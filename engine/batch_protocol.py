"""Bounded v2 worker events and control frames, independent of legacy JSONL."""

from __future__ import annotations

import json
import math
from threading import Lock
from typing import Any, BinaryIO


MAX_FRAME_BYTES = 64 * 1024
MAX_SAFE_INTEGER = 2**53 - 1
EVENT_TYPES = frozenset({"snapshot", "progress", "page_failed", "state_changed", "completed"})


class FrameError(ValueError):
    """Untrusted framing is invalid; exception text never includes raw input."""


def _text(value: Any, limit: int) -> bool:
    return isinstance(value, str) and 0 < len(value.strip()) <= limit and len(value) <= limit and "\0" not in value


def _integer(value: Any) -> bool:
    return type(value) is int and 0 < value <= MAX_SAFE_INTEGER


def _validate_json(value: Any) -> None:
    # Charge every occurrence, including aliases.  A tiny Python graph of
    # shared lists can otherwise expand into an enormous JSON document.
    remaining = MAX_FRAME_BYTES
    pending = [(value, 0)]
    while pending:
        item, depth = pending.pop()
        if depth > 16:
            raise FrameError("worker frame is too deeply nested")
        remaining -= 1
        if remaining < 0:
            raise FrameError("worker frame exceeds the validation budget")
        if item is None or type(item) is bool:
            continue
        if type(item) is int:
            if abs(item) > MAX_SAFE_INTEGER:
                raise FrameError("worker frame integer is out of range")
            continue
        if type(item) is float:
            if not math.isfinite(item) or abs(item) > MAX_SAFE_INTEGER:
                raise FrameError("worker frame number is out of range")
            continue
        if isinstance(item, str):
            if len(item) > remaining:
                raise FrameError("worker frame string exceeds the validation budget")
            try:
                remaining -= len(item.encode("utf-8"))
            except UnicodeEncodeError:
                raise FrameError("worker frame contains invalid Unicode") from None
            if remaining < 0:
                raise FrameError("worker frame string exceeds the validation budget")
            continue
        if type(item) not in (list, dict) or len(item) > 1024:
            raise FrameError("worker frame contains invalid data")
        if type(item) is dict:
            for key, child in item.items():
                if not isinstance(key, str) or len(key) > 256:
                    raise FrameError("worker frame has invalid keys")
                pending.append((key, depth + 1))
                pending.append((child, depth + 1))
        else:
            pending.extend((child, depth + 1) for child in item)


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise FrameError("worker frame contains duplicate keys")
        result[key] = value
    return result


def _invalid_constant(_value: str) -> None:
    raise FrameError("worker frame contains a non-finite number")


def read_frame(stream: BinaryIO) -> dict[str, Any] | None:
    """Read at most one bounded line; malformed input terminates the session."""
    line = stream.readline(MAX_FRAME_BYTES + 1)
    if not line:
        return None
    if not isinstance(line, bytes) or len(line) > MAX_FRAME_BYTES or not line.endswith(b"\n"):
        raise FrameError("worker frame exceeds the limit or is incomplete")
    try:
        frame = json.loads(line.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        if isinstance(error, FrameError):
            raise
        raise FrameError("worker frame is not valid JSON") from None
    if not isinstance(frame, dict):
        raise FrameError("worker frame must be an object")
    _validate_json(frame)
    return frame


def validate_control(frame: dict[str, Any], job_id: str, generation: int) -> dict[str, str]:
    """Bind a pipe control to its assigned job, never to an arbitrary path."""
    if (
        type(frame) is not dict or set(frame) != {"protocol", "jobId", "generation", "commandId", "action"}
        or type(frame["protocol"]) is not int or frame["protocol"] != 2
        or not _text(frame["jobId"], 128) or frame["jobId"] != job_id
        or not _integer(frame["generation"]) or frame["generation"] != generation
        or not _text(frame["commandId"], 128)
        or not isinstance(frame["action"], str) or frame["action"] not in {"pause", "cancel"}
    ):
        raise FrameError("worker control does not match the active job")
    return {"command_id": frame["commandId"], "action": frame["action"]}


class EventWriter:
    """Serialize heartbeat and computation events into one increasing stream."""

    def __init__(self, stream: BinaryIO, job_id: str, generation: int) -> None:
        if not _text(job_id, 128) or not _integer(generation):
            raise FrameError("invalid worker identity")
        self._stream = stream
        self._job_id = job_id
        self._generation = generation
        self._seq = 0
        self._broken = False
        self._lock = Lock()

    def emit(self, event_type: str, payload: dict[str, Any]) -> int:
        if not isinstance(event_type, str) or event_type not in EVENT_TYPES or type(payload) is not dict:
            raise FrameError("invalid worker event")
        with self._lock:
            if self._broken:
                raise FrameError("worker event stream is unusable")
            seq = self._seq + 1
            if seq > MAX_SAFE_INTEGER:
                raise FrameError("worker event sequence is exhausted")
            frame = {"protocol": 2, "jobId": self._job_id, "generation": self._generation,
                     "seq": seq, "type": event_type, "payload": payload}
            _validate_json(frame)
            try:
                encoded = json.dumps(frame, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n"
            except (ValueError, UnicodeEncodeError, TypeError):
                raise FrameError("worker event cannot be encoded") from None
            if len(encoded) > MAX_FRAME_BYTES:
                raise FrameError("worker event exceeds the frame limit")
            try:
                pending = memoryview(encoded)
                while pending:
                    written = self._stream.write(pending)
                    if type(written) is not int or not 0 < written <= len(pending):
                        raise FrameError("worker event stream did not accept a complete write")
                    pending = pending[written:]
                self._stream.flush()
            except Exception:
                # Once any I/O failed, a partial frame may already be visible.
                # Never append another event to that ambiguous byte stream.
                self._broken = True
                raise
            self._seq = seq
            return seq
