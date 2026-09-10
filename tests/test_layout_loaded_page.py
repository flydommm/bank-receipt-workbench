"""The batch worker reuses a page without changing layout or closing its PDF."""

import pymupdf
import pytest

from engine.layout import extract_frame_anchors, extract_separators, extract_visual_anchors


@pytest.mark.parametrize("extract", [extract_frame_anchors, extract_separators, extract_visual_anchors])
def test_loaded_page_matches_existing_path_api_without_reopening(tmp_path, monkeypatch, extract):
    path = tmp_path / "synthetic.pdf"
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=800)
        page.draw_rect(pymupdf.Rect(40, 60, 560, 300))
        page.insert_text((80, 100), "Receipt fee")
        document.save(path)
    expected = extract(path, 1)
    with pymupdf.open(path) as document:
        page = document[0]
        monkeypatch.setattr(pymupdf, "open", lambda *_args, **_kwargs: pytest.fail("unexpected PDF reopen"))
        assert extract(path, 1, loaded_page=page) == expected
        assert not document.is_closed
        assert page.get_text().strip() == "Receipt fee"


def test_loaded_page_number_mismatch_is_rejected():
    with pymupdf.open() as document:
        page = document.new_page()
        with pytest.raises(ValueError, match="page"):
            extract_separators("unused.pdf", 2, loaded_page=page)
        assert not document.is_closed
