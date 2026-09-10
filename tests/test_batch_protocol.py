"""The persistent worker uses bounded frames, separate from legacy JSONL."""

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json

import pytest

from engine.batch_protocol import FrameError, EventWriter, MAX_FRAME_BYTES, read_frame, validate_control


def test_events_are_ordered_flushed_and_use_utf8_byte_limit():
    stream = BytesIO()
    writer = EventWriter(stream, "job", 2)
    assert writer.emit("progress", {"state": "running", "message": "正在分析"}) == 1
    with pytest.raises(FrameError):
        writer.emit("progress", {"message": "税" * (MAX_FRAME_BYTES // 2)})
    assert writer.emit("completed", {"state": "ready_for_review"}) == 2
    stream.seek(0)
    assert read_frame(stream)["seq"] == 1
    assert read_frame(stream)["seq"] == 2
    assert read_frame(stream) is None


def test_threaded_heartbeat_and_progress_do_not_interleave_frames():
    stream = BytesIO()
    writer = EventWriter(stream, "job", 1)
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(lambda page: writer.emit("progress", {"page": page}), range(100)))
    frames = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert [frame["seq"] for frame in frames] == list(range(1, 101))
    assert len({frame["payload"]["page"] for frame in frames}) == 100


@pytest.mark.parametrize("data", [
    b'{"job":"a","job":"b"}\n', b'{"number":NaN}\n', b'{"number":Infinity}\n',
    b'{}', b'[]\n', b'\xff\n', b'{"x":"' + b'x' * MAX_FRAME_BYTES + b'"}\n',
    b'{"x":' + b'[' * 40 + b'0' + b']' * 40 + b'}\n',
], ids=["duplicate-key", "nan", "infinity", "missing-newline", "array", "bad-utf8", "oversized", "deep-json"])
def test_bad_or_oversized_frames_are_rejected(data):
    with pytest.raises(FrameError):
        read_frame(BytesIO(data))


def control(**changes):
    frame = {"protocol": 2, "jobId": "job", "generation": 3, "commandId": "cmd-1", "action": "pause"}
    frame.update(changes)
    return frame


def test_control_is_bound_to_job_generation_and_fixed_actions():
    assert validate_control(control(), "job", 3) == {"command_id": "cmd-1", "action": "pause"}
    for frame in [control(jobId="old"), control(generation=2), control(generation=True),
                  control(action="run_shell"), control(path="anything"), control(commandId="")]:
        with pytest.raises(FrameError):
            validate_control(frame, "job", 3)


def test_event_writer_rejects_unknown_event_and_nonfinite_payload():
    writer = EventWriter(BytesIO(), "job", 1)
    with pytest.raises(FrameError):
        writer.emit("raw_results", {})
    with pytest.raises(FrameError):
        writer.emit("progress", {"count": float("inf")})


@pytest.mark.parametrize("number", ["9007199254740992", "18446744073709551616", "-18446744073709551616",
    "99999999999999999999999999999999999999999999999999", "1e30"])
def test_numeric_range_matches_the_rust_event_reader(number):
    with pytest.raises(FrameError):
        read_frame(BytesIO(('{"counter":' + number + '}\n').encode()))
    with pytest.raises(FrameError):
        EventWriter(BytesIO(), "job", 1).emit("progress", {"counter": float(number)})


class ShortStream(BytesIO):
    def write(self, data):
        return super().write(data[:7])


def test_short_writes_are_completed_before_the_event_is_acknowledged():
    stream = ShortStream()
    writer = EventWriter(stream, "job", 1)
    assert writer.emit("progress", {"message": "正在分析"}) == 1
    stream.seek(0)
    assert read_frame(stream)["payload"] == {"message": "正在分析"}
    assert read_frame(stream) is None


@pytest.mark.parametrize("result", [0, None, -1, True, MAX_FRAME_BYTES])
def test_invalid_write_counts_break_the_stream(result):
    class InvalidStream(BytesIO):
        def write(self, data):
            return result

    writer = EventWriter(InvalidStream(), "job", 1)
    with pytest.raises(FrameError, match="complete write"):
        writer.emit("progress", {})
    with pytest.raises(FrameError, match="unusable"):
        writer.emit("completed", {})


@pytest.mark.parametrize("failure", ["write", "flush"])
def test_io_failure_prevents_any_further_frames(failure):
    class FailingStream(BytesIO):
        def write(self, data):
            if failure == "write" and self.tell():
                raise OSError("test failure")
            return super().write(data[:7] if failure == "write" else data)

        def flush(self):
            if failure == "flush":
                raise OSError("test failure")
            return super().flush()

    stream = FailingStream()
    writer = EventWriter(stream, "job", 1)
    with pytest.raises(OSError):
        writer.emit("progress", {})
    partial = stream.getvalue()
    assert partial
    with pytest.raises(FrameError, match="unusable"):
        writer.emit("completed", {})
    assert stream.getvalue() == partial


def test_shared_containers_are_bounded_before_json_serialization(monkeypatch):
    shared = [0] * 100
    for _ in range(6):
        shared = [shared] * 100

    def unexpected_serialization(*args, **kwargs):
        pytest.fail("an oversized graph reached JSON serialization")

    monkeypatch.setattr(json, "dumps", unexpected_serialization)
    with pytest.raises(FrameError, match="validation budget"):
        EventWriter(BytesIO(), "job", 1).emit("progress", {"shared": shared})


def test_writer_and_reader_use_the_same_envelope_depth_limit():
    stream = BytesIO()
    writer = EventWriter(stream, "job", 1)
    nested = 0
    for _ in range(14):
        nested = [nested]
    assert writer.emit("progress", {"value": nested}) == 1
    with pytest.raises(FrameError, match="deeply nested"):
        writer.emit("progress", {"value": [nested]})
    assert writer.emit("completed", {}) == 2
    stream.seek(0)
    assert read_frame(stream)["seq"] == 1
    assert read_frame(stream)["seq"] == 2


def test_overlong_string_is_rejected_before_encoding():
    class UnencodableString(str):
        def encode(self, *args, **kwargs):
            pytest.fail("oversized string was encoded before checking its length")

    with pytest.raises(FrameError, match="validation budget"):
        EventWriter(BytesIO(), "job", 1).emit("progress", {"value": UnencodableString("x" * MAX_FRAME_BYTES)})
