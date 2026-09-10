"""Cross-process tests for the persistent batch worker lifecycle lease."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest

from engine.batch_lease import BatchLeaseError, worker_lease


_REPOSITORY = Path(__file__).parents[1]
_LEASE_HELPER = textwrap.dedent(
    """
    import sys
    import time
    from pathlib import Path

    from engine.batch_lease import BatchLeaseError, worker_lease

    database = Path(sys.argv[1])
    duration = float(sys.argv[2])
    try:
        with worker_lease(database):
            print("acquired", flush=True)
            time.sleep(duration)
    except BatchLeaseError:
        print("unavailable", flush=True)
        raise SystemExit(3)
    """
)


def _start_lease_process(database: Path, duration: float = 0.4) -> subprocess.Popen[str]:
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    return subprocess.Popen(
        [sys.executable, "-E", "-s", "-X", "utf8", "-c", _LEASE_HELPER,
         str(database), str(duration)],
        cwd=_REPOSITORY,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        creationflags=creationflags,
    )


def _read_status(process: subprocess.Popen[str]) -> str:
    assert process.stdout is not None
    status = process.stdout.readline().strip()
    assert status in {"acquired", "unavailable"}, process.stderr.read() if process.stderr else ""
    return status


def _finish(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        process.kill()
    process.wait(timeout=10)
    if process.stdout is not None:
        process.stdout.close()
    if process.stderr is not None:
        process.stderr.close()


def test_lease_uses_fixed_empty_file_and_releases_on_context_exit(tmp_path: Path) -> None:
    database = tmp_path / "private" / "batch.sqlite3"
    database.parent.mkdir()

    with worker_lease(database):
        lock_file = database.parent / "batch-worker.lock"
        assert lock_file.exists()
        assert lock_file.stat().st_size == 0
        with pytest.raises(BatchLeaseError, match="^worker lease unavailable$"):
            with worker_lease(database):
                pass

    # The file remains as the stable rendezvous point, while the OS lock is
    # released as soon as the context exits.
    assert (database.parent / "batch-worker.lock").stat().st_size == 0
    with worker_lease(database):
        pass


def test_two_processes_compete_and_next_process_acquires_after_exit(tmp_path: Path) -> None:
    database = tmp_path / "batch.sqlite3"
    holder = _start_lease_process(database, duration=0.55)
    contender = None
    try:
        assert _read_status(holder) == "acquired"
        contender = _start_lease_process(database)
        assert _read_status(contender) == "unavailable"
        assert contender.wait(timeout=10) == 3
        assert holder.wait(timeout=10) == 0

        recovered = _start_lease_process(database, duration=0.05)
        try:
            assert _read_status(recovered) == "acquired"
            assert recovered.wait(timeout=10) == 0
        finally:
            _finish(recovered)
    finally:
        _finish(holder)
        if contender is not None:
            _finish(contender)


def test_killed_process_does_not_leave_a_stale_lease(tmp_path: Path) -> None:
    database = tmp_path / "batch.sqlite3"
    holder = _start_lease_process(database, duration=30)
    try:
        assert _read_status(holder) == "acquired"
        holder.kill()
        assert holder.wait(timeout=10) is not None

        recovered = _start_lease_process(database, duration=0.05)
        try:
            assert _read_status(recovered) == "acquired"
            assert recovered.wait(timeout=10) == 0
        finally:
            _finish(recovered)
    finally:
        _finish(holder)


def test_missing_database_parent_is_rejected_without_creating_anything(tmp_path: Path) -> None:
    database = tmp_path / "missing-private" / "batch.sqlite3"
    with pytest.raises(BatchLeaseError, match="^worker lease unavailable$"):
        with worker_lease(database):
            pass
    assert not database.parent.exists()
