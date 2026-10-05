"""Cross-language public field contract; uses synthetic data only."""

import json
from pathlib import Path

from engine.receipt_grouping_api import _public_field


FIXTURE = Path(__file__).parents[1] / "src" / "services" / "fixtures" / "groupingFieldCandidates.json"


def load_fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_python_public_field_matches_typescript_fixture_and_is_idempotent():
    fixture = load_fixture()
    actual = {name: _public_field(value) for name, value in fixture["input"].items()}

    assert actual == fixture["public_output"]
    assert _public_field(actual["ordinary"]) == actual["ordinary"]
    assert _public_field(actual["ambiguous"]) == actual["ambiguous"]

    candidates = actual["ambiguous"]["candidates"]
    assert len(candidates) == 2
    assert all(set(candidate) == {"raw", "value", "state", "evidence"} for candidate in candidates)
    serialized = json.dumps(actual, ensure_ascii=False)
    for secret in ("candidate-reader-trace-secret", "candidate-trace-secret", "ordinary-reader-trace"):
        assert secret not in serialized


def test_python_candidate_projection_keeps_legacy_evidence_and_normalized_fallback():
    fixture = load_fixture()
    result = _public_field(fixture["input"]["ambiguous"])

    assert result["value"] == "字段备用值"
    assert result["evidence"][0]["label"] == "对方名称"
    assert result["candidates"][0]["value"] == "候选甲规范值"
    assert result["candidates"][1]["value"] == "候选乙显式值"
    assert result["candidates"][0]["evidence"][0]["rect"] == {
        "x0": 25,
        "y0": 54,
        "x1": 125,
        "y1": 68,
    }
