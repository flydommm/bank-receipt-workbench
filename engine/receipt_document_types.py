"""Bounded, title-based notices for non-standard bank documents.

Only an isolated native/OCR heading near the page top establishes a type.
Neither filenames, bank watermarks nor transaction text establish identity.
"""
from __future__ import annotations

from hashlib import sha256
import json
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .pdf_parser import ParsedPage


DOCUMENT_TYPES = frozenset({"loan_interest_notice", "loan_settlement_notice", "electronic_tax_payment"})
_TITLES = {
    "贷款利息到期通知书": "loan_interest_notice",
    "贷款清算通知书": "loan_settlement_notice",
    "电子缴税付款凭证": "electronic_tax_payment",
    "上海银行电子缴税付款凭证": "electronic_tax_payment",
}
_FIXED_LABELS = ("日期", "放款编号", "客户号", "客户备注", "到期利息金额预计",
                 "打印次数", "回单编号")


def document_type_for_title(text: str) -> str | None:
    """Exact heading match: comments quoting a title are not headings."""
    if not isinstance(text, str) or len(text) > 128:
        return None
    return _TITLES.get("".join(text.split()))


def detect_document_type(parsed: ParsedPage) -> str | None:
    if not 0 < len(parsed.blocks) <= 4096:
        return None
    kinds = {
        kind for block in parsed.blocks
        if not block.is_watermark and 0 <= block.y0 < parsed.height * 0.2
        and (kind := document_type_for_title(block.text)) is not None
    }
    return next(iter(kinds)) if len(kinds) == 1 else None


def document_layout_family(parsed: ParsedPage, document_type: str) -> str:
    """Separate special types and their fixed field arrangement, without values.

    This is not bank evidence. With no verified issuer, calibration continues
    to require a source-local match and matching slot geometry.
    """
    headings = [block for block in parsed.blocks if not block.is_watermark
                and document_type_for_title(block.text) == document_type]
    origin = min((block.y0 for block in headings), default=0.0)
    anchors = []
    for block in parsed.blocks:
        if block.is_watermark or len(block.text) > 4096:
            continue
        compact = "".join(block.text.split())
        label = next((value for value in _FIXED_LABELS if compact.startswith(value)), None)
        if label is not None:
            anchors.append([label, round(block.x0, 1), round(block.y0 - origin, 1)])
    payload = {"type": document_type, "page": [round(parsed.width, 1), round(parsed.height, 1)],
               "headings": [[round(b.x0, 1), round(b.y0 - origin, 1), round(b.y1 - b.y0, 1)] for b in headings],
               "anchors": sorted(anchors)}
    return sha256(json.dumps(payload, sort_keys=True, ensure_ascii=True).encode("ascii")).hexdigest()
