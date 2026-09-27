"""Private, workspace-scoped historical layout references.

References contain only geometry and stable layout identity. They are never
used across workspaces or physical page sizes, and a failed reference lookup
must not prevent the current analysis from being reviewed.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
import sqlite3
from typing import Any

from .batch_models import MAX_PAGE_RESULT_BYTES, canonical_json
from .layout_template_store import LayoutTemplateStore, LayoutTemplateError, _save_selection, _update_target
from .receipt_layout_calibration import validate_complete_layout
from .receipt_layout_models import near
from .receipt_layout_review import CalibrationPreparation, CalibrationPreview, _incompatibility


def reference_scope(layout: dict[str, Any]) -> str:
    return ":".join(str(layout.get(key) or "unknown") for key in ("workspace_id", "issuer_id", "family_id", "evidence_version"))


def require_reference_identity(layout: dict[str, Any]) -> None:
    """Reject a cross-file reference when its stable form identity is unknown.

    A layout with an unknown issuer or family can still be reviewed and saved
    for the current round, but it cannot authorize geometry reuse in another
    PDF.  Persisting it would create an active row that the reusable-template
    reader must hide, which makes a successful save look as if it disappeared.
    """
    if not layout.get("issuer_id") or not layout.get("family_id"):
        raise LayoutTemplateError("reference layout identity is unavailable", code="identity_unavailable")


def reference_fingerprint(layout: dict[str, Any]) -> str:
    identity = {key: layout[key] for key in ("workspace_id", "issuer_id", "family_id", "evidence_version", "page_geometry")}
    identity["slots"] = [{"slot_id": slot["slot_id"], "position_index": slot["position_index"]} for slot in layout["slots"]]
    return sha256(canonical_json(identity, max_bytes=MAX_PAGE_RESULT_BYTES)).hexdigest()


def reference_slots(layout: dict[str, Any], *, use_rects: bool = False) -> list[dict[str, Any]]:
    left, right = float(layout["left_pt"]), float(layout["right_pt"])
    result = []
    for slot in layout["slots"]:
        rect = {"x0": left, "y0": float(slot["top_pt"]), "x1": float(layout["page_geometry"]["width_pt"] - right), "y1": float(slot["top_pt"] + slot["height_pt"])}
        result.append({"slot_id": slot["slot_id"], "position_index": slot["position_index"], "rect": rect})
    return result


def historical_reference(template: dict[str, Any], *, workspace_id: str = "default") -> dict[str, Any] | None:
    """Accept only a complete, internally consistent, non-private reference.

    Legacy rows lack positive layout identity and cannot authorize cross-file
    automatic application. Corrupt auxiliary records are ignored individually.
    """
    try:
        summary = template["evidence_summary"]
        if (not template["active"] or not isinstance(summary, dict)
                or type(summary.get("reference_schema")) is not int or summary["reference_schema"] != 2):
            return None
        layout = validate_complete_layout(summary["layout_definition"])
        confirmed = summary["confirmed_slot_ids"]
        if (layout["workspace_id"] != workspace_id or not layout["issuer_id"] or not layout["family_id"]
                or template["source_scope"] != reference_scope(layout)
                or template["layout_fingerprint"] != reference_fingerprint(layout)
                or template["page_geometry"] != layout["page_geometry"]
                or template["slots"] != reference_slots(layout)
                or not isinstance(confirmed, list) or not confirmed
                or any(not isinstance(value, str) for value in confirmed)
                or len(set(confirmed)) != len(confirmed)
                or not set(confirmed) <= {slot["slot_id"] for slot in layout["slots"]}
                or summary["shared_parameters"] != _shared_parameters(layout)):
            return None
        for key in ("id", "source_operation_id"):
            if (not isinstance(template[key], str) or not template[key]
                    or len(template[key]) > 256 or "\0" in template[key]):
                return None
        sources = summary.get("confirmed_slot_sources")
        if sources is not None and (not isinstance(sources, dict) or set(sources) != set(confirmed)
                or any(not isinstance(value, str) or not value or len(value) > 256 or "\0" in value for value in sources.values())):
            return None
        reference = {"template_id": template["id"], "source_operation_id": template["source_operation_id"],
                     "layout_definition": layout, "confirmed_slot_ids": sorted(confirmed)}
        if "series_id" in template:
            series = template["series_id"]
            if not isinstance(series, str) or not series or len(series) > 256 or "\0" in series:
                return None
            reference["template_series_id"] = series
        return reference
    except (ValueError, TypeError, KeyError, OverflowError):
        return None


def _shared_parameters(layout: dict[str, Any]) -> dict[str, Any]:
    return {"left_pt": round(float(layout["left_pt"]), 6), "right_pt": round(float(layout["right_pt"]), 6),
            "uniform_height": bool(layout["uniform_height"])}


def _same_margins(left: dict[str, Any], right: dict[str, Any]) -> bool:
    try:
        return all(type(left[key]) in (int, float) and type(right[key]) in (int, float)
                   and round(float(left[key]), 6) == round(float(right[key]), 6)
                   for key in ("left_pt", "right_pt"))
    except (KeyError, TypeError, ValueError, OverflowError):
        return False


def _normalize_uniform_height(layout: dict[str, Any]) -> dict[str, Any]:
    # Uniform height is an editing constraint, not shared crop geometry.
    # A partial replay must never resize the other, unconfirmed positions.
    if layout["uniform_height"] and any(not near(slot["height_pt"], layout["slots"][0]["height_pt"])
                                         for slot in layout["slots"]):
        layout["uniform_height"] = False
    return layout


def _apply_reference_series(layout: dict[str, Any], references: tuple[dict[str, Any], ...]) -> dict[str, Any] | None:
    """Compose the latest confirmed positions onto the current proven slots.

    Never create missing tail slots or reuse hits/decisions. Shared margins
    belong to a complete confirmed layout; a partial round can only change its
    confirmed positions when those margins already agree.
    """
    result = deepcopy(layout)
    applied = False
    for reference in reversed(references):
        saved = reference["layout_definition"]
        if _incompatibility(layout, saved, False) is not None:
            continue
        # Preserve the exact target PDF origin, scale and rotation. Geometric
        # tolerances used for review grouping cannot authorize historical replay.
        if layout["page_geometry"] != saved["page_geometry"]:
            continue
        saved_slots = {slot["slot_id"]: slot for slot in saved["slots"]}
        if not {slot["slot_id"] for slot in layout["slots"]} <= saved_slots.keys():
            continue
        confirmed = set(reference["confirmed_slot_ids"])
        complete = confirmed == saved_slots.keys()
        if not complete and not _same_margins(result, saved):
            continue
        applicable = confirmed & {slot["slot_id"] for slot in layout["slots"]}
        if not applicable:
            continue
        candidate = {**deepcopy(result), "slots": [
            {**deepcopy(slot), **({key: saved_slots[slot["slot_id"]][key] for key in ("top_pt", "height_pt")}
                                    if slot["slot_id"] in applicable else {})}
            for slot in result["slots"]]}
        if complete:
            candidate.update({key: saved[key] for key in ("left_pt", "right_pt", "uniform_height")})
        _normalize_uniform_height(candidate)
        try:
            result = validate_complete_layout(candidate)
            applied = True
        except (ValueError, TypeError, KeyError):
            continue
    return result if applied else None


def _reference_series(reference: dict[str, Any]) -> tuple[str, str]:
    # Old pins had no series identity and intentionally replayed their compatible
    # version history together. Keep that frozen behavior without rewriting pins.
    series = reference.get("template_series_id")
    return ("series", series) if series is not None else ("legacy_pin", "")


def _reference_groups(references: tuple[dict[str, Any], ...]) -> dict[tuple[str, str], list[dict[str, Any]]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for reference in references:
        groups.setdefault(_reference_series(reference), []).append(reference)
    return groups


def compatible_historical_references(layout: dict[str, Any], references: tuple[dict[str, Any], ...]
                                     ) -> tuple[dict[str, Any], ...]:
    """Return one representative per applicable independent template series.

    Callers may report ambiguity using len(result) > 1. A manual selection pins
    only its selected version; it still goes through every compatibility check.
    """
    return tuple(rows[0] for rows in _reference_groups(references).values()
                 if _apply_reference_series(layout, tuple(rows)) is not None)


def apply_historical_reference(layout: dict[str, Any], references: tuple[dict[str, Any], ...]) -> dict[str, Any] | None:
    groups = _reference_groups(references)
    candidates = [_apply_reference_series(layout, tuple(rows)) for rows in groups.values()]
    applicable = [candidate for candidate in candidates if candidate is not None]
    return applicable[0] if len(applicable) == 1 else None


def apply_reference(prepared: CalibrationPreparation, database: Path) -> CalibrationPreparation:
    if prepared.editable_slot_ids is not None:
        return prepared
    layout = prepared.layout
    try:
        template = LayoutTemplateStore(database).match_reference(reference_scope(layout), layout["page_geometry"], reference_fingerprint(layout), reference_slots(layout))
    except (LayoutTemplateError, OSError):
        return prepared
    if template is None:
        return prepared
    slots = []
    confirmed = template.get("evidence_summary", {}).get("confirmed_slot_ids")
    shared = template.get("evidence_summary", {}).get("shared_parameters")
    if isinstance(shared, dict) and not _same_margins(shared, layout):
        return prepared
    confirmed_ids = set(confirmed) if isinstance(confirmed, list) and confirmed else {slot["slot_id"] for slot in layout["slots"]}
    for saved, current in zip(template["slots"], layout["slots"], strict=True):
        rect = saved["rect"]
        slots.append({**deepcopy(current), **({"top_pt": rect["y0"], "height_pt": rect["y1"] - rect["y0"]}
                                              if saved["slot_id"] in confirmed_ids else {})})
    candidate = {**deepcopy(layout), "left_pt": template["slots"][0]["rect"]["x0"], "right_pt": layout["page_geometry"]["width_pt"] - template["slots"][0]["rect"]["x1"], "slots": slots}
    _normalize_uniform_height(candidate)
    try:
        return replace(prepared, layout=validate_complete_layout(candidate))
    except (TypeError, ValueError, KeyError):
        return prepared


def save_reference(preview: CalibrationPreview, database: Path, operation_id: str, *, name: str | None = None,
                   save_mode: str = "create", template_id: str | None = None,
                   bank_name: str | None = None) -> dict[str, Any]:
    if preview.preparation.editable_slot_ids is not None:
        raise LayoutTemplateError("manually classified receipts require an independent template identity")
    confirmed = sorted({item["slot_id"] for item in preview.affected
                        if item.get("status") in {"updated", "added"} and item.get("after_rect") is not None})
    return save_reference_layout(preview.draft, database, operation_id, confirmed_slot_ids=confirmed, name=name,
                                 save_mode=save_mode, template_id=template_id, bank_name=bank_name)


def validate_reference_target(layout: dict[str, Any], database: Path, save_mode: str = "create",
                              template_id: str | None = None) -> dict[str, Any] | None:
    """Validate a chosen update before committing review; never create/migrate a DB.

    Store.save repeats the check under its write lock to reject a concurrent
    update, deactivation, or withdrawal between validation and registration.
    """
    layout = validate_complete_layout(layout)
    require_reference_identity(layout)
    target_id = _save_selection(save_mode, template_id)
    if target_id is None:
        return None
    database = Path(database).resolve()
    if not database.is_file():
        raise LayoutTemplateError("update template is unavailable", code="template_unavailable")
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=5) as connection:
        connection.row_factory = sqlite3.Row
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='layout_templates'").fetchone():
            raise LayoutTemplateError("update template is unavailable", code="template_unavailable")
        return _update_target(connection, target_id, reference_scope(layout), reference_fingerprint(layout),
                              layout["page_geometry"], reference=True, workspace_id=layout["workspace_id"])


def merge_reference_evidence(evidence: dict[str, Any], operation_id: str,
                             previous: dict[str, Any] | None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Compose confirmed positions within the selected series under its write lock."""
    evidence = deepcopy(evidence)
    incoming = validate_complete_layout(evidence["layout_definition"])
    confirmed = set(evidence["confirmed_slot_ids"])
    sources = {slot: operation_id for slot in confirmed}
    prior = historical_reference(previous, workspace_id=incoming["workspace_id"]) if previous else None
    all_slots = {slot["slot_id"] for slot in incoming["slots"]}
    if prior is not None and confirmed != all_slots:
        saved = prior["layout_definition"]
        if not _same_margins(saved, incoming):
            raise LayoutTemplateError("partial reference shared parameters differ", code="shared_geometry_changed")
        # Unconfirmed draft positions cannot overwrite previously checked
        # geometry. The new version carries their original operation identity.
        replacement = {slot["slot_id"]: slot for slot in incoming["slots"]}
        merged = {**deepcopy(incoming), "slots": [
            deepcopy(replacement[slot["slot_id"]] if slot["slot_id"] in confirmed else slot)
            for slot in saved["slots"]]}
        try:
            incoming = validate_complete_layout(_normalize_uniform_height(merged))
        except ValueError as exc:
            raise LayoutTemplateError("merged reference geometry is invalid", code="template_geometry_conflict") from exc
        old_sources = previous["evidence_summary"].get("confirmed_slot_sources", {})
        sources = {slot: old_sources.get(slot, previous["source_operation_id"]) for slot in prior["confirmed_slot_ids"]} | sources
        confirmed.update(prior["confirmed_slot_ids"])
    evidence.update(layout_definition=incoming, confirmed_slot_ids=sorted(confirmed), confirmed_slot_sources=sources,
                    shared_parameters=_shared_parameters(incoming))
    return evidence, reference_slots(incoming)


def compose_legacy_reference(previous: dict[str, Any] | None, current: dict[str, Any]) -> dict[str, Any]:
    """Read-only compatibility for releases which retained active partial rows.

    The latest valid row retains its identity. Incompatible shared parameters
    or overlapping composed geometry leave only that row's confirmed slots.
    """
    if not current['active'] or previous is None or not previous['active']:
        return current
    try:
        evidence, slots = merge_reference_evidence(current['evidence_summary'], current['source_operation_id'], previous)
        # Existing composed rows already carry per-slot operation identities.
        evidence['confirmed_slot_sources'].update(current['evidence_summary'].get('confirmed_slot_sources', {}))
        return {**current, 'evidence_summary': evidence, 'slots': slots}
    except (ValueError, TypeError, KeyError):
        return current


def save_reference_layout(layout_definition: dict[str, Any], database: Path, operation_id: str,
                          *, confirmed_slot_ids: list[str] | None = None, name: str | None = None,
                          save_mode: str = "create", template_id: str | None = None,
                          bank_name: str | None = None) -> dict[str, Any]:
    """Persist one geometry reference idempotently for a calibration operation."""
    layout = validate_complete_layout(layout_definition)
    require_reference_identity(layout)
    confirmed = confirmed_slot_ids if confirmed_slot_ids is not None else [slot["slot_id"] for slot in layout["slots"]]
    if (not isinstance(confirmed, list) or not confirmed or any(not isinstance(item, str) for item in confirmed)
            or len(set(confirmed)) != len(confirmed) or not set(confirmed) <= {slot["slot_id"] for slot in layout["slots"]}):
        raise LayoutTemplateError("invalid confirmed_slot_ids")
    shared = {"left_pt": round(float(layout["left_pt"]), 6), "right_pt": round(float(layout["right_pt"]), 6),
              "uniform_height": bool(layout["uniform_height"])}
    template = {"name": name, "source_scope": reference_scope(layout), "layout_fingerprint": reference_fingerprint(layout),
                "page_geometry": layout["page_geometry"], "slots": reference_slots(layout),
                "evidence_summary": {"slot_count": len(layout["slots"]), "confirmed_slot_ids": confirmed,
                                      "reference_schema": 2, "layout_definition": deepcopy(layout),
                                      "shared_parameters": shared,
                                      "page_width_pt": layout["page_geometry"]["width_pt"], "page_height_pt": layout["page_geometry"]["height_pt"]},
                "source_operation_id": operation_id, "save_mode": save_mode,
                "update_template_id": template_id, "bank_name": bank_name}
    store = LayoutTemplateStore(database)
    return store.save(template)
