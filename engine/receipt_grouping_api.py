"""Strict batch-command adapter for counterparty grouping.

The desktop host injects the private grouping database path and calls
dispatch_grouping(store, op, data, database) from the existing batch service.
Webview input never supplies a path, authoritative receipt data, source
geometry, or extraction evidence.
"""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sqlite3
from typing import Any, Mapping

from .receipt_grouping_models import (
    GroupingConflict,
    GroupingError,
    GroupingIncomplete,
    GroupingNotFound,
    GroupingSourceChanged,
    GroupingValidationError,
    digest,
    normalize_account,
)
from .receipt_grouping_store import GroupingStore


_OPS = {
    "batch_counterparty_account_list",
    "batch_counterparty_account_save",
    "batch_receipt_grouping_set_account",
    "batch_receipt_grouping_prepare",
    "batch_receipt_grouping_refresh",
    "batch_receipt_grouping_page",
    "batch_receipt_grouping_save",
}
_REQUIRED = {
    "batch_counterparty_account_list": {"active_only", "offset", "limit"},
    "batch_counterparty_account_save": {"account_id", "expected_account_revision", "account", "active"},
    "batch_receipt_grouping_set_account": {"job_id", "expected_grouping_revision", "account_selection"},
    "batch_receipt_grouping_prepare": {"job_id", "result_revision", "expected_grouping_revision"},
    "batch_receipt_grouping_refresh": {
        "job_id", "result_revision", "expected_grouping_revision", "expected_review_fingerprint", "segment_ids",
    },
    "batch_receipt_grouping_page": {
        "job_id", "result_revision", "expected_grouping_revision", "expected_review_fingerprint", "offset", "limit",
    },
    "batch_receipt_grouping_save": {
        "job_id", "result_revision", "expected_grouping_revision", "expected_review_fingerprint", "edits", "group_edits",
    },
}


def _required_fields(op: str, data: Mapping[str, Any]) -> None:
    if op not in _OPS or not isinstance(data, Mapping) or set(data) != _REQUIRED[op]:
        raise GroupingValidationError("整理请求字段无效")


def _string(value: object, field: str, *, allow_empty: bool = False, limit: int = 4096) -> str:
    if not isinstance(value, str) or "\x00" in value or (not allow_empty and not value.strip()):
        raise GroupingValidationError(f"{field}格式无效")
    value = value.strip()
    if len(value) > limit:
        raise GroupingValidationError(f"{field}过长")
    return value


def _integer(value: object, field: str, *, minimum: int = 0, maximum: int | None = None) -> int:
    if type(value) is not int or value < minimum or value >= 2**53 or (maximum is not None and value > maximum):
        raise GroupingValidationError(f"{field}无效")
    return value


def _account_input(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != {"company_name", "bank_name", "branch_name", "account_number"}:
        raise GroupingValidationError("账户资料字段无效")
    company = _string(value["company_name"], "公司名称", limit=256)
    bank = _string(value["bank_name"], "来源银行", limit=256)
    branch = _string(value["branch_name"], "开户支行", allow_empty=True, limit=256)
    account = _string(value["account_number"], "本方账号", limit=128)
    import re
    account = normalize_account(account)
    if not re.fullmatch(r"[0-9]{1,128}", account):
        raise GroupingValidationError("本方账号必须是完整账号")
    return {"company_name": company, "bank_name": bank, "branch_name": branch, "account_number": account}


def _selection(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping) or "kind" not in value:
        raise GroupingValidationError("本方账户选择格式无效")
    kind = value["kind"]
    if kind == "saved":
        if set(value) != {"kind", "account_id", "account_revision"}:
            raise GroupingValidationError("本方账户选择字段无效")
        return {"kind": "saved", "account_id": _string(value["account_id"], "账户编号", limit=256),
                "account_revision": _integer(value["account_revision"], "账户版本", minimum=1)}
    if kind == "inline":
        if set(value) != {"kind", "account"}:
            raise GroupingValidationError("本方账户选择字段无效")
        return {"kind": "inline", "account": _account_input(value["account"])}
    raise GroupingValidationError("本方账户选择类型无效")


def _public_field(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {"raw": "", "value": "", "state": "missing", "evidence": [], "diagnostics": []}
    evidence = value.get("evidence")
    evidence_list = []
    for entry in evidence if isinstance(evidence, list) else [evidence] if isinstance(evidence, Mapping) else []:
        if not isinstance(entry, Mapping):
            raise GroupingValidationError("字段依据格式无效")
        raw_label = entry.get("label")
        label = raw_label.get("text") if isinstance(raw_label, Mapping) else raw_label
        rect = entry.get("rect")
        if rect is not None:
            from math import isfinite
            if (not isinstance(rect, Mapping) or set(rect) != {"x0", "y0", "x1", "y1"}
                    or any(type(rect[key]) not in (int, float) or not isfinite(rect[key]) for key in rect)
                    or rect["x0"] >= rect["x1"] or rect["y0"] >= rect["y1"]):
                raise GroupingValidationError("字段依据范围无效")
            rect = dict(rect)
        evidence_list.append({"rect": rect, "label": label if isinstance(label, str) else None,
                              "method": "verified_region" if entry.get("method") == "verified_region" else "label" if isinstance(label, str) else "none"})
    diagnostics = value.get("diagnostics", [])
    if not isinstance(diagnostics, list):
        diagnostics = [str(diagnostics)]
    state = value.get("state", "missing")
    if state not in {"present", "blank", "missing", "ambiguous"}:
        state = "ambiguous"
    raw = value.get("raw", "")
    editable = value.get("value", value.get("normalized", ""))
    result = {
        "raw": raw if isinstance(raw, str) else "",
        "value": editable if isinstance(editable, str) else "",
        "state": state,
        "evidence": evidence_list,
        "diagnostics": [str(item) for item in diagnostics],
    }
    if isinstance(value.get("candidates"), list):
        candidates = []
        for candidate in value["candidates"][:16]:
            if not isinstance(candidate, Mapping):
                continue
            projected = _public_field({key: candidate[key] for key in ("raw", "value", "normalized", "state", "evidence") if key in candidate})
            # FieldCandidate has four public keys; field-level diagnostics stay on the parent.
            candidates.append({key: projected[key] for key in ("raw", "value", "state", "evidence")})
        result["candidates"] = candidates
    return result


def _public_party(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        value = {}
    return {field: _public_field(value.get(field)) for field in ("name", "account", "bank")}


def _public_parties(value: object) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    diagnostics = value.get("diagnostics", [])
    if isinstance(diagnostics, Mapping):
        diagnostics = [item.get("message", item.get("code", "字段待核对")) for item in diagnostics.get("issues", []) if isinstance(item, Mapping)]
    result = {
        "payer": _public_party(value.get("payer")),
        "payee": _public_party(value.get("payee")),
        "diagnostics": [str(item) for item in diagnostics] if isinstance(diagnostics, list) else [],
        "extractor_version": str(value.get("extractor_version", "receipt-parties-v1")),
    }
    from .receipt_field_candidates import normalize_issues, normalize_reader_dependencies
    for key in ("own_observed", "counterparty_observed"):
        if key in value:
            result[key] = _public_party(value[key]) if value[key] is not None else None
    if "issues" in value:
        result["issues"] = normalize_issues(value["issues"])
    if "reader_dependencies" in value:
        result["reader_dependencies"] = normalize_reader_dependencies(value["reader_dependencies"])
    if "layout_signature" in value:
        signature = value["layout_signature"]
        import re
        result["layout_signature"] = signature if isinstance(signature, str) and re.fullmatch(r"[a-f0-9]{64}", signature) else None
    if "service_type" in value:
        service_type = value["service_type"]
        if service_type not in (None, "bank_fee", "deposit_interest"):
            raise GroupingValidationError("凭证业务类型无效")
        result["service_type"] = service_type
    return result


def _public_binding(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise GroupingValidationError("片段依据格式无效")
    return {
        "segment_id": _string(value.get("segment_id"), "片段标识"),
        "fragment_key": _string(value.get("fragment_key"), "片段键", limit=128),
        "source_key": _string(value.get("source_key"), "来源标识"),
        "source_sha256": _string(value.get("source_sha256"), "来源校验值", limit=128),
        "source_page": _integer(value.get("source_page"), "来源页码", minimum=1),
        "position_index": _integer(value.get("position_index"), "栏位序号", minimum=1),
        "slot_id": _string(value.get("slot_id"), "版式栏位", allow_empty=True, limit=256),
        "instance_id": _string(value.get("instance_id", ""), "版式实例", allow_empty=True, limit=2048),
        "analysis_signature": _string(value.get("analysis_signature", ""), "分析依据", allow_empty=True, limit=128),
        "review_record_revision": _integer(value.get("review_record_revision", 0), "审核版本", minimum=0),
    }


def _public_group(value: object) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise GroupingValidationError("分组定义格式无效")
    kind = value.get("kind")
    if kind == "blank_name":
        kind = "blank"
    if kind not in {"named", "internal", "blank", "special", "counterparty_pending"}:
        kind = "counterparty_pending"
    return {
        "group_id": _string(value.get("group_id"), "分组编号", limit=256),
        "kind": kind,
        "display_name": _string(value.get("display_name", "待确认"), "分组名称", limit=256),
        "key": value.get("key") if value.get("key") is None or isinstance(value.get("key"), str) else None,
        "manual": bool(value.get("manual", False)),
    }


def _public_item(value: Mapping[str, Any]) -> dict[str, Any]:
    extracted = _public_parties(value.get("extracted"))
    counterparty = _public_party(value.get("counterparty")) if value.get("counterparty") is not None else None
    own = value.get("own_decision") if isinstance(value.get("own_decision"), Mapping) else {}
    own_public = {
        "status": own.get("status", "pending"),
        "method": own.get("method", "none"),
        "side": own.get("side"),
        "source_bank_status": own.get("source_bank_status", "unknown"),
        "reasons": [str(item) for item in own.get("reasons", [])] if isinstance(own.get("reasons", []), list) else [],
    }
    route = value.get("route", "counterparty_pending")
    if route == "blank_name":
        route = "blank"
    if route not in {"excluded", "named", "internal", "blank", "special", "counterparty_pending", "own_pending"}:
        route = "counterparty_pending"
    return {
        "binding": _public_binding(value.get("binding")),
        "extraction_fingerprint": _string(value.get("extraction_fingerprint"), "提取依据", limit=128),
        "basis_fingerprint": _string(value.get("basis_fingerprint"), "分组依据", limit=128),
        "extraction_state": value.get("extraction_state", "pending"),
        "extracted": extracted,
        "field_overrides": deepcopy(value.get("field_overrides", [])) if isinstance(value.get("field_overrides", []), list) else [],
        "own_decision": own_public,
        "counterparty": counterparty,
        "route": route,
        "group": _public_group(value.get("group")),
        "decision_method": value.get("decision_method", "none"),
        "warnings": [str(item) for item in value.get("warnings", [])] if isinstance(value.get("warnings", []), list) else [],
        "boundary_status": _string(value.get("boundary_status", ""), "边界状态", allow_empty=True, limit=256),
        "document_type": value.get("document_type") if value.get("document_type") is None or isinstance(value.get("document_type"), str) else None,
    }


def _public_header(value: Mapping[str, Any]) -> dict[str, Any]:
    raw = value.get("own_account")
    own = None
    if isinstance(raw, Mapping):
        account_revision = raw.get("account_revision")
        own = {
            "company_name": raw.get("company_name", ""),
            "bank_name": raw.get("bank_name", ""),
            "branch_name": raw.get("branch_name", ""),
            "account_number": raw.get("account_number", ""),
            "own_account_revision": raw.get("own_account_revision", 1),
            "account_id": raw.get("account_id"),
            "account_revision": account_revision if raw.get("account_id") is not None else None,
            "fingerprint": raw.get("fingerprint", digest({key: raw.get(key) for key in ("company_name", "bank_name", "branch_name", "account_number", "account_id", "account_revision")})),
            "selected_at": raw.get("selected_at", ""),
        }
    raw_counts = value.get("counts") if isinstance(value.get("counts"), Mapping) else {}
    counts = {key: int(raw_counts.get(key, 0)) for key in ("total", "excluded", "extraction_pending", "own_pending", "counterparty_pending", "assigned", "stale")}
    return {
        "schema_version": 1,
        "job_id": _string(value.get("job_id"), "任务编号"),
        "result_revision": value.get("result_revision") if value.get("result_revision") is None or isinstance(value.get("result_revision"), str) else None,
        "grouping_revision": _integer(value.get("grouping_revision"), "分组版本", minimum=0),
        "own_account": own,
        "review_fingerprint": value.get("review_fingerprint") if value.get("review_fingerprint") is None or isinstance(value.get("review_fingerprint"), str) else None,
        "counts": counts,
    }


def _public_result(value: Mapping[str, Any]) -> dict[str, Any]:
    return {"header": _public_header(value["header"]), "items": [_public_item(item) for item in value.get("items", [])]}


def _trusted_inputs(store: Any, job_id: str, result_revision: str, database: str | Path):
    from .batch_review import _validated_review_binding
    from .receipt_classification import effective_document_type
    from .computation import current_computation_version
    snapshot = store.review_snapshot(job_id, result_revision)
    job = snapshot["job"]
    if (job.get("page_result_schema") != 2 or job["processing_options"]["processing_mode"] != "split_all"
            or job["computation_version"] != current_computation_version()):
        raise GroupingConflict("当前分析不能用于交易对手整理")
    _, reviews = _validated_review_binding(store, snapshot, Path(database))
    records = {record["original"]["id"]: record for record in reviews["segments"]}
    revisions = {record["id"]: record["record_revision"] for record in reviews["record_revisions"]}
    sources = {source["source_key"]: source for source in job["sources"]}
    source_keys = {source["source_id"]: source["source_key"] for source in job["sources"]}
    notices = {}
    for page in store.read_page_results(job_id):
        for notice in page["payload"].get("diagnostics", []):
            if notice.get("code") == "special_document":
                notices[(source_keys[page["source_id"]], page["page"])] = notice["document_type"]
    raw_items = []
    for original in snapshot["originals"]:
        record = records.get(original["id"])
        source = sources[original["source_key"]]
        geometry = original["page_geometry"]
        rect = record["final_rect"] if record else original["candidate_rect"]
        crop_mode = record["crop_mode"] if record else "candidate"
        if crop_mode == "full_page":
            rect = {"x0": 0, "y0": 0, "x1": geometry["width_pt"], "y1": geometry["height_pt"]}
        review_status = record["review_status"] if record else "pending" if original["needs_review"] else "confirmed"
        kind = effective_document_type(record, notices.get((original["source_key"], original["source_page"])))
        raw_items.append({**original, "source_path": source["access_path"], "source_sha256": source["sha256"],
                          "final_rect": rect, "crop_mode": crop_mode, "review_status": review_status,
                          "record_revision": revisions[original["id"]], "document_type": None if kind == "ordinary" else kind,
                          "special_confirmed": kind != "ordinary" and review_status in {"confirmed", "page_confirmed"}})
    # Relocation changes the access path, not the PDF or the local field basis.
    review_fp = digest([{key: value for key, value in item.items() if key != "source_path"} for item in raw_items])
    return snapshot, raw_items, review_fp


def _source_heading(page, rect) -> dict[str, str]:
    import pymupdf
    from .receipt_issuer import issuer_masthead_bank
    from .crop_templates import _Title, _canonical_title_text, _issuer_bank_name
    lines = []
    for block in page.get_text("dict", sort=True, flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES).get("blocks", []):
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            if not spans:
                continue
            text = "".join(span.get("text", "") for span in spans)
            box = tuple(line["bbox"])
            if box[0] >= rect["x0"] and box[1] >= rect["y0"] and box[2] <= rect["x1"] and box[3] <= rect["y1"]:
                lines.append((text, box))
    # Only independent headings near the top of this receipt qualify. Account
    # banks and adjacent receipt mastheads cannot establish source ownership.
    ceiling = rect["y0"] + min(100, (rect["y1"] - rect["y0"]) * .3)
    banks = {bank for text, box in lines if box[1] <= ceiling
             if (bank := issuer_masthead_bank(text, box, lines)) is not None}
    for text, box in lines:
        title = _canonical_title_text(text) if box[1] <= ceiling else None
        if title is not None:
            bank = _issuer_bank_name(_Title(title, "grouping-heading", *box), lines, rect["y0"])
            if bank is not None:
                banks.add(bank)
    return {"bank_name": next(iter(banks)) if len(banks) == 1 else "", "state": "present" if len(banks) == 1 else "unknown"}


def _extract_selected(snapshot, raw_items, ids, saved_rules=(), own_account=None):
    from .batch_pdf import open_batch_source
    from .pdf_parser import visible_page
    from .receipt_parties import extract_receipt_parties
    from .receipt_document_types import detect_grouping_service_type
    selected = {item["id"]: item for item in raw_items if item["id"] in ids}
    if len(selected) != len(ids):
        raise GroupingValidationError("选中片段不在当前结果中")
    result = {}
    for source in snapshot["job"]["sources"]:
        values = [item for item in selected.values() if item["source_key"] == source["source_key"]]
        if not values:
            continue
        with open_batch_source(source["access_path"], source["sha256"]) as opened:
            if opened.size_bytes != source["size_bytes"] or opened.page_count != source["page_count"]:
                raise GroupingSourceChanged("来源文件已变化")
            loaded = {}
            for item in values:
                number = item["source_page"]
                if number not in loaded:
                    loaded[number] = visible_page(opened._document.load_page(number - 1))
                rect = item["final_rect"]
                if rect is None:
                    result[item["id"]] = {"parties": None, "extraction_state": "failed"}
                else:
                    extracted = extract_receipt_parties(loaded[number], rect)
                    heading = _source_heading(loaded[number], rect)
                    rule_basis = None
                    if saved_rules and heading['bank_name']:
                        from .receipt_field_rule_reader import select_rule, read_rule, merge_rule_reading
                        chosen = select_rule(loaded[number], rect, saved_rules, heading['bank_name'])
                        if chosen['rule'] is not None:
                            rule = chosen['rule']
                            reading = read_rule(loaded[number], rect, rule['definition'], heading['bank_name'],
                                                own_account=own_account, base_parties=extracted)
                            if reading['matched']:
                                if reading.get('resolved', True):
                                    extracted = merge_rule_reading(extracted, reading['parties'], rule['definition'], automatic=True,
                                                                  resolved_fields=reading.get('resolved_fields'))
                                else:
                                    from .receipt_field_candidates import make_issue
                                    extracted.setdefault('issues', []).append(make_issue('role_unresolved', 'name', 'counterparty'))
                                rule_basis = {'rule_id': rule['rule_id'], 'version': rule['version'],
                                              'definition_digest': rule['definition_digest']}
                        elif chosen['reason'] == 'multiple_rules':
                            from .receipt_field_candidates import make_issue
                            extracted.setdefault('issues', []).append(make_issue('rule_incompatible', role='counterparty'))
                    # Business-only classification uses this final fragment, not
                    # the entire page (which can also contain ordinary transfers).
                    extracted["service_type"] = detect_grouping_service_type(loaded[number], rect)
                    # Project into the shared contract before storing evidence.
                    result[item["id"]] = {"parties": _public_parties(extracted), "source_bank": heading,
                                           "extractor_version": "receipt-parties-v1", "extraction_state": "ready"}
                    if rule_basis is not None:
                        result[item['id']]['field_rule_basis'] = rule_basis
    return result


def dispatch_grouping(store: Any, op: str, data: Mapping[str, Any], database: str | Path | sqlite3.Connection) -> Any:
    """Dispatch one contract operation from the existing batch service."""
    data = {key: value for key, value in data.items() if key not in {"op", "database_path", "grouping_database_path"}}
    _required_fields(op, data)
    initialize = op.startswith("batch_counterparty_account_") or op == "batch_receipt_grouping_set_account"
    if not initialize and not Path(database).is_file():
        raise GroupingNotFound("本任务未启用交易对手整理")
    with GroupingStore(database, initialize=initialize) as grouping:
        return _dispatch_locked(store, grouping, op, data, Path(database))


def _active_field_rules_digest(rules):
    return digest(sorted((rule['rule_id'], rule['version'], rule['definition_digest']) for rule in rules))


def _dispatch_locked(store, grouping, op, data, database):
    if op == "batch_counterparty_account_list":
        if not isinstance(data["active_only"], bool):
            raise GroupingValidationError("账户筛选条件无效")
        return grouping.account_list(active_only=data["active_only"], offset=_integer(data["offset"], "偏移"), limit=_integer(data["limit"], "数量", minimum=1, maximum=50))
    if op == "batch_counterparty_account_save":
        if data["account_id"] is not None and not isinstance(data["account_id"], str):
            raise GroupingValidationError("账户编号格式无效")
        if not isinstance(data["active"], bool):
            raise GroupingValidationError("账户启用状态无效")
        return grouping.account_save(_account_input(data["account"]), account_id=data["account_id"], expected_account_revision=_integer(data["expected_account_revision"], "账户版本", minimum=0), active=data["active"])
    job_id = _string(data["job_id"], "任务编号", limit=1024)
    if op == "batch_receipt_grouping_set_account":
        job = store.get_job(job_id)
        if job.get("processing_options", {}).get("processing_mode") != "split_all":
            raise GroupingValidationError("关键词查找任务不能启用交易对手整理")
        with store.hold_review_binding(job):
            return _public_header(grouping.set_account(job_id, expected_grouping_revision=_integer(data["expected_grouping_revision"], "分组版本", minimum=0), account_selection=_selection(data["account_selection"]), task_state=job["state"]))
    result_revision = _string(data["result_revision"], "分析版本", limit=1024)
    expected = _integer(data["expected_grouping_revision"], "分组版本", minimum=-1 if op.endswith("prepare") else 0)
    from .receipt_grouping_basis import content_stamp, trusted_basis
    selected_ids = None if op == "batch_receipt_grouping_prepare" else set()
    if op == "batch_receipt_grouping_refresh":
        ids = data["segment_ids"]
        if (not isinstance(ids, list) or not 1 <= len(ids) <= 50 or not all(isinstance(item, str) for item in ids)
                or len(set(ids)) != len(ids)):
            raise GroupingValidationError("每次只能提取1至50个不同片段")
        selected_ids = set(ids)
    snapshot, raw_items, review_fp, basis_stamp = trusted_basis(
        store, grouping, job_id, result_revision, database, _trusted_inputs, selected_ids=selected_ids,
    )
    extracted = None
    if op != "batch_receipt_grouping_prepare" and data["expected_review_fingerprint"] != review_fp:
        raise GroupingConflict("审核结果已变化，请重新载入归组")
    if op == "batch_receipt_grouping_refresh":
        ids = data["segment_ids"]
        pending_ids = grouping.pending_segment_ids(job_id, ids, expected_grouping_revision=expected, expected_review_fingerprint=review_fp)
        from .receipt_field_rule_store import FieldRuleStore
        saved_rules = FieldRuleStore(grouping.connection).list(active_only=True)
        rules_digest = _active_field_rules_digest(saved_rules)
        extracted = _extract_selected(snapshot, raw_items, set(ids) & pending_ids, saved_rules,
                                      own_account=grouping.header(job_id).get('own_account'))
    with store.hold_review_binding(snapshot["job"]):
        with grouping.transaction():
            # Both stores are locked in their established order. Compare all
            # audited input bytes again, including review geometry and history,
            # without decoding/revalidating thousands of unchanged records.
            if content_stamp(store, grouping, job_id, result_revision) != basis_stamp:
                raise GroupingConflict("审核结果已变化，请重新载入归组")
            if op == "batch_receipt_grouping_prepare":
                prepared = grouping.prepare(job_id, result_revision=result_revision, expected_grouping_revision=expected,
                    authoritative=raw_items, source_manifest=snapshot["job"]["sources"], review_fingerprint=review_fp)
                result = _public_header(prepared["header"])
            elif op == "batch_receipt_grouping_page":
                page = grouping.page(job_id, result_revision=result_revision, expected_grouping_revision=expected, expected_review_fingerprint=review_fp,
                    offset=_integer(data["offset"], "偏移"), limit=_integer(data["limit"], "数量", minimum=1, maximum=200))
                result = {"header": _public_header(page["header"]), "offset": page["offset"], "total": page["total"],
                          "items": [_public_item(item) for item in page["items"]], "next_offset": page["next_offset"]}
            elif op == "batch_receipt_grouping_refresh":
                current_rules = FieldRuleStore(grouping.connection).list(active_only=True)
                if _active_field_rules_digest(current_rules) != rules_digest:
                    raise GroupingConflict("本机读取规则已变化，请重新读取当前回单")
                refreshed = grouping.refresh(job_id, result_revision=result_revision, expected_grouping_revision=expected,
                    expected_review_fingerprint=review_fp, segment_ids=data["segment_ids"], verify_sources=False,
                    source_reader=lambda _path, _page, item: extracted.get(item["binding"]["segment_id"]))
                result = _public_result(refreshed)
            else:
                if not isinstance(data["edits"], list) or not isinstance(data["group_edits"], list):
                    raise GroupingValidationError("分组修改格式无效")
                saved = grouping.save(job_id, result_revision=result_revision, expected_grouping_revision=expected,
                    expected_review_fingerprint=review_fp, edits=data["edits"], group_edits=data["group_edits"])
                # The view reloads all pages against the returned revision.
                # Only echo requested edits here: a group rename can affect
                # thousands of items, beyond the 200-item response contract.
                changed_ids = {edit["segment_id"] for edit in data["edits"]}
                result = _public_result({"header": saved["header"], "items": [
                    item for item in saved["items"] if item["binding"]["segment_id"] in changed_ids
                ]})
            from .batch_models import canonical_json, MAX_JSON_BYTES
            if op == "batch_receipt_grouping_page":
                from .batch_models import BatchModelError
                while len(result["items"]) > 1:
                    try:
                        canonical_json(result, max_bytes=MAX_JSON_BYTES)
                        break
                    except BatchModelError:
                        result["items"] = result["items"][:max(1, len(result["items"]) // 2)]
                        result["next_offset"] = result["offset"] + len(result["items"])
            canonical_json(result, max_bytes=MAX_JSON_BYTES)
            return result


def handle_grouping_request(store: Any, request: Mapping[str, Any], database: str | Path | sqlite3.Connection) -> dict[str, Any]:
    try:
        if not isinstance(request, Mapping) or not isinstance(request.get("op"), str):
            raise GroupingValidationError("整理请求无效")
        data = {key: value for key, value in request.items() if key != "op"}
        result = dispatch_grouping(store, request["op"], data, database)
        return {"status": "ok", "data": result}
    except GroupingConflict as exc:
        return {"status": "error", "code": "grouping_conflict", "message": str(exc)}
    except GroupingSourceChanged as exc:
        return {"status": "error", "code": "source_changed", "message": str(exc)}
    except GroupingIncomplete as exc:
        return {"status": "error", "code": "grouping_incomplete", "message": str(exc)}
    except GroupingNotFound as exc:
        return {"status": "error", "code": "grouping_not_found", "message": str(exc)}
    except GroupingValidationError as exc:
        return {"status": "error", "code": "grouping_invalid", "message": str(exc)}
    except (GroupingError, sqlite3.Error, OSError):
        return {"status": "error", "code": "grouping_store_failed", "message": "本地整理结果无法读取或保存"}


__all__ = ["dispatch_grouping", "handle_grouping_request"]
