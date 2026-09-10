"""Interruptible, bounded binary control-pipe framing for the batch worker.

The worker's control reader must not use ``sys.stdin.buffer``: a buffered
stream read can leave a thread blocked on a pipe after the worker has asked it
to stop.  This module therefore accepts the already-owned OS file descriptor,
waits for bytes with a short platform-specific poll, and reads with
``os.read`` only after the pipe reports data.
"""

from __future__ import annotations

from collections.abc import Iterator
from io import BytesIO
import ctypes
import ctypes.wintypes as wintypes
import os
import selectors
import stat
from threading import Event
from typing import Any

from .batch_protocol import FrameError, MAX_FRAME_BYTES, read_frame


_POLL_SECONDS = 0.01
_READ_CHUNK_BYTES = 4 * 1024

if os.name == "nt":
    import msvcrt

    _FILE_TYPE_PIPE = 0x00000003
    _ERROR_BROKEN_PIPE = 109
    _ERROR_NO_DATA = 232
    _ERROR_PIPE_NOT_CONNECTED = 233

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _get_file_type = _kernel32.GetFileType
    _get_file_type.argtypes = [wintypes.HANDLE]
    _get_file_type.restype = wintypes.DWORD

    _peek_named_pipe = _kernel32.PeekNamedPipe
    _peek_named_pipe.argtypes = [
        wintypes.HANDLE,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.DWORD),
    ]
    _peek_named_pipe.restype = wintypes.BOOL


def _validate_pipe_fd(fd: int) -> int | None:
    """Validate the caller-owned descriptor and return its Windows handle."""

    if type(fd) is not int or fd < 0:
        raise ValueError("fd must be a non-negative pipe descriptor")
    try:
        descriptor_stat = os.fstat(fd)
    except (OSError, ValueError):
        raise ValueError("fd must refer to a live pipe") from None

    if os.name != "nt":
        if not stat.S_ISFIFO(descriptor_stat.st_mode):
            raise ValueError("fd must refer to a pipe")
        return None

    try:
        handle = msvcrt.get_osfhandle(fd)
    except (OSError, ValueError):
        raise ValueError("fd must refer to a live pipe") from None
    if handle == -1 or _get_file_type(wintypes.HANDLE(handle)) != _FILE_TYPE_PIPE:
        raise ValueError("fd must refer to a pipe")
    return handle


def _next_frame(buffer: bytearray) -> bytes | None:
    """Remove one complete line while keeping the accumulator bounded."""

    newline = buffer.find(b"\n")
    if newline < 0:
        if len(buffer) >= MAX_FRAME_BYTES:
            raise FrameError("worker frame exceeds the limit or is incomplete")
        return None

    frame_length = newline + 1
    if frame_length > MAX_FRAME_BYTES:
        raise FrameError("worker frame exceeds the limit or is incomplete")
    frame = bytes(buffer[:frame_length])
    del buffer[:frame_length]
    return frame


def _decode_frame(frame: bytes) -> dict[str, Any]:
    """Decode exactly one already-framed line through the shared validator."""

    decoded = read_frame(BytesIO(frame))
    # ``read_frame`` returns None only for an empty stream.  A frame obtained
    # from the pipe is non-empty and newline-terminated, but keep the guard so
    # this helper's return type remains true if the protocol changes later.
    if decoded is None:
        raise FrameError("worker frame is empty")
    return decoded


def _read_posix(fd: int, stop: Event) -> Iterator[dict[str, Any]]:
    buffer = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(fd, selectors.EVENT_READ)
        while True:
            while True:
                if stop.is_set():
                    return
                frame = _next_frame(buffer)
                if frame is None:
                    break
                yield _decode_frame(frame)

            # A stop request is allowed to discard an incomplete in-flight
            # line.  It must win before another potentially blocking wait.
            if stop.is_set():
                return

            if not selector.select(_POLL_SECONDS):
                continue
            if stop.is_set():
                return

            read_length = min(_READ_CHUNK_BYTES, MAX_FRAME_BYTES - len(buffer))
            try:
                data = os.read(fd, read_length)
            except (BlockingIOError, InterruptedError):
                continue
            if not data:
                if stop.is_set():
                    return
                if buffer:
                    raise FrameError("worker frame exceeds the limit or is incomplete")
                return
            buffer.extend(data)


def _peek_windows(handle: int) -> tuple[int, bool]:
    """Return available bytes and whether the peer has closed the pipe."""

    available = wintypes.DWORD()
    ok = _peek_named_pipe(
        wintypes.HANDLE(handle),
        None,
        0,
        None,
        ctypes.byref(available),
        None,
    )
    if ok:
        return int(available.value), False

    error = ctypes.get_last_error()
    if error in {_ERROR_BROKEN_PIPE, _ERROR_NO_DATA, _ERROR_PIPE_NOT_CONNECTED}:
        return 0, True
    raise OSError(error, "PeekNamedPipe failed")


def _read_windows(fd: int, handle: int, stop: Event) -> Iterator[dict[str, Any]]:
    buffer = bytearray()
    while True:
        while True:
            if stop.is_set():
                return
            frame = _next_frame(buffer)
            if frame is None:
                break
            yield _decode_frame(frame)

        # PeekNamedPipe is deliberately used only as a readiness probe; the
        # bytes are consumed through the caller's fd, and the fd is never
        # closed here.  Event.wait supplies the interruptible short poll.
        if stop.is_set():
            return
        available, peer_closed = _peek_windows(handle)
        if peer_closed:
            if stop.is_set():
                return
            if buffer:
                raise FrameError("worker frame exceeds the limit or is incomplete")
            return
        if available == 0:
            if stop.wait(_POLL_SECONDS):
                return
            continue

        read_length = min(_READ_CHUNK_BYTES, MAX_FRAME_BYTES - len(buffer), available)
        try:
            data = os.read(fd, read_length)
        except (BlockingIOError, InterruptedError):
            continue
        if not data:
            if stop.is_set():
                return
            if buffer:
                raise FrameError("worker frame exceeds the limit or is incomplete")
            return
        buffer.extend(data)


def read_control_frames(fd: int, stop: Event) -> Iterator[dict[str, Any]]:
    """Yield strictly decoded NDJSON frames from a real pipe descriptor.

    ``fd`` remains owned by the caller and is never closed.  The generator
    polls in short intervals so setting ``stop`` abandons a partial line and
    returns promptly even while the peer keeps the pipe open.  At EOF an empty
    accumulator is clean; a non-empty accumulator is an incomplete frame.
    """

    handle = _validate_pipe_fd(fd)
    if os.name == "nt":
        if handle is None:  # defensive guard for type checkers
            raise ValueError("fd must refer to a pipe")
        return _read_windows(fd, handle, stop)
    return _read_posix(fd, stop)


__all__ = ["read_control_frames"]
