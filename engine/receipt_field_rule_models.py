"""Small, declarative rules for reading fields inside reviewed receipt crops.

Rules contain geometry and fixed label categories only. Extracted values, source
paths and image data belong to the private job evidence, never to a reusable
rule. They cannot change receipt boundaries or review decisions.
"""

from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import json
import math
import re
from typing import Any, Mapping


SCHEMA_VERSION = 1
ROLES = frozenset({"counterparty", "own", "payer", "payee"})
FIELD_NAMES = frozenset({"name", "account", "bank"})
MAX_FIELDS = 6
MAX_SIGNATURE_LABELS = 128
_HASH = re.compile(r"^[a-f0-9]{64}$")
_CATEGORY = re.compile(r"^[a-z][a-z0-9_.:-]{0,63}$")


class FieldRuleError(ValueError):
    code = "field_rule_invalid"


class FieldRuleConflict(FieldRuleError):
    code = "field_rule_conflict"


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False)


def rule_digest(definition: Mapping[str, Any]) -> str:
    return sha256(canonical_json(definition).encode("utf-8")).hexdigest()


def text(value: object, label: str, limit: int = 128) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit or any(ord(char) < 32 for char in value):
        raise FieldRuleError(f"{label}无效")
    return value.strip()


def normalized_rect(value: object) -> dict[str, float]:
    if not isinstance(value, Mapping) or set(value) != {"x0", "y0", "x1", "y1"}:
        raise FieldRuleError("字段范围无效")
    result = {}
    for key in ("x0", "y0", "x1", "y1"):
        item = value[key]
        if isinstance(item, bool) or not isinstance(item, (float, int)) or not math.isfinite(item) or not 0 <= item <= 1:
            raise FieldRuleError("字段范围必须在回单片段内")
        result[key] = round(float(item), 8)
    if result["x0"] >= result["x1"] or result["y0"] >= result["y1"]:
        raise FieldRuleError("字段范围不能为空")
    return result


def validate_fields(fields: object, mode: object, *, compiled: bool = False) -> list[dict[str, Any]]:
    if not isinstance(mode, str) or mode not in {"auto", "direct", "sides"}:
        raise FieldRuleError("字段读取模式无效")
    if not isinstance(fields, list) or not 1 <= len(fields) <= MAX_FIELDS:
        raise FieldRuleError("字段数量无效")
    # In auto mode these two legacy role names identify neutral positions,
    # not the payer/payee or own/counterparty meaning of their contents.
    allowed_roles = {"counterparty", "own"} if mode in {"auto", "direct"} else {"payer", "payee"}
    result = []
    seen = set()
    for item in fields:
        keys = {"role", "field", "rect", "anchor"} if compiled else {"role", "field", "rect"}
        if not isinstance(item, Mapping) or set(item) != keys:
            raise FieldRuleError("字段设置包含未支持的内容")
        role, field = item.get("role"), item.get("field")
        if not isinstance(role, str) or not isinstance(field, str) or role not in allowed_roles or field not in FIELD_NAMES or (role, field) in seen:
            raise FieldRuleError("字段名称、对应方或重复设置无效")
        seen.add((role, field))
        row = {"role": role, "field": field, "rect": normalized_rect(item["rect"])}
        if compiled:
            row["anchor"] = None if item["anchor"] is None else _label(item["anchor"])
        result.append(row)
    required = {("counterparty", "name")} if mode in {"auto", "direct"} else {("payer", "name"), ("payee", "name")}
    if not required <= seen:
        raise FieldRuleError("请标出交易对方名称，或付款方和收款方名称")
    for index, left in enumerate(result):
        a = left["rect"]
        for right in result[index + 1:]:
            b = right["rect"]
            if min(a["x1"], b["x1"]) > max(a["x0"], b["x0"]) and min(a["y1"], b["y1"]) > max(a["y0"], b["y0"]):
                raise FieldRuleError("不同字段的范围不能重叠，请分别框选")
    return result


def _label(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != {"kind", "rect"}:
        raise FieldRuleError("标签定位条件无效")
    kind = value["kind"]
    from .receipt_field_readers import FIELD_LAYOUT_KINDS
    if not isinstance(kind, str) or not _CATEGORY.fullmatch(kind) or kind not in FIELD_LAYOUT_KINDS:
        raise FieldRuleError("只允许固定标签类别")
    return {"kind": kind, "rect": normalized_rect(value["rect"])}


def validate_signature(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != {"version", "fingerprint", "reliable", "labels"}:
        raise FieldRuleError("版式依据无效")
    if value["version"] != "field-layout-v1" or type(value["reliable"]) is not bool:
        raise FieldRuleError("版式依据版本无效")
    if not isinstance(value["fingerprint"], str) or not _HASH.fullmatch(value["fingerprint"]):
        raise FieldRuleError("版式校验信息无效")
    if not isinstance(value["labels"], list) or len(value["labels"]) > MAX_SIGNATURE_LABELS:
        raise FieldRuleError("版式标签数量无效")
    return {"version": value["version"], "fingerprint": value["fingerprint"],
            "reliable": value["reliable"], "labels": [_label(label) for label in value["labels"]]}


def validate_rule(value: object) -> dict[str, Any]:
    keys = {"schema_version", "bank_name", "mode", "fields", "layout_signature", "batch_only", "aspect_ratio"}
    if not isinstance(value, Mapping) or set(value) != keys:
        raise FieldRuleError("识别规则包含未支持的内容")
    if type(value["schema_version"]) is not int or value["schema_version"] != SCHEMA_VERSION or type(value["batch_only"]) is not bool:
        raise FieldRuleError("识别规则版本无效")
    bank = text(value["bank_name"], "来源银行", 80)
    aspect = value["aspect_ratio"]
    if type(aspect) not in (int, float) or not math.isfinite(aspect) or not .05 <= aspect <= 20:
        raise FieldRuleError("回单片段长宽比无效")
    signature = validate_signature(value["layout_signature"])
    fields = validate_fields(value["fields"], value["mode"], compiled=True)
    labels = signature["labels"]
    if any(item["anchor"] is not None and item["anchor"] not in labels for item in fields):
        raise FieldRuleError("字段锚点不属于本版式")
    if not value["batch_only"] and (not signature["reliable"] or any(item["anchor"] is None for item in fields)):
        raise FieldRuleError("缺少稳定标签的规则只能用于本批")
    return deepcopy({"schema_version": SCHEMA_VERSION, "bank_name": bank, "mode": value["mode"], "aspect_ratio": float(aspect),
                     "fields": fields, "layout_signature": signature, "batch_only": value["batch_only"]})
