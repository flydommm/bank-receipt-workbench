"""Versioned, local-only counterparty check sheets, independent of PDF approval."""

from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import datetime, timezone
import os
from pathlib import Path
import re
import stat
import unicodedata
from uuid import uuid4
from typing import Any

from .xlsx_writer import write_xlsx_sheets
from .receipt_group_labels import document_type_label, group_display_name
from .export_plan import MAX_EXPORT_NAME_LENGTH, _limit_utf16, _safe_source_stem, _utf16_units

_ROUTES = {"excluded": "已排除", "own_pending": "本方待确认", "named": "交易对手",
           "internal": "本公司内部往来", "blank": "对方名称为空", "special": "特殊凭证",
           "counterparty_pending": "交易对手待确认"}
_STATES = {"present": "有值", "blank": "已确认空白", "missing": "未识别", "ambiguous": "有冲突",
           "pending": "尚未提取", "ready": "已提取", "stale": "依据已变化", "failed": "提取失败"}
_METHODS = {"account_match": "完整账号匹配", "manual": "人工确认", "none": "尚未确认",
            "automatic": "按规则归组", "batch_profile": "本批账户资料"}
_BASE_HEADERS = ["片段标识", "原文件", "原文件路径", "原文件SHA256", "原页码", "原栏位",
                 "边界审核状态", "凭证类型", "字段提取状态", "当前去向", "分组名称", "分组标识",
                 "归组方式", "本方识别方式", "本方所在一侧", "来源银行核对", "本方判断原因",
                 "人工修正及说明", "提醒", "本片段依据版本"]


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _draft_prefix(job: dict[str, Any]) -> str:
    """Use trusted source names; preserve existing dates without inferring a month."""
    sources = job["sources"]
    first = sources[0] if sources else {}
    stem = _safe_source_stem({"name": first.get("name", ""),
                             "source_path": first.get("access_path", first.get("source_key", ""))})
    # Reuse formal-export source cleanup, then also remove invisible format
    # controls and protect device names containing a dot on Windows.
    stem = "".join("_" if unicodedata.category(char) in {"Cf", "Cs"} else char
                   for char in unicodedata.normalize("NFC", stem)).strip(" .") or "未命名"
    if re.fullmatch(r"(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?", stem, flags=re.IGNORECASE):
        stem = "_" + stem
    suffix = (f"_等{len(sources)}份" if len(sources) > 1 else "") + "_交易对手核对草稿"
    stem = _limit_utf16(stem, MAX_EXPORT_NAME_LENGTH - _utf16_units(suffix)).rstrip(" .") or "未命名"
    return stem + suffix


def draft_sheets(snapshot: dict[str, Any], job: dict[str, Any], generated_at: str):
    """Build sheets from a trusted, locked snapshot; never accept renderer rows."""
    header, items = snapshot["header"], snapshot["items"]
    own = header["own_account"]
    source_by_key = {source["source_key"]: source for source in job["sources"]}
    headers = list(_BASE_HEADERS)
    for side in ("付款方", "收款方"):
        for field in ("名称", "账号", "开户行"):
            headers.extend([f"{side}{field}原文", f"{side}{field}识别值", f"{side}{field}状态", f"{side}{field}依据"])
    headers.extend(["有效对方名称", "有效对方账号", "有效对方开户行"])
    rows = []
    for item in items:
        binding = item["binding"]
        source = source_by_key[binding["source_key"]]
        decision = item["own_decision"]
        group = item["group"] or {}
        row = {
            "片段标识": binding["segment_id"], "原文件": source["name"],
            "原文件路径": source["access_path"], "原文件SHA256": binding["source_sha256"],
            "原页码": binding["source_page"], "原栏位": binding["position_index"],
            "边界审核状态": item["boundary_status"], "凭证类型": document_type_label(item["document_type"]),
            "字段提取状态": _STATES.get(item["extraction_state"], item["extraction_state"]),
            "当前去向": _ROUTES[item["route"]], "分组名称": group_display_name(group),
            "分组标识": group.get("group_id", ""), "归组方式": _METHODS[item["decision_method"]],
            "本方识别方式": _METHODS[decision["method"]],
            "本方所在一侧": {"payer": "付款方", "payee": "收款方", "single": "单方凭证"}.get(decision["side"], ""),
            "来源银行核对": {"matched": "已匹配", "manual": "人工确认", "unknown": "待确认", "mismatch": "不符"}[decision["source_bank_status"]],
            "本方判断原因": "；".join(decision["reasons"]), "人工修正及说明": _json(item["field_overrides"]),
            "提醒": "；".join(item["warnings"]), "本片段依据版本": item["basis_fingerprint"],
        }
        extracted = item["extracted"] or {}
        for side, label in (("payer", "付款方"), ("payee", "收款方")):
            for field, field_label in (("name", "名称"), ("account", "账号"), ("bank", "开户行")):
                value = extracted.get(side, {}).get(field, {})
                prefix = label + field_label
                row.update({prefix + "原文": str(value.get("raw", "")), prefix + "识别值": str(value.get("value", "")),
                            prefix + "状态": _STATES.get(value.get("state", "missing"), "未识别"),
                            prefix + "依据": _json(value.get("evidence", []))})
        counterparty = item["counterparty"] or {}
        for field, label in (("name", "名称"), ("account", "账号"), ("bank", "开户行")):
            row["有效对方" + label] = str(counterparty.get(field, {}).get("value", ""))
        rows.append(row)
    meta = [
        ("用途", "分析核对草稿；包含待确认和已排除项，不表示可以正式导出PDF。请在工作台修正后重新导出，首版不回导Excel。"),
        ("生成时间UTC", generated_at), ("本公司", own["company_name"]), ("来源银行", own["bank_name"]),
        ("本方开户行", own["branch_name"]), ("本方账号", str(own["account_number"])),
        ("任务标识", header["job_id"]), ("分析版本", header["result_revision"]),
        ("归组版本", header["grouping_revision"]), ("审核依据", header["review_fingerprint"]),
        ("本方账户依据", own["fingerprint"]), ("片段总数", len(items)),
    ]
    incomplete = [{"原文件": source["name"], "原文件路径": source["access_path"],
                   "状态": source.get("state", "未知"),
                   "说明": "此来源未全部成功，请返回工作台检查，不能据此草稿判定已整理齐全。"}
                  for source in job["sources"] if source.get("state") not in {"verified", "registered"}
                  or source.get("error") or source.get("error_json")]
    return [("草稿说明", ["项目", "内容"], [{"项目": key, "内容": value} for key, value in meta]),
            ("片段核对", headers, rows), ("未完成来源", ["原文件", "原文件路径", "状态", "说明"], incomplete)]


def write_draft(output, snapshot: dict[str, Any], job: dict[str, Any], generated_at: str):
    return write_xlsx_sheets(output, draft_sheets(snapshot, job, generated_at))


@contextmanager
def _hold_draft(store, review_database: Path, request: dict[str, Any]):
    from .export_scope import ExportScopeError, _digest, _hold_existing_reviews
    from .receipt_grouping_store import read_grouping_export_snapshot
    from .receipt_review_read import read_receipt_review_snapshot
    from .batch_pdf import open_batch_source
    authority = store.review_snapshot(request["job_id"], request["result_revision"])
    job = authority["job"]
    # Failed/unanalysed sources remain visible in their own sheet. Sources
    # with immutable identities are rechecked from read-only working copies.
    for source in job["sources"]:
        if source.get("sha256") and source.get("state") in {"verified", "registered"}:
            with open_batch_source(source["access_path"], source["sha256"]) as opened:
                if opened.size_bytes != source["size_bytes"] or opened.page_count != source["page_count"]:
                    raise ExportScopeError("draft source identity changed", "source_changed")
    with store.hold_review_binding(job):
        with _hold_existing_reviews(review_database) as connection:
            current = read_grouping_export_snapshot(connection, job["id"],
                expected_grouping_revision=request["expected_grouping_revision"],
                expected_review_fingerprint=request["expected_review_fingerprint"], require_complete=False)
            header = current["header"]
            if (header["result_revision"] != request["result_revision"]
                    or header["own_account"]["fingerprint"] != request["own_account_fingerprint"]):
                raise ExportScopeError("draft account or result changed", "export_scope_stale")
            originals = {item["id"]: item for item in authority["originals"]}
            if len(current["items"]) != len(originals) or {item["binding"]["segment_id"] for item in current["items"]} != set(originals):
                raise ExportScopeError("draft receipt set changed", "export_scope_stale")
            from .receipt_review_models import validate_receipt_context
            _, _, context_key = validate_receipt_context(authority["context"], trusted_aliases=True)
            reviews = read_receipt_review_snapshot(review_database, context_key, request["result_revision"])
            records = {row["original"]["id"]: row for row in reviews["segments"]}
            for item in current["items"]:
                binding = item["binding"]
                original = originals[binding["segment_id"]]
                record = records.get(binding["segment_id"])
                if (any(binding[key] != original[key] for key in ("source_key", "source_page", "slot_id", "position_index", "instance_id", "analysis_signature"))
                        or binding["review_record_revision"] != (record["record_revision"] if record else 0)):
                    raise ExportScopeError("draft review changed", "export_scope_stale")
            result = {"header": header, "items": current["items"]}
            yield result, job, _digest({"grouping": result, "authority": authority, "reviews": reviews})


def _draft_file_identity(handle) -> dict[str, object]:
    """Hash one opened regular file and detect writes during the read."""
    from .export_publish import _file_identity_from_stat, _hash_open_file, _stat_matches_identity
    from .export_scope import ExportScopeError
    before = os.fstat(handle.fileno())
    if not stat.S_ISREG(before.st_mode) or getattr(before, "st_file_attributes", 0) & 0x400:
        raise ExportScopeError("draft output is not an ordinary file", "draft_export_failed")
    handle.seek(0)
    digest, size = _hash_open_file(handle)
    identity = _file_identity_from_stat(before, digest)
    if size != before.st_size or not _stat_matches_identity(os.fstat(handle.fileno()), identity):
        raise ExportScopeError("draft output changed while hashing", "draft_export_failed")
    return identity


def _verify_draft_directory(path: Path, expected: dict[str, object], files: list[dict[str, object]], *, renamed: bool = False) -> None:
    from .export_directory import directory_identity, _same_identity
    from .export_publish import _verify_attempt_files
    from .export_scope import ExportScopeError
    before = directory_identity(path)
    if not _same_identity(before, expected, require_path=not renamed):
        raise ExportScopeError("draft directory identity changed", "draft_export_failed")
    registry = {"files": files}
    if (_verify_attempt_files(registry, path)
            or _verify_attempt_files(registry, path, full_hash=False)):
        raise ExportScopeError("draft directory contents changed", "draft_export_failed")
    if not _same_identity(directory_identity(path), before):
        raise ExportScopeError("draft directory changed while checking", "draft_export_failed")


def publish_grouping_draft(batch_database: Path, review_database: Path, request: dict[str, Any]) -> dict[str, Any]:
    from .batch_pdf import BatchSourceError
    from .batch_store import BatchStore
    from .export_scope import ExportScopeError
    from .export_directory import directory_identity, writable_directory, rename_directory_no_replace
    from .receipt_grouping_models import GroupingError
    if (type(request.get("expected_grouping_revision")) is not int or not 0 <= request["expected_grouping_revision"] < 2**53
            or any(not isinstance(request.get(key), str) or not re.fullmatch(r"[a-f0-9]{64}", request[key])
                   for key in ("expected_review_fingerprint", "own_account_fingerprint"))
            or any(not isinstance(request.get(key), str) or not request[key] or "\0" in request[key] or len(request[key]) > 32768
                   for key in ("job_id", "result_revision", "directory"))):
        raise ExportScopeError("draft request is invalid")
    parent = Path(request["directory"])
    parent_identity = directory_identity(parent)
    generated = datetime.now(timezone.utc)
    generated_at = generated.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    suffix = generated.strftime("%Y%m%d_%H%M%S") + "_" + uuid4().hex[:12]
    created = False
    try:
        with BatchStore(batch_database) as store:
            with _hold_draft(store, review_database, request) as (snapshot, job, frozen_digest):
                pass
            prefix = _draft_prefix(job)
            temporary = parent / ("." + prefix + "_" + suffix + ".tmp")
            final = parent / (prefix + "_" + suffix)
            name = prefix + ".xlsx"
            with writable_directory(parent, parent_identity):
                temporary.mkdir(mode=0o700, parents=False, exist_ok=False)
                created = True
                temporary_identity = directory_identity(temporary)
                with writable_directory(temporary, temporary_identity):
                    with (temporary / name).open("x+b") as output:
                        write_draft(output, snapshot, job, generated_at)
                        output.flush()
                        os.fsync(output.fileno())
                        file_identity = _draft_file_identity(output)
                file_hash, file_size = file_identity["sha256"], file_identity["size"]
                files = [{"name": name, "state": "created", "identity": file_identity}]
            # Keep the exact batch + review/grouping versions protected until
            # the complete directory is made visible, without overwriting.
            with _hold_draft(store, review_database, request) as (_, _, latest_digest):
                if latest_digest != frozen_digest:
                    raise ExportScopeError("draft changed while writing", "export_scope_stale")
                with writable_directory(parent, parent_identity):
                    _verify_draft_directory(temporary, temporary_identity, files)
                    rename_directory_no_replace(temporary, final, temporary_identity, parent_identity)
                    # Windows cannot rename the directory while its child is
                    # open. Match full-bundle publication: verify the complete
                    # final registry before acknowledging the native rename.
                    _verify_draft_directory(final, temporary_identity, files, renamed=True)
        return {"state": "draft_published", "directory": str(final), "path": str(final / name), "name": name,
                "sha256": file_hash, "size_bytes": file_size, "row_count": len(snapshot["items"]), "generated_at": generated_at,
                "job_id": snapshot["header"]["job_id"], "result_revision": snapshot["header"]["result_revision"],
                "grouping_revision": snapshot["header"]["grouping_revision"], "review_fingerprint": snapshot["header"]["review_fingerprint"],
                "own_account_fingerprint": snapshot["header"]["own_account"]["fingerprint"]}
    except Exception as error:
        if isinstance(error, ExportScopeError):
            wrapped = error
        elif isinstance(error, BatchSourceError):
            wrapped = ExportScopeError("draft source could not be verified", error.code)
        else:
            wrapped = ExportScopeError("draft could not be saved", "export_scope_stale" if isinstance(error, GroupingError) else "draft_export_failed")
        if created:
            # The native rename may have succeeded before a later check or
            # callback failed. Report the actual remaining path; never erase
            # a replacement, a foreign child, or a partially published file.
            remaining = [path for path in (temporary, final) if os.path.lexists(path)]
            wrapped.residuals = [{"path": str(path), "reason": "核对草稿未通过完整发布校验，此目录已保留供检查；不会覆盖现有文件。"}
                                 for path in remaining or [temporary]]
        raise wrapped from None
