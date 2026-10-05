"""独立的交易对手归组算法版本。

交易对手字段提取和归组发生在既有回单分割之后。归组独占源码的变更只
使归组依据失效，不改变已经完成的分割、裁剪和审核结果的计算版本。
银行身份和凭证类型同时影响分析与归组，必须参与两者的指纹。因此这里
单独计算源码指纹，不复用 :mod:`engine.computation` 的整个分析版本。
"""

from __future__ import annotations

from functools import lru_cache
from hashlib import sha256
import json
from pathlib import Path
from typing import Any, Mapping


# Keep the list explicit.  The API is included because its trusted projection
# determines which fields reach the grouping rules, while the export modules
# are not part of the decision algorithm itself.
# These modules also produce analysis results. Keep them in both fingerprints:
# removing them from either side could revive results based on old semantics.
SHARED_ANALYSIS_SOURCE_FILES: tuple[str, ...] = (
    "engine/receipt_document_types.py",
    "engine/receipt_issuer.py",
)

GROUPING_ONLY_SOURCE_FILES: tuple[str, ...] = (
    "engine/receipt_parties.py",
    "engine/receipt_grouping_models.py",
    "engine/receipt_grouping_store.py",
    "engine/receipt_grouping_api.py",
    "engine/receipt_grouping_basis.py",
    "engine/receipt_grouping_version.py",
    "engine/receipt_field_candidates.py",
    "engine/receipt_field_readers.py",
    "engine/receipt_party_relations.py",
    "engine/receipt_field_rule_models.py",
    "engine/receipt_field_rule_reader.py",
    "engine/receipt_field_rule_application.py",
    "engine/receipt_group_labels.py",
)
GROUPING_SOURCE_FILES = GROUPING_ONLY_SOURCE_FILES + SHARED_ANALYSIS_SOURCE_FILES

# Common projection/field normalization applies to every reader. Reader source
# changes only invalidate fragments that actually used that reader. Saved local
# rule definitions are immutable evidence, not a dependency on the live library.
COMMON_EXTRACTION_SOURCE_FILES = (
    "engine/receipt_field_candidates.py", "engine/receipt_grouping_api.py",
    *SHARED_ANALYSIS_SOURCE_FILES,
)
READER_SOURCE_FILES = {
    "legacy_labels": ("engine/receipt_parties.py",),
    "direct_counterparty": ("engine/receipt_parties.py", "engine/receipt_field_readers.py"),
    "local-field-rule": ("engine/receipt_parties.py", "engine/receipt_field_readers.py",
                         "engine/receipt_field_rule_models.py", "engine/receipt_field_rule_reader.py"),
}


class GroupingVersionError(RuntimeError):
    """无法安全确定当前归组算法版本。"""


def _module_digests() -> dict[str, str]:
    root = Path(__file__).resolve().parent.parent
    digests: dict[str, str] = {}
    for relative_path in GROUPING_SOURCE_FILES:
        path = root / relative_path
        try:
            content = path.read_bytes()
        except (OSError, ValueError) as exc:
            raise GroupingVersionError("分组算法源码不可读取") from exc
        digests[relative_path] = sha256(content).hexdigest()
    return digests


@lru_cache(maxsize=1)
def grouping_algorithm_version() -> str:
    """返回当前进程使用的归组算法指纹。

    归组请求在一个桌面进程内复用同一版本；安装新版本通常会重启进程，
    从而重新读取源码指纹。测试可以调用 ``clear_grouping_algorithm_version``
    显式清除缓存。
    """

    payload = json.dumps(
        {"schema": "receipt-grouping-v1", "modules": _module_digests()},
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"grouping-v1-{sha256(payload).hexdigest()[:32]}"


def clear_grouping_algorithm_version() -> None:
    """清除进程内版本缓存，供源码变更回归测试使用。"""

    grouping_algorithm_version.cache_clear()
    extraction_algorithm_version.cache_clear()
    reader_algorithm_version.cache_clear()


@lru_cache(maxsize=1)
def extraction_algorithm_version() -> str:
    """Version only field reading/projection, independently of grouping rules."""
    digests = _module_digests()
    payload = json.dumps({"contract": "field-evidence-v2", "modules": {
        name: digests[name] for name in COMMON_EXTRACTION_SOURCE_FILES
    }}, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "extraction-v2-" + sha256(payload).hexdigest()[:32]


@lru_cache(maxsize=16)
def reader_algorithm_version(reader_id: str) -> str | None:
    files = READER_SOURCE_FILES.get(reader_id)
    if files is None:
        return None
    digests = _module_digests()
    payload = json.dumps({name: digests[name] for name in files}, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return "reader-v1-" + sha256(payload).hexdigest()[:32]


def extraction_dependencies(parties: Mapping[str, Any], *, common_version: str | None = None,
                            rule_basis: object = None) -> dict[str, Any]:
    from .receipt_field_candidates import normalize_reader_dependencies
    readers = normalize_reader_dependencies(parties.get("reader_dependencies"))
    # Older trusted local readers have the legacy shape. Newly read values can
    # establish that dependency; an old cache without this bundle is stale.
    if not readers:
        readers = [{"reader_id": "legacy_labels", "version": "1"}]
    result: dict[str, Any] = {
        "common_version": common_version or extraction_algorithm_version(),
        "readers": [{**reader, "source_version": reader_algorithm_version(reader["reader_id"])} for reader in readers],
    }
    if isinstance(rule_basis, Mapping):
        result["rule"] = {key: rule_basis[key] for key in ("rule_id", "version", "definition_digest") if key in rule_basis}
        if "definition_digest" not in result["rule"] and isinstance(rule_basis.get("definition"), Mapping):
            from .receipt_field_rule_models import rule_digest
            result["rule"]["definition_digest"] = rule_digest(rule_basis["definition"])
    return result


__all__ = [
    "GROUPING_SOURCE_FILES",
    "GROUPING_ONLY_SOURCE_FILES", "SHARED_ANALYSIS_SOURCE_FILES",
    "GroupingVersionError",
    "clear_grouping_algorithm_version",
    "grouping_algorithm_version",
    "extraction_algorithm_version",
    "reader_algorithm_version", "extraction_dependencies",
    "COMMON_EXTRACTION_SOURCE_FILES", "READER_SOURCE_FILES",
]
