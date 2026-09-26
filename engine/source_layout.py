"""Bounded source evidence for automatic receipt-page selection.

The borrowed document is an already SHA-bound private copy. This index never
retains transaction text. Small image mastheads may use local cached OCR. A positive multi-receipt template match
can settle a tail page; incomplete/ambiguous evidence protects the full page
for manual review instead of guessing from its content height.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Callable, Literal

from .crop_templates import describe_crop_page, _title_text_from_block
from .layout import MAX_TEXT_BLOCKS, _deduplicate_title_blocks, _is_receipt_title
from .pdf_parser import ParsedPage, parse_loaded_page


SourceLayoutPolicy = Literal["single", "multiple", "unknown"]
MAX_SOURCE_LAYOUT_PAGES = 512
MAX_MULTI_TEMPLATE_PAGES = 16
_VACANT_MARKERS = ("此处白纸无效", "此处空白无效", "此处白页无效", "空白区域无效", "此空白联无效")


def _vacant_marker(text: str) -> bool:
    normalized = "".join(text.split())
    # Only an isolated printed marker is an empty slot. A note quoting this
    # wording is business content and its whole text block must be retained.
    return normalized.rstrip("!！。.") in _VACANT_MARKERS


def has_vacant_receipt_slots(parsed: ParsedPage) -> bool:
    if len(parsed.blocks) > MAX_TEXT_BLOCKS:
        return False
    titles = [block for block in parsed.blocks if _is_receipt_title(block.text) and not block.is_watermark]
    return bool(titles) and any(
        _vacant_marker(block.text) and block.y0 > min(title.y1 for title in titles)
        for block in parsed.blocks
    )


def without_vacant_markers(parsed: ParsedPage) -> ParsedPage:
    """Keep searchable text untouched while excluding explicit invalid slots."""
    if not has_vacant_receipt_slots(parsed):
        return parsed
    return replace(parsed, blocks=tuple(block for block in parsed.blocks if not _vacant_marker(block.text)))


@dataclass(frozen=True)
class _PageEvidence:
    count: int
    usable: bool
    vacant: bool


def _page_evidence(parsed: ParsedPage) -> _PageEvidence:
    if not parsed.blocks or len(parsed.blocks) > MAX_TEXT_BLOCKS:
        return _PageEvidence(0, False, False)
    raw_titles = [
        block for block in parsed.blocks if not block.is_watermark and _is_receipt_title(block.text)
    ]
    if any(sum(_is_receipt_title(line) for line in block.text.splitlines()) > 1 for block in raw_titles):
        return _PageEvidence(0, False, False)
    # The current candidate detector partitions vertically. Side-by-side
    # headings must never be mistaken for a proven native single receipt.
    ordered = sorted(raw_titles, key=lambda block: (block.y0, block.x0))
    for left, right in zip(ordered, ordered[1:]):
        if abs(left.y0 - right.y0) < 32 and min(left.x1, right.x1) <= max(left.x0, right.x0):
            return _PageEvidence(0, False, False)
    titles = _deduplicate_title_blocks(raw_titles)
    return _PageEvidence(len(titles), bool(titles), has_vacant_receipt_slots(parsed))


def _template_keys(descriptor: dict[str, Any], *, allow_partial: bool = False) -> set[str] | None:
    if descriptor.get("status") != "ready":
        return None
    receipts = descriptor.get("receipts")
    if not isinstance(receipts, list) or not receipts:
        return None
    keys = {receipt.get("template_fingerprint") for receipt in receipts}
    if not allow_partial and any(not isinstance(key, str) or not key for key in keys):
        return None
    return {key for key in keys if isinstance(key, str) and key} or None


class SourceLayoutIndex:
    """Reuse one bounded source scan across pages and rebuild it after resume."""

    def __init__(self, document: Any, *, descriptor_reader: Callable[[Any], dict[str, Any]] | None = None) -> None:
        self.document = document
        self._descriptor_reader = descriptor_reader or describe_crop_page
        self._scanned = False
        self._complete = True
        self._multi_pages: list[int] = []
        self._multi_keys: set[str] = set()
        self._unknown_multi = False
        self._descriptor_keys: dict[int, set[str] | None] = {}
        self._partial_descriptor_keys: dict[int, set[str] | None] = {}
        self._descriptors: dict[int, dict[str, Any]] = {}
        self._reference_page_numbers: tuple[int, ...] = ()
        self._page_heading_keys: dict[int, set[str]] = {}
        self._page_evidence_counts: dict[int, int] = {}

    def descriptor(self, number: int) -> dict[str, Any]:
        """Share native page identity within this borrowed private document.

        Automatic receipt geometry and source-reference matching both consume
        the same query-independent descriptor. Retain only its anonymous
        metadata, never rendered pixels or page handles. A new source/resume
        creates a fresh index, so a descriptor cannot outlive the SHA-bound PDF.
        """
        if number not in self._descriptors:
            descriptor = self._descriptor_reader(self.document.load_page(number - 1))
            self._descriptors[number] = descriptor
            self._descriptor_keys[number] = _template_keys(descriptor)
            self._partial_descriptor_keys[number] = _template_keys(descriptor, allow_partial=True)
        return self._descriptors[number]

    def _keys(self, number: int) -> set[str] | None:
        self.descriptor(number)
        return self._descriptor_keys[number]

    def _scan(self, current_page: int, parsed: ParsedPage) -> None:
        self._scanned = True
        count = int(self.document.page_count)
        self._complete = count <= MAX_SOURCE_LAYOUT_PAGES
        representatives: list[int] = []
        seen_headings: set[str] = set()
        for number in range(1, min(count, MAX_SOURCE_LAYOUT_PAGES) + 1):
            try:
                page = parsed if number == current_page else parse_loaded_page(self.document.load_page(number - 1), number)
                evidence = _page_evidence(page)
            except (OSError, RuntimeError, ValueError, TypeError):
                self._complete = False
                continue
            if not evidence.usable:
                self._complete = False
            if evidence.count > 1 or evidence.vacant:
                self._multi_pages.append(number)
                headings = {heading for block in page.blocks if not block.is_watermark
                            and (heading := _title_text_from_block(block.text)) is not None}
                self._page_heading_keys[number] = headings
                self._page_evidence_counts[number] = evidence.count
                # The budget should sample distinct forms before spending every
                # slot on repeated copies of the first form in a long source.
                if headings - seen_headings:
                    representatives.append(number)
                    seen_headings.update(headings)
        reference_pages = list(dict.fromkeys([*representatives, *self._multi_pages]))[:MAX_MULTI_TEMPLATE_PAGES]
        self._reference_page_numbers = tuple(reference_pages)
        for number in reference_pages:
            keys = self._keys(number)
            # One verified receipt can prove a positive same-template match.
            # Unknown siblings still prevent the negative inference "single".
            self._multi_keys.update(self._partial_descriptor_keys[number] or set())
            if keys is None:
                self._unknown_multi = True
        if len(self._multi_pages) > MAX_MULTI_TEMPLATE_PAGES:
            self._unknown_multi = True

    def policy(self, number: int, parsed: ParsedPage) -> SourceLayoutPolicy:
        evidence = _page_evidence(parsed)
        if evidence.count > 1 or evidence.vacant:
            return "multiple"
        if not evidence.usable:
            return "unknown"
        if not self._scanned:
            self._scan(number, parsed)
        if not self._multi_pages:
            return "single" if self._complete else "unknown"
        current = self._keys(number)
        if current and current & self._multi_keys:
            return "multiple"
        if current and self._complete and not self._unknown_multi:
            return "single"
        return "unknown"

    def matching_reference_pages(self, number: int, parsed: ParsedPage) -> tuple[int, ...]:
        """Return bounded positive form matches for the new slot pipeline.

        These are reference candidates, not permission to apply their geometry.
        The caller still checks physical geometry and conflicting full layouts.
        No source text or business values are exposed by this method.
        """
        if not self._scanned:
            self._scan(number, parsed)
        current = self._keys(number)
        descriptor = self._descriptors.get(number, {})
        banks = {item.get("issuer_bank_key") for item in descriptor.get("receipts", [])}
        if not current or len(banks) != 1 or None in banks:
            # Some real PDFs have usable repeated headings but an incomplete
            # crop descriptor (for example, image-heavy bank forms). A same
            # heading on a verified multi-receipt page is still positive
            # source-local evidence for a one-receipt tail; the caller will
            # reuse only its slot geometry and will not infer a bank globally.
            current_headings = {
                heading for block in parsed.blocks if not block.is_watermark
                and (heading := _title_text_from_block(block.text)) is not None
            }
            if not current_headings:
                return ()
            return tuple(number for number in self._reference_page_numbers
                         if self._page_evidence_counts.get(number, 0) > 1
                         and current_headings & self._page_heading_keys.get(number, set()))
        matches = []
        for candidate_number in self._reference_page_numbers:
            candidate = self._descriptors.get(candidate_number, {})
            receipts = candidate.get("receipts", [])
            candidate_keys = self._descriptor_keys.get(candidate_number)
            if (candidate_number != number and len(receipts) > 1 and candidate_keys
                    and current <= candidate_keys
                    and {item.get("issuer_bank_key") for item in receipts} == banks):
                matches.append(candidate_number)
        return tuple(sorted(matches))
