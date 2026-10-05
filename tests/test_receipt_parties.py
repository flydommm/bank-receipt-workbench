from __future__ import annotations

from dataclasses import dataclass

import pytest

from engine.pdf_parser import ParsedPage, TextBlock
from engine.receipt_parties import extract_receipt_parties


def _parsed_page(rows: list[tuple[float, float, str, float]], *, width: float = 800, height: float = 800) -> ParsedPage:
    blocks = tuple(
        TextBlock(1, text, x, y, x + block_width, y + 14, index)
        for index, (x, y, text, block_width) in enumerate(rows)
    )
    return ParsedPage(1, width, height, "\n".join(text for _x, _y, text, _w in rows), blocks)


@dataclass
class _WordPage:
    words: list[tuple[float, float, float, float, str, int, int, int]]
    width: float = 800
    height: float = 300

    @property
    def rect(self):
        return type("Rect", (), {"x0": 0.0, "y0": 0.0, "x1": self.width, "y1": self.height})()

    def get_text(self, mode="text", *, clip=None, sort=False):
        if mode == "words":
            result = list(self.words)
            if clip is not None:
                x0, y0, x1, y1 = clip
                result = [
                    word for word in result
                    if word[2] > x0 and word[0] < x1 and word[3] > y0 and word[1] < y1
                ]
            return result
        return ""


def _word(x: float, y: float, text: str, block: int, word: int, width: float | None = None):
    return (x, y, x + (width if width is not None else max(10, len(text) * 10)), y + 12, text, block, 0, word)


def test_extracts_vertical_fields_from_one_fragment_and_preserves_leading_zero_account():
    page = _parsed_page([
        (20, 20, "付款方名称：甲公司", 240),
        (20, 40, "付款方账号：012345678901", 240),
        (20, 60, "付款方开户行：中国银行", 240),
        (300, 20, "收款方名称：乙公司", 240),
        (300, 40, "收款方账号：987654321098", 240),
        (300, 60, "收款方开户行：建设银行", 240),
        # A second receipt is on the same page and must not enter the first
        # fragment when the clip is restricted to the upper half.
        (20, 220, "付款方名称：另一公司", 240),
        (300, 220, "收款方名称：第三公司", 240),
    ], height=400)

    result = extract_receipt_parties(page, (0, 0, 600, 120))

    assert result["payer"]["name"]["normalized"] == "甲公司"
    assert result["payer"]["account"] ["raw"] == "012345678901"
    assert result["payer"]["account"]["normalized"] == "012345678901"
    assert result["payer"]["account"]["state"] == "present"
    assert result["payee"]["name"]["normalized"] == "乙公司"
    assert result["payee"]["bank"]["normalized"] == "建设银行"
    assert result["diagnostics"]["status"] == "ok"
    assert result["diagnostics"]["scope"] == {"x0": 0.0, "y0": 0.0, "x1": 600.0, "y1": 120.0}


def test_word_geometry_supports_two_columns_and_keeps_evidence_inside_clip():
    words = [
        _word(20, 20, "付款方名称：", 0, 0, 85), _word(110, 20, "甲公司", 0, 1, 60),
        _word(320, 20, "收款方名称：", 1, 0, 85), _word(410, 20, "乙公司", 1, 1, 60),
        _word(20, 45, "付款方账号：", 2, 0, 85), _word(110, 45, "0012345678", 2, 1, 90),
        _word(320, 45, "收款方账号：", 3, 0, 85), _word(410, 45, "8765432100", 3, 1, 90),
        _word(20, 70, "付款方开户行：", 4, 0, 105), _word(130, 70, "中国银行", 4, 1, 70),
        _word(320, 70, "收款方开户行：", 5, 0, 105), _word(430, 70, "建设银行", 5, 1, 70),
    ]
    page = _WordPage(words)

    result = extract_receipt_parties(page, (0, 0, 500, 100))

    assert result["payer"]["name"]["raw"] == "甲公司"
    assert result["payee"]["name"]["raw"] == "乙公司"
    assert result["payer"]["account"]["normalized"] == "0012345678"
    assert result["payee"]["account"]["normalized"] == "8765432100"
    for side in ("payer", "payee"):
        for field in ("name", "account", "bank"):
            evidence = result[side][field]["evidence"]
            assert evidence["label"]["rect"]["x0"] >= 0
            assert evidence["rect"]["x1"] <= 500


def test_generic_two_column_header_uses_geometry_and_does_not_treat_bank_value_as_label():
    rows = [
        (20, 20, "付款方"), (320, 20, "收款方"),
        (20, 40, "名称"), (320, 40, "名称"),
        (110, 60, "甲公司"), (410, 60, "乙公司"),
        (20, 80, "账号"), (320, 80, "账号"),
        (110, 100, "001234"), (410, 100, "007654"),
        (20, 120, "开户行"), (320, 120, "开户行"),
        (110, 140, "中国银行"), (410, 140, "建设银行"),
    ]
    words = [_word(x, y, text, index, 0, 70) for index, (x, y, text) in enumerate(rows)]

    result = extract_receipt_parties(_WordPage(words), (0, 0, 500, 180))

    assert result["payer"]["name"]["normalized"] == "甲公司"
    assert result["payee"]["name"]["normalized"] == "乙公司"
    assert result["payer"]["account"]["normalized"] == "001234"
    assert result["payee"]["account"]["normalized"] == "007654"
    assert result["payer"]["bank"]["normalized"] == "中国银行"
    assert result["payee"]["bank"]["normalized"] == "建设银行"
    assert result["diagnostics"]["status"] == "ok"


def test_wrapped_labels_use_column_anchor_and_do_not_call_unread_value_blank():
    page = _parsed_page([
        (20, 20, "付款方", 200),
        (20, 38, "名称：甲公司", 200),
        (20, 58, "账号：012300", 200),
        (320, 20, "收款方", 200),
        (320, 38, "名称：乙公司", 200),
        (320, 58, "账号：045600", 200),
        (20, 100, "付款方开户行", 200),  # label without a value: missing, not blank
    ], height=160)

    result = extract_receipt_parties(page, (0, 0, 600, 150))

    assert result["payer"]["name"]["normalized"] == "甲公司"
    assert result["payee"]["name"]["normalized"] == "乙公司"
    assert result["payer"]["account"]["normalized"] == "012300"
    assert result["payer"]["bank"]["state"] == "missing"
    assert any(issue["code"] == "label_without_value" for issue in result["diagnostics"]["issues"])


def test_explicit_empty_markers_are_blank_but_a_colon_alone_is_not_proof():
    page = _parsed_page([
        (20, 20, "付款方名称：—", 220),
        (20, 40, "付款方账号：012345", 220),
        (300, 20, "收款方名称：无", 220),
        (300, 40, "收款方账号：", 220),
    ], height=100)

    result = extract_receipt_parties(page, (0, 0, 600, 90))

    assert result["payer"]["name"]["state"] == "blank"
    assert result["payer"]["name"]["evidence"]["value"] is not None
    assert result["payer"]["account"]["state"] == "present"
    assert result["payee"]["name"]["state"] == "blank"
    assert result["payee"]["account"]["state"] == "missing"


def test_colon_label_with_wrapped_value_is_not_misclassified_as_empty():
    page = _parsed_page([(20, 20, "付款方名称：", 120), (20, 40, "合成 A B 公司", 120),
                         (320, 20, "收款方名称：", 120), (320, 40, "合成 AB 公司", 120)])
    result = extract_receipt_parties(page, (0, 0, 600, 100))
    assert result["payer"]["name"]["state"] == "present"
    assert result["payer"]["name"]["value"] == "合成 A B 公司"
    assert result["payee"]["name"]["value"] == "合成 AB 公司"


def test_real_pdf_span_text_preserves_spaces_within_a_name():
    import pymupdf
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=300)
        page.insert_text((20, 40), "付款方名称：", fontname="china-s", fontsize=12)
        page.insert_text((20, 60), "Synthetic A B Company", fontsize=12)
        result = extract_receipt_parties(page, (0, 0, 600, 200))
        assert result["payer"]["name"]["value"] == "Synthetic A B Company"


def test_masked_account_and_conflicting_duplicate_are_ambiguous():
    page = _parsed_page([
        (20, 20, "付款方账号：62****1234", 230),
        (20, 40, "付款方账号：621234567890", 230),
        (300, 20, "收款方账号：尾号1234", 230),
    ], height=100)

    result = extract_receipt_parties(page, (0, 0, 600, 90))

    assert result["payer"]["account"]["state"] == "ambiguous"
    assert len(result["payer"]["account"]["candidates"]) == 2
    # The suffix-only account is preserved for review, without being used as a
    # complete identifier by this extraction layer.
    assert result["payee"]["account"]["state"] == "ambiguous"
    assert any(issue["code"] == "conflicting_field_values" for issue in result["diagnostics"]["issues"])
    assert any(issue["code"] == "field_ambiguous" for issue in result["diagnostics"]["issues"])


def test_text_crossing_fragment_boundary_is_excluded_and_reported():
    page = _WordPage([
        _word(20, 20, "付款方名称：", 0, 0, 85),
        _word(110, 20, "甲公司", 0, 1, 60),
        _word(280, 20, "收款方名称：乙公司", 1, 0, 170),
    ])

    result = extract_receipt_parties(page, (0, 0, 300, 100))

    assert result["payer"]["name"]["raw"] == "甲公司"
    assert result["payee"]["name"]["state"] == "missing"
    assert any(issue["code"] == "text_crosses_scope" for issue in result["diagnostics"]["issues"])


def test_invalid_scope_is_rejected_before_reading_page():
    page = _WordPage([])
    with pytest.raises(ValueError, match="ordered"):
        extract_receipt_parties(page, (100, 100, 20, 20))

def _vertical_table_page(*, same_name: bool = False, same_bank: bool = False) -> _WordPage:
    rows = []
    for x, heading, name, account, bank in [
        (14, "付款人", "合成甲公司", "00123456789", "示例银行甲支行"),
        (301, "收款人", "合成甲公司" if same_name else "合成乙公司", "00987654321",
         "示例银行甲支行" if same_bank else "示例银行乙支行"),
    ]:
        for offset, character in enumerate(heading):
            rows.append((x, 42 + offset * 12, character, 9))
        # Values deliberately occur slightly above the corresponding label in
        # PDF text order.  They are separate lines, not joined text strings.
        for y, label, value in [(32, "户名", name), (54, "账号", account), (76, "开户行", bank)]:
            rows.extend([(x + 25, y, label, 28), (x + 58, y - 0.1, value, len(value) * 9)])
    return _WordPage([_word(x, y, text, index, 0, width) for index, (x, y, text, width) in enumerate(rows)])


def test_vertical_character_headers_and_same_row_geometry_preserve_both_parties():
    result = extract_receipt_parties(_vertical_table_page(), (0, 0, 590, 130))
    assert result["payer"]["name"]["value"] == "合成甲公司"
    assert result["payee"]["name"]["value"] == "合成乙公司"
    assert result["payer"]["account"]["value"] == "00123456789"
    assert result["payee"]["account"]["value"] == "00987654321"
    assert result["payer"]["bank"]["value"] == "示例银行甲支行"
    assert result["payee"]["bank"]["value"] == "示例银行乙支行"
    assert result["payer"]["account"]["evidence"]["label"]["text"] == "账号"
    assert result["payer"]["account"]["evidence"]["value"]["rect"]["x0"] == 72


def test_vertical_table_same_company_same_bank_retains_distinct_accounts():
    result = extract_receipt_parties(_vertical_table_page(same_name=True, same_bank=True), (0, 0, 590, 130))
    assert result["payer"]["name"]["value"] == result["payee"]["name"]["value"] == "合成甲公司"
    assert result["payer"]["bank"]["value"] == result["payee"]["bank"]["value"] == "示例银行甲支行"
    assert result["payer"]["account"]["value"] == "00123456789"
    assert result["payee"]["account"]["value"] == "00987654321"


@pytest.mark.parametrize("change", ["partial", "reversed", "gap", "misaligned"])
def test_incomplete_or_nonadjacent_vertical_headers_do_not_guess_sides(change):
    page = _vertical_table_page()
    words = list(page.words)
    if change == "partial":
        words = [w for w in words if not (w[4] == "人" and w[0] == 14)]
    elif change == "reversed":
        words = [(*w[:4], "人" if w[4] == "付" else "付" if w[4] == "人" and w[0] == 14 else w[4], *w[5:]) for w in words]
    elif change == "gap":
        words = [(w[0], w[1] + 40, w[2], w[3] + 40, *w[4:]) if w[4] == "人" and w[0] == 14 else w for w in words]
    else:
        words = [(w[0] + 15, w[1], w[2] + 15, *w[3:]) if w[4] == "人" and w[0] == 14 else w for w in words]
    result = extract_receipt_parties(_WordPage(words), (0, 0, 590, 130))
    assert all(result[side][field]["state"] == "missing" for side in ("payer", "payee") for field in ("name", "account", "bank"))


def test_vertical_header_crossing_clip_and_adjacent_receipt_are_not_used():
    page = _vertical_table_page()
    result = extract_receipt_parties(page, (0, 0, 590, 70))
    assert all(result[side]["account"]["state"] == "missing" for side in ("payer", "payee"))
    adjacent = [tuple([w[0], w[1] + 150, w[2], w[3] + 150, *w[4:]]) for w in page.words]
    page.words.extend(adjacent)
    result = extract_receipt_parties(page, (0, 0, 590, 130))
    assert result["payer"]["account"]["value"] == "00123456789"
    assert result["payee"]["account"]["value"] == "00987654321"


def test_same_row_empty_cell_never_borrows_other_party_or_next_field():
    page = _vertical_table_page()
    page.words = [w for w in page.words if w[4] != "00123456789"]
    result = extract_receipt_parties(page, (0, 0, 590, 130))
    assert result["payer"]["account"]["state"] == "missing"
    assert result["payee"]["account"]["value"] == "00987654321"


def test_vertical_table_conflicting_same_cell_values_remain_ambiguous():
    page = _vertical_table_page()
    page.words.append(_word(72, 53.9, "00555555555", 100, 0, 99))
    result = extract_receipt_parties(page, (0, 0, 590, 130))
    assert result["payer"]["account"]["state"] == "ambiguous"
    assert any(issue["code"] == "conflicting_field_values" for issue in result["diagnostics"]["issues"])


def test_vertical_table_blank_marker_and_masked_value_keep_their_meanings():
    page = _vertical_table_page()
    page.words = [(*w[:4], "—" if w[4] == "合成乙公司" else "00****4321" if w[4] == "00987654321" else w[4], *w[5:]) for w in page.words]
    result = extract_receipt_parties(page, (0, 0, 590, 130))
    assert result["payee"]["name"]["state"] == "blank"
    assert result["payee"]["account"]["state"] == "ambiguous"


def test_unrelated_single_glyphs_and_bank_watermark_do_not_become_fields():
    page = _vertical_table_page()
    page.words.extend([
        _word(240, 150, "付", 100, 0, 9), _word(240, 162, "款", 101, 0, 9),
        _word(240, 174, "人", 102, 0, 9),
        (50, 20, 220, 110, "示例银行", 103, 0, 0),
    ])
    result = extract_receipt_parties(page, (0, 0, 590, 220))
    assert result["payer"]["name"]["value"] == "合成甲公司"
    assert result["payer"]["account"]["value"] == "00123456789"
    assert result["payer"]["bank"]["value"] == "示例银行甲支行"


def test_native_pdf_vertical_headers_read_values_even_when_written_before_labels():
    import pymupdf
    with pymupdf.open() as document:
        page = document.new_page(width=595, height=400)
        for top in (0, 180):
            for x, heading, name, account in [
                (14, "付款人", "合成甲公司", "00123456789"),
                (301, "收款人", "合成乙公司", "00987654321"),
            ]:
                for y, label, value in [(40, "户名", name), (62, "账号", account), (84, "开户行", "示例银行")]:
                    page.insert_text((x + 58, y + top - 0.1), value, fontname="china-s", fontsize=9)
                    page.insert_text((x + 25, y + top), label, fontname="china-s", fontsize=9)
                for offset, character in enumerate(heading):
                    page.insert_text((x, 50 + offset * 12 + top), character, fontname="china-s", fontsize=9)
        result = extract_receipt_parties(page, (0, 0, 595, 130))
        assert result["payer"]["name"]["value"] == "合成甲公司"
        assert result["payee"]["name"]["value"] == "合成乙公司"
        assert result["payer"]["account"]["value"] == "00123456789"
        assert result["payee"]["account"]["value"] == "00987654321"
        assert all(result[side][field]["state"] == "present" for side in ("payer", "payee") for field in ("name", "account", "bank"))


def test_two_receipts_in_one_scope_do_not_silently_choose_a_vertical_table():
    page = _vertical_table_page()
    page.words.extend([tuple([w[0], w[1] + 150, w[2], w[3] + 150, *w[4:]]) for w in list(page.words)])
    result = extract_receipt_parties(page, (0, 0, 590, 290))
    assert all(result[side][field]["state"] == "missing" for side in ("payer", "payee") for field in ("name", "account", "bank"))


def test_vertical_table_company_words_are_values_not_embedded_party_labels():
    page = _vertical_table_page()
    page.words = [(*w[:4], "合成代付款服务公司" if w[4] == "合成乙公司" else w[4], *w[5:]) for w in page.words]
    result = extract_receipt_parties(page, (0, 0, 590, 130))
    assert result["payer"]["name"]["value"] == "合成甲公司"
    assert result["payee"]["name"]["value"] == "合成代付款服务公司"
    assert result["payer"]["name"]["state"] == result["payee"]["name"]["state"] == "present"


def test_explicit_both_parties_on_same_line_still_keep_separate_fields():
    page = _parsed_page([
        (20, 20, "付款方名称：合成甲公司；收款方名称：合成乙公司", 500),
        (20, 40, "付款方账号：00123456789；收款方账号：00987654321", 500),
    ])
    result = extract_receipt_parties(page, (0, 0, 590, 130))
    assert result["payer"]["name"]["value"] == "合成甲公司"
    assert result["payee"]["name"]["value"] == "合成乙公司"
    assert result["payer"]["account"]["value"] == "00123456789"
    assert result["payee"]["account"]["value"] == "00987654321"


@pytest.mark.parametrize("treasury_label", ["收款国库（银行）名称", "收款国库(银行)名称"])
def test_tax_voucher_uses_business_labels_without_title_or_payee_name_conflict(treasury_label: str):
    page = _parsed_page([
        (20, 20, "上海银行电子缴税付款凭证", 420),
        (20, 52, "纳税人全称及纳税人识别号：合成甲公司 91310000MA5TEST01", 520),
        (20, 74, "付款人全称：合成甲公司", 360),
        (20, 94, "付款人账号：000123456789", 260),
        (20, 114, "付款人开户银行：示例银行甲支行", 360),
        (300, 140, "征收机关名称：合成税务机关（1）", 300),
        (300, 160, f"{treasury_label}：示例国库甲支库", 290),
    ], height=240)

    result = extract_receipt_parties(page, (0, 0, 600, 220))

    assert result["payer"]["name"]["value"] == "合成甲公司"
    assert result["payer"]["account"]["value"] == "000123456789"
    assert result["payer"]["bank"]["value"] == "示例银行甲支行"
    assert result["payee"]["name"]["value"] == "合成税务机关(1)"
    assert result["payee"]["bank"]["value"] == "示例国库甲支库"
    assert result["payer"]["name"]["state"] == "present"
    assert result["payee"]["name"]["state"] == "present"
    assert not any(issue["code"] == "conflicting_field_values" for issue in result["diagnostics"]["issues"])


def test_tax_voucher_title_alone_does_not_become_payer_name():
    page = _parsed_page([(20, 20, "上海银行电子缴税付款凭证", 420)], height=160)

    result = extract_receipt_parties(page, (0, 0, 600, 140))

    assert result["payer"]["name"]["state"] == "missing"
    assert result["payer"]["name"]["value"] == ""
    assert result["payee"]["name"]["state"] == "missing"


def test_tax_specific_labels_stay_disabled_without_tax_voucher_heading():
    page = _parsed_page([
        (20, 20, "付款人全称：合成甲公司", 300),
        (300, 20, "收款国库（银行）名称：示例国库甲支库", 290),
    ], height=100)

    result = extract_receipt_parties(page, (0, 0, 600, 90))

    # A generic receipt must not gain the tax-voucher treasury-bank mapping
    # merely because a similar phrase appears in its text layer.
    assert result["payee"]["bank"]["state"] == "missing"


def test_tax_voucher_missing_payer_account_is_not_filled_from_other_fields():
    page = _parsed_page([
        (20, 20, "上海银行电子缴税付款凭证", 420),
        (20, 58, "付款人全称：合成甲公司", 300),
        (20, 78, "付款人账号：", 240),
        (20, 98, "付款人开户银行：示例银行甲支行", 300),
        (300, 130, "征收机关名称：合成税务机关", 280),
    ], height=200)

    result = extract_receipt_parties(page, (0, 0, 600, 180))

    assert result["payer"]["account"]["state"] == "missing"
    assert result["payer"]["account"]["value"] == ""
