from __future__ import annotations

from copy import deepcopy
import hashlib
import json

import pytest

import engine.receipt_review_models as review_models
from engine.receipt_layout_models import make_instance_id
from engine.receipt_review_models import (
    MAX_RECEIPT_REVIEW_MANIFEST_BYTES,
    ReceiptReviewError,
    build_receipt_record,
    validate_receipt_context,
    validate_receipt_edit,
    validate_receipt_originals,
    validate_receipt_record,
)
from engine.receipt_snapshot import processing_fingerprint


SHA_A = "a" * 64
SHA_B = "b" * 64
LAYOUT_SIGNATURE = "c" * 64
ANALYSIS_SIGNATURE = "d" * 64
ITEM_ID = "e" * 64
GEOMETRY = {
    "pdf_box": {"x0": 0, "y0": 0, "x1": 600, "y1": 900},
    "rotation": 0,
    "user_unit": 1,
    "width_pt": 600,
    "height_pt": 900,
}


def _options(mode: str = "search") -> dict[str, object]:
    return {
        "processing_mode": mode,
        "criteria": None if mode == "split_all" else {
            "include": ["手续费"],
            "includeMode": "all",
            "exclude": [],
        },
    }


def _context(*, source_path: str = "/documents/report.pdf", source_key: str = "/documents/report.pdf",
             sha: str = SHA_A, mode: str = "search") -> dict[str, object]:
    options = _options(mode)
    return {
        "version": 3,
        "sources": [{"source_key": source_key, "source_path": source_path, "source_sha256": sha}],
        "processing_options": options,
        "match_mode": "exact",
        "criteria_fingerprint": processing_fingerprint(options, "exact"),
        "computation_version": "receipt-engine-v3",
    }


def _original(*, source_key: str = "/documents/report.pdf", sha: str = SHA_A,
              slot_id: str = "slot-3", position_index: int = 3, item_id: str = ITEM_ID) -> dict[str, object]:
    layout = {"layout_id": "layout-report", "revision": 2, "slots": [{"slot_id": slot_id}]}
    instance_id = make_instance_id(sha, 1, layout, slot_id)
    candidate = {"x0": 0, "y0": 600, "x1": 600, "y1": 900}
    return {
        "id": item_id,
        "source_key": source_key,
        "source_page": 1,
        "instance_id": instance_id,
        "slot_id": slot_id,
        "position_index": position_index,
        "layout_id": "layout-report",
        "layout_revision": 2,
        "layout_signature": LAYOUT_SIGNATURE,
        "page_geometry": deepcopy(GEOMETRY),
        "candidate_rect": candidate,
        "occupancy": "occupied",
        "selection_basis": "keyword",
        "needs_review": False,
        "analysis_signature": ANALYSIS_SIGNATURE,
    }


def _edit(context_key: str, original: dict[str, object], *, mode: str = "candidate",
          final_rect: dict[str, object] | None = None, manual: bool = False,
          status: str = "confirmed", revision: int = 0) -> dict[str, object]:
    chosen_rect = None if mode == "full_page" else deepcopy(
        final_rect if final_rect is not None else original["candidate_rect"]
    )
    return {
        "schema_version": 1,
        "context_key": context_key,
        "result_revision": "run-1",
        "id": original["id"],
        "source_key": original["source_key"],
        "instance_id": original["instance_id"],
        "analysis_signature": original["analysis_signature"],
        "record_revision": revision,
        "final_rect": chosen_rect,
        "crop_mode": mode,
        "review_status": status,
        "manual_adjusted": manual,
        "reviewed_at": "2026-09-14T10:20:30.000Z",
    }


def test_context3_accepts_search_and_split_all_and_fingerprints_options() -> None:
    for mode in ("search", "split_all"):
        value = _context(mode=mode)
        descriptor, sha_by_key, context_key = validate_receipt_context(value)
        assert descriptor["version"] == 3
        assert descriptor["processing_options"] == _options(mode)
        assert descriptor["match_mode"] == "exact"
        assert descriptor["criteria_fingerprint"] == processing_fingerprint(_options(mode), "exact")
        assert sha_by_key == {"/documents/report.pdf": SHA_A}
        assert context_key == validate_receipt_context(deepcopy(value))[2]
        assert len(context_key) == 64


def test_context3_allows_same_sha_for_distinct_sources_and_trusted_relocation() -> None:
    options = _options()
    value = _context()
    value["sources"] = [
        {"source_key": "/documents/a.pdf", "source_path": "/documents/a.pdf", "source_sha256": SHA_A},
        {"source_key": "/documents/b.pdf", "source_path": "/documents/b.pdf", "source_sha256": SHA_A},
    ]
    descriptor, sha_by_key, context_key = validate_receipt_context(value)
    assert descriptor["sources"] == value["sources"]
    assert sha_by_key == {"/documents/a.pdf": SHA_A, "/documents/b.pdf": SHA_A}

    relocated = deepcopy(value)
    relocated["sources"][0]["source_path"] = "/relocated/a.pdf"  # type: ignore[index]
    with pytest.raises(ReceiptReviewError):
        validate_receipt_context(relocated)
    rebound, rebound_sha, rebound_key = validate_receipt_context(relocated, trusted_aliases=True)
    assert rebound["sources"][0]["source_path"] == "/relocated/a.pdf"  # type: ignore[index]
    assert rebound_sha == sha_by_key and rebound_key == context_key
    assert rebound["processing_options"] == options


def test_original_manifest_validates_third_position_and_same_sha_sources_without_match_data() -> None:
    context = _context()
    context["sources"] = [
        {"source_key": "/documents/a.pdf", "source_path": "/documents/a.pdf", "source_sha256": SHA_A},
        {"source_key": "/documents/b.pdf", "source_path": "/documents/b.pdf", "source_sha256": SHA_A},
    ]
    _, source_sha_by_key, _ = validate_receipt_context(context)
    originals = [_original(source_key="/documents/a.pdf"), _original(source_key="/documents/b.pdf", item_id="f" * 64)]
    before = deepcopy(originals)
    validated, manifest, digest = validate_receipt_originals(originals, source_sha_by_key)
    assert validated == originals and originals == before
    assert validated[0]["position_index"] == 3
    assert "evidence" not in validated[0] and "match_rect" not in validated[0]
    assert json.loads(manifest) == validated
    assert digest == hashlib.sha256(manifest.encode("utf-8")).hexdigest()
    validated[0]["candidate_rect"]["y0"] = 610  # type: ignore[index]
    assert originals[0]["candidate_rect"]["y0"] == 600  # type: ignore[index]


def test_original_manifest_rejects_duplicate_ids_logical_keys_and_immutable_mismatches() -> None:
    context = _context()
    _, source_sha_by_key, _ = validate_receipt_context(context)
    original = _original()
    for duplicate in ([_original(), deepcopy(original)],
                      [_original(), _original(item_id="f" * 64)]):
        if duplicate[1]["id"] == duplicate[0]["id"]:
            pass
        else:
            duplicate[1]["instance_id"] = duplicate[0]["instance_id"]
        with pytest.raises(ReceiptReviewError):
            validate_receipt_originals(duplicate, source_sha_by_key)

    bad_sha = deepcopy(original)
    bad_sha["instance_id"] = make_instance_id(SHA_B, 1, {"layout_id": "layout-report", "revision": 2,
                                                          "slots": [{"slot_id": "slot-3"}]}, "slot-3")
    with pytest.raises(ReceiptReviewError):
        validate_receipt_originals([bad_sha], source_sha_by_key)


def test_original_manifest_uses_an_independent_aggregate_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    context = _context()
    _, source_sha_by_key, _ = validate_receipt_context(context)
    first = _original()
    _, one_item_manifest, _ = validate_receipt_originals([first], source_sha_by_key)
    aggregate_limit = len(one_item_manifest) + 1
    assert aggregate_limit < MAX_RECEIPT_REVIEW_MANIFEST_BYTES
    monkeypatch.setattr(review_models, "MAX_RECEIPT_REVIEW_MANIFEST_BYTES", aggregate_limit)

    # Each item still fits the ordinary per-item budget; only the aggregate
    # manifest limit should reject the two-item collection.
    second = _original(item_id="f" * 64, position_index=4, slot_id="slot-4")
    validated, manifest, _ = validate_receipt_originals([first], source_sha_by_key)
    assert len(validated) == 1 and manifest == one_item_manifest
    with pytest.raises(ReceiptReviewError, match="aggregate JSON limit"):
        validate_receipt_originals([first, second], source_sha_by_key)


def test_edits_and_records_support_candidate_manual_and_full_page_modes() -> None:
    context = _context()
    _, source_sha_by_key, context_key = validate_receipt_context(context)
    original = _original()
    validate_receipt_originals([original], source_sha_by_key)

    candidate = validate_receipt_edit(_edit(context_key, original))
    manual_rect = {"x0": 12.0, "y0": 612.0, "x1": 588.0, "y1": 888.0}
    manual = validate_receipt_edit(_edit(context_key, original, mode="manual", final_rect=manual_rect, manual=True))
    full_page = validate_receipt_edit(_edit(context_key, original, mode="full_page", final_rect=None))
    assert candidate["manual_adjusted"] is False and manual["manual_adjusted"] is True
    assert full_page["final_rect"] is None and full_page["manual_adjusted"] is False

    for edit in (candidate, manual, full_page):
        record = build_receipt_record(original, edit, "/documents/report.pdf", SHA_A, 1)
        assert validate_receipt_record(record) == record
        assert record["original"] == original


def test_record_relocation_keeps_context_identity_and_source_binding() -> None:
    context = _context()
    _, source_sha_by_key, context_key = validate_receipt_context(context)
    original = _original()
    validate_receipt_originals([original], source_sha_by_key)
    edit = _edit(context_key, original)
    first = build_receipt_record(original, edit, "/documents/report.pdf", SHA_A, 1)
    relocated = build_receipt_record(original, edit, "/relocated/report.pdf", SHA_A, 2)
    assert first["context_key"] == relocated["context_key"] == context_key
    assert first["original"] == relocated["original"]
    assert relocated["source_path"] == "/relocated/report.pdf"
    assert validate_receipt_record(relocated) == relocated


def test_edit_revision_zero_is_valid_but_persisted_record_revision_must_be_positive() -> None:
    context = _context()
    _, source_sha_by_key, context_key = validate_receipt_context(context)
    original = _original()
    validate_receipt_originals([original], source_sha_by_key)
    edit = validate_receipt_edit(_edit(context_key, original, revision=0))
    assert edit["record_revision"] == 0
    with pytest.raises(ReceiptReviewError, match="positive integer"):
        build_receipt_record(original, edit, "/documents/report.pdf", SHA_A, 0)
    assert build_receipt_record(original, edit, "/documents/report.pdf", SHA_A, 1)["record_revision"] == 1


def test_manual_crop_requires_the_manual_adjusted_flag() -> None:
    context = _context()
    _, source_sha_by_key, context_key = validate_receipt_context(context)
    original = _original()
    validate_receipt_originals([original], source_sha_by_key)
    manual_rect = {"x0": 12.0, "y0": 612.0, "x1": 588.0, "y1": 888.0}
    unmarked = _edit(context_key, original, mode="manual", final_rect=manual_rect, manual=False)
    with pytest.raises(ReceiptReviewError, match="manually adjusted"):
        validate_receipt_edit(unmarked)


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(schema_version=2),
    lambda value: value.update(manual_adjusted=1),
    lambda value: value.update(final_rect={"x0": float("nan"), "y0": 0, "x1": 10, "y1": 10}),
    lambda value: value.update(crop_mode="group_confirmed"),
])
def test_edit_rejects_unknown_version_boolean_nan_and_status_or_mode(mutation) -> None:
    context = _context()
    _, _, context_key = validate_receipt_context(context)
    original = _original()
    value = _edit(context_key, original)
    mutation(value)
    with pytest.raises(ReceiptReviewError):
        validate_receipt_edit(value)


def test_source_map_errors_use_indexes_without_echoing_source_paths() -> None:
    context = _context()
    validate_receipt_context(context)
    original = _original()
    with pytest.raises(ReceiptReviewError) as caught:
        validate_receipt_originals([original], {"/private/secret/report.pdf": "not-a-sha"})
    message = str(caught.value)
    assert "source_sha_by_key[0]" in message
    assert "/private/secret/report.pdf" not in message


def test_build_rejects_out_of_page_or_outside_candidate_manual_rectangles() -> None:
    context = _context()
    _, source_sha_by_key, context_key = validate_receipt_context(context)
    original = _original()
    validate_receipt_originals([original], source_sha_by_key)

    outside_page = _edit(context_key, original, mode="manual",
                         final_rect={"x0": 1, "y0": 610, "x1": 601, "y1": 890}, manual=True)
    outside_candidate = _edit(context_key, original, mode="manual",
                              final_rect={"x0": 0, "y0": 590, "x1": 600, "y1": 890}, manual=True)
    for edit in (outside_page, outside_candidate):
        with pytest.raises(ReceiptReviewError):
            build_receipt_record(original, edit, "/documents/report.pdf", SHA_A, 1)


@pytest.mark.parametrize("field", ["id", "source_key", "instance_id", "analysis_signature"])
def test_build_rejects_immutable_edit_binding_conflicts(field: str) -> None:
    context = _context()
    _, source_sha_by_key, context_key = validate_receipt_context(context)
    original = _original()
    validate_receipt_originals([original], source_sha_by_key)
    edit = _edit(context_key, original)
    edit[field] = "f" * 64 if field != "source_key" else "/other.pdf"
    with pytest.raises(ReceiptReviewError):
        build_receipt_record(original, edit, "/documents/report.pdf", SHA_A, 1)


def test_record_contract_rejects_extra_or_missing_fields_and_deep_copies() -> None:
    context = _context()
    _, source_sha_by_key, context_key = validate_receipt_context(context)
    original = _original()
    validate_receipt_originals([original], source_sha_by_key)
    record = build_receipt_record(original, _edit(context_key, original), "/documents/report.pdf", SHA_A, 1)
    copied = validate_receipt_record(record)
    assert copied == record and copied is not record and copied["original"] is not record["original"]
    copied["original"]["candidate_rect"]["y0"] = 620  # type: ignore[index]
    assert record["original"]["candidate_rect"]["y0"] == 600  # type: ignore[index]
    for invalid in (dict(record, extra=True), {key: value for key, value in record.items() if key != "original"}):
        with pytest.raises(ReceiptReviewError):
            validate_receipt_record(invalid)
