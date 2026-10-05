"""Pure models and conservative rules for receipt counterparty grouping.

The grouping feature deliberately lives beside, rather than inside, the
receipt review model.  A grouping decision is a view over an already split
receipt and must never change its crop, exclusion, or document type.

The module accepts the field shape produced by :mod:`receipt_parties` and a
small set of equivalent JSON shapes used by the batch/review boundary.  All
helpers return JSON-friendly dictionaries so the Python engine and the
desktop bridge can share the same contract without leaking SQLite rows.
"""

from __future__ import annotations

from copy import deepcopy

from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import re
from typing import Any, Mapping, Sequence
import unicodedata
from uuid import uuid4

from .receipt_document_types import DOCUMENT_TYPES, GROUPING_SERVICE_TYPES
from .receipt_issuer import canonical_bank_heading, is_bank_channel_heading, rural_bank_identity_unspecified


MAX_TEXT_BYTES = 4096
MAX_ACCOUNT_BYTES = 128
MAX_ACCOUNT_NAME_CHARS = 256
MAX_EVIDENCE_BYTES = 64 * 1024
MAX_PARTY_BYTES = 128 * 1024
MAX_GROUP_KEY_BYTES = 4096
MAX_ITEMS = 50_000
MAX_REFRESH_IDS = 50
MAX_REFRESH_PAGES = 200

PARTY_SIDES = ("payer", "payee")
PARTY_FIELDS = ("name", "account", "bank")
PARTY_STATES = frozenset({"present", "blank", "missing", "ambiguous"})


class GroupingError(ValueError):
    """Base error for invalid grouping data or unavailable state."""
    code = "grouping_error"


class GroupingValidationError(GroupingError):
    """Input data does not satisfy the bounded grouping contract."""
    code = "grouping_invalid"


class AccountValidationError(GroupingValidationError):
    """A profile is incomplete or cannot represent a full account."""
    code = "account_invalid"


class GroupingConflict(GroupingError):
    """A task, account, or grouping revision changed before a write."""
    code = "grouping_conflict"


class GroupingNotFound(GroupingError):
    """A requested account, task, item, or group does not exist."""
    code = "grouping_not_found"


class GroupingSourceChanged(GroupingError):
    """A source path no longer has the immutable SHA bound to the item."""
    code = "source_changed"


class GroupingIncomplete(GroupingError):
    """A grouping snapshot still contains unresolved destinations."""
    code = "grouping_incomplete"


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_json(value: object) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError, OverflowError) as exc:
        raise GroupingValidationError("分组数据格式无效") from exc


def digest(value: object) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _text(value: object, field_name: str, *, required: bool = True, limit: int = MAX_TEXT_BYTES) -> str:
    if not isinstance(value, str) or "\x00" in value:
        raise GroupingValidationError(f"{field_name}格式无效")
    value = unicodedata.normalize("NFC", value).strip()
    if required and not value:
        raise GroupingValidationError(f"{field_name}不能为空")
    if not value and not required:
        return ""
    if len(value) > limit:
        raise GroupingValidationError(f"{field_name}过长")
    try:
        value.encode("utf-8", "strict")
    except UnicodeError:
        raise GroupingValidationError(f"{field_name}格式无效") from None
    return value


def normalize_text(value: object) -> str:
    """Normalize only presentation whitespace and full-width forms.

    Names are intentionally not fuzzy matched or rewritten.  This function
    retains meaningful punctuation and internal spaces.
    """

    if not isinstance(value, str):
        return ""
    # NFKC also folds circled digits, Roman numerals and other meaningful
    # characters; that would accidentally merge distinct account names.
    width_only = value.translate({**{c: c - 0xFEE0 for c in range(0xFF01, 0xFF5F)}, 0x3000: 0x20})
    return " ".join(unicodedata.normalize("NFC", width_only).split())


def normalize_account(value: object) -> str:
    """Return a comparison form while preserving the stored account text."""

    if not isinstance(value, str):
        return ""
    return "".join(normalize_text(value).split())


def normalize_bank(value: object) -> str:
    return normalize_text(value).casefold()


def new_account_id() -> str:
    return f"account_{uuid4().hex}"


@dataclass(frozen=True)
class CompanyAccount:
    """A locally saved account profile used to establish the selected side."""

    id: str
    revision: int
    company_name: str
    bank_name: str
    branch_name: str | None
    account_number: str
    active: bool = True
    created_at: str | None = None
    updated_at: str | None = None

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any], *, require_id: bool = False) -> "CompanyAccount":
        if not isinstance(value, Mapping):
            raise GroupingValidationError("本方账户资料格式无效")
        raw_id = value.get("account_id", value.get("id", ""))
        identifier = _text(raw_id, "账户资料编号", required=require_id, limit=256) if raw_id else ""
        raw_revision = value.get("account_revision", value.get("revision", 1))
        if raw_revision is None and not identifier:
            raw_revision = 1  # An inline task snapshot has no profile revision.
        if isinstance(raw_revision, bool) or not isinstance(raw_revision, int) or not 1 <= raw_revision <= (1 << 53) - 1:
            raise GroupingValidationError("账户资料版本无效")
        branch = value.get("branch_name", value.get("branch", None))
        branch_name = "" if branch in (None, "") else _text(branch, "开户支行", required=True, limit=MAX_ACCOUNT_NAME_CHARS)
        account_number = _text(value.get("account_number", value.get("account", "")), "本方账号",
                               limit=MAX_ACCOUNT_BYTES)
        if not _complete_account_text(account_number):
            raise AccountValidationError("本方账号必须是完整账号")
        active_value = value.get("active", True)
        if not isinstance(active_value, bool):
            raise GroupingValidationError("账户启用状态无效")
        return cls(
            id=identifier,
            revision=raw_revision,
            company_name=_text(value.get("company_name", value.get("company", "")), "公司名称", limit=MAX_ACCOUNT_NAME_CHARS),
            bank_name=_text(value.get("bank_name", value.get("bank", "")), "来源银行", limit=MAX_ACCOUNT_NAME_CHARS),
            branch_name=branch_name,
            account_number=account_number,
            active=active_value,
            created_at=(None if value.get("created_at") is None else _text(value["created_at"], "创建时间")),
            updated_at=(None if value.get("updated_at") is None else _text(value["updated_at"], "更新时间")),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "account_id": self.id,
            "account_revision": self.revision,
            "company_name": self.company_name,
            "bank_name": self.bank_name,
            "branch_name": self.branch_name,
            "account_number": self.account_number,
            "active": self.active,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    def snapshot(self) -> dict[str, Any]:
        """Return the immutable account data bound to one grouping task."""

        return {
            "account_id": self.id or None,
            "account_revision": self.revision,
            "company_name": self.company_name,
            "bank_name": self.bank_name,
            "branch_name": self.branch_name,
            "account_number": self.account_number,
        }

    @property
    def account_id(self) -> str:
        return self.id

    @property
    def account_revision(self) -> int:
        return self.revision


def validate_account(value: Mapping[str, Any], *, require_id: bool = False) -> CompanyAccount:
    try:
        return CompanyAccount.from_mapping(value, require_id=require_id)
    except GroupingValidationError as error:
        raise AccountValidationError(str(error)) from None


def _raw_field_value(value: object, field_name: str) -> str:
    if isinstance(value, Mapping):
        # ``raw`` is kept verbatim for the evidence view.  ``value`` is the
        # editable/normalized bridge shape used by early callers.
        raw = value.get("raw", value.get("value", value.get("normalized", "")))
    else:
        raw = value
    if raw is None:
        return ""
    if not isinstance(raw, str) or "\0" in raw or len(raw) > MAX_TEXT_BYTES:
        raise GroupingValidationError("交易字段原文格式无效")
    return raw


def normalize_party_field(value: object, field_name: str) -> dict[str, Any]:
    """Normalize one party field without discarding its raw/evidence values."""

    if field_name not in PARTY_FIELDS:
        raise GroupingValidationError("交易字段类型无效")
    if isinstance(value, Mapping):
        raw = _raw_field_value(value, field_name)
        editable = value.get("value", value.get("normalized", raw))
        editable = "" if editable is None else editable
        if not isinstance(editable, str) or "\0" in editable or len(editable) > MAX_TEXT_BYTES:
            raise GroupingValidationError("交易字段值格式无效")
        state = value.get("state")
        evidence = value.get("evidence")
        # Keep parser diagnostics and additional evidence bounded.  Do not
        # include evidence in exception messages, which could expose a whole
        # receipt in a host log.
        try:
            evidence_json = canonical_json(evidence) if evidence is not None else None
        except GroupingValidationError:
            raise GroupingValidationError("交易字段依据格式无效") from None
        if evidence_json is not None and len(evidence_json.encode("utf-8")) > MAX_EVIDENCE_BYTES:
            raise GroupingValidationError("交易字段依据过长")
    else:
        raw = _raw_field_value(value, field_name)
        editable = raw
        state = None
        evidence = None
    normalized = normalize_account(editable) if field_name == "account" else normalize_text(editable)
    if state is None:
        # Absence of text never establishes an original blank. Only the
        # extractor's explicit state or a manual assertion can do that.
        state = "present" if normalized else "missing"
    if not isinstance(state, str) or state not in PARTY_STATES:
        raise GroupingValidationError("交易字段状态无效")
    if (state == "blank" and normalized) or (state == "present" and not normalized):
        raise GroupingValidationError("交易字段状态与值不一致")
    if field_name == "account" and state == "present" and not _complete_account_text(normalized):
        state = "ambiguous"
    result = {
        "raw": raw,
        "value": editable,
        "normalized": normalized,
        "state": state,
        "evidence": evidence,
        "diagnostics": list(value.get("diagnostics", [])) if isinstance(value, Mapping) and isinstance(value.get("diagnostics", []), list) else [],
    }
    if isinstance(value, Mapping) and isinstance(value.get("candidates"), list):
        result["candidates"] = [normalize_party_field(
            {key: candidate[key] for key in ("raw", "value", "state", "evidence") if key in candidate}, field_name,
        ) for candidate in value["candidates"][:16] if isinstance(candidate, Mapping)]
    return result


def normalize_parties(value: object) -> dict[str, Any]:
    """Accept ``parties``/``receipt_parties`` and return payer/payee fields."""

    source: Mapping[str, Any]
    if not isinstance(value, Mapping):
        source = {}
    else:
        source = value
    result: dict[str, dict[str, dict[str, Any]]] = {}
    for side in PARTY_SIDES:
        side_value = source.get(side)
        side_mapping = side_value if isinstance(side_value, Mapping) else {}
        result[side] = {
            field_name: normalize_party_field(side_mapping.get(field_name), field_name)
            for field_name in PARTY_FIELDS
        }
    # Additive metadata keeps old records compatible while retaining automatic
    # direct-counterparty observations through the storage projection.
    from .receipt_field_candidates import normalize_issues, normalize_reader_dependencies
    for role in ("own_observed", "counterparty_observed"):
        if role in source:
            observed = source[role]
            result[role] = ({field: normalize_party_field(observed.get(field), field) for field in PARTY_FIELDS}
                            if isinstance(observed, Mapping) else None)
    if "issues" in source:
        result["issues"] = normalize_issues(source["issues"])
    if "reader_dependencies" in source:
        result["reader_dependencies"] = normalize_reader_dependencies(source["reader_dependencies"])
    if "layout_signature" in source:
        signature = source["layout_signature"]
        result["layout_signature"] = signature if isinstance(signature, str) and re.fullmatch(r"[a-f0-9]{64}", signature) else None
    if "service_type" in source:
        service_type = source["service_type"]
        if service_type is not None and (not isinstance(service_type, str) or service_type not in GROUPING_SERVICE_TYPES):
            raise GroupingValidationError("银行收费或结息凭证类型无效")
        result["service_type"] = service_type
    return result


def _party_container(item: Mapping[str, Any]) -> Mapping[str, Any]:
    for key in ("parties", "receipt_parties", "party_fields", "fields"):
        candidate = item.get(key)
        if isinstance(candidate, Mapping) and any(side in candidate for side in (*PARTY_SIDES, "own_observed", "counterparty_observed")):
            return candidate
    if any(side in item for side in (*PARTY_SIDES, "own_observed", "counterparty_observed")):
        return item
    return {}


def parties_from_item(item: Mapping[str, Any]) -> dict[str, dict[str, dict[str, Any]]]:
    return normalize_parties(_party_container(item))


def _item_source_bank(item: Mapping[str, Any]) -> tuple[str, str]:
    """Return (bank value, state) without looking at either party's bank.

    A counterparty's开户行 is never treated as evidence for the bank that
    issued the source PDF.  The issuer must come from the authoritative batch
    layout/page metadata or an explicit manual confirmation.
    """

    for key in ("source_bank", "issuer_bank", "source_issuer_bank", "issuer"):
        candidate = item.get(key)
        if isinstance(candidate, Mapping):
            value = candidate.get("bank_name", candidate.get("name", candidate.get("value", "")))
            state = candidate.get("state", "present" if value else "unknown")
        else:
            value = candidate
            state = "present" if value else "unknown"
        if state in {"mismatch", "ambiguous", "unknown", "missing"} and candidate is not None:
            return normalize_text(value) if isinstance(value, str) else "", str(state)
        if isinstance(value, str) and value.strip():
            if is_bank_channel_heading(value):
                return "", "unknown"
            return normalize_text(value), str(state)
    return "", "unknown"


def _field_present(field: Mapping[str, Any]) -> bool:
    return field.get("state") == "present" and bool(field.get("normalized"))


def _field_blank(field: Mapping[str, Any]) -> bool:
    return field.get("state") == "blank" and not field.get("normalized")


def _complete_account_text(value: object) -> bool:
    """No numeric coercion, masked characters, suffix labels or ellipses."""
    normalized = normalize_account(value)
    return bool(normalized and len(normalized) <= MAX_ACCOUNT_BYTES
                and re.fullmatch(r"[A-Za-z0-9]+", normalized)
                and re.search(r"[0-9]", normalized)
                and not re.search(r"[xX]", normalized))


def _full_account(field: Mapping[str, Any]) -> str:
    if not _field_present(field):
        return ""
    value = normalize_account(field.get("normalized", field.get("value", field.get("raw", ""))))
    return value if _complete_account_text(value) else ""


def _special_type(item: Mapping[str, Any]) -> tuple[str, bool]:
    for key in ("special_type", "document_type", "voucher_type"):
        value = item.get(key)
        if isinstance(value, Mapping):
            label = value.get("value", value.get("name", value.get("type", "")))
            confirmed = value.get("confirmed", value.get("state") in {"confirmed", "present"})
        else:
            label = value
            confirmed = item.get("special_confirmed", item.get("document_type_confirmed", False))
        if isinstance(label, str) and label.strip():
            label = normalize_text(label)
            if label == "ordinary":
                return "", False
            if label not in DOCUMENT_TYPES | {"other_special"}:
                raise GroupingValidationError("凭证分类无效")
            if not isinstance(confirmed, bool):
                raise GroupingValidationError("凭证分类确认状态无效")
            return label, confirmed
    return "", False


def _item_identifier(item: Mapping[str, Any], index: int = 0) -> str:
    for key in ("item_id", "id", "instance_id", "segment_id"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    identity = {
        "source_key": item.get("source_key", item.get("source_id", "")),
        "source_sha256": item.get("source_sha256", ""),
        "source_page": item.get("source_page", item.get("page", 0)),
        "segment_no": item.get("segment_no", item.get("segment", index + 1)),
        "slot_id": item.get("slot_id", item.get("slot", "")),
    }
    return f"receipt_{digest(identity)[:32]}"


def _stable_identity(item: Mapping[str, Any]) -> str:
    """Identity used for safe layout-revision migration within one task."""

    final_rect = item.get("final_rect", item.get("rect"))
    semantic = item.get("semantic_identity", item.get("semantic", ""))
    return digest({
        "source_key": item.get("source_key", item.get("source_id", "")),
        "source_sha256": item.get("source_sha256", ""),
        "source_page": item.get("source_page", item.get("page", 0)),
        "segment_no": item.get("segment_no", item.get("segment", 0)),
        "slot_id": item.get("slot_id", item.get("slot", "")),
        "final_rect": final_rect,
        "semantic": semantic,
    })


def _group_key(prefix: str, value: str) -> str:
    key = f"{prefix}:{value}"
    if len(key.encode("utf-8")) > MAX_GROUP_KEY_BYTES:
        raise GroupingValidationError("交易对手分组名称过长")
    return key


def derive_grouping_decision(
    item: Mapping[str, Any],
    account: CompanyAccount | Mapping[str, Any],
    *,
    source_bank: str | None = None,
    manual: Mapping[str, Any] | None = None,
    groups: Mapping[str, Mapping[str, Any]] | None = None,
    job_id: str | None = None,
) -> dict[str, Any]:
    """Recompute one decision from immutable fields and currently valid manual data.

    Callers verify source/account/crop continuity and invalidate manual records
    whose basis changed. This function never mutates ``item`` or
    the extraction evidence. Legacy suggestion keys remain for store callers;
    ``own_decision``, ``route`` and ``group`` are the authoritative new contract.
    """
    if not isinstance(item, Mapping):
        raise GroupingValidationError("回单片段格式无效")
    profile = validate_account(account.to_dict() if isinstance(account, CompanyAccount) else account)
    if not _complete_account_text(profile.account_number):
        raise AccountValidationError("本方账号必须是完整账号")
    parties = parties_from_item(item)
    own_observed = parties.get("own_observed")
    counterparty_observed = parties.get("counterparty_observed")
    manual = {} if manual is None else manual
    if not isinstance(manual, Mapping):
        raise GroupingValidationError("人工决定格式无效")
    if groups is not None and not isinstance(groups, Mapping):
        raise GroupingValidationError("分组定义格式无效")
    confirmation = manual.get("own_confirmation")
    manual_side = None
    if confirmation is not None:
        if (not isinstance(confirmation, Mapping)
                or set(confirmation) != {"side", "confirms_selected_account", "confirms_source_bank", "reason"}
                or confirmation["side"] not in {"payer", "payee", "single"}
                or confirmation["confirms_selected_account"] is not True
                or confirmation["confirms_source_bank"] is not True):
            raise GroupingValidationError("本方确认必须明确账户、来源银行及所在一侧")
        _text(confirmation["reason"], "人工确认依据", limit=1000)
        manual_side = confirmation["side"]
    override_values = manual.get("field_overrides") or []
    if not isinstance(override_values, list) or len(override_values) > 9:
        raise GroupingValidationError("人工字段数量无效")
    overrides = []
    seen = set()
    single_counterparty = {key: normalize_party_field(None, key) for key in PARTY_FIELDS}
    for change in override_values:
        if (not isinstance(change, Mapping)
                or set(change) != {"side", "field", "value", "state", "reason"}
                or change["side"] not in {"payer", "payee", "counterparty"}
                or change["field"] not in PARTY_FIELDS
                or change["state"] not in {"present", "blank"}):
            raise GroupingValidationError("人工字段格式无效")
        side, field_name = change["side"], change["field"]
        if (side, field_name) in seen:
            raise GroupingValidationError("人工字段重复")
        seen.add((side, field_name))
        value = _text(change["value"], "人工字段", required=False,
                      limit=MAX_ACCOUNT_BYTES if field_name == "account" else MAX_ACCOUNT_NAME_CHARS)
        reason = _text(change["reason"], "人工字段依据", limit=1000)
        if (change["state"] == "blank" and value) or (change["state"] == "present" and not value):
            raise GroupingValidationError("人工字段状态与值不一致")
        target = single_counterparty if side == "counterparty" else parties[side]
        original = target[field_name]
        target[field_name] = normalize_party_field({**original, "value": value, "state": change["state"]}, field_name)
        overrides.append({"side": side, "field": field_name, "value": value, "state": change["state"], "reason": reason})

    source_value, source_state = _item_source_bank(item)
    def bank_key(value: str) -> str:
        value = normalize_text(value)
        return normalize_bank(canonical_bank_heading(value) or value)
    source_status = "unknown"
    reasons: list[str] = []
    if source_state == "mismatch":
        source_status = "mismatch"
        reasons.append("source_bank_mismatch")
    elif source_state in {"present", "confirmed"} and source_value:
        expected_bank = source_bank or profile.bank_name
        if rural_bank_identity_unspecified(source_value, expected_bank):
            reasons.append("source_bank_unknown")
        elif bank_key(source_value) == bank_key(expected_bank):
            source_status = "matched"
        else:
            source_status = "mismatch"
            reasons.append("source_bank_mismatch")
    elif confirmation is not None:
        source_status = "manual"
    else:
        reasons.append("source_bank_unknown")

    selected_account = normalize_account(profile.account_number)
    complete_accounts = {side: _full_account(parties[side]["account"]) for side in PARTY_SIDES}
    matches = [side for side in PARTY_SIDES if complete_accounts[side] == selected_account]
    our_side: str | None = None
    method = "none"
    if len(matches) == 2:
        reasons.append("both_sides_match_our_account")
    elif len(matches) == 1:
        our_side = matches[0]
        if manual_side is not None and manual_side != our_side:
            reasons.append("own_side_conflict")
        method = "manual" if confirmation is not None else "account_match"
    elif manual_side in PARTY_SIDES:
        our_side = manual_side
        if complete_accounts[our_side] and complete_accounts[our_side] != selected_account:
            reasons.append("own_account_mismatch")
        method = "manual"
    elif manual_side == "single":
        our_side = "single"
        if any(complete_accounts.values()):
            reasons.append("own_account_mismatch")
        method = "manual"
    else:
        reasons.append("own_account_mismatch" if all(complete_accounts.values()) else "own_account_missing")
    company_name = normalize_text(profile.company_name)
    # The selected account describes this batch. Missing printed identity is
    # not a second admission gate for each receipt. A unique exact company
    # name can locate the own side without inventing a missing account.
    name_matches = [side for side in PARTY_SIDES
                    if _field_present(parties[side]["name"])
                    and normalize_text(parties[side]["name"]["normalized"]) == company_name]
    if our_side is None and not matches and len(name_matches) == 1:
        our_side = name_matches[0]
        method = "batch_profile"
        if complete_accounts[our_side] and complete_accounts[our_side] != selected_account:
            reasons.append("own_account_mismatch")
    if our_side in PARTY_SIDES:
        own_name = parties[our_side]["name"]
        if _field_present(own_name) and normalize_text(own_name["normalized"]) != company_name:
            reasons.append("own_company_mismatch")
        elif own_name["state"] == "ambiguous":
            reasons.append("own_company_ambiguous")
    from .receipt_party_relations import observed_identity_conflicts, combine_counterparty_observation
    reasons.extend(reason for reason in observed_identity_conflicts(own_observed, profile.company_name, selected_account)
                   if reason not in reasons)
    individually_matched = bool(our_side is not None and not reasons and source_status in {"matched", "manual"})
    own_decision = {"status": "confirmed", "method": method if individually_matched else "batch_profile",
                    "side": our_side, "source_bank_status": source_status, "reasons": reasons}
    special, special_confirmed = _special_type(item)
    counterparty_side = ("payee" if our_side == "payer" else "payer") if our_side in PARTY_SIDES else None
    counterparty = deepcopy(parties[counterparty_side]) if counterparty_side else deepcopy(single_counterparty)
    if our_side is None and len(name_matches) == 2:
        # Both names positively identify an internal transfer; unavailable
        # direction must not invent which bank/account is the counterparty.
        counterparty["name"] = deepcopy(parties[name_matches[0]]["name"])
    protected_fields = [change["field"] for change in overrides
                        if change["side"] == "counterparty" or change["side"] == counterparty_side]
    counterparty = combine_counterparty_observation(counterparty, counterparty_observed, protected_fields)
    counterparty = {key: normalize_party_field(counterparty[key], key) for key in PARTY_FIELDS}
    for change in overrides:
        if change["side"] == "counterparty":
            key = change["field"]
            counterparty[key] = normalize_party_field({**counterparty[key], "value": change["value"], "state": change["state"]}, key)
    scope = job_id if job_id is not None else str(item.get("job_id", ""))
    warnings: list[str] = []

    def outcome(route: str, key: str | None, label: str, reason: str = "",
                definition: Mapping[str, Any] | None = None) -> dict[str, Any]:
        group = None
        if route not in {"excluded", "own_pending"}:
            group = {"group_id": "group_" + digest({"job_id": scope, "kind": route, "key": key})[:32],
                     "kind": route, "display_name": label if len(label) <= 256 else label[:255] + "…",
                     "key": key, "manual": False}
            if definition is not None:
                group = {"group_id": definition["group_id"], "kind": route, "display_name": definition["display_name"],
                         "key": definition.get("key", definition.get("group_key")), "manual": True}
        legacy_kind = {"named": "counterparty", "blank": "blank_name", "counterparty_pending": "pending", "own_pending": "pending"}.get(route, route)
        state = "excluded" if route == "excluded" else "special" if route == "special" else "needs_confirmation" if route in {"own_pending", "counterparty_pending"} else "confirmed"
        return {"state": state, "kind": legacy_kind, "group_key": key, "group_label": label,
                "reason": reason, "our_side": our_side, "counterparty_side": counterparty_side,
                "source_bank": source_value, "source_state": source_state, "parties": parties,
                "special_type": special, "special_confirmed": special_confirmed,
                "own_decision": own_decision, "route": route, "group": group, "counterparty": counterparty,
                "decision_method": "manual" if definition is not None else "automatic" if route not in {"excluded", "own_pending", "counterparty_pending"} else "none",
                "field_overrides": overrides, "warnings": list(dict.fromkeys([*warnings, *reasons, *([reason] if reason else [])]))}

    if item.get("excluded") is True or item.get("review_status") == "excluded":
        return outcome("excluded", None, "已排除", "excluded_by_review")
    if special and special_confirmed:
        from .receipt_group_labels import document_type_label
        return outcome("special", _group_key("special", special), document_type_label(special))

    hard_conflicts = {"source_bank_mismatch", "own_company_mismatch",
                      "own_account_mismatch", "both_sides_match_our_account", "own_side_conflict"}
    if len(name_matches) == 2:
        hard_conflicts.discard("both_sides_match_our_account")
    if hard_conflicts.intersection(reasons):
        # Keep the whole batch usable, but never guess an output counterparty
        # from contradictory evidence. This group can be explicitly included.
        return outcome("counterparty_pending", "counterparty_pending", "对手待确认", "batch_identity_conflict")

    counterparty_name, counterparty_account, counterparty_bank = (counterparty[key] for key in PARTY_FIELDS)
    if _field_present(counterparty_name) and normalize_text(counterparty_name["normalized"]) == company_name:
        return outcome("internal", _group_key("internal", company_name), company_name)

    assignment = manual.get("assignment")
    if assignment is not None:
        if not isinstance(assignment, Mapping) or set(assignment) != {"group_id", "reason"}:
            raise GroupingValidationError("人工分组格式无效")
        target_id = _text(assignment["group_id"], "目标分组", limit=256)
        _text(assignment["reason"], "人工分组依据", limit=1000)
        definition = None if groups is None else groups.get(target_id)
        if not isinstance(definition, Mapping) or definition.get("kind") not in {"named", "internal"}:
            raise GroupingValidationError("人工分组必须指向本任务的普通对手或内部账户组")
        label = _text(definition.get("display_name"), "目标组名", limit=256)
        if definition["kind"] == "named":
            return outcome("named", definition.get("key", definition.get("group_key")), label,
                           definition={**definition, "group_id": target_id})
        # Old internal assignments must not recreate per-account groups, nor
        # turn a different company into an internal transfer. Re-derive below.
        warnings.append("legacy_internal_assignment_recomputed")
    assert counterparty is not None
    counterparty_name, counterparty_account, counterparty_bank = (counterparty[key] for key in PARTY_FIELDS)
    service_type = parties.get("service_type")
    unassigned_printed_name = our_side not in PARTY_SIDES and any(
        parties[side]["name"]["state"] in {"present", "ambiguous"} for side in PARTY_SIDES
    )
    if (service_type in GROUPING_SERVICE_TYPES and not special
            and counterparty_name["state"] in {"missing", "blank"}
            and not unassigned_printed_name
            and not any(change["field"] == "name" and change["side"] in {"counterparty", counterparty_side}
                        for change in overrides)):
        from .receipt_group_labels import document_type_label
        # This is a grouping destination only. The reviewed document type,
        # original fields, exclusions and crop remain exactly as supplied.
        return outcome("special", _group_key("special", service_type), document_type_label(service_type))
    if _field_blank(counterparty_name):
        return outcome("blank", "blank", "对方名称为空")
    if not _field_present(counterparty_name):
        reason = "counterparty_name_ambiguous" if counterparty_name["state"] == "ambiguous" else "counterparty_name_missing"
        return outcome("counterparty_pending", "counterparty_pending", "对手待确认", reason)
    name = normalize_text(counterparty_name["normalized"])
    return outcome("named", _group_key("counterparty", name), name)


def normalize_basis(value: object) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise GroupingValidationError("分组依据格式无效")
    # Store only JSON data and avoid accepting a caller-controlled digest as
    # the authority.  The store computes basis_digest from this object.
    try:
        checked = json.loads(canonical_json(value))
    except GroupingValidationError:
        raise
    if not isinstance(checked, dict):
        raise GroupingValidationError("分组依据格式无效")
    if len(canonical_json(checked).encode("utf-8")) > MAX_PARTY_BYTES:
        raise GroupingValidationError("分组依据过长")
    return checked


def stable_item_identity(item: Mapping[str, Any]) -> str:
    return _stable_identity(item)


def item_identifier(item: Mapping[str, Any], index: int = 0) -> str:
    return _item_identifier(item, index)


__all__ = [
    "CompanyAccount", "GroupingError", "GroupingValidationError", "AccountValidationError", "GroupingConflict",
    "GroupingNotFound", "GroupingSourceChanged", "GroupingIncomplete", "GroupingSnapshot",
    "MAX_REFRESH_IDS", "MAX_REFRESH_PAGES", "PARTY_FIELDS", "PARTY_SIDES", "canonical_json",
    "derive_grouping_decision", "digest", "item_identifier", "normalize_account", "normalize_bank",
    "normalize_basis", "normalize_parties", "normalize_party_field", "normalize_text", "now_utc",
    "parties_from_item", "stable_item_identity", "validate_account",
]


@dataclass(frozen=True)
class GroupingSnapshot:
    """Typed convenience wrapper around the JSON snapshot returned by the store."""

    task_id: str
    grouping_revision: int
    basis: dict[str, Any]
    account: dict[str, Any] | None
    items: tuple[dict[str, Any], ...] = field(default_factory=tuple)
    groups: tuple[dict[str, Any], ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "grouping_revision": self.grouping_revision,
            "basis": self.basis,
            "account": self.account,
            "items": list(self.items),
            "groups": list(self.groups),
        }
