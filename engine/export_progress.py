"""Best-effort JSONL progress reporting for host-managed export intents.

Progress frames are deliberately kept outside the ordinary request response.
The native host opts in by asking the JSONL server to bind a reporter for one
request.  Export code can then report stage changes without threading an
optional callback through every low-level PDF and publication helper.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import json
import time
from typing import Callable, Iterator, TextIO


EXPORT_PROGRESS_STAGES = frozenset({
    "validating",
    "rendering",
    "writing_pdf",
    "saving",
    "indexing",
    "verifying",
    "finalizing",
})
EXPORT_PROGRESS_INTERVAL_SECONDS = 0.2
EXPORT_PROGRESS_MAX_TOTAL = 100_000
EXPORT_PROGRESS_MAX_FRAMES = 20_000


class ExportProgressReporter:
    """Rate-limited writer for one request's bounded progress frames.

    Reporting is advisory.  A broken progress transport must not turn a
    successful export into a failed export, nor hide the original export
    exception.  Once a write fails the reporter disables itself and leaves the
    request's normal response path untouched.
    """

    def __init__(
        self,
        output: TextIO,
        *,
        clock: Callable[[], float] = time.monotonic,
        interval: float = EXPORT_PROGRESS_INTERVAL_SECONDS,
    ) -> None:
        self._output = output
        self._clock = clock
        self._interval = max(0.0, float(interval))
        self._last_emit: float | None = None
        self._last_stage: str | None = None
        self._disabled = False
        self._emitted_frames = 0

    @property
    def disabled(self) -> bool:
        return self._disabled

    @staticmethod
    def _frame(
        stage: str,
        completed: int | None,
        total: int | None,
        unit: str | None,
    ) -> dict[str, object]:
        if stage not in EXPORT_PROGRESS_STAGES:
            raise ValueError("export progress stage is invalid")
        if completed is None and total is None and unit is None:
            return {
                "type": "export_progress",
                "stage": stage,
                "completed": None,
                "total": None,
                "unit": None,
            }
        if (
            isinstance(completed, bool)
            or not isinstance(completed, int)
            or isinstance(total, bool)
            or not isinstance(total, int)
            or completed < 0
            or total < 1
            or total > EXPORT_PROGRESS_MAX_TOTAL
            or completed > total
            or unit not in {"pages", "files"}
        ):
            raise ValueError("export progress counts are invalid")
        return {
            "type": "export_progress",
            "stage": stage,
            "completed": completed,
            "total": total,
            "unit": unit,
        }

    def report(
        self,
        stage: str,
        completed: int | None = None,
        total: int | None = None,
        unit: str | None = None,
        *,
        force: bool = False,
    ) -> bool:
        """Write one frame when the stage or rate-limit permits it.

        Validation happens before the rate-limit check so callers cannot use
        an invalid frame to silently advance reporter state.  The fixed frame
        shape and bounded integer values keep every emitted line well below
        the host's frame limit.
        """

        try:
            frame = self._frame(stage, completed, total, unit)
        except ValueError:
            # A progress hint is advisory.  If a future caller cannot fit a
            # count into the host contract, preserve the stage while sending
            # an explicitly unknown count instead of failing the export.
            if stage not in EXPORT_PROGRESS_STAGES:
                return False
            frame = self._frame(stage, None, None, None)
        if self._disabled:
            return False
        now = float(self._clock())
        stage_changed = stage != self._last_stage
        if not force and not stage_changed and self._last_emit is not None and now - self._last_emit < self._interval:
            return False
        is_forced_final = stage == "finalizing" and force
        if self._emitted_frames >= EXPORT_PROGRESS_MAX_FRAMES:
            return False
        # Keep one slot available for the operation's mandatory final frame;
        # the native reader rejects a stream that exceeds its frame budget.
        if self._emitted_frames >= EXPORT_PROGRESS_MAX_FRAMES - 1 and not is_forced_final:
            return False
        try:
            self._output.write(json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n")
            self._output.flush()
        except Exception:
            # Progress is a side channel.  Never replace the export's own
            # result or exception because a host channel was closed.
            self._disabled = True
            return False
        self._last_emit = now
        self._last_stage = stage
        self._emitted_frames += 1
        return True


_REPORTER: ContextVar[ExportProgressReporter | None] = ContextVar(
    "export_progress_reporter",
    default=None,
)


@contextmanager
def bind_export_progress_reporter(reporter: ExportProgressReporter | None) -> Iterator[None]:
    """Bind a reporter to the current request context only."""

    token = _REPORTER.set(reporter)
    try:
        yield
    finally:
        _REPORTER.reset(token)


def current_export_progress_reporter() -> ExportProgressReporter | None:
    return _REPORTER.get()


def report_export_progress(
    stage: str,
    completed: int | None = None,
    total: int | None = None,
    unit: str | None = None,
    *,
    force: bool = False,
) -> bool:
    reporter = _REPORTER.get()
    if reporter is None:
        return False
    return reporter.report(stage, completed, total, unit, force=force)
