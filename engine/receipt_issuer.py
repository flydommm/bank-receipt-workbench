"""Conservative issuer masthead recognition shared by crop and layout code.

An account-bank value can be printed separately from its field label. Callers
must use :func:`issuer_masthead_bank` with surrounding lines, not the lexical
helper alone, when assigning a heading to a receipt.
"""

from __future__ import annotations

import re
from typing import Iterable
import unicodedata


TextLine = tuple[str, tuple[float, float, float, float]]
_ISSUER_ALIASES = {
    "工商银行": "中国工商银行", "农业银行": "中国农业银行",
    "建设银行": "中国建设银行", "交通银行": "交通银行",
    "邮政储蓄银行": "中国邮政储蓄银行", "民生银行": "中国民生银行",
    "光大银行": "中国光大银行", "招商银行": "招商银行",
    "中信银行": "中信银行", "浦发银行": "上海浦东发展银行",
    "上海浦东发展银行": "上海浦东发展银行", "兴业银行": "兴业银行",
    "平安银行": "平安银行", "华夏银行": "华夏银行",
    "广发银行": "广发银行", "中国银行": "中国银行",
}
_HEADER_BANK = re.compile(r"[\u4e00-\u9fff]{2,18}(?:银行|农村信用合作联社|农村信用社)")
_NON_ISSUER_WORDS = ("开户", "付款", "收款", "银行行号", "账号", "户名", "对方", "对手", "代理", "清算")
_ACCOUNT_LABELS = (
    "开户", "付款人", "收款人", "付款方", "收款方", "付款行", "收款行", "付款银行", "收款银行",
    "付方银行", "收方银行", "银行行号", "银行名称", "账号", "户名", "对方银行", "对手银行",
    "付款：", "付款:", "收款：", "收款:", "行名：", "行名:",
)


def canonical_bank_heading(text: str) -> str | None:
    """Lexical normalization only; it cannot establish receipt ownership."""
    compact = re.sub(r"[A-Za-z\s·.\-]+", "", unicodedata.normalize("NFC", text))
    if any(word in compact for word in _NON_ISSUER_WORDS) or not _HEADER_BANK.fullmatch(compact):
        return None
    if compact in _ISSUER_ALIASES:
        return _ISSUER_ALIASES[compact]
    return _ISSUER_ALIASES.get(compact.removeprefix("中国"), compact)


def issuer_masthead_bank(text: str, box: tuple[float, float, float, float], text_lines: Iterable[TextLine]) -> str | None:
    """Reject a bank value accompanied by a same-row or wrapping field label.

    Bank logos and headings often share a row with the receipt title, so
    ``支付业务回单（付款）`` is not an account label. Explicit payer/payee and
    account-bank labels are. A nearby preceding label also protects PDFs that
    split one logical field across lines or separate text blocks.
    """
    bank = canonical_bank_heading(text)
    if bank is None:
        return None
    _x0, y0, _x1, y1 = box
    for other_text, (_left, top, _right, bottom) in text_lines:
        compact = "".join(other_text.split())
        if not any(label in compact for label in _ACCOUNT_LABELS):
            continue
        same_row = min(y1, bottom) > max(y0, top) or abs(top - y0) <= 2.0
        wrapped_previous_line = 0 <= y0 - bottom <= 20.0
        if same_row or wrapped_previous_line:
            return None
    return bank
