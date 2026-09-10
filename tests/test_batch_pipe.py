"""Real-pipe coverage for the interruptible batch control reader."""

from __future__ import annotations

import json
import os
import stat
import threading
import time
from typing import Any

import pytest

from engine.batch_pipe import read_control_frames
from engine.batch_protocol import FrameError, MAX_FRAME_BYTES


def _frame(value: dict[str, Any]) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"


def _write_all(fd: int, chunks: list[bytes], *, delay: float = 0.0) -> None:
    """Write in a helper thread so a large test payload cannot deadlock."""

    try:
        for chunk in chunks:
            pending = memoryview(chunk)
            while pending:
                try:
                    written = os.write(fd, pending)
                except OSError:
                    # The reader may close its end after an intentional
                    # framing failure (for example, an oversized frame).
                    return
                if written <= 0:
                    return
                pending = pending[written:]
            if delay:
                time.sleep(delay)
    finally:
        os.close(fd)


def _read_pipe(chunks: list[bytes], *, delay: float = 0.0) -> list[dict[str, Any]]:
    read_fd, write_fd = os.pipe()
    writer = threading.Thread(target=_write_all, args=(write_fd, chunks), kwargs={"delay": delay})
    writer.start()
    try:
        result = list(read_control_frames(read_fd, threading.Event()))
    finally:
        os.close(read_fd)
        writer.join(timeout=1.0)
    assert not writer.is_alive(), "writer thread must not remain blocked"
    return result


def test_fragmented_input_yields_multiple_frames_in_order():
    first = {"command": "pause", "id": 1}
    second = {"command": "cancel", "id": 2}
    data = _frame(first) + _frame(second)
    chunks = [data[:1], data[1:4], data[4:13], data[13:]]

    assert _read_pipe(chunks, delay=0.001) == [first, second]


def test_clean_eof_without_frames_returns_empty():
    assert _read_pipe([]) == []


def test_partial_frame_at_eof_is_rejected():
    read_fd, write_fd = os.pipe()
    writer = threading.Thread(target=_write_all, args=(write_fd, [b'{"partial":']))
    writer.start()
    try:
        with pytest.raises(FrameError, match="incomplete"):
            list(read_control_frames(read_fd, threading.Event()))
    finally:
        os.close(read_fd)
        writer.join(timeout=1.0)
    assert not writer.is_alive()


def test_oversized_frame_is_rejected_without_writer_deadlock():
    read_fd, write_fd = os.pipe()
    oversized = b"x" * (MAX_FRAME_BYTES + 1) + b"\n"
    writer = threading.Thread(target=_write_all, args=(write_fd, [oversized]))
    writer.start()
    try:
        with pytest.raises(FrameError, match="exceeds the limit"):
            list(read_control_frames(read_fd, threading.Event()))
    finally:
        # Closing the reader also releases a writer that has not finished
        # pushing the intentionally oversized payload yet.
        os.close(read_fd)
        writer.join(timeout=1.0)
    assert not writer.is_alive()


def test_stop_unblocks_an_open_empty_pipe_quickly_and_keeps_fd_open():
    read_fd, write_fd = os.pipe()
    stop = threading.Event()
    started = threading.Event()
    frames: list[dict[str, Any]] = []
    errors: list[BaseException] = []

    def reader() -> None:
        started.set()
        try:
            frames.extend(read_control_frames(read_fd, stop))
        except BaseException as error:  # capture thread failures for assertion
            errors.append(error)

    thread = threading.Thread(target=reader, name="test-control-reader")
    thread.start()
    assert started.wait(1.0)
    started_at = time.monotonic()
    stop.set()
    thread.join(timeout=0.5)
    elapsed = time.monotonic() - started_at
    try:
        assert not thread.is_alive(), "stop must release a reader waiting on an open pipe"
        assert elapsed < 0.5
        assert frames == []
        assert errors == []
        os.fstat(read_fd)
    finally:
        os.close(read_fd)
        os.close(write_fd)


def test_stop_abandons_a_partial_frame_without_waiting_for_peer_close():
    read_fd, write_fd = os.pipe()
    stop = threading.Event()
    started = threading.Event()
    frames: list[dict[str, Any]] = []
    errors: list[BaseException] = []

    def reader() -> None:
        started.set()
        try:
            frames.extend(read_control_frames(read_fd, stop))
        except BaseException as error:
            errors.append(error)

    thread = threading.Thread(target=reader, name="test-partial-control-reader")
    thread.start()
    assert started.wait(1.0)
    os.write(write_fd, b'{"partial":')
    # Give the native poll a chance to consume the fragment while the peer
    # remains open; stop must still be able to abandon it.
    time.sleep(0.03)
    stop.set()
    thread.join(timeout=0.5)
    try:
        assert not thread.is_alive()
        assert frames == []
        assert errors == []
    finally:
        os.close(read_fd)
        os.close(write_fd)


def test_shared_protocol_decoder_rejects_malformed_json():
    read_fd, write_fd = os.pipe()
    writer = threading.Thread(target=_write_all, args=(write_fd, [b'{"number":NaN}\n']))
    writer.start()
    try:
        with pytest.raises(FrameError, match="non-finite"):
            list(read_control_frames(read_fd, threading.Event()))
    finally:
        os.close(read_fd)
        writer.join(timeout=1.0)
    assert not writer.is_alive()


@pytest.mark.parametrize("value", [None, True, "3"])
def test_only_a_live_pipe_fd_is_accepted(value: Any):
    with pytest.raises(ValueError):
        read_control_frames(value, threading.Event())


def test_regular_file_fd_is_rejected(tmp_path):
    path = tmp_path / "not-a-pipe"
    path.write_bytes(b"{}\n")
    fd = os.open(path, os.O_RDONLY)
    try:
        with pytest.raises(ValueError, match="pipe"):
            read_control_frames(fd, threading.Event())
    finally:
        os.close(fd)


def test_os_pipe_read_end_is_a_fifo_on_this_runtime():
    read_fd, write_fd = os.pipe()
    try:
        # This documents the real-pipe fixture used by every behavior test;
        # Windows exposes anonymous pipes through CRT descriptors as well.
        assert stat.S_ISFIFO(os.fstat(read_fd).st_mode)
    finally:
        os.close(read_fd)
        os.close(write_fd)
