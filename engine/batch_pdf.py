"""Per-page batch computation on one SHA-bound, private PDF working copy."""

from __future__ import annotations

from contextlib import contextmanager
from collections import OrderedDict
from dataclasses import dataclass, field, replace
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
from .pdf_parser import visible_page
from .pdf_geometry import read_page_geometry
from .crop_templates import describe_crop_page
from .receipt_layout import (
    PageLayoutEvidence, ReceiptPageComputation, LayoutSuggestion,
    collect_visible_objects, compatible_reference, compute_receipt_page, suggest_layout,
    refresh_saved_layout_identity, contains_verified_crop_envelopes,
)
from .receipt_visual_identity import requires_verified_crop_envelopes
from .receipt_layout_models import parse_processing_options, parse_layout_definition
from .private_temp import private_temporary_directory
from .search import SearchBudget, SearchClause, SearchMatch, SearchQuery, search_pages, search_pages_multi
from .source_layout import MAX_MULTI_TEMPLATE_PAGES, SourceLayoutIndex
from .receipt_document_types import detect_document_type


# Keep recent page evidence in addition to the bounded reference set. With
# only 16 entries, a 16-reference scan plus the current page cyclically evicts
# every reference and re-runs its geometry/descriptor extraction on each page.
_RECEIPT_EVIDENCE_LIMIT = 16 + MAX_MULTI_TEMPLATE_PAGES


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
    _source_layout: SourceLayoutIndex | None = field(default=None, init=False)
    # A small, query-independent LRU. No bitmaps, document handles, or search
    # values are retained here; the enclosing private-copy context owns it.
    _receipt_evidence: OrderedDict[int, PageLayoutEvidence] = field(default_factory=OrderedDict, init=False)
    _receipt_references: OrderedDict[int, tuple[str, PageLayoutEvidence | None, str | None]] = field(default_factory=OrderedDict, init=False)

    def _explicit_layout_evidence(self, page: int, *, allow_ocr: bool) -> PageLayoutEvidence:
        """Read all content for an explicit draft without suggesting a new layout.

        The caller already supplies the complete layout from the SHA-bound
        calibration preparation. Automatic candidates and visual form identity
        would be discarded here, but text, OCR, occupancy and crossing risks
        must still be recomputed. Do not cache this partial evidence in the
        automatic-layout LRU: saved/historical layouts require full identity.
        """
        if type(page) is not int or not 1 <= page <= self.page_count:
            raise BatchSourceError("invalid_page")
        loaded = self._document.load_page(page - 1)
        text_layer = parse_loaded_page(loaded, page)
        if allow_ocr and self.reuse_ocr and not text_layer.blocks and self._ocr_cache is None:
            self._ocr_cache = OcrTextCache(self.sha256)
        searchable = _ocr_page(loaded, text_layer, self._ocr_cache) if allow_ocr else text_layer
        objects, complete = collect_visible_objects(visible_page(loaded))
        return PageLayoutEvidence(read_page_geometry(loaded), searchable, (), {}, objects, complete,
                                  native_text=searchable is text_layer,
                                  ocr_attempted=allow_ocr and not text_layer.blocks)

    def _page_evidence(self, page: int, *, allow_ocr: bool = True) -> PageLayoutEvidence:
        if type(page) is not int or not 1 <= page <= self.page_count:
            raise BatchSourceError("invalid_page")
        if page in self._receipt_evidence:
            evidence = self._receipt_evidence[page]
            # A native-only reference scan must not suppress requested OCR.
            if evidence.parsed.blocks or not allow_ocr or evidence.ocr_attempted:
                self._receipt_evidence.move_to_end(page)
                return evidence
        loaded = self._document.load_page(page - 1)
        text_layer = parse_loaded_page(loaded, page)
        if allow_ocr and self.reuse_ocr and not text_layer.blocks and self._ocr_cache is None:
            self._ocr_cache = OcrTextCache(self.sha256)
        searchable = _ocr_page(loaded, text_layer, self._ocr_cache) if allow_ocr else text_layer
        _separators, _anchors, candidates, exceeded = core._analyze_page_geometry(
            self.snapshot_path, page, searchable, loaded_page=loaded,
        )
        objects, complete = collect_visible_objects(visible_page(loaded))
        if self._source_layout is None:
            self._source_layout = SourceLayoutIndex(self._document, descriptor_reader=describe_crop_page)
        evidence = PageLayoutEvidence(read_page_geometry(loaded), searchable, tuple(candidates),
                                      self._source_layout.descriptor(page), objects, complete,
                                      native_text=searchable is text_layer, budget_exceeded=exceeded,
                                      ocr_attempted=allow_ocr and not text_layer.blocks)
        self._receipt_evidence[page] = evidence
        self._receipt_evidence.move_to_end(page)
        while len(self._receipt_evidence) > _RECEIPT_EVIDENCE_LIMIT:
            self._receipt_evidence.popitem(last=False)
        return evidence

    def verified_template_crop_envelopes(self, page: int) -> tuple[tuple[float, ...], ...]:
        """Read source-bound outer form bounds without OCR or changing a crop."""
        from .receipt_visual_identity import verified_crop_envelopes
        return verified_crop_envelopes(self._page_evidence(page, allow_ocr=False).descriptor)

    def compute_receipt_page(
        self, page: int, processing_options: dict[str, Any], match_mode: str, budget: SearchBudget,
        *, layout_definition: dict[str, Any] | None = None, slot_count: int | None = None,
        workspace_id: str = "default", allow_ocr: bool = True,
        reused_layout_definition: dict[str, Any] | None = None,
        historical_layouts: tuple[dict[str, Any], ...] = (),
    ) -> ReceiptPageComputation:
        """Shared search/split-all computation; the legacy endpoint is unchanged.

        The P3 protocol will call this after negotiating the receipt contract.
        Explicit layouts are geometric drafts, not authorization for a review
        write or cross-source application; that check belongs to preview/save.
        """
        options = parse_processing_options(processing_options)
        if match_mode not in {"exact", "fuzzy"} or not isinstance(budget, SearchBudget) or type(allow_ocr) is not bool:
            raise ValueError("invalid receipt computation parameters")
        if layout_definition is not None and slot_count is not None:
            raise ValueError("layout and slot count are mutually exclusive")
        if layout_definition is not None and reused_layout_definition is not None:
            raise ValueError("saved layout and explicit layout are mutually exclusive")
        if layout_definition is not None:
            layout = parse_layout_definition(layout_definition)
            evidence = self._explicit_layout_evidence(page, allow_ocr=allow_ocr)
            return compute_receipt_page(evidence, self.sha256, options, match_mode=match_mode, budget=budget,
                suggestion=LayoutSuggestion(layout, "manual_layout", True),
                visible_page=visible_page(self._document.load_page(page - 1)))
        evidence = self._page_evidence(page, allow_ocr=allow_ocr)
        policy, reference, reference_warning = "unknown", None, None
        suggestion = None
        if reused_layout_definition is not None:
            if layout_definition is not None or slot_count is not None:
                raise ValueError("saved layout and explicit layout are mutually exclusive")
            saved = parse_layout_definition(reused_layout_definition)
            if saved["page_geometry"] == evidence.geometry:
                # The task has pinned an exact SHA/page saved layout. Geometry
                # is retained exactly; identity is recomputed so older saved
                # layouts without bank/form evidence can join today's proven
                # scope. Current text/visual risks and special notices remain.
                saved = refresh_saved_layout_identity(saved, evidence)
                return compute_receipt_page(evidence, self.sha256, options, match_mode=match_mode, budget=budget,
                    suggestion=LayoutSuggestion(saved, "manual_layout", False),
                    visible_page=visible_page(self._document.load_page(page - 1)))
        if slot_count is None and page in self._receipt_references:
            policy, reference, reference_warning = self._receipt_references[page]
            self._receipt_references.move_to_end(page)
        elif slot_count is None and evidence.candidates and evidence.native_text:
            assert self._source_layout is not None
            policy = self._source_layout.policy(page, evidence.parsed)
            # A one-receipt tail can be classified as ``single`` because its
            # page-local evidence contains only one heading. Still ask the
            # bounded source index for a positive same-form multi-slot
            # reference; a true native single-receipt document yields no
            # matching reference and keeps its page crop unchanged.
            references = [self._page_evidence(number, allow_ocr=False)
                          for number in self._source_layout.matching_reference_pages(page, evidence.parsed)]
            # The source-local fallback below must not bypass special-document
            # isolation when a descriptor is unavailable.
            references = [item for item in references
                          if detect_document_type(item.parsed) == detect_document_type(evidence.parsed)]
            compatible = [item for item in references if compatible_reference(evidence, item, require_positions=False)]
            # Descriptor extraction can be unavailable on image-heavy pages,
            # while repeated native headings still identify the same local
            # form. In that case retain only a larger repeated candidate
            # layout; the source-local heading/geometry gate above prevents
            # unrelated pages from becoming references.
            if compatible:
                references = compatible
            else:
                references = [item for item in references if item.geometry == evidence.geometry
                              and all(any(abs(candidate.rect.y0 - target.rect.y0) <= 0.5
                                          and abs(candidate.rect.x0 - target.rect.x0) <= 0.5
                                          and abs(candidate.rect.x1 - target.rect.x1) <= 0.5
                                          for target in item.candidates) for candidate in evidence.candidates)]
            if references and max(len(item.candidates) for item in references) > len(evidence.candidates):
                # A two-receipt tail can share the complete three-slot form.
                maximum = max(len(item.candidates) for item in references)
                full = [item for item in references if len(item.candidates) == maximum]
                verified_full = [item for item in full if compatible_reference(evidence, item)]
                if compatible:
                    full = verified_full
                layouts = [suggest_layout(item, workspace_id=workspace_id, source_policy="multiple").layout_definition for item in full]
                first_slots = layouts[0]["slots"] if layouts else []
                if layouts and all(len(layout["slots"]) == len(first_slots) and all(
                    abs(a[key] - b[key]) <= 0.5
                    for a, b in zip(first_slots, layout["slots"], strict=True)
                    for key in ("top_pt", "height_pt")) for layout in layouts):
                    reference = full[0]
                else:
                    reference_warning = "reference_layout_conflict" if full else "reference_position_mismatch"
            self._receipt_references[page] = (policy, reference, reference_warning)
            while len(self._receipt_references) > 16:
                self._receipt_references.popitem(last=False)
            # Preparing the bounded references may have evicted the active
            # sample. Keep it for the next query/preview and cache the decision
            # above so a 16-reference scan cannot create a cyclic LRU miss.
            self._receipt_evidence[page] = evidence
            self._receipt_evidence.move_to_end(page)
            while len(self._receipt_evidence) > _RECEIPT_EVIDENCE_LIMIT:
                self._receipt_evidence.popitem(last=False)
        if reference_warning is not None:
            initial = suggest_layout(evidence, workspace_id=workspace_id, source_policy=policy)
            suggestion = replace(initial, needs_review=True,
                                 diagnostics=(*initial.diagnostics, {"code": reference_warning}))
        elif reference is not None and not compatible_reference(evidence, reference):
            # A source-local repeated-heading reference has already passed
            # physical geometry and row-start checks above. Its layout is a
            # suggestion for this source only, not a cross-bank template.
            initial = suggest_layout(reference, workspace_id=workspace_id, source_policy="multiple")
            suggestion = replace(initial, basis="source_reference")
            reference = None
        if historical_layouts and layout_definition is None and slot_count is None:
            from .receipt_layout_reference import apply_historical_reference, compatible_historical_references
            initial = suggestion or suggest_layout(evidence, workspace_id=workspace_id, source_policy=policy, reference=reference)
            compatible = compatible_historical_references(initial.layout_definition, historical_layouts)
            if len(compatible) > 1:
                suggestion = replace(initial, needs_review=True, diagnostics=(*initial.diagnostics,
                    {"code": "historical_template_ambiguous", "template_ids": [item["template_id"] for item in compatible]}))
            elif compatible:
                historical = apply_historical_reference(initial.layout_definition, historical_layouts)
                if historical is not None:
                    if (requires_verified_crop_envelopes(historical) and not contains_verified_crop_envelopes(
                            historical, self.verified_template_crop_envelopes(page))):
                        # A matching outer form does not imply unchanged body
                        # height. Retain the automatic crop if any current
                        # table would be truncated or its proof is unavailable.
                        suggestion = replace(initial, needs_review=True,
                            diagnostics=(*initial.diagnostics, {"code": "reference_layout_conflict"}))
                    else:
                        suggestion = LayoutSuggestion(historical, "historical_reference", True,
                            (*initial.diagnostics, {"code": "historical_layout_applied"}))
        return compute_receipt_page(evidence, self.sha256, options, match_mode=match_mode, budget=budget,
                                    suggestion=suggestion, source_policy=policy, reference=reference,
                                    workspace_id=workspace_id, slot_count=slot_count,
                                    visible_page=visible_page(self._document.load_page(page - 1)))

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
            source_layout_policy = "multiple"
            if len(candidates) == 1:
                if self._source_layout is None:
                    self._source_layout = SourceLayoutIndex(self._document)
                # Native source evidence never starts OCR on other pages.
                # A scanned single receipt stays protected for manual review.
                source_layout_policy = self._source_layout.policy(page, text_layer)
            fully_matched, selections = core._selection_payloads(
                [core.Rect(match.x0, match.y0, match.x1, match.y1) for match in matches],
                separators, anchors, candidates, text_layer.width, text_layer.height, exceeded,
                source_layout_policy=source_layout_policy,
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
