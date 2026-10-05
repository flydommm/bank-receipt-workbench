"""Synthetic regression coverage for the Ningbo customer-receipt layout."""

from __future__ import annotations

import pymupdf
import pytest

from engine.receipt_parties import extract_receipt_parties


OWN = {
    "name": "合成本方公司",
    "account": "000111222333",
    "bank": "合成宁波银行示例支行",
}


def _draw_receipt(
    page: pymupdf.Page,
    *,
    top: float,
    direction: str | None,
    loose_generic_name: str | None = None,
    own_account: str = OWN["account"],
    counterparty_name: str | None = "合成交易对手公司",
    counterparty_account: str = "000999888777",
    counterparty_bank: str = "合成对手银行",
) -> tuple[float, float, float, float]:
    page.insert_text((200, top + 18), "宁波银行客户回单", fontname="china-s", fontsize=10)
    for offset, label, value in (
        (50, "账号", own_account),
        (68, "户名", OWN["name"]),
        (86, "开户银行", OWN["bank"]),
    ):
        page.insert_text((30, top + offset), f"{label}：{value}", fontname="china-s", fontsize=9)
    if direction:
        page.insert_text((200, top + 112), direction, fontname="china-s", fontsize=9)
        if loose_generic_name is not None:
            page.insert_text((200, top + 124), f"名称：{loose_generic_name}", fontname="china-s", fontsize=9)
        if direction == "转账存入":
            lower_rows = (
                (135, "付款户名", counterparty_name),
                (153, "付款账户", counterparty_account),
                (171, "付款行行名", counterparty_bank),
            )
        else:
            lower_rows = (
                (135, "收款人账号", counterparty_account),
                (153, "收款人户名", counterparty_name),
                (171, "收款行行名", counterparty_bank),
            )
        for offset, label, value in lower_rows:
            suffix = "" if value is None else value
            page.insert_text((200, top + offset), f"{label}：{suffix}", fontname="china-s", fontsize=9)
    return (0, top, 595, top + 210)


def _page_with_receipts(*receipts: dict) -> tuple[pymupdf.Document, list[tuple[float, float, float, float]]]:
    document = pymupdf.open()
    page = document.new_page(width=595, height=520)
    rects = []
    for index, options in enumerate(receipts):
        rects.append(_draw_receipt(page, top=index * 250, **options))
    return document, rects


def _extract(page: pymupdf.Page, rect: tuple[float, float, float, float]) -> dict:
    return extract_receipt_parties(page, rect)


@pytest.mark.parametrize(
    ("direction", "own_side", "counterparty_side"),
    [("转账存入", "payee", "payer"), ("转账支取", "payer", "payee")],
)
def test_ningbo_direction_assigns_upper_generic_table_and_lower_party(
    direction: str, own_side: str, counterparty_side: str,
) -> None:
    document, rects = _page_with_receipts({"direction": direction})
    try:
        result = _extract(document[0], rects[0])
    finally:
        document.close()

    assert result[own_side]["account"]["value"] == OWN["account"]
    assert result[own_side]["name"]["value"] == OWN["name"]
    assert result[own_side]["bank"]["value"] == OWN["bank"]
    assert result[counterparty_side]["name"]["value"] == "合成交易对手公司"
    assert result[counterparty_side]["account"]["value"] == "000999888777"
    assert result[counterparty_side]["bank"]["value"] == "合成对手银行"


def test_ningbo_same_counterparty_name_keeps_different_accounts_in_each_receipt() -> None:
    document, rects = _page_with_receipts(
        {"direction": "转账支取", "counterparty_name": "合成同名对手", "counterparty_account": "000999888777"},
        {"direction": "转账支取", "counterparty_name": "合成同名对手", "counterparty_account": "000999888666"},
    )
    try:
        first = _extract(document[0], rects[0])
        second = _extract(document[0], rects[1])
    finally:
        document.close()

    assert first["payee"]["name"]["value"] == second["payee"]["name"]["value"] == "合成同名对手"
    assert first["payee"]["account"]["value"] == "000999888777"
    assert second["payee"]["account"]["value"] == "000999888666"


def test_ningbo_empty_counterparty_name_does_not_borrow_own_name() -> None:
    document, rects = _page_with_receipts({"direction": "转账支取", "counterparty_name": None})
    try:
        result = _extract(document[0], rects[0])
    finally:
        document.close()

    assert result["payer"]["name"]["value"] == OWN["name"]
    assert result["payee"]["name"]["state"] in {"missing", "blank"}
    assert result["payee"]["name"]["value"] != OWN["name"]


def test_ningbo_counterparty_name_containing_payment_word_is_value_not_payer_label() -> None:
    document, rects = _page_with_receipts({"direction": "转账支取", "counterparty_name": "合成代付款服务公司"})
    try:
        result = _extract(document[0], rects[0])
    finally:
        document.close()

    assert result["payee"]["name"]["value"] == "合成代付款服务公司"
    assert result["payee"]["name"]["state"] == "present"
    assert not any(
        issue.get("side") == "payer" and issue.get("field") == "name"
        for issue in result["diagnostics"]["issues"]
    )


def test_ningbo_lower_bare_name_does_not_override_complete_directional_name() -> None:
    document, rects = _page_with_receipts(
        {"direction": "转账支取", "loose_generic_name": "合成备注名称"},
    )
    try:
        result = _extract(document[0], rects[0])
    finally:
        document.close()

    assert result["payee"]["name"]["state"] == "present"
    assert result["payee"]["name"]["value"] == "合成交易对手公司"
    assert not any(
        issue.get("side") == "payee"
        and issue.get("field") == "name"
        and issue.get("code") == "conflicting_field_values"
        for issue in result["diagnostics"]["issues"]
    )


def test_ningbo_distinct_upper_and_directional_bank_values_stay_for_review() -> None:
    document, rects = _page_with_receipts({"direction": "转账存入"})
    try:
        document[0].insert_text(
            (200, rects[0][1] + 189),
            "收款行名：合成另一行名",
            fontname="china-s",
            fontsize=9,
        )
        result = _extract(document[0], rects[0])
    finally:
        document.close()

    assert result["payee"]["bank"]["state"] == "ambiguous"
    assert any(
        issue.get("side") == "payee"
        and issue.get("field") == "bank"
        and issue.get("code") == "conflicting_field_values"
        for issue in result["diagnostics"]["issues"]
    )


def test_ningbo_adjacent_receipts_are_not_used_across_segment_boundary() -> None:
    document, rects = _page_with_receipts(
        {"direction": "转账支取", "counterparty_account": "000999888777"},
        {"direction": "转账支取", "counterparty_account": "000999888666"},
    )
    try:
        first = _extract(document[0], rects[0])
        second = _extract(document[0], rects[1])
        combined = _extract(document[0], (0, 0, 595, 460))
    finally:
        document.close()

    assert first["payer"]["account"]["value"] == OWN["account"]
    assert second["payer"]["account"]["value"] == OWN["account"]
    assert first["payee"]["account"]["value"] == "000999888777"
    assert second["payee"]["account"]["value"] == "000999888666"
    # Two titles/directions disable the Ningbo block mapping; the combined
    # scope must not produce one clean orientation by silently choosing a row.
    assert combined["payer"]["account"]["state"] != "present" or combined["payee"]["account"]["state"] != "present"


def test_ningbo_unknown_direction_does_not_guess_upper_table_side() -> None:
    document, rects = _page_with_receipts({"direction": None})
    try:
        result = _extract(document[0], rects[0])
    finally:
        document.close()

    assert result["payer"]["account"]["state"] == "missing"
    assert result["payee"]["account"]["state"] != "present"
