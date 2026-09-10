"""Canonical immutable review results assembled from complete durable pages.

Only the internal worker calls this module. UI commands cannot register page
payloads or an arbitrary purportedly complete result array. Actual final file
verification and the publish CAS remain the processor/store's responsibilities.
"""

from __future__ import annotations

from collections import defaultdict
from copy import deepcopy
import hashlib
import json
import math
import re
from typing import Any, Iterable
import unicodedata

try:
    from .batch_models import normalize_criteria, validate_page_result
except ImportError:
    from batch_models import normalize_criteria, validate_page_result  # type: ignore[no-redef]


ASSEMBLY_VERSION = "batch-assembly-v1"
MAX_SOURCES = 10_000
MAX_SEGMENTS = 50_000
MIN_CROP_SIZE = 12
_SHA = re.compile(r"^[a-f0-9]{64}$")


class BatchAssemblyError(ValueError):
    """A complete, internally consistent review snapshot cannot be produced."""


def _require(condition: object, message: str) -> None:
    if not condition:
        raise BatchAssemblyError(message)


def _text(value: Any, limit: int) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= limit and "\0" not in value


def _positive_int(value: Any) -> bool:
    return type(value) is int and 0 < value <= 2**53 - 1


def _normalize_path(path: str) -> str:
    return unicodedata.normalize("NFC", path.strip()).replace("\\", "/").lower()


def _digest(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _rect(match: dict[str, Any]) -> dict[str, float]:
    return {key: match[key] for key in ("x0", "y0", "x1", "y1")}


def _inside(rect: Any, width: float, height: float, *, minimum: bool = False) -> bool:
    if not isinstance(rect, dict):
        return False
    coordinates = [rect.get(key) for key in ("x0", "y0", "x1", "y1")]
    if not all(type(value) in (int, float) and math.isfinite(value) for value in coordinates):
        return False
    x0, y0, x1, y1 = coordinates
    if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        return False
    if not minimum:
        return True
    return (x1 - x0 >= MIN_CROP_SIZE if width >= MIN_CROP_SIZE else x0 == 0 and x1 == width) and (
        y1 - y0 >= MIN_CROP_SIZE if height >= MIN_CROP_SIZE else y0 == 0 and y1 == height
    )


def _geometry_fingerprint(width: float, height: float, rect: dict[str, float] | None) -> str:
    # Preserve the existing frontend fingerprint (including its zero-as-unknown
    # convention), rather than silently regrouping already accepted layouts.
    def rounded(value: float) -> str:
        if not math.isfinite(value) or value <= 0:
            return "unknown"
        value = math.floor(value * 1000 + 0.5) / 1000
        return str(int(value)) if value.is_integer() else str(value)

    geometry = ",".join(rounded(rect[key]) for key in ("x0", "y0", "x1", "y1")) if rect else "none"
    return f"geometry:{rounded(width)}x{rounded(height)}:{geometry}"


def _status(confidence: float, rect: Any, width: float, height: float, match_rect: Any) -> str:
    if confidence < 0.7 or not _inside(rect, width, height, minimum=True) or not _inside(match_rect, width, height):
        return "blocked"
    return "needs_review" if confidence < 0.9 else "confirmed"


def _segment_id(job_id: str, source: dict[str, Any], page: int, number: int, used: set[str]) -> str:
    base = f"{job_id}:{source['sha256']}:{page}:{number}"
    identity = base
    if identity in used:
        collision = f"{base}:source-{source['position'] + 1}"
        identity = collision
        suffix = 2
        while identity in used:
            identity = f"{collision}:{suffix}"
            suffix += 1
    used.add(identity)
    return identity


def _item(
    segment: dict[str, Any], evidence: list[dict[str, Any]], raw_selections: list[dict[str, Any]],
) -> dict[str, Any]:
    signature = _digest({
        "version": ASSEMBLY_VERSION,
        "page": segment["source_page"],
        "page_width": segment["page_width"], "page_height": segment["page_height"],
        "match_rect": segment["match_rect"], "candidate_rect": segment["candidate_rect"],
        "auto_full_page": segment["crop_mode"] == "full_page",
        "confidence": segment["confidence"], "layout_fingerprint": segment["layout_fingerprint"],
        "slot": segment["slot"], "snap_points": segment["snap_points"],
        # M3 also binds raw layout evidence and the pre-full-page candidate.
        # These remain immutable even when editable review geometry is restored.
        "raw_selections": raw_selections,
        "evidence": [{
            **{key: hit[key] for key in ("page", "matched_text", "matched_field", "confidence", "x0", "y0", "x1", "y1")},
            "needs_review": hit.get("needs_review", False),
            "query_id": hit.get("query_id"), "role": hit.get("role"),
        } for hit in evidence],
    })
    width, height = segment["page_width"], segment["page_height"]
    candidate = segment["candidate_rect"]
    original = {
        "id": segment["id"], "source_key": segment["source_key"],
        "source_page": segment["source_page"], "segment_no": segment["segment_no"],
        "analysis_signature": signature,
        "persistable": _inside(segment["match_rect"], width, height) and (
            candidate is None or _inside(candidate, width, height)
        ),
        "page_width": width, "page_height": height, "match_rect": deepcopy(segment["match_rect"]),
        "candidate_rect": deepcopy(candidate), "layout_fingerprint": segment["layout_fingerprint"],
        "confidence": segment["confidence"], "auto_full_page": segment["crop_mode"] == "full_page",
    }
    return {"segment": deepcopy(segment), "evidence": deepcopy(evidence), "original": original}


def _assemble_page(
    job_id: str, source: dict[str, Any], payload: dict[str, Any], criteria: dict[str, Any],
    clauses: dict[str, str], used_ids: set[str],
) -> list[dict[str, Any]]:
    hits = payload["matches"]
    if not hits:
        return []
    width, height, page = payload["page_width"], payload["page_height"], payload["page"]
    analysis = payload["analysis"]
    selections = analysis["selections"]
    legacy = len(criteria["include"]) == 1 and criteria["includeMode"] == "all" and not criteria["exclude"]
    candidates: list[tuple[list[int], dict[str, Any], dict[str, Any] | None, float, bool]] = []
    if legacy:
        for index, selection in enumerate(selections):
            candidates.append(([index], selection, selection["rect"], selection["confidence"],
                               analysis.get("page_fully_matched", False)))
    else:
        entries: dict[int, list[int]] = defaultdict(list)
        candidate_selections: dict[int, dict[str, Any]] = {}
        for index, (hit, selection) in enumerate(zip(hits, selections)):
            _require(hit.get("query_id") in clauses and clauses[hit["query_id"]] == hit.get("role"),
                     "page match references an unknown search clause")
            candidate_index = selection.get("candidate_index")
            _require(type(candidate_index) is int and candidate_index >= 0 and selection.get("candidate_rect") is not None,
                     "multi-condition page lacks candidate metadata")
            entries[candidate_index].append(index)
            candidate_selections[candidate_index] = selection
        include_ids = {key for key, role in clauses.items() if role == "include"}
        exclude_ids = {key for key, role in clauses.items() if role == "exclude"}
        for candidate_index in sorted(entries):
            indices = entries[candidate_index]
            query_ids = {hits[index]["query_id"] for index in indices}
            included = bool(include_ids & query_ids) if criteria["includeMode"] == "any" else include_ids <= query_ids
            if not included or query_ids & exclude_ids:
                continue
            selection = candidate_selections[candidate_index]
            candidate_rect = selection["candidate_rect"]
            _require(all(selections[index].get("candidate_rect") == candidate_rect for index in indices),
                     "multi-condition candidate geometry disagrees")
            confidence = min(value for index in indices if hits[index]["role"] == "include"
                             for value in (hits[index]["confidence"], selections[index]["confidence"]))
            candidates.append((indices, selection, candidate_rect, confidence, False))

    items = []
    for number, (indices, selection, candidate_rect, confidence, full_page) in enumerate(candidates, 1):
        evidence = [hits[index] for index in indices]
        representative = evidence[0] if legacy else next(hit for hit in evidence if hit["role"] == "include")
        match_rect = _rect(representative)
        segment = {
            "id": _segment_id(job_id, source, page, number, used_ids),
            "source_key": source["source_key"], "source_path": source["access_path"], "source_sha256": source["sha256"],
            "source_page": page, "segment_no": number, "match_rect": match_rect,
            "candidate_rect": deepcopy(candidate_rect), "final_rect": None if full_page else deepcopy(candidate_rect),
            "page_width": width, "page_height": height, "confidence": confidence,
            "slot": selection.get("slot"), "snap_points": deepcopy(selection.get("snap_points", [])),
            "layout_fingerprint": _geometry_fingerprint(width, height, candidate_rect or match_rect),
            "crop_mode": "full_page" if full_page else "candidate",
            "review_status": _status(confidence, candidate_rect, width, height, match_rect), "manual_adjusted": False,
        }
        items.append(_item(segment, evidence, [selections[index] for index in indices]))
    return items


def assemble_batch_results(
    job_id: str, sources: list[dict[str, Any]], criteria: dict[str, Any], match_mode: str,
    computation_version: str, pages: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    """Require one complete raw result per registered page, then assemble.

    This pure function neither verifies files nor writes a database. The store
    additionally requires all final SHA attestations and the active owner CAS.
    Only its worker-facing publish method accepts this result.
    """
    _require(_text(job_id, 128) and _text(computation_version, 256), "invalid batch identity or computation version")
    _require(match_mode in {"exact", "fuzzy"}, "invalid match mode")
    try:
        normalized = normalize_criteria(criteria)
    except (ValueError, TypeError) as error:
        raise BatchAssemblyError("invalid batch search criteria") from error
    _require(isinstance(sources, list) and 0 < len(sources) <= MAX_SOURCES, "invalid batch source count")
    source_by_id: dict[str, dict[str, Any]] = {}
    keys: set[str] = set()
    for position, incoming in enumerate(sources):
        source = deepcopy(incoming)
        _require(isinstance(source, dict) and source.get("position") == position and type(source.get("position")) is int,
                 "batch sources are not in import order")
        _require(_text(source.get("source_id"), 128) and source["source_id"] not in source_by_id, "duplicate or invalid source id")
        _require(all(_text(source.get(key), 32768) for key in ("source_key", "initial_path", "access_path")), "invalid source path")
        _require(source["source_key"] == _normalize_path(source["initial_path"]) and source["source_key"] not in keys,
                 "duplicate or invalid logical source key")
        _require(isinstance(source.get("sha256"), str) and _SHA.fullmatch(source["sha256"]), "source is not SHA-bound")
        _require(_positive_int(source.get("page_count")), "source has no valid page count")
        keys.add(source["source_key"])
        source_by_id[source["source_id"]] = source
    by_source: dict[str, dict[int, dict[str, Any]]] = {key: {} for key in source_by_id}
    for result in pages:
        _require(isinstance(result, dict) and result.get("source_id") in source_by_id, "page has unknown source")
        source_id = result["source_id"]
        try:
            payload = validate_page_result(result.get("payload"))
        except (ValueError, TypeError) as error:
            raise BatchAssemblyError("invalid durable page result") from error
        page = payload["page"]
        _require(page <= source_by_id[source_id]["page_count"] and page not in by_source[source_id], "duplicate or out-of-range page")
        analysis_sha = (payload["analysis"] or {}).get("source_sha256")
        _require(analysis_sha is None or analysis_sha.lower() == source_by_id[source_id]["sha256"].lower(),
                 "page analysis SHA does not match its registered source")
        by_source[source_id][page] = payload
    _require(all(len(by_source[key]) == source["page_count"] for key, source in source_by_id.items()),
             "batch has incomplete page results")
    clauses = [{"id": f"{role}-{index}", "keyword": keyword, "role": role}
               for role in ("include", "exclude") for index, keyword in enumerate(normalized[role])]
    roles = {clause["id"]: clause["role"] for clause in clauses}
    items: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for source_id, source in source_by_id.items():
        for page in sorted(by_source[source_id]):
            items.extend(_assemble_page(job_id, source, by_source[source_id][page], normalized, roles, used_ids))
            _require(len(items) <= MAX_SEGMENTS, "complete result exceeds the segment limit")
    context = {
        "version": 2,
        "sources": [{"source_key": source["source_key"], "source_path": source["access_path"], "source_sha256": source["sha256"]}
                    for source in source_by_id.values()],
        "criteria_fingerprint": _digest({"criteria": normalized, "match_mode": match_mode, "clauses": clauses}),
        "computation_version": computation_version,
    }
    return {"context": context, "originals": [deepcopy(item["original"]) for item in items], "items": items}
