"""账户档案和本方账户快照的持久化回归。"""

import pytest

from engine.receipt_grouping_models import GroupingConflict
from engine.receipt_grouping_store import GroupingStore


ACCOUNT = {
    "company_name": "合成公司",
    "bank_name": "合成银行",
    "branch_name": "合成支行",
    "account_number": "000012345678",
}


def test_account_save_list_cas_and_disable(tmp_path):
    database = tmp_path / "grouping.sqlite3"
    with GroupingStore(database) as store:
        created = store.account_save(ACCOUNT, expected_account_revision=0, active=True)
        assert created["account_revision"] == 1
        assert created["branch_name"] == "合成支行"
        listed = store.account_list(active_only=True, offset=0, limit=50)
        assert listed["total"] == 1
        assert listed["items"][0]["account_number"] == ACCOUNT["account_number"]

        updated = store.account_save(
            {**ACCOUNT, "branch_name": "新合成支行"}, account_id=created["account_id"],
            expected_account_revision=1, active=False,
        )
        assert updated["account_revision"] == 2
        assert store.account_list(active_only=True, offset=0, limit=50)["total"] == 0
        assert store.account_list(active_only=False, offset=0, limit=50)["items"][0]["active"] is False
        with pytest.raises(GroupingConflict):
            store.account_save(ACCOUNT, account_id=created["account_id"], expected_account_revision=1, active=True)


def test_saved_account_selection_is_revision_pinned_and_inline_is_immutable(tmp_path):
    database = tmp_path / "grouping.sqlite3"
    with GroupingStore(database) as store:
        saved = store.account_save(ACCOUNT, expected_account_revision=0, active=True)
        selected = store.set_account(
            "job-saved", expected_grouping_revision=0,
            account_selection={"kind": "saved", "account_id": saved["account_id"], "account_revision": 1},
        )
        assert selected["own_account"]["account_revision"] == 1

        # Editing the saved profile does not silently change an already
        # selected task; the caller must select the new revision explicitly.
        store.account_save({**ACCOUNT, "company_name": "另一合成公司"}, account_id=saved["account_id"],
                           expected_account_revision=1, active=True)
        with pytest.raises(GroupingConflict):
            store.set_account(
                "job-new", expected_grouping_revision=0,
                account_selection={"kind": "saved", "account_id": saved["account_id"], "account_revision": 1},
            )

        inline = store.set_account(
            "job-inline", expected_grouping_revision=0,
            account_selection={"kind": "inline", "account": ACCOUNT},
        )
        assert inline["own_account"]["account_id"] is None
        assert inline["own_account"]["account_revision"] is None


def test_selection_time_and_revision_are_independent_of_group_edits(tmp_path, monkeypatch):
    import engine.receipt_grouping_store as module
    with GroupingStore(tmp_path / "grouping.sqlite3") as store:
        monkeypatch.setattr(module, "now_utc", lambda: "2026-01-01T00:00:00.000Z")
        selected = store.set_account("job-time", expected_grouping_revision=0, account_selection={"kind": "inline", "account": ACCOUNT})
        store.connection.execute("UPDATE receipt_grouping_tasks SET updated_at='2026-02-01T00:00:00.000Z' WHERE job_id='job-time'")
        assert store.header("job-time")["own_account"]["selected_at"] == selected["own_account"]["selected_at"]
        monkeypatch.setattr(module, "now_utc", lambda: "2026-03-01T00:00:00.000Z")
        changed = store.set_account("job-time", expected_grouping_revision=0, account_selection={"kind": "inline", "account": {**ACCOUNT, "account_number": "000012345679"}})
        assert changed["own_account"]["own_account_revision"] == 2
        assert changed["own_account"]["selected_at"] == "2026-03-01T00:00:00.000Z"


def test_profile_changed_before_freeze_lock_is_rejected(tmp_path, monkeypatch):
    from contextlib import contextmanager
    database = tmp_path / "grouping.sqlite3"
    with GroupingStore(database) as store:
        saved = store.account_save(ACCOUNT, expected_account_revision=0, active=True)
        original_transaction = store.transaction

        @contextmanager
        def concurrent_edit():
            with GroupingStore(database) as other:
                other.account_save(ACCOUNT, account_id=saved["account_id"], expected_account_revision=1, active=False)
            with original_transaction() as connection:
                yield connection

        monkeypatch.setattr(store, "transaction", concurrent_edit)
        with pytest.raises(GroupingConflict):
            store.set_account("job-race", expected_grouping_revision=0,
                account_selection={"kind": "saved", "account_id": saved["account_id"], "account_revision": 1})
        assert store.connection.execute("SELECT COUNT(*) FROM receipt_grouping_tasks").fetchone()[0] == 0
