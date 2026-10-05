"""Bounded role-neutral field candidates shared by automatic/local readers."""
from __future__ import annotations

from copy import deepcopy
import re
from typing import Any, Mapping, Sequence
import unicodedata

FIELDS = ("name", "account", "bank")
ROLES = ("payer", "payee", "own", "counterparty", "unknown")
STATES = ("present", "blank", "missing", "ambiguous")
MAX_CANDIDATES = 16
MAX_ISSUES = 64
ISSUE_MESSAGES = {
    "no_text": "当前片段没有可用文字，不能通过读取位置自动识别",
    "invalid_text": "文字内容不完整或编码异常，请对照原件核对",
    "missing_field": "已找到字段位置，但没有读到可确认的内容",
    "conflicting_field": "同一字段读到多个不同结果，请核对正确位置",
    "incomplete_account": "账号被遮挡或不完整，不能据此确定账户",
    "role_unresolved": "字段已读到，但本方与对方的位置关系尚不明确",
    "unsupported_layout": "当前版式没有可确认的字段依据，可设置读取位置",
    "source_conflict": "原件资料与本批公司或来源存在明确矛盾",
    "rule_incompatible": "当前片段与所选读取规则不匹配",
    "region_out_of_bounds": "读取位置超出当前片段范围",
}


def make_issue(code: str, field: str | None = None, role: str = "unknown") -> dict[str, Any]:
    if code not in ISSUE_MESSAGES or field not in (*FIELDS, None) or role not in ROLES:
        raise ValueError("invalid structured field issue")
    return {"code": code, "field": field, "role": role, "message": ISSUE_MESSAGES[code]}


def normalize_issues(value: object) -> list[dict[str, Any]]:
    """Project a whitelist; never propagate arbitrary diagnostic messages."""
    result = []
    if not isinstance(value, list):
        return result
    for entry in value:
        if not isinstance(entry, Mapping):
            continue
        code, field, role = entry.get("code"), entry.get("field"), entry.get("role", "unknown")
        if not isinstance(code, str) or code not in ISSUE_MESSAGES or field not in (*FIELDS, None) or role not in ROLES:
            continue
        issue = make_issue(code, field, role)
        if issue not in result:
            result.append(issue)
        if len(result) == MAX_ISSUES:
            break
    return result


def normalize_reader_dependencies(value: object) -> list[dict[str, str]]:
    result = []
    if isinstance(value, list):
        for entry in value[:16]:
            if not isinstance(entry, Mapping):
                continue
            reader_id, version = entry.get("reader_id"), entry.get("version")
            if all(isinstance(v, str) and re.fullmatch(r"[a-zA-Z0-9_.-]{1,80}", v) for v in (reader_id, version)):
                item = {"reader_id": reader_id, "version": version}
                if item not in result:
                    result.append(item)
    return result


def empty_field() -> dict[str, Any]:
    return {"raw": "", "value": "", "normalized": "", "state": "missing", "evidence": []}


def empty_party() -> dict[str, dict[str, Any]]:
    return {field: empty_field() for field in FIELDS}


def candidate_field(field: str, raw: str, evidence: object = None) -> dict[str, Any]:
    if field not in FIELDS:
        raise ValueError("invalid candidate field")
    text = unicodedata.normalize("NFKC", raw).strip()
    normalized = ("" if field == "account" else " ").join(text.split())
    state = "present"
    if not normalized:
        state = "missing"
    elif normalized in {"空", "空白", "未提供", "无", "—", "–", "-", "/", "\\"}:
        state, normalized = "blank", ""
    elif "\ufffd" in normalized or len(normalized) > 4096:
        state = "ambiguous"
    elif field == "name" and not any(char.isalnum() for char in normalized):
        state = "ambiguous"
    elif field == "account" and (
        not re.fullmatch(r"[0-9]+", normalized)
        or re.search(r"(?:尾号|末四位|后四位|后\d+位)", normalized)
    ):
        state = "ambiguous"
    return {"raw": raw[:4096], "value": normalized[:4096], "normalized": normalized[:4096],
            "state": state, "evidence": deepcopy(evidence) if evidence is not None else []}


def merge_field_candidates(field: str, candidates: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Keep true conflicts; an empty read is not proof of an empty original."""
    if field not in FIELDS:
        raise ValueError("invalid candidate field")
    unique: list[dict[str, Any]] = []
    for candidate in candidates:
        if candidate.get("state") == "missing":
            continue
        value = deepcopy(dict(candidate))
        if not any((value.get("value"), value.get("state")) == (old.get("value"), old.get("state")) for old in unique):
            unique.append(value)
        if len(unique) > MAX_CANDIDATES:
            break
    if not unique:
        return deepcopy(dict(candidates[0])) if candidates else empty_field()
    if len(unique) == 1:
        return unique[0]
    kept = unique[:MAX_CANDIDATES]
    raw = " | ".join(str(value.get("raw", "")) for value in kept)[:4096]
    normalized = " | ".join(str(value.get("value", "")) for value in kept)[:4096]
    return {"raw": raw, "value": normalized, "normalized": normalized, "state": "ambiguous",
            "evidence": deepcopy(kept[0].get("evidence", [])), "candidates": kept}
