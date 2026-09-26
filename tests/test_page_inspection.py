"""Bounded geometry inspection must not rasterize pages or repeat source snapshots."""

from __future__ import annotations

import hashlib
from dataclasses import replace
from pathlib import Path

import pymupdf
import pytest

import engine.engine as engine_module
from engine.engine import handle_request


@pytest.fixture
def source(tmp_path: Path) -> tuple[Path, str]:
    path = tmp_path / "inspection.pdf"
    with pymupdf.open() as document:
        document.new_page(width=600, height=800)
        document.new_page(width=400, height=300)
        document.new_page(width=20_000, height=300)
        document.save(path)
    return path, hashlib.sha256(path.read_bytes()).hexdigest()


def request(source: tuple[Path, str], pages: object, **overrides: object) -> dict[str, object]:
    path, digest = source
    return {
        "op": "inspect_pages", "path": str(path), "source_sha256": digest,
        "pages": pages, **overrides,
    }


def test_batch_uses_one_snapshot_and_open_without_rendering_or_extracting_text(source, monkeypatch):
    calls = {"snapshot": 0, "open": 0}
    original_snapshot = engine_module._snapshot_pdf_source
    original_open = pymupdf.open

    def snapshot(*args, **kwargs):
        calls["snapshot"] += 1
        return original_snapshot(*args, **kwargs)

    def open_document(*args, **kwargs):
        calls["open"] += 1
        return original_open(*args, **kwargs)

    def forbidden(*args, **kwargs):
        pytest.fail("metadata inspection must not render or parse text")

    monkeypatch.setattr(engine_module, "_snapshot_pdf_source", snapshot)
    monkeypatch.setattr(engine_module.pymupdf, "open", open_document)
    monkeypatch.setattr(pymupdf.Page, "get_pixmap", forbidden)
    monkeypatch.setattr(engine_module, "describe_crop_page", forbidden)
    response = handle_request(request(source, [2, 1]))

    assert calls == {"snapshot": 1, "open": 1}
    assert response["status"] == "ok"
    assert response["source_sha256"] == source[1]
    assert response["page_count"] == 3
    assert [(page["page"], page["page_width"], page["page_height"]) for page in response["pages"]] == [
        (2, 400, 300), (1, 600, 800),
    ]
    assert all("image_data" not in page and "crop_template" not in page for page in response["pages"])
    assert hashlib.sha256(source[0].read_bytes()).hexdigest() == source[1]


@pytest.mark.parametrize("pages", [None, "1", [], [0], [-1], [True], [1.5], [2**32], [1, 1], [[1]], list(range(1, 34))])
def test_rejects_invalid_page_set_before_snapshot(source, pages, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("invalid requests must not copy the source")

    monkeypatch.setattr(engine_module, "_snapshot_pdf_source", forbidden)
    assert handle_request(request(source, pages))["code"] == "invalid_page"


@pytest.mark.parametrize("value", [None, 1, "true", []])
def test_rejects_non_boolean_descriptor_flag(source, value):
    assert handle_request(request(source, [1], include_crop_template=value))["code"] == "invalid_request"


def test_source_change_fails_the_whole_batch_before_opening_pages(source, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("changed source must not be opened for page inspection")

    monkeypatch.setattr(engine_module.pymupdf, "open", forbidden)
    result = handle_request(request(source, [1, 2], source_sha256="a" * 64))
    assert result["code"] == "source_changed"
    assert "pages" not in result


def test_missing_source_and_bad_hash_remain_top_level_errors(source):
    assert handle_request(request(source, [1], source_sha256="bad"))["status"] == "error"
    assert handle_request(request(source, [1], path=str(source[0].with_name("missing.pdf"))))["code"] == "file_not_found"


def test_out_of_range_and_raster_budget_failures_do_not_hide_other_pages(source):
    response = handle_request(request(source, [3, 4, 1]))
    assert response["status"] == "ok"
    assert [item["status"] for item in response["pages"]] == ["error", "error", "ok"]
    assert [item.get("code") for item in response["pages"]] == ["render_failed", "page_out_of_range", None]
    assert response["pages"][2]["page"] == 1


def test_page_load_failure_is_isolated_and_does_not_echo_private_errors(source, monkeypatch):
    original_load = pymupdf.Document.load_page

    def load_page(document, number):
        if number == 1:
            raise RuntimeError("private extraction detail")
        return original_load(document, number)

    monkeypatch.setattr(pymupdf.Document, "load_page", load_page)
    response = handle_request(request(source, [2, 1]))
    assert response["pages"][0]["code"] == "render_failed"
    assert response["pages"][1]["status"] == "ok"
    assert "private extraction detail" not in str(response)


def test_optional_descriptors_are_bounded_to_requested_pages_and_fail_independently(source, monkeypatch):
    described = []

    def describe(page):
        described.append(page.number)
        if page.number == 1:
            raise RuntimeError("private descriptor detail")
        return {"status": "unavailable", "reason": "no_text"}

    monkeypatch.setattr(engine_module, "describe_crop_page", describe)
    response = handle_request(request(source, [2, 3, 1], include_crop_template=True))
    assert described == [1, 0]
    assert response["pages"][0]["code"] == "analyze_failed"
    assert response["pages"][1]["code"] == "render_failed"
    assert response["pages"][2]["crop_template"] == {"status": "unavailable", "reason": "no_text"}
    assert "private descriptor detail" not in str(response)


def test_inspection_allows_the_maximum_bounded_request(source):
    response = handle_request(request(source, list(range(1, 33))))
    assert response["status"] == "ok"
    assert len(response["pages"]) == 32


@pytest.mark.parametrize("limit,code", [("max_pages", "page_limit_exceeded"), ("max_file_bytes", "file_too_large")])
def test_source_budgets_remain_authoritative_for_the_entire_batch(source, monkeypatch, limit, code):
    monkeypatch.setattr(engine_module, "ENGINE_CONFIG", replace(engine_module.ENGINE_CONFIG, **{limit: 1}))
    response = handle_request(request(source, [1, 2]))
    assert response["status"] == "error"
    assert response["code"] == code
    assert "pages" not in response
