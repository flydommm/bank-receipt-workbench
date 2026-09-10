from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3

import pytest

from engine.db import Database
from engine.layout import Rect
from engine.review_store import ReviewStore
from engine.review_store_v2 import ReviewRevisionConflict, ReviewStoreError, ReviewStoreV2


SHA_A = "a" * 64
SHA_B = "b" * 64
FINGERPRINT_A = "1" * 64
FINGERPRINT_B = "2" * 64


def _rect(x0: float = 10, y0: float = 20, x1: float = 30, y1: float = 40) -> dict[str, float]:
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


def _source(path: str, sha256: str = SHA_A) -> dict[str, str]:
    return {"source_key": path, "source_path": path, "source_sha256": sha256}


def _context(
    *,
    sources: list[dict[str, str]] | None = None,
    criteria_fingerprint: str = FINGERPRINT_A,
    computation_version: str = "engine-schema-v2",
) -> dict[str, object]:
    return {
        "version": 2,
        "sources": sources or [_source("/docs/report.pdf")],
        "criteria_fingerprint": criteria_fingerprint,
        "computation_version": computation_version,
    }


def _original(
    *,
    id: str = "segment-1",
    source_key: str = "/docs/report.pdf",
    source_page: int = 1,
    segment_no: int = 1,
    analysis_signature: str = FINGERPRINT_A,
    persistable: bool = True,
    page_width: float = 600,
    page_height: float = 800,
    match_rect: dict[str, float] | None = ...,
    candidate_rect: dict[str, float] | None = ...,
    layout_fingerprint: str = "geometry:report-v1",
    confidence: float = 0.96,
    auto_full_page: bool = False,
) -> dict[str, object]:
    return {
        "id": id,
        "source_key": source_key,
        "source_page": source_page,
        "segment_no": segment_no,
        "analysis_signature": analysis_signature,
        "persistable": persistable,
        "page_width": page_width,
        "page_height": page_height,
        "match_rect": _rect() if match_rect is ... else match_rect,
        "candidate_rect": _rect(0, 0, 600, 250) if candidate_rect is ... else candidate_rect,
        "layout_fingerprint": layout_fingerprint,
        "confidence": confidence,
        "auto_full_page": auto_full_page,
    }


def _sha_for(context: dict[str, object], source_key: str) -> str:
    for source in context["sources"]:  # type: ignore[index]
        if source["source_key"].strip().replace("\\", "/").lower() == source_key.lower():
            return source["source_sha256"]
    raise AssertionError(f"missing source {source_key}")


def _segment(
    context: dict[str, object],
    original: dict[str, object],
    *,
    context_key: str,
    result_revision: str,
    record_revision: int = 0,
    task_id: str = "task-1",
    final_rect: dict[str, float] | None = None,
    crop_mode: str = "manual",
    review_status: str = "confirmed",
    manual_adjusted: bool = True,
    reviewed_at: str = "2026-09-08T06:20:00.000Z",
) -> dict[str, object]:
    source_key = original["source_key"]
    return {
        "id": original["id"],
        "task_id": task_id,
        "source_path": source_key,
        "source_sha256": _sha_for(context, source_key),
        "source_page": original["source_page"],
        "segment_no": original["segment_no"],
        "match_rect": original["match_rect"],
        "candidate_rect": original["candidate_rect"],
        "final_rect": final_rect if final_rect is not None else _rect(0, 2, 600, 248),
        "layout_fingerprint": original["layout_fingerprint"],
        "confidence": original["confidence"],
        "crop_mode": crop_mode,
        "review_status": review_status,
        "manual_adjusted": manual_adjusted,
        "reviewed_at": reviewed_at,
        "context_key": context_key,
        "source_key": source_key,
        "analysis_signature": original["analysis_signature"],
        "result_revision": result_revision,
        "record_revision": record_revision,
        "page_width": original["page_width"],
        "page_height": original["page_height"],
    }


def _prepare_one(
    store: ReviewStoreV2,
    context: dict[str, object] | None = None,
    original: dict[str, object] | None = None,
    *,
    result_revision: str = "run-1",
) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    actual_context = context or _context()
    actual_original = original or _original()
    prepared = store.prepare(actual_context, [actual_original], result_revision=result_revision)
    return prepared, actual_context, actual_original


def test_same_sha_different_paths_save_and_load_independently(tmp_path: Path) -> None:
    context = _context(sources=[_source("/in/a/report.pdf"), _source("/out/b/report.pdf")])
    originals = [
        _original(id="a-1", source_key="/in/a/report.pdf"),
        _original(id="b-1", source_key="/out/b/report.pdf", analysis_signature=FINGERPRINT_B),
    ]

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, originals, result_revision="run-1")
        assert prepared["segments"] == []
        assert all(item["record_revision"] == 0 for item in prepared["record_revisions"])

        first = _segment(context, originals[0], context_key=prepared["context_key"], result_revision="run-1", final_rect=_rect(0, 0, 600, 200))
        second = _segment(context, originals[1], context_key=prepared["context_key"], result_revision="run-1", final_rect=_rect(0, 300, 600, 500))
        assert store.save(prepared["context_key"], "run-1", [first], confirm_group=False)["saved_count"] == 1
        assert store.save(prepared["context_key"], "run-1", [second], confirm_group=False)["saved_count"] == 1

        next_prepared = store.prepare(context, originals, result_revision="run-2")
        loaded = next_prepared["segments"]
        assert [record["source_key"] for record in loaded] == ["/in/a/report.pdf", "/out/b/report.pdf"]
        assert [record["final_rect"] for record in loaded] == [_rect(0, 0, 600, 200), _rect(0, 300, 600, 500)]
        assert all(record["result_revision"] == "run-2" for record in loaded)
        assert all(record["record_revision"] == 1 for record in loaded)


def test_public_record_can_save_when_manifest_has_auto_full_page_without_exposing_flags(tmp_path: Path) -> None:
    context = _context()
    original = _original(auto_full_page=True)

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, [original], result_revision="run-1")
        record = _segment(context, original, context_key=prepared["context_key"], result_revision="run-1")
        record.pop("persistable", None)
        record.pop("auto_full_page", None)
        saved = store.save(prepared["context_key"], "run-1", [record], confirm_group=False)
        assert "persistable" not in saved["segments"][0]
        assert "auto_full_page" not in saved["segments"][0]
        assert store.prepare(context, [original], result_revision="run-2")["segments"][0]["id"] == "segment-1"


def test_access_path_spelling_is_preserved_while_context_identity_is_normalized(tmp_path: Path) -> None:
    context = _context(sources=[_source("d:/docs/report.pdf")])
    context["sources"][0]["source_path"] = "D:\\Docs\\Report.PDF"  # type: ignore[index]
    original = _original(source_key="d:/docs/report.pdf")

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, [original], result_revision="run-1")
        record = _segment(context, original, context_key=prepared["context_key"], result_revision="run-1")
        record["source_path"] = "D:\\Docs\\Report.PDF"
        saved = store.save(prepared["context_key"], "run-1", [record], confirm_group=False)
        assert saved["segments"][0]["source_path"] == "D:\\Docs\\Report.PDF"
        rebound = store.prepare(context, [original], result_revision="run-2")
        assert rebound["segments"][0]["source_path"] == "D:\\Docs\\Report.PDF"


def test_public_prepare_rejects_a_source_access_alias(tmp_path: Path) -> None:
    context = _context()
    context["sources"][0]["source_path"] = "/relocated/report.pdf"  # type: ignore[index]

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        with pytest.raises(ReviewStoreError):
            store.prepare(context, [_original()], result_revision="run-1")


def test_batch_prepare_rebinds_verified_alias_and_save_uses_current_descriptor_path(tmp_path: Path) -> None:
    context = _context()
    original = _original()
    relocated = deepcopy(context)
    relocated["sources"][0]["source_path"] = "/relocated/report.pdf"  # type: ignore[index]

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare_batch(context, [original], result_revision="run-1")
        record = _segment(
            context,
            original,
            context_key=prepared["context_key"],
            result_revision="run-1",
            final_rect=_rect(0, 0, 600, 200),
            review_status="confirmed",
            manual_adjusted=True,
        )
        saved = store.save(prepared["context_key"], "run-1", [record], confirm_group=False)

        rebound = store.prepare_batch(relocated, [original], result_revision="run-2")
        assert rebound["context_key"] == prepared["context_key"]
        assert rebound["segments"][0]["source_path"] == "/relocated/report.pdf"
        assert rebound["segments"][0]["final_rect"] == _rect(0, 0, 600, 200)
        assert rebound["segments"][0]["review_status"] == "confirmed"
        assert rebound["segments"][0]["manual_adjusted"] is True
        assert rebound["segments"][0]["record_revision"] == saved["segments"][0]["record_revision"]
        stored_path = store.connection.execute(
            "SELECT source_path FROM review_segments_v2 WHERE context_key = ?",
            (prepared["context_key"],),
        ).fetchone()[0]
        assert stored_path == "/relocated/report.pdf"

        current = deepcopy(rebound["segments"][0])
        assert store.save(rebound["context_key"], "run-2", [current], confirm_group=False)["saved_count"] == 1
        for bad_path in ("/docs/report.pdf", "/attacker/report.pdf"):
            forged = deepcopy(current)
            forged["source_path"] = bad_path
            forged["record_revision"] = current["record_revision"] + 1
            with pytest.raises(ReviewStoreError):
                store.save(rebound["context_key"], "run-2", [forged], confirm_group=False)

        forged_sha = deepcopy(current)
        forged_sha["source_sha256"] = SHA_B
        forged_sha["record_revision"] = current["record_revision"] + 1
        with pytest.raises(ReviewStoreError):
            store.save(rebound["context_key"], "run-2", [forged_sha], confirm_group=False)

        store.connection.execute(
            "UPDATE review_segments_v2 SET source_path = ? WHERE context_key = ?",
            ("/attacker/stored.pdf", rebound["context_key"]),
        )
        store.connection.commit()
        tampered_row = deepcopy(current)
        tampered_row["record_revision"] = current["record_revision"] + 1
        with pytest.raises(ReviewStoreError):
            store.save(rebound["context_key"], "run-2", [tampered_row], confirm_group=False)
        with pytest.raises(ReviewStoreError):
            store.prepare_batch(relocated, [original], result_revision="run-3")


def test_batch_prepare_rebinds_path_before_analysis_match_and_allows_new_manifest_save(tmp_path: Path) -> None:
    context = _context()
    original = _original()
    relocated = deepcopy(context)
    relocated["sources"][0]["source_path"] = "/relocated/report.pdf"  # type: ignore[index]
    changed = _original(id="new-id", analysis_signature=FINGERPRINT_B)

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare_batch(context, [original], result_revision="run-1")
        first = _segment(context, original, context_key=prepared["context_key"], result_revision="run-1")
        store.save(prepared["context_key"], "run-1", [first], confirm_group=False)

        rebound = store.prepare_batch(relocated, [changed], result_revision="run-2")
        assert rebound["segments"] == []
        assert rebound["record_revisions"] == [{
            "id": "new-id",
            "source_key": "/docs/report.pdf",
            "source_page": 1,
            "segment_no": 1,
            "record_revision": 1,
            "task_id": "task-1",
        }]
        assert store.connection.execute(
            "SELECT source_path FROM review_segments_v2 WHERE context_key = ?",
            (prepared["context_key"],),
        ).fetchone()[0] == "/relocated/report.pdf"

        replacement = _segment(
            relocated,
            changed,
            context_key=rebound["context_key"],
            result_revision="run-2",
        )
        replacement["source_path"] = "/relocated/report.pdf"
        replacement["record_revision"] = 1
        assert store.save(rebound["context_key"], "run-2", [replacement], confirm_group=False)["saved_count"] == 1
        restored = store.prepare_batch(relocated, [changed], result_revision="run-3")
        assert restored["segments"][0]["id"] == "new-id"
        assert restored["segments"][0]["source_path"] == "/relocated/report.pdf"
        assert restored["segments"][0]["record_revision"] == 2


def test_batch_prepare_rebinds_historical_row_omitted_from_manifest(tmp_path: Path) -> None:
    context = _context()
    original = _original()
    relocated = deepcopy(context)
    relocated["sources"][0]["source_path"] = "/relocated/report.pdf"  # type: ignore[index]

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare_batch(context, [original], result_revision="run-1")
        record = _segment(context, original, context_key=prepared["context_key"], result_revision="run-1")
        store.save(prepared["context_key"], "run-1", [record], confirm_group=False)

        omitted = store.prepare_batch(relocated, [], result_revision="run-2")
        assert omitted["segments"] == []
        row = store.connection.execute(
            "SELECT source_path, record_revision FROM review_segments_v2 WHERE context_key = ?",
            (prepared["context_key"],),
        ).fetchone()
        assert row["source_path"] == "/relocated/report.pdf" and row["record_revision"] == 1
        restored = store.prepare_batch(relocated, [original], result_revision="run-3")
        assert restored["segments"][0]["source_path"] == "/relocated/report.pdf"
        assert restored["segments"][0]["record_revision"] == 1


def test_same_logical_record_with_new_analysis_id_rebinds_without_incrementing_revision(tmp_path: Path) -> None:
    context = _context()
    first = _original(id="old-id")
    second = _original(id="new-id")

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, [first], result_revision="run-1")
        record = _segment(context, first, context_key=prepared["context_key"], result_revision="run-1")
        store.save(prepared["context_key"], "run-1", [record], confirm_group=False)
        rebound = store.prepare(context, [second], result_revision="run-2")
        assert rebound["segments"][0]["id"] == "new-id"
        assert rebound["record_revisions"][0]["record_revision"] == 1


def test_rebinding_two_ids_in_one_new_manifest_does_not_depend_on_id_uniqueness(tmp_path: Path) -> None:
    context = _context(sources=[_source("/docs/a.pdf"), _source("/docs/b.pdf", SHA_B)])
    first = [
        _original(id="one", source_key="/docs/a.pdf"),
        _original(id="two", source_key="/docs/b.pdf", analysis_signature=FINGERPRINT_B, segment_no=2),
    ]
    second = [
        _original(id="two", source_key="/docs/a.pdf"),
        _original(id="one", source_key="/docs/b.pdf", analysis_signature=FINGERPRINT_B, segment_no=2),
    ]

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, first, result_revision="run-1")
        records = [_segment(context, item, context_key=prepared["context_key"], result_revision="run-1") for item in first]
        store.save(prepared["context_key"], "run-1", records, confirm_group=False)
        rebound = store.prepare(context, second, result_revision="run-2")
        assert [item["id"] for item in rebound["segments"]] == ["two", "one"]
        assert [item["record_revision"] for item in rebound["record_revisions"]] == [1, 1]


def test_context_key_is_stable_for_path_spelling_but_changes_for_order_inputs_and_algorithm() -> None:
    first = _context(sources=[_source("  D:\\Docs\\A.PDF  ", SHA_A), _source("D:/Docs/B.PDF", SHA_B)])
    spelling = _context(sources=[_source("d:/docs/a.pdf", SHA_A), _source("d:/docs/b.pdf", SHA_B)])
    reversed_sources = _context(sources=list(reversed(first["sources"])))  # type: ignore[arg-type]
    changed_criteria = _context(sources=first["sources"], criteria_fingerprint=FINGERPRINT_B)  # type: ignore[arg-type]
    changed_algorithm = _context(sources=first["sources"], computation_version="engine-schema-v3")  # type: ignore[arg-type]
    changed_sha = _context(sources=[_source("d:/docs/a.pdf", SHA_B), _source("d:/docs/b.pdf", SHA_B)])

    with ReviewStoreV2(":memory:") as store:
        keys = [store.context_key(value) for value in (first, spelling, reversed_sources, changed_criteria, changed_algorithm, changed_sha)]

    assert keys[0] == keys[1]
    assert len(set(keys)) == 5
    expected_payload = {
        "version": 2,
        "sources": [
            {"source_key": "d:/docs/a.pdf", "source_sha256": SHA_A},
            {"source_key": "d:/docs/b.pdf", "source_sha256": SHA_B},
        ],
        "criteria_fingerprint": FINGERPRINT_A,
        "computation_version": "engine-schema-v2",
    }
    expected_json = json.dumps(expected_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    assert keys[0] == hashlib.sha256(expected_json.encode("utf-8")).hexdigest()


def test_old_review_table_remains_readable_and_is_not_copied(tmp_path: Path) -> None:
    database = tmp_path / "review.sqlite3"
    legacy = ReviewStore(database)
    from engine.review_store import ReviewSegmentRecord

    legacy.upsert(
        ReviewSegmentRecord(
            id="legacy-1",
            task_id="task-1",
            source_path="/docs/report.pdf",
            source_sha256=SHA_A,
            source_page=1,
            segment_no=1,
            match_rect=Rect(10, 20, 30, 40),
            candidate_rect=Rect(0, 0, 600, 250),
            final_rect=Rect(0, 2, 600, 248),
            layout_fingerprint="geometry:report-v1",
            confidence=0.96,
            crop_mode="manual",
            review_status="group_confirmed",
            manual_adjusted=True,
            reviewed_at="2026-09-08T06:20:00.000Z",
        )
    )
    legacy.close()

    context = _context()
    originals = [_original()]
    with ReviewStoreV2(database) as store:
        prepared = store.prepare(context, originals, result_revision="run-1")
        assert prepared["segments"] == []
        assert prepared["record_revisions"][0]["record_revision"] == 0

    with ReviewStore(database) as old_store:
        assert len(old_store.list_for_task("task-1")) == 1


def test_group_confirmation_requires_complete_eligible_manifest_and_is_restored(tmp_path: Path) -> None:
    context = _context(sources=[_source("/docs/a.pdf"), _source("/docs/b.pdf", SHA_B)])
    originals = [_original(id="a", source_key="/docs/a.pdf"), _original(id="b", source_key="/docs/b.pdf", analysis_signature=FINGERPRINT_B, segment_no=2)]

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, originals, result_revision="run-1")
        records = [
            _segment(context, original, context_key=prepared["context_key"], result_revision="run-1")
            for original in originals
        ]
        records = [dict(record, review_status="group_confirmed") for record in records]
        saved = store.save(prepared["context_key"], "run-1", records, confirm_group=True)
        assert saved["saved_count"] == 2
        assert all(item["review_status"] == "group_confirmed" for item in saved["segments"])
        group_rows = store.connection.execute(
            "SELECT group_operation_id, group_scope_digest FROM review_segments_v2 ORDER BY source_key"
        ).fetchall()
        assert len({row["group_operation_id"] for row in group_rows}) == 1
        assert len({row["group_scope_digest"] for row in group_rows}) == 1

        restored = store.prepare(context, originals, result_revision="run-2")
        assert restored["group_confirmed"] is True
        assert len(restored["segments"]) == 2

        incomplete = [records[0]]
        with pytest.raises(ReviewStoreError):
            store.save(prepared["context_key"], "run-1", incomplete, confirm_group=True)
        assert store.prepare(context, originals, result_revision="run-3")["group_confirmed"] is True


def test_mixed_group_marker_cannot_become_confirmed_by_repeated_prepare(tmp_path: Path) -> None:
    context = _context(sources=[_source("/docs/a.pdf"), _source("/docs/b.pdf", SHA_B)])
    originals = [_original(id="a", source_key="/docs/a.pdf"), _original(id="b", source_key="/docs/b.pdf", analysis_signature=FINGERPRINT_B, segment_no=2)]

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, originals, result_revision="run-1")
        records = [
            _segment(context, item, context_key=prepared["context_key"], result_revision="run-1", review_status="group_confirmed")
            for item in originals
        ]
        store.save(prepared["context_key"], "run-1", records, confirm_group=True)
        store.connection.execute(
            "UPDATE review_segments_v2 SET group_operation_id = ? WHERE source_key = ?",
            ("different-operation", "/docs/b.pdf"),
        )
        store.connection.commit()

        assert store.prepare(context, originals, result_revision="run-2")["group_confirmed"] is False
        assert store.prepare(context, originals, result_revision="run-3")["group_confirmed"] is False


def test_ordinary_save_clears_group_marker_for_the_changed_row(tmp_path: Path) -> None:
    context = _context(sources=[_source("/docs/a.pdf"), _source("/docs/b.pdf", SHA_B)])
    originals = [_original(id="a", source_key="/docs/a.pdf"), _original(id="b", source_key="/docs/b.pdf", analysis_signature=FINGERPRINT_B, segment_no=2)]

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, originals, result_revision="run-1")
        records = [
            _segment(context, item, context_key=prepared["context_key"], result_revision="run-1", review_status="group_confirmed")
            for item in originals
        ]
        saved = store.save(prepared["context_key"], "run-1", records, confirm_group=True)
        changed = dict(saved["segments"][0], review_status="pending", record_revision=saved["segments"][0]["record_revision"])
        store.save(prepared["context_key"], "run-1", [changed], confirm_group=False)

        group_rows = store.connection.execute(
            "SELECT review_status, group_operation_id, group_scope_digest FROM review_segments_v2 ORDER BY source_key"
        ).fetchall()
        assert group_rows[0]["review_status"] == "pending"
        assert group_rows[0]["group_operation_id"] is None
        assert group_rows[0]["group_scope_digest"] is None
        assert store.prepare(context, originals, result_revision="run-2")["group_confirmed"] is False


def test_save_uses_record_revision_cas_and_rolls_back_mixed_batch(tmp_path: Path) -> None:
    context = _context(sources=[_source("/docs/a.pdf"), _source("/docs/b.pdf", SHA_B)])
    originals = [_original(id="a", source_key="/docs/a.pdf"), _original(id="b", source_key="/docs/b.pdf", analysis_signature=FINGERPRINT_B, segment_no=2)]

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, originals, result_revision="run-1")
        records = [_segment(context, item, context_key=prepared["context_key"], result_revision="run-1") for item in originals]
        first_save = store.save(prepared["context_key"], "run-1", records, confirm_group=False)
        current = {item["id"]: item for item in first_save["segments"]}

        stale = deepcopy(current["a"])
        stale["record_revision"] = 1
        stale["final_rect"] = _rect(0, 4, 600, 244)
        fresh = deepcopy(current["b"])
        fresh["record_revision"] = 1
        fresh["final_rect"] = _rect(0, 8, 600, 240)
        store.save(prepared["context_key"], "run-1", [stale], confirm_group=False)

        with pytest.raises(ReviewRevisionConflict):
            store.save(prepared["context_key"], "run-1", [deepcopy(current["a"]), fresh], confirm_group=False)

        after = store.prepare(context, originals, result_revision="run-2")["segments"]
        assert {item["id"]: item["final_rect"] for item in after} == {
            "a": _rect(0, 4, 600, 244),
            "b": _rect(0, 2, 600, 248),
        }


def test_changed_analysis_signature_returns_actual_revision_and_allows_explicit_overwrite(tmp_path: Path) -> None:
    database = tmp_path / "review.sqlite3"
    context = _context()
    original = _original()
    changed = _original(analysis_signature=FINGERPRINT_B, candidate_rect=_rect(0, 0, 600, 300))

    with ReviewStoreV2(database) as store:
        prepared = store.prepare(context, [original], result_revision="run-1")
        first = _segment(context, original, context_key=prepared["context_key"], result_revision="run-1")
        saved = store.save(prepared["context_key"], "run-1", [first], confirm_group=False)
        assert saved["segments"][0]["record_revision"] == 1

        changed_prepared = store.prepare(context, [changed], result_revision="run-2")
        assert changed_prepared["segments"] == []
        assert changed_prepared["record_revisions"][0]["record_revision"] == 1
        replacement = _segment(
            context,
            changed,
            context_key=changed_prepared["context_key"],
            result_revision="run-2",
            record_revision=1,
        )
        replacement["candidate_rect"] = changed["candidate_rect"]
        replacement["final_rect"] = _rect(0, 0, 600, 300)
        replaced = store.save(changed_prepared["context_key"], "run-2", [replacement], confirm_group=False)
        assert replaced["segments"][0]["record_revision"] == 2


def test_prepare_reports_existing_record_task_id_when_context_is_reused_by_another_batch(
    tmp_path: Path,
) -> None:
    context = _context()
    original = _original()

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        first = store.prepare_batch(context, [original], result_revision="run-1", job_id="task-a")
        record = _segment(
            context,
            original,
            context_key=first["context_key"],
            result_revision="run-1",
            task_id="task-a",
        )
        store.save(first["context_key"], "run-1", [record], confirm_group=False)

        reused = store.prepare_batch(context, [original], result_revision="run-2", job_id="task-b")
        assert reused["segments"][0]["task_id"] == "task-a"
        assert reused["record_revisions"] == [{
            "id": original["id"],
            "source_key": original["source_key"],
            "source_page": original["source_page"],
            "segment_no": original["segment_no"],
            "record_revision": 1,
            "task_id": "task-a",
        }]

        changed = _original(analysis_signature=FINGERPRINT_B, candidate_rect=_rect(0, 0, 600, 300))
        incompatible = store.prepare_batch(
            context,
            [changed],
            result_revision="run-3",
            job_id="task-b",
        )
        assert incompatible["segments"] == []
        assert incompatible["record_revisions"][0]["record_revision"] == 1
        assert incompatible["record_revisions"][0]["task_id"] == "task-a"


def test_stale_result_revision_is_rejected_even_with_current_record_revision(tmp_path: Path) -> None:
    context = _context()
    original = _original()

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, [original], result_revision="run-1")
        record = _segment(context, original, context_key=prepared["context_key"], result_revision="run-1")
        saved = store.save(prepared["context_key"], "run-1", [record], confirm_group=False)
        stale = deepcopy(saved["segments"][0])
        stale["result_revision"] = "run-1"
        stale["record_revision"] = 1
        stale["final_rect"] = _rect(0, 5, 600, 245)
        store.prepare(context, [original], result_revision="run-2")

        with pytest.raises(ReviewStoreError):
            store.save(prepared["context_key"], "run-1", [stale], confirm_group=False)


def test_save_requires_a_boolean_confirmation_flag_and_rejects_empty_group(tmp_path: Path) -> None:
    context = _context()
    original = _original()

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, [original], result_revision="run-1")
        record = _segment(context, original, context_key=prepared["context_key"], result_revision="run-1")
        with pytest.raises(ReviewStoreError):
            store.save(prepared["context_key"], "run-1", [record], confirm_group=1)  # type: ignore[arg-type]

    with ReviewStoreV2(tmp_path / "empty.sqlite3") as store:
        empty_context = _context(sources=[_source("/docs/empty.pdf")])
        prepared = store.prepare(empty_context, [], result_revision="run-1")
        with pytest.raises(ReviewStoreError):
            store.save(
                prepared["context_key"],
                "run-1",
                [],
                confirm_group=True,
            )


def test_blocked_status_does_not_make_valid_item_unpersistable(tmp_path: Path) -> None:
    context = _context()
    original = _original()

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, [original], result_revision="run-1")
        blocked = _segment(
            context,
            original,
            context_key=prepared["context_key"],
            result_revision="run-1",
            review_status="blocked",
        )
        saved = store.save(prepared["context_key"], "run-1", [blocked], confirm_group=False)
        assert saved["segments"][0]["review_status"] == "blocked"


def test_non_persistable_item_is_kept_in_manifest_but_cannot_be_saved_or_confirmed(tmp_path: Path) -> None:
    context = _context()
    original = _original(persistable=False, source_page=0, page_width=0, page_height=0, match_rect=None)

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, [original], result_revision="run-1")
        assert prepared["record_revisions"] == [
            {"id": "segment-1", "source_key": "/docs/report.pdf", "source_page": 0, "segment_no": 1, "record_revision": 0, "task_id": None}
        ]
        assert prepared["segments"] == []
        blocked = _segment(
            context,
            original,
            context_key=prepared["context_key"],
            result_revision="run-1",
            review_status="blocked",
        )
        blocked["source_page"] = 0
        blocked["match_rect"] = None
        with pytest.raises(ReviewStoreError):
            store.save(prepared["context_key"], "run-1", [blocked], confirm_group=False)
        with pytest.raises(ReviewStoreError):
            store.save(prepared["context_key"], "run-1", [blocked], confirm_group=True)


def test_non_persistable_finite_negative_or_reversed_rectangles_are_retained_but_never_saved(tmp_path: Path) -> None:
    context = _context()
    original = _original(
        persistable=False,
        source_page=0,
        page_width=0,
        page_height=0,
        match_rect={"x0": 30, "y0": 40, "x1": 20, "y1": -2},
        candidate_rect={"x0": -1, "y0": 5, "x1": -3, "y1": 4},
    )

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, [original], result_revision="run-1")
        assert prepared["segments"] == []
        assert prepared["record_revisions"][0]["record_revision"] == 0

        malformed = _segment(
            context,
            original,
            context_key=prepared["context_key"],
            result_revision="run-1",
        )
        malformed["source_page"] = 0
        malformed["page_width"] = 0
        malformed["page_height"] = 0
        malformed["match_rect"] = original["match_rect"]
        malformed["candidate_rect"] = original["candidate_rect"]
        with pytest.raises(ReviewStoreError):
            store.save(prepared["context_key"], "run-1", [malformed], confirm_group=False)
        assert store.connection.execute(
            "SELECT COUNT(*) FROM review_segments_v2 WHERE context_key = ?",
            (prepared["context_key"],),
        ).fetchone()[0] == 0


def test_public_record_cannot_save_a_non_persistable_manifest_item_even_when_geometry_is_valid(tmp_path: Path) -> None:
    context = _context()
    original = _original(persistable=False, source_page=1, page_width=600, page_height=800)

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, [original], result_revision="run-1")
        record = _segment(context, original, context_key=prepared["context_key"], result_revision="run-1")
        record.pop("persistable", None)
        record.pop("auto_full_page", None)
        with pytest.raises(ReviewStoreError):
            store.save(prepared["context_key"], "run-1", [record], confirm_group=False)


@pytest.mark.parametrize(
    "mutator",
    [
        lambda item: item.update(source_page=True),
        lambda item: item.update(confidence=float("nan")),
        lambda item: item.update(match_rect={"x0": 0, "y0": 0, "x1": float("inf"), "y1": 10}),
        lambda item: item.update(analysis_signature="not-a-sha"),
    ],
)
def test_prepare_rejects_malformed_manifest_input(tmp_path: Path, mutator) -> None:
    original = _original()
    mutator(original)

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        with pytest.raises(ReviewStoreError):
            store.prepare(_context(), [original], result_revision="run-1")


def test_prepare_rejects_duplicate_ids_and_logical_keys(tmp_path: Path) -> None:
    context = _context(sources=[_source("/docs/a.pdf"), _source("/docs/b.pdf", SHA_B)])
    duplicate_id = [_original(id="same", source_key="/docs/a.pdf"), _original(id="same", source_key="/docs/b.pdf", segment_no=2)]
    duplicate_key = [_original(id="a", source_key="/docs/a.pdf"), _original(id="b", source_key="/docs/a.pdf")]

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        with pytest.raises(ReviewStoreError):
            store.prepare(context, duplicate_id, result_revision="run-1")
        with pytest.raises(ReviewStoreError):
            store.prepare(context, duplicate_key, result_revision="run-1")


def test_corrupt_stored_payload_fails_closed_in_prepare(tmp_path: Path) -> None:
    context = _context()
    original = _original()

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, [original], result_revision="run-1")
        record = _segment(context, original, context_key=prepared["context_key"], result_revision="run-1")
        store.save(prepared["context_key"], "run-1", [record], confirm_group=False)
        store.connection.execute(
            "UPDATE review_segments_v2 SET final_x1 = NULL WHERE context_key = ?",
            (prepared["context_key"],),
        )
        store.connection.commit()

        with pytest.raises(ReviewStoreError):
            store.prepare(context, [original], result_revision="run-2")


@pytest.mark.parametrize("column, value", [("criteria_fingerprint", "f" * 64), ("manifest_digest", "e" * 64)])
def test_corrupt_context_payload_fails_closed_in_prepare_and_save(
    tmp_path: Path,
    column: str,
    value: str,
) -> None:
    context = _context()
    original = _original()

    with ReviewStoreV2(tmp_path / "review.sqlite3") as store:
        prepared = store.prepare(context, [original], result_revision="run-1")
        record = _segment(context, original, context_key=prepared["context_key"], result_revision="run-1")
        store.connection.execute(f"UPDATE review_contexts_v2 SET {column} = ?", (value,))
        store.connection.commit()
        with pytest.raises(ReviewStoreError):
            store.prepare(context, [original], result_revision="run-2")
        with pytest.raises(ReviewStoreError):
            store.save(prepared["context_key"], "run-1", [record], confirm_group=False)


def test_migration_runs_in_independent_transaction_and_rolls_back_on_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    database = tmp_path / "review.sqlite3"
    calls = 0
    from engine import review_store_v2

    statements = list(review_store_v2._V2_DDL)
    statements[1] = "CREATE TABLE IF NOT EXISTS review_segments_v2 ("  # deliberately incomplete SQL
    monkeypatch.setattr(review_store_v2, "_V2_DDL", tuple(statements))
    with pytest.raises(sqlite3.OperationalError):
        ReviewStoreV2(database)

    connection = sqlite3.connect(database)
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    connection.close()
    assert "review_contexts_v2" not in tables
    assert "review_segments_v2" not in tables


@pytest.mark.parametrize("phase", ["initialize", "migrate"])
def test_constructor_closes_its_owned_database_after_setup_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    phase: str,
) -> None:
    database = tmp_path / f"failed-{phase}.sqlite3"
    close_calls: list[Database] = []
    real_close = Database.close

    def close_spy(instance: Database) -> None:
        close_calls.append(instance)
        real_close(instance)

    monkeypatch.setattr(Database, "close", close_spy)
    if phase == "initialize":
        def fail_initialize(_instance: Database) -> None:
            raise sqlite3.OperationalError("synthetic initialize failure")

        monkeypatch.setattr(Database, "initialize", fail_initialize)
        expected = sqlite3.OperationalError
    else:
        def fail_migrate(_instance: ReviewStoreV2) -> None:
            raise sqlite3.OperationalError("synthetic migration failure")

        monkeypatch.setattr(ReviewStoreV2, "_migrate_v2", fail_migrate)
        expected = sqlite3.OperationalError

    with pytest.raises(expected):
        ReviewStoreV2(database)
    assert len(close_calls) == 1

    # The constructor's connection must be gone before a Windows caller
    # reopens, repairs, or removes the failed database.
    connection = sqlite3.connect(database)
    connection.execute("SELECT 1")
    connection.close()
    database.unlink()


@pytest.mark.parametrize("phase", ["initialize", "migrate"])
def test_constructor_preserves_external_database_after_setup_failure(
    monkeypatch: pytest.MonkeyPatch,
    phase: str,
) -> None:
    external = Database(":memory:")
    close_calls: list[Database] = []
    real_close = Database.close

    def close_spy(instance: Database) -> None:
        close_calls.append(instance)
        real_close(instance)

    monkeypatch.setattr(Database, "close", close_spy)
    if phase == "initialize":
        def fail_initialize() -> None:
            raise sqlite3.OperationalError("synthetic initialize failure")

        monkeypatch.setattr(external, "initialize", fail_initialize)
    else:
        def fail_migrate(_instance: ReviewStoreV2) -> None:
            raise sqlite3.OperationalError("synthetic migration failure")

        monkeypatch.setattr(ReviewStoreV2, "_migrate_v2", fail_migrate)

    with pytest.raises(sqlite3.OperationalError):
        ReviewStoreV2(external)
    assert close_calls == []
    assert external.connection.execute("SELECT 1").fetchone()[0] == 1
    external.close()
