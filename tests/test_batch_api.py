from hashlib import sha256
from pathlib import Path

import pymupdf
import pytest

import engine.batch_api as batch_api_module
from engine.batch_api import handle_batch_request
from engine.batch_store import BatchStore
from engine.engine import handle_request


def request(database, op, **fields):
    return handle_request({"op": op, "database_path": str(database), **fields})


def test_short_management_creates_persisted_job_without_opening_pdf(tmp_path, monkeypatch):
    monkeypatch.setattr(pymupdf, "open", lambda *_args, **_kwargs: pytest.fail("management must not parse or OCR PDFs"))
    database = tmp_path / "batch.sqlite3"
    created = request(database, "batch_create", name="test", sources=[{"source_path": str(tmp_path / "later.pdf"), "name": "later"}],
                      criteria={"include": ["fee"], "includeMode": "all", "exclude": []}, match_mode="exact")
    assert created["status"] == "ok"
    job = created["data"]
    assert job["state"] == "queued" and job["sources"][0]["sha256"] is None
    assert request(database, "batch_snapshot", job_id=job["id"])["data"] == job
    assert request(database, "batch_list", offset=0, limit=10)["data"]["total"] == 1
    assert request(database, "batch_activate", owner="host")["status"] == "ok"
    started = request(database, "batch_start", job_id=job["id"], generation=0, owner="host")
    assert started["data"]["state"] == "validating"
    assert request(database, "batch_control", job_id=job["id"], generation=1, command_id="pause", action="pause")["data"]["state"] == "paused"


@pytest.mark.parametrize("op", ["batch_commit_page", "batch_publish_snapshot", "batch_verify_source"])
def test_private_computation_writes_have_no_management_command(tmp_path, op):
    assert request(tmp_path / "batch.sqlite3", op)["code"] == "batch_invalid_request"
    assert not (tmp_path / "batch.sqlite3").exists()


def test_management_rejects_extra_fields_and_never_echoes_private_data(tmp_path):
    result = request(tmp_path / "batch.sqlite3", "batch_list", offset=0, limit=50, raw_text="private text")
    assert result["code"] == "batch_invalid_request" and "private" not in str(result)
    result = request(tmp_path / "batch.sqlite3", "batch_snapshot", job_id="private-keyword")
    assert result["status"] == "error" and "private-keyword" not in str(result)
    assert handle_batch_request({"op": "batch_list", "database_path": "relative.sqlite3", "offset": 0, "limit": 50})["status"] == "error"


def test_batch_start_reports_computation_version_change_as_actionable_error(tmp_path, monkeypatch):
    database = tmp_path / "batch.sqlite3"
    with BatchStore(database) as store:
        job = store.create_job(
            "legacy",
            [{"source_path": str(tmp_path / "legacy.pdf"), "name": "legacy"}],
            {"include": ["fee"], "includeMode": "all", "exclude": []},
            "exact",
            "stored-v1",
        )
        store.activate_supervisor("host")

    monkeypatch.setattr(batch_api_module, "current_computation_version", lambda: "current-v2")
    response = handle_batch_request({
        "op": "batch_start",
        "database_path": str(database),
        "job_id": job["id"],
        "generation": 0,
        "owner": "host",
    })
    assert response == {
        "status": "error",
        "code": "computation_version_changed",
        "message": "计算版本已变化，请重新选择原始 PDF 开始新的分析任务",
    }
    with BatchStore(database) as store:
        current = store.get_job(job["id"])
        assert current["state"] == "queued" and current["generation"] == 0


def test_relocation_hash_is_computed_from_file_not_ui_claim(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    original = tmp_path / "original.pdf"
    with pymupdf.open() as pdf:
        pdf.new_page()
        pdf.save(original)
    copy = tmp_path / "relocated.pdf"
    copy.write_bytes(original.read_bytes())
    database = tmp_path / "batch.sqlite3"
    with BatchStore(database) as store:
        job = store.create_job("test", [{"source_path": str(original), "name": "original"}],
                               {"include": ["fee"], "includeMode": "all", "exclude": []}, "exact", "test")
        store.activate_supervisor("host")
        running = store.start_job(job["id"], 0, "host", "test")
        source = running["sources"][0]
        store.register_source(job["id"], 1, "host", source["source_id"], sha256(original.read_bytes()).hexdigest(), original.stat().st_size, 1)
        store.control(job["id"], 1, "pause", "pause")
    changed = request(database, "batch_relocate", job_id=job["id"], source_id=source["source_id"], new_path=str(copy))
    assert changed["status"] == "ok"
    with BatchStore(database) as store:
        relocated = store.get_job(job["id"])["sources"][0]
        assert Path(relocated["access_path"]) == copy and relocated["source_key"] == source["source_key"]
    with copy.open("ab") as synthetic:
        synthetic.write(b"changed fixture")
    refused = request(database, "batch_relocate", job_id=job["id"], source_id=source["source_id"], new_path=str(copy))
    assert refused["code"] == "source_changed"
