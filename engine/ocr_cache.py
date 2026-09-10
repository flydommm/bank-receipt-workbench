"""Bounded, disposable OCR records in the host's private cache directory.

Keys contain verified PDF content, page, and the OCR recipe, never a filename,
keyword, review state, or crop algorithm. A cache fault must not fail analysis.
"""
from __future__ import annotations

from hashlib import sha256
from importlib import metadata
import json
import math
import os
from pathlib import Path
import re
import stat
import time
from uuid import uuid4

from .ocr import OCR_RUNTIME_PROFILE
from .private_temp import private_storage_directory, _is_reparse_or_symlink


OCR_RENDER_DPI = 200
CACHE_SCHEMA = 1
MAX_ENTRY_BYTES = 8 * 1024 * 1024
MAX_CACHE_BYTES = 256 * 1024 * 1024
MAX_ENTRIES = 10_000
RETENTION_DAYS = 30
MAX_RECORDS = 50_000
_ENTRY = re.compile(r'^[a-f0-9]{64}\.json$')
_TEMP = re.compile(r'^[a-f0-9]{64}\.[a-f0-9]{32}\.tmp$')
_DIGEST = re.compile(r'^[a-f0-9]{64}$')


def _json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def ocr_recipe_signature() -> str:
    """No model import/download. Layout/search-only changes retain OCR records."""
    versions = {}
    for package in ('PyMuPDF', 'paddleocr', 'paddlepaddle', 'paddlepaddle-gpu', 'paddlex', 'opencv-python', 'opencv-contrib-python'):
        try:
            versions[package] = metadata.version(package)
        except metadata.PackageNotFoundError:
            versions[package] = 'not-installed'
    return sha256(_json({
        'schema': CACHE_SCHEMA, 'language': 'ch', 'render_dpi': OCR_RENDER_DPI, 'alpha': False,
        'doc_orientation': False, 'doc_unwarping': False, 'textline_orientation': False,
        'runtime_profile': OCR_RUNTIME_PROFILE, 'dependencies': versions,
        'ocr_normalizer_sha256': sha256(Path(__file__).with_name('ocr.py').read_bytes()).hexdigest(),
    })).hexdigest()


def _root() -> Path:
    return private_storage_directory('ocr-text-cache')


def _ordinary(path: Path) -> os.stat_result | None:
    try:
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or _is_reparse_or_symlink(path)):
            return None
        return info
    except OSError:
        return None


def _inventory(root: Path) -> list[tuple[Path, os.stat_result]]:
    entries = []
    # Only flat owned names are considered; no traversal or caller paths.
    for path in root.iterdir():
        if _ENTRY.fullmatch(path.name):
            info = _ordinary(path)
            if info is not None:
                entries.append((path, info))
        elif _TEMP.fullmatch(path.name):
            info = _ordinary(path)
            if info is not None and time.time() - info.st_mtime > 3600:
                path.unlink(missing_ok=True)
    return entries


def _prune(root: Path, reserve: int, replacing: Path) -> None:
    entries = sorted(_inventory(root), key=lambda pair: pair[1].st_mtime)
    retained = [(path, info) for path, info in entries if path != replacing]
    total = sum(info.st_size for _, info in retained)
    count = len(retained)
    cutoff = time.time() - RETENTION_DAYS * 86400
    for path, info in retained:
        if info.st_mtime >= cutoff and total + reserve <= MAX_CACHE_BYTES and count < MAX_ENTRIES:
            break
        if _ordinary(path) is not None:
            path.unlink(missing_ok=True)
            total -= info.st_size
            count -= 1
    if total + reserve > MAX_CACHE_BYTES or count >= MAX_ENTRIES:
        raise OSError('cache capacity unavailable')


def _records(value: object, width: float, height: float) -> list[dict]:
    if not isinstance(value, list) or len(value) > MAX_RECORDS:
        raise ValueError('invalid OCR records')
    result = []
    pixel_width, pixel_height = math.ceil(width * OCR_RENDER_DPI / 72), math.ceil(height * OCR_RENDER_DPI / 72)
    for item in value:
        if not isinstance(item, dict) or set(item) != {'text', 'box', 'confidence'}:
            raise ValueError('invalid OCR record')
        text, box, confidence = item['text'], item['box'], item['confidence']
        if not isinstance(text, str) or not text.strip() or len(text) > 16_384:
            raise ValueError('invalid OCR text')
        if not isinstance(box, list) or len(box) != 4:
            raise ValueError('invalid OCR box')
        values = [*box, confidence]
        if any(type(number) not in (int, float) or not math.isfinite(number) for number in values):
            raise ValueError('invalid OCR numbers')
        x0, y0, x1, y1 = box
        if not (0 <= x0 < x1 <= pixel_width + 1 and 0 <= y0 < y1 <= pixel_height + 1 and 0 <= confidence <= 1):
            raise ValueError('OCR record outside page')
        result.append({'text': text, 'box': [float(number) for number in box], 'confidence': float(confidence)})
    return result


class OcrTextCache:
    def __init__(self, source_sha256: str):
        self.source_sha256 = source_sha256
        try:
            if not isinstance(source_sha256, str) or not _DIGEST.fullmatch(source_sha256):
                raise ValueError('invalid source digest')
            self.recipe = ocr_recipe_signature()
            if not _DIGEST.fullmatch(self.recipe):
                raise ValueError('invalid OCR recipe')
        except (OSError, ValueError, RuntimeError, TypeError):
            self.recipe = None

    def _path(self, page: int, width: float, height: float) -> Path:
        if self.recipe is None or type(page) is not int or page < 1:
            raise ValueError('cache unavailable')
        if any(type(number) not in (int, float) or not math.isfinite(number) or number <= 0 for number in (width, height)):
            raise ValueError('invalid page size')
        key = sha256(_json([self.source_sha256, self.recipe, page])).hexdigest()
        return _root() / f'{key}.json'

    def get(self, page: int, width: float, height: float) -> list[dict] | None:
        try:
            path = self._path(page, width, height)
            info = _ordinary(path)
            if info is None or info.st_size > MAX_ENTRY_BYTES or time.time() - info.st_mtime > RETENTION_DAYS * 86400:
                return None
            descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
            with os.fdopen(descriptor, 'rb') as file:
                opened = os.fstat(file.fileno())
                if (opened.st_dev, opened.st_ino, opened.st_nlink) != (info.st_dev, info.st_ino, 1):
                    return None
                raw = file.read(MAX_ENTRY_BYTES + 1)
            if len(raw) > MAX_ENTRY_BYTES:
                return None
            payload = json.loads(raw)
            if not isinstance(payload, dict) or set(payload) != {'schema', 'source_sha256', 'recipe', 'page', 'width', 'height', 'records', 'checksum'}:
                return None
            checksum = payload.pop('checksum')
            if checksum != sha256(_json(payload)).hexdigest():
                return None
            if (payload['schema'] != CACHE_SCHEMA or payload['source_sha256'] != self.source_sha256
                    or payload['recipe'] != self.recipe or payload['page'] != page
                    or payload['width'] != width or payload['height'] != height):
                return None
            records = _records(payload['records'], width, height)
            # Retention starts at the atomic write. Avoid path-based timestamp
            # updates: Windows cannot apply utime without following symlinks.
            return records
        except (OSError, ValueError, RuntimeError, TypeError, KeyError, RecursionError, OverflowError):
            return None

    def put(self, page: int, width: float, height: float, records: list[dict]) -> None:
        temporary = None
        try:
            path = self._path(page, width, height)
            if os.path.lexists(path) and _ordinary(path) is None:
                return
            payload = {'schema': CACHE_SCHEMA, 'source_sha256': self.source_sha256, 'recipe': self.recipe,
                       'page': page, 'width': width, 'height': height, 'records': _records(records, width, height)}
            payload['checksum'] = sha256(_json(payload)).hexdigest()
            encoded = _json(payload)
            if len(encoded) > min(MAX_ENTRY_BYTES, MAX_CACHE_BYTES):
                return
            _prune(path.parent, len(encoded), path)
            temporary = path.with_name(f'{path.stem}.{uuid4().hex}.tmp')
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0), 0o600)
            with os.fdopen(descriptor, 'wb') as file:
                file.write(encoded)
                file.flush()
                os.fsync(file.fileno())
            if _root() != path.parent or (os.path.lexists(path) and _ordinary(path) is None):
                return
            os.replace(temporary, path)
        except (OSError, ValueError, RuntimeError, TypeError, KeyError, RecursionError, OverflowError):
            return
        finally:
            if temporary is not None and _ordinary(temporary) is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass


def cache_info() -> dict:
    response = {'status': 'ok', 'available': False, 'entries': 0, 'bytes': 0,
                'max_bytes': MAX_CACHE_BYTES, 'retention_days': RETENTION_DAYS}
    try:
        entries = _inventory(_root())
        response.update(available=True, entries=len(entries), bytes=sum(info.st_size for _, info in entries))
    except (OSError, ValueError, RuntimeError):
        pass
    return response


def clear_cache() -> dict:
    removed = failed = 0
    try:
        root = _root()
        for path, _ in _inventory(root):
            try:
                if _root() == root and _ordinary(path) is not None:
                    path.unlink(missing_ok=True)
                    removed += 1
            except (OSError, ValueError, RuntimeError):
                failed += 1
    except (OSError, ValueError, RuntimeError):
        failed += 1
    return {**cache_info(), 'removed_entries': removed, 'failed_entries': failed}
