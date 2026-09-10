"""Disposable OCR cache contracts; all files stay under the test private root."""
from copy import deepcopy
from hashlib import sha256
import json
import os
from pathlib import Path

import pytest

from engine import ocr_cache

REAL_SIGNATURE = ocr_cache.ocr_recipe_signature


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv('PDF_SEARCH_PRIVATE_TEMP', str(tmp_path / 'private'))
    monkeypatch.setattr(ocr_cache, 'ocr_recipe_signature', lambda: 'b' * 64)


def records(text='fee bank'):
    return [{'text': text, 'box': [10, 20, 100, 40], 'confidence': 0.98}]


def entries(tmp_path):
    return list((tmp_path / 'private' / 'ocr-text-cache').glob('*.json'))


def test_reopen_reuses_records_without_path_or_keyword_binding(tmp_path):
    cache = ocr_cache.OcrTextCache('a' * 64)
    original = records()
    cache.put(1, 600, 800, original)
    loaded = ocr_cache.OcrTextCache('a' * 64).get(1, 600, 800)
    assert loaded == original
    loaded[0]['text'] = 'changed'
    assert cache.get(1, 600, 800) == original
    assert cache.get(2, 600, 800) is None
    assert cache.get(1, 601, 800) is None
    assert ocr_cache.OcrTextCache('c' * 64).get(1, 600, 800) is None
    assert len(entries(tmp_path)) == 1


def test_recipe_change_misses_cache(tmp_path, monkeypatch):
    ocr_cache.OcrTextCache('a' * 64).put(1, 600, 800, records())
    monkeypatch.setattr(ocr_cache, 'ocr_recipe_signature', lambda: 'c' * 64)
    assert ocr_cache.OcrTextCache('a' * 64).get(1, 600, 800) is None


def test_valid_blank_page_is_cached():
    cache = ocr_cache.OcrTextCache('a' * 64)
    cache.put(1, 600, 800, [])
    assert cache.get(1, 600, 800) == []


def test_oversized_integer_with_valid_checksum_is_a_miss(tmp_path):
    cache = ocr_cache.OcrTextCache('a' * 64)
    cache.put(1, 600, 800, records())
    path = entries(tmp_path)[0]
    payload = json.loads(path.read_text(encoding='utf-8'))
    payload.pop('checksum')
    payload['records'][0]['box'][2] = 10 ** 400
    payload['checksum'] = sha256(ocr_cache._json(payload)).hexdigest()
    path.write_bytes(ocr_cache._json(payload))
    assert cache.get(1, 600, 800) is None
    cache.put(1, 600, 800, payload['records'])
    cache.put(1, 600, 800, records('fresh'))
    assert cache.get(1, 600, 800) == records('fresh')


@pytest.mark.parametrize('change', ['truncated', 'checksum', 'oversized', 'schema', 'page'])
def test_corrupt_or_incompatible_entry_is_a_miss_and_can_be_replaced(tmp_path, change):
    cache = ocr_cache.OcrTextCache('a' * 64)
    cache.put(1, 600, 800, records())
    path = entries(tmp_path)[0]
    raw = json.loads(path.read_text(encoding='utf-8'))
    if change == 'truncated':
        path.write_text('{', encoding='utf-8')
    elif change == 'oversized':
        with path.open('wb') as file:
            file.truncate(ocr_cache.MAX_ENTRY_BYTES + 1)
    else:
        if change == 'checksum':
            raw['records'][0]['text'] = 'tampered'
        else:
            raw[change] = 999
        path.write_text(json.dumps(raw), encoding='utf-8')
    assert cache.get(1, 600, 800) is None
    cache.put(1, 600, 800, records('fresh'))
    assert cache.get(1, 600, 800) == records('fresh')


@pytest.mark.parametrize('bad', [
    [{'text': 'fee', 'box': [10, 2, 1, 3], 'confidence': 1}],
    [{'text': 'fee', 'box': [0, 0, float('inf'), 2], 'confidence': 1}],
    [{'text': 'fee', 'box': [0, 0, 999999, 2], 'confidence': 1}],
    [{'text': 'fee', 'box': [0, 0, 100, 20], 'confidence': 1.1}],
])
def test_invalid_ocr_output_is_never_persisted(tmp_path, bad):
    cache = ocr_cache.OcrTextCache('a' * 64)
    cache.put(1, 600, 800, bad)
    assert cache.get(1, 600, 800) is None
    assert not entries(tmp_path)


def test_unavailable_directory_does_not_raise(monkeypatch):
    def denied(*_args):
        raise PermissionError('private path')
    monkeypatch.setattr(ocr_cache, 'private_storage_directory', denied)
    cache = ocr_cache.OcrTextCache('a' * 64)
    assert cache.get(1, 600, 800) is None
    cache.put(1, 600, 800, records())
    assert ocr_cache.cache_info()['available'] is False
    assert ocr_cache.clear_cache()['available'] is False


def test_atomic_write_failure_preserves_existing_cache(tmp_path, monkeypatch):
    cache = ocr_cache.OcrTextCache('a' * 64)
    cache.put(1, 600, 800, records('old'))
    def fail(*_args):
        raise OSError('disk full')
    monkeypatch.setattr(ocr_cache.os, 'replace', fail)
    cache.put(1, 600, 800, records('new'))
    assert cache.get(1, 600, 800) == records('old')
    assert len(list((tmp_path / 'private' / 'ocr-text-cache').iterdir())) == 1


def test_expired_cache_misses_and_pruning_keeps_recent_records(tmp_path, monkeypatch):
    cache = ocr_cache.OcrTextCache('a' * 64)
    cache.put(1, 600, 800, records())
    old = entries(tmp_path)[0]
    os.utime(old, (1, 1))
    assert cache.get(1, 600, 800) is None
    monkeypatch.setattr(ocr_cache, 'MAX_ENTRIES', 2)
    for page in (2, 3, 4):
        cache.put(page, 600, 800, records())
    assert len(entries(tmp_path)) == 2
    assert cache.get(4, 600, 800) == records()


def test_clear_only_removes_owned_cache_files(tmp_path):
    cache = ocr_cache.OcrTextCache('a' * 64)
    cache.put(1, 600, 800, records())
    directory = entries(tmp_path)[0].parent
    unrelated = directory / 'user-note.txt'
    unrelated.write_text('keep', encoding='utf-8')
    report = ocr_cache.clear_cache()
    assert report['removed_entries'] == 1 and report['failed_entries'] == 0
    assert report['entries'] == 0 and report['bytes'] == 0
    assert unrelated.read_text(encoding='utf-8') == 'keep'
    assert cache.get(1, 600, 800) is None


def test_hardlinked_entry_is_never_read_overwritten_or_cleared(tmp_path):
    cache = ocr_cache.OcrTextCache('a' * 64)
    cache.put(1, 600, 800, records())
    path = entries(tmp_path)[0]
    external = tmp_path / 'keep.json'
    os.link(path, external)
    original = external.read_bytes()
    assert cache.get(1, 600, 800) is None
    cache.put(1, 600, 800, records('new'))
    ocr_cache.clear_cache()
    assert path.exists() and external.read_bytes() == original


def test_signature_changes_with_runtime_profile_but_not_search_criteria(monkeypatch):
    monkeypatch.setattr(ocr_cache, 'ocr_recipe_signature', REAL_SIGNATURE)
    first = ocr_cache.ocr_recipe_signature()
    profile = deepcopy(ocr_cache.OCR_RUNTIME_PROFILE)
    profile['cpu_threads'] = 3
    monkeypatch.setattr(ocr_cache, 'OCR_RUNTIME_PROFILE', profile)
    assert ocr_cache.ocr_recipe_signature() != first
