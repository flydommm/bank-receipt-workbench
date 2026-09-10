"""Models and strict wire validation for persistent batch analysis.

The batch worker stores only bounded, JSON serialisable metadata.  This module
keeps the validation independent from the SQLite implementation so that the
same rules can be used by the result assembler and by storage writes.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import json
import math
from collections.abc import Mapping
import re
import unicodedata
from typing import Any


class BatchModelError(ValueError):
    """Raised when a batch model or JSON payload is not safe to use."""


SCHEMA_VERSION = 1
MAX_SOURCES = 10_000
MAX_CRITERIA_CLAUSES = 32
MAX_KEYWORD_CODEPOINTS = 512
MAX_NAME_BYTES = 1_024
MAX_PATH_BYTES = 32_768
MAX_IDENTIFIER_BYTES = 1_024
MAX_VERSION_BYTES = 256
MAX_MATCH_TEXT_BYTES = 65_536
MAX_LAYOUT_TEXT_BYTES = 1_024
MAX_PAGE_RESULT_BYTES = 64 * 1024 * 1024
MAX_RESULTS_PAGE_ITEMS = 200
MAX_RESULTS_PAGE_BYTES = 4 * 1024 * 1024
MAX_JSON_DEPTH = 32
MAX_JSON_ITEMS = 250_000
MAX_JSON_BYTES = MAX_PAGE_RESULT_BYTES

BUDGET_FIELDS = (
    "processed_pages",
    "text_characters",
    "fuzzy_work",
    "matches",
    "matched_text_characters",
)
BUDGET_LIMITS = {
    "processed_pages": 5_000,
    "text_characters": 64_000_000,
    "fuzzy_work": 64_000_000,
    "matches": 10_000,
    "matched_text_characters": 8_000_000,
}

_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_MATCH_FIELDS = {
    "page",
    "matched_text",
    "matched_field",
    "confidence",
    "needs_review",
    "x0",
    "y0",
    "x1",
    "y1",
    "query_id",
    "role",
}
_ANALYSIS_FIELDS = {
    "status",
    "page",
    "page_width",
    "page_height",
    "source_sha256",
    "page_fully_matched",
    "selections",
}
_SELECTION_FIELDS = {
    "match_rect",
    "rect",
    "candidate_index",
    "candidate_rect",
    "confidence",
    "slot",
    "evidence",
    "needs_review",
    "snap_points",
}
_RECT_FIELDS = {"x0", "y0", "x1", "y1"}


class BatchJobState(str, Enum):
    QUEUED = "queued"
    VALIDATING = "validating"
    RUNNING = "running"
    PAUSE_REQUESTED = "pause_requested"
    PAUSED = "paused"
    PARTIAL_FAILED = "partial_failed"
    FINALIZING = "finalizing"
    READY_FOR_REVIEW = "ready_for_review"
    BLOCKED = "blocked"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"
    ARCHIVED = "archived"


class BatchPageState(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class BatchSourceState(str, Enum):
    PENDING = "pending"
    REGISTERED = "registered"
    VERIFIED = "verified"
    FAILED = "failed"
    BLOCKED = "blocked"


@dataclass(frozen=True, slots=True)
class BatchBudget:
    """The five persisted search-work counters."""

    processed_pages: int = 0
    text_characters: int = 0
    fuzzy_work: int = 0
    matches: int = 0
    matched_text_characters: int = 0

    def __post_init__(self) -> None:
        for field in BUDGET_FIELDS:
            value = getattr(self, field)
            if type(value) is not int or not 0 <= value <= BUDGET_LIMITS[field]:
                raise BatchModelError(f"budget.{field} is invalid")

    def to_dict(self) -> dict[str, int]:
        return {field: getattr(self, field) for field in BUDGET_FIELDS}

    @classmethod
    def from_dict(cls, value: object) -> "BatchBudget":
        decoded = validate_budget(value)
        return cls(**decoded)


@dataclass(frozen=True, slots=True)
class BatchSource:
    job_id: str
    source_id: str
    position: int
    source_key: str
    initial_path: str
    access_path: str
    name: str
    sha256: str | None = None
    size_bytes: int | None = None
    page_count: int | None = None
    state: str = BatchSourceState.PENDING.value
    error: object | None = None
    budget: BatchBudget = BatchBudget()
    verified_generation: int | None = None


@dataclass(frozen=True, slots=True)
class BatchPage:
    job_id: str
    source_id: str
    page: int
    stage: str = "page"
    state: str = BatchPageState.PENDING.value
    owner: str | None = None
    generation: int = 0
    attempt: int = 0
    error: object | None = None
    budget: BatchBudget = BatchBudget()


def _bad(field: str, detail: str = "invalid") -> BatchModelError:
    return BatchModelError(f"{field} {detail}")


def _utf8_text(value: object, field: str, *, max_bytes: int, strip: bool = False) -> str:
    if not isinstance(value, str):
        raise _bad(field, "must be a string")
    result = value.strip() if strip else value
    if not result or "\x00" in result:
        raise _bad(field, "must be non-empty and contain no NUL")
    try:
        size = len(result.encode("utf-8", "strict"))
    except UnicodeError:
        raise _bad(field, "must be valid UTF-8") from None
    if size > max_bytes:
        raise _bad(field, "is too long")
    return result


def _finite_number(value: object, field: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _bad(field, "must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        raise _bad(field, "must be a finite number") from None
    if not math.isfinite(number) or (positive and number <= 0):
        raise _bad(field, "must be a finite number")
    return number


def _positive_int(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise _bad(field, "must be a positive integer")
    return value


def _nonnegative_int(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise _bad(field, "must be a non-negative integer")
    return value


def _walk_json(value: object, *, max_bytes: int) -> None:
    if type(max_bytes) is not int or not 0 <= max_bytes <= MAX_JSON_BYTES:
        raise _bad("JSON", "has an invalid byte budget")
    remaining = max_bytes
    nodes = 0

    def charge(size: int) -> None:
        nonlocal remaining
        remaining -= size
        if remaining < 0:
            raise _bad("JSON", "is too large")

    def visit(item: object, depth: int) -> None:
        nonlocal nodes
        if depth > MAX_JSON_DEPTH:
            raise _bad("JSON", "is too deeply nested")
        nodes += 1
        if nodes > MAX_JSON_ITEMS:
            raise _bad("JSON", "has too many values")
        if item is None:
            charge(4)
        elif type(item) is bool:
            charge(4 if item else 5)
        elif isinstance(item, str):
            # Check length before encoding, and charge every alias occurrence
            # including dictionary keys.  Serialization cannot first expand
            # a small Python graph into unbounded repeated string content.
            if len(item) + 2 > remaining:
                raise _bad("JSON", "is too large")
            try:
                size = len(item.encode("utf-8", "strict")) + 2
            except UnicodeError:
                raise _bad("JSON", "contains invalid UTF-8") from None
            size += sum(1 if char in '\\"\b\f\n\r\t' else 5 if ord(char) < 32 else 0 for char in item)
            charge(size)
        elif type(item) is int:
            if item.bit_length() > remaining * 4:
                raise _bad("JSON", "is too large")
            try:
                charge(len(str(item)))
            except ValueError:
                raise _bad("JSON", "integer cannot be encoded") from None
        elif type(item) is float:
            if not math.isfinite(item):
                raise _bad("JSON", "contains a non-finite number")
            charge(len(repr(item)))
        elif type(item) is list:
            charge(2 + max(0, len(item) - 1))
            for child in item:
                visit(child, depth + 1)
        elif type(item) is dict:
            charge(2 + max(0, len(item) - 1) + len(item))
            for key, child in item.items():
                if not isinstance(key, str) or "\x00" in key:
                    raise _bad("JSON", "object keys must be strings without NUL")
                visit(key, depth + 1)
                visit(child, depth + 1)
        else:
            raise _bad("JSON", "must contain only plain JSON values")

    visit(value, 0)


def clone_json(value: object, *, max_bytes: int = MAX_JSON_BYTES) -> Any:
    """Validate and return an independent JSON-only copy of ``value``."""

    if not isinstance(value, (dict, list, str, int, float, bool)) and value is not None:
        raise _bad("JSON", "must contain only plain JSON values")
    _walk_json(value, max_bytes=max_bytes)
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8", "strict")
    except (TypeError, ValueError, UnicodeError, OverflowError):
        raise _bad("JSON", "cannot be encoded") from None
    if len(encoded) > max_bytes:
        raise _bad("JSON", "is too large")
    try:
        return json.loads(encoded.decode("utf-8"))
    except (TypeError, ValueError, UnicodeError):
        raise _bad("JSON", "cannot be decoded") from None


def canonical_json(value: object, *, max_bytes: int = MAX_JSON_BYTES) -> bytes:
    """Return the deterministic UTF-8 JSON representation used for hashes."""

    cloned = clone_json(value, max_bytes=max_bytes)
    try:
        return json.dumps(
            cloned,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8", "strict")
    except (TypeError, ValueError, UnicodeError, OverflowError):
        raise _bad("JSON", "cannot be encoded") from None


def _normalize_keywords(value: object, field: str) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            continue
        keyword = unicodedata.normalize("NFC", item.strip())
        if not keyword or keyword in seen:
            continue
        if len(keyword) > MAX_KEYWORD_CODEPOINTS:
            raise _bad(field, f"keyword exceeds {MAX_KEYWORD_CODEPOINTS} code points")
        seen.add(keyword)
        result.append(keyword)
    return result


def normalize_criteria(value: object) -> dict[str, object]:
    """Normalize the stable TS ``include/includeMode/exclude`` shape.

    The TypeScript editor ignores malformed individual entries and treats an
    omitted/unknown include mode as ``all``.  An empty include set is not a
    runnable batch and is rejected here so that storage never receives an
    unusable job.
    """

    if not isinstance(value, Mapping):
        raise _bad("criteria", "must be an object")
    include = _normalize_keywords(value.get("include"), "include")
    exclude = _normalize_keywords(value.get("exclude"), "exclude")
    if not include:
        raise _bad("criteria", "must contain an include keyword")
    if len(include) + len(exclude) > MAX_CRITERIA_CLAUSES:
        raise _bad("criteria", f"cannot contain more than {MAX_CRITERIA_CLAUSES} clauses")
    include_mode = "any" if value.get("includeMode") == "any" else "all"
    return {"include": include, "includeMode": include_mode, "exclude": exclude}


def criteria_clauses(criteria: Mapping[str, object]) -> list[dict[str, str]]:
    normalized = normalize_criteria(criteria)
    return [
        *[
            {"id": f"include-{index}", "keyword": keyword, "role": "include"}
            for index, keyword in enumerate(normalized["include"])
        ],
        *[
            {"id": f"exclude-{index}", "keyword": keyword, "role": "exclude"}
            for index, keyword in enumerate(normalized["exclude"])
        ],
    ]


def normalize_match_mode(value: object) -> str:
    if not isinstance(value, str) or value not in {"exact", "fuzzy"}:
        raise _bad("match_mode", "must be exact or fuzzy")
    return value


def validate_budget(value: object) -> dict[str, int]:
    """Validate a complete persisted five-dimensional budget."""

    if isinstance(value, BatchBudget):
        value = value.to_dict()
    elif hasattr(value, "to_dict") and callable(value.to_dict):
        value = value.to_dict()
    if not isinstance(value, Mapping):
        raise _bad("budget", "must be an object")
    if set(value) != set(BUDGET_FIELDS):
        raise _bad("budget", "has unknown or missing fields")
    result: dict[str, int] = {}
    for field in BUDGET_FIELDS:
        counter = _nonnegative_int(value[field], f"budget.{field}")
        if counter > BUDGET_LIMITS[field]:
            raise _bad(f"budget.{field}", "exceeds the search limit")
        result[field] = counter
    return result


def _rect(value: object, field: str, *, width: float, height: float, required: bool = True) -> dict[str, float] | None:
    if value is None and not required:
        return None
    if not isinstance(value, dict) or set(value) != _RECT_FIELDS:
        raise _bad(field, "must be a rectangle")
    values = {
        edge: _finite_number(value[edge], f"{field}.{edge}")
        for edge in ("x0", "y0", "x1", "y1")
    }
    if not (0 <= values["x0"] < values["x1"] <= width and 0 <= values["y0"] < values["y1"] <= height):
        raise _bad(field, "must be ordered and inside the page")
    return values


def _contains(container: Mapping[str, float], contained: Mapping[str, float]) -> bool:
    return (
        container["x0"] <= contained["x0"]
        and container["y0"] <= contained["y0"]
        and container["x1"] >= contained["x1"]
        and container["y1"] >= contained["y1"]
    )


def _same_rect(left: Mapping[str, float], right: Mapping[str, object]) -> bool:
    return all(left[edge] == right.get(edge) for edge in ("x0", "y0", "x1", "y1"))


def _validate_match(value: object, page: int) -> dict[str, object]:
    if not isinstance(value, dict) or not set(value).issubset(_MATCH_FIELDS):
        raise _bad("matches", "contains an unknown field")
    required = {"page", "matched_text", "matched_field", "confidence", "x0", "y0", "x1", "y1"}
    if not required.issubset(value):
        raise _bad("match", "has missing fields")
    if _positive_int(value["page"], "match.page") != page:
        raise _bad("match.page", "must equal the page result page")
    matched_text = _utf8_text(value["matched_text"], "match.matched_text", max_bytes=MAX_MATCH_TEXT_BYTES)
    matched_field = value["matched_field"]
    if matched_field is not None:
        matched_field = _utf8_text(matched_field, "match.matched_field", max_bytes=MAX_LAYOUT_TEXT_BYTES)
    confidence = _finite_number(value["confidence"], "match.confidence")
    if not 0 <= confidence <= 1:
        raise _bad("match.confidence", "must be between 0 and 1")
    coordinates = {
        edge: _finite_number(value[edge], f"match.{edge}")
        for edge in ("x0", "y0", "x1", "y1")
    }
    if not (0 <= coordinates["x0"] < coordinates["x1"] and 0 <= coordinates["y0"] < coordinates["y1"]):
        raise _bad("match", "rectangle must be ordered and non-negative")
    needs_review = value.get("needs_review")
    if needs_review is not None and not isinstance(needs_review, bool):
        raise _bad("match.needs_review", "must be a boolean")
    has_query = "query_id" in value
    has_role = "role" in value
    if has_query != has_role:
        raise _bad("match", "query_id and role must be provided together")
    result: dict[str, object] = {
        "page": page,
        "matched_text": matched_text,
        "matched_field": matched_field,
        "confidence": confidence,
        "x0": coordinates["x0"],
        "y0": coordinates["y0"],
        "x1": coordinates["x1"],
        "y1": coordinates["y1"],
    }
    if needs_review is not None:
        result["needs_review"] = needs_review
    if has_query:
        result["query_id"] = _utf8_text(value["query_id"], "match.query_id", max_bytes=MAX_IDENTIFIER_BYTES, strip=True)
        if value["role"] not in {"include", "exclude"}:
            raise _bad("match.role", "must be include or exclude")
        if (
            (result["query_id"].startswith("include-") and value["role"] != "include")
            or (result["query_id"].startswith("exclude-") and value["role"] != "exclude")
        ):
            raise _bad("match", "query_id and role do not agree")
        result["role"] = value["role"]
    return result


def _validate_selection(value: object, match: Mapping[str, object], width: float, height: float) -> dict[str, object]:
    if not isinstance(value, dict) or not set(value).issubset(_SELECTION_FIELDS):
        raise _bad("analysis.selection", "contains an unknown field")
    required = {"match_rect", "rect", "confidence", "slot", "evidence", "needs_review"}
    if not required.issubset(value):
        raise _bad("analysis.selection", "has missing fields")
    match_rect = _rect(value["match_rect"], "analysis.selection.match_rect", width=width, height=height)
    assert match_rect is not None
    if not _same_rect(match_rect, match):
        raise _bad("analysis.selection.match_rect", "must equal its match")
    rect = _rect(value["rect"], "analysis.selection.rect", width=width, height=height, required=False)
    candidate_rect = _rect(value.get("candidate_rect"), "analysis.selection.candidate_rect", width=width, height=height, required=False)
    if "candidate_index" in value:
        candidate_index = value["candidate_index"]
        if candidate_index is not None:
            candidate_index = _nonnegative_int(candidate_index, "analysis.selection.candidate_index")
    else:
        candidate_index = None
    if ("candidate_index" in value) != ("candidate_rect" in value) and ("candidate_index" in value or "candidate_rect" in value):
        raise _bad("analysis.selection", "candidate fields must be provided together")
    if candidate_rect is not None and not _contains(candidate_rect, match_rect):
        raise _bad("analysis.selection.candidate_rect", "must contain the match")
    confidence = _finite_number(value["confidence"], "analysis.selection.confidence")
    if not 0 <= confidence <= 1:
        raise _bad("analysis.selection.confidence", "must be between 0 and 1")
    slot = value["slot"]
    if slot is not None:
        slot = _utf8_text(slot, "analysis.selection.slot", max_bytes=MAX_LAYOUT_TEXT_BYTES, strip=True)
    evidence = value["evidence"]
    if not isinstance(evidence, list):
        raise _bad("analysis.selection.evidence", "must be an array")
    evidence_copy = [
        _utf8_text(item, "analysis.selection.evidence", max_bytes=MAX_LAYOUT_TEXT_BYTES)
        for item in evidence
    ]
    needs_review = value["needs_review"]
    if not isinstance(needs_review, bool):
        raise _bad("analysis.selection.needs_review", "must be a boolean")
    if rect is None:
        if confidence != 0 or slot is not None or not needs_review:
            raise _bad("analysis.selection", "an empty rectangle must be an unresolved selection")
    else:
        if not _contains(rect, match_rect) or slot is None:
            raise _bad("analysis.selection.rect", "must contain the match and have a slot")
        if needs_review != (confidence < 0.9):
            raise _bad("analysis.selection.needs_review", "does not match confidence")
    snap_points: list[float] | None = None
    if "snap_points" in value:
        raw_points = value["snap_points"]
        if not isinstance(raw_points, list):
            raise _bad("analysis.selection.snap_points", "must be an array")
        snap_points = []
        for point in raw_points:
            number = _finite_number(point, "analysis.selection.snap_points")
            if not 0 <= number <= height:
                raise _bad("analysis.selection.snap_points", "must be inside the page")
            snap_points.append(number)
    result: dict[str, object] = {
        "match_rect": match_rect,
        "rect": rect,
        "confidence": confidence,
        "slot": slot,
        "evidence": evidence_copy,
        "needs_review": needs_review,
    }
    if "candidate_index" in value:
        result["candidate_index"] = candidate_index
        result["candidate_rect"] = candidate_rect
    if snap_points is not None:
        result["snap_points"] = snap_points
    return result


def validate_page_result(value: object) -> dict[str, object]:
    """Validate and deeply copy one durable raw page result.

    Source identity is deliberately absent from matches; the parent source
    row binds every result to its logical key and verified SHA.  A page with
    no matches carries ``analysis: None`` so an incomplete geometry analysis
    can never be mistaken for an empty, successfully processed page.
    """

    if not isinstance(value, dict):
        raise _bad("page_result", "must be an object")
    expected_fields = {"schema", "page", "page_width", "page_height", "matches", "analysis"}
    if set(value) != expected_fields:
        raise _bad("page_result", "has unknown or missing fields")
    if type(value["schema"]) is not int or value["schema"] != 1:
        raise _bad("page_result.schema", "must be 1")
    page = _positive_int(value["page"], "page_result.page")
    width = _finite_number(value["page_width"], "page_result.page_width", positive=True)
    height = _finite_number(value["page_height"], "page_result.page_height", positive=True)
    raw_matches = value["matches"]
    if not isinstance(raw_matches, list):
        raise _bad("page_result.matches", "must be an array")
    if len(raw_matches) > BUDGET_LIMITS["matches"]:
        raise _bad("page_result.matches", "contains too many matches")
    matches = [_validate_match(item, page) for item in raw_matches]
    raw_analysis = value["analysis"]
    if not matches:
        if raw_analysis is not None:
            raise _bad("page_result.analysis", "must be null for a page with no matches")
        analysis = None
    else:
        if not isinstance(raw_analysis, dict) or not set(raw_analysis).issubset(_ANALYSIS_FIELDS):
            raise _bad("page_result.analysis", "is invalid")
        required = {"status", "page", "page_width", "page_height", "selections"}
        if not required.issubset(raw_analysis):
            raise _bad("page_result.analysis", "has missing fields")
        if raw_analysis["status"] != "ok":
            raise _bad("page_result.analysis.status", "must be ok")
        if _positive_int(raw_analysis["page"], "analysis.page") != page:
            raise _bad("analysis.page", "must equal page_result.page")
        if _finite_number(raw_analysis["page_width"], "analysis.page_width", positive=True) != width:
            raise _bad("analysis.page_width", "must equal page_result.page_width")
        if _finite_number(raw_analysis["page_height"], "analysis.page_height", positive=True) != height:
            raise _bad("analysis.page_height", "must equal page_result.page_height")
        if "source_sha256" in raw_analysis:
            source_sha = raw_analysis["source_sha256"]
            if not isinstance(source_sha, str) or not _SHA256_RE.fullmatch(source_sha):
                raise _bad("analysis.source_sha256", "must be a SHA-256 digest")
        if "page_fully_matched" in raw_analysis and not isinstance(raw_analysis["page_fully_matched"], bool):
            raise _bad("analysis.page_fully_matched", "must be a boolean")
        raw_selections = raw_analysis["selections"]
        if not isinstance(raw_selections, list) or len(raw_selections) != len(matches):
            raise _bad("analysis.selections", "must correspond one-to-one with matches")
        selections = [
            _validate_selection(item, match, width, height)
            for item, match in zip(raw_selections, matches, strict=True)
        ]
        analysis = {
            "status": "ok",
            "page": page,
            "page_width": width,
            "page_height": height,
            "selections": selections,
        }
        for field in ("source_sha256", "page_fully_matched"):
            if field in raw_analysis:
                analysis[field] = raw_analysis[field]
    result = {
        "schema": 1,
        "page": page,
        "page_width": width,
        "page_height": height,
        "matches": matches,
        "analysis": analysis,
    }
    try:
        clone = clone_json(result, max_bytes=MAX_PAGE_RESULT_BYTES)
    except BatchModelError:
        raise
    if not isinstance(clone, dict):  # pragma: no cover - clone_json preserves shape
        raise _bad("page_result", "must be an object")
    return clone


__all__ = [
    "BUDGET_FIELDS",
    "BUDGET_LIMITS",
    "BatchBudget",
    "BatchJobState",
    "BatchModelError",
    "BatchPage",
    "BatchPageState",
    "BatchSource",
    "BatchSourceState",
    "MAX_CRITERIA_CLAUSES",
    "MAX_KEYWORD_CODEPOINTS",
    "MAX_PAGE_RESULT_BYTES",
    "MAX_RESULTS_PAGE_BYTES",
    "MAX_RESULTS_PAGE_ITEMS",
    "SCHEMA_VERSION",
    "canonical_json",
    "clone_json",
    "criteria_clauses",
    "normalize_criteria",
    "normalize_match_mode",
    "validate_budget",
    "validate_page_result",
]
