"""Bounded, title-based notices for non-standard bank documents.

Only an isolated native/OCR heading near the page top establishes a type.
Neither filenames, bank watermarks nor transaction text establish identity.
"""
from __future__ import annotations

from hashlib import sha256
import json
import math
import re
from collections.abc import Mapping
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .pdf_parser import ParsedPage


DOCUMENT_TYPES = frozenset({"loan_interest_notice", "loan_settlement_notice", "electronic_tax_payment"})
# Grouping-only observations. These must not become a whole-page review type:
# ordinary transfers and bank service vouchers can share the same PDF page.
GROUPING_SERVICE_TYPES = frozenset({"bank_fee", "deposit_interest"})
_SERVICE_TITLES = {
    "客户付费回单": "bank_fee", "银行收费凭证": "bank_fee", "银行收费回单": "bank_fee", "收费回单": "bank_fee",
    "存款结息凭证": "deposit_interest", "存款结息回单": "deposit_interest",
    "存款利息单": "deposit_interest",
}
_SERVICE_FIELD_VALUES = {
    "业务类型": {"企业银行收费": "bank_fee", "银行收费": "bank_fee", "活期结息": "deposit_interest",
                 "存款结息": "deposit_interest"},
    "业务种类": {"银行收费": "bank_fee", "存款结息": "deposit_interest",
                 "贷方利息资本化(系统结息)": "deposit_interest"},
    # Only an exact bank service label/value pair is admitted. Generic words
    # like "手续费" may describe an ordinary payment and cannot classify it.
    "摘要": {"自助交易费": "bank_fee", "费用外收": "bank_fee", "开户手续费扣收": "bank_fee",
             "汇款费": "bank_fee", "季度结息": "deposit_interest", "结息转入": "deposit_interest"},
    "回单类型": {"业务收费凭证": "bank_fee"},
}
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


def detect_grouping_service_type(page, rect) -> str | None:
    """Read a fixed service title/field inside one already-reviewed fragment.

    This returns only a controlled observation, never a crop/classification
    edit. A caller must still preserve explicit counterparties, identity
    conflicts and manual decisions before assigning the special destination.
    """
    try:
        bounds = tuple(float(rect[k]) for k in ("x0", "y0", "x1", "y1")) if isinstance(rect, Mapping) else tuple(map(float, rect))
        if (len(bounds) != 4 or not all(math.isfinite(v) for v in bounds)
                or bounds[2] <= bounds[0] or bounds[3] <= bounds[1]):
            return None
        lines = []
        if hasattr(page, "blocks"):
            candidates = ((block.text, (block.x0, block.y0, block.x1, block.y1))
                          for block in page.blocks if not block.is_watermark)
        else:
            from .receipt_parties import _call_get_text, _coerce_rect
            data = _call_get_text(page, "dict", _coerce_rect(bounds))
            candidates = (("".join(span.get("text", "") for span in line.get("spans", [])), line["bbox"])
                          for block in data.get("blocks", []) for line in block.get("lines", []))
        for text, box in candidates:
            if len(lines) >= 4096 or not isinstance(text, str) or len(text) > 4096:
                return None
            if (bounds[0] <= box[0] < box[2] <= bounds[2]
                    and bounds[1] <= box[1] < box[3] <= bounds[3]):
                compact = "".join(text.split()).replace("（", "(").replace("）", ")")
                if compact:
                    lines.append((compact, tuple(map(float, box))))
        top = bounds[1] + min(100.0, (bounds[3] - bounds[1]) * .3)
        kinds = {kind for text, box in lines if box[1] <= top
                 if (kind := _SERVICE_TITLES.get(text)) is not None}
        for text, box in lines:
            for label, values in _SERVICE_FIELD_VALUES.items():
                inline = re.fullmatch(re.escape(label) + r"[:：](.+)", text)
                if inline:
                    kind = values.get(inline.group(1))
                    if kind:
                        kinds.add(kind)
                elif text.rstrip(":：") == label:
                    # Separate PDF text objects may still form one table cell.
                    # Use the nearest right-hand same-row value, never a later
                    # row or a string anywhere else in the fragment.
                    right = [(other_box[0], other) for other, other_box in lines
                             if other_box[0] >= box[2]
                             and other_box[0] - box[2] <= min(120.0, (bounds[2] - bounds[0]) * .3)
                             and min(box[3], other_box[3]) > max(box[1], other_box[1])
                             and abs(other_box[1] - box[1]) <= max(2.0, (box[3] - box[1]) * .25)]
                    if right:
                        closest = min(x for x, _ in right)
                        near = [other for x, other in right if abs(x - closest) <= .1]
                        if len(near) == 1 and (kind := values.get(near[0])):
                            kinds.add(kind)
        return next(iter(kinds)) if len(kinds) == 1 else None
    except (AttributeError, KeyError, TypeError, ValueError, RuntimeError):
        return None


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
