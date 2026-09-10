"""Per-page batch computation on one SHA-bound, private PDF working copy."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
import re
from typing import Any, Iterator

from . import engine as core
from .batch_models import normalize_criteria, validate_page_result
from .layout import _is_receipt_title
from .ocr import is_scanned_page, recognize_image
from .ocr_cache import OCR_RENDER_DPI, OcrTextCache
from .ocr_pdf import _validate_raster_budget
from .pdf_parser import ParsedPage, TextBlock, parse_loaded_page
from .private_temp import private_temporary_directory
from .search import SearchBudget, SearchClause, SearchMatch, SearchQuery, search_pages, search_pages_multi


class BatchSourceError(RuntimeError):
    """Stable source failure; raw parser/path exception messages stay private."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(core.DEFAULT_ERROR_MESSAGES.get(code, "PDF processing failed"))


def _ocr_page(loaded_page: Any, parsed: ParsedPage, cache: OcrTextCache | None = None) -> ParsedPage:
    if parsed.blocks or not is_scanned_page(parsed):
        return parsed
    _validate_raster_budget(loaded_page.rect, OCR_RENDER_DPI)
    records = cache.get(parsed.page_number, parsed.width, parsed.height) if cache is not None else None
    if records is None:
        with private_temporary_directory("batch-ocr") as directory:
            image = directory / "page.png"
            pixmap = loaded_page.get_pixmap(matrix=core.pymupdf.Matrix(OCR_RENDER_DPI / 72, OCR_RENDER_DPI / 72), alpha=False)
            try:
                pixmap.save(str(image))
            finally:
                del pixmap
            records = recognize_image(image, language="ch")
        if cache is not None:
            cache.put(parsed.page_number, parsed.width, parsed.height, records)
    blocks = []
    for index, record in enumerate(records):
        text = str(record.get("text", "")).strip()
        box = record.get("box", [0, 0, 0, 0])
        if not text or not isinstance(box, (list, tuple)) or len(box) < 4:
            continue
        x0, y0, x1, y1 = (float(box[coordinate]) * (72 / OCR_RENDER_DPI) for coordinate in range(4))
        blocks.append(TextBlock(parsed.page_number, text, x0, y0, x1, y1, index, float(record.get("confidence", 0.0))))
    return ParsedPage(parsed.page_number, parsed.width, parsed.height, "\n".join(block.text for block in blocks), tuple(blocks))


def _match_payload(match: SearchMatch, *, multi: bool) -> dict[str, Any]:
    payload = {
        "page": match.page_number, "matched_text": match.matched_text,
        "matched_field": match.matched_field, "confidence": match.confidence,
        "needs_review": match.confidence < 0.85,
        "x0": match.x0, "y0": match.y0, "x1": match.x1, "y1": match.y1,
    }
    if multi:
        payload.update(query_id=match.query_id, role=match.role)
    return payload


@dataclass
class BatchPdfSource:
    """Borrowed for the open_batch_source context; it never owns the original."""

    snapshot_path: Path
    sha256: str
    size_bytes: int
    page_count: int
    _document: Any
    reuse_ocr: bool = False
    _ocr_cache: OcrTextCache | None = field(default=None, init=False)

    def compute_page(
        self, page: int, criteria: dict[str, Any], match_mode: str, budget: SearchBudget,
    ) -> dict[str, Any]:
        if type(page) is not int or not 1 <= page <= self.page_count:
            raise BatchSourceError("invalid_page")
        if match_mode not in {"exact", "fuzzy"} or not isinstance(budget, SearchBudget):
            raise ValueError("invalid batch computation parameters")
        criteria = normalize_criteria(criteria)
        loaded = self._document.load_page(page - 1)
        text_layer = parse_loaded_page(loaded, page)
        if self.reuse_ocr and not text_layer.blocks and self._ocr_cache is None:
            self._ocr_cache = OcrTextCache(self.sha256)
        searchable = _ocr_page(loaded, text_layer, self._ocr_cache)
        legacy = len(criteria["include"]) == 1 and criteria["includeMode"] == "all" and not criteria["exclude"]
        if legacy:
            matches = search_pages([searchable], SearchQuery(criteria["include"][0], exact=match_mode == "exact"), budget=budget)
        else:
            clauses = [SearchClause(f"{role}-{index}", keyword, role)
                       for role in ("include", "exclude") for index, keyword in enumerate(criteria[role])]
            matches = search_pages_multi([searchable], clauses, exact=match_mode == "exact", budget=budget)
        raw_matches = [_match_payload(match, multi=not legacy) for match in matches]
        analysis = None
        if matches:
            # Search and layout must use the same effective text layer. For
            # native PDFs _ocr_page returns the original ParsedPage unchanged,
            # preserving watermark metadata; scans use recognized title/body
            # coordinates instead of the original empty layer.
            separators, anchors, candidates, exceeded = core._analyze_page_geometry(
                self.snapshot_path, page, searchable, loaded_page=loaded,
            )
            fully_matched, selections = core._selection_payloads(
                [core.Rect(match.x0, match.y0, match.x1, match.y1) for match in matches],
                separators, anchors, candidates, text_layer.width, text_layer.height, exceeded,
            )
            if searchable is not text_layer:
                # Strong layout evidence cannot make an uncertain OCR reading
                # safe for automatic confirmation (including legacy searches).
                # A misread title can move both its own and a neighbouring
                # receipt boundary. Keep the geometry, but require review for
                # the page rather than silently accepting an uncertain split.
                title_confidence = min(
                    (block.confidence for block in searchable.blocks if _is_receipt_title(block.text)),
                    default=1.0,
                )
                for selection, match in zip(selections, matches, strict=True):
                    selection["confidence"] = min(selection["confidence"], match.confidence, title_confidence)
                    selection["needs_review"] = selection["needs_review"] or selection["confidence"] < 0.9
            analysis = {
                "status": "ok", "page": page, "page_width": text_layer.width, "page_height": text_layer.height,
                "page_fully_matched": fully_matched, "selections": selections,
            }
        return validate_page_result({
            "schema": 1, "page": page, "page_width": text_layer.width, "page_height": text_layer.height,
            "matches": raw_matches, "analysis": analysis,
        })


@contextmanager
def open_batch_source(path: str | Path, expected_sha256: str | None = None, *, reuse_ocr: bool = False) -> Iterator[BatchPdfSource]:
    """Hash while copying one opened source; retain no PDF copy after exit."""
    source = Path(path)
    if not source.is_absolute() or source.suffix.lower() != ".pdf":
        raise BatchSourceError("invalid_path")
    if expected_sha256 is not None and (
        not isinstance(expected_sha256, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", expected_sha256)
    ):
        raise BatchSourceError("source_changed")
    with private_temporary_directory("batch-source") as directory:
        try:
            copied = core._snapshot_pdf_source(source, expected_sha256.lower() if expected_sha256 else None, directory)
        except FileNotFoundError:
            raise BatchSourceError("file_not_found") from None
        except ValueError:
            raise BatchSourceError("source_changed") from None
        except OSError:
            raise BatchSourceError("search_failed") from None
        if isinstance(copied, dict):
            raise BatchSourceError(copied["code"])
        try:
            document = core.pymupdf.open(str(copied.path))
        except Exception:
            raise BatchSourceError("search_failed") from None
        try:
            if document.needs_pass:
                raise BatchSourceError("search_failed")
            if not 1 <= document.page_count <= core.ENGINE_CONFIG.max_pages:
                raise BatchSourceError("page_limit_exceeded")
            yield BatchPdfSource(copied.path, copied.sha256, copied.size, document.page_count, document, reuse_ocr)
        finally:
            document.close()
