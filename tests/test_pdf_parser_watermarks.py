from copy import deepcopy
from types import SimpleNamespace

import pytest

from engine import pdf_parser


class FakePage:
    def __init__(self):
        self.rect = SimpleNamespace(width=600, height=800)
        self.raw = [(40, 20, 300, 40, "客户回单\n", 0, 0)]
        self.metadata = []
        self.flags = None
        for index, y in enumerate((350, 450, 550, 650), start=1):
            box = (40, y, 160, y + 60)
            self.raw.append((*box, "上海银行\n", index, 0))
            self.metadata.append({
                "type": 0, "number": index + 100, "bbox": box,
                "lines": [{"dir": (0.866, -0.5), "spans": [{"text": "上海银行"}]}],
            })

    def get_text(self, mode="text", *, flags=None):
        if mode == "blocks":
            return self.raw
        if mode == "dict":
            self.flags = flags
            return {"blocks": self.metadata}
        return "".join(block[4] for block in self.raw)


def test_marks_repeated_diagonal_bank_watermarks_and_preserves_original_content():
    page = FakePage()
    parsed = pdf_parser.parse_loaded_page(page, 7)
    assert [block.is_watermark for block in parsed.blocks] == [False, True, True, True, True]
    assert parsed.text == page.get_text()
    for index, block in enumerate(parsed.blocks):
        assert block.page_number == 7
        assert block.block_index == index
        assert block.text == page.raw[index][4].strip()
        assert (block.x0, block.y0, block.x1, block.y1) == page.raw[index][:4]
    assert not page.flags & pdf_parser.fitz.TEXT_PRESERVE_IMAGES


@pytest.mark.parametrize("direction", [(1, 0), (0, 1)])
def test_horizontal_or_vertical_bank_names_are_not_watermarks(direction):
    page = FakePage()
    for block in page.metadata:
        block["lines"][0]["dir"] = direction
    assert not any(block.is_watermark for block in pdf_parser.parse_loaded_page(page, 1).blocks)


def test_a_single_diagonal_bank_name_is_preserved():
    page = FakePage()
    page.raw = page.raw[:2]
    page.metadata = page.metadata[:1]
    assert not any(block.is_watermark for block in pdf_parser.parse_loaded_page(page, 1).blocks)


def test_repeated_non_bank_text_is_preserved():
    page = FakePage()
    page.raw = [(*block[:4], block[4].replace("上海银行", "业务明细"), *block[5:]) for block in page.raw]
    for block in page.metadata:
        block["lines"][0]["spans"][0]["text"] = "业务明细"
    assert not any(block.is_watermark for block in pdf_parser.parse_loaded_page(page, 1).blocks)


def test_a_block_mixed_with_body_text_is_preserved():
    page = FakePage()
    page.raw[1] = (*page.raw[1][:4], "上海银行\n业务明细\n", *page.raw[1][5:])
    page.metadata[0]["lines"].append({"dir": (1, 0), "spans": [{"text": "业务明细"}]})
    parsed = pdf_parser.parse_loaded_page(page, 1)
    assert not parsed.blocks[1].is_watermark
    assert all(block.is_watermark for block in parsed.blocks[2:])


def test_duplicates_at_the_same_position_do_not_prove_background_pattern():
    page = FakePage()
    page.raw = [page.raw[0], *[page.raw[1]] * 4]
    page.metadata = [deepcopy(page.metadata[0]) for _ in range(4)]
    assert not any(block.is_watermark for block in pdf_parser.parse_loaded_page(page, 1).blocks)


def test_optional_metadata_failure_preserves_searchable_content():
    page = FakePage()
    get_text = page.get_text
    def failing_metadata(mode="text", **kwargs):
        if mode == "dict":
            raise RuntimeError("optional metadata unavailable")
        return get_text(mode, **kwargs)
    page.get_text = failing_metadata
    parsed = pdf_parser.parse_loaded_page(page, 1)
    assert len(parsed.blocks) == len(page.raw)
    assert not any(block.is_watermark for block in parsed.blocks)


def test_iter_pages_uses_the_same_parser(monkeypatch):
    page = FakePage()
    document = SimpleNamespace(page_count=1, load_page=lambda index: page, close=lambda: None)
    monkeypatch.setattr(pdf_parser.fitz, "open", lambda path: document)
    assert list(pdf_parser.iter_pages("synthetic.pdf")) == [pdf_parser.parse_loaded_page(page, 1)]
