"""Real private worker processes with synthetic PDFs, no OCR models required."""

from contextlib import contextmanager
from io import BytesIO
import json
import os
from pathlib import Path
from queue import Queue
import subprocess
import sys
from threading import Thread

import pymupdf
import pytest

from engine.batch_protocol import read_frame
from engine import batch_worker
from engine.batch_lease import worker_lease
from engine.batch_store import BatchStore
from engine.computation import current_computation_version


def create_task(tmp_path, pages=40):
    source = tmp_path / "synthetic.pdf"
    with pymupdf.open() as document:
        for number in range(pages):
            page = document.new_page(width=600, height=800)
            page.insert_text((50, 60), f"bank fee page {number + 1}")
        document.save(source)
    database = tmp_path / "batch.sqlite3"
    with BatchStore(database) as store:
        store.activate_supervisor("host")
        job = store.create_job("worker-test", [{"source_path": str(source), "name": "synthetic"}],
                               {"include": ["fee"], "includeMode": "all", "exclude": []}, "exact", current_computation_version())
        return database, store.start_job(job["id"], 0, "host", current_computation_version())


@contextmanager
def worker(tmp_path, database, job, owner="host"):
    environment = os.environ.copy()
    environment["PDF_SEARCH_PRIVATE_TEMP"] = str(tmp_path / "private")
    process = subprocess.Popen(
        [sys.executable, "-E", "-s", "-X", "utf8", str(Path(__file__).parents[1] / "engine" / "engine.py"),
         "--batch-worker", "--batch-database", str(database), "--batch-job", job["id"],
         "--batch-generation", str(job["generation"]), "--batch-owner", owner],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    events = Queue()

    def read_events():
        try:
            while frame := read_frame(process.stdout):
                events.put(frame)
        except Exception as error:
            events.put(error)
        finally:
            events.put(None)

    reader = Thread(target=read_events)
    reader.start()
    try:
        yield process, events
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=10)
        reader.join(timeout=10)
        assert not reader.is_alive()
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()


def send(process, job, action="pause", **changes):
    frame = {"protocol": 2, "jobId": job["id"], "generation": job["generation"], "commandId": "control", "action": action}
    frame.update(changes)
    process.stdin.write(json.dumps(frame).encode() + b"\n")
    process.stdin.flush()


def drain(events):
    frames = []
    while (frame := events.get(timeout=20)) is not None:
        if isinstance(frame, Exception):
            raise frame
        frames.append(frame)
    return frames


def test_real_worker_pause_process_exit_and_new_generation_resume(tmp_path):
    database, job = create_task(tmp_path)
    with worker(tmp_path, database, job) as (process, events):
        first = []
        while True:
            frame = events.get(timeout=20)
            assert isinstance(frame, dict)
            first.append(frame)
            if frame["payload"].get("phase") == "page_settled":
                send(process, job)
                break
        first += drain(events)
        assert process.wait(timeout=10) == 0, process.stderr.read().decode()
        assert first[-1]["type"] == "completed" and first[-1]["payload"]["state"] == "paused"
        assert [frame["seq"] for frame in first] == list(range(1, len(first) + 1))
    with BatchStore(database) as store:
        paused = store.get_job(job["id"])
        completed = paused["page_summary"]["succeeded"]
        assert 0 < completed < 40
        restarted = store.start_job(job["id"], 1, "host", current_computation_version())
    with worker(tmp_path, database, restarted) as (process, events):
        frames = drain(events)
        assert process.wait(timeout=10) == 0, process.stderr.read().decode()
        assert frames[0]["seq"] == 1 and all(frame["generation"] == 2 for frame in frames)
        assert frames[-1]["payload"]["state"] == "ready_for_review"
        computed = [frame["payload"]["page"] for frame in frames if frame["payload"].get("phase") == "unit_start" and frame["payload"]["stage"] == "page"]
        assert computed == list(range(completed + 1, 41))
    with BatchStore(database) as store:
        assert store.get_job(job["id"])["sources"][0]["budget"]["processed_pages"] == 40


def test_forced_worker_exit_recovers_saved_pages_under_new_supervisor(tmp_path):
    database, job = create_task(tmp_path)
    with worker(tmp_path, database, job) as (process, events):
        while True:
            frame = events.get(timeout=20)
            assert isinstance(frame, dict)
            if frame["payload"].get("phase") == "page_settled":
                process.kill()
                process.wait(timeout=10)
                break
    with BatchStore(database) as store:
        store.activate_supervisor("new-host")
        interrupted = store.get_job(job["id"])
        completed = interrupted["page_summary"]["succeeded"]
        assert interrupted["state"] == "interrupted" and 0 < completed < 40
        assert interrupted["page_summary"]["processing"] == 0
        restarted = store.start_job(job["id"], 1, "new-host", current_computation_version())
    with worker(tmp_path, database, restarted, "new-host") as (process, events):
        frames = drain(events)
        assert process.wait(timeout=10) == 0, process.stderr.read().decode()
        computed = [frame["payload"]["page"] for frame in frames if frame["payload"].get("phase") == "unit_start" and frame["payload"]["stage"] == "page"]
        assert computed == list(range(completed + 1, 41))
        assert frames[-1]["payload"]["state"] == "ready_for_review"


def test_real_worker_rejects_wrong_generation_control_without_publishing(tmp_path):
    database, job = create_task(tmp_path)
    with worker(tmp_path, database, job) as (process, events):
        assert events.get(timeout=20)["type"] == "snapshot"
        send(process, job, generation=999)
        frames = drain(events)
        assert process.wait(timeout=10) != 0
        assert not any(frame["payload"].get("state") == "ready_for_review" for frame in frames)
    with BatchStore(database) as store:
        assert store.get_job(job["id"])["result_revision"] is None


def test_partial_thread_start_failure_stops_and_joins_the_started_control_reader(tmp_path, monkeypatch):
    database, job = create_task(tmp_path, pages=1)
    created = []

    def make_thread(**kwargs):
        thread = Thread(**kwargs)
        created.append(thread)
        if len(created) == 2:
            def fail_start():
                raise RuntimeError("synthetic thread start failure")
            thread.start = fail_start
        return thread

    monkeypatch.setattr(batch_worker, "Thread", make_thread)
    read_fd, write_fd = os.pipe()
    try:
        with pytest.raises(RuntimeError, match="thread start failure"):
            batch_worker.run_worker(database, job["id"], 1, "host", read_fd, BytesIO())
        assert len(created) == 2 and not any(thread.is_alive() for thread in created)
    finally:
        os.close(read_fd)
        os.close(write_fd)


def test_locked_worker_exits_before_opening_database_or_starting_computation(tmp_path):
    database, job = create_task(tmp_path, pages=1)
    with BatchStore(database) as store:
        before = store.get_job(job["id"])

    with worker_lease(database):
        with worker(tmp_path, database, job) as (process, events):
            assert drain(events) == []
            assert process.wait(timeout=10) == 1
            assert process.stderr.read().decode().strip() == "batch worker stopped before completion"

    with BatchStore(database) as store:
        after = store.get_job(job["id"])
    assert after == before
