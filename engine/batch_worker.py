"""Dedicated v2 worker; stdout is a bounded event pipe, never document text."""

from __future__ import annotations

from pathlib import Path
from threading import Event, Thread
from typing import Any, BinaryIO

from .batch_pipe import read_control_frames
from .batch_processor import BatchProcessor, BatchProgress, public_summary
from .batch_protocol import EventWriter, FrameError, validate_control
from .batch_lease import worker_lease
from .batch_store import BatchStore
from .computation import current_computation_version


class WorkerChannelError(RuntimeError):
    """A failed host channel prevents the worker from doing further work."""


def run_worker(
    database: str | Path, job_id: str, generation: int, owner: str,
    input_fd: int, output: BinaryIO, *, heartbeat_seconds: float = 2.0,
) -> int:
    path = Path(database)
    if not path.is_absolute() or path.suffix != ".sqlite3":
        raise ValueError("batch database path must be an absolute SQLite path")
    if heartbeat_seconds <= 0:
        raise ValueError("heartbeat interval must be positive")

    # The lease must be held before opening the database, starting helper
    # threads, or doing any computation.  A failed acquisition therefore
    # leaves the job untouched and cannot race host recovery.
    with worker_lease(path):
        return _run_worker_with_lease(
            path, job_id, generation, owner, input_fd, output,
            heartbeat_seconds=heartbeat_seconds,
        )


def _run_worker_with_lease(
    path: Path, job_id: str, generation: int, owner: str,
    input_fd: int, output: BinaryIO, *, heartbeat_seconds: float,
) -> int:
    writer = EventWriter(output, job_id, generation)
    stop = Event()
    broken = Event()

    def mark_failed(_error: Exception) -> None:
        broken.set()

    def check_health() -> None:
        if broken.is_set():
            raise WorkerChannelError("worker host channel is unavailable")

    def emit(event_type: str, payload: dict[str, Any]) -> int:
        check_health()
        try:
            return writer.emit(event_type, payload)
        except Exception as error:
            mark_failed(error)
            raise

    progress = BatchProgress(emit, check_health)

    def controls() -> None:
        try:
            # Each thread owns its connection.  It never shares the page
            # transaction connection or waits for computation under a lock.
            with BatchStore(path) as control_store:
                for frame in read_control_frames(input_fd, stop):
                    command = validate_control(frame, job_id, generation)
                    response = control_store.control(job_id, generation, command["command_id"], command["action"])
                    emit("state_changed", {"state": response["state"], "control": response})
            if not stop.is_set():
                raise FrameError("worker host control pipe closed")
        except Exception as error:
            if not stop.is_set():
                mark_failed(error)

    def heartbeat() -> None:
        while not stop.wait(heartbeat_seconds):
            try:
                emit("progress", {"phase": "heartbeat", "unit": progress.current_unit()})
            except Exception as error:
                mark_failed(error)
                return

    control_thread = Thread(target=controls, name="batch-controls")
    heartbeat_thread = Thread(target=heartbeat, name="batch-heartbeat")
    with BatchStore(path) as store:
        version = current_computation_version()
        started = []
        try:
            for thread in (control_thread, heartbeat_thread):
                thread.start()
                started.append(thread)
            job = BatchProcessor(store, job_id, generation, owner, version, progress).run()
            # Stop and join emitters before writing the single final event.
            # Rust still confirms process/pipes exit before settling cancel.
        finally:
            stop.set()
            for thread in started:
                thread.join()
        emit("completed", public_summary(job))
    return 0
