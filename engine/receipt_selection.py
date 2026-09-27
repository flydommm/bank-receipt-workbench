"""Select receipt instances from one prepared PDF page.

This module is the P2 bridge between the existing bounded text search and the
receipt-layout v1 result model.  It does not split native PDF text blocks or
infer a layout; the caller supplies a prepared :class:`ParsedPage` and the
visible-coordinate instance rectangles.  Search is performed once per
physical page, then every match is evaluated independently for each instance.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
import math
from typing import Final

from .pdf_parser import ParsedPage, TextBlock
from .receipt_layout_models import ReceiptLayoutError, near, parse_processing_options
from .search import (
    SearchBudget,
    SearchBudgetExceeded,
    SearchClause,
    SearchMatch,
    register_page_budget,
    search_pages_multi,
)


_VALID_MATCH_MODES: Final = frozenset(("exact", "fuzzy"))
_RECT_FIELDS: Final = ("x0", "y0", "x1", "y1")
_INSTANCE_ID_MAX_LENGTH: Final = 1024
_REVIEW_CONFIDENCE_THRESHOLD: Final = 0.9


@dataclass(frozen=True, slots=True)
class SelectionDiagnostic:
    """A safe explanation for a match that cannot be assigned automatically.

    Only stable query/geometry identifiers are retained.  Matched text is
    intentionally absent so diagnostics cannot leak source document content.
    """

    code: str
    query_id: str | None
    rect: dict[str, float]
    instance_ids: tuple[str, ...]

    def as_dict(self) -> dict[str, object]:
        """Return a JSON-shaped copy suitable for a UI or audit record."""

        return {
            "code": self.code,
            "query_id": self.query_id,
            "rect": dict(self.rect),
            "instance_ids": list(self.instance_ids),
        }


@dataclass(frozen=True, slots=True)
class ReceiptSelectionResult:
    """Selection output for one page and one explicit processing mode."""

    candidates: tuple[dict[str, object], ...]
    matches: tuple[SearchMatch, ...]
    diagnostics: tuple[SelectionDiagnostic, ...]


@dataclass(frozen=True, slots=True)
class _Instance:
    instance_id: str
    rect: dict[str, float]
    occupancy: str


def _fail(code: str, path: str) -> None:
    raise ReceiptLayoutError(code, path)


def _finite_number(value: object, code: str, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(code, path)
    try:
        result = float(value)
    except (OverflowError, TypeError, ValueError):
        _fail(code, path)
    if not math.isfinite(result):
        _fail(code, path)
    return result


def _safe_rect(
    value: object,
    *,
    width: float,
    height: float,
    code: str,
    path: str,
) -> dict[str, float]:
    if not isinstance(value, Mapping) or set(value) != set(_RECT_FIELDS):
        _fail(code, path)
    rect = {
        edge: _finite_number(value[edge], code, f"{path}.{edge}")
        for edge in _RECT_FIELDS
    }
    if (
        rect["x0"] >= rect["x1"]
        or rect["y0"] >= rect["y1"]
        or (rect["x0"] < 0 and not near(rect["x0"], 0.0))
        or (rect["y0"] < 0 and not near(rect["y0"], 0.0))
        or (rect["x1"] > width and not near(rect["x1"], width))
        or (rect["y1"] > height and not near(rect["y1"], height))
    ):
        _fail(code, path)
    return rect


def _validate_page(page: ParsedPage, *, validate_blocks: bool) -> tuple[float, float]:
    if not isinstance(page, ParsedPage):
        _fail("invalid_selection", "page")
    if type(page.page_number) is not int or page.page_number < 1:
        _fail("invalid_selection", "page.page_number")
    width = _finite_number(page.width, "invalid_selection", "page.width")
    height = _finite_number(page.height, "invalid_selection", "page.height")
    if width <= 0 or height <= 0:
        _fail("invalid_selection", "page")
    if not isinstance(page.text, str) or not isinstance(page.blocks, Sequence):
        _fail("invalid_selection", "page")
    if validate_blocks:
        for index, block in enumerate(page.blocks):
            block_path = f"page.blocks[{index}]"
            if not isinstance(block, TextBlock):
                _fail("invalid_selection", block_path)
            if type(block.page_number) is not int or block.page_number != page.page_number:
                _fail("invalid_selection", f"{block_path}.page_number")
            if not isinstance(block.text, str):
                _fail("invalid_selection", f"{block_path}.text")
            _safe_rect(
                {
                    "x0": block.x0,
                    "y0": block.y0,
                    "x1": block.x1,
                    "y1": block.y1,
                },
                width=width,
                height=height,
                code="invalid_selection",
                path=f"{block_path}.rect",
            )
            _finite_number(block.confidence, "invalid_selection", f"{block_path}.confidence")
    return width, height


def _validate_optional_identity_fields(raw: Mapping[str, object], page_number: int, path: str) -> None:
    """Validate v1 identity fields when a caller supplies them.

    The selector only consumes the stable ID, rectangle, and occupancy.  The
    complete page-result parser validates all v1 fields; these checks prevent
    an accidentally mismatched page or a boolean identity from being used by
    this lower-level entry point when a partial instance mapping is supplied.
    """

    for field in ("page", "layout_revision", "position_index"):
        if field not in raw:
            continue
        value = raw[field]
        if type(value) is not int or value < 1:
            _fail("invalid_instance", f"{path}.{field}")
        if field == "page" and value != page_number:
            _fail("invalid_instance", f"{path}.{field}")
    for field in ("source_sha256", "layout_id", "slot_id"):
        if field in raw and (not isinstance(raw[field], str) or not raw[field]):
            _fail("invalid_instance", f"{path}.{field}")


def _validate_instances(
    instances: Sequence[dict[str, object]] | Sequence[Mapping[str, object]],
    *,
    page_number: int,
    width: float,
    height: float,
) -> tuple[_Instance, ...]:
    if isinstance(instances, (str, bytes, bytearray)) or not isinstance(instances, Sequence):
        _fail("invalid_instance", "instances")
    result: list[_Instance] = []
    seen: set[str] = set()
    for index, raw in enumerate(instances):
        path = f"instances[{index}]"
        if not isinstance(raw, Mapping):
            _fail("invalid_instance", path)
        required = ("instance_id", "rect", "occupancy")
        if any(field not in raw for field in required):
            _fail("invalid_instance", path)
        instance_id = raw["instance_id"]
        if (
            not isinstance(instance_id, str)
            or not instance_id
            or len(instance_id) > _INSTANCE_ID_MAX_LENGTH
            or any(0xD800 <= ord(char) <= 0xDFFF for char in instance_id)
            or instance_id in seen
        ):
            _fail("invalid_instance", f"{path}.instance_id")
        occupancy = raw["occupancy"]
        if occupancy not in ("occupied", "uncertain"):
            _fail("invalid_instance", f"{path}.occupancy")
        _validate_optional_identity_fields(raw, page_number, path)
        rect = _safe_rect(
            raw["rect"],
            width=width,
            height=height,
            code="invalid_instance",
            path=f"{path}.rect",
        )
        seen.add(instance_id)
        result.append(_Instance(instance_id, rect, occupancy))
    return tuple(result)


def _contains(outer: Mapping[str, float], inner: Mapping[str, float]) -> bool:
    return (
        (outer["x0"] <= inner["x0"] or near(outer["x0"], inner["x0"]))
        and (outer["y0"] <= inner["y0"] or near(outer["y0"], inner["y0"]))
        and (inner["x1"] <= outer["x1"] or near(inner["x1"], outer["x1"]))
        and (inner["y1"] <= outer["y1"] or near(inner["y1"], outer["y1"]))
    )


def _intersects(left: Mapping[str, float], right: Mapping[str, float]) -> bool:
    return (
        min(left["x1"], right["x1"]) > max(left["x0"], right["x0"])
        and min(left["y1"], right["y1"]) > max(left["y0"], right["y0"])
    )


def _match_rect(
    match: SearchMatch,
    *,
    page: ParsedPage,
    width: float,
    height: float,
    index: int,
) -> tuple[dict[str, float], float]:
    path = f"matches[{index}]"
    if not isinstance(match, SearchMatch):
        _fail("invalid_selection", path)
    if type(match.page_number) is not int or match.page_number != page.page_number:
        _fail("invalid_selection", f"{path}.page_number")
    if not isinstance(match.query_id, str) or not match.query_id:
        _fail("invalid_selection", f"{path}.query_id")
    if match.role not in ("include", "exclude"):
        _fail("invalid_selection", f"{path}.role")
    confidence = _finite_number(match.confidence, "invalid_selection", f"{path}.confidence")
    rect = _safe_rect(
        {"x0": match.x0, "y0": match.y0, "x1": match.x1, "y1": match.y1},
        width=width,
        height=height,
        code="invalid_selection",
        path=f"{path}.rect",
    )
    return rect, confidence


def _diagnostic(
    diagnostics: list[SelectionDiagnostic],
    seen: set[tuple[str, str | None, tuple[float, float, float, float], tuple[str, ...]]],
    *,
    code: str,
    query_id: str | None,
    rect: dict[str, float],
    instance_ids: Sequence[str],
) -> None:
    ids = tuple(instance_ids)
    key = (code, query_id, tuple(rect[edge] for edge in _RECT_FIELDS), ids)
    if key in seen:
        return
    seen.add(key)
    diagnostics.append(SelectionDiagnostic(code, query_id, dict(rect), ids))


def _validate_budget(budget: SearchBudget | None) -> None:
    if budget is None:
        return
    if not isinstance(budget, SearchBudget):
        raise SearchBudgetExceeded("invalid search budget")
    budget.to_dict()


def select_receipt_instances(
    page: ParsedPage,
    instances: Sequence[dict[str, object]] | Sequence[Mapping[str, object]],
    processing_options: Mapping[str, object] | dict[str, object],
    match_mode: str = "exact",
    budget: SearchBudget | None = None,
) -> ReceiptSelectionResult:
    """Select v1 receipt candidates for one prepared physical page.

    ``instances`` use visible top-left coordinates and may be a partial
    mapping containing only the fields consumed here.  The caller's full
    ``page_result`` parser remains responsible for validating and persisting
    the complete v1 instance identity.
    """

    if not isinstance(processing_options, Mapping):
        _fail("invalid_processing", "processing_options")
    options = parse_processing_options(dict(processing_options))
    if not isinstance(match_mode, str) or match_mode not in _VALID_MATCH_MODES:
        _fail("invalid_processing", "match_mode")
    _validate_budget(budget)
    mode = options["processing_mode"]
    criteria = options["criteria"]
    assert isinstance(mode, str)
    width, height = _validate_page(page, validate_blocks=True)
    parsed_instances = _validate_instances(
        instances,
        page_number=page.page_number,
        width=width,
        height=height,
    )

    if mode == "split_all":
        register_page_budget(page, budget)
        return ReceiptSelectionResult(
            candidates=tuple(
                {
                    "instance_id": instance.instance_id,
                    "selection_basis": "occupied_slot",
                    "evidence": [],
                    "needs_review": instance.occupancy == "uncertain",
                }
                for instance in parsed_instances
            ),
            matches=(),
            diagnostics=(),
        )

    assert isinstance(criteria, Mapping)
    include = criteria["include"]
    include_mode = criteria["includeMode"]
    exclude = criteria["exclude"]
    assert isinstance(include, list) and isinstance(exclude, list)
    assert isinstance(include_mode, str)
    clauses = tuple(
        SearchClause(f"{role}-{index}", keyword, role)
        for role, keywords in (("include", include), ("exclude", exclude))
        for index, keyword in enumerate(keywords)
    )
    # Exactly one call gives every clause the same page/budget accounting and
    # avoids a separate search pass for each slot or query.
    raw_matches = search_pages_multi(
        (page,),
        clauses,
        exact=match_mode == "exact",
        budget=budget,
    )
    matches = tuple(raw_matches)
    expected_roles = {
        f"{role}-{index}": role
        for role, keywords in (("include", include), ("exclude", exclude))
        for index, _keyword in enumerate(keywords)
    }
    include_hits: dict[str, dict[str, list[dict[str, float]]]] = {
        instance.instance_id: {} for instance in parsed_instances
    }
    exclude_hits: dict[str, set[str]] = {instance.instance_id: set() for instance in parsed_instances}
    needs_review: set[str] = {
        instance.instance_id
        for instance in parsed_instances
        if instance.occupancy == "uncertain"
    }
    diagnostics: list[SelectionDiagnostic] = []
    seen_diagnostics: set[tuple[str, str | None, tuple[float, float, float, float], tuple[str, ...]]] = set()
    seen_evidence: dict[str, set[tuple[str, float, float, float, float]]] = {
        instance.instance_id: set() for instance in parsed_instances
    }

    for index, match in enumerate(matches):
        rect, confidence = _match_rect(match, page=page, width=width, height=height, index=index)
        low_confidence = confidence < _REVIEW_CONFIDENCE_THRESHOLD
        query_id = match.query_id
        assert isinstance(query_id, str)
        expected_role = expected_roles.get(query_id)
        if expected_role is None or match.role != expected_role:
            _fail("invalid_selection", f"matches[{index}].query_id")
        role = expected_role
        intersecting = [
            instance
            for instance in parsed_instances
            if _intersects(instance.rect, rect)
        ]
        containing = [
            instance
            for instance in intersecting
            if _contains(instance.rect, rect)
        ]
        if len(intersecting) == 0:
            _diagnostic(
                diagnostics,
                seen_diagnostics,
                code="unassigned_block",
                query_id=query_id,
                rect=rect,
                instance_ids=(),
            )
            continue

        is_reliable = len(intersecting) == 1 and len(containing) == 1
        if len(intersecting) > 1:
            diagnostic_code = "ambiguous_block"
        elif not is_reliable:
            diagnostic_code = "cross_boundary_block"
        else:
            diagnostic_code = None
        if diagnostic_code is not None:
            _diagnostic(
                diagnostics,
                seen_diagnostics,
                code=diagnostic_code,
                query_id=query_id,
                rect=rect,
                instance_ids=tuple(instance.instance_id for instance in intersecting),
            )

        # An include crossing a slot boundary is useful evidence for every
        # affected target, but only as a review candidate.  An exclude with
        # the same ambiguity is never allowed to remove a target.
        if role == "exclude" and low_confidence:
            target_instances = intersecting if not is_reliable else containing
            needs_review.update(instance.instance_id for instance in target_instances)
            _diagnostic(
                diagnostics,
                seen_diagnostics,
                code="low_confidence_exclude",
                query_id=query_id,
                rect=rect,
                instance_ids=tuple(instance.instance_id for instance in target_instances),
            )
            continue

        if role == "exclude" and not is_reliable:
            needs_review.update(instance.instance_id for instance in intersecting)
            continue

        target_instances = intersecting if role == "include" and not is_reliable else containing
        for instance in target_instances:
            if role == "include":
                evidence_key = (query_id, *(rect[edge] for edge in _RECT_FIELDS))
                if evidence_key in seen_evidence[instance.instance_id]:
                    continue
                seen_evidence[instance.instance_id].add(evidence_key)
                include_hits[instance.instance_id].setdefault(query_id, []).append(dict(rect))
                if not is_reliable or low_confidence:
                    needs_review.add(instance.instance_id)
            elif is_reliable:
                exclude_hits[instance.instance_id].add(query_id)

    candidates: list[dict[str, object]] = []
    include_query_ids = [f"include-{index}" for index in range(len(include))]
    for instance in parsed_instances:
        hits = include_hits[instance.instance_id]
        matched_queries = set(hits)
        include_satisfied = (
            all(query_id in matched_queries for query_id in include_query_ids)
            if include_mode == "all"
            else any(query_id in matched_queries for query_id in include_query_ids)
        )
        if not include_satisfied or exclude_hits[instance.instance_id]:
            continue
        evidence = [
            {
                "query_id": query_id,
                "rect": dict(evidence_rect),
            }
            for query_id in include_query_ids
            for evidence_rect in hits.get(query_id, ())
        ]
        candidates.append({
            "instance_id": instance.instance_id,
            "selection_basis": "keyword",
            "evidence": evidence,
            "needs_review": instance.instance_id in needs_review,
        })

    return ReceiptSelectionResult(tuple(candidates), matches, tuple(diagnostics))


__all__ = [
    "ReceiptSelectionResult",
    "SelectionDiagnostic",
    "select_receipt_instances",
]
