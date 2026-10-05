"""Observed empty native-PDF cells are distinct from unreadable fields."""
import pytest
import pymupdf

from engine.receipt_parties import extract_receipt_parties
from engine.receipt_field_candidates import candidate_field


def table(page, *, ink=False, borders=True, thin_fills=False, opacity=1):
    for x, side, value in ((20, "付款人", "合成甲公司"), (300, "收款人", "")):
        page.insert_text((x, 73), side, fontname="china-s", fontsize=9)
        for y, label in ((50, "名称"), (75, "账号"), (100, "开户行")):
            page.insert_text((x + 40, y), label, fontname="china-s", fontsize=9)
            if borders:
                cell = pymupdf.Rect(x + 95, y - 13, x + 280, y + 7)
                if thin_fills:
                    for bar in (pymupdf.Rect(cell.x0, cell.y0, cell.x1, cell.y0 + .75),
                                pymupdf.Rect(cell.x0, cell.y1 - .75, cell.x1, cell.y1),
                                pymupdf.Rect(cell.x0, cell.y0, cell.x0 + .75, cell.y1),
                                pymupdf.Rect(cell.x1 - .75, cell.y0, cell.x1, cell.y1)):
                        page.draw_rect(bar, color=None, fill=(0, 0, 0), fill_opacity=opacity)
                else:
                    page.draw_rect(cell, stroke_opacity=opacity)
            if x == 20:
                text = value if label == "名称" else "000123456" if label == "账号" else "合成银行"
                page.insert_text((x + 100, y), text, fontname="china-s", fontsize=9)
    if ink:
        # Visible vector content with no extractable text cannot mean blank.
        page.draw_circle((430, 46), 3, color=(0, 0, 0), fill=(0, 0, 0))


@pytest.mark.parametrize("thin_fills", [False, True])
def test_closed_blank_cell_has_empty_value_evidence(thin_fills):
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=300)
        table(page, thin_fills=thin_fills)
        result = extract_receipt_parties(page, (0, 0, 600, 300))
    assert result["payee"]["name"]["state"] == "blank"
    assert result["payee"]["name"]["value"] == ""
    assert result["payee"]["name"]["evidence"]["value"]["rect"]
    assert result["payer"]["name"]["value"] == "合成甲公司"


@pytest.mark.parametrize("ink,borders,scope", [(True, True, (0, 0, 600, 300)),
    (False, False, (0, 0, 600, 300)), (False, True, (0, 0, 520, 300))])
def test_no_geometry_visible_ink_or_clipped_cell_remains_missing(ink, borders, scope):
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=300)
        table(page, ink=ink, borders=borders)
        result = extract_receipt_parties(page, scope)
    assert result["payee"]["name"]["state"] == "missing"


def test_name_punctuation_is_not_a_valid_direct_candidate():
    assert candidate_field("name", "）")["state"] == "ambiguous"
    assert candidate_field("name", "—")["state"] == "blank"
    assert candidate_field("name", "合成银行（新）")["state"] == "present"


def test_text_only_extraction_does_not_hide_an_image_inside_the_value_cell():
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=300)
        table(page)
        image = pymupdf.Pixmap(pymupdf.csGRAY, pymupdf.IRect(0, 0, 8, 8), False)
        image.clear_with(0)
        page.insert_image(pymupdf.Rect(420, 42, 428, 50), stream=image.tobytes("png"))
        result = extract_receipt_parties(page, (0, 0, 600, 300))
    assert result["payee"]["name"]["state"] == "missing"


@pytest.mark.parametrize("thin_fills", [False, True])
def test_transparent_geometry_cannot_prove_a_printed_blank_cell(thin_fills):
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=300)
        table(page, thin_fills=thin_fills, opacity=0)
        result = extract_receipt_parties(page, (0, 0, 600, 300))
    assert result["payee"]["name"]["state"] == "missing"


@pytest.mark.parametrize("mask", [(393, 35, 583, 59), (578, 35, 583, 59)])
def test_white_overlay_obscuring_borders_cannot_prove_a_blank_cell(mask):
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=300)
        table(page)
        page.draw_rect(pymupdf.Rect(mask), color=None, fill=(1, 1, 1))
        result = extract_receipt_parties(page, (0, 0, 600, 300))
    assert result["payee"]["name"]["state"] == "missing"
