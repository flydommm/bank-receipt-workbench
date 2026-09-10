"""Immutable backend assembly parity and completeness, using synthetic pages."""

from copy import deepcopy
import json
from pathlib import Path

import pytest

from engine.batch_results import BatchAssemblyError, assemble_batch_results


SHA = "a" * 64
CRITERIA = {"include": ["fee"], "includeMode": "all", "exclude": []}


def source(index=0, *, count=1, sha=SHA):
    path = f"/documents/source-{index}.pdf"
    return {"source_id": f"s{index}", "position": index, "source_key": path,
            "initial_path": path, "access_path": path, "name": f"source-{index}.pdf",
            "sha256": sha, "page_count": count, "size_bytes": 1234}


def hit(page=1, *, query_id=None, role=None, y=30, confidence=0.98):
    value = {"page": page, "matched_text": "fee text", "matched_field": None,
             "confidence": confidence, "x0": 20, "y0": y, "x1": 120, "y1": y + 10}
    if query_id is not None:
        value.update(query_id=query_id, role=role)
    return value


def selection(match, *, index=0, top=0, bottom=300, confidence=0.96):
    rect = {"x0": 0, "y0": top, "x1": 600, "y1": bottom}
    return {"match_rect": {key: match[key] for key in ("x0", "y0", "x1", "y1")},
            "rect": deepcopy(rect), "candidate_index": index, "candidate_rect": rect,
            "confidence": confidence, "slot": "top", "evidence": ["synthetic"],
            "needs_review": confidence < 0.9, "snap_points": [0, bottom, 800]}


def page_result(source_id="s0", *, number=1, matches=None, selections=None, full=False):
    matches = [hit(number)] if matches is None else matches
    selected = deepcopy(selections) if selections is not None else [selection(item) for item in matches]
    if full:
        for item in selected:
            if item["rect"] is not None:
                item["rect"] = {"x0": 0, "y0": 0, "x1": 600, "y1": 800}
    analysis = None if not matches else {
        "status": "ok", "page": number, "page_width": 600, "page_height": 800,
        "page_fully_matched": full,
        "selections": selected,
    }
    return {"source_id": source_id, "payload": {
        "schema": 1, "page": number, "page_width": 600, "page_height": 800,
        "matches": matches, "analysis": analysis,
    }}


def assemble(sources=None, pages=None, criteria=None):
    return assemble_batch_results("job-test", sources or [source()], criteria or CRITERIA,
                                  "exact", "batch-assembly-v1", pages or [page_result()])


def test_legacy_keeps_per_match_order_full_page_and_selection_confidence():
    matches = [hit(y=30, confidence=0.72), hit(y=50)]
    selections = [selection(matches[0], confidence=0.96), selection(matches[1], confidence=0.73)]
    result = assemble(pages=[page_result(matches=matches, selections=selections, full=True)])
    segments = [item["segment"] for item in result["items"]]
    assert [item["segment_no"] for item in segments] == [1, 2]
    assert [item["confidence"] for item in segments] == [0.96, 0.73]
    assert [item["review_status"] for item in segments] == ["confirmed", "needs_review"]
    assert all(item["crop_mode"] == "full_page" and item["final_rect"] is None for item in segments)
    assert all(item["auto_full_page"] for item in result["originals"])
    assert segments[0]["layout_fingerprint"] == "geometry:600x800:unknown,unknown,600,800"
    assert len(result["items"][0]["evidence"]) == 1


def test_multi_all_filters_per_candidate_and_keeps_all_evidence():
    criteria = {"include": ["fee", "bank"], "includeMode": "all", "exclude": ["refund"]}
    tags = [("include-0", "include", 0), ("include-0", "include", 0),
            ("include-1", "include", 0), ("include-0", "include", 1),
            ("include-1", "include", 1), ("exclude-0", "exclude", 1),
            ("include-0", "include", 2)]
    matches = [hit(query_id=q, role=r, y=candidate * 200 + 20 + n * 10) for n, (q, r, candidate) in enumerate(tags)]
    selections = [selection(item, index=index, top=index * 200, bottom=(index + 1) * 200)
                  for item, (_, _, index) in zip(matches, tags)]
    selections[2]["confidence"] = 0.73
    selections[2]["needs_review"] = True
    result = assemble(criteria=criteria, pages=[page_result(matches=matches, selections=selections, full=True)])
    assert len(result["items"]) == 1
    item = result["items"][0]
    assert item["segment"]["crop_mode"] == "candidate"
    assert item["segment"]["confidence"] == 0.73
    assert item["segment"]["review_status"] == "needs_review"
    assert len(item["evidence"]) == 3  # Duplicate query evidence is not discarded.
    assert not item["original"]["auto_full_page"]


def test_multi_any_sorts_candidate_indices_and_uses_first_include_representative():
    criteria = {"include": ["fee"], "includeMode": "any", "exclude": []}
    matches = [hit(query_id="include-0", role="include", y=430),
               hit(query_id="include-0", role="include", y=30)]
    selections = [selection(matches[0], index=2, top=400, bottom=600),
                  selection(matches[1], index=0, top=0, bottom=200)]
    result = assemble(criteria=criteria, pages=[page_result(matches=matches, selections=selections)])
    assert [item["segment"]["match_rect"]["y0"] for item in result["items"]] == [30, 430]
    assert [item["segment"]["segment_no"] for item in result["items"]] == [1, 2]


def test_same_sha_sources_are_independent_and_ids_follow_global_collision_rule():
    result = assemble(sources=[source(0), source(1)], pages=[page_result("s1"), page_result("s0")])
    assert [item["segment"]["id"] for item in result["items"]] == [
        f"job-test:{SHA}:1:1", f"job-test:{SHA}:1:1:source-2"]
    assert [item["source_key"] for item in result["originals"]] == [
        "/documents/source-0.pdf", "/documents/source-1.pdf"]


def test_missing_zero_hit_page_duplicate_page_and_unknown_source_are_rejected():
    with pytest.raises(BatchAssemblyError):
        assemble(sources=[source(count=2)], pages=[page_result()])
    with pytest.raises(BatchAssemblyError):
        assemble(pages=[page_result(), page_result()])
    with pytest.raises(BatchAssemblyError):
        assemble(pages=[page_result("unknown")])
    result = assemble(sources=[source(count=2)], pages=[page_result(), page_result(number=2, matches=[])])
    assert len(result["items"]) == 1


def test_zero_results_have_valid_complete_context_and_empty_manifest():
    result = assemble(pages=[page_result(matches=[])])
    assert result["items"] == result["originals"] == []
    assert len(result["context"]["sources"]) == 1
    assert len(result["context"]["criteria_fingerprint"]) == 64


def test_alias_keeps_logical_identity_and_signature_without_merging_sources():
    before = assemble()
    moved = source()
    moved["access_path"] = "/relocated/same-content.pdf"
    after = assemble(sources=[moved])
    assert after["context"]["sources"][0]["source_key"] == source()["source_key"]
    assert after["context"]["sources"][0]["source_path"] == moved["access_path"]
    assert before["originals"] == after["originals"]


def test_mutating_input_or_returned_items_cannot_change_separate_originals():
    data = page_result()
    result = assemble(pages=[data])
    original = deepcopy(result["originals"][0])
    data["payload"]["matches"][0]["matched_text"] = "changed"
    result["items"][0]["segment"]["candidate_rect"]["y1"] = 700
    result["items"][0]["original"]["candidate_rect"]["y1"] = 600
    assert result["originals"][0] == original
    assert result["items"][0]["evidence"][0]["matched_text"] == "fee text"


def test_candidate_geometry_disagreement_and_unknown_tags_cannot_publish():
    criteria = {"include": ["fee"], "includeMode": "any", "exclude": []}
    matches = [hit(query_id="include-0", role="include"), hit(query_id="include-0", role="include", y=50)]
    selections = [selection(matches[0]), selection(matches[1], bottom=301)]
    with pytest.raises(BatchAssemblyError):
        assemble(criteria=criteria, pages=[page_result(matches=matches, selections=selections)])
    matches[1]["query_id"] = "not-registered"
    with pytest.raises(BatchAssemblyError):
        assemble(criteria=criteria, pages=[page_result(matches=matches)])


def test_raw_analysis_cannot_claim_another_source_sha():
    raw = page_result()
    raw["payload"]["analysis"]["source_sha256"] = "b" * 64
    with pytest.raises(BatchAssemblyError, match="SHA"):
        assemble(pages=[raw])


def test_optional_analysis_sha_accepts_equivalent_uppercase_hex():
    raw = page_result()
    raw["payload"]["analysis"]["source_sha256"] = "A" * 64
    assert assemble(pages=[raw])["items"]


def test_illegal_crop_stays_blocked_and_signatures_cover_original_evidence():
    before = page_result()
    before["payload"]["analysis"]["selections"][0].update(
        rect=None, candidate_rect=None, candidate_index=None, confidence=0, slot=None, evidence=[], needs_review=True,
    )
    result = assemble(pages=[before])
    assert result["items"][0]["segment"]["review_status"] == "blocked"
    assert result["originals"][0]["candidate_rect"] is None
    altered = deepcopy(before)
    altered["payload"]["matches"][0]["matched_text"] = "new fee text"
    second = assemble(pages=[altered])
    assert result["originals"][0]["analysis_signature"] != second["originals"][0]["analysis_signature"]


def test_signature_binds_original_layout_evidence_even_in_full_page_mode():
    first = page_result(full=True)
    second = deepcopy(first)
    second["payload"]["analysis"]["selections"][0]["candidate_rect"]["y1"] = 350
    second["payload"]["analysis"]["selections"][0]["evidence"].append("additional layout anchor")
    before, after = assemble(pages=[first]), assemble(pages=[second])
    assert before["items"][0]["segment"] == after["items"][0]["segment"]
    assert before["originals"][0]["analysis_signature"] != after["originals"][0]["analysis_signature"]


_REFERENCE = json.loads((Path(__file__).parent / "fixtures" / "batch_assembly_m2_reference.json").read_text(encoding="utf-8"))
_FRONTEND_FIELDS = {
    "id": "id", "source_path": "sourcePath", "source_sha256": "sourceSha256",
    "source_page": "sourcePage", "segment_no": "segmentNo", "match_rect": "matchRect",
    "candidate_rect": "candidateRect", "final_rect": "finalRect", "page_width": "pageWidth",
    "page_height": "pageHeight", "confidence": "confidence", "slot": "slot", "snap_points": "snapPoints",
    "layout_fingerprint": "layoutFingerprint", "crop_mode": "mode", "review_status": "reviewStatus",
    "manual_adjusted": "manualAdjusted",
}


@pytest.mark.parametrize("fixture", _REFERENCE["fixtures"], ids=lambda item: item["name"])
def test_backend_assembly_matches_executed_m2_frontend_reference(fixture):
    result = assemble_batch_results("job-test", fixture["sources"], fixture["criteria"],
                                    fixture["match_mode"], "batch-assembly-v1", fixture["pages"])
    segments = [{target: item["segment"][key] for key, target in _FRONTEND_FIELDS.items()} for item in result["items"]]
    assert segments == fixture["expected_segments"]
    assert {item["segment"]["id"]: item["evidence"] for item in result["items"]} == fixture["expected_evidence"]
