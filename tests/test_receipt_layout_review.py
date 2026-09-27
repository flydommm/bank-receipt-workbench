"""Whole-layout preview on synthetic PDFs and isolated task/review stores."""
from copy import deepcopy
from hashlib import sha256

import pytest

from engine.batch_processor import BatchProcessor, BatchProgress
from engine.batch_review import prepare_batch_review, save_batch_receipt_review, read_batch_receipt_review_page
from engine.batch_store import BatchStore, BatchConflict
from engine.batch_pdf import BatchSourceError
from engine.computation import current_computation_version
from engine.receipt_layout_calibration import suggest_calibrated_layout, validate_complete_layout
from engine.receipt_layout_models import ReceiptLayoutError
from engine.receipt_layout_review import prepare_receipt_calibration, preview_receipt_calibration, _incompatibility, _target_layout
from tests.test_receipt_batch_pdf import make_source, SEARCH, ALL
from tests.test_batch_receipt_review_api import _make_edit


@pytest.fixture(autouse=True)
def private_temp(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))


def _pdf(tmp_path, name, title="上海银行业务回单", counts=(3, 1)):
    folder = tmp_path / name
    folder.mkdir()
    return make_source(folder, counts, title=title)


def _ready(store, paths, options=SEARCH):
    version = current_computation_version()
    job = store.create_receipt_job("synthetic", [{"source_path": str(path), "name": path.name} for path in paths], options, "exact", version)
    store.activate_supervisor("host")
    running = store.start_job(job["id"], job["generation"], "host", version)
    result = BatchProcessor(store, job["id"], running["generation"], "host", version, BatchProgress(lambda *_args: None)).run()
    assert result["state"] == "ready_for_review", result
    return result


def _prepared(store, ready, review, sample_index=0):
    prepare_batch_review(store, ready["id"], ready["result_revision"], review)
    original = store.review_snapshot(ready["id"], ready["result_revision"])["originals"][sample_index]
    return prepare_receipt_calibration(store, ready["id"], ready["result_revision"], original["id"], review)


def _draft(prepared):
    draft = deepcopy(prepared.layout)
    draft["revision"] += 1
    draft["uniform_height"] = True
    draft["slots"] = [{**slot, "top_pt": index * 300, "height_pt": 280} for index, slot in enumerate(draft["slots"])]
    return validate_complete_layout(draft)


def test_preparation_keeps_selected_position_and_groups_verified_cross_pdf_tail_pages(tmp_path):
    paths = [_pdf(tmp_path, "first"), _pdf(tmp_path, "second"), _pdf(tmp_path, "other", "中国民生银行业务回单")]
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, paths)
        prepared = _prepared(store, ready, tmp_path / "review.sqlite3", 1)
        view = prepared.view()
        assert len(view["preparation_fingerprint"]) == 64
        assert view["selected_slot_id"] == "slot-2"
        assert view["scope_kind"] == "verified_layout"
        assert view["source_count"] == 2
        assert view["page_count"] == 4
        assert view["excluded_page_counts"] == {"different_issuer": 2}
        assert len(view["layout_definition"]["slots"]) == 3
        view["layout_definition"]["slots"].clear()
        assert len(prepared.layout["slots"]) == 3


@pytest.mark.parametrize("options", [SEARCH, ALL], ids=["search", "split_all"])
def test_preview_expands_automatic_frame_and_recomputes_all_targets_without_saving(tmp_path, options):
    paths = [_pdf(tmp_path, "first"), _pdf(tmp_path, "second")]
    before_hashes = [sha256(path.read_bytes()).hexdigest() for path in paths]
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, paths, options)
        prepared = _prepared(store, ready, review)
        before_rows = store.read_page_results(ready["id"])
        progress = []
        preview = preview_receipt_calibration(store, prepared, _draft(prepared), review, progress=lambda a, b: progress.append((a, b)))
        assert preview.can_save, preview.blockers
        assert len(preview.affected) == 8
        assert len(preview.proposed["originals"]) == 8
        assert progress == [(1, 4), (2, 4), (3, 4), (4, 4)]
        assert preview.affected[0]["after_rect"]["y0"] == 0
        assert preview.affected[0]["before_rect"]["y0"] > 0
        assert preview.view()["saved"] is False
        assert store.read_page_results(ready["id"]) == before_rows
        restored = read_batch_receipt_review_page(store, ready["id"], ready["result_revision"], 0, 200, review)
        assert all(item["record"] is None for item in restored["items"])
        assert all(item["original"]["selection_basis"] == ("keyword" if options is SEARCH else "occupied_slot") for item in preview.proposed["items"])
    assert [sha256(path.read_bytes()).hexdigest() for path in paths] == before_hashes


def test_preview_does_not_reuse_old_hit_membership_when_boundary_moves(tmp_path):
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "source", counts=(3,))])
        prepared = _prepared(store, ready, review)
        draft = _draft(prepared)
        draft["uniform_height"] = False
        draft["slots"][0]["height_pt"] = 100
        preview = preview_receipt_calibration(store, prepared, draft, review)
        assert len(preview.proposed["originals"]) == 2
        assert any(item["status"] == "removed" and item["slot_id"] == "slot-1" for item in preview.affected)
        assert any(item.get("diagnostic", {}).get("code") == "unassigned_block" for item in preview.blockers)
        assert not preview.can_save


def test_new_content_outside_edited_slot_keeps_unedited_candidates_pending(tmp_path):
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "source", counts=(3,))], ALL)
        prepared = _prepared(store, ready, review)
        assert all(not original["needs_review"] for original in prepared.snapshot["originals"])
        draft = deepcopy(prepared.layout)
        draft["revision"] += 1
        draft["uniform_height"] = False
        # Moving the first boundary above its receipt text creates a genuine
        # page-wide risk, despite leaving the other two rectangles unchanged.
        draft["slots"][0]["height_pt"] = 100
        preview = preview_receipt_calibration(store, prepared, draft, review)
        assert {item["slot_id"] for item in preview.affected} == {"slot-1"}
        assert any(item["diagnostic"]["code"] == "content_outside_slots" for item in preview.risks)
        assert len(preview.proposed["originals"]) == 3
        assert all(original["needs_review"] for original in preview.proposed["originals"])


def test_whole_page_overlap_is_rejected_even_when_neighbor_did_not_match(tmp_path):
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "source")])
        prepared = _prepared(store, ready, review)
        draft = _draft(prepared)
        draft["uniform_height"] = False
        draft["slots"][0]["height_pt"] = 400
        with pytest.raises(ReceiptLayoutError):
            preview_receipt_calibration(store, prepared, draft, review)


def test_preview_rejects_changed_review_and_cancellation(tmp_path):
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "source")])
        prepared = _prepared(store, ready, review)
        with pytest.raises(BatchConflict, match="cancelled"):
            preview_receipt_calibration(store, prepared, _draft(prepared), review, cancelled=lambda: True)
        edit = _make_edit(prepared.context_key, ready["result_revision"], prepared.sample)
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [edit], review)
        with pytest.raises(BatchConflict, match="decisions changed"):
            preview_receipt_calibration(store, prepared, _draft(prepared), review)


def test_manual_exception_is_retained_and_only_explicitly_selected_override_is_applied(tmp_path):
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "source")])
        prepared = _prepared(store, ready, review)
        edit = _make_edit(prepared.context_key, ready["result_revision"], prepared.sample)
        edit.update(crop_mode="manual", manual_adjusted=True)
        candidate = prepared.sample["candidate_rect"]
        edit["final_rect"] = {"x0": candidate["x0"] + 5, "y0": candidate["y0"] + 5,
                              "x1": candidate["x1"] - 5, "y1": min(candidate["y1"] - 5, 250)}
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [edit], review)
        prepared = prepare_receipt_calibration(store, ready["id"], ready["result_revision"], prepared.sample["id"], review)
        preview = preview_receipt_calibration(store, prepared, _draft(prepared), review)
        assert preview.retained_record_ids == (prepared.sample["id"],)
        assert preview.affected[0]["status"] == "retained_manual"
        assert preview.affected[0]["after_rect"] == edit["final_rect"]
        overridden = preview_receipt_calibration(store, prepared, _draft(prepared), review, include_exception_ids=[prepared.sample["id"]])
        assert overridden.affected[0]["status"] == "updated"
        assert overridden.fingerprint != preview.fingerprint


def test_unverified_source_never_matches_another_pdf_by_filename_or_geometry(tmp_path):
    paths = [_pdf(tmp_path, "first", title="合成凭证"), _pdf(tmp_path, "second", title="合成凭证")]
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, paths)
        prepared = _prepared(store, ready, review)
        view = prepared.view()
        assert view["scope_kind"] == "current_pdf"
        assert view["source_count"] == 1
        assert "unverified_layout" in view["excluded_page_counts"]


def _unverified_layout():
    geometry = {"pdf_box": {"x0": 0, "y0": 0, "x1": 595, "y1": 900},
                "rotation": 0, "user_unit": 1, "width_pt": 595, "height_pt": 900}
    layout = suggest_calibrated_layout(geometry, 3)
    layout["uniform_height"] = False
    layout["slots"] = [
        {"slot_id": "slot-1", "position_index": 1, "top_pt": 0, "height_pt": 283.5},
        {"slot_id": "slot-2", "position_index": 2, "top_pt": 283.5, "height_pt": 287.5},
        {"slot_id": "slot-3", "position_index": 3, "top_pt": 571, "height_pt": 270},
    ]
    return validate_complete_layout(layout)


@pytest.mark.parametrize("bottom_difference", [-1, -0.5, 0, 0.2612915, 1])
def test_unverified_same_pdf_accepts_one_point_bottom_variation_and_preserves_untouched_slot(bottom_difference):
    sample = _unverified_layout()
    target = deepcopy(sample)
    target["layout_id"] = "layout-neighbor"
    target["slots"][2]["height_pt"] += bottom_difference
    assert _incompatibility(sample, target, same_source=True) is None

    draft = deepcopy(sample)
    draft["slots"][0]["height_pt"] -= 5
    adjusted = _target_layout(sample, draft, target, {"slot-1"}, 2)
    assert adjusted["slots"][0] == draft["slots"][0]
    assert adjusted["slots"][1:] == target["slots"][1:]
    assert adjusted["layout_id"] == target["layout_id"]


@pytest.mark.parametrize("boundary", ["top", "bottom", "left", "right"])
@pytest.mark.parametrize("difference,compatible", [(1, True), (1.001, False)])
def test_unverified_boundary_tolerance_is_at_most_one_point(boundary, difference, compatible):
    sample = _unverified_layout()
    target = deepcopy(sample)
    target["layout_id"] = "layout-neighbor"
    if boundary == "top":
        target["slots"][2]["top_pt"] += difference
        target["slots"][2]["height_pt"] -= difference
    elif boundary == "bottom":
        target["slots"][2]["height_pt"] += difference
    else:
        target[f"{boundary}_pt"] += difference
    assert (_incompatibility(sample, target, same_source=True) is None) is compatible


def test_unverified_tolerance_checks_bottom_edges_and_does_not_chain_neighbor_groups():
    sample = _unverified_layout()
    middle = deepcopy(sample)
    middle["layout_id"] = "layout-middle"
    middle["slots"][2]["height_pt"] += 1
    distant = deepcopy(middle)
    distant["layout_id"] = "layout-distant"
    distant["slots"][2]["height_pt"] += 1
    assert _incompatibility(sample, middle, same_source=True) is None
    assert _incompatibility(middle, distant, same_source=True) is None
    assert _incompatibility(sample, distant, same_source=True) is not None
    # Each individual top/height change is one point; the bottom moves two.
    middle["slots"][2]["top_pt"] += 1
    assert _incompatibility(sample, middle, same_source=True) is not None


@pytest.mark.parametrize("difference", ["source", "slot_count", "slot_id", "position", "size", "rotation", "evidence"])
def test_unverified_compatibility_keeps_source_structure_geometry_and_evidence_gates(difference):
    sample = _unverified_layout()
    target = deepcopy(sample)
    if difference == "slot_count":
        target["slots"].pop()
    elif difference == "slot_id":
        target["slots"][2]["slot_id"] = "other-slot"
    elif difference == "position":
        target["slots"][2]["position_index"] = 4
    elif difference == "size":
        target["page_geometry"]["height_pt"] += 1
        target["page_geometry"]["pdf_box"]["y1"] += 1
    elif difference == "rotation":
        target["page_geometry"]["rotation"] = 180
    elif difference == "evidence":
        target["evidence_version"] = "another-evidence-version"
    # A shared layout ID cannot override any of these gates.
    assert _incompatibility(sample, target, same_source=difference != "source") is not None


@pytest.mark.parametrize("identity", ["issuer_id", "family_id"])
def test_partial_known_identity_conflicts_are_rejected_before_unverified_geometry_fallback(identity):
    sample = _unverified_layout()
    sample[identity] = "a" * 64
    target = deepcopy(sample)
    target[identity] = "b" * 64
    assert _incompatibility(sample, target, same_source=True) is not None


def test_verified_layout_compatibility_retains_existing_geometry_policy():
    sample = _unverified_layout()
    sample.update(issuer_id="a" * 64, family_id="b" * 64)
    target = deepcopy(sample)
    target["layout_id"] = "layout-neighbor"
    target["slots"][2]["height_pt"] += 3
    assert _incompatibility(sample, target, same_source=False) is None
    target["family_id"] = "c" * 64
    assert _incompatibility(sample, target, same_source=False) == "different_layout_family"


def test_changed_source_is_rejected_before_any_calibration_write(tmp_path):
    review = tmp_path / "review.sqlite3"
    path = _pdf(tmp_path, "source")
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [path])
        prepared = _prepared(store, ready, review)
        before = store.read_page_results(ready["id"])
        path.write_bytes(path.read_bytes() + b"\n% changed synthetic test source\n")
        with pytest.raises(BatchSourceError):
            preview_receipt_calibration(store, prepared, _draft(prepared), review)
        assert store.read_page_results(ready["id"]) == before


def test_one_position_keeps_other_target_positions_and_prepare_binds_reviews(tmp_path):
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "source")])
        prepared = _prepared(store, ready, review)
        draft = deepcopy(prepared.layout)
        draft["slots"][0]["top_pt"] += 1
        other = deepcopy(prepared.layout)
        other["slots"][1]["top_pt"] += 1
        adjusted = _target_layout(prepared.layout, draft, other, {"slot-1"}, 2)
        assert adjusted["slots"][0] == draft["slots"][0]
        assert adjusted["slots"][1:] == other["slots"][1:]
        fingerprint = prepared.fingerprint
        edit = _make_edit(prepared.context_key, ready["result_revision"], prepared.sample)
        save_batch_receipt_review(store, ready["id"], ready["result_revision"], [edit], review)
        next_prepared = prepare_receipt_calibration(store, ready["id"], ready["result_revision"], prepared.sample["id"], review)
        assert next_prepared.fingerprint != fingerprint
