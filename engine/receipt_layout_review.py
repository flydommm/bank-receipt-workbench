"""Server-owned preparation and recomputation for complete layout calibration.

Ordinary receipt edits remain constrained by their original candidate. This
module deliberately starts from durable *whole-page* checkpoints instead. It
does not persist a review decision: callers must retain the returned plan in
private storage and publish it atomically after a separate save request.
"""

from __future__ import annotations

from collections import Counter
from copy import deepcopy
from dataclasses import dataclass, replace
from hashlib import sha256
from pathlib import Path
from typing import Any, Callable

from .batch_models import MAX_PAGE_RESULT_BYTES, BatchModelError, canonical_json
from .batch_pdf import BatchSourceError, open_batch_source
from .batch_review import _binding, _validated_review_binding
from .batch_store import BatchCapacityExceeded, BatchComputationChanged, BatchConflict, BatchStore, BatchStoreError
from .computation import current_computation_version
from .receipt_checkpoint import encode_receipt_checkpoint, validate_receipt_checkpoint
from .receipt_layout_calibration import affected_slot_ids, validate_complete_layout
from .receipt_layout_models import near, slot_rect
from .receipt_visual_identity import compatible_visual_positions, requires_verified_crop_envelopes, visual_positions
from .receipt_snapshot import assemble_receipt_results
from .search import SearchBudget


_DRAFT_FIELDS = frozenset(("revision", "uniform_height", "left_pt", "right_pt", "slots"))
_MEMBERSHIP_ERRORS = frozenset(("unassigned_block", "ambiguous_block", "cross_boundary_block", "low_confidence_exclude"))
_MAX_PREVIEW_BYTES = 64 * 1024 * 1024
_LOCAL_LAYOUT_EDGE_TOLERANCE_PT = 1.0


class TemplateNoTargetsError(BatchStoreError):
    """An active template has no eligible target; the template is not invalid."""

    def __init__(self, reasons: dict[str, int], *, legacy_identity: bool = False):
        self.reasons = reasons
        self.legacy_identity = legacy_identity
        super().__init__("no eligible ordinary receipt matches the selected layout template")

    def user_message(self) -> str:
        labels = {"prior_review_scope": "已人工确认或分类", "special_document_scope": "特殊凭证",
                  "template_incompatible": "版式不匹配", "no_confirmed_slot": "没有可应用栏位"}
        detail = "，".join(f"{labels[key]} {count} 页" for key, count in self.reasons.items() if count and key in labels)
        message = f"当前没有可应用的回单页面{f'（{detail}）' if detail else ''}。模板仍保留，已审核结果未改变。"
        if self.legacy_identity and self.reasons.get("template_incompatible"):
            message += "旧版模板缺少当前版式依据，请重新分析、微调并另存新模板；原模板仍保留。"
        return message


def _digest(value: object) -> str:
    return sha256(canonical_json(value, max_bytes=MAX_PAGE_RESULT_BYTES)).hexdigest()


def _collection_digest(values: list[dict[str, Any]]) -> str:
    digest = sha256()
    for value in values:
        digest.update(bytes.fromhex(_digest(value)))
    return digest.hexdigest()


def _rect_contains(outer: dict[str, float], inner: dict[str, float]) -> bool:
    return all(outer[k] <= inner[k] or near(outer[k], inner[k]) for k in ("x0", "y0")) and all(
        inner[k] <= outer[k] or near(inner[k], outer[k]) for k in ("x1", "y1")
    )


def _geometry_compatible(a: dict[str, Any], b: dict[str, Any]) -> bool:
    # Points already include UserUnit. Preserve each target's true PDF origin
    # and transform; never resize a template to fit another physical sheet.
    return a["rotation"] == b["rotation"] and all(abs(a[k] - b[k]) <= 0.5 for k in ("width_pt", "height_pt"))


def _same_slot_structure(sample: dict[str, Any], target: dict[str, Any]) -> bool:
    return [(s["slot_id"], s["position_index"]) for s in sample["slots"]] == [
        (s["slot_id"], s["position_index"]) for s in target["slots"]
    ]


def _visual_slot_prefix(sample: dict[str, Any], target: dict[str, Any]) -> bool:
    a, b = visual_positions(sample), visual_positions(target)
    if (not a or not b or len(a) != len(sample["slots"]) or len(b) != len(target["slots"])
            or not compatible_visual_positions(sample, target)):
        return False
    return all((left["slot_id"], left["position_index"]) == (right["slot_id"], right["position_index"])
               for left, right in zip(sample["slots"], target["slots"]))


def _document_types(row: dict[str, Any]) -> tuple[str, ...]:
    return tuple(sorted({str(item.get("document_type", "unknown"))
                         for item in row["payload"].get("diagnostics", [])
                         if item.get("code") == "special_document"}))


def _local_layout_edges_compatible(sample: dict[str, Any], target: dict[str, Any]) -> bool:
    # Small automatic bottom-edge differences must not split identical first
    # positions into separate groups. Compare every edge to the selected sample
    # (never to another accepted neighbor), without changing target geometry.
    if any(abs(sample[edge] - target[edge]) > _LOCAL_LAYOUT_EDGE_TOLERANCE_PT
           for edge in ("left_pt", "right_pt")):
        return False
    return all(
        abs(a["top_pt"] - b["top_pt"]) <= _LOCAL_LAYOUT_EDGE_TOLERANCE_PT
        and abs((a["top_pt"] + a["height_pt"]) - (b["top_pt"] + b["height_pt"])) <= _LOCAL_LAYOUT_EDGE_TOLERANCE_PT
        for a, b in zip(sample["slots"], target["slots"], strict=True)
    )


def _incompatibility(sample: dict[str, Any], target: dict[str, Any], same_source: bool) -> str | None:
    if sample["workspace_id"] != target["workspace_id"]:
        return "different_workspace"
    if not _geometry_compatible(sample["page_geometry"], target["page_geometry"]):
        return "different_page_geometry"
    verified = bool(sample["issuer_id"] and sample["family_id"] and target["issuer_id"] and target["family_id"])
    if not verified:
        if not same_source:
            return "unverified_layout"
        # Missing identity is not positive bank evidence. Keep this fallback
        # source-local, and never ignore contradictory partial identities.
        if sample["issuer_id"] and target["issuer_id"] and sample["issuer_id"] != target["issuer_id"]:
            return "different_issuer"
        if (sample["evidence_version"] != target["evidence_version"]
                or (sample["family_id"] and target["family_id"] and sample["family_id"] != target["family_id"])):
            return "different_layout_family"
        if not _same_slot_structure(sample, target):
            return "different_slot_structure"
        return None if _local_layout_edges_compatible(sample, target) else "unverified_layout"
    if sample["issuer_id"] != target["issuer_id"]:
        return "different_issuer"
    if visual_positions(sample) is not None or visual_positions(target) is not None:
        if sample["family_id"] != target["family_id"]:
            return "different_layout_family"
        return None if _visual_slot_prefix(sample, target) else "different_slot_structure"
    if sample["family_id"] != target["family_id"] or sample["evidence_version"] != target["evidence_version"]:
        return "different_layout_family"
    if not _same_slot_structure(sample, target):
        return "different_slot_structure"
    return None


def _review_digest(restored: dict[str, Any]) -> str:
    return _collection_digest([*restored["record_revisions"], *restored["segments"]])


def _excluded_by_page(records) -> dict[tuple[str, int], list[dict[str, float]]]:
    result: dict[tuple[str, int], list[dict[str, float]]] = {}
    for record in records:
        if record is not None and record["review_status"] == "excluded":
            original = record["original"]
            result.setdefault((original["source_key"], original["source_page"]), []).append(original["candidate_rect"])
    return result


def _overlaps_excluded(original: dict[str, Any], excluded: dict[tuple[str, int], list[dict[str, float]]]) -> bool:
    candidate = original["candidate_rect"]
    return any(max(candidate["x0"], rect["x0"]) < min(candidate["x1"], rect["x1"])
               and max(candidate["y0"], rect["y0"]) < min(candidate["y1"], rect["y1"])
               for rect in excluded.get((original["source_key"], original["source_page"]), ()))


def _exclusion_requires_review(prepared: CalibrationPreparation, previous: dict[str, Any] | None,
                               previous_original: dict[str, Any] | None, original: dict[str, Any],
                               excluded: dict[tuple[str, int], list[dict[str, float]]]) -> bool:
    """Match the save transition before acknowledging a round can mask a lost exclusion."""
    if previous is not None and previous["review_status"] == "excluded":
        protected_neighbor = (prepared.editable_slot_ids is not None
                              and original["slot_id"] not in prepared.editable_slot_ids
                              and original["source_key"] == prepared.sample["source_key"]
                              and original["source_page"] == prepared.sample["source_page"]
                              and all(previous["original"][field] == original[field] for field in
                                      ("candidate_rect", "occupancy", "selection_basis")))
        return previous["original"] != original and not protected_neighbor
    # Replaced slot identities may overlap an excluded region without retaining
    # its old slot id. Such a candidate also returns to explicit review.
    return original != previous_original and _overlaps_excluded(original, excluded)


def _template_protected_slots(restored: dict[str, Any], selected: set[tuple[str, int]]) -> dict[tuple[str, int], set[str]]:
    protected: dict[tuple[str, int], set[str]] = {}
    for record in restored["segments"]:
        original = record["original"]
        page = (original["source_key"], original["source_page"])
        if page in selected and record["review_status"] == "excluded" and "document_type" not in record:
            protected.setdefault(page, set()).add(original["slot_id"])
    return protected


def _template_target_layout(previous: dict[str, Any], reference: dict[str, Any],
                            protected: set[str]) -> tuple[dict[str, Any] | None, str | None]:
    from .receipt_layout_reference import apply_historical_reference

    applied = apply_historical_reference(previous, (reference,))
    if applied is None:
        return None, "template_incompatible"
    if not protected:
        return applied, None
    # Margins are shared by every slot. A protected exclusion cannot tolerate
    # a page-wide horizontal change, even if its own top and height are restored.
    if any(applied[edge] != previous[edge] for edge in ("left_pt", "right_pt")):
        return None, "excluded_shared_geometry_scope"
    old_slots = {slot["slot_id"]: slot for slot in previous["slots"]}
    if not protected <= old_slots.keys():
        return None, "excluded_geometry_conflict"
    candidate = deepcopy(applied)
    for slot in candidate["slots"]:
        if slot["slot_id"] in protected:
            old = old_slots[slot["slot_id"]]
            slot.update({field: old[field] for field in ("top_pt", "height_pt")})
    if candidate["uniform_height"] and any(not near(candidate["slots"][0]["height_pt"], slot["height_pt"])
                                           for slot in candidate["slots"]):
        candidate["uniform_height"] = False
    try:
        return validate_complete_layout(candidate), None
    except (ValueError, TypeError, KeyError):
        return None, "excluded_geometry_conflict"


def _template_exclusion_proof(prepared: CalibrationPreparation, proposed: dict[str, Any],
                              rows: list[dict[str, Any]]) -> tuple[set[tuple[str, int, str]], list[dict[str, Any]]]:
    """Prove protected exclusions still refer to the exact same selected content.

    A layout revision changes every original ID on its page. This permits a
    decision rebind only after proving the protected candidate and evidence
    are unchanged and no other selected candidate occupies its rectangle.
    """
    sources = {source["source_key"]: source["source_id"] for source in prepared.snapshot["job"]["sources"]}
    selected = set(prepared.eligible_page_keys)
    source_keys = {source_id: key for key, source_id in sources.items()}
    selected_keys = {(source_keys[source_id], page) for source_id, page in selected}
    protected = _template_protected_slots(prepared.restored, selected_keys)
    old_rows = {(row["source_id"], row["page"]): row for row in prepared.page_rows}
    new_rows = {(row["source_id"], row["page"]): row for row in rows}
    old_originals = {(item["source_key"], item["source_page"], item["slot_id"]): item
                     for item in prepared.snapshot["originals"]}
    new_originals = {(item["source_key"], item["source_page"], item["slot_id"]): item
                     for item in proposed["originals"]}
    new_by_page: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for item in proposed["originals"]:
        new_by_page.setdefault((item["source_key"], item["source_page"]), []).append(item)
    safe, blockers = set(), []
    for (source_key, page), slot_ids in protected.items():
        source_id = sources[source_key]
        old_payload = old_rows[(source_id, page)]["payload"]["receipt_page"]
        new_payload = new_rows[(source_id, page)]["payload"]["receipt_page"]
        old_layout, new_layout = old_payload["layout_definition"], new_payload["layout_definition"]
        old_slots = {slot["slot_id"]: slot for slot in old_layout["slots"]}
        new_slots = {slot["slot_id"]: slot for slot in new_layout["slots"]}
        def selected_candidates(payload):
            instances = {instance["instance_id"]: instance for instance in payload["instances"]}
            return {instances[candidate["instance_id"]]["slot_id"]:
                    (instances[candidate["instance_id"]], candidate) for candidate in payload["candidates"]}
        old_candidates = selected_candidates(old_payload)
        new_candidates = selected_candidates(new_payload)
        margins_same = all(old_layout[field] == new_layout[field] for field in ("left_pt", "right_pt"))
        for slot_id in slot_ids:
            key = (source_key, page, slot_id)
            before, after = old_originals.get(key), new_originals.get(key)
            original_same = (before is not None and after is not None and all(
                before[field] == after[field] for field in
                ("source_key", "source_page", "slot_id", "position_index", "candidate_rect",
                 "occupancy", "selection_basis", "page_geometry")))
            geometry_same = (margins_same and slot_id in old_slots and slot_id in new_slots and all(
                old_slots[slot_id][field] == new_slots[slot_id][field]
                for field in ("top_pt", "height_pt", "position_index")))
            old_pair, new_pair = old_candidates.get(slot_id), new_candidates.get(slot_id)
            content_same = (old_pair is not None and new_pair is not None and all(
                old_pair[0][field] == new_pair[0][field] for field in ("rect", "position_index", "occupancy"))
                and all(old_pair[1][field] == new_pair[1][field]
                        for field in ("selection_basis", "evidence", "needs_review")))
            overlap = False
            if before is not None:
                rect = before["candidate_rect"]
                overlap = any(other["slot_id"] != slot_id and
                              min(other["candidate_rect"]["x1"], rect["x1"]) > max(other["candidate_rect"]["x0"], rect["x0"]) and
                              min(other["candidate_rect"]["y1"], rect["y1"]) > max(other["candidate_rect"]["y0"], rect["y0"])
                              for other in new_by_page.get((source_key, page), ()))
            if original_same and geometry_same and content_same and not overlap:
                safe.add(key)
            else:
                blockers.append({"source_key": source_key, "page": page, "slot_id": slot_id,
                                 "code": "excluded_template_protection"})
    return safe, blockers


def _ordinary_exclusion_proof(prepared: CalibrationPreparation, proposed: dict[str, Any],
                              rows: list[dict[str, Any]], changed: set[str]) -> set[tuple[str, int, str]]:
    """Prove that an ordinary, untouched neighbor can keep its exclusion.

    Recomputing a page advances its layout revision and therefore every
    instance identity.  That identity change alone is not a content change,
    but an exclusion may be rebound only when the complete candidate binding
    remains byte-for-byte equivalent and no other candidate moves into its
    former rectangle.  The proof is intentionally narrower than the
    template-specific proof and applies only to ordinary calibration rounds.
    """
    if prepared.mode != "calibration" or prepared.editable_slot_ids is not None:
        return set()
    sources = {source["source_key"]: source for source in prepared.snapshot["job"]["sources"]}
    source_ids = {source["source_key"]: source["source_id"] for source in sources.values()}
    source_key_by_id = {source["source_id"]: source["source_key"] for source in sources.values()}
    selected = {(source_key_by_id[source_id], page) for source_id, page in prepared.eligible_page_keys}
    old_rows = {(row["source_id"], row["page"]): row for row in prepared.page_rows}
    new_rows = {(row["source_id"], row["page"]): row for row in rows}
    old_originals = {(item["source_key"], item["source_page"], item["slot_id"]): item
                     for item in prepared.snapshot["originals"]}
    new_originals = {(item["source_key"], item["source_page"], item["slot_id"]): item
                     for item in proposed["originals"]}
    previous_records = {(record["original"]["source_key"], record["original"]["source_page"],
                         record["original"]["slot_id"]): record
                        for record in prepared.restored["segments"]}
    new_by_page: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for item in proposed["originals"]:
        new_by_page.setdefault((item["source_key"], item["source_page"]), []).append(item)

    def candidate_pairs(payload: dict[str, Any]) -> dict[str, tuple[dict[str, Any], dict[str, Any]]]:
        page = payload["receipt_page"]
        instances = {instance["instance_id"]: instance for instance in page["instances"]}
        return {instances[candidate["instance_id"]]["slot_id"]:
                (instances[candidate["instance_id"]], candidate)
                for candidate in page["candidates"]}

    safe: set[tuple[str, int, str]] = set()
    for key, previous in previous_records.items():
        source_key, page, slot_id = key
        # A full-page exclusion covers more than this slot; keep its existing
        # re-review behavior. Valid manual crops stay inside their candidate.
        if (previous["review_status"] != "excluded" or previous["crop_mode"] == "full_page"
                or previous["final_rect"] is None or (source_key, page) not in selected
                or slot_id in changed):
            continue
        before, after = old_originals.get(key), new_originals.get(key)
        old_source_id = source_ids.get(source_key)
        old_row = old_rows.get((old_source_id, page))
        new_row = new_rows.get((old_source_id, page))
        if before is None or after is None or old_row is None or new_row is None:
            continue
        old_page, new_page = old_row["payload"]["receipt_page"], new_row["payload"]["receipt_page"]
        old_layout, new_layout = old_page["layout_definition"], new_page["layout_definition"]
        source_sha = sources[source_key]["sha256"]
        if (old_page["source_sha256"] != source_sha or new_page["source_sha256"] != source_sha
                or before["page_geometry"] != after["page_geometry"]
                or old_layout["page_geometry"] != before["page_geometry"]
                or new_layout["page_geometry"] != after["page_geometry"]
                or old_layout["page_geometry"] != new_layout["page_geometry"]
                or any(old_layout[field] != new_layout[field] for field in ("left_pt", "right_pt"))):
            continue
        old_slots = {slot["slot_id"]: slot for slot in old_layout["slots"]}
        new_slots = {slot["slot_id"]: slot for slot in new_layout["slots"]}
        if slot_id not in old_slots or slot_id not in new_slots:
            continue
        old_slot, new_slot = old_slots[slot_id], new_slots[slot_id]
        if any(old_slot[field] != new_slot[field] for field in ("top_pt", "height_pt", "position_index")):
            continue
        if any(before[field] != after[field] for field in
               ("source_key", "source_page", "slot_id", "position_index", "candidate_rect",
                "occupancy", "selection_basis", "needs_review", "page_geometry")):
            continue
        old_pair, new_pair = candidate_pairs(old_row["payload"]), candidate_pairs(new_row["payload"])
        old_candidate, new_candidate = old_pair.get(slot_id), new_pair.get(slot_id)
        if old_candidate is None or new_candidate is None:
            continue
        old_instance, old_item = old_candidate
        new_instance, new_item = new_candidate
        if any(old_instance[field] != new_instance[field]
               for field in ("source_sha256", "page", "slot_id", "position_index", "rect", "occupancy")):
            continue
        if any(old_item[field] != new_item[field] for field in ("selection_basis", "evidence", "needs_review")):
            continue
        if any(other["slot_id"] != slot_id
               and max(other["candidate_rect"]["x0"], before["candidate_rect"]["x0"])
                   < min(other["candidate_rect"]["x1"], before["candidate_rect"]["x1"])
               and max(other["candidate_rect"]["y0"], before["candidate_rect"]["y0"])
                   < min(other["candidate_rect"]["y1"], before["candidate_rect"]["y1"])
               for other in new_by_page.get((source_key, page), ())):
            continue
        safe.add(key)
    return safe


def _target_layout(base: dict[str, Any], draft: dict[str, Any], previous: dict[str, Any],
                   changed: set[str], revision: int) -> dict[str, Any]:
    """Preserve other positions when only one sample position is calibrated."""
    before_ids = [slot["slot_id"] for slot in base["slots"]]
    after_ids = [slot["slot_id"] for slot in draft["slots"]]
    previous_slots = {slot["slot_id"]: slot for slot in previous["slots"]}
    if visual_positions(base) is not None and len(previous_slots) < len(base["slots"]):
        if not _visual_slot_prefix(base, previous):
            raise BatchConflict("a shared tail calibration requires proven corresponding positions")
        if before_ids != after_ids:
            raise BatchConflict("a shared tail calibration must preserve the proven slot identities")
        # The editor may use a verified full-page representative for a tail,
        # but the target retains only the positions actually present there.
        slots = [deepcopy(slot if slot["slot_id"] in changed else previous_slots[slot["slot_id"]])
                 for slot in draft["slots"] if slot["slot_id"] in previous_slots]
    else:
        slots = [deepcopy(slot if slot["slot_id"] in changed or before_ids != after_ids
                          else previous_slots[slot["slot_id"]]) for slot in draft["slots"]]
    target = {**deepcopy(draft), "layout_id": previous["layout_id"], "revision": revision,
              "page_geometry": deepcopy(previous["page_geometry"]), "slots": slots,
              "evidence_version": previous["evidence_version"]}
    for edge in ("left_pt", "right_pt"):
        if near(base[edge], draft[edge]):
            target[edge] = previous[edge]
    # An untouched target position can have a slightly different automatic
    # height. Do not silently resize it to satisfy the sample's equal-height
    # flag; the next explicit shared-height edit includes all positions.
    if target["uniform_height"] and any(not near(slots[0]["height_pt"], slot["height_pt"]) for slot in slots):
        target["uniform_height"] = False
    return validate_complete_layout(target)


def _calibration_changed_slots(prepared: CalibrationPreparation, draft: dict[str, Any]) -> set[str]:
    """Use the same explicit edit scope during preview and journal publication."""
    base = prepared.layout
    changed = set(affected_slot_ids(base, draft)) or {prepared.sample["slot_id"]}
    if draft["uniform_height"] and (draft["uniform_height"] != base["uniform_height"] or any(
            not near(old["height_pt"], new["height_pt"]) for old, new in zip(base["slots"], draft["slots"]))):
        changed.update(slot["slot_id"] for slot in draft["slots"])
    return changed


@dataclass(frozen=True)
class CalibrationPreparation:
    """Private input binding. Never deserialize this object from a WebView."""

    snapshot: dict[str, Any]
    page_rows: list[dict[str, Any]]
    restored: dict[str, Any]
    context_key: str
    sample: dict[str, Any]
    layout: dict[str, Any]
    eligible_page_keys: tuple[tuple[str, int], ...]
    excluded_page_counts: dict[str, int]
    editable_slot_ids: tuple[str, ...] | None = None
    mode: str = "calibration"
    template_id: str | None = None
    template_reference_digest: str | None = None
    template_applied_slot_ids: tuple[str, ...] = ()

    @property
    def fingerprint(self) -> str:
        return _digest({
            "job_binding": [*_binding(self.snapshot["job"])[:-1],
                            [list(source) for source in _binding(self.snapshot["job"])[-1]]],
            "context_key": self.context_key,
            "sample_id": self.sample["id"], "layout": self.layout,
            "pages_digest": _collection_digest(self.page_rows),
            "review_digest": _review_digest(self.restored),
            "scope_digest": _collection_digest([{"source_id": source, "page": page}
                                                for source, page in self.eligible_page_keys]),
            **({"editable_slot_ids": list(self.editable_slot_ids)} if self.editable_slot_ids is not None else {}),
            **({"mode": self.mode, "template_id": self.template_id,
                "template_reference_digest": self.template_reference_digest,
                "template_applied_slot_ids": list(self.template_applied_slot_ids)}
               if self.mode == "template_apply" else {}),
        })

    def view(self) -> dict[str, Any]:
        sources = {source["source_id"]: source for source in self.snapshot["job"]["sources"]}
        selected = set(self.eligible_page_keys)
        counts = Counter()
        for row in self.page_rows:
            if (row["source_id"], row["page"]) in selected:
                counts[row["source_id"]] += 1
        return deepcopy({
            "schema_version": 1, "job_id": self.snapshot["job"]["id"],
            "result_revision": self.snapshot["job"]["result_revision"], "context_key": self.context_key,
            "sample_id": self.sample["id"], "selected_slot_id": self.sample["slot_id"],
            "preparation_fingerprint": self.fingerprint,
            "layout_definition": self.layout,
            "scope_kind": "verified_layout" if self.layout["issuer_id"] and self.layout["family_id"] else "current_pdf",
            "pages": [{"source_key": sources[source_id]["source_key"], "page": page}
                      for source_id, page in self.eligible_page_keys],
            "source_count": len(counts), "page_count": len(selected),
            "excluded_page_counts": self.excluded_page_counts,
            **({"editable_slot_ids": list(self.editable_slot_ids), "template_allowed": False}
               if self.editable_slot_ids is not None else {}),
            **({"mode": self.mode, "template_id": self.template_id,
                "applied_slot_ids": list(self.template_applied_slot_ids), "template_allowed": False}
               if self.mode == "template_apply" else {}),
        })


@dataclass(frozen=True)
class CalibrationPreview:
    preparation: CalibrationPreparation
    draft: dict[str, Any]
    page_rows: list[dict[str, Any]]
    proposed: dict[str, Any]
    affected: list[dict[str, Any]]
    risks: list[dict[str, Any]]
    blockers: list[dict[str, Any]]
    retained_record_ids: tuple[str, ...]
    included_exception_ids: tuple[str, ...]
    fingerprint: str
    preserved_excluded_count: int = 0

    @property
    def can_save(self) -> bool:
        return not self.blockers and bool(self.affected)

    def view(self) -> dict[str, Any]:
        return deepcopy({
            "schema_version": 1, "job_id": self.preparation.snapshot["job"]["id"],
            "result_revision": self.preparation.snapshot["job"]["result_revision"],
            "sample_id": self.preparation.sample["id"], "preview_fingerprint": self.fingerprint,
            "layout_definition": self.draft, "can_save": self.can_save,
            "affected": self.affected, "risks": self.risks, "blockers": self.blockers,
            "retained_record_ids": list(self.retained_record_ids),
            "included_exception_ids": list(self.included_exception_ids),
            "candidate_count": len(self.proposed["items"]),
            "page_count": len(self.preparation.eligible_page_keys),
            "saved": False,
            **({"template_allowed": False} if self.preparation.editable_slot_ids is not None else {}),
            **({"mode": "template_apply", "template_id": self.preparation.template_id,
                "applied_slot_ids": list(self.preparation.template_applied_slot_ids),
                "excluded_page_counts": self.preparation.excluded_page_counts,
                "preserved_excluded_count": self.preserved_excluded_count,
                "template_allowed": False} if self.preparation.mode == "template_apply" else {}),
        })


def prepare_receipt_template_apply(store: BatchStore, job_id: str, result_revision: str,
                                   template_id: str, review_database: Path,
                                   template_database: Path) -> tuple[CalibrationPreparation, dict[str, Any], dict[str, Any]]:
    """Bind one active reference to ordinary pages in an existing result.

    A page with only excluded decisions may contribute its other slots if its
    shared margins and protected geometry remain unchanged. Every other human
    decision still isolates the page from this automatic template operation.
    """
    from .receipt_layout_history import selected_reference
    reference = selected_reference(store, template_database, template_id)
    snapshot = store.review_snapshot(job_id, result_revision)
    _, restored = _validated_review_binding(store, snapshot, review_database)
    records_by_page: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for record in restored["segments"]:
        original = record["original"]
        records_by_page.setdefault((original["source_key"], original["source_page"]), []).append(record)
    source_by_key = {source["source_key"]: source["source_id"] for source in snapshot["job"]["sources"]}
    source_key_by_id = {source_id: source_key for source_key, source_id in source_by_key.items()}
    rows = {(row["source_id"], row["page"]): row for row in store.read_page_results(job_id)}
    confirmed = set(reference["confirmed_slot_ids"])
    sample_id = None
    rejected_pages = {}
    for original in snapshot["originals"]:
        key = (original["source_key"], original["source_page"])
        records = records_by_page.get(key, ())
        protected = {record["original"]["slot_id"] for record in records}
        if any(record["review_status"] != "excluded" or "document_type" in record for record in records):
            rejected_pages[key] = "prior_review_scope"
            continue
        if original["slot_id"] in protected or original["slot_id"] not in confirmed:
            rejected_pages.setdefault(key, "no_confirmed_slot")
            continue
        row = rows.get((source_by_key[original["source_key"]], original["source_page"]))
        if row is None or _document_types(row):
            rejected_pages[key] = "special_document_scope"
            continue
        layout = row["payload"]["receipt_page"]["layout_definition"]
        if _template_target_layout(layout, reference, protected)[0] is not None:
            sample_id = original["id"]
            break
        rejected_pages[key] = "template_incompatible"
    if sample_id is None:
        raise TemplateNoTargetsError(dict(Counter(rejected_pages.values())), legacy_identity=(
            reference["layout_definition"]["evidence_version"] == "receipt-layout-evidence-v1"
            and any(visual_positions(row["payload"]["receipt_page"]["layout_definition"]) is not None for row in rows.values())))

    prepared = prepare_receipt_calibration(store, job_id, result_revision, sample_id, review_database)
    eligible, excluded = [], Counter(prepared.excluded_page_counts)
    for source_id, page in prepared.eligible_page_keys:
        row = rows[(source_id, page)]
        source_key = source_key_by_id[source_id]
        records = records_by_page.get((source_key, page), ())
        if any(record["review_status"] != "excluded" or "document_type" in record for record in records):
            excluded["prior_review_scope"] += 1
            continue
        if _document_types(row):
            excluded["special_document_scope"] += 1
            continue
        current = row["payload"]["receipt_page"]["layout_definition"]
        protected = {record["original"]["slot_id"] for record in records}
        if not confirmed.intersection(slot["slot_id"] for slot in current["slots"] if slot["slot_id"] not in protected):
            excluded["no_confirmed_slot"] += 1
            continue
        target, reason = _template_target_layout(current, reference, protected)
        if target is None:
            excluded[reason] += 1
            continue
        eligible.append((source_id, page))
    sample_key = (prepared.sample["source_key"], prepared.sample["source_page"])
    sample_protected = {record["original"]["slot_id"] for record in records_by_page.get(sample_key, ())}
    draft, _ = _template_target_layout(prepared.layout, reference, sample_protected)
    if not eligible or draft is None:
        raise TemplateNoTargetsError(dict(excluded))
    prepared = replace(prepared, eligible_page_keys=tuple(eligible), excluded_page_counts=dict(excluded),
                       mode="template_apply", template_id=template_id,
                       template_reference_digest=_digest(reference),
                       template_applied_slot_ids=tuple(slot["slot_id"] for slot in reference["layout_definition"]["slots"]
                                                       if slot["slot_id"] in confirmed))
    return prepared, draft, reference


def prepare_receipt_calibration(store: BatchStore, job_id: str, result_revision: str,
                                sample_id: str, review_database: Path) -> CalibrationPreparation:
    snapshot = store.review_snapshot(job_id, result_revision)
    job = snapshot["job"]
    if job.get("page_result_schema") != 2:
        raise BatchConflict("layout calibration requires a receipt task")
    if job["computation_version"] != current_computation_version():
        raise BatchComputationChanged("batch computation version has changed")
    context_key, restored = _validated_review_binding(store, snapshot, review_database)
    sample = next((item for item in snapshot["originals"] if item["id"] == sample_id), None)
    if sample is None:
        raise BatchConflict("calibration sample is absent from the current result")
    rows = store.read_page_results(job_id)
    source_ids = {source["source_key"]: source["source_id"] for source in job["sources"]}
    sample_source = source_ids[sample["source_key"]]
    sample_row = next((row for row in rows if row["source_id"] == sample_source and row["page"] == sample["source_page"]), None)
    if sample_row is None:
        raise BatchConflict("calibration sample page is unavailable")
    layout = validate_complete_layout(sample_row["payload"]["receipt_page"]["layout_definition"])
    # An explicit type decision belongs to one immutable receipt, not its whole
    # page. Keep that page outside every family-wide calibration, including
    # when a keyword search did not select one of its neighboring slots.
    protected_pages = {(source_ids[record["original"]["source_key"]], record["original"]["source_page"])
                       for record in restored["segments"] if "document_type" in record}
    protected_sample = (sample_source, sample["source_page"]) in protected_pages
    editable_slot_ids = (sample["slot_id"],) if protected_sample else None
    if protected_sample:
        # Retain every rectangle, but do not require the selected slot's new
        # height to equal its neighbors during this isolated edit.
        layout["uniform_height"] = False
    eligible, excluded = [], Counter()
    sample_types = _document_types(sample_row)
    for row in rows:
        other = row["payload"]["receipt_page"]["layout_definition"]
        key = (row["source_id"], row["page"])
        if protected_sample:
            reason = None if key == (sample_source, sample["source_page"]) else "manual_classification_scope"
        elif key in protected_pages:
            reason = "manual_classification_scope"
        else:
            reason = ("different_document_type" if _document_types(row) != sample_types
                      else _incompatibility(layout, other, row["source_id"] == sample_source))
        if reason is None:
            eligible.append((row["source_id"], row["page"]))
        else:
            excluded[reason] += 1
    if not protected_sample and visual_positions(layout) is not None:
        eligible_keys = set(eligible)
        compatible_layouts = [row["payload"]["receipt_page"]["layout_definition"] for row in rows
                              if (row["source_id"], row["page"]) in eligible_keys]
        representative = max(compatible_layouts, key=lambda value: len(value["slots"]), default=layout)
        if len(representative["slots"]) > len(layout["slots"]):
            # Keep the selected PDF/page geometry and identity while exposing
            # every proven position in the family, even when the sample is a tail.
            layout = validate_complete_layout({**deepcopy(representative),
                "layout_id": layout["layout_id"], "revision": layout["revision"],
                "page_geometry": deepcopy(layout["page_geometry"])})
            # A tail proves only its present prefix. It cannot bridge two
            # full layouts with different later positions. Coordinate
            # tolerances also are not transitive, so retain the intersection
            # of compatibility with the selected page and the full editor.
            eligible = []
            for row in rows:
                key = (row["source_id"], row["page"])
                if key not in eligible_keys:
                    continue
                other = row["payload"]["receipt_page"]["layout_definition"]
                reason = _incompatibility(layout, other, row["source_id"] == sample_source)
                if reason is None:
                    eligible.append(key)
                else:
                    excluded[reason] += 1
    if _binding(store.get_job(job_id)) != _binding(job):
        raise BatchConflict("batch changed during calibration preparation")
    return CalibrationPreparation(deepcopy(snapshot), deepcopy(rows), deepcopy(restored), context_key,
                                  deepcopy(sample), layout, tuple(eligible), dict(excluded), editable_slot_ids)


def assert_calibration_current(store: BatchStore, prepared: CalibrationPreparation, review_database: Path) -> None:
    job = prepared.snapshot["job"]
    if _binding(store.get_job(job["id"])) != _binding(job):
        raise BatchConflict("calibration belongs to a stale task revision")
    # Checkpoint checksums bind even pages with zero keyword hits.
    if _collection_digest(store.read_page_results(job["id"])) != _collection_digest(prepared.page_rows):
        raise BatchConflict("calibration page geometry changed")
    _, restored = _validated_review_binding(store, prepared.snapshot, review_database)
    if _review_digest(restored) != _review_digest(prepared.restored):
        raise BatchConflict("receipt decisions changed during calibration")


def _preserve_unedited_candidate_review(previous: dict[str, Any], payload: dict[str, Any],
                                        changed: set[str], *, force_review: bool = False) -> dict[str, Any]:
    """Keep automatic decisions without fabricating a user review record.

    Explicit layout recomputation marks the entire page for review. Only the
    edited positions need that blanket flag; unchanged candidates retain their
    prior flag, unless current evidence or diagnostics introduce a real risk.
    Store this in the checkpoint so save/reopen/undo share the same result.
    """
    old_page, new_page = previous["receipt_page"], payload["receipt_page"]
    old_instances = {item["instance_id"]: item for item in old_page["instances"]}
    old_candidates = {old_instances[item["instance_id"]]["slot_id"]:
                      (old_instances[item["instance_id"]], item) for item in old_page["candidates"]}
    instances = {item["instance_id"]: item for item in new_page["instances"]}
    risky_slots, risky_instances = set(), set()
    global_risk = False
    for diagnostic in payload["diagnostics"]:
        global_risk |= diagnostic["code"] in {
            "content_outside_slots", "visual_outside_slots", "diagnostic_budget_exceeded"}
        if "slot_id" in diagnostic:
            risky_slots.add(diagnostic["slot_id"])
        risky_instances.update(diagnostic.get("instance_ids", ()))
    for candidate in new_page["candidates"]:
        instance = instances[candidate["instance_id"]]
        slot_id = instance["slot_id"]
        if force_review and slot_id in changed:
            candidate["needs_review"] = True
            continue
        old = old_candidates.get(slot_id)
        if (slot_id in changed or old is None or global_risk or slot_id in risky_slots
                or instance["instance_id"] in risky_instances):
            continue
        old_instance, old_candidate = old
        if (all(instance[key] == old_instance[key] for key in ("position_index", "rect", "occupancy"))
                and all(candidate[key] == old_candidate[key] for key in ("selection_basis", "evidence"))):
            candidate["needs_review"] = old_candidate["needs_review"]
    # Review is now attached to individual candidates, including every changed
    # or newly selected position, rather than imposed on all neighboring slots.
    payload["suggestion"]["needs_review"] = False
    return validate_receipt_checkpoint(payload)


def preview_receipt_calibration(store: BatchStore, prepared: CalibrationPreparation,
                                draft: dict[str, Any], review_database: Path, *,
                                include_exception_ids: list[str] | None = None,
                                progress: Callable[[int, int], None] | None = None,
                                cancelled: Callable[[], bool] | None = None,
                                template_reference: dict[str, Any] | None = None) -> CalibrationPreview:
    """Recompute selection from PDF content, not from the previous hit list.

    The new rectangle may expand beyond the automatic candidate. Every slot
    (including unselected neighbors) still has to fit the actual paper and
    must not overlap. Source originals are opened through private SHA-bound
    working copies. No review records or durable pages are written here.
    """
    checked = validate_complete_layout(draft)
    base = prepared.layout
    if prepared.mode == "template_apply":
        if (template_reference is None or prepared.template_reference_digest != _digest(template_reference)
                or prepared.template_id != template_reference["template_id"]):
            raise BatchConflict("layout template changed before preview")
        sample_page = (prepared.sample["source_key"], prepared.sample["source_page"])
        sample_protected = _template_protected_slots(prepared.restored, {sample_page}).get(sample_page, set())
        if _template_target_layout(base, template_reference, sample_protected)[0] != checked:
            raise BatchConflict("template draft differs from the selected reference")
    elif template_reference is not None:
        raise BatchConflict("layout template is not part of this calibration")
    if prepared.editable_slot_ids is not None:
        if any(checked[field] != base[field] for field in ("uniform_height", "left_pt", "right_pt")):
            raise BatchConflict("manual classification requires unchanged shared margins and independent slot heights")
        if [(slot["slot_id"], slot["position_index"]) for slot in checked["slots"]] != [
                (slot["slot_id"], slot["position_index"]) for slot in base["slots"]]:
            raise BatchConflict("manual classification requires unchanged slot identities")
        if any(before != after for before, after in zip(base["slots"], checked["slots"], strict=True)
               if before["slot_id"] not in prepared.editable_slot_ids):
            raise BatchConflict("manual classification only permits the selected slot to change")
    if any(checked[key] != base[key] for key in base if key not in _DRAFT_FIELDS):
        raise BatchConflict("a calibration draft cannot change its source or layout identity")
    if checked["revision"] not in (base["revision"], base["revision"] + 1):
        raise BatchConflict("calibration layout revision is stale")
    include = [] if include_exception_ids is None else include_exception_ids
    if (not isinstance(include, list) or any(not isinstance(value, str) for value in include)
            or len(set(include)) != len(include)):
        raise BatchModelError("exception identities must be a unique list")
    records = {record["original"]["id"]: record for record in prepared.restored["segments"]}
    # Exclusion is not an opt-in crop exception. Its identity/geometry are
    # checked by the journal transition, including when its old crop was manual.
    exceptions = {key for key, record in records.items() if record["review_status"] != "excluded"
                  and (record["manual_adjusted"] or record["crop_mode"] == "full_page")}
    if not set(include) <= exceptions:
        raise BatchConflict("explicit exception selection is not a current manual decision")
    assert_calibration_current(store, prepared, review_database)
    selected_keys = set(prepared.eligible_page_keys)
    source_by_id = {source["source_id"]: source for source in prepared.snapshot["job"]["sources"]}
    source_ids = {source["source_key"]: source_id for source_id, source in source_by_id.items()}
    if prepared.mode == "template_apply" and any(
            (source_ids[record["original"]["source_key"]], record["original"]["source_page"]) in selected_keys
            and (record["review_status"] != "excluded" or "document_type" in record)
            for record in prepared.restored["segments"]):
        raise BatchConflict("template scope contains an existing receipt decision")
    selected_source_pages = {(source_by_id[source_id]["source_key"], page) for source_id, page in selected_keys}
    protected = (_template_protected_slots(prepared.restored, selected_source_pages)
                 if prepared.mode == "template_apply" else {})
    row_map = {(row["source_id"], row["page"]): deepcopy(row) for row in prepared.page_rows}
    eligible_rows = [row for row in prepared.page_rows if (row["source_id"], row["page"]) in selected_keys]
    # A template changes only its confirmed geometry, but the user must
    # inspect every ordinary receipt on each affected page before exporting.
    # This includes positions whose automatic frame was left unchanged.
    changed = ({slot["slot_id"] for row in eligible_rows
                for slot in row["payload"]["receipt_page"]["layout_definition"]["slots"]}
               if prepared.mode == "template_apply"
               else _calibration_changed_slots(prepared, checked))
    scope_ids = {item["id"] for item in prepared.snapshot["originals"] if
                 (source_ids[item["source_key"]], item["source_page"]) in selected_keys
                 and item["slot_id"] in changed
                 and item["slot_id"] not in protected.get((item["source_key"], item["source_page"]), ())}
    if not set(include) <= scope_ids:
        raise BatchConflict("exception selection is outside this calibration round")
    retained = tuple(sorted((exceptions & scope_ids) - set(include)))
    new_revision = max(row["payload"]["receipt_page"]["layout_definition"]["revision"] for row in eligible_rows) + 1
    budget, done, total_bytes = SearchBudget(), 0, 0
    risks, blockers = [], []
    job = prepared.snapshot["job"]
    for source_id, source in source_by_id.items():
        source_rows = [row for row in eligible_rows if row["source_id"] == source_id]
        if not source_rows:
            continue
        if cancelled and cancelled():
            raise BatchConflict("calibration preview cancelled")
        with open_batch_source(source["access_path"], source["sha256"]) as opened:
            if opened.size_bytes != source["size_bytes"] or opened.page_count != source["page_count"]:
                raise BatchSourceError("source_changed")
            for row in source_rows:
                if cancelled and cancelled():
                    raise BatchConflict("calibration preview cancelled")
                old_layout = row["payload"]["receipt_page"]["layout_definition"]
                if prepared.mode == "template_apply":
                    page_protected = protected.get((source["source_key"], row["page"]), set())
                    applied, _ = _template_target_layout(old_layout, template_reference, page_protected)
                    if applied is None:
                        raise BatchConflict("template target changed before preview")
                    target = validate_complete_layout({**applied, "revision": new_revision})
                    row_changed = changed.intersection(slot["slot_id"] for slot in old_layout["slots"])
                    row_changed.difference_update(page_protected)
                else:
                    target = _target_layout(base, checked, old_layout, changed, new_revision)
                    row_changed = changed
                if prepared.mode == "template_apply" and requires_verified_crop_envelopes(old_layout):
                    # This alternate identity tolerates wrapped body rows. It
                    # never permits the saved crop to truncate the current
                    # page's independently verified title, logo or outer table.
                    bounds = opened.verified_template_crop_envelopes(row["page"])
                    if len(bounds) != len(target["slots"]):
                        blockers.append({"source_key": source["source_key"], "page": row["page"],
                                         "code": "template_content_outside_crop"})
                    for slot, box in zip(target["slots"], bounds):
                        if slot["slot_id"] not in row_changed:
                            continue
                        body = dict(zip(("x0", "y0", "x1", "y1"), box, strict=True))
                        if not _rect_contains(slot_rect(target, slot), body):
                            blockers.append({"source_key": source["source_key"], "page": row["page"],
                                             "slot_id": slot["slot_id"], "code": "template_content_outside_crop"})
                computed = opened.compute_receipt_page(row["page"], job["processing_options"], job["match_mode"], budget,
                                                       layout_definition=target)
                payload = _preserve_unedited_candidate_review(
                    row["payload"], encode_receipt_checkpoint(computed), row_changed,
                    force_review=prepared.mode == "template_apply")
                encoded = canonical_json(payload, max_bytes=MAX_PAGE_RESULT_BYTES)
                total_bytes += len(encoded)
                if total_bytes > min(_MAX_PREVIEW_BYTES, store.quota_bytes):
                    raise BatchCapacityExceeded("calibration preview exceeds private storage budget")
                row_map[(source_id, row["page"])] = {**row, "payload": payload, "sha256": sha256(encoded).hexdigest()}
                for diagnostic in payload["diagnostics"]:
                    observation = {"source_key": source["source_key"], "page": row["page"], "diagnostic": diagnostic}
                    observation["risk_id"] = _digest(observation)
                    (blockers if diagnostic["code"] in _MEMBERSHIP_ERRORS else risks).append(observation)
                if prepared.mode == "template_apply" and _document_types({"payload": payload}):
                    blockers.append({"source_key": source["source_key"], "page": row["page"],
                                     "code": "template_special_document"})
                done += 1
                if progress:
                    progress(done, len(eligible_rows))
    rows = [row_map[(row["source_id"], row["page"])] for row in prepared.page_rows]
    proposed = assemble_receipt_results(job["id"], job["sources"], job["processing_options"], job["match_mode"],
                                        job["computation_version"], rows)
    old_by_slot = {(item["source_key"], item["source_page"], item["slot_id"]): item for item in prepared.snapshot["originals"]}
    new_by_slot = {(item["source_key"], item["source_page"], item["slot_id"]): item for item in proposed["originals"]}
    selected_source_pages = {(source_by_id[source_id]["source_key"], page) for source_id, page in selected_keys}
    previous_records = {(record["original"]["source_key"], record["original"]["source_page"], record["original"]["slot_id"]): record
                        for record in prepared.restored["segments"]}
    excluded_regions = _excluded_by_page(previous_records.values())
    protected_proven = set()
    ordinary_proven = set()
    if prepared.mode == "template_apply":
        protected_proven, protection_blockers = _template_exclusion_proof(prepared, proposed, rows)
        blockers.extend(protection_blockers)
    else:
        ordinary_proven = _ordinary_exclusion_proof(prepared, proposed, rows, changed)
    for key, original in new_by_slot.items():
        if key[:2] not in selected_source_pages:
            continue
        if key in protected_proven or key in ordinary_proven:
            continue
        if _exclusion_requires_review(prepared, previous_records.get(key), old_by_slot.get(key), original, excluded_regions):
            observation = {"source_key": key[0], "page": key[1], "diagnostic":
                           {"code": "excluded_decision_reset", "slot_id": key[2]}}
            observation["risk_id"] = _digest(observation)
            risks.append(observation)
    # A type override cannot be dropped merely because a changed boundary no
    # longer matches this keyword. Its identity must stay reviewable; users can
    # explicitly exclude it instead of silently returning the page to a normal
    # template family on the next round.
    for record in prepared.restored["segments"]:
        original = record["original"]
        key = (original["source_key"], original["source_page"], original["slot_id"])
        if "document_type" in record and key not in new_by_slot:
            blockers.append({"source_key": key[0], "page": key[1], "slot_id": key[2],
                             "code": "manual_classification_membership", "original_id": original["id"]})
    affected = []
    for key in dict.fromkeys([*old_by_slot, *new_by_slot]):
        if key[:2] not in selected_source_pages:
            continue
        before, after = old_by_slot.get(key), new_by_slot.get(key)
        if key[2] in protected.get(key[:2], ()):
            continue
        # Newly selected or removed receipts always enter the preview, even
        # when the previous keyword list did not mention their slot.
        if key[2] not in changed and before is not None and after is not None:
            continue
        previous_id = before["id"] if before else None
        retained_record = records.get(previous_id) if previous_id in retained else None
        if retained_record:
            if after is None or retained_record["crop_mode"] == "full_page" or not _rect_contains(after["candidate_rect"], retained_record["final_rect"]):
                blockers.append({"source_key": key[0], "page": key[1], "slot_id": key[2],
                                 "code": "manual_exception_conflict", "original_id": previous_id})
        affected.append({"source_key": key[0], "page": key[1], "slot_id": key[2],
                         "previous_id": previous_id, "id": after["id"] if after else None,
                         "before_rect": before["candidate_rect"] if before else None,
                         "after_rect": retained_record["final_rect"] if retained_record else (after["candidate_rect"] if after else None),
                         "status": "retained_manual" if retained_record else ("added" if before is None else ("removed" if after is None else "updated"))})
        if prepared.mode == "template_apply" and before is not None and after is None:
            blockers.append({"source_key": key[0], "page": key[1], "slot_id": key[2],
                             "code": "template_removed_candidate", "original_id": previous_id})
    assert_calibration_current(store, prepared, review_database)
    if cancelled and cancelled():
        raise BatchConflict("calibration preview cancelled")
    fingerprint = _digest({"job_id": job["id"], "result_revision": job["result_revision"],
                           "context_key": prepared.context_key, "review_digest": _review_digest(prepared.restored),
                           "draft": checked, "pages_digest": _collection_digest(rows),
                           "exceptions": sorted(include), "affected_digest": _collection_digest(affected)})
    return CalibrationPreview(prepared, checked, rows, proposed, affected, risks, blockers,
                              retained, tuple(sorted(include)), fingerprint, len(protected_proven))
