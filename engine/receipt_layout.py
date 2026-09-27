"""Query-independent receipt slots, evidence, and instance construction.

This module consumes evidence from a SHA-bound working PDF. Suggestions never
infer an issuing bank from a filename or transaction fields. Unknown content
is retained for review; an empty OCR result is not evidence of a blank slot.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from hashlib import sha256
import json
import math
from typing import Any

from .layout import ReceiptCandidate, _is_receipt_title
from .pdf_parser import ParsedPage, TextBlock
from .pdf_geometry import unrotated_rect_to_visible
from .receipt_layout_models import (
    MAX_LAYOUT_SLOTS, MIN_CROP_SIZE, ReceiptLayoutError, make_instance_id, near,
    parse_layout_definition, parse_page_geometry, parse_page_result,
    parse_processing_options, slot_rect,
)
from .receipt_selection import select_receipt_instances
from .search import SearchBudget
from .source_layout import _vacant_marker
from .receipt_document_types import detect_document_type, document_layout_family
from .receipt_visual_identity import consume_visual_identity, visual_positions


LAYOUT_EVIDENCE_VERSION = "receipt-layout-evidence-v1"
MAX_VISIBLE_OBJECTS = 16_384
MAX_LAYOUT_TEXT_LINES = 4_096
MAX_LAYOUT_DIAGNOSTICS = 10_000
MAX_BLANK_CHECK_PIXELS = 2_000_000


@dataclass(frozen=True)
class PageLayoutEvidence:
    geometry: dict[str, Any]
    parsed: ParsedPage
    candidates: tuple[ReceiptCandidate, ...]
    descriptor: dict[str, Any]
    # Non-text display-list rectangles, already in visible physical points.
    visible_objects: tuple[tuple[str, tuple[float, float, float, float]], ...] = ()
    visual_complete: bool = False
    native_text: bool = True
    budget_exceeded: bool = False
    ocr_attempted: bool = False


@dataclass(frozen=True)
class LayoutSuggestion:
    layout_definition: dict[str, Any]
    basis: str
    needs_review: bool
    diagnostics: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True)
class ReceiptPageComputation:
    result: dict[str, Any]
    suggestion: LayoutSuggestion
    diagnostics: tuple[dict[str, Any], ...]


def _box(value: Any) -> dict[str, float]:
    if isinstance(value, Mapping):
        return {key: float(value[key]) for key in ("x0", "y0", "x1", "y1")}
    if isinstance(value, (tuple, list)):
        return dict(zip(("x0", "y0", "x1", "y1"), map(float, value), strict=True))
    return {key: float(getattr(value, key)) for key in ("x0", "y0", "x1", "y1")}


def _intersects(a: Mapping[str, float], b: Mapping[str, float]) -> bool:
    return min(a["x1"], b["x1"]) > max(a["x0"], b["x0"]) and min(a["y1"], b["y1"]) > max(a["y0"], b["y0"])


def _contains(a: Mapping[str, float], b: Mapping[str, float]) -> bool:
    return all(a[k] <= b[k] or near(a[k], b[k]) for k in ("x0", "y0")) and all(
        b[k] <= a[k] or near(a[k], b[k]) for k in ("x1", "y1")
    )


def _verified_keys(descriptor: Mapping[str, Any]) -> tuple[str | None, tuple[str, ...]]:
    receipts = descriptor.get("receipts")
    if (descriptor.get("status") != "ready" or not isinstance(receipts, list) or not receipts
            or any(not isinstance(receipt, dict) for receipt in receipts)):
        return None, ()
    banks = {receipt.get("issuer_bank_key") for receipt in receipts if isinstance(receipt, dict)}
    fingerprints = {receipt.get("template_fingerprint") for receipt in receipts if isinstance(receipt, dict)}
    if len(banks) != 1 or any(not isinstance(value, str) or len(value) != 64 for value in banks | fingerprints):
        return None, ()
    if any(any(character not in "0123456789abcdef" for character in value) for value in banks | fingerprints):
        return None, ()
    return next(iter(banks)), tuple(sorted(fingerprints))


def _native_issuer_evidence(descriptor: Mapping[str, Any]) -> tuple[str | None, bool]:
    """Keep explicit bank evidence even when a structural fingerprint is absent.

    A common bitmap cannot override differing native issuer headings. Malformed
    or contradictory native identities also prevent anonymous cross-file use.
    """
    receipts = descriptor.get("receipts")
    if descriptor.get("status") != "ready" or not isinstance(receipts, list) or not receipts:
        return None, False
    banks = set()
    for receipt in receipts:
        if not isinstance(receipt, dict):
            return None, True
        bank = receipt.get("issuer_bank_key")
        if bank is None:
            continue
        if not isinstance(bank, str) or len(bank) != 64 or any(c not in "0123456789abcdef" for c in bank):
            return None, True
        banks.add(bank)
    return (next(iter(banks)), False) if len(banks) == 1 else (None, len(banks) > 1)


def compatible_reference(current: PageLayoutEvidence, reference: PageLayoutEvidence, *, require_positions: bool = True) -> bool:
    """Positive form evidence only; never compare transaction text or filenames."""
    if detect_document_type(current.parsed) != detect_document_type(reference.parsed):
        return False
    current_bank, current_keys = _verified_keys(current.descriptor)
    reference_bank, reference_keys = _verified_keys(reference.descriptor)
    a, b = parse_page_geometry(current.geometry), parse_page_geometry(reference.geometry)
    same_form = bool(
        current_bank and current_bank == reference_bank and current_keys
        and set(current_keys).issubset(reference_keys)
        and a["rotation"] == b["rotation"]
        and abs(a["width_pt"] - b["width_pt"]) <= 0.5
        and abs(a["height_pt"] - b["height_pt"]) <= 0.5
    )
    if not same_form or not require_positions:
        return same_form
    # A family fingerprint intentionally omits page-local Y. It does not prove
    # the sheet has the same row starts. Match the actually present headings
    # one-to-one, including tails occupying only a middle or last position.
    used = set()
    for receipt in current.descriptor["receipts"]:
        anchor = receipt.get("anchor_y")
        if isinstance(anchor, bool) or not isinstance(anchor, (int, float)) or not math.isfinite(anchor):
            return False
        matches = []
        for index, target in enumerate(reference.descriptor["receipts"]):
            target_anchor = target.get("anchor_y")
            if (not isinstance(target_anchor, bool) and isinstance(target_anchor, (int, float))
                    and math.isfinite(target_anchor) and abs(anchor - target_anchor) <= 0.5
                    and receipt["template_fingerprint"] == target["template_fingerprint"]):
                matches.append(index)
        if len(matches) != 1 or matches[0] in used:
            return False
        used.add(matches[0])
    return True


def _definition(geometry: dict[str, Any], slots: list[dict[str, Any]], workspace_id: str,
                descriptor: Mapping[str, Any], *, uniform: bool,
                parsed: ParsedPage | None = None) -> dict[str, Any]:
    issuer_id, keys = _verified_keys(descriptor)
    native_issuer, conflicting_issuers = _native_issuer_evidence(descriptor)
    if native_issuer is not None:
        issuer_id = native_issuer
    family_id = sha256("|".join(keys).encode("ascii")).hexdigest() if keys else None
    evidence_version = LAYOUT_EVIDENCE_VERSION
    document_type = detect_document_type(parsed) if parsed is not None else None
    if document_type is not None:
        # Stable special-form identity cannot establish a bank on its own.
        # Keep it separate even when an ordinary tail has the same geometry.
        family_id = sha256((document_type + "|" + str(family_id or "") + "|"
                            + document_layout_family(parsed, document_type)).encode("ascii")).hexdigest()
    elif not conflicting_issuers and (visual_identity := consume_visual_identity(descriptor)) is not None:
        positions = visual_positions({"evidence_version": visual_identity[2]})
        # Saved crops may contain reference-expanded empty rows or custom IDs.
        # Original visual row evidence must map to every saved slot exactly;
        # otherwise retain native/source-local evidence and the saved geometry.
        if (positions is not None and len(positions) == len(slots)
                and all(slot["slot_id"] == f"slot-{index + 1}" and slot["position_index"] == index + 1
                        for index, slot in enumerate(slots))):
            issuer_id = native_issuer or visual_identity[0]
            family_id, evidence_version = visual_identity[1:]
    # An initial definition must bind its geometry. Editing an existing layout
    # keeps its ID and increments revision instead. The reusable *family*
    # fingerprint above contains neither these user parameters nor query data.
    identity = {"version": 1, "issuer": issuer_id, "family": family_id,
                "evidence_version": evidence_version,
                "geometry": geometry, "slots": [{**slot, "top_pt": float(slot["top_pt"]),
                                                  "height_pt": float(slot["height_pt"])} for slot in slots]}
    layout_id = "layout-" + sha256(json.dumps(identity, sort_keys=True).encode("ascii")).hexdigest()
    return parse_layout_definition({
        "schema_version": 1, "layout_id": layout_id, "revision": 1,
        "workspace_id": workspace_id, "issuer_id": issuer_id, "family_id": family_id,
        "evidence_version": evidence_version, "page_geometry": geometry,
        "uniform_height": uniform, "left_pt": 0.0, "right_pt": 0.0, "slots": slots,
    })


def refresh_saved_layout_identity(saved: dict[str, Any], evidence: PageLayoutEvidence) -> dict[str, Any]:
    """Revalidate identity while retaining a SHA/page-bound saved crop exactly."""
    saved = parse_layout_definition(saved)
    if saved["page_geometry"] != parse_page_geometry(evidence.geometry):
        raise ReceiptLayoutError("incompatible_layout", "page_geometry")
    current = _definition(saved["page_geometry"], saved["slots"], saved["workspace_id"],
                          evidence.descriptor, uniform=saved["uniform_height"], parsed=evidence.parsed)
    return parse_layout_definition({**saved, **{key: current[key]
        for key in ("issuer_id", "family_id", "evidence_version")}})


def suggest_equal_slots(geometry: dict[str, Any], slot_count: int, *, workspace_id: str = "default",
                        top_pt: float = 0.0, bottom_pt: float = 0.0,
                        gaps_pt: Sequence[float] | None = None) -> LayoutSuggestion:
    """Manual initial suggestion, with a count bound before any allocation."""
    geometry = parse_page_geometry(geometry)
    height = geometry["height_pt"]
    limit = min(MAX_LAYOUT_SLOTS, math.floor(height / min(MIN_CROP_SIZE, height)))
    if type(slot_count) is not int or not 1 <= slot_count <= limit:
        raise ReceiptLayoutError("invalid_layout", "slot_count")
    if gaps_pt is None:
        gaps_pt = [0.0] * (slot_count - 1)
    if len(gaps_pt) != slot_count - 1 or any(
        isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0
        for value in (top_pt, bottom_pt, *gaps_pt)
    ):
        raise ReceiptLayoutError("invalid_layout", "spacing")
    common_height = (height - top_pt - bottom_pt - sum(gaps_pt)) / slot_count
    top = top_pt
    slots = []
    for index in range(slot_count):
        slots.append({"slot_id": f"slot-{index + 1}", "position_index": index + 1,
                      "top_pt": top, "height_pt": common_height})
        top += common_height + (gaps_pt[index] if index < slot_count - 1 else 0.0)
    return LayoutSuggestion(_definition(geometry, slots, workspace_id, {}, uniform=True), "equal_division", True)


def _evidence_slots(evidence: PageLayoutEvidence) -> list[dict[str, Any]]:
    candidates = sorted(evidence.candidates, key=lambda candidate: (candidate.rect.y0, candidate.rect.x0))
    if not candidates or len(candidates) > MAX_LAYOUT_SLOTS:
        raise ReceiptLayoutError("invalid_layout", "candidates")
    slots = [{"slot_id": f"slot-{index + 1}", "position_index": index + 1,
              "top_pt": candidate.rect.y0, "height_pt": candidate.rect.y1 - candidate.rect.y0}
             for index, candidate in enumerate(candidates)]
    # PDF generators often draw a separator on both neighbouring receipts.
    # The detector then reports a tiny one-point overlap (for example, the
    # first box ends at 565.125 while the next starts at 564.125).  Treating
    # that harmless seam as an invalid layout collapsed a valid tail page to
    # the one-slot equal-division fallback, which produced a full-page box.
    # Split only a small shared seam at its midpoint. Some bank PDFs draw a
    # perforation/scissors marker across the seam, which can make the two
    # detector boxes overlap by several points. Text crossing the boundary is
    # stronger evidence of a real ambiguous layout and still falls back to
    # manual review.
    for index in range(len(slots) - 1):
        current = slots[index]
        following = slots[index + 1]
        current_bottom = current["top_pt"] + current["height_pt"]
        following_top = following["top_pt"]
        overlap = current_bottom - following_top
        if overlap <= 0:
            continue
        allowed_overlap = min(12.0, 0.05 * min(current["height_pt"], following["height_pt"]))
        if overlap > allowed_overlap:
            raise ReceiptLayoutError("invalid_layout", "overlapping_candidates")
        if overlap > 4.0:
            pair = candidates[index:index + 2]
            if (not evidence.visual_complete
                    or any("repeated_title" not in candidate.evidence for candidate in pair)
                    or any(
                        kind == "fill-image" and max(0.0, box[3] - box[1]) > 8.0
                        and box[1] < current_bottom and box[3] > following_top
                        for kind, box in evidence.visible_objects
                    )):
                raise ReceiptLayoutError("invalid_layout", "ambiguous_seam")
        boundary = (current_bottom + following_top) / 2.0
        crossing_text = any(
            not block.is_watermark
            and block.y0 < boundary < block.y1
            for block in evidence.parsed.blocks
        )
        if crossing_text:
            raise ReceiptLayoutError("invalid_layout", "overlapping_content")
        current["height_pt"] = boundary - current["top_pt"]
        following["height_pt"] = following["top_pt"] + following["height_pt"] - boundary
        following["top_pt"] = boundary
    # Keep a visible stamp/image that extends into an otherwise unused seam.
    # Expand the suggested crop to include it; never silently disregard ink
    # outside a crop, and never expand into another receipt or off the paper.
    original_rects = [{"x0": 0.0, "y0": slot["top_pt"], "x1": evidence.geometry["width_pt"],
                       "y1": slot["top_pt"] + slot["height_pt"]} for slot in slots]
    for index, slot in enumerate(slots):
        rect = original_rects[index]
        lower = original_rects[index - 1]["y1"] if index else 0.0
        upper = original_rects[index + 1]["y0"] if index + 1 < len(slots) else evidence.geometry["height_pt"]
        for kind, raw in evidence.visible_objects:
            box = _box(raw)
            if kind != "fill-image" or not _intersects(rect, box) or _contains(rect, box):
                continue
            if (0 <= box["x0"] < box["x1"] <= evidence.geometry["width_pt"]
                    and lower <= box["y0"] < box["y1"] <= upper
                    and max(rect["y0"] - box["y0"], 0) + max(box["y1"] - rect["y1"], 0) <= 12):
                top = min(slot["top_pt"], box["y0"])
                bottom = max(slot["top_pt"] + slot["height_pt"], box["y1"])
                slot.update(top_pt=top, height_pt=bottom - top)
    return slots


def suggest_layout(evidence: PageLayoutEvidence, *, workspace_id: str = "default",
                   source_policy: str = "unknown", reference: PageLayoutEvidence | None = None,
                   slot_count: int | None = None) -> LayoutSuggestion:
    geometry = parse_page_geometry(evidence.geometry)
    if source_policy not in {"single", "multiple", "unknown"}:
        raise ReceiptLayoutError("invalid_layout", "source_policy")
    if slot_count is not None:
        return suggest_equal_slots(geometry, slot_count, workspace_id=workspace_id)
    if source_policy == "single" and len(evidence.candidates) == 1:
        slots = [{"slot_id": "slot-1", "position_index": 1, "top_pt": 0.0, "height_pt": geometry["height_pt"]}]
        return LayoutSuggestion(_definition(geometry, slots, workspace_id, evidence.descriptor,
                                            uniform=True, parsed=evidence.parsed),
                                "native_single", evidence.budget_exceeded or detect_document_type(evidence.parsed) is not None)
    base, basis = evidence, "page_evidence"
    if reference is not None:
        if not compatible_reference(evidence, reference):
            raise ReceiptLayoutError("incompatible_layout", "reference")
        base, basis = reference, "source_reference"
    try:
        slots = _evidence_slots(base)
        # Prefer a common height only if it covers every suggested receipt and
        # still fits every gap. Otherwise keep independent heights visibly.
        common = max(slot["height_pt"] for slot in slots)
        available = [slots[index + 1]["top_pt"] - slot["top_pt"] if index + 1 < len(slots)
                     else geometry["height_pt"] - slot["top_pt"] for index, slot in enumerate(slots)]
        # A common height is safe only when the detected receipt heights are
        # already effectively equal.  Using the gap to the next slot as the
        # sole constraint can extend the last candidate beyond its detected
        # bottom (especially after correcting a one-point shared separator),
        # causing a tail crop to include neighbouring blank content.
        uniform = (
            all(abs(common - slot["height_pt"]) <= 0.5 for slot in slots)
            and all(common <= value or near(common, value) for value in available)
        )
        if uniform:
            slots = [{**slot, "height_pt": common} for slot in slots]
        layout = _definition(geometry, slots, workspace_id, base.descriptor, uniform=uniform, parsed=base.parsed)
    except ReceiptLayoutError:
        # Unsupported/overlapping geometry stays an explicit initial suggestion.
        initial = suggest_equal_slots(geometry, 1, workspace_id=workspace_id)
        return replace(initial, diagnostics=({"code": "layout_requires_manual_slots"},))
    unknown_single = len(slots) == 1 and source_policy != "single"
    needs_review = (evidence.budget_exceeded or base.budget_exceeded or unknown_single
                    or any(candidate.confidence < 0.9 for candidate in base.candidates))
    return LayoutSuggestion(layout, basis, needs_review)


def collect_visible_objects(visible_page: Any) -> tuple[tuple[Any, ...], bool]:
    """Read bounded geometry only. Failure cannot prove that a page is blank."""
    try:
        result = []
        for index, (kind, raw_box, *_rest) in enumerate(visible_page.get_bboxlog()):
            if index >= MAX_VISIBLE_OBJECTS:
                return (), False
            if kind in {"fill-text", "stroke-text", "ignore-text"}:
                continue
            box = _box(raw_box)
            if not all(math.isfinite(value) for value in box.values()):
                return (), False
            if box["x1"] > box["x0"] and box["y1"] > box["y0"]:
                result.append((kind, tuple(box[key] for key in ("x0", "y0", "x1", "y1"))))
        return tuple(result), True
    except (ValueError, TypeError, RuntimeError, AttributeError):
        return (), False


def split_cross_slot_text(parsed: ParsedPage, layout: dict[str, Any], visible_page: Any) -> ParsedPage:
    """Split only native blocks crossing slots, using real line geometry.

    Unrelated neighbouring blocks are never joined. An unsplittable OCR block
    or malformed optional line data remains intact for the selector's explicit
    ambiguity handling; clipping a rectangle while retaining its text is unsafe.
    """
    boxes = [slot_rect(layout, slot) for slot in layout["slots"]]
    crossing = [block for block in parsed.blocks if sum(_intersects(box, _box(block)) for box in boxes) > 1]
    if not crossing:
        return parsed
    try:
        import pymupdf
        raw = visible_page.get_text("dict", flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES)
        metadata = raw.get("blocks", [])
        if len(metadata) > MAX_LAYOUT_TEXT_LINES:
            return parsed
        replacements: dict[int, tuple[TextBlock, ...]] = {}
        count = 0
        for block in crossing:
            matching = [item for item in metadata if item.get("type") == 0 and all(
                near(_box(item["bbox"])[key], _box(block)[key]) for key in ("x0", "y0", "x1", "y1"))]
            if len(matching) != 1:
                continue
            lines = matching[0].get("lines", [])
            count += len(lines)
            if count > MAX_LAYOUT_TEXT_LINES:
                return parsed
            split = []
            for line in lines:
                text = "".join(span.get("text", "") for span in line.get("spans", [])).strip()
                if not text:
                    continue
                rect = _box(line["bbox"])
                if not _contains(_box(block), rect):
                    break
                split.append(replace(block, text=text, **rect))
            else:
                if split and "".join("".join(item.text.split()) for item in split) == "".join(block.text.split()):
                    replacements[block.block_index] = tuple(split)
        if not replacements:
            return parsed
        blocks = tuple(item for block in parsed.blocks for item in replacements.get(block.block_index, (block,)))
        return replace(parsed, blocks=blocks)
    except (AttributeError, KeyError, TypeError, ValueError, RuntimeError):
        return parsed


def _rendered_slot_is_blank(rect: dict[str, float], visible_page: Any, remaining_pixels: int,
                            *, image_boxes: Sequence[tuple[float, float, float, float]],
                            geometry: dict[str, Any]) -> tuple[bool, int]:
    """Prove a bitmap margin is white; unknown rendering always keeps the slot.

    A saved crop can graze the white padding of an adjacent stamp's image.
    Its display-list rectangle alone cannot establish a second receipt. Only
    that ambiguous case reaches this bounded check, never every slot. Do not
    downsample: that can round faint high-resolution pixels to white. Unknown
    image resolution/transform keeps the candidate. RGB and exact white retain
    faint or coloured ink; a source-pixel padding protects partial crop edges.
    """
    if visible_page is None:
        return False, remaining_pixels
    try:
        import pymupdf
        metadata = visible_page.get_image_info()
        if not metadata or len(metadata) > MAX_VISIBLE_OBJECTS:
            return False, remaining_pixels
        images_by_box: dict[tuple[float, ...], list[dict[str, Any]]] = {}
        for item in metadata:
            image_rect = unrotated_rect_to_visible(item["bbox"], geometry)
            key = tuple(image_rect[key] for key in ("x0", "y0", "x1", "y1"))
            images_by_box.setdefault(key, []).append(item)
        for image_box in image_boxes:
            box = _box(image_box)
            # Exact placement association is conservative on numeric mismatch
            # and keeps many small image objects from causing quadratic work.
            matches = images_by_box.get(tuple(box[key] for key in ("x0", "y0", "x1", "y1")), [])
            if not matches:
                return False, remaining_pixels
            scale, padding = 2, 0.0
            for item in matches:
                a, b, c, d, _e, _f = item["transform"]
                width, height = item["width"], item["height"]
                if (not all(math.isfinite(value) for value in (a, b, c, d, width, height))
                        or width <= 0 or height <= 0
                        or not ((b == c == 0 and a != 0 and d != 0)
                                or (a == d == 0 and b != 0 and c != 0))):
                    return False, remaining_pixels
                # Page quarter-turns preserve these source pixel sizes. Skew
                # or arbitrary image rotations need a stronger proof and stay.
                pitch_x, pitch_y = math.hypot(a, b) / width, math.hypot(c, d) / height
                scale = max(scale, math.ceil(1 / min(pitch_x, pitch_y)))
                padding = max(padding, pitch_x, pitch_y)
            clip = {"x0": max(box["x0"], rect["x0"] - padding),
                    "y0": max(box["y0"], rect["y0"] - padding),
                    "x1": min(box["x1"], rect["x1"] + padding),
                    "y1": min(box["y1"], rect["y1"] + padding)}
            width = math.ceil(clip["x1"] * scale) - math.floor(clip["x0"] * scale)
            height = math.ceil(clip["y1"] * scale) - math.floor(clip["y0"] * scale)
            pixels = width * height
            if pixels <= 0 or pixels > remaining_pixels:
                return False, remaining_pixels
            remaining_pixels -= pixels
            pixmap = visible_page.get_pixmap(matrix=pymupdf.Matrix(scale, scale),
                clip=pymupdf.Rect(tuple(clip[key] for key in ("x0", "y0", "x1", "y1"))),
                colorspace=pymupdf.csRGB, alpha=False)
            samples = pixmap.samples
            if (pixmap.width != width or pixmap.height != height or len(samples) != pixels * 3
                    or samples.count(255) != len(samples)):
                return False, remaining_pixels
        return True, remaining_pixels
    except Exception:
        # MuPDF decoder errors derive from FzErrorBase, not RuntimeError.
        # A failed optional proof must retain the candidate, never abort a page.
        return False, remaining_pixels


def instantiate_receipts(evidence: PageLayoutEvidence, layout: dict[str, Any], source_sha256: str,
                         *, parsed: ParsedPage | None = None, visible_page: Any = None,
                         suggest_invalid_slots: bool = True,
                         ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], tuple[dict[str, Any], ...]]:
    layout = parse_layout_definition(layout)
    if layout["page_geometry"] != parse_page_geometry(evidence.geometry):
        raise ReceiptLayoutError("incompatible_layout", "page_geometry")
    parsed = evidence.parsed if parsed is None else parsed
    instances, excluded, diagnostics = [], [], []
    blank_pixels_remaining = MAX_BLANK_CHECK_PIXELS
    can_check_image_margin = (evidence.visual_complete and evidence.native_text
                              and any(not block.is_watermark for block in parsed.blocks))
    diagnostic_budget_exceeded = False
    def report(diagnostic: dict[str, Any]) -> None:
        nonlocal diagnostic_budget_exceeded
        if len(diagnostics) < MAX_LAYOUT_DIAGNOSTICS:
            diagnostics.append(diagnostic)
        else:
            diagnostic_budget_exceeded = True
    for slot in layout["slots"]:
        rect = slot_rect(layout, slot)
        blocks = [block for block in parsed.blocks if not block.is_watermark and _intersects(rect, _box(block))]
        markers = [block for block in blocks if _vacant_marker(block.text)]
        content = [block for block in blocks if not _vacant_marker(block.text)]
        visible_objects = [(kind, box) for kind, box in evidence.visible_objects if _intersects(rect, _box(box))
                           and (kind == "fill-image" or (box[2] - box[0] > 2 and box[3] - box[1] > 2))]
        objects = [box for _kind, box in visible_objects]
        # Isolated printed invalid markers are positive evidence only when no
        # other text or unexamined image could contain a valid receipt.
        if markers and not content and not objects and evidence.visual_complete:
            excluded.append({"slot_id": slot["slot_id"], "reason": "invalid"})
            continue
        if not blocks and not objects and evidence.visual_complete:
            excluded.append({"slot_id": slot["slot_id"], "reason": "blank"})
            continue
        if (not blocks and objects and can_check_image_margin
                and all(kind == "fill-image" and not _contains(rect, _box(box))
                        for kind, box in visible_objects)):
            blank, blank_pixels_remaining = _rendered_slot_is_blank(rect, visible_page, blank_pixels_remaining,
                image_boxes=objects, geometry=evidence.geometry)
            if blank:
                excluded.append({"slot_id": slot["slot_id"], "reason": "blank"})
                continue
        # An isolated invalid-slip marker is evidence worth surfacing, but
        # other content or visible objects prevent a safe automatic exclusion.
        # Keep the candidate and ask a person; never persist source text.
        if (suggest_invalid_slots and (content or objects)
                and any(_contains(rect, _box(marker)) for marker in markers)):
            report({"code": "suspected_invalid_slot", "slot_id": slot["slot_id"]})
        complete_content = [block for block in content if _contains(rect, _box(block))]
        occupancy = "occupied" if complete_content else "uncertain"
        instance = {
            "instance_id": make_instance_id(source_sha256, parsed.page_number, layout, slot["slot_id"]),
            "source_sha256": source_sha256, "page": parsed.page_number,
            "layout_id": layout["layout_id"], "layout_revision": layout["revision"],
            "slot_id": slot["slot_id"], "position_index": slot["position_index"],
            "rect": rect, "occupancy": occupancy,
        }
        instances.append(instance)
        for block in content:
            if block.confidence < 0.9:
                report({"code": "uncertain_text", "slot_id": slot["slot_id"], "rect": _box(block)})
            if not _contains(rect, _box(block)):
                report({"code": "content_crosses_slot", "slot_id": slot["slot_id"], "rect": _box(block),
                        "kind": "title" if _is_receipt_title(block.text) else "text"})
        for box in objects:
            box_rect = _box(box)
            if not _contains(rect, box_rect):
                report({"code": "visual_crosses_slot", "slot_id": slot["slot_id"], "rect": box_rect})
        if occupancy == "uncertain":
            report({"code": "occupancy_uncertain", "slot_id": slot["slot_id"]})
    boxes = [slot_rect(layout, slot) for slot in layout["slots"]]
    for block in parsed.blocks:
        if not block.is_watermark and not _vacant_marker(block.text) and not any(_intersects(box, _box(block)) for box in boxes):
            report({"code": "content_outside_slots", "rect": _box(block)})
    for kind, object_box in evidence.visible_objects:
        if ((kind == "fill-image" or (object_box[2] - object_box[0] > 2 and object_box[3] - object_box[1] > 2))
                and not any(_intersects(box, _box(object_box)) for box in boxes)):
            report({"code": "visual_outside_slots", "rect": _box(object_box)})
    if diagnostic_budget_exceeded:
        diagnostics.append({"code": "diagnostic_budget_exceeded"})
    return instances, excluded, tuple(diagnostics)


def compute_receipt_page(evidence: PageLayoutEvidence, source_sha256: str, processing_options: dict[str, Any],
                         *, match_mode: str = "exact", budget: SearchBudget | None = None,
                         suggestion: LayoutSuggestion | None = None, visible_page: Any = None,
                         source_policy: str = "unknown", reference: PageLayoutEvidence | None = None,
                         workspace_id: str = "default", slot_count: int | None = None) -> ReceiptPageComputation:
    options = parse_processing_options(processing_options)
    suggestion = suggestion or suggest_layout(evidence, workspace_id=workspace_id, source_policy=source_policy,
                                               reference=reference, slot_count=slot_count)
    document_type = detect_document_type(evidence.parsed)
    if document_type is not None:
        # This page notice survives explicit calibration and saved-layout reuse.
        # It names only a controlled type, never source text or business values.
        suggestion = replace(suggestion,
            needs_review=suggestion.needs_review or suggestion.basis != "manual_layout",
            diagnostics=(*suggestion.diagnostics, {"code": "special_document", "document_type": document_type}))
    layout = suggestion.layout_definition
    parsed = (split_cross_slot_text(evidence.parsed, layout, visible_page)
              if evidence.native_text and visible_page is not None else evidence.parsed)
    instances, excluded, risks = instantiate_receipts(evidence, layout, source_sha256, parsed=parsed,
                                                      visible_page=visible_page,
                                                      suggest_invalid_slots=document_type is None)
    selection = select_receipt_instances(parsed, instances, options, match_mode=match_mode, budget=budget)
    risky_slots = {risk["slot_id"] for risk in risks if "slot_id" in risk}
    global_risk = any(risk["code"] in {"content_outside_slots", "visual_outside_slots", "diagnostic_budget_exceeded"} for risk in risks)
    by_id = {instance["instance_id"]: instance for instance in instances}
    candidates = [{**candidate, "needs_review": bool(candidate["needs_review"] or suggestion.needs_review or global_risk
                   or by_id[candidate["instance_id"]]["slot_id"] in risky_slots)} for candidate in selection.candidates]
    result = parse_page_result({"schema_version": 1, "processing_mode": options["processing_mode"],
        "source_sha256": source_sha256, "page": parsed.page_number, "layout_definition": layout,
        "instances": instances, "excluded_slots": excluded, "candidates": candidates})
    return ReceiptPageComputation(result, suggestion, (*suggestion.diagnostics, *risks,
                                                       *(item.as_dict() for item in selection.diagnostics)))
