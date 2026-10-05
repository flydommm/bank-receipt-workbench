"""Resolve observed own/counterparty roles without inventing payment direction."""
from __future__ import annotations

from copy import deepcopy
import re
from typing import Any, Mapping, Sequence
import unicodedata

from .receipt_field_candidates import FIELDS, empty_field, merge_field_candidates


def _key(value: object) -> str:
    return "".join(unicodedata.normalize("NFKC", str(value or "")).split())


def observed_identity_conflicts(own: Mapping[str, Any] | None,
                                company_name: str, account_number: str) -> list[str]:
    if not own:
        return []
    reasons = []
    name, account = own.get("name", {}), own.get("account", {})
    if name.get("state") == "present" and _key(name.get("value")) != _key(company_name):
        reasons.append("own_company_mismatch")
    number = _key(account.get("value"))
    if account.get("state") == "present" and re.fullmatch(r"[0-9]+", number) and number != _key(account_number):
        reasons.append("own_account_mismatch")
    return reasons


def combine_counterparty_observation(current: Mapping[str, Any], observed: Mapping[str, Any] | None,
                                    protected_fields: Sequence[str] = ()) -> dict[str, Any]:
    result = deepcopy(dict(current))
    if observed is None:
        return result
    for field in FIELDS:
        if field in protected_fields:
            continue
        old, new = result.get(field, empty_field()), observed.get(field, empty_field())
        if new.get("state") == "missing":
            continue
        if old.get("state") == "missing":
            result[field] = deepcopy(new)
        elif old.get("state") == new.get("state") and _key(old.get("value")) == _key(new.get("value")):
            # Preserve the legacy field/evidence exactly when both agree.
            continue
        else:
            result[field] = merge_field_candidates(field, [old, new])
    return result
