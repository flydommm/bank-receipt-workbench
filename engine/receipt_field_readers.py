"""Registered local text readers; rules select structure, not bank names."""
from __future__ import annotations

from hashlib import sha256
import json
import re
from typing import Any

from .receipt_field_candidates import FIELDS, candidate_field, empty_party, make_issue, merge_field_candidates

READER_VERSIONS = {"legacy_labels": "1", "direct_counterparty": "1"}
FIELD_LAYOUT_KINDS = frozenset({*FIELDS, *(f"{role}.{field}" for role in
                                  ("payer", "payee", "own", "counterparty") for field in FIELDS)})
DIRECT_LABELS = {
    "交易对方名称": ("counterparty", "name"), "交易对手名称": ("counterparty", "name"),
    "对方名称": ("counterparty", "name"), "对方户名": ("counterparty", "name"),
    "对手名称": ("counterparty", "name"), "交易对方户名": ("counterparty", "name"),
    "交易对方账号": ("counterparty", "account"), "交易对方帐号": ("counterparty", "account"),
    "对方账号": ("counterparty", "account"), "对方帐号": ("counterparty", "account"),
    "对方开户行": ("counterparty", "bank"), "对方开户银行": ("counterparty", "bank"),
    "交易对方银行名称": ("counterparty", "bank"), "交易对方开户行": ("counterparty", "bank"),
    "对方银行名称": ("counterparty", "bank"),
    "本方名称": ("own", "name"), "本方户名": ("own", "name"),
    "本方账号": ("own", "account"), "本方帐号": ("own", "account"),
    "本方开户行": ("own", "bank"), "本方开户银行": ("own", "bank"),
}
BOUNDARY_LABELS = {
    "交易对方银行行号", "对方银行行号", "发起人开户行行号", "接收人开户行行号",
    "交易机构", "币种", "发生额", "交易流水号", "来源或用途", "摘要", "备注",
    "借贷标志", "交易种类", "业务类型", "交易日期", "金额", "用途", "回单编号",
}


def _known_labels() -> dict[str, str]:
    from .receipt_parties import _label_aliases, _FIELD_ALIASES
    labels = {alias: f"{role}.{field}" for alias, (role, field) in DIRECT_LABELS.items()}
    for alias, role, field, _ in _label_aliases(tax_context=True):
        labels[alias] = f"{role}.{field}"
    for field, aliases in _FIELD_ALIASES.items():
        for alias in aliases:
            labels.setdefault(alias, field)
    labels.update({alias: "meta.boundary" for alias in BOUNDARY_LABELS})
    return labels


def _line_matches(line: Any, labels: dict[str, str]) -> list[tuple[str, int, int]]:
    from .receipt_parties import _label_text_with_map
    normalized, indexes = _label_text_with_map(line.text)
    pattern = re.compile("|".join(re.escape(alias) for alias in sorted(labels, key=len, reverse=True)))
    matches = []
    for match in pattern.finditer(normalized):
        tail = normalized[match.end():]
        if tail.startswith(":") or (match.start() == 0 and not tail):
            matches.append((match.group(), indexes[match.start()], indexes[match.end() - 1] + 1))
    return matches


def read_direct_counterparty(page: Any, rect: Any) -> dict[str, Any] | None:
    """Read explicit own/counterparty labels without inventing payer/payee."""
    from .receipt_parties import _coerce_rect, _extract_lines, _rect_dict, _strip_value_separators
    scope = _coerce_rect(rect)
    lines = _extract_lines(page, scope, [])
    labels = _known_labels()
    matched = [_line_matches(line, labels) for line in lines]
    if not any(alias in DIRECT_LABELS and DIRECT_LABELS[alias][0] == "counterparty"
               for matches in matched for alias, _, _ in matches):
        return None
    candidates = {(role, field): [] for role in ("own", "counterparty") for field in FIELDS}
    issues = []
    for index, (line, matches) in enumerate(zip(lines, matched)):
        for position, (alias, start, end) in enumerate(matches):
            if alias not in DIRECT_LABELS:
                continue
            role, field = DIRECT_LABELS[alias]
            stop = matches[position + 1][1] if position + 1 < len(matches) else len(line.text)
            value = _strip_value_separators(line.text[end:stop])
            value_rect = line.rect_for_span(end, stop)
            # A label-only row may wrap to a single aligned text row. Never
            # borrow another labelled cell or cross the neighbouring column.
            if not value and position + 1 == len(matches) and index + 1 < len(lines):
                other = lines[index + 1]
                height = max(1., line.rect[3] - line.rect[1])
                if (not matched[index + 1] and other.rect[1] >= line.rect[3]
                        and other.rect[1] - line.rect[3] <= height * 1.2
                        and abs(other.rect[0] - line.rect[0]) <= height * 2):
                    value, value_rect = other.text.strip(), other.rect
            evidence = {"label": {"text": alias, "rect": _rect_dict(line.rect_for_span(start, end))},
                        "value": {"text": value, "rect": _rect_dict(value_rect)} if value else None,
                        "rect": _rect_dict(line.rect_for_span(start, stop) or line.rect)}
            candidate = candidate_field(field, value, evidence)
            candidates[(role, field)].append(candidate)
            if candidate["state"] == "missing":
                issues.append(make_issue("missing_field", field, role))
    result: dict[str, Any] = {"issues": issues}
    for role in ("own", "counterparty"):
        party = empty_party()
        observed = False
        for field in FIELDS:
            values = candidates[(role, field)]
            observed |= bool(values)
            party[field] = merge_field_candidates(field, values)
            if party[field]["state"] == "ambiguous":
                code = ("invalid_text" if "\ufffd" in party[field]["value"]
                        or field == "name" and not any(char.isalnum() for char in party[field]["value"]) else
                        "incomplete_account" if field == "account" and len(values) == 1 else "conflicting_field")
                issues.append(make_issue(code, field, role))
        result[role + "_observed"] = party if observed else None
        if role == "counterparty" and observed and party["name"]["state"] == "missing":
            issues.append(make_issue("missing_field", "name", role))
    return result


def field_layout_signature(page: Any, rect: Any) -> dict[str, Any]:
    """Only fixed label classes and label coordinates enter this signature.

    Real character boxes avoid including variable company/account widths in
    a whole-span label rectangle. Without those boxes a portable signature
    cannot be established; callers may still offer a batch-only region rule.
    """
    from .receipt_parties import _call_get_text, _coerce_rect, _inside, _label_text_with_map
    scope = _coerce_rect(rect)
    anchors = []
    try:
        data = _call_get_text(page, "rawdict", scope)
    except (AttributeError, TypeError, ValueError, RuntimeError, KeyError):
        data = {}
    labels = _known_labels()
    for block in data.get("blocks", []) if isinstance(data, dict) else []:
        for line in block.get("lines", []):
            chars = [char for span in line.get("spans", []) for char in span.get("chars", [])]
            text = "".join(char.get("c", "") for char in chars)
            if not chars or any(len(char.get("c", "")) != 1 for char in chars):
                continue
            normalized, indexes = _label_text_with_map(text)
            pattern = re.compile("|".join(re.escape(alias) for alias in sorted(labels, key=len, reverse=True)))
            for match in pattern.finditer(normalized):
                tail = normalized[match.end():]
                if not (tail.startswith(":") or match.start() == 0 and not tail):
                    continue
                kind = labels[match.group()]
                if kind == "meta.boundary":
                    continue
                boxes = [char["bbox"] for char in chars[indexes[match.start()]:indexes[match.end() - 1] + 1]]
                box = (min(x[0] for x in boxes), min(x[1] for x in boxes), max(x[2] for x in boxes), max(x[3] for x in boxes))
                if not _inside(box, scope):
                    continue
                relative = {"x0": round((box[0] - scope.x0) / (scope.x1 - scope.x0), 4),
                            "y0": round((box[1] - scope.y0) / (scope.y1 - scope.y0), 4),
                            "x1": round((box[2] - scope.x0) / (scope.x1 - scope.x0), 4),
                            "y1": round((box[3] - scope.y0) / (scope.y1 - scope.y0), 4)}
                if min(relative.values()) < 0 or max(relative.values()) > 1:
                    continue
                anchors.append({"kind": kind, "rect": relative})
    anchors.sort(key=lambda entry: (entry["rect"]["y0"], entry["rect"]["x0"], entry["kind"]))
    reliable = 2 <= len(anchors) <= 64 and len({entry["kind"] for entry in anchors}) >= 2
    anchors = anchors[:64]
    payload = {"version": "field-layout-v1", "labels": anchors,
               "aspect": round((scope.x1 - scope.x0) / (scope.y1 - scope.y0), 3)}
    fingerprint = sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"version": payload["version"], "fingerprint": fingerprint, "reliable": reliable, "labels": anchors}


READERS = (("direct_counterparty", read_direct_counterparty),)


def enrich_legacy_extraction(page: Any, rect: Any, legacy: dict[str, Any]) -> dict[str, Any]:
    """Add observations beside the legacy projection; never overwrite it."""
    from .receipt_field_candidates import normalize_issues
    result = dict(legacy)
    result.update(own_observed=None, counterparty_observed=None)
    dependencies = [{"reader_id": "legacy_labels", "version": READER_VERSIONS["legacy_labels"]}]
    issues = []
    code_map = {"no_text_in_scope": "no_text", "label_without_value": "missing_field",
                "conflicting_field_values": "conflicting_field", "field_ambiguous": "incomplete_account",
                "generic_label_side_unknown": "role_unresolved"}
    for issue in legacy.get("diagnostics", {}).get("issues", []):
        if issue.get("code") in code_map:
            field = issue.get("field") if issue.get("field") in FIELDS else None
            role = issue.get("side", "unknown")
            code = code_map[issue["code"]]
            if issue["code"] == "field_ambiguous" and field != "account":
                code = "invalid_text"
            issues.append(make_issue(code, field, role))
    for reader_id, reader in READERS:
        observed = reader(page, rect)
        if observed is not None:
            dependencies.append({"reader_id": reader_id, "version": READER_VERSIONS[reader_id]})
            result.update({key: observed.get(key) for key in ("own_observed", "counterparty_observed")})
            issues.extend(observed.get("issues", []))
    has_legacy_value = any(result[side][field]["state"] != "missing"
                           for side in ("payer", "payee") for field in FIELDS)
    if not has_legacy_value and result["counterparty_observed"] is None and not any(i["code"] == "no_text" for i in issues):
        issues.append(make_issue("unsupported_layout"))
    if result["counterparty_observed"] is not None:
        issues = [i for i in issues if i["code"] != "role_unresolved"]
    signature = field_layout_signature(page, rect)
    result.update(issues=normalize_issues(issues), reader_dependencies=dependencies,
                  layout_signature=signature["fingerprint"] if signature["reliable"] else None)
    return result
