"""Saved geometry and current positive/negative identity evidence stay separate."""
from copy import deepcopy
from dataclasses import replace
from pathlib import Path

import pymupdf
import pytest

from engine.batch_pdf import BatchPdfSource
from engine.receipt_layout import LAYOUT_EVIDENCE_VERSION, refresh_saved_layout_identity, suggest_layout
from engine.receipt_layout_review import _incompatibility
from engine.search import SearchBudget
from tests.test_receipt_layout import evidence, SHA
from tests.test_receipt_document_types import evidence as special_evidence, page, block


VISUAL = {"kind": "visible_form_v1", "issuer_id": "visual-" + "a" * 64,
          "family_id": "b" * 64, "evidence_version": "receipt-visual-v1.p300.p3300.p6300"}
ALL = {"processing_mode": "split_all", "criteria": None}


def visual_evidence(bank="c", *, partial=False):
    value = evidence(bank=bank)
    descriptor = deepcopy(value.descriptor)
    descriptor["layout_compatibility"] = VISUAL
    if partial:
        descriptor["receipts"][1]["template_fingerprint"] = None
    return replace(value, descriptor=descriptor)


@pytest.mark.parametrize("partial", [False, True])
def test_native_issuer_survives_common_bitmap_even_with_partial_form_fingerprint(partial):
    first = suggest_layout(visual_evidence("c", partial=partial)).layout_definition
    second = suggest_layout(visual_evidence("d", partial=partial)).layout_definition
    assert first["issuer_id"] == "c" * 64
    assert second["issuer_id"] == "d" * 64
    assert first["family_id"] == second["family_id"] == VISUAL["family_id"]
    assert _incompatibility(first, second, False) == "different_issuer"


def test_conflicting_native_issuers_disable_anonymous_cross_source_identity():
    value = visual_evidence(partial=True)
    value.descriptor["receipts"][1]["issuer_bank_key"] = "d" * 64
    conflicted = suggest_layout(value).layout_definition
    ordinary = suggest_layout(visual_evidence()).layout_definition
    assert conflicted["issuer_id"] is None
    assert conflicted["family_id"] is None
    assert not conflicted["evidence_version"].startswith("receipt-visual-")
    assert _incompatibility(ordinary, conflicted, False) == "unverified_layout"


def test_old_saved_geometry_gets_current_identity_and_can_join_current_cross_pdf_scope():
    current = visual_evidence()
    current_layout = suggest_layout(current).layout_definition
    saved = deepcopy(current_layout)
    saved.update(issuer_id=None, family_id=None, evidence_version="receipt-layout-evidence-v1",
                 layout_id="old-saved-layout", revision=7, left_pt=5.0, right_pt=6.0)
    for slot in saved["slots"]:
        slot["height_pt"] = 260
    before = deepcopy(saved)
    with pymupdf.open() as document:
        document.new_page(width=600, height=900)
        source = BatchPdfSource(Path("unused-private-copy.pdf"), SHA, 0, 1, document)
        source._receipt_evidence[1] = current
        computation = source.compute_receipt_page(1, ALL, "exact", SearchBudget(),
                                                 reused_layout_definition=saved, allow_ocr=False)
    restored = computation.result["layout_definition"]
    assert saved == before
    for key in saved:
        if key not in {"issuer_id", "family_id", "evidence_version"}:
            assert restored[key] == saved[key]
    assert restored["issuer_id"] == current_layout["issuer_id"]
    assert restored["family_id"] == current_layout["family_id"]
    assert restored["evidence_version"] == current_layout["evidence_version"]
    assert _incompatibility(restored, current_layout, False) is None
    assert computation.suggestion.basis == "manual_layout"


def test_old_saved_special_geometry_refresh_keeps_special_notice_and_isolation():
    current = special_evidence(page(block("贷款利息到期通知书", 60), block("body", 180)))
    saved = suggest_layout(current).layout_definition
    saved.update(issuer_id=None, family_id=None, left_pt=10, right_pt=10)
    with pymupdf.open() as document:
        document.new_page(width=600, height=900)
        source = BatchPdfSource(Path("unused-private-copy.pdf"), SHA, 0, 1, document)
        source._receipt_evidence[1] = current
        result = source.compute_receipt_page(1, ALL, "exact", SearchBudget(),
                                             reused_layout_definition=saved, allow_ocr=False)
    restored = result.result["layout_definition"]
    assert restored["family_id"] is not None
    assert restored["slots"] == saved["slots"]
    assert restored["left_pt"] == restored["right_pt"] == 10
    assert result.diagnostics == ({"code": "special_document", "document_type": "loan_interest_notice"},)


def test_identity_refresh_does_not_keep_obsolete_proof_when_current_evidence_is_unknown():
    current = evidence()
    saved = suggest_layout(current).layout_definition
    refreshed = refresh_saved_layout_identity(saved, replace(current, descriptor={}))
    assert refreshed["issuer_id"] is None and refreshed["family_id"] is None
    assert refreshed["slots"] == saved["slots"]


@pytest.mark.parametrize("slot_mismatch", ["extra_saved_slot", "reversed_ids", "custom_ids"])
@pytest.mark.parametrize("native_proof", ["complete", "partial", "absent"])
def test_refresh_without_one_to_one_visual_slots_retains_geometry_and_native_evidence(slot_mismatch, native_proof):
    current = evidence(("alpha", "beta") if slot_mismatch == "extra_saved_slot" else ("alpha", "beta", "gamma"))
    descriptor = deepcopy(current.descriptor)
    if native_proof == "partial":
        descriptor["receipts"][1]["template_fingerprint"] = None
    elif native_proof == "absent":
        for receipt in descriptor["receipts"]:
            receipt.update(issuer_bank_key=None, template_fingerprint=None)
    fallback = suggest_layout(replace(current, descriptor=descriptor)).layout_definition
    descriptor["layout_compatibility"] = {
        **VISUAL, "evidence_version": "receipt-visual-v1.p300.p3300"
        if slot_mismatch == "extra_saved_slot" else VISUAL["evidence_version"],
    }
    current = replace(current, descriptor=descriptor)
    saved = suggest_layout(evidence()).layout_definition
    saved.update(layout_id="old-saved-layout", revision=7, left_pt=5.0, right_pt=6.0)
    for index, slot in enumerate(saved["slots"]):
        slot["height_pt"] = 260
        if slot_mismatch == "reversed_ids":
            slot["slot_id"] = f"slot-{3 - index}"
        elif slot_mismatch == "custom_ids":
            slot["slot_id"] = f"saved-{index + 1}"
    before = deepcopy(saved)

    refreshed = refresh_saved_layout_identity(saved, current)

    assert saved == before
    for key in saved:
        if key not in {"issuer_id", "family_id", "evidence_version"}:
            assert refreshed[key] == saved[key]
    assert refreshed["evidence_version"] == LAYOUT_EVIDENCE_VERSION
    assert refreshed["issuer_id"] == fallback["issuer_id"]
    assert refreshed["family_id"] == fallback["family_id"]
    assert _incompatibility(refreshed, refreshed, True) is None
    if native_proof != "complete":
        assert refreshed["family_id"] is None
        assert _incompatibility(refreshed, refreshed, False) == "unverified_layout"
