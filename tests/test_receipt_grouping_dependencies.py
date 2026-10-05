"""Synthetic evidence migration; never open business PDFs."""
from copy import deepcopy
import json

import pytest

from engine import receipt_grouping_version as versions
from engine.computation import COMPUTATION_SOURCE_FILES
from engine.receipt_field_rule_store import FieldRuleStore
from engine.receipt_grouping_store import stamp_extraction_dependencies
from test_receipt_field_rule_store import definition
from test_receipt_grouping_store import configured_store, field, prepare, receipt


@pytest.fixture(autouse=True)
def reset_version_caches():
    versions.clear_grouping_algorithm_version()
    yield
    versions.clear_grouping_algorithm_version()


def direct_receipt(pdf, index=1, *, name="合成对方", reader="direct_counterparty"):
    row = receipt(pdf, index)
    row["parties"] = {
        "counterparty_observed": {"name": field(name), "account": field(), "bank": field()},
        "reader_dependencies": [{"reader_id": reader, "version": "1"}],
    }
    return row


def review_rows(rows):
    return [{key: value for key, value in row.items() if key != "parties"} for row in rows]


def test_reader_changes_are_isolated_from_common_extraction_and_split_version(monkeypatch):
    digests = {name: "a" * 64 for name in versions.GROUPING_SOURCE_FILES}
    monkeypatch.setattr(versions, "_module_digests", lambda: dict(digests))
    before = (versions.grouping_algorithm_version(), versions.extraction_algorithm_version(),
              versions.reader_algorithm_version("legacy_labels"), versions.reader_algorithm_version("local-field-rule"))
    digests["engine/receipt_field_rule_reader.py"] = "b" * 64
    versions.clear_grouping_algorithm_version()
    assert versions.grouping_algorithm_version() != before[0]
    assert versions.extraction_algorithm_version() == before[1]
    assert versions.reader_algorithm_version("legacy_labels") == before[2]
    assert versions.reader_algorithm_version("local-field-rule") != before[3]
    # Issuer and document semantics are shared with splitting; grouping-only
    # reader changes still leave the split version's source set untouched.
    assert set(versions.GROUPING_SOURCE_FILES) & set(COMPUTATION_SOURCE_FILES) == {
        "engine/receipt_document_types.py", "engine/receipt_issuer.py",
    }
    digests["engine/receipt_field_candidates.py"] = "c" * 64
    versions.clear_grouping_algorithm_version()
    assert versions.extraction_algorithm_version() != before[1]


@pytest.mark.parametrize("module", ["engine/receipt_document_types.py", "engine/receipt_issuer.py"])
def test_shared_receipt_semantics_invalidate_cached_extraction(monkeypatch, module):
    digests = {name: "a" * 64 for name in versions.GROUPING_SOURCE_FILES}
    monkeypatch.setattr(versions, "_module_digests", lambda: dict(digests))
    before = versions.extraction_algorithm_version()
    digests[module] = "b" * 64
    versions.clear_grouping_algorithm_version()
    assert versions.extraction_algorithm_version() != before


def test_unsaved_rule_evidence_keeps_definition_digest_without_copying_definition():
    raw = {"parties": {"reader_dependencies": [{"reader_id": "local-field-rule", "version": "1"}]},
           "field_rule_basis": {"definition": definition(), "version": 1}}
    first = stamp_extraction_dependencies(raw)
    changed = deepcopy(raw)
    changed["field_rule_basis"]["definition"]["fields"][0]["rect"]["x1"] = .85
    second = stamp_extraction_dependencies(changed)
    assert first["extraction_dependencies"]["rule"] != second["extraction_dependencies"]["rule"]
    assert set(first["extraction_dependencies"]["rule"]) == {"version", "definition_digest"}
    assert "extraction_dependencies" not in raw


def test_prepare_invalidates_only_fragments_using_changed_reader(tmp_path, monkeypatch):
    store, pdf = configured_store(tmp_path)
    try:
        rows = [receipt(pdf, 1), direct_receipt(pdf, 2)]
        initial = prepare(store, pdf, rows)
        assert {item["extraction_state"] for item in initial["items"]} == {"ready"}
        digests = versions._module_digests()
        digests["engine/receipt_field_readers.py"] = "changed-direct-reader"
        monkeypatch.setattr(versions, "_module_digests", lambda: dict(digests))
        versions.clear_grouping_algorithm_version()
        prepared = prepare(store, pdf, review_rows(rows))
        states = {item["binding"]["segment_id"]: item["extraction_state"] for item in prepared["items"]}
        assert states == {"segment-1": "ready", "segment-2": "stale"}
        stored = store._load_items(store.connection, "job-1")
        assert all(item["_raw"]["extraction_dependencies"]["readers"] for item in stored)
        assert [item["binding"]["final_rect"] for item in prepared["items"]] == [item["binding"]["final_rect"] for item in initial["items"]]
        assert prepared["header"]["counts"]["stale"] == 1
    finally:
        store.close()


def test_old_dependencyless_cache_stales_once_then_refresh_establishes_evidence(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        row = direct_receipt(pdf)
        prepare(store, pdf, [row])
        payload = json.loads(store.connection.execute("SELECT derived_json FROM receipt_grouping_items").fetchone()[0])
        payload["_raw"].pop("extraction_dependencies")
        store.connection.execute("UPDATE receipt_grouping_items SET derived_json=?", (json.dumps(payload),))
        stale = prepare(store, pdf, review_rows([row]))
        assert stale["items"][0]["extraction_state"] == "stale"
        refreshed = store.refresh("job-1", result_revision="result-1", expected_grouping_revision=stale["header"]["grouping_revision"],
                                  expected_review_fingerprint="review-1", segment_ids=["segment-1"],
                                  source_reader=lambda *_: {"parties": row["parties"], "extraction_state": "ready"})
        final = prepare(store, pdf, review_rows([row]))
        assert final["items"][0]["extraction_state"] == "ready"
        assert final["header"]["grouping_revision"] == refreshed["header"]["grouping_revision"]
    finally:
        store.close()


def test_rule_save_update_and_disable_do_not_rewrite_completed_grouping(tmp_path):
    store, pdf = configured_store(tmp_path)
    try:
        rules = FieldRuleStore(store.connection)
        rule = rules.create(definition(), name="合成规则", operation_id="rule-save")
        row = direct_receipt(pdf, reader="local-field-rule")
        row["field_rule_basis"] = {key: rule[key] for key in ("rule_id", "version", "definition_digest")}
        initial = prepare(store, pdf, [row])
        before = deepcopy(store._load_items(store.connection, "job-1")[0])
        changed = definition()
        changed["fields"][0]["rect"]["x1"] = .85
        newer = rules.create(changed, name="合成规则新版", operation_id="rule-update", update_rule_id=rule["rule_id"], expected_version=1)
        rules.deactivate(newer["rule_id"], 2)
        after = prepare(store, pdf, review_rows([row]))
        assert after["header"]["grouping_revision"] == initial["header"]["grouping_revision"]
        current = store._load_items(store.connection, "job-1")[0]
        assert current == before
        assert current["_raw"]["extraction_dependencies"]["rule"]["version"] == 1
    finally:
        store.close()


@pytest.mark.parametrize("manual_name", [False, True])
def test_direct_evidence_change_drops_unprotected_assignment_only(tmp_path, manual_name):
    store, pdf = configured_store(tmp_path)
    try:
        row = direct_receipt(pdf)
        initial = prepare(store, pdf, [row])
        item = initial["items"][0]
        edit = {"segment_id": "segment-1", "expected_basis_fingerprint": item["basis_fingerprint"],
                "assignment": {"group_id": "manual-group", "reason": "合成核对"}}
        if manual_name:
            edit["field_overrides"] = [{"side": "counterparty", "field": "name", "state": "present", "value": "已人工核对对方", "reason": "核对原件"}]
        store.save("job-1", result_revision="result-1", expected_grouping_revision=initial["header"]["grouping_revision"],
                   expected_review_fingerprint="review-1", edits=[edit],
                   group_edits=[{"action": "create", "group_id": "manual-group", "kind": "named", "display_name": "人工核对组"}])
        changed = direct_receipt(pdf, name="新读对方")
        final = prepare(store, pdf, [changed])["items"][0]
        assert (final["group"]["group_id"] == "manual-group") is manual_name
        assert final["counterparty"]["name"]["value"] == ("已人工核对对方" if manual_name else "新读对方")
        assert final["boundary_status"] == "confirmed"
        assert final["binding"]["final_rect"] == row["final_rect"]
    finally:
        store.close()
