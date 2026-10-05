"""Narrow checks for the opt-in export progress side channel."""

from __future__ import annotations

from io import StringIO
import json
from pathlib import Path

import pytest
import pymupdf

from engine import engine as engine_module
from engine import export_api, export_publish
from engine.crop import PdfSegment, export_merged_segments
from engine.export_progress import (
    ExportProgressReporter,
    bind_export_progress_reporter,
    current_export_progress_reporter,
    report_export_progress,
)


def _frames(output: StringIO) -> list[dict[str, object]]:
    return [json.loads(line) for line in output.getvalue().splitlines()]


def test_reporter_rate_limits_repeated_stage_but_forces_stage_changes_and_final() -> None:
    now = [0.0]
    output = StringIO()
    reporter = ExportProgressReporter(output, clock=lambda: now[0])

    assert reporter.report("rendering", 0, 4, "pages")
    assert not reporter.report("rendering", 1, 4, "pages")
    now[0] += 0.2
    assert reporter.report("rendering", 1, 4, "pages")
    assert reporter.report("writing_pdf")
    assert reporter.report("finalizing", force=True)

    frames = _frames(output)
    assert [frame["stage"] for frame in frames] == ["rendering", "rendering", "writing_pdf", "finalizing"]
    assert frames[0]["completed"] == 0 and frames[0]["total"] == 4 and frames[0]["unit"] == "pages"
    assert frames[2]["completed"] is None and frames[2]["total"] is None and frames[2]["unit"] is None
    assert all(len(json.dumps(frame, ensure_ascii=False).encode("utf-8")) < 1024 for frame in frames)


@pytest.mark.parametrize(
    "args",
    [
        ("rendering", 0, 1, None),
        ("rendering", True, 1, "pages"),
        ("rendering", 2, 1, "pages"),
        ("rendering", 0, 100001, "pages"),
    ],
)
def test_reporter_downgrades_invalid_count_frames_to_unknown(args: tuple[object, ...]) -> None:
    output = StringIO()
    reporter = ExportProgressReporter(output)
    assert reporter.report(*args)  # type: ignore[arg-type]
    frame = _frames(output)[0]
    assert frame["completed"] is None and frame["total"] is None and frame["unit"] is None


def test_pdf_writer_reports_each_output_page(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    with pymupdf.open() as document:
        for index in range(3):
            page = document.new_page(width=300, height=400)
            page.insert_text((20, 40), f"page {index + 1}")
        document.save(source)
    events: list[tuple[str, int | None]] = []
    output = tmp_path / "output.pdf"
    export_merged_segments(
        output,
        [(source, [PdfSegment(page_number=1, keep_full_page=True), PdfSegment(page_number=2, keep_full_page=True), PdfSegment(page_number=3, keep_full_page=True)])],
        progress=lambda completed: events.append(("page", completed)),
        before_save=lambda: events.append(("before_save", None)),
    )
    assert events == [("page", 1), ("page", 2), ("page", 3), ("before_save", None)]
    with pymupdf.open(output) as document:
        assert document.page_count == 3


def test_serve_removes_progress_flag_and_binds_reporter_without_extra_health_frame(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[dict[str, object]] = []

    def fake_handle(request: object) -> dict[str, object]:
        assert isinstance(request, dict)
        seen.append(request)
        assert current_export_progress_reporter() is not None
        return {"status": "ok"}

    monkeypatch.setattr(engine_module, "handle_request", fake_handle)
    output = StringIO()
    assert engine_module.serve(StringIO('{"op":"health","progress":true}\n'), output) == 0
    assert seen == [{"op": "health"}]
    assert _frames(output) == [{"status": "ok"}]


def test_serve_round_trips_opt_in_create_render_publish_with_synthetic_service(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    class StubService:
        def __init__(self, *_args: object) -> None:
            pass

        def create(self, _scope: object) -> dict[str, object]:
            return {"state": "created"}

        def render(self, _intent_id: str) -> dict[str, object]:
            report_export_progress("rendering", 0, 1, "pages", force=True)
            report_export_progress("rendering", 1, 1, "pages", force=True)
            return {"state": "rendered"}

    def publish(_service: object, _intent_id: str, _directory: object) -> dict[str, object]:
        report_export_progress("saving", 0, 1, "files", force=True)
        report_export_progress("saving", 1, 1, "files", force=True)
        return {"state": "published"}

    monkeypatch.setattr(export_api, "ExportBundleService", StubService)
    monkeypatch.setattr(export_publish, "publish_bundle", publish)
    fields = {
        "batch_database_path": str((tmp_path / "batch.sqlite3").resolve()),
        "review_database_path": str((tmp_path / "review.sqlite3").resolve()),
        "journal_root": str((tmp_path / "journal").resolve()),
        "preview_root": str((tmp_path / "preview").resolve()),
    }
    requests = [
        {"op": "export_intent_create", "scope": {}, **fields, "progress": True},
        {"op": "export_intent_render", "intent_id": "intent", **fields, "progress": True},
        {"op": "export_intent_publish", "intent_id": "intent", "directory": str(tmp_path / "out"), **fields, "progress": True},
    ]
    output = StringIO()
    assert engine_module.serve(StringIO("\n".join(json.dumps(request) for request in requests) + "\n"), output) == 0
    lines = _frames(output)
    progress = [frame for frame in lines if frame.get("type") == "export_progress"]
    responses = [frame for frame in lines if frame.get("status") in {"ok", "error"}]
    assert len(responses) == 3 and all(response["status"] == "ok" for response in responses)
    assert [frame["stage"] for frame in progress].count("validating") == 3
    assert [frame["stage"] for frame in progress].count("finalizing") == 3
    assert "rendering" in [frame["stage"] for frame in progress]
    assert "saving" in [frame["stage"] for frame in progress]


def test_only_create_render_publish_emit_opt_in_frames(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    class StubService:
        def __init__(self, *_args: object) -> None:
            pass

        def create(self, _scope: object) -> dict[str, object]:
            return {"state": "created"}

        def render(self, _intent_id: str) -> dict[str, object]:
            return {"state": "rendered"}

        def describe(self, _intent_id: str) -> dict[str, object]:
            return {"state": "created"}

        def close(self, _intent_id: str) -> dict[str, object]:
            return {"state": "closed"}

        def reconcile(self, _tokens: object) -> dict[str, object]:
            return {"residuals": []}

    monkeypatch.setattr(export_api, "ExportBundleService", StubService)
    fields = {
        "batch_database_path": str((tmp_path / "batch.sqlite3").resolve()),
        "review_database_path": str((tmp_path / "review.sqlite3").resolve()),
        "journal_root": str((tmp_path / "journal").resolve()),
        "preview_root": str((tmp_path / "preview").resolve()),
    }
    request = {"op": "export_intent_describe", "intent_id": "intent" , **fields}
    output = StringIO()
    with bind_export_progress_reporter(ExportProgressReporter(output)):
        response = export_api.handle_export_request(request)
    assert response == {"status": "ok", "data": {"state": "created"}}
    assert _frames(output) == []

    output = StringIO()
    request = {"op": "export_intent_create", "scope": {}, **fields}
    with bind_export_progress_reporter(ExportProgressReporter(output)):
        response = export_api.handle_export_request(request)
    assert response == {"status": "ok", "data": {"state": "created"}}
    assert [frame["stage"] for frame in _frames(output)] == ["validating", "finalizing"]
