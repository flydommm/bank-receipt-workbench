"""Read declarative field regions from the local PDF text layer, without OCR."""

from __future__ import annotations

from copy import deepcopy
import math
import re
from typing import Any, Mapping, Sequence

from .receipt_field_rule_models import FieldRuleError, SCHEMA_VERSION, normalized_rect, text, validate_fields, validate_rule, validate_signature


_KEYS = ("x0", "y0", "x1", "y1")
_TOLERANCE = 0.012


def _crop(page: Any, rect: object) -> dict[str, float]:
    if isinstance(rect, Mapping):
        value = dict(rect)
    elif isinstance(rect, Sequence) and not isinstance(rect, (str, bytes)) and len(rect) == 4:
        value = dict(zip(_KEYS, rect))
    else:
        raise FieldRuleError("回单片段范围无效")
    if set(value) != set(_KEYS) or any(type(value[key]) not in (float, int) or not math.isfinite(value[key]) for key in _KEYS):
        raise FieldRuleError("回单片段范围无效")
    result = {key: float(value[key]) for key in _KEYS}
    bounds = page.rect
    if (result["x0"] < bounds.x0 or result["y0"] < bounds.y0 or result["x1"] > bounds.x1 or result["y1"] > bounds.y1
            or result["x0"] >= result["x1"] or result["y0"] >= result["y1"]):
        raise FieldRuleError("回单片段超出原页")
    return result


def _signature(page: Any, rect: Mapping[str, float]) -> dict[str, Any]:
    from .receipt_field_readers import field_layout_signature
    return validate_signature(field_layout_signature(page, dict(rect)))


def _bank(value: object) -> str:
    return re.sub(r"\s+", "", text(value, "来源银行", 80))


def _center(rect: Mapping[str, float]) -> tuple[float, float]:
    return ((rect["x0"] + rect["x1"]) / 2, (rect["y0"] + rect["y1"]) / 2)


def _compatible_kind(kind: str, role: str, field: str, *, auto: bool = False) -> bool:
    return kind in {field, f"{role}.{field}"} or (auto and kind in {f"{side}.{field}" for side in ("payer", "payee", "own", "counterparty")})


def _choose_anchor(labels: list[dict[str, Any]], field: Mapping[str, Any], *, auto: bool = False) -> dict[str, Any] | None:
    rect = field["rect"]
    candidates = []
    for label in labels:
        if not _compatible_kind(label["kind"], field["role"], field["field"], auto=auto):
            continue
        box = label["rect"]
        overlap_y = min(rect["y1"], box["y1"]) - max(rect["y0"], box["y0"])
        same_row = overlap_y > 0 and box["x0"] <= rect["x1"] and rect["x0"] - box["x1"] <= .25
        above = 0 <= rect["y0"] - box["y1"] <= .06 and min(rect["x1"], box["x1"]) > max(rect["x0"], box["x0"])
        if same_row or above:
            x, y = _center(rect)
            lx, ly = _center(box)
            candidates.append((abs(y - ly) * 3 + abs(x - lx), label))
    candidates.sort(key=lambda pair: pair[0])
    if not candidates or (len(candidates) > 1 and abs(candidates[0][0] - candidates[1][0]) < .005):
        return None
    return deepcopy(candidates[0][1])


def compile_rule(page: Any, final_rect: object, mode: str, fields: object, bank_name: str) -> dict[str, Any]:
    """Build a value-free rule from a trusted prototype and user-drawn regions."""
    crop = _crop(page, final_rect)
    rows = validate_fields(fields, mode)
    signature = _signature(page, crop)
    compiled = [{**row, "anchor": _choose_anchor(signature["labels"], row, auto=mode == "auto")} for row in rows]
    return validate_rule({"schema_version": SCHEMA_VERSION, "bank_name": _bank(bank_name), "mode": mode,
                          "aspect_ratio": round((crop["x1"] - crop["x0"]) / (crop["y1"] - crop["y0"]), 6),
                          "fields": compiled, "layout_signature": signature,
                          "batch_only": not signature["reliable"] or any(row["anchor"] is None for row in compiled)})


def _matched_labels(expected: list[dict[str, Any]], current: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    if len(expected) != len(current):
        return None
    available = set(range(len(current)))
    matched = []
    for label in expected:
        found = [index for index in available if current[index]["kind"] == label["kind"]
                 and max(abs(current[index]["rect"][key] - label["rect"][key]) for key in _KEYS) <= _TOLERANCE]
        if len(found) != 1:
            return None
        matched.append(current[found[0]])
        available.remove(found[0])
    return matched


def match_rule(page: Any, final_rect: object, definition: object, bank_name: str,
               *, allow_batch_only: bool = False) -> dict[str, Any]:
    """Require the same issuing bank and stable label geometry, never just a name."""
    rule = validate_rule(definition)
    crop = _crop(page, final_rect)
    if _bank(bank_name) != rule["bank_name"]:
        return {"matched": False, "reason": "source_bank_mismatch"}
    if rule["batch_only"] and not allow_batch_only:
        return {"matched": False, "reason": "batch_only"}
    aspect = (crop["x1"] - crop["x0"]) / (crop["y1"] - crop["y0"])
    if abs(aspect / rule["aspect_ratio"] - 1) > .015:
        return {"matched": False, "reason": "layout_mismatch"}
    signature = _signature(page, crop)
    expected = rule["layout_signature"]
    if not rule["batch_only"] and not signature["reliable"]:
        return {"matched": False, "reason": "labels_unavailable"}
    matched = _matched_labels(expected["labels"], signature["labels"])
    if matched is None:
        return {"matched": False, "reason": "layout_mismatch"}
    return {"matched": True, "reason": "matched", "labels": matched}


def select_rule(page: Any, final_rect: object, rules: Sequence[Mapping[str, Any]], bank_name: str) -> dict[str, Any]:
    """A unique compatible active version is required for automatic reuse."""
    matches = [rule for rule in rules if rule.get("active", True)
               and match_rule(page, final_rect, rule.get("definition", rule), bank_name)["matched"]]
    return {"rule": matches[0] if len(matches) == 1 else None,
            "reason": "matched" if len(matches) == 1 else "multiple_rules" if matches else "no_rule",
            "candidate_ids": [rule.get("rule_id") for rule in matches]}


def merge_rule_reading(base_parties: Mapping[str, Any], rule_parties: Mapping[str, Any], definition: object,
                       *, automatic: bool, resolved_fields: Sequence[Mapping[str, str]] | None = None) -> dict[str, Any]:
    """Merge configured fields, without treating automatic reuse as a human edit."""
    from .receipt_field_candidates import empty_field, make_issue, merge_field_candidates, normalize_issues, normalize_reader_dependencies
    from .receipt_grouping_models import normalize_account, normalize_text
    rule = validate_rule(definition)
    if not isinstance(base_parties, Mapping) or not isinstance(rule_parties, Mapping) or type(automatic) is not bool:
        raise FieldRuleError("字段读取结果无效")
    result = deepcopy(dict(base_parties))
    issues = [*normalize_issues(base_parties.get("issues")), *normalize_issues(rule_parties.get("issues"))]
    fields = rule["fields"]
    if rule["mode"] == "auto":
        if (not isinstance(resolved_fields, list) or not resolved_fields or len(resolved_fields) > 6
                or any(not isinstance(row, Mapping) or set(row) != {"role", "field"}
                       or row["role"] not in {"payer", "payee", "own", "counterparty"}
                       or row["field"] not in {"name", "account", "bank"} for row in resolved_fields)
                or len({(row["role"], row["field"]) for row in resolved_fields}) != len(resolved_fields)):
            raise FieldRuleError("自动读取尚未确定本方与对方位置")
        fields = resolved_fields
    for row in fields:
        role = {"own": "own_observed", "counterparty": "counterparty_observed"}.get(row["role"], row["role"])
        field = row["field"]
        if not isinstance(result.get(role), Mapping):
            result[role] = _empty_party()
        observed = rule_parties.get(role)
        incoming = deepcopy(observed.get(field, empty_field())) if isinstance(observed, Mapping) else empty_field()
        previous = result[role].get(field, empty_field())
        if automatic:
            old_state, new_state = previous.get("state", "missing"), incoming.get("state", "missing")
            if old_state in {"present", "blank"} and new_state in {"missing", "ambiguous"}:
                issues.append(make_issue("rule_incompatible", field, row["role"]))
                continue
            if old_state != "missing" and new_state != "missing":
                normalize = normalize_account if field == "account" else normalize_text
                old_value = normalize(previous.get("value", previous.get("normalized", "")))
                new_value = normalize(incoming.get("value", incoming.get("normalized", "")))
                if old_state != new_state or old_value != new_value:
                    result[role][field] = merge_field_candidates(field, [previous, incoming])
                    issues.append(make_issue("conflicting_field", field, row["role"]))
                    continue
            elif new_state == "missing":
                continue
        result[role][field] = incoming
    result["issues"] = normalize_issues(issues)
    result["reader_dependencies"] = normalize_reader_dependencies([
        *normalize_reader_dependencies(base_parties.get("reader_dependencies")),
        *normalize_reader_dependencies(rule_parties.get("reader_dependencies")),
    ])
    return result


def _absolute(rect: Mapping[str, float], crop: Mapping[str, float]) -> dict[str, float]:
    width, height = crop["x1"] - crop["x0"], crop["y1"] - crop["y0"]
    return {"x0": crop["x0"] + rect["x0"] * width, "x1": crop["x0"] + rect["x1"] * width,
            "y0": crop["y0"] + rect["y0"] * height, "y1": crop["y0"] + rect["y1"] * height}


def _overlap(a: Mapping[str, float], b: Mapping[str, float]) -> bool:
    return min(a["x1"], b["x1"]) > max(a["x0"], b["x0"]) and min(a["y1"], b["y1"]) > max(a["y0"], b["y0"])


def _contains(a: Mapping[str, float], b: Mapping[str, float], tolerance: float = .3) -> bool:
    return a["x0"] - tolerance <= b["x0"] and a["y0"] - tolerance <= b["y0"] and a["x1"] + tolerance >= b["x1"] and a["y1"] + tolerance >= b["y1"]


def _glyph_lines(page: Any) -> list[list[tuple[str, dict[str, float]]]]:
    rows = []
    for block in page.get_text("rawdict").get("blocks", []):
        for line in block.get("lines", []):
            chars = [(char.get("c", ""), dict(zip(_KEYS, char["bbox"])))
                     for span in line.get("spans", []) for char in span.get("chars", []) if "bbox" in char]
            if chars:
                rows.append(chars)
    return rows


def _empty_party() -> dict[str, Any]:
    return {key: {"raw": "", "value": "", "normalized": "", "state": "missing", "evidence": [], "diagnostics": []}
            for key in ("name", "account", "bank")}


def _read_field(lines: list, region: Mapping[str, float], row: Mapping[str, Any],
                labels: list[dict[str, Any]], crop: Mapping[str, float], *, auto: bool = False) -> dict[str, Any]:
    raw_rows = []
    conflict = False
    label_boxes = [_absolute(label["rect"], crop) for label in labels]
    for label, box in zip(labels, label_boxes):
        if _overlap(region, box) and not _compatible_kind(label["kind"], row["role"], row["field"], auto=auto):
            conflict = True
    for line in lines:
        content = []
        selected_boxes = []
        for char, box in line:
            if not _overlap(region, box):
                continue
            if any(_contains(label, box, .8) for label in label_boxes):
                continue
            if char in ":：" and any(abs(box["x0"] - label["x1"]) <= 1.
                                    and min(box["y1"], label["y1"]) > max(box["y0"], label["y0"]) for label in label_boxes):
                continue
            if char.strip() and not _contains(region, box):
                conflict = True
            if _contains(region, box):
                content.append(char)
                if char.strip() and char not in ":：":
                    selected_boxes.append(box)
        if selected_boxes:
            left = min(box["x0"] for box in selected_boxes)
            right = max(box["x1"] for box in selected_boxes)
            for char, box in line:
                if (not char.strip() or char in ":：" or not _contains(crop, box)
                        or _contains(region, box) or any(_contains(label, box, .8) for label in label_boxes)):
                    continue
                # Cropping exactly between glyphs must not turn the remaining
                # suffix/prefix of a company name into a successful read.
                margin = max(1., box["y1"] - box["y0"]) * 1.2
                if 0 <= left - box["x1"] <= margin or 0 <= box["x0"] - right <= margin:
                    conflict = True
        value = "".join(content).strip().strip(":：").strip()
        if value:
            raw_rows.append(value)
    # Multiple lines can be a wrapped value or two different values. This
    # first rule format cannot prove which; it leaves them for confirmation.
    if len(raw_rows) > 1:
        conflict = True
    raw = "\n".join(raw_rows)
    from .receipt_grouping_models import normalize_account, normalize_text
    value = normalize_account(raw) if row["field"] == "account" else normalize_text(raw)
    state = "ambiguous" if conflict else "present" if value else "missing"
    if row["field"] == "account" and value and (not re.fullmatch(r"[0-9A-Za-z-]{6,80}", value)
                                               or any(c in value for c in "*＊×xX") or not any(c.isdigit() for c in value)):
        state = "ambiguous"
    if value in {"-", "—", "--", "无", "空"}:
        # A configured empty region never proves a blank value. Fixed blank
        # markers printed by the bank do constitute explicit evidence.
        state = "ambiguous" if conflict else "blank"
        value = ""
    return {"raw": raw, "value": value, "normalized": value, "state": state,
            "evidence": [{"rect": dict(region), "label": row["anchor"]["kind"] if row["anchor"] else None, "method": "verified_region"}],
            "diagnostics": ["字段范围内存在多个值或范围不完整"] if conflict else []}


def _identity_value(party: Mapping[str, Any], field: str) -> str:
    from .receipt_grouping_models import normalize_party_field
    value = normalize_party_field(party.get(field), field)
    return value["normalized"] if value["state"] == "present" else ""


def _own_side(parties: Mapping[str, Any], own: Mapping[str, Any]) -> str | None:
    """Locate one own side using this receipt, never the prototype's values."""
    from .receipt_grouping_models import normalize_account, normalize_text
    account, name = normalize_account(own.get("account_number", "")), normalize_text(own.get("company_name", ""))
    if not account or not name:
        return None
    sides = {side: parties.get(side) or {} for side in ("payer", "payee")}
    matches = [side for side, party in sides.items() if _identity_value(party, "account") == account]
    if len(matches) == 1:
        found = matches[0]
        printed_name = _identity_value(sides[found], "name")
        return found if not printed_name or printed_name == name else None
    if matches:
        return None
    matches = [side for side, party in sides.items() if _identity_value(party, "name") == name]
    if len(matches) != 1:
        return None
    found = matches[0]
    printed_account = _identity_value(sides[found], "account")
    return found if not printed_account or printed_account == account else None


def _resolve_auto(slots: Mapping[str, Any], rule: Mapping[str, Any], base: Mapping[str, Any],
                  own: Mapping[str, Any], parties: dict[str, Any]) -> tuple[bool, list[dict[str, str]]]:
    """Resolve neutral boxes from fixed labels and current own-account evidence."""
    from .receipt_grouping_models import normalize_account, normalize_text
    mappings: dict[str, str] = {}
    candidate = deepcopy(dict(base))
    account = normalize_account(own.get("account_number", ""))
    company = normalize_text(own.get("company_name", ""))
    if account and sum(_identity_value(values, "account") == account for values in slots.values()) > 1:
        return False, []
    for slot, values in slots.items():
        kinds = {row["anchor"]["kind"].split(".")[0] for row in rule["fields"]
                 if row["role"] == slot and row["anchor"] is not None and "." in row["anchor"]["kind"]}
        if len(kinds) > 1:
            return False, []
        if kinds:
            mappings[slot] = next(iter(kinds))
            role = {"own": "own_observed", "counterparty": "counterparty_observed"}.get(mappings[slot], mappings[slot])
            candidate[role] = {**(candidate.get(role) or _empty_party()), **deepcopy(values)}
    own_side = _own_side(candidate, own)
    neutral = [slot for slot in slots if slot not in mappings]
    own_slots = []
    if account and company:
        for slot, values in slots.items():
            number, name = _identity_value(values, "account"), _identity_value(values, "name")
            if (number == account and name in {"", company}) or (not number and name == company):
                own_slots.append(slot)
    if len(own_slots) == 1 and len(slots) == 2:
        local_own = own_slots[0]
        for slot in neutral:
            is_own = slot == local_own
            mappings[slot] = (own_side if is_own else ("payee" if own_side == "payer" else "payer")) if own_side else ("own" if is_own else "counterparty")
    # A lone generic box is usable only when its value uniquely locates a
    # reliable existing side. Merely differing from our name is insufficient.
    for slot in neutral:
        if slot in mappings:
            continue
        values = slots[slot]
        number, name = _identity_value(values, "account"), _identity_value(values, "name")
        matching = [side for side in ("payer", "payee") if
                    (number and number == _identity_value(candidate.get(side) or {}, "account")) or
                    (not number and name and name == _identity_value(candidate.get(side) or {}, "name"))]
        if own_side is None or len(matching) != 1:
            return False, []
        mappings[slot] = matching[0]
    resolved_fields = []
    seen = set()
    for row in rule["fields"]:
        value = slots[row["role"]][row["field"]]
        # An old baseline must not conceal an unreadable configured name.
        if value["state"] == "ambiguous" or (row["field"] == "name" and value["state"] == "missing"):
            return False, []
        role = mappings[row["role"]]
        key = role, row["field"]
        if key in seen:
            return False, []
        seen.add(key)
        target = {"own": "own_observed", "counterparty": "counterparty_observed"}.get(role, role)
        if parties[target] is None:
            parties[target] = _empty_party()
        parties[target][row["field"]] = deepcopy(value)
        candidate[target] = {**(candidate.get(target) or _empty_party()), row["field"]: deepcopy(value)}
        resolved_fields.append({"role": role, "field": row["field"]})
    direct = parties.get("counterparty_observed") or {}
    if direct.get("name", {}).get("state") in {"present", "blank"}:
        return True, resolved_fields
    own_side = _own_side(candidate, own)
    if own_side is None:
        return False, []
    other = candidate.get("payee" if own_side == "payer" else "payer") or {}
    return other.get("name", {}).get("state") in {"present", "blank"}, resolved_fields


def read_rule(page: Any, final_rect: object, definition: object, bank_name: str,
              *, allow_batch_only: bool = False, own_account: Mapping[str, Any] | None = None,
              base_parties: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Read only the configured fields; never manufacture a payment direction."""
    rule = validate_rule(definition)
    crop = _crop(page, final_rect)
    applicability = match_rule(page, crop, rule, bank_name, allow_batch_only=allow_batch_only)
    if not applicability["matched"]:
        return {**applicability, "parties": None}
    original_labels, labels = rule["layout_signature"]["labels"], applicability["labels"]
    parties = {"payer": _empty_party(), "payee": _empty_party(), "own_observed": None, "counterparty_observed": None,
               "issues": [], "reader_dependencies": [{"reader_id": "local-field-rule", "version": "1"}]}
    if rule["mode"] == "direct":
        parties["counterparty_observed"] = _empty_party()
        if any(row["role"] == "own" for row in rule["fields"]):
            parties["own_observed"] = _empty_party()
    lines = _glyph_lines(page)
    slots: dict[str, dict[str, Any]] = {}
    for row in rule["fields"]:
        relative = dict(row["rect"])
        if row["anchor"] is not None:
            anchor = labels[original_labels.index(row["anchor"])]["rect"]
            old_x, old_y = _center(row["anchor"]["rect"])
            new_x, new_y = _center(anchor)
            relative = {key: value + (new_x - old_x if key.startswith("x") else new_y - old_y) for key, value in relative.items()}
        role = {"own": "own_observed", "counterparty": "counterparty_observed"}.get(row["role"], row["role"])
        try:
            normalized_rect(relative)
            field = _read_field(lines, _absolute(relative, crop), row, labels, crop, auto=rule["mode"] == "auto")
        except FieldRuleError:
            field = {**_empty_party()[row["field"]], "state": "ambiguous", "diagnostics": ["字段范围超出当前片段"]}
        if rule["mode"] == "auto":
            slots.setdefault(row["role"], {})[row["field"]] = field
        else:
            parties[role][row["field"]] = field
        if field["state"] in {"missing", "ambiguous"}:
            from .receipt_field_candidates import make_issue
            parties["issues"].append(make_issue("missing_field" if field["state"] == "missing" else "conflicting_field", field=row["field"], role=row["role"]))
    if rule["mode"] == "auto":
        resolved, fields = _resolve_auto(slots, rule, base_parties or {}, own_account or {}, parties)
        if not resolved:
            from .receipt_field_candidates import make_issue
            parties["issues"].append(make_issue("role_unresolved", "name", "counterparty"))
        return {"matched": True, "reason": "matched" if resolved else "role_unresolved", "resolved": resolved,
                "resolved_fields": fields, "parties": parties}
    return {"matched": True, "reason": "matched", "parties": parties}
