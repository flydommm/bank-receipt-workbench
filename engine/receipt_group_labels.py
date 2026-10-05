"""Human-readable grouping labels without changing internal document codes."""

from typing import Any, Mapping


_DOCUMENT_LABELS = {
    "ordinary": "普通回单",
    "other_special": "其他特殊单证",
    "loan_settlement_notice": "贷款清算通知书",
    "loan_interest_notice": "贷款利息到期通知书",
    "electronic_tax_payment": "电子缴税付款凭证",
    "bank_fee": "银行收费凭证",
    "deposit_interest": "存款结息凭证",
}


def document_type_label(value: object) -> str:
    if value is None or value == "":
        return "普通回单"
    return _DOCUMENT_LABELS.get(value, value) if isinstance(value, str) else "其他特殊单证"


def group_display_name(group: Mapping[str, Any]) -> str:
    name = group.get("display_name", group.get("name", ""))
    if not isinstance(name, str):
        return ""
    # Translate type codes only. Manual display names remain the user's text.
    return document_type_label(name) if group.get("kind") == "special" else name
