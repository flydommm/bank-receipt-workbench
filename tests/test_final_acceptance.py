from __future__ import annotations

import hashlib
from pathlib import Path

import pymupdf
import pytest

from engine.engine import handle_request


PAGE_WIDTH = 600
PAGE_HEIGHT = 900
RECEIPT_TOPS = (40, 320, 600)


def _synthetic_receipts_pdf(
    tmp_path: Path,
    receipt_count: int,
    *,
    separators: bool = True,
    duplicate_match: bool = False,
) -> Path:
    """Create a non-sensitive receipt-like fixture entirely below ``tmp_path``."""

    path = tmp_path / f"synthetic-{receipt_count}-receipts.pdf"
    document = pymupdf.open()
    page = document.new_page(width=PAGE_WIDTH, height=PAGE_HEIGHT)
    for index, top in enumerate(RECEIPT_TOPS[:receipt_count]):
        page.insert_text((60, top), "银行客户回单", fontname="china-s")
        page.insert_text((60, top + 55), "收款方：手续费", fontname="china-s")
        if duplicate_match and index == 0:
            page.insert_text((60, top + 85), "备注：手续费", fontname="china-s")
        page.insert_text((60, top + 120), "交易金额：12345.67", fontname="china-s")
        if separators:
            page.draw_line((40, top - 15), (560, top - 15))
            page.draw_line((40, top + 115), (560, top + 115))
    document.save(path)
    document.close()
    return path


def _search_and_analyze(path: Path) -> tuple[dict[str, object], dict[str, object]]:
    search = handle_request({"op": "search", "path": str(path), "keyword": "手续费"})
    assert search["status"] == "ok"
    matches = search["matches"]
    assert isinstance(matches, list) and matches
    analysis = handle_request(
        {
            "op": "analyze_page",
            "path": str(path),
            "page": 1,
            "source_sha256": search["source_sha256"],
            "matches": [
                {field: match[field] for field in ("x0", "y0", "x1", "y1")}
                for match in matches
                if isinstance(match, dict)
            ],
        }
    )
    assert analysis["status"] == "ok"
    return search, analysis


@pytest.mark.parametrize(
    ("receipt_count", "expected_slots"),
    (
        (1, ["slot-1"]),
        (2, ["slot-1", "slot-2"]),
        (3, ["top", "middle", "bottom"]),
    ),
)
def test_synthetic_receipt_counts_map_matches_to_slots_and_final_rectangles(
    tmp_path: Path,
    receipt_count: int,
    expected_slots: list[str],
) -> None:
    path = _synthetic_receipts_pdf(tmp_path, receipt_count)
    _search, analysis = _search_and_analyze(path)

    selections = analysis["selections"]
    assert isinstance(selections, list)
    assert [selection["slot"] for selection in selections] == expected_slots
    assert len(selections) == receipt_count
    for selection in selections:
        assert isinstance(selection, dict)
        rect = selection["rect"]
        match_rect = selection["match_rect"]
        assert isinstance(rect, dict) and isinstance(match_rect, dict)
        assert 0 <= rect["x0"] < rect["x1"] <= PAGE_WIDTH
        assert 0 <= rect["y0"] < rect["y1"] <= PAGE_HEIGHT
        assert rect["x0"] <= match_rect["x0"] < match_rect["x1"] <= rect["x1"]
        assert rect["y0"] <= match_rect["y0"] < match_rect["y1"] <= rect["y1"]
        assert 0.90 <= selection["confidence"] <= 0.99
        assert selection["needs_review"] is False
        assert "repeated_title" in selection["evidence"]


def test_synthetic_same_page_multiple_matches_share_the_same_receipt_slot_and_rect(
    tmp_path: Path,
) -> None:
    path = _synthetic_receipts_pdf(tmp_path, 1, duplicate_match=True)
    _search, analysis = _search_and_analyze(path)

    selections = analysis["selections"]
    assert isinstance(selections, list)
    assert len(selections) == 2
    assert [selection["slot"] for selection in selections] == ["slot-1", "slot-1"]
    assert selections[0]["rect"] == selections[1]["rect"]
    assert selections[0]["match_rect"] != selections[1]["match_rect"]


def test_synthetic_missing_separators_stays_in_review_confidence_band(tmp_path: Path) -> None:
    path = _synthetic_receipts_pdf(tmp_path, 3, separators=False)
    _search, analysis = _search_and_analyze(path)

    selections = analysis["selections"]
    assert isinstance(selections, list)
    assert [selection["slot"] for selection in selections] == ["top", "middle", "bottom"]
    for selection in selections:
        assert 0.70 <= selection["confidence"] < 0.90
        assert selection["needs_review"] is True
        assert "separator" not in selection["evidence"]
        assert selection["rect"] is not None


@pytest.mark.parametrize("selection_index", (0, 1, 2))
def test_synthetic_top_middle_bottom_export_dimensions_and_source_hash(
    tmp_path: Path,
    selection_index: int,
) -> None:
    path = _synthetic_receipts_pdf(tmp_path, 3)
    original_bytes = path.read_bytes()
    original_hash = hashlib.sha256(original_bytes).hexdigest()
    source_document = pymupdf.open(path)
    original_page_count = source_document.page_count
    source_document.close()

    search, analysis = _search_and_analyze(path)
    selection = analysis["selections"][selection_index]
    rect = selection["rect"]
    assert isinstance(rect, dict)
    output = tmp_path / f"export-{selection_index}.pdf"
    exported = handle_request(
        {
            "op": "export_pdf",
            "output_path": str(output),
            "export_token": f"final-acceptance-token-{selection_index:02d}-0000001",
            "selections": [
                {
                    "source_path": str(path),
                    "source_sha256": search["source_sha256"],
                    "segments": [
                        {
                            "page_number": 1,
                            "segment_no": 1,
                            "rect": rect,
                            "review_status": "confirmed",
                        }
                    ],
                }
            ],
        }
    )

    assert exported["status"] == "ok"
    result = pymupdf.open(output)
    assert result.page_count == 1
    assert result[0].rect.width == pytest.approx(rect["x1"] - rect["x0"])
    assert result[0].rect.height == pytest.approx(rect["y1"] - rect["y0"])
    assert "手续费" in result[0].get_text()
    result.close()

    assert path.read_bytes() == original_bytes
    assert hashlib.sha256(path.read_bytes()).hexdigest() == original_hash
    source_document = pymupdf.open(path)
    assert source_document.page_count == original_page_count
    source_document.close()
