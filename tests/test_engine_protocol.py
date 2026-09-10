from __future__ import annotations

from dataclasses import replace
import json
import hashlib
import os
import subprocess
import sys
from io import StringIO
from pathlib import Path

import pymupdf
import pytest

import engine.engine as engine_module
from engine.engine import ENGINE_VERSION, handle_request, serve


TEST_EXPORT_TOKEN = "test-export-token-000000000001"


@pytest.fixture(autouse=True)
def isolate_export_ownership_registry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        engine_module,
        "EXPORT_OWNERSHIP_DIR",
        tmp_path / ".export-ownership",
    )


def _source_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_engine_version_matches_current_release() -> None:
    release = json.loads((Path(__file__).parents[1] / "package.json").read_text(encoding="utf-8"))
    assert ENGINE_VERSION == release["version"]


def test_health_request_returns_stable_health_payload() -> None:
    response = handle_request({"op": "health"})

    assert response == {
        "status": "ok",
        "engine": "pdf-search",
        "version": ENGINE_VERSION,
    }


def test_serve_emits_one_json_response_per_request_line() -> None:
    input_stream = StringIO('{"op":"health"}\n{"op":"not-supported"}\n')
    output_stream = StringIO()

    exit_code = serve(input_stream, output_stream)

    assert exit_code == 0
    responses = [json.loads(line) for line in output_stream.getvalue().splitlines()]
    assert responses[0]["status"] == "ok"
    assert responses[0]["engine"] == "pdf-search"
    assert responses[1] == {
        "status": "error",
        "code": "unsupported_operation",
        "message": "unsupported operation",
    }


def test_serve_reports_malformed_json_without_echoing_request() -> None:
    output_stream = StringIO()

    assert serve(StringIO("not-json\n"), output_stream) == 0

    response = json.loads(output_stream.getvalue())
    assert response == {
        "status": "error",
        "code": "invalid_json",
        "message": "request must be valid JSON",
    }


def test_serve_process_supports_health_request_without_startup_noise() -> None:
    engine_path = Path(__file__).parents[1] / "engine" / "engine.py"
    result = subprocess.run(
        [sys.executable, str(engine_path), "--serve"],
        input='{"op":"health"}\n',
        text=True,
        capture_output=True,
        check=True,
    )

    assert result.stderr == ""
    assert json.loads(result.stdout) == {
        "status": "ok",
        "engine": "pdf-search",
        "version": ENGINE_VERSION,
    }


def test_search_request_returns_structured_matches(tmp_path: Path) -> None:
    pdf_path = tmp_path / "search.pdf"
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((50, 80), "收款方：手续费", fontname="china-s")
    document.save(pdf_path)
    document.close()

    response = handle_request({"op": "search", "path": str(pdf_path), "keyword": "手续费"})

    assert response["status"] == "ok"
    assert response["page_count"] == 1
    assert response["source_sha256"] == hashlib.sha256(pdf_path.read_bytes()).hexdigest()
    matches = response["matches"]
    assert isinstance(matches, list)
    assert matches[0]["page"] == 1
    assert matches[0]["matched_field"] == "收款方"


def _write_marker_pdf(path: Path, marker: str) -> None:
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    page.insert_text((40, 80), f"银行客户回单 {marker}", fontname="china-s")
    page.insert_text((40, 150), f"收款方：{marker}", fontname="china-s")
    document.save(path)
    document.close()


def _write_multi_search_pdf(path: Path) -> None:
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    page.insert_text((40, 80), "交易对手：示例实业（深圳）有限公司", fontname="china-s")
    page.insert_text((40, 130), "对方开户行：华夏银行", fontname="china-s")
    document.save(path)
    document.close()


def test_search_multi_returns_clause_tags(tmp_path: Path) -> None:
    pdf_path = tmp_path / "multi.pdf"
    _write_multi_search_pdf(pdf_path)

    response = handle_request(
        {
            "op": "search_multi",
            "path": str(pdf_path),
            "queries": [
                {"id": "include-0", "keyword": "示例实业", "role": "include"},
                {"id": "include-1", "keyword": "华夏银行", "role": "include"},
            ],
            "exact": True,
        }
    )

    assert response["status"] == "ok"
    assert response["page_count"] == 1
    assert response["source_sha256"] == _source_sha256(pdf_path)
    matches = response["matches"]
    assert isinstance(matches, list)
    assert {item["query_id"] for item in matches} == {"include-0", "include-1"}
    assert {item["role"] for item in matches} == {"include"}
    assert all(
        all(field in item for field in ("x0", "y0", "x1", "y1"))
        for item in matches
    )


def test_search_multi_rejects_missing_include_and_duplicate_ids(tmp_path: Path) -> None:
    pdf_path = tmp_path / "multi.pdf"
    _write_multi_search_pdf(pdf_path)

    missing_include = handle_request(
        {
            "op": "search_multi",
            "path": str(pdf_path),
            "queries": [{"id": "exclude-0", "keyword": "退款", "role": "exclude"}],
        }
    )
    assert missing_include["code"] == "empty_include_queries"
    assert missing_include["message"] == "at least one include query is required"

    duplicate_ids = handle_request(
        {
            "op": "search_multi",
            "path": str(pdf_path),
            "queries": [
                {"id": "same", "keyword": "示例实业", "role": "include"},
                {"id": "same", "keyword": "华夏银行", "role": "include"},
            ],
        }
    )
    assert duplicate_ids["code"] == "invalid_queries"
    assert duplicate_ids["message"] == "search queries are invalid"


def test_search_multi_rejects_invalid_query_shapes_and_limits(tmp_path: Path) -> None:
    pdf_path = tmp_path / "multi.pdf"
    _write_multi_search_pdf(pdf_path)

    requests: list[dict[str, object]] = [
        {"op": "search_multi", "path": str(pdf_path), "queries": []},
        {"op": "search_multi", "path": str(pdf_path), "queries": "not-an-array"},
        {
            "op": "search_multi",
            "path": str(pdf_path),
            "queries": [{"id": "query", "keyword": "目标", "role": "other"}],
        },
        {
            "op": "search_multi",
            "path": str(pdf_path),
            "queries": [{"id": "", "keyword": "目标", "role": "include"}],
        },
        {
            "op": "search_multi",
            "path": str(pdf_path),
            "queries": [{"id": "query", "keyword": "  ", "role": "include"}],
        },
        {
            "op": "search_multi",
            "path": str(pdf_path),
            "queries": [
                {"id": str(index), "keyword": "目标", "role": "include"}
                for index in range(33)
            ],
        },
        {
            "op": "search_multi",
            "path": str(pdf_path),
            "queries": [
                {"id": "query", "keyword": "x" * 513, "role": "include"}
            ],
        },
    ]

    for request in requests:
        response = handle_request(request)
        assert response["code"] == "invalid_queries"
        assert response["message"] == "search queries are invalid"
        assert "Traceback" not in response["message"]


def test_search_multi_snapshots_and_scans_source_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pdf_path = tmp_path / "multi.pdf"
    _write_multi_search_pdf(pdf_path)
    snapshot_calls = 0
    iterator_calls = 0
    search_calls = 0
    original_snapshot = engine_module._snapshot_pdf_source
    original_iter_pages = engine_module._iter_pages_with_ocr
    original_search_multi = getattr(engine_module, "search_pages_multi", None)

    def capture_snapshot(*args, **kwargs):
        nonlocal snapshot_calls
        snapshot_calls += 1
        return original_snapshot(*args, **kwargs)

    def capture_iter_pages(path: Path):
        nonlocal iterator_calls
        iterator_calls += 1
        yield from original_iter_pages(path)

    def capture_search_multi(*args, **kwargs):
        nonlocal search_calls
        search_calls += 1
        if original_search_multi is None:
            pytest.fail("search_pages_multi was not exposed by engine.py")
        return original_search_multi(*args, **kwargs)

    monkeypatch.setattr(engine_module, "_snapshot_pdf_source", capture_snapshot)
    monkeypatch.setattr(engine_module, "_iter_pages_with_ocr", capture_iter_pages)
    monkeypatch.setattr(
        engine_module,
        "search_pages_multi",
        capture_search_multi,
        raising=False,
    )

    response = handle_request(
        {
            "op": "search_multi",
            "path": str(pdf_path),
            "queries": [
                {"id": "include-0", "keyword": "示例实业", "role": "include"},
                {"id": "include-1", "keyword": "华夏银行", "role": "include"},
            ],
        }
    )

    assert response["status"] == "ok"
    assert snapshot_calls == 1
    assert iterator_calls == 1
    assert search_calls == 1


def test_search_uses_one_source_snapshot_across_a_b_a_race(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.pdf"
    source_a = tmp_path / "source-a.pdf"
    source_b = tmp_path / "source-b.pdf"
    _write_marker_pdf(source_a, "marker-A")
    _write_marker_pdf(source_b, "marker-B")
    source_a_bytes = source_a.read_bytes()
    source_b_bytes = source_b.read_bytes()
    source.write_bytes(source_a_bytes)
    original_iter_pages = engine_module._iter_pages_with_ocr

    def iter_during_a_b_a_race(path: Path):
        source.write_bytes(source_b_bytes)
        try:
            yield from original_iter_pages(path)
        finally:
            source.write_bytes(source_a_bytes)

    monkeypatch.setattr(engine_module, "_iter_pages_with_ocr", iter_during_a_b_a_race)
    response = handle_request({"op": "search", "path": str(source), "keyword": "marker"})

    assert response["status"] == "ok"
    assert response["source_sha256"] == hashlib.sha256(source_a_bytes).hexdigest()
    assert response["matches"][0]["matched_text"].endswith("marker-A")
    assert source.read_bytes() == source_a_bytes


def test_search_source_snapshot_is_removed_after_request(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.pdf"
    _write_marker_pdf(source, "marker-A")
    observed_snapshots: list[Path] = []
    original_snapshot = engine_module._snapshot_pdf_source

    def capture_snapshot(source_path, expected_sha256, snapshot_directory):
        snapshot = original_snapshot(source_path, expected_sha256, snapshot_directory)
        if not isinstance(snapshot, dict):
            observed_snapshots.append(snapshot.path)
        return snapshot

    monkeypatch.setattr(engine_module, "_snapshot_pdf_source", capture_snapshot)
    response = handle_request({"op": "search", "path": str(source), "keyword": "marker"})

    assert response["status"] == "ok"
    assert observed_snapshots
    assert not observed_snapshots[0].exists()


def test_search_request_rejects_invalid_input() -> None:
    assert handle_request({"op": "search", "path": "missing.pdf", "keyword": "手续费"})["code"] == "file_not_found"
    assert handle_request({"op": "search", "path": "x.pdf", "keyword": ""})["code"] == "empty_keyword"


def test_search_request_returns_stable_error_when_content_budget_is_exceeded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "oversized.pdf"
    document = pymupdf.open()
    document.new_page(width=200, height=200)
    document.save(source)
    document.close()

    def reject_search(*_args, **_kwargs):
        raise engine_module.SearchBudgetExceeded("private parser details")

    monkeypatch.setattr(engine_module, "search_pages", reject_search)

    response = handle_request(
        {"op": "search", "path": str(source), "keyword": "目标"}
    )

    assert response == {
        "status": "error",
        "code": "search_failed",
        "message": "PDF 文本内容超过安全搜索上限",
    }


def test_render_page_request_returns_png_data_url(tmp_path: Path) -> None:
    pdf_path = tmp_path / "preview.pdf"
    document = pymupdf.open()
    page = document.new_page(width=300, height=420)
    page.insert_text((40, 80), "preview")
    document.save(pdf_path)
    document.close()

    response = handle_request({
        "op": "render_page",
        "path": str(pdf_path),
        "page": 1,
        "source_sha256": _source_sha256(pdf_path),
    })

    assert response["status"] == "ok"
    assert response["page"] == 1
    assert response["page_count"] == 1
    assert response["page_width"] == pytest.approx(300)
    assert response["page_height"] == pytest.approx(420)
    assert str(response["image_data"]).startswith("data:image/png;base64,")


def test_inspect_pdf_returns_page_count_and_source_sha256(tmp_path: Path) -> None:
    pdf_path = tmp_path / "inspect.pdf"
    document = pymupdf.open()
    document.new_page()
    document.new_page()
    document.save(pdf_path)
    document.close()
    original_bytes = pdf_path.read_bytes()

    response = handle_request({"op": "inspect_pdf", "path": str(pdf_path)})

    assert response == {
        "status": "ok",
        "page_count": 2,
        "source_sha256": _source_sha256(pdf_path),
    }
    assert pdf_path.read_bytes() == original_bytes


@pytest.mark.parametrize(
    "path_factory",
    [
        lambda tmp_path: tmp_path / "missing.pdf",
        lambda tmp_path: tmp_path / "directory.pdf",
        lambda tmp_path: tmp_path / "document.txt",
    ],
    ids=["missing", "directory", "non-pdf"],
)
def test_inspect_pdf_rejects_missing_directory_and_non_pdf_inputs(
    tmp_path: Path,
    path_factory,
) -> None:
    path = path_factory(tmp_path)
    if path.name == "directory.pdf":
        path.mkdir()
    elif path.name == "document.txt":
        path.write_text("not a PDF", encoding="utf-8")

    response = handle_request({"op": "inspect_pdf", "path": str(path)})

    assert response["status"] == "error"
    assert response["code"] == "invalid_output_path"
    assert isinstance(response["message"], str)


def test_render_page_requires_source_sha256(tmp_path: Path) -> None:
    pdf_path = tmp_path / "preview.pdf"
    _write_marker_pdf(pdf_path, "marker-A")

    response = handle_request({"op": "render_page", "path": str(pdf_path), "page": 1})

    assert response == {
        "status": "error",
        "code": "source_changed",
        "message": "source PDF changed during processing",
    }


def test_render_page_request_rejects_out_of_range_page(tmp_path: Path) -> None:
    pdf_path = tmp_path / "preview.pdf"
    document = pymupdf.open()
    document.new_page()
    document.save(pdf_path)
    document.close()

    response = handle_request({
        "op": "render_page",
        "path": str(pdf_path),
        "page": 2,
        "source_sha256": _source_sha256(pdf_path),
    })

    assert response["code"] == "page_out_of_range"


def test_render_page_uses_one_source_snapshot_across_a_b_a_race(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.pdf"
    source_a = tmp_path / "source-a.pdf"
    source_b = tmp_path / "source-b.pdf"
    _write_marker_pdf(source_a, "marker-A")
    _write_marker_pdf(source_b, "marker-B")
    source_a_bytes = source_a.read_bytes()
    source_b_bytes = source_b.read_bytes()
    source.write_bytes(source_a_bytes)
    seen_paths: list[Path] = []
    original_open = engine_module.pymupdf.open

    def open_during_a_b_a_race(path, *args, **kwargs):
        candidate = Path(str(path)) if isinstance(path, (str, Path)) else None
        if candidate is not None:
            seen_paths.append(candidate)
        if candidate is not None and candidate.resolve() == source.resolve():
            source.write_bytes(source_b_bytes)
            try:
                return original_open(path, *args, **kwargs)
            finally:
                source.write_bytes(source_a_bytes)
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(engine_module.pymupdf, "open", open_during_a_b_a_race)
    response = handle_request({
        "op": "render_page",
        "path": str(source),
        "page": 1,
        "source_sha256": hashlib.sha256(source_a_bytes).hexdigest(),
    })

    assert response["status"] == "ok"
    assert seen_paths
    assert all(path.resolve() != source.resolve() for path in seen_paths)
    assert source.read_bytes() == source_a_bytes


def test_render_page_rejects_source_sha256_mismatch(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    _write_marker_pdf(source, "marker-A")
    original_bytes = source.read_bytes()
    source.write_bytes(source.read_bytes() + b"tampered")

    response = handle_request({
        "op": "render_page",
        "path": str(source),
        "page": 1,
        "source_sha256": hashlib.sha256(original_bytes).hexdigest(),
    })

    assert response == {
        "status": "error",
        "code": "source_changed",
        "message": "source PDF changed during processing",
    }


def test_render_page_rejects_malformed_source_sha256(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    _write_marker_pdf(source, "marker-A")

    response = handle_request({
        "op": "render_page",
        "path": str(source),
        "page": 1,
        "source_sha256": "not-a-sha",
    })

    assert response == {
        "status": "error",
        "code": "source_changed",
        "message": "source PDF changed during processing",
    }


def test_render_page_rejects_extreme_media_box_before_allocating_pixmap(
    tmp_path: Path,
) -> None:
    source = tmp_path / "huge-page.pdf"
    document = pymupdf.open()
    document.new_page(width=14_400, height=14_400)
    document.save(source)
    document.close()

    response = handle_request({
        "op": "render_page",
        "path": str(source),
        "page": 1,
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    })

    assert response == {
        "status": "error",
        "code": "render_failed",
        "message": "PDF page rendering failed",
    }


def _analysis_pdf(tmp_path: Path) -> Path:
    pdf_path = tmp_path / "analysis.pdf"
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    for index, top in enumerate((30, 290, 550), start=1):
        page.insert_text((50, top), "银行客户回单", fontname="china-s")
        page.insert_text((50, top + 90), f"收款方：目标{index}", fontname="china-s")
        page.insert_text((50, top + 120), "打印时间", fontname="china-s")
        page.insert_text((50, top + 150), "交易金额：12345678901234567890", fontname="china-s")
    document.save(pdf_path)
    document.close()
    return pdf_path


def test_analyze_page_requires_source_sha256(tmp_path: Path) -> None:
    pdf_path = _analysis_pdf(tmp_path)

    response = handle_request({
        "op": "analyze_page",
        "path": str(pdf_path),
        "page": 1,
        "matches": [],
    })

    assert response == {
        "status": "error",
        "code": "source_changed",
        "message": "source PDF changed during processing",
    }


def test_analyze_page_rejects_malformed_source_sha256(tmp_path: Path) -> None:
    pdf_path = _analysis_pdf(tmp_path)

    response = handle_request({
        "op": "analyze_page",
        "path": str(pdf_path),
        "page": 1,
        "source_sha256": "unavailable",
        "matches": [],
    })

    assert response == {
        "status": "error",
        "code": "source_changed",
        "message": "source PDF changed during processing",
    }


def test_analyze_page_uses_one_source_snapshot_across_a_b_a_race(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.pdf"
    source_a = tmp_path / "source-a.pdf"
    source_b = tmp_path / "source-b.pdf"
    _write_marker_pdf(source_a, "marker-A")
    _write_marker_pdf(source_b, "marker-B")
    source_a_bytes = source_a.read_bytes()
    source_b_bytes = source_b.read_bytes()
    source.write_bytes(source_a_bytes)
    seen_paths: list[Path] = []
    original_parse = engine_module._parse_pdf_page
    original_geometry = engine_module._analyze_page_geometry

    def parse_during_a_b_a_race(path: Path, page_number: int):
        candidate = Path(path)
        seen_paths.append(candidate)
        if candidate.resolve() == source.resolve():
            source.write_bytes(source_b_bytes)
            try:
                return original_parse(path, page_number)
            finally:
                source.write_bytes(source_a_bytes)
        return original_parse(path, page_number)

    def geometry_during_a_b_a_race(path: Path, page_number: int, parsed):
        seen_paths.append(Path(path))
        return original_geometry(path, page_number, parsed)

    monkeypatch.setattr(engine_module, "_parse_pdf_page", parse_during_a_b_a_race)
    monkeypatch.setattr(engine_module, "_analyze_page_geometry", geometry_during_a_b_a_race)
    response = handle_request({
        "op": "analyze_page",
        "path": str(source),
        "page": 1,
        "source_sha256": hashlib.sha256(source_a_bytes).hexdigest(),
        "matches": [],
    })

    assert response["status"] == "ok"
    assert seen_paths
    assert all(path.resolve() != source.resolve() for path in seen_paths)
    assert source.read_bytes() == source_a_bytes


def _framed_analysis_pdf(tmp_path: Path) -> Path:
    pdf_path = tmp_path / "framed-analysis.pdf"
    document = pymupdf.open()
    page = document.new_page(width=600, height=840)
    frames = ((10, 10, 590, 275), (10, 285, 590, 550), (10, 560, 590, 830))
    for index, (x0, y0, x1, y1) in enumerate(frames, start=1):
        for start, end in (
            ((x0, y0), (x1, y0)),
            ((x1, y0), (x1, y1)),
            ((x1, y1), (x0, y1)),
            ((x0, y1), (x0, y0)),
        ):
            page.draw_line(
                pymupdf.Point(*start),
                pymupdf.Point(*end),
                color=(0, 0, 0),
                width=1,
            )
        page.insert_text((50, y0 + 35), "银行客户回单", fontname="china-s")
        page.insert_text((50, y0 + 90), f"收款方：目标{index}", fontname="china-s")
        page.insert_text((50, y0 + 120), "交易金额：12345678901234567890", fontname="china-s")
        page.insert_text((50, y0 + 150), "打印时间：2026-09-03", fontname="china-s")
    document.save(pdf_path)
    document.close()
    return pdf_path


def test_analyze_page_selects_middle_receipt_for_matching_rect(tmp_path: Path) -> None:
    pdf_path = _analysis_pdf(tmp_path)

    response = handle_request({
        "op": "analyze_page",
        "path": str(pdf_path),
        "page": 1,
        "source_sha256": _source_sha256(pdf_path),
        "matches": [{"x0": 50, "y0": 350, "x1": 200, "y1": 370}],
    })

    assert response["status"] == "ok"
    assert response["page"] == 1
    assert response["page_width"] == pytest.approx(600)
    assert response["page_height"] == pytest.approx(800)
    assert response["source_sha256"] == _source_sha256(pdf_path)
    selections = response["selections"]
    assert isinstance(selections, list)
    assert selections[0]["slot"] == "middle"
    assert selections[0]["rect"]["y0"] < 350


def test_analyze_page_selection_contains_match_and_has_consistent_review_state(tmp_path: Path) -> None:
    pdf_path = _analysis_pdf(tmp_path)

    response = handle_request({
        "op": "analyze_page",
        "path": str(pdf_path),
        "page": 1,
        "source_sha256": _source_sha256(pdf_path),
        "matches": [{"x0": 50, "y0": 350, "x1": 100, "y1": 370}],
    })

    selection = response["selections"][0]
    assert response["status"] == "ok"
    assert selection["match_rect"] == {"x0": 50.0, "y0": 350.0, "x1": 100.0, "y1": 370.0}
    rect = selection["rect"]
    assert rect is not None
    assert 0 <= rect["x0"] < rect["x1"] <= response["page_width"]
    assert 0 <= rect["y0"] < rect["y1"] <= response["page_height"]
    assert rect["x0"] <= selection["match_rect"]["x0"] < selection["match_rect"]["x1"] <= rect["x1"]
    assert rect["y0"] <= selection["match_rect"]["y0"] < selection["match_rect"]["y1"] <= rect["y1"]
    assert 0 <= selection["confidence"] <= 1
    assert isinstance(selection["evidence"], list)
    assert selection["needs_review"] is (selection["confidence"] < 0.9)


def test_analyze_page_marks_visual_budget_overflow_for_manual_review(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pdf_path = _analysis_pdf(tmp_path)

    def reject_visual_analysis(*_args: object, **_kwargs: object) -> list[object]:
        raise engine_module.LayoutBudgetExceeded

    monkeypatch.setattr(
        engine_module,
        "extract_visual_anchors",
        reject_visual_analysis,
    )

    response = handle_request({
        "op": "analyze_page",
        "path": str(pdf_path),
        "page": 1,
        "source_sha256": _source_sha256(pdf_path),
        "matches": [{"x0": 50, "y0": 350, "x1": 100, "y1": 370}],
    })

    assert response["status"] == "ok"
    assert response["page_fully_matched"] is False
    selection = response["selections"][0]
    assert selection["needs_review"] is True
    assert selection["confidence"] <= 0.89
    assert "layout_budget_exceeded" in selection["evidence"]


def test_analyze_page_preserves_match_order_and_count(tmp_path: Path) -> None:
    pdf_path = _analysis_pdf(tmp_path)
    matches = [
        {"x0": 50, "y0": 100, "x1": 100, "y1": 120},
        {"x0": 50, "y0": 350, "x1": 100, "y1": 370},
    ]

    response = handle_request({
        "op": "analyze_page",
        "path": str(pdf_path),
        "page": 1,
        "source_sha256": _source_sha256(pdf_path),
        "matches": matches,
    })

    assert response["status"] == "ok"
    selections = response["selections"]
    assert len(selections) == len(matches)
    assert [selection["slot"] for selection in selections] == ["top", "middle"]
    assert [selection["match_rect"] for selection in selections] == [
        {key: float(value) for key, value in match.items()} for match in matches
    ]


def test_analyze_page_exposes_page_local_candidate_identity(
    tmp_path: Path,
) -> None:
    pdf_path = _analysis_pdf(tmp_path)
    matches = [
        {"x0": 50, "y0": 100, "x1": 100, "y1": 120},
        {"x0": 50, "y0": 350, "x1": 100, "y1": 370},
    ]

    response = handle_request({
        "op": "analyze_page",
        "path": str(pdf_path),
        "page": 1,
        "source_sha256": _source_sha256(pdf_path),
        "matches": matches,
    })

    assert response["status"] == "ok"
    selections = response["selections"]
    assert [selection["candidate_index"] for selection in selections] == [0, 1]
    assert selections[0]["candidate_rect"] != selections[1]["candidate_rect"]
    assert all(
        selection["candidate_rect"] == selection["rect"]
        for selection in selections
    )


def test_analyze_page_marks_full_page_when_every_receipt_is_matched(tmp_path: Path) -> None:
    pdf_path = _analysis_pdf(tmp_path)
    matches = [
        {"x0": 50, "y0": 120, "x1": 100, "y1": 140},
        {"x0": 50, "y0": 380, "x1": 100, "y1": 400},
        {"x0": 50, "y0": 640, "x1": 100, "y1": 660},
    ]

    response = handle_request({
        "op": "analyze_page",
        "path": str(pdf_path),
        "page": 1,
        "source_sha256": _source_sha256(pdf_path),
        "matches": matches,
    })

    assert response["status"] == "ok"
    assert response["page_fully_matched"] is True
    assert all(
        selection["rect"] == {"x0": 0.0, "y0": 0.0, "x1": 600.0, "y1": 800.0}
        for selection in response["selections"]
    )


def test_analyze_page_uses_closed_frames_for_each_single_match(tmp_path: Path) -> None:
    pdf_path = _framed_analysis_pdf(tmp_path)
    cases = (
        ({"x0": 50, "y0": 90, "x1": 180, "y1": 110}, "top", (9, 9, 591, 276)),
        ({"x0": 50, "y0": 365, "x1": 180, "y1": 385}, "middle", (9, 284, 591, 551)),
        ({"x0": 50, "y0": 640, "x1": 180, "y1": 660}, "bottom", (9, 559, 591, 831)),
    )

    for match, expected_slot, expected_rect in cases:
        response = handle_request({
            "op": "analyze_page",
            "path": str(pdf_path),
            "page": 1,
            "source_sha256": _source_sha256(pdf_path),
            "matches": [match],
        })

        assert response["status"] == "ok"
        assert response["page_fully_matched"] is False
        selection = response["selections"][0]
        assert selection["slot"] == expected_slot
        assert selection["rect"] == {
            "x0": float(expected_rect[0]),
            "y0": float(expected_rect[1]),
            "x1": float(expected_rect[2]),
            "y1": float(expected_rect[3]),
        }
        assert "frame" in selection["evidence"]
        assert "page_width" not in selection["evidence"]
        assert expected_rect[1] in selection["snap_points"]
        assert expected_rect[3] in selection["snap_points"]


@pytest.mark.parametrize(
    "rect",
    (
        {"x0": -1, "y0": 350, "x1": 100, "y1": 370},
        {"x0": 100, "y0": 350, "x1": 50, "y1": 370},
        {"x0": 50, "y0": 350, "x1": 50, "y1": 370},
        {"x0": 50, "y0": 350, "x1": 100, "y1": 350},
        {"x0": 50, "y0": 350, "x1": 601, "y1": 370},
        {"x0": 50, "y0": 350, "x1": 100, "y1": 801},
        {"x0": 50, "y0": 350, "x1": float("inf"), "y1": 370},
    ),
)
def test_analyze_page_rejects_non_positive_or_out_of_page_match_rect(
    tmp_path: Path, rect: dict[str, object]
) -> None:
    pdf_path = _analysis_pdf(tmp_path)

    response = handle_request({
        "op": "analyze_page",
        "path": str(pdf_path),
        "page": 1,
        "source_sha256": _source_sha256(pdf_path),
        "matches": [rect],
    })

    assert response == {
        "status": "error",
        "code": "invalid_match_rect",
        "message": "each match must be finite, ordered, and inside the page",
    }


def _multipage_analysis_pdf(tmp_path: Path, page_count: int = 6) -> Path:
    pdf_path = tmp_path / "multipage-analysis.pdf"
    document = pymupdf.open()
    for page_number in range(1, page_count + 1):
        page = document.new_page(width=600, height=800)
        if page_number == page_count:
            page.insert_text((50, 30), "银行客户回单", fontname="china-s")
            page.insert_text((50, 120), "收款方：目标高页", fontname="china-s")
            page.insert_text((50, 150), "交易金额：12345678901234567890", fontname="china-s")
    document.save(pdf_path)
    document.close()
    return pdf_path


def test_analyze_page_loads_only_requested_high_page_without_iterating_all_pages(
    tmp_path: Path, monkeypatch
) -> None:
    pdf_path = _multipage_analysis_pdf(tmp_path)

    def fail_if_iter_pages_called(*args, **kwargs):
        raise AssertionError("analyze_page must not iterate every PDF page")

    monkeypatch.setattr(engine_module, "iter_pages", fail_if_iter_pages_called)
    response = handle_request({
        "op": "analyze_page",
        "path": str(pdf_path),
        "page": 6,
        "source_sha256": _source_sha256(pdf_path),
        "matches": [{"x0": 50, "y0": 100, "x1": 100, "y1": 120}],
    })

    assert response["status"] == "ok"
    assert response["page"] == 6
    assert len(response["selections"]) == 1


def test_analyze_page_rejects_page_after_document_page_count(tmp_path: Path) -> None:
    pdf_path = _analysis_pdf(tmp_path)

    response = handle_request({
        "op": "analyze_page",
        "path": str(pdf_path),
        "page": 2,
        "source_sha256": _source_sha256(pdf_path),
        "matches": [],
    })

    assert response == {
        "status": "error",
        "code": "page_out_of_range",
        "message": "page is out of range",
    }


def test_analyze_page_hides_corrupt_pdf_error_details(tmp_path: Path) -> None:
    pdf_path = tmp_path / "sensitive-bank-statement.pdf"
    pdf_path.write_bytes(b"not a PDF")

    response = handle_request({
        "op": "analyze_page",
        "path": str(pdf_path),
        "page": 1,
        "source_sha256": _source_sha256(pdf_path),
        "matches": [],
    })

    encoded_response = json.dumps(response, ensure_ascii=False)
    assert response["status"] == "error"
    assert response["code"] == "analyze_failed"
    assert response["message"] == "PDF page analysis failed"
    assert pdf_path.name not in encoded_response
    assert str(pdf_path) not in encoded_response


def test_analyze_page_rejects_non_array_matches(tmp_path: Path) -> None:
    pdf_path = _analysis_pdf(tmp_path)

    response = handle_request({
        "op": "analyze_page",
        "path": str(pdf_path),
        "page": 1,
        "source_sha256": _source_sha256(pdf_path),
        "matches": {"x0": 50, "y0": 350, "x1": 200, "y1": 370},
    })

    assert response == {
        "status": "error",
        "code": "invalid_matches",
        "message": "matches must be an array",
    }


@pytest.mark.parametrize(
    "rect",
    (
        {"x0": 50, "y0": 350, "x1": 200},
        {"x0": 50, "y0": 350, "x1": "200", "y1": 370},
        {"x0": 50, "y0": float("nan"), "x1": 200, "y1": 370},
    ),
)
def test_analyze_page_rejects_invalid_match_rect(tmp_path: Path, rect: dict[str, object]) -> None:
    pdf_path = _analysis_pdf(tmp_path)

    response = handle_request({
        "op": "analyze_page",
        "path": str(pdf_path),
        "page": 1,
        "source_sha256": _source_sha256(pdf_path),
        "matches": [rect],
    })

    assert response == {
        "status": "error",
        "code": "invalid_match_rect",
        "message": "each match must be finite, ordered, and inside the page",
    }


@pytest.mark.parametrize("page", (0, True, "1"))
def test_analyze_page_rejects_invalid_page(tmp_path: Path, page: object) -> None:
    pdf_path = _analysis_pdf(tmp_path)

    response = handle_request({
        "op": "analyze_page",
        "path": str(pdf_path),
        "page": page,
        "matches": [],
    })

    assert response == {
        "status": "error",
        "code": "invalid_page",
        "message": "page must be a positive integer",
    }


def test_search_request_uses_ocr_for_scanned_page(tmp_path: Path, monkeypatch) -> None:
    pdf_path = tmp_path / "scan.pdf"
    document = pymupdf.open()
    document.new_page(width=300, height=300)
    document.save(pdf_path)
    document.close()
    monkeypatch.setattr(engine_module, "is_scanned_page", lambda page: True)
    monkeypatch.setattr(engine_module, "render_page_to_png", lambda *args, **kwargs: tmp_path / "page.png")
    monkeypatch.setattr(engine_module, "recognize_image", lambda *args, **kwargs: [{"text": "手续费", "confidence": 0.71, "box": [20, 30, 140, 55]}])

    response = handle_request({"op": "search", "path": str(pdf_path), "keyword": "手续费"})

    assert response["status"] == "ok"
    assert response["matches"][0]["matched_text"] == "手续费"
    assert response["matches"][0]["needs_review"] is True
    assert response["matches"][0]["x0"] == pytest.approx(7.2)


def test_export_index_request_writes_xlsx(tmp_path: Path) -> None:
    output = tmp_path / "review-index.xlsx"
    response = handle_request({
        "op": "export_index",
        "output_path": str(output),
        "export_token": TEST_EXPORT_TOKEN,
        "rows": [{"source_file": "sample.pdf", "source_page": 3, "review_status": "approved"}],
    })
    assert response["status"] == "ok"
    assert response["row_count"] == 1
    assert output.exists()


def test_export_index_rejects_nul_output_path_without_crashing(tmp_path: Path) -> None:
    output_path = str(tmp_path / "invalid\x00directory" / "result.xlsx")

    response = handle_request({
        "op": "export_index",
        "output_path": output_path,
        "export_token": TEST_EXPORT_TOKEN,
        "rows": [],
    })

    assert response == {
        "status": "error",
        "code": "invalid_output_path",
        "message": "output path is invalid",
    }


def test_export_pdf_rejects_nul_output_path_without_crashing(tmp_path: Path) -> None:
    output_path = str(tmp_path / "invalid\x00directory" / "result.pdf")

    response = handle_request({
        "op": "export_pdf",
        "output_path": output_path,
        "export_token": TEST_EXPORT_TOKEN,
        "selections": [],
    })

    assert response == {
        "status": "error",
        "code": "invalid_output_path",
        "message": "output path is invalid",
    }


def test_export_index_request_requires_export_token(tmp_path: Path) -> None:
    output = tmp_path / "token-required.xlsx"

    response = handle_request({
        "op": "export_index",
        "output_path": str(output),
        "rows": [{"source_file": "sample.pdf", "source_page": 1, "review_status": "confirmed"}],
    })

    assert response == {
        "status": "error",
        "code": "export_token_required",
        "message": "export token is required",
    }


def test_cleanup_exports_only_removes_outputs_owned_by_token(tmp_path: Path) -> None:
    index = tmp_path / "source.pdf-search-index.xlsx"
    pdf = tmp_path / "source.pdf-search-results.pdf"
    index.write_bytes(b"old-index")
    pdf.write_bytes(b"old-pdf")

    response = handle_request({
        "op": "cleanup_exports",
        "export_token": "export-token-security-test-001",
        "paths": [str(index), str(pdf)],
    })

    assert response == {"status": "ok", "cleaned_count": 0}
    assert index.read_bytes() == b"old-index"
    assert pdf.read_bytes() == b"old-pdf"


def test_release_exports_forgets_ownership_without_deleting_published_output(
    tmp_path: Path,
) -> None:
    token = "release-export-ownership-token-001"
    output = tmp_path / "published.xlsx"
    export = handle_request(
        {
            "op": "export_index",
            "output_path": str(output),
            "export_token": token,
            "rows": [
                {
                    "source_file": "sample.pdf",
                    "source_page": 1,
                    "review_status": "confirmed",
                }
            ],
        }
    )
    assert export["status"] == "ok"
    assert output.is_file()
    assert engine_module._ownership_manifest_path(token).is_file()

    release = handle_request({"op": "release_exports", "export_token": token})

    assert release == {"status": "ok", "released_count": 1}
    assert output.is_file()
    assert not engine_module._ownership_manifest_path(token).exists()
    assert handle_request(
        {"op": "cleanup_exports", "export_token": token}
    ) == {"status": "ok", "cleaned_count": 0}


def test_export_index_does_not_replace_preexisting_output(tmp_path: Path) -> None:
    output = tmp_path / "preexisting.xlsx"
    output.write_bytes(b"do-not-replace")

    response = handle_request({
        "op": "export_index",
        "output_path": str(output),
        "export_token": "export-token-security-test-002",
        "rows": [{"source_file": "sample.pdf", "source_page": 1, "review_status": "confirmed"}],
    })

    assert response == {
        "status": "error",
        "code": "output_exists",
        "message": "导出文件已存在，请更换输出位置后重试",
    }
    assert output.read_bytes() == b"do-not-replace"


def test_publish_new_file_rejects_unsafe_hard_link_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    temporary_path = tmp_path / "staging.tmp"
    output = tmp_path / "result.xlsx"
    temporary_path.write_bytes(b"trusted")
    original_replace = engine_module.os.replace

    def fail_hard_link(*_args: object, **_kwargs: object) -> None:
        raise OSError("simulated hard-link unavailability")

    def fail_rename(*_args: object, **_kwargs: object) -> None:
        raise OSError("simulated rename unavailability")

    def racing_replace(source: object, destination: object) -> None:
        Path(destination).write_bytes(b"foreign")
        original_replace(source, destination)

    monkeypatch.setattr(engine_module.os, "link", fail_hard_link)
    monkeypatch.setattr(engine_module.os, "rename", fail_rename)
    monkeypatch.setattr(engine_module.os, "replace", racing_replace)

    with pytest.raises(engine_module.ExportOwnershipError) as raised:
        engine_module._publish_new_file(temporary_path, output)

    assert raised.value.code == "export_failed"
    assert not output.exists()
    assert temporary_path.read_bytes() == b"trusted"


@pytest.mark.skipif(os.name != "nt", reason="Windows rename semantics are platform-specific")
def test_publish_new_file_uses_no_replace_rename_when_hard_link_unavailable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    temporary_path = tmp_path / "staging.tmp"
    output = tmp_path / "result.xlsx"
    temporary_path.write_bytes(b"trusted")

    def fail_hard_link(*_args: object, **_kwargs: object) -> None:
        raise OSError("simulated hard-link unavailability")

    def unexpected_replace(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("unsafe replacement fallback must not run")

    monkeypatch.setattr(engine_module.os, "link", fail_hard_link)
    monkeypatch.setattr(engine_module.os, "replace", unexpected_replace)

    engine_module._publish_new_file(temporary_path, output)

    assert output.read_bytes() == b"trusted"
    assert not temporary_path.exists()


@pytest.mark.skipif(os.name != "nt", reason="Windows rename semantics are platform-specific")
def test_publish_new_file_rename_race_preserves_existing_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    temporary_path = tmp_path / "staging.tmp"
    output = tmp_path / "result.xlsx"
    temporary_path.write_bytes(b"trusted")
    original_rename = engine_module.os.rename

    def racing_rename(source: object, destination: object) -> None:
        Path(destination).write_bytes(b"foreign")
        original_rename(source, destination)

    monkeypatch.setattr(engine_module.os, "rename", racing_rename)

    with pytest.raises(engine_module.ExportOwnershipError) as raised:
        engine_module._publish_new_file(temporary_path, output)

    assert raised.value.code == "output_exists"
    assert output.read_bytes() == b"foreign"
    assert temporary_path.read_bytes() == b"trusted"


def test_export_index_hides_internal_failure_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    output = tmp_path / "private-output.xlsx"
    secret_path = str(tmp_path / "should-not-be-disclosed.xlsx")

    def fail_export(*_args: object, **_kwargs: object) -> Path:
        raise OSError(secret_path)

    monkeypatch.setattr(engine_module, "export_index", fail_export)

    response = handle_request({
        "op": "export_index",
        "output_path": str(output),
        "export_token": "export-token-security-test-003",
        "rows": [{"source_file": "sample.pdf", "source_page": 1, "review_status": "confirmed"}],
    })

    assert response == {
        "status": "error",
        "code": "export_failed",
        "message": "XLSX 索引导出失败",
    }
    assert secret_path not in str(response)


def test_export_pdf_does_not_replace_preexisting_output(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    document = pymupdf.open()
    document.new_page(width=200, height=200)
    document.save(source)
    document.close()
    output = tmp_path / "preexisting.pdf"
    output.write_bytes(b"do-not-replace")

    response = handle_request({
        "op": "export_pdf",
        "output_path": str(output),
        "export_token": "export-token-security-test-004",
        "selections": [{
            "source_path": str(source),
            "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "segments": [{"page_number": 1, "segment_no": 1, "keep_full_page": True, "review_status": "confirmed"}],
        }],
    })

    assert response == {
        "status": "error",
        "code": "output_exists",
        "message": "导出文件已存在，请更换输出位置后重试",
    }
    assert output.read_bytes() == b"do-not-replace"


def test_cleanup_does_not_remove_output_replaced_after_export(tmp_path: Path) -> None:
    token = "cleanup-replacement-token-001"
    output = tmp_path / "replace-me.xlsx"
    exported = handle_request({
        "op": "export_index",
        "output_path": str(output),
        "export_token": token,
        "rows": [{"source_file": "sample.pdf", "source_page": 1, "review_status": "confirmed"}],
    })
    assert exported["status"] == "ok"
    output.write_bytes(b"user-owned-content")

    cleanup = handle_request({"op": "cleanup_exports", "export_token": token})

    assert cleanup == {
        "status": "error",
        "code": "cleanup_failed",
        "message": "导出文件清理失败，请稍后重试",
    }
    assert output.read_bytes() == b"user-owned-content"
    assert not engine_module._ownership_manifest_path(token).exists()


def test_cleanup_keeps_manifest_when_unlink_is_temporarily_unavailable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = "cleanup-retryable-unlink-token-001"
    output = tmp_path / "retryable.xlsx"
    exported = handle_request({
        "op": "export_index",
        "output_path": str(output),
        "export_token": token,
        "rows": [{"source_file": "sample.pdf", "source_page": 1, "review_status": "confirmed"}],
    })
    assert exported["status"] == "ok"
    original_unlink = engine_module._unlink_owned_file

    monkeypatch.setattr(engine_module, "_unlink_owned_file", lambda *_args: False)
    first_cleanup = handle_request({"op": "cleanup_exports", "export_token": token})

    assert first_cleanup == {
        "status": "error",
        "code": "cleanup_failed",
        "message": "导出文件清理失败，请稍后重试",
    }
    assert output.exists()
    assert engine_module._ownership_manifest_path(token).exists()

    monkeypatch.setattr(engine_module, "_unlink_owned_file", original_unlink)
    second_cleanup = handle_request({"op": "cleanup_exports", "export_token": token})

    assert second_cleanup == {"status": "ok", "cleaned_count": 1}
    assert not output.exists()
    assert not engine_module._ownership_manifest_path(token).exists()


@pytest.mark.parametrize("failure_target", ("stat", "sha256"))
def test_cleanup_retries_after_transient_ownership_read_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_target: str,
) -> None:
    token = f"cleanup-transient-{failure_target}-token-001"
    output = tmp_path / f"transient-{failure_target}.xlsx"
    exported = handle_request({
        "op": "export_index",
        "output_path": str(output),
        "export_token": token,
        "rows": [{"source_file": "sample.pdf", "source_page": 1, "review_status": "confirmed"}],
    })
    assert exported["status"] == "ok"

    failed_once = True
    if failure_target == "sha256":
        original_sha256 = engine_module._file_sha256

        def fail_sha256_once(path: Path) -> str:
            nonlocal failed_once
            if failed_once:
                failed_once = False
                raise PermissionError("temporary hash read denial")
            return original_sha256(path)

        monkeypatch.setattr(engine_module, "_file_sha256", fail_sha256_once)
    else:
        original_stat = Path.stat

        def fail_stat_once(path: Path, *args: object, **kwargs: object) -> object:
            nonlocal failed_once
            if path == output and failed_once:
                failed_once = False
                raise PermissionError("temporary stat denial")
            return original_stat(path, *args, **kwargs)

        monkeypatch.setattr(Path, "stat", fail_stat_once)

    first_cleanup = handle_request({"op": "cleanup_exports", "export_token": token})

    assert first_cleanup == {
        "status": "error",
        "code": "cleanup_failed",
        "message": "导出文件清理失败，请稍后重试",
    }
    assert output.exists()
    assert engine_module._ownership_manifest_path(token).exists()

    if failure_target == "sha256":
        monkeypatch.setattr(engine_module, "_file_sha256", original_sha256)
    else:
        monkeypatch.setattr(Path, "stat", original_stat)

    second_cleanup = handle_request({"op": "cleanup_exports", "export_token": token})

    assert second_cleanup == {"status": "ok", "cleaned_count": 1}
    assert not output.exists()
    assert not engine_module._ownership_manifest_path(token).exists()


def test_cleanup_does_not_remove_file_replaced_after_identity_check(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = "cleanup-race-replacement-token-001"
    output = tmp_path / "race-replace-me.xlsx"
    exported = handle_request({
        "op": "export_index",
        "output_path": str(output),
        "export_token": token,
        "rows": [{"source_file": "sample.pdf", "source_page": 1, "review_status": "confirmed"}],
    })
    assert exported["status"] == "ok"
    original_is_owned_file = engine_module._is_owned_file
    replaced = False

    def replace_after_identity_check(path: Path, identity: object) -> bool:
        nonlocal replaced
        owned = original_is_owned_file(path, identity)
        if owned and not replaced:
            path.unlink()
            path.write_bytes(b"foreign-file")
            replaced = True
        return owned

    monkeypatch.setattr(engine_module, "_is_owned_file", replace_after_identity_check)

    cleanup = handle_request({"op": "cleanup_exports", "export_token": token})

    assert cleanup == {
        "status": "error",
        "code": "cleanup_failed",
        "message": "导出文件清理失败，请稍后重试",
    }
    assert output.read_bytes() == b"foreign-file"
    assert not engine_module._ownership_manifest_path(token).exists()


def test_export_index_does_not_register_file_replaced_before_mark(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output = tmp_path / "publish-mark-race.xlsx"
    token = "publish-mark-race-" + hashlib.sha256(str(output).encode()).hexdigest()[:24]
    original_publish = engine_module._publish_new_file

    def publish_then_replace(temporary_path: Path, destination: Path) -> None:
        original_publish(temporary_path, destination)
        destination.write_bytes(b"foreign-file")

    monkeypatch.setattr(engine_module, "_publish_new_file", publish_then_replace)

    response = handle_request({
        "op": "export_index",
        "output_path": str(output),
        "export_token": token,
        "rows": [{"source_file": "sample.pdf", "source_page": 1, "review_status": "confirmed"}],
    })

    assert response == {
        "status": "error",
        "code": "ownership_lost",
        "message": "导出文件登记已失效，请重试",
    }
    assert output.read_bytes() == b"foreign-file"
    cleanup = handle_request({"op": "cleanup_exports", "export_token": token})
    assert cleanup == {"status": "ok", "cleaned_count": 0}
    assert output.read_bytes() == b"foreign-file"


@pytest.mark.skipif(os.name != "nt", reason="Windows handle semantics are platform-specific")
def test_cleanup_preserves_same_identity_file_when_bytes_change_after_check(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = "cleanup-same-identity-mutation-token-001"
    output = tmp_path / "same-identity.xlsx"
    exported = handle_request({
        "op": "export_index",
        "output_path": str(output),
        "export_token": token,
        "rows": [{"source_file": "sample.pdf", "source_page": 1, "review_status": "confirmed"}],
    })
    assert exported["status"] == "ok"
    original_bytes = output.read_bytes()
    original_is_owned_file = engine_module._is_owned_file
    mutated = False

    def mutate_after_identity_check(path: Path, identity: object) -> bool:
        nonlocal mutated
        owned = original_is_owned_file(path, identity)
        if owned and not mutated:
            file_stat = path.stat()
            with path.open("r+b") as handle:
                first_byte = handle.read(1)
                handle.seek(0)
                handle.write(bytes([first_byte[0] ^ 0x01]))
            os.utime(path, ns=(file_stat.st_atime_ns, file_stat.st_mtime_ns))
            mutated = True
        return owned

    monkeypatch.setattr(engine_module, "_is_owned_file", mutate_after_identity_check)

    cleanup = handle_request({"op": "cleanup_exports", "export_token": token})

    assert cleanup == {
        "status": "error",
        "code": "cleanup_failed",
        "message": "导出文件清理失败，请稍后重试",
    }
    assert output.exists()
    assert output.read_bytes() != original_bytes
    assert not engine_module._ownership_manifest_path(token).exists()


def test_export_index_request_accepts_confirmed_review_status(tmp_path: Path) -> None:
    output = tmp_path / "confirmed-index.xlsx"
    response = handle_request({
        "op": "export_index",
        "output_path": str(output),
        "export_token": TEST_EXPORT_TOKEN,
        "rows": [{"source_file": "sample.pdf", "source_page": 1, "review_status": "confirmed"}],
    })

    assert response == {"status": "ok", "output_path": str(output), "row_count": 1}
    assert output.exists()


def test_cleanup_request_removes_registered_outputs_only(tmp_path: Path) -> None:
    index = tmp_path / "source.pdf-search-index.xlsx"
    pdf = tmp_path / "source.pdf-search-results.pdf"
    unrelated = tmp_path / "keep.xlsx"
    exported = handle_request({
        "op": "export_index",
        "output_path": str(index),
        "export_token": "cleanup-export-token-000000001",
        "rows": [{"source_file": "sample.pdf", "source_page": 1, "review_status": "confirmed"}],
    })
    assert exported["status"] == "ok"
    pdf.write_bytes(b"pdf")
    unrelated.write_bytes(b"keep")

    response = handle_request({
        "op": "cleanup_exports",
        "export_token": "cleanup-export-token-000000001",
        "paths": [str(index), str(pdf)],
    })

    assert response == {"status": "ok", "cleaned_count": 1}
    assert not index.exists()
    assert pdf.exists()
    assert unrelated.exists()


def test_cleanup_request_removes_created_pdf_and_xlsx_for_same_token(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    document = pymupdf.open()
    document.new_page(width=200, height=200)
    document.save(source)
    document.close()
    token = "cleanup-both-token-000000001"
    index = tmp_path / "result.xlsx"
    pdf = tmp_path / "result.pdf"

    index_result = handle_request({
        "op": "export_index",
        "output_path": str(index),
        "export_token": token,
        "rows": [{"source_file": source.name, "source_page": 1, "review_status": "confirmed"}],
    })
    pdf_result = handle_request({
        "op": "export_pdf",
        "output_path": str(pdf),
        "export_token": token,
        "selections": [{
            "source_path": str(source),
            "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "segments": [{"page_number": 1, "segment_no": 1, "keep_full_page": True, "review_status": "confirmed"}],
        }],
    })
    assert index_result["status"] == "ok"
    assert pdf_result["status"] == "ok"

    cleanup = handle_request({"op": "cleanup_exports", "export_token": token})

    assert cleanup == {"status": "ok", "cleaned_count": 2}
    assert not index.exists()
    assert not pdf.exists()


def test_export_index_request_rejects_non_xlsx(tmp_path: Path) -> None:
    response = handle_request({"op": "export_index", "output_path": str(tmp_path / "index.csv"), "export_token": TEST_EXPORT_TOKEN, "rows": []})
    assert response["code"] == "unsupported_output"


def test_export_index_request_rejects_unreviewed_rows(tmp_path: Path) -> None:
    response = handle_request({
        "op": "export_index",
        "output_path": str(tmp_path / "index.xlsx"),
        "export_token": TEST_EXPORT_TOKEN,
        "rows": [{"review_status": "pending"}],
    })
    assert response["code"] == "unreviewed_rows"


def test_ocr_health_request_is_non_destructive() -> None:
    response = handle_request({"op": "ocr_health"})
    assert response["status"] == "ok"
    assert response["engine"] == "paddleocr"
    assert isinstance(response["available"], bool)


def test_ocr_cache_info_dispatches_a_path_free_occupancy_dto(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake_cache_info() -> dict[str, object]:
        calls.append("info")
        return {
            "status": "ok",
            "available": True,
            "entries": 4,
            "bytes": 12_345,
            "max_bytes": 268_435_456,
            "retention_days": 30,
            "path": r"C:\private\ocr-cache",
            "text": "OCR output must not cross the protocol boundary",
        }

    monkeypatch.setattr(engine_module, "ocr_cache_info", fake_cache_info)

    response = handle_request({"op": "ocr_cache_info"})

    assert response == {
        "status": "ok",
        "available": True,
        "entries": 4,
        "bytes": 12_345,
        "max_bytes": 268_435_456,
        "retention_days": 30,
    }
    assert calls == ["info"]


def test_ocr_cache_clear_dispatches_a_path_free_result_with_counts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake_clear_cache() -> dict[str, object]:
        calls.append("clear")
        return {
            "status": "ok",
            "available": True,
            "entries": 0,
            "bytes": 0,
            "max_bytes": 268_435_456,
            "retention_days": 30,
            "removed_entries": 4,
            "failed_entries": 1,
            "path": r"C:\private\ocr-cache",
        }

    monkeypatch.setattr(engine_module, "ocr_cache_clear", fake_clear_cache)

    response = handle_request({"op": "ocr_cache_clear"})

    assert response == {
        "status": "ok",
        "available": True,
        "entries": 0,
        "bytes": 0,
        "max_bytes": 268_435_456,
        "retention_days": 30,
        "removed_entries": 4,
        "failed_entries": 1,
    }
    assert calls == ["clear"]


@pytest.mark.parametrize("operation", ["ocr_cache_info", "ocr_cache_clear"])
def test_ocr_cache_operations_reject_extra_request_fields(
    operation: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(engine_module, "ocr_cache_info", lambda: pytest.fail("cache info must not run"))
    monkeypatch.setattr(engine_module, "ocr_cache_clear", lambda: pytest.fail("cache clear must not run"))

    response = handle_request({"op": operation, "path": r"C:\private\ocr-cache"})

    assert response["status"] == "error"
    assert response["code"] == "invalid_request"


def test_ocr_cache_failure_degrades_to_available_false_without_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        engine_module,
        "ocr_cache_info",
        lambda: (_ for _ in ()).throw(OSError(r"C:\private\ocr-cache\secret.txt")),
    )

    response = handle_request({"op": "ocr_cache_info"})

    assert response == {
        "status": "ok",
        "available": False,
        "entries": 0,
        "bytes": 0,
        "max_bytes": 268_435_456,
        "retention_days": 30,
    }
    assert "private" not in json.dumps(response)
    assert "secret" not in json.dumps(response)


def test_export_pdf_request_merges_reviewed_pages(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    document = pymupdf.open()
    document.new_page(width=200, height=200)
    document.save(source)
    document.close()
    output = tmp_path / "result.pdf"
    response = handle_request({
        "op": "export_pdf",
        "output_path": str(output),
        "export_token": TEST_EXPORT_TOKEN,
        "selections": [{
            "source_path": str(source),
            "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "segments": [{"page_number": 1, "segment_no": 1, "keep_full_page": True, "review_status": "confirmed"}],
        }],
    })
    assert response["status"] == "ok"
    assert response["page_count"] == 1
    assert response["sha256"] == hashlib.sha256(output.read_bytes()).hexdigest()
    result_document = pymupdf.open(output)
    assert result_document.page_count == 1
    result_document.close()


def test_export_pdf_allows_the_same_segment_number_on_different_pages(tmp_path: Path) -> None:
    source = tmp_path / "multi-page.pdf"
    document = pymupdf.open()
    document.new_page(width=200, height=200)
    document.new_page(width=200, height=200)
    document.save(source)
    document.close()
    output = tmp_path / "result.pdf"

    response = handle_request({
        "op": "export_pdf",
        "output_path": str(output),
        "export_token": "cross-page-segment-token-001",
        "selections": [{
            "source_path": str(source),
            "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "segments": [
                {"page_number": 1, "segment_no": 1, "keep_full_page": True, "review_status": "confirmed"},
                {"page_number": 2, "segment_no": 1, "keep_full_page": True, "review_status": "confirmed"},
            ],
        }],
    })

    assert response["status"] == "ok"
    assert response["page_count"] == 2
    result_document = pymupdf.open(output)
    assert result_document.page_count == 2
    result_document.close()


def _export_owned_preview(tmp_path: Path, token: str) -> Path:
    source = tmp_path / f"source-{token[-3:]}.pdf"
    document = pymupdf.open()
    page = document.new_page(width=200, height=200)
    page.insert_text((20, 40), "receipt")
    document.save(source)
    document.close()
    preview = tmp_path / "cache" / f"{token}.pdf"
    exported = handle_request({
        "op": "export_pdf",
        "output_path": str(preview),
        "export_token": token,
        "selections": [{
            "source_path": str(source),
            "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "segments": [{
                "page_number": 1,
                "segment_no": 1,
                "keep_full_page": True,
                "review_status": "confirmed",
            }],
        }],
    })
    assert exported["status"] == "ok"
    return preview


def test_publish_preview_pdf_copies_exact_owned_bytes_and_keeps_cleanup_isolated(tmp_path: Path) -> None:
    preview_token = "preview-token-security-test-001"
    final_token = "final-token-security-test-00001"
    preview = _export_owned_preview(tmp_path, preview_token)
    output = tmp_path / "chosen" / "result.pdf"

    published = handle_request({
        "op": "publish_preview_pdf",
        "preview_path": str(preview),
        "output_path": str(output),
        "preview_token": preview_token,
        "final_token": final_token,
    })

    assert published["status"] == "ok"
    assert output.read_bytes() == preview.read_bytes()
    assert published["sha256"] == hashlib.sha256(output.read_bytes()).hexdigest()
    cleanup = handle_request({"op": "cleanup_exports", "export_token": final_token})
    assert cleanup == {"status": "ok", "cleaned_count": 1}
    assert preview.exists()
    assert not output.exists()


def test_publish_preview_pdf_cleans_staging_after_hard_link_unlink_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    preview_token = "preview-token-staging-cleanup-test-001"
    final_token = "final-token-staging-cleanup-test-00001"
    preview = _export_owned_preview(tmp_path, preview_token)
    output = tmp_path / "chosen" / "result.pdf"
    original_publish = engine_module._publish_new_file
    original_unlink = Path.unlink
    original_rename = engine_module.os.rename

    def publish_with_transient_staging_unlink_failure(
        temporary_path: Path,
        destination: Path,
    ) -> None:
        def fail_rename(*_args: object, **_kwargs: object) -> None:
            raise OSError("simulated staging rename unavailability")

        def flaky_unlink(path: Path, *args: object, **kwargs: object) -> None:
            if path == temporary_path:
                raise OSError("simulated transient staging unlink failure")
            original_unlink(path, *args, **kwargs)

        monkeypatch.setattr(engine_module.os, "rename", fail_rename)
        monkeypatch.setattr(Path, "unlink", flaky_unlink)
        try:
            original_publish(temporary_path, destination)
        finally:
            monkeypatch.setattr(Path, "unlink", original_unlink)
            monkeypatch.setattr(engine_module.os, "rename", original_rename)

    monkeypatch.setattr(engine_module, "_publish_new_file", publish_with_transient_staging_unlink_failure)
    try:
        published = handle_request({
            "op": "publish_preview_pdf",
            "preview_path": str(preview),
            "output_path": str(output),
            "preview_token": preview_token,
            "final_token": final_token,
        })

        assert published["status"] == "ok"
        assert output.exists()
        assert list(output.parent.glob(f".{output.stem}-*")) == []
    finally:
        handle_request({"op": "cleanup_exports", "export_token": final_token})
        handle_request({"op": "cleanup_exports", "export_token": preview_token})


def test_publish_preview_pdf_rejects_nul_output_path_without_crashing(tmp_path: Path) -> None:
    preview_token = "preview-token-nul-path-test-001"
    final_token = "final-token-nul-path-test-00001"
    preview = _export_owned_preview(tmp_path, preview_token)
    output_path = str(tmp_path / "invalid\x00directory" / "result.pdf")

    try:
        response = handle_request({
            "op": "publish_preview_pdf",
            "preview_path": str(preview),
            "output_path": output_path,
            "preview_token": preview_token,
            "final_token": final_token,
        })
    finally:
        handle_request({"op": "cleanup_exports", "export_token": preview_token})
        handle_request({"op": "cleanup_exports", "export_token": final_token})

    assert response == {
        "status": "error",
        "code": "invalid_output_path",
        "message": "output path is invalid",
    }


@pytest.mark.skipif(os.name != "nt", reason="Windows extended-length paths are platform-specific")
def test_publish_preview_pdf_accepts_the_windows_extended_form_of_an_owned_path(tmp_path: Path) -> None:
    preview_token = "preview-token-windows-path-test-001"
    final_token = "final-token-windows-path-test-00001"
    preview = _export_owned_preview(tmp_path, preview_token)
    output = tmp_path / "chosen" / "result.pdf"
    extended_preview = rf"\\?\{preview.resolve()}"

    try:
        published = handle_request({
            "op": "publish_preview_pdf",
            "preview_path": extended_preview,
            "output_path": str(output),
            "preview_token": preview_token,
            "final_token": final_token,
        })

        assert published["status"] == "ok"
        assert output.read_bytes() == preview.read_bytes()
    finally:
        handle_request({"op": "cleanup_exports", "export_token": final_token})
        handle_request({"op": "cleanup_exports", "export_token": preview_token})


def test_publish_preview_pdf_rejects_unowned_preview(tmp_path: Path) -> None:
    preview = tmp_path / "preview.pdf"
    preview.write_bytes(b"not owned")

    response = handle_request({
        "op": "publish_preview_pdf",
        "preview_path": str(preview),
        "output_path": str(tmp_path / "result.pdf"),
        "preview_token": "preview-token-security-test-002",
        "final_token": "final-token-security-test-00002",
    })

    assert response["status"] == "error"
    assert response["code"] == "ownership_lost"
    assert not (tmp_path / "result.pdf").exists()


def test_publish_preview_pdf_never_replaces_existing_output(tmp_path: Path) -> None:
    preview_token = "preview-token-security-test-003"
    final_token = "final-token-security-test-00003"
    preview = _export_owned_preview(tmp_path, preview_token)
    output = tmp_path / "result.pdf"
    output.write_bytes(b"keep")

    response = handle_request({
        "op": "publish_preview_pdf",
        "preview_path": str(preview),
        "output_path": str(output),
        "preview_token": preview_token,
        "final_token": final_token,
    })

    assert response["status"] == "error"
    assert response["code"] == "output_exists"
    assert output.read_bytes() == b"keep"


def test_export_pdf_rejects_segment_without_rect_or_full_page(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    document = pymupdf.open()
    document.new_page(width=600, height=800)
    document.save(source)
    document.close()

    response = handle_request({
        "op": "export_pdf",
        "output_path": str(tmp_path / "out.pdf"),
        "export_token": TEST_EXPORT_TOKEN,
        "selections": [{
            "source_path": str(source),
            "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "segments": [{"page_number": 1, "segment_no": 1, "review_status": "confirmed"}],
        }],
    })

    assert response["code"] == "pdf_export_failed"


def test_export_pdf_uses_reviewed_rectangle_and_preserves_source(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    page.insert_text((30, 80), "target-receipt")
    page.insert_text((30, 600), "other-content")
    document.save(source)
    document.close()
    original_bytes = source.read_bytes()
    original_hash = hashlib.sha256(original_bytes).hexdigest()
    source_document = pymupdf.open(source)
    original_page_count = source_document.page_count
    source_document.close()

    response = handle_request({
        "op": "export_pdf",
        "output_path": str(tmp_path / "out.pdf"),
        "export_token": TEST_EXPORT_TOKEN,
        "selections": [{
            "source_path": str(source),
            "source_sha256": original_hash,
            "segments": [{
                "page_number": 1,
                "segment_no": 1,
                "rect": {"x0": 0, "y0": 0, "x1": 600, "y1": 250},
                "review_status": "confirmed",
            }],
        }],
    })

    assert response["status"] == "ok"
    result = pymupdf.open(response["output_path"])
    assert result.page_count == 1
    assert result[0].rect.height == pytest.approx(250)
    assert "target-receipt" in result[0].get_text()
    result.close()
    assert source.read_bytes() == original_bytes
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
    source_document = pymupdf.open(source)
    assert source_document.page_count == original_page_count
    source_document.close()


@pytest.mark.parametrize("segment_patch", [
    {"source_sha256": "wrong"},
    {"review_status": "needs_review"},
    {"rect": {"x0": 0, "y0": 0, "x1": 601, "y1": 250}},
    {"rect": {"x0": float("nan"), "y0": 0, "x1": 600, "y1": 250}},
])
def test_export_pdf_rejects_untrusted_selection_data(tmp_path: Path, segment_patch: dict[str, object]) -> None:
    source = tmp_path / "source.pdf"
    document = pymupdf.open()
    document.new_page(width=600, height=800)
    document.save(source)
    document.close()
    segment: dict[str, object] = {
        "page_number": 1,
        "segment_no": 1,
        "rect": {"x0": 0, "y0": 0, "x1": 600, "y1": 250},
        "review_status": "confirmed",
    }
    selection: dict[str, object] = {
        "source_path": str(source),
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "segments": [segment],
    }
    if "source_sha256" in segment_patch:
        selection["source_sha256"] = segment_patch["source_sha256"]
    segment.update({key: value for key, value in segment_patch.items() if key != "source_sha256"})

    response = handle_request({
        "op": "export_pdf",
        "output_path": str(tmp_path / "out.pdf"),
        "export_token": TEST_EXPORT_TOKEN,
        "selections": [selection],
    })

    assert response["code"] == "pdf_export_failed"


def test_export_pdf_accepts_explicit_full_page_only(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    document = pymupdf.open()
    document.new_page(width=200, height=200)
    document.save(source)
    document.close()

    response = handle_request({
        "op": "export_pdf",
        "output_path": str(tmp_path / "out.pdf"),
        "export_token": TEST_EXPORT_TOKEN,
        "selections": [{
            "source_path": str(source),
            "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "segments": [{"page_number": 1, "segment_no": 1, "keep_full_page": True, "review_status": "confirmed"}],
        }],
    })

    assert response["status"] == "ok"
    result = pymupdf.open(response["output_path"])
    assert result[0].rect.width == pytest.approx(200)
    assert result[0].rect.height == pytest.approx(200)
    result.close()


def test_export_pdf_uses_snapshot_when_source_changes_after_snapshot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.pdf"
    document = pymupdf.open()
    document.new_page(width=600, height=800)
    document.save(source)
    document.close()
    original_bytes = source.read_bytes()
    source_hash = hashlib.sha256(original_bytes).hexdigest()
    original_export = engine_module.export_merged_segments

    def export_then_mutate(output_path, selections):
        result = original_export(output_path, selections)
        source.write_bytes(source.read_bytes() + b"changed-after-export")
        return result

    monkeypatch.setattr(engine_module, "export_merged_segments", export_then_mutate)
    output = tmp_path / "out.pdf"
    response = handle_request({
        "op": "export_pdf",
        "output_path": str(output),
        "export_token": TEST_EXPORT_TOKEN,
        "selections": [{
            "source_path": str(source),
            "source_sha256": source_hash,
            "segments": [{
                "page_number": 1,
                "segment_no": 1,
                "rect": {"x0": 0, "y0": 0, "x1": 600, "y1": 250},
                "review_status": "confirmed",
            }],
        }],
    })

    assert response["status"] == "ok"
    result = pymupdf.open(output)
    assert result.page_count == 1
    assert result[0].rect.height == pytest.approx(250)
    result.close()
    assert source.read_bytes() != original_bytes


def test_export_pdf_uses_one_source_snapshot_across_a_b_a_race(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.pdf"
    source_a = tmp_path / "source-a.pdf"
    source_b = tmp_path / "source-b.pdf"
    for path, text in ((source_a, "source-A"), (source_b, "source-B")):
        document = pymupdf.open()
        page = document.new_page(width=600, height=800)
        page.insert_text((30, 80), text)
        document.save(path)
        document.close()
    source_a_bytes = source_a.read_bytes()
    source_b_bytes = source_b.read_bytes()
    source.write_bytes(source_a_bytes)
    source_hash = hashlib.sha256(source_a_bytes).hexdigest()
    original_export = engine_module.export_merged_segments

    def export_during_a_b_a_race(output_path, selections):
        source.write_bytes(source_b_bytes)
        try:
            return original_export(output_path, selections)
        finally:
            source.write_bytes(source_a_bytes)

    monkeypatch.setattr(engine_module, "export_merged_segments", export_during_a_b_a_race)
    output = tmp_path / "out.pdf"
    response = handle_request({
        "op": "export_pdf",
        "output_path": str(output),
        "export_token": "export-a-b-a-race-token-000001",
        "selections": [{
            "source_path": str(source),
            "source_sha256": source_hash,
            "segments": [{
                "page_number": 1,
                "segment_no": 1,
                "rect": {"x0": 0, "y0": 0, "x1": 600, "y1": 250},
                "review_status": "confirmed",
            }],
        }],
    })

    assert response["status"] == "ok"
    result = pymupdf.open(output)
    assert "source-A" in result[0].get_text()
    assert "source-B" not in result[0].get_text()
    result.close()
    assert source.read_bytes() == source_a_bytes


def test_export_pdf_applies_configured_source_size_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.pdf"
    document = pymupdf.open()
    document.new_page(width=200, height=200)
    document.save(source)
    document.close()
    monkeypatch.setattr(
        engine_module,
        "ENGINE_CONFIG",
        replace(engine_module.ENGINE_CONFIG, max_file_bytes=source.stat().st_size - 1),
    )

    response = handle_request({
        "op": "export_pdf",
        "output_path": str(tmp_path / "out.pdf"),
        "export_token": "export-size-limit-token-000001",
        "selections": [{
            "source_path": str(source),
            "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "segments": [{"page_number": 1, "keep_full_page": True, "review_status": "confirmed"}],
        }],
    })

    assert response == {
        "status": "error",
        "code": "file_too_large",
        "message": "PDF file exceeds the configured size limit",
    }
    assert not (tmp_path / "out.pdf").exists()


def test_export_pdf_applies_configured_page_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.pdf"
    document = pymupdf.open()
    document.new_page(width=200, height=200)
    document.new_page(width=200, height=200)
    document.save(source)
    document.close()
    monkeypatch.setattr(
        engine_module,
        "ENGINE_CONFIG",
        replace(engine_module.ENGINE_CONFIG, max_pages=1),
    )

    response = handle_request({
        "op": "export_pdf",
        "output_path": str(tmp_path / "out.pdf"),
        "export_token": "export-page-limit-token-000001",
        "selections": [{
            "source_path": str(source),
            "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "segments": [{"page_number": 1, "keep_full_page": True, "review_status": "confirmed"}],
        }],
    })

    assert response == {
        "status": "error",
        "code": "page_limit_exceeded",
        "message": "PDF page count exceeds the configured limit",
        "page_count": 2,
        "max_pages": 1,
    }
    assert not (tmp_path / "out.pdf").exists()


def test_export_pdf_does_not_publish_a_partial_batch(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    document = pymupdf.open()
    for _ in range(2):
        document.new_page(width=600, height=800)
    document.save(source)
    document.close()
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    output = tmp_path / "out.pdf"
    response = handle_request({
        "op": "export_pdf",
        "output_path": str(output),
        "export_token": TEST_EXPORT_TOKEN,
        "selections": [{
            "source_path": str(source),
            "source_sha256": source_hash,
            "segments": [
                {
                    "page_number": 1,
                    "segment_no": 1,
                    "rect": {"x0": 0, "y0": 0, "x1": 600, "y1": 250},
                    "review_status": "confirmed",
                },
                {
                    "page_number": 2,
                    "segment_no": 2,
                    "rect": {"x0": 0, "y0": 0, "x1": 601, "y1": 250},
                    "review_status": "confirmed",
                },
            ],
        }],
    })

    assert response["code"] == "pdf_export_failed"
    assert not output.exists()


def _review_segment_payload(*, segment_no: int = 1, final_rect: dict[str, float] | None = None) -> dict[str, object]:
    return {
        "id": f"sha:4:{segment_no}",
        "task_id": "task-1",
        "source_path": "source.pdf",
        "source_sha256": "abc123",
        "source_page": 4,
        "segment_no": segment_no,
        "match_rect": {"x0": 10, "y0": 20, "x1": 30, "y1": 40},
        "candidate_rect": {"x0": 0, "y0": 0, "x1": 600, "y1": 250},
        "final_rect": final_rect or {"x0": 0, "y0": 2, "x1": 600, "y1": 248},
        "layout_fingerprint": "layout-a",
        "confidence": 0.96,
        "crop_mode": "manual",
        "review_status": "confirmed",
        "manual_adjusted": True,
        "reviewed_at": "2026-09-01T06:20:00.000Z",
    }


def test_review_segment_protocol_saves_and_loads_by_task_id(tmp_path: Path) -> None:
    database = tmp_path / "review.sqlite3"
    segments = [_review_segment_payload(), _review_segment_payload(segment_no=2)]

    saved = handle_request({
        "op": "save_review_segments",
        "database_path": str(database),
        "task_id": "task-1",
        "segments": segments,
    })
    loaded = handle_request({
        "op": "load_review_segments",
        "database_path": str(database),
        "task_id": "task-1",
    })

    assert saved == {"status": "ok", "task_id": "task-1", "saved_count": 2}
    assert loaded["status"] == "ok"
    assert loaded["task_id"] == "task-1"
    assert loaded["segments"] == segments


def test_review_segment_save_validates_full_batch_before_writing(tmp_path: Path) -> None:
    database = tmp_path / "review.sqlite3"
    invalid = _review_segment_payload(segment_no=2)
    invalid["final_rect"] = {"x0": 0, "y0": 100, "x1": 0, "y1": 200}

    response = handle_request({
        "op": "save_review_segments",
        "database_path": str(database),
        "task_id": "task-1",
        "segments": [_review_segment_payload(), invalid],
    })
    loaded = handle_request({
        "op": "load_review_segments",
        "database_path": str(database),
        "task_id": "task-1",
    })

    assert response == {
        "status": "error",
        "code": "invalid_review_segments",
        "message": "review segments are invalid",
    }
    assert loaded == {"status": "ok", "task_id": "task-1", "segments": []}


@pytest.mark.parametrize("operation", ("save_review_segments", "load_review_segments"))
def test_review_segment_protocol_requires_database_path(operation: str) -> None:
    request: dict[str, object] = {"op": operation}
    if operation == "save_review_segments":
        request["segments"] = []

    response = handle_request(request)

    assert response == {
        "status": "error",
        "code": "invalid_database_path",
        "message": "database_path is required",
    }
