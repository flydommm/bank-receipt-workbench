from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

from engine.db import Database
from engine.models import (
    CropMode,
    CropRegion,
    ExportRecord,
    LayoutGroup,
    Match,
    PageStatus,
    TaskStatus,
    TextBlock,
)
from engine.task_store import InvalidTaskTransition, TaskStore


def test_database_initialization_is_idempotent(tmp_path: Path) -> None:
    database_path = tmp_path / "task-store.sqlite3"

    database = Database(database_path)
    database.initialize()
    database.initialize()

    tables = {
        row[0]
        for row in database.connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    assert {
        "tasks",
        "source_files",
        "pages",
        "text_blocks",
        "matches",
        "layout_groups",
        "crop_regions",
        "exports",
        "task_logs",
    }.issubset(tables)
    database.close()


def test_task_status_transition_is_persisted_and_invalid_transition_rejected(
    tmp_path: Path,
) -> None:
    store = TaskStore(tmp_path / "tasks.sqlite3")
    task = store.create_task("手续费检索")

    updated = store.transition_task(task.id, TaskStatus.PARSING)
    assert updated.status == TaskStatus.PARSING
    assert store.get_task(task.id).status == TaskStatus.PARSING

    with pytest.raises(InvalidTaskTransition):
        store.transition_task(task.id, TaskStatus.COMPLETED)

    store.close()


def test_pause_and_resume_restore_the_previous_processing_state(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.sqlite3")
    task = store.create_task("可暂停任务")
    store.transition_task(task.id, TaskStatus.PARSING)

    paused = store.pause_task(task.id)
    assert paused.status == TaskStatus.PAUSED
    assert paused.status_before_pause == TaskStatus.PARSING

    # Repeated pause requests should be harmless and must not overwrite the
    # state that resume needs.
    store.pause_task(task.id)
    resumed = store.resume_task(task.id)
    assert resumed.status == TaskStatus.PARSING
    assert resumed.status_before_pause is None
    store.close()


def test_register_source_file_records_sha256_and_page_checkpoints(tmp_path: Path) -> None:
    source_path = tmp_path / "source.pdf"
    source_bytes = b"local test pdf bytes"
    source_path.write_bytes(source_bytes)
    expected_sha256 = hashlib.sha256(source_bytes).hexdigest()

    store = TaskStore(tmp_path / "tasks.sqlite3")
    task = store.create_task("批量任务")
    source_file = store.register_source_file(task.id, source_path, page_count=2)
    assert source_file.sha256 == expected_sha256
    assert source_file.size_bytes == len(source_bytes)
    assert store.source_file_changed(source_file) is False
    source_path.write_bytes(source_bytes + b" changed")
    assert store.source_file_changed(source_file) is True
    duplicate_path = tmp_path / "copy.pdf"
    duplicate_path.write_bytes(b"local test pdf bytes")
    duplicate = store.register_source_file(task.id, duplicate_path)
    assert duplicate.id == source_file.id
    assert len(store.list_source_files(task.id)) == 1

    first_page = store.add_page(source_file.id, 1)
    second_page = store.add_page(source_file.id, 2)
    claimed = store.claim_next_page(task.id)
    assert claimed is not None
    assert claimed.id == first_page.id
    assert claimed.status == PageStatus.PROCESSING

    store.mark_page_completed(first_page.id)
    store.mark_page_failed(second_page.id, "OCR error")
    assert store.get_page(first_page.id).status == PageStatus.COMPLETED
    assert store.get_page(second_page.id).status == PageStatus.FAILED
    assert [page.id for page in store.list_retryable_pages(task.id)] == [second_page.id]

    retried = store.retry_failed_pages(task.id)
    assert [page.id for page in retried] == [second_page.id]
    retried_page = store.get_page(second_page.id)
    assert retried_page.status == PageStatus.PENDING
    assert retried_page.retry_count == 1
    assert retried_page.error_message is None
    store.close()


def test_transaction_rolls_back_multiple_writes_on_error(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.sqlite3")

    with pytest.raises(RuntimeError):
        with store.transaction():
            task = store.create_task("不会保存")
            store.add_task_log(task.id, "info", "temporary")
            raise RuntimeError("rollback")

    assert store.list_tasks() == []
    store.close()


def test_related_models_round_trip_through_task_store(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.sqlite3")
    task = store.create_task("结果索引")
    source_file = store.register_source_file(task.id, tmp_path / "missing.pdf", sha256="a" * 64)
    page = store.add_page(source_file.id, 1)

    text_block = store.add_text_block(
        TextBlock(
            id="block-1",
            page_id=page.id,
            text="手续费",
            x0=10,
            y0=20,
            x1=80,
            y1=40,
            confidence=0.98,
            field="摘要",
        )
    )
    assert text_block == store.get_text_blocks(page.id)[0]

    match = store.add_match(
        Match(
            id="match-1",
            page_id=page.id,
            query="手续费",
            matched_text="手续费",
            matched_field="摘要",
            confidence=0.98,
            x0=10,
            y0=20,
            x1=80,
            y1=40,
        )
    )
    assert match == store.get_matches(page.id)[0]

    group = store.add_layout_group(
        LayoutGroup(
            id="group-1",
            task_id=task.id,
            fingerprint="fingerprint",
            confidence=0.95,
            name="同版式",
        )
    )
    region = store.add_crop_region(
        CropRegion(
            id="crop-1",
            page_id=page.id,
            layout_group_id=group.id,
            x0=0,
            y0=0,
            x1=100,
            y1=200,
            confidence=0.91,
            mode=CropMode.CANDIDATE,
            review_status="pending",
        )
    )
    assert region == store.get_crop_regions(page.id)[0]

    export = store.add_export(
        ExportRecord(
            id="export-1",
            task_id=task.id,
            output_path=str(tmp_path / "result.pdf"),
            kind="per_source",
            status="pending",
        )
    )
    assert export == store.get_exports(task.id)[0]
    store.add_task_log(task.id, "info", "索引已建立", page_id=page.id)
    assert store.get_task_logs(task.id)[0].message == "索引已建立"
    store.close()


def test_store_uses_foreign_keys_for_child_records(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.sqlite3")

    with pytest.raises(sqlite3.IntegrityError):
        store.add_page("missing-source", 1)

    store.close()
