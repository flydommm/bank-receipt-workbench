"""Small shared vocabulary for task-scoped, per-receipt document decisions."""

from collections.abc import Mapping
from copy import deepcopy
from typing import Any

from .receipt_document_types import DOCUMENT_TYPES


MANUAL_DOCUMENT_TYPES = DOCUMENT_TYPES | frozenset({"ordinary", "other_special"})


def effective_document_type(record: Mapping[str, Any] | None,
                            automatic_type: str | None = None) -> str:
    """A bound manual decision overrides detection for this receipt only."""
    if record is not None and "document_type" in record:
        return record["document_type"]
    return automatic_type if automatic_type in DOCUMENT_TYPES else "ordinary"


def classification_notice(record: Mapping[str, Any] | None,
                          automatic_notice: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
    """Keep automatic evidence intact unless a manual decision overrides it."""
    if record is None or "document_type" not in record:
        return None if automatic_notice is None else deepcopy(dict(automatic_notice))
    kind = effective_document_type(record)
    return None if kind == "ordinary" else {"code": "special_document", "document_type": kind}
