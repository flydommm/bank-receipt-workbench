"""Regression coverage for two-column receipt tables using ``全称`` labels.

The fixture is synthetic and contains no customer material.  Several banks
print payer/payee as a vertical three-character header while the name row is
labelled ``全称`` instead of ``名称``.  The geometry intentionally mirrors the
wide gap in that layout so the role detector cannot fall back to nearest text.
"""

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

import pymupdf
import pytest

from engine.receipt_grouping_api import _extract_selected
from engine.receipt_grouping_models import derive_grouping_decision
from engine.receipt_parties import extract_receipt_parties


@dataclass
class FullNameTablePage:
    rows: list[tuple[float, float, str, float, float]]
    width: float = 1008.0
    height: float = 600.0

    @property
    def rect(self):
        return (0.0, 0.0, self.width, self.height)

    def get_text(self, mode, **kwargs):
        if mode != "dict":
            return []
        return {
            "blocks": [{
                "type": 0,
                "lines": [{
                    "spans": [{"text": text, "bbox": (x, y, x + width, y + font_height)}],
                }],
            } for x, y, text, width, font_height in self.rows],
        }


def _table(*, sides=("付款人", "收款人"), scale=1.0, wrapped=False, column_values=None):
    """Build a wide two-column table with isolated role characters."""
    rows = []
    base = {
        "付款人": (140.0, "合成付款方有限公司", "001234567890", "合成银行甲支行"),
        "收款人": (540.0, "合成收款方有限公司", "009876543210", "合成银行乙支行"),
    }
    for column, (x, side) in enumerate(zip((140.0, 540.0), sides)):
        # Keep the same absolute column positions when sides are reversed.  A
        # role is identified from its printed characters, never from a bank.
        _unused, name, account, bank = base[side]
        if column_values is not None:
            name, account, bank = column_values[column]
        for index, character in enumerate(side):
            rows.append((x * scale, (242.84 + index * 19.54) * scale,
                         character, 12.0 * scale, 12.0 * scale))
        label_x = (234.0 if x < 300 else 634.0) * scale
        value_x = (306.0 if x < 300 else 706.0) * scale
        labels = [(217.38, "全称", name), (257.15, "账号", account),
                  (307.38, "开户行", bank)]
        for y, label, value in labels:
            rows.append((label_x, y * scale, label, 24.0 * scale, 12.0 * scale))
            if wrapped and label in {"全称", "开户行"}:
                midpoint = len(value) // 2
                rows.append((value_x, (y - 1) * scale, value[:midpoint], 145.0 * scale, 9.0 * scale))
                rows.append((value_x, (y + 9) * scale, value[midpoint:], 145.0 * scale, 9.0 * scale))
            else:
                rows.append((value_x, (y - 1) * scale, value, 145.0 * scale, 9.0 * scale))
    return rows


def _read(rows, *, rect=None, scale=1.0):
    page = FullNameTablePage(rows, width=1008.0 * scale, height=600.0 * scale)
    if rect is None:
        rect = (0.0, 0.0, page.width, page.height)
    return extract_receipt_parties(page, rect)


def test_wide_vertical_roles_read_full_name_account_and_bank():
    result = _read(_table())

    assert result["payer"]["name"]["value"] == "合成付款方有限公司"
    assert result["payer"]["account"]["value"] == "001234567890"
    assert result["payer"]["bank"]["value"] == "合成银行甲支行"
    assert result["payee"]["name"]["value"] == "合成收款方有限公司"
    assert result["payee"]["account"]["value"] == "009876543210"
    assert result["payee"]["bank"]["value"] == "合成银行乙支行"
    assert result["diagnostics"]["status"] == "ok"
    assert not {item["code"] for item in result["diagnostics"]["issues"]} & {
        "generic_label_side_unknown", "unsupported_layout", "role_unresolved",
    }


@pytest.mark.parametrize("scale", [0.75, 1.0, 1.25])
def test_full_name_table_scales_keep_the_same_role_mapping(scale):
    result = _read(_table(scale=scale), scale=scale)
    assert result["payer"]["name"]["state"] == "present"
    assert result["payee"]["name"]["state"] == "present"
    assert result["payer"]["account"]["value"] == "001234567890"
    assert result["payee"]["account"]["value"] == "009876543210"


def test_printed_roles_can_be_reversed_without_using_column_position():
    result = _read(_table(sides=("收款人", "付款人")))
    assert result["payer"]["name"]["value"] == "合成付款方有限公司"
    assert result["payee"]["name"]["value"] == "合成收款方有限公司"
    assert result["payer"]["bank"]["value"] == "合成银行甲支行"
    assert result["payee"]["bank"]["value"] == "合成银行乙支行"


def test_wrapped_chinese_name_and_bank_stay_inside_their_cells():
    result = _read(_table(wrapped=True))
    assert result["payer"]["name"]["value"] == "合成付款方有限公司"
    assert result["payee"]["name"]["value"] == "合成收款方有限公司"
    assert result["payer"]["bank"]["value"] == "合成银行甲支行"
    assert result["payee"]["bank"]["value"] == "合成银行乙支行"


def test_clipped_single_column_does_not_borrow_a_missing_role():
    result = _read(_table(), rect=(0.0, 0.0, 500.0, 600.0))
    assert result["payee"]["name"]["state"] == "missing"
    assert result["payer"]["name"]["state"] == "missing"
    assert result["diagnostics"]["status"] == "needs_review"


def test_existing_name_label_layout_remains_supported():
    rows = []
    for x, y, text, width, height in _table():
        # Keep this comparison in the ordinary geometry already covered by
        # the legacy parser: the label cell is close to the role header.
        if text == "全称":
            text = "名称"
            x -= 64.0
        elif text in {"账号", "开户行"}:
            x -= 64.0
        elif x in {306.0, 706.0}:
            x -= 64.0
        rows.append((x, y, text, width, height))
    result = _read(rows)
    assert result["payer"]["name"]["value"] == "合成付款方有限公司"
    assert result["payee"]["name"]["value"] == "合成收款方有限公司"


def test_metadata_full_name_is_not_treated_as_a_party_label():
    rows = _table()
    rows += [(20.0, 180.0, "银行全称：合成银行总行", 260.0, 12.0),
             (20.0, 198.0, "业务全称：合成付款业务", 260.0, 12.0)]
    result = _read(rows)
    assert result["payer"]["name"]["value"] == "合成付款方有限公司"
    assert result["payee"]["name"]["value"] == "合成收款方有限公司"
    assert result["payer"]["name"]["state"] == result["payee"]["name"]["state"] == "present"


def _partial_role_rows(*, two_headers=True, truncated=False):
    rows = []
    for x, role in ((20.0, "付款人"), (80.0, "收款人")):
        if not two_headers and x > 20.0:
            continue
        characters = role[:-1] if truncated and x > 20.0 else role
        for index, character in enumerate(characters):
            rows.append((x, 40.0 + index * 19.54, character, 12.0, 12.0))
    # These fields are deliberately associated with neither complete role.
    for y, label, value in [(40.0, "全称", "合成孤立名称"),
                            (80.0, "账号", "001234567890"),
                            (120.0, "开户行", "合成孤立银行")]:
        rows.append((120.0, y, label, 24.0, 12.0))
        rows.append((170.0, y - 1.0, value, 100.0, 9.0))
    return rows


@pytest.mark.parametrize("kwargs", [
    {"two_headers": True, "truncated": False},
    {"two_headers": False, "truncated": False},
    {"two_headers": True, "truncated": True},
])
def test_incomplete_role_geometry_stays_unresolved(kwargs):
    result = _read(_partial_role_rows(**kwargs), rect=(0.0, 0.0, 300.0, 200.0))
    for side in ("payer", "payee"):
        for field in ("name", "account", "bank"):
            assert result[side][field]["state"] == "missing"
    assert result["diagnostics"]["status"] == "needs_review"


def _tight_wrapped_table(*, competing_bank=False, trailing_field=False, name_parts=None):
    """Use the 12pt/0.82pt-overlap row geometry seen in real PDF text."""
    rows = []
    values = {
        "付款人": ("合成付款服务有限公司", "001234567890", "合成银行甲支行营业部"),
        "收款人": ("合成收款服务有限公司", "009876543210", "合成银行乙支行营业部"),
    }
    for x, side in ((140.0, "付款人"), (540.0, "收款人")):
        name, account, bank = values[side]
        for index, character in enumerate(side):
            rows.append((x, 242.84 + index * 19.54, character, 12.0, 12.0))
        label_x = 234.0 if x < 300 else 634.0
        value_x = 306.0 if x < 300 else 706.0
        # The label and first value overlap as they do in the source text
        # layer. The continuation begins 0.82pt before the label's bottom.
        for y, label, value in ((217.38, "全称", name), (257.15, "账号", account),
                                (307.38, "开户行", bank)):
            rows.append((label_x, y, label, 24.0, 12.0))
            if label == "账号":
                rows.append((value_x, 256.59, value, 145.0, 12.0))
            else:
                if label == "全称" and name_parts is not None:
                    first, second = name_parts[side]
                elif label == "开户行":
                    # Keep the first line a complete bank branch name; the
                    # continuation is the short department suffix.
                    first, second = value[:-3], value[-3:]
                else:
                    midpoint = len(value) // 2
                    first, second = value[:midpoint], value[midpoint:]
                rows.append((value_x, y - 2.79, first, 145.0, 12.0))
                rows.append((value_x, y + 11.18, second, 145.0, 12.0))
        if competing_bank:
            # Same baseline and same value cell: retain both candidates as an
            # ambiguity instead of silently selecting or concatenating one.
            rows.append((value_x, 304.59, "另一家银行", 145.0, 12.0))
        if trailing_field:
            # A later generic label closes the bank row; its value must not be
            # joined to the bank continuation merely because x is identical.
            rows.append((label_x, 347.38, "全称", 24.0, 12.0))
            rows.append((value_x, 344.59, "后续字段文本", 145.0, 12.0))
    return rows


def test_realistic_twelve_point_continuations_keep_full_names_and_banks():
    result = _read(_tight_wrapped_table())
    assert result["payer"]["name"]["value"] == "合成付款服务有限公司"
    assert result["payee"]["name"]["value"] == "合成收款服务有限公司"
    assert result["payer"]["bank"]["value"] == "合成银行甲支行营业部"
    assert result["payee"]["bank"]["value"] == "合成银行乙支行营业部"


def test_far_or_next_label_text_is_not_appended_to_bank_cell():
    result = _read(_tight_wrapped_table(trailing_field=True))
    assert result["payer"]["bank"]["value"] == "合成银行甲支行营业部"
    assert result["payee"]["bank"]["value"] == "合成银行乙支行营业部"


def _bank_summary_boundary_table(*, with_continuation, label_position="regular"):
    rows = _tight_wrapped_table()
    if not with_continuation:
        rows = [row for row in rows if abs(row[1] - 318.56) > 0.01]
    if label_position == "regular":
        columns = ((234.0, 306.0), (634.0, 706.0))
    elif label_position == "left_of_role":
        # Some PDFs place the next-row label to the left of the vertical role
        # cell while its value remains in the same value column. It still
        # belongs to that role's table and must close the previous cell.
        columns = ((100.0, 306.0), (500.0, 706.0))
    else:
        raise AssertionError(f"unknown label position: {label_position}")
    for label_x, value_x in columns:
        boundary_y = 331.0 if with_continuation else 318.56
        rows.extend([(label_x, boundary_y, "摘要", 24.0, 12.0),
                     (value_x, boundary_y, "后续摘要文本", 145.0, 12.0)])
    return rows


@pytest.mark.parametrize("label_position", ["regular", "left_of_role"])
def test_summary_boundary_below_tight_continuation_does_not_enter_bank_value(label_position):
    result = _read(_bank_summary_boundary_table(with_continuation=True, label_position=label_position))
    assert result["payer"]["bank"]["value"] == "合成银行甲支行营业部"
    assert result["payee"]["bank"]["value"] == "合成银行乙支行营业部"
    assert "后续摘要文本" not in result["payer"]["bank"]["value"]
    assert "后续摘要文本" not in result["payee"]["bank"]["value"]


@pytest.mark.parametrize("label_position", ["regular", "left_of_role"])
def test_summary_boundary_after_single_bank_line_does_not_enter_bank_value(label_position):
    result = _read(_bank_summary_boundary_table(with_continuation=False, label_position=label_position))
    assert result["payer"]["bank"]["value"] == "合成银行甲支行"
    assert result["payee"]["bank"]["value"] == "合成银行乙支行"
    assert "后续摘要文本" not in result["payer"]["bank"]["value"]
    assert "后续摘要文本" not in result["payee"]["bank"]["value"]


def test_competing_overlapping_bank_values_remain_ambiguous():
    result = _read(_tight_wrapped_table(competing_bank=True))
    assert result["payer"]["bank"]["state"] == "ambiguous"
    assert result["payee"]["bank"]["state"] == "ambiguous"


def test_continuation_containing_payment_word_stays_in_the_same_name_cell():
    rows = _tight_wrapped_table(name_parts={
        "付款人": ("合成付款", "含付款说明有限公司"),
        "收款人": ("合成收款", "含付款说明有限公司"),
    })
    result = _read(rows)
    assert result["payer"]["name"]["value"] == "合成付款含付款说明有限公司"
    assert result["payee"]["name"]["value"] == "合成收款含付款说明有限公司"


def _make_two_page_text_pdf(path: Path):
    with pymupdf.open() as document:
        tables = [
            _table(),
            _table(sides=("收款人", "付款人"), column_values=(
                ("合成付款方有限公司", "001234567890", "合成付款银行"),
                ("合成收款方有限公司", "009876543210", "合成收款银行"),
            )),
        ]
        for table_rows in tables:
            page = document.new_page(width=1008, height=600)
            # Insert each synthetic table row at its intended top coordinate.
            # PyMuPDF receives a baseline, so adding the font height makes the
            # extracted bbox match the CellPage geometry used above.
            for x, y, text, _width, font_height in table_rows:
                page.insert_text((x, y + font_height), text,
                                 fontname="china-s", fontsize=font_height)
        document.save(path)


def test_full_name_extraction_pipeline_assigns_payer_and_payee_without_bank_title(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    path = tmp_path / "synthetic-full-name.pdf"
    _make_two_page_text_pdf(path)
    source_hash = sha256(path.read_bytes()).hexdigest()
    source = {"access_path": str(path), "sha256": source_hash,
              "size_bytes": path.stat().st_size, "page_count": 2, "source_key": "synthetic"}
    rows = [{"id": "payer", "source_key": "synthetic", "source_page": 1,
             "final_rect": {"x0": 0.0, "y0": 0.0, "x1": 1008.0, "y1": 600.0}},
            {"id": "payee", "source_key": "synthetic", "source_page": 2,
             "final_rect": {"x0": 0.0, "y0": 0.0, "x1": 1008.0, "y1": 600.0}}]
    extracted = _extract_selected({"job": {"sources": [source]}}, rows, {"payer", "payee"})
    account = {"company_name": "合成付款方有限公司", "bank_name": "无标题银行",
               "account_number": "001234567890"}
    decisions = [derive_grouping_decision({**row, **extracted[row["id"]], "review_status": "confirmed"}, account)
                 for row in rows]
    assert decisions[0]["own_decision"]["side"] == "payer"
    assert decisions[1]["own_decision"]["side"] == "payee"
    assert [decision["route"] for decision in decisions] == ["named", "named"]
    assert [decision["counterparty"]["name"]["value"] for decision in decisions] == [
        "合成收款方有限公司", "合成收款方有限公司",
    ]
    assert sha256(path.read_bytes()).hexdigest() == source_hash
