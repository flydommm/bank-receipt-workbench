from __future__ import annotations

from copy import deepcopy

import pytest

from engine.export_plan import build_output_plan


PROCESSED_AT = "2026-09-08T08:00:00Z"
SOURCES = [
    {
        "source_key": "source-a",
        "name": r"C:\incoming\Statement A.pdf",
        "source_path": r"C:\incoming\Statement A.pdf",
        "source_sha256": "a" * 64,
    },
    {
        "source_key": "source-b",
        "name": "/incoming/statement a.pdf",
        "source_path": "/incoming/statement a.pdf",
        "source_sha256": "b" * 64,
    },
]
CRITERIA = {"include": ["示例实业", "华夏银行"], "exclude": ["退款"]}


def _record(
    segment_id: str,
    source_key: str,
    source_page: int,
    segment_no: int,
    *,
    crop_mode: str = "candidate",
    final_rect: dict[str, float] | None = None,
    status: str = "confirmed",
    width: float = 600,
    height: float = 800,
) -> dict[str, object]:
    source = next(item for item in SOURCES if item["source_key"] == source_key)
    return {
        "id": segment_id,
        "task_id": "task-1",
        "source_path": source["source_path"],
        "source_sha256": source["source_sha256"],
        "source_key": source_key,
        "source_page": source_page,
        "segment_no": segment_no,
        "match_rect": {"x0": 10, "y0": 20, "x1": 100, "y1": 120},
        "candidate_rect": final_rect,
        "final_rect": final_rect,
        "page_width": width,
        "page_height": height,
        "layout_fingerprint": "geometry:test",
        "confidence": 0.98,
        "crop_mode": crop_mode,
        "review_status": status,
        "manual_adjusted": False,
        "reviewed_at": PROCESSED_AT,
    }


def test_build_output_plan_deduplicates_full_pages_and_maps_all_three_modes() -> None:
    records = [
        _record("b-crop", "source-b", 1, 2, final_rect={"x0": 20, "y0": 30, "x1": 200, "y1": 240}),
        _record("a-full-2", "source-a", 2, 2, crop_mode="full_page", final_rect=None),
        _record("a-full-1", "source-a", 2, 1, crop_mode="full_page", final_rect=None),
        _record("a-crop", "source-a", 1, 1, final_rect={"x0": 0, "y0": 30, "x1": 200, "y1": 240}),
    ]
    evidence = {
        "a-crop": [
            {"query_id": "include-0", "role": "include", "matched_field": "交易对手", "matched_text": "示例实业"},
            {"query_id": "include-0", "role": "include", "matched_field": "交易对手", "matched_text": "示例实业"},
            {"query_id": "exclude-0", "role": "exclude", "matched_field": "摘要", "matched_text": "退款"},
            {"query_id": "include-1", "role": "include", "matched_field": "开户行", "matched_text": "华夏银行"},
        ],
        "a-full-1": [{"role": "include", "matched_field": "整页", "matched_text": "整页证据"}],
    }

    plan = build_output_plan(SOURCES, records, evidence, CRITERIA, "both", PROCESSED_AT)

    assert [item["file_id"] for item in plan["files"]] == ["merged", "source-001", "source-002"]
    assert [item["name"] for item in plan["files"]] == [
        "全部匹配结果.pdf",
        "001__Statement A__匹配结果.pdf",
        "002__statement a__匹配结果.pdf",
    ]
    assert plan["files"][0]["page_count"] == 3
    assert plan["files"][1]["page_count"] == 2
    assert plan["files"][2]["page_count"] == 1
    assert plan["merged_pages"] == 3
    assert plan["source_pages"] == 3
    assert plan["total_pages"] == 6

    merged_pages = plan["files"][0]["pages"]
    assert [(item["source_key"], item["source_page"], item["segment_no"]) for item in merged_pages] == [
        ("source-a", 1, 1),
        ("source-a", 2, 1),
        ("source-b", 1, 2),
    ]
    assert merged_pages[1]["keep_full_page"] is True
    assert merged_pages[1]["rect"] is None
    assert merged_pages[1]["segment_ids"] == ["a-full-1", "a-full-2"]
    assert len(plan["mappings"]) == 8
    assert {row["segment_id"] for row in plan["mappings"]} == {"a-crop", "a-full-1", "a-full-2", "b-crop"}
    assert plan["index_rows"] == [
        {
            "source_file": r"C:\incoming\Statement A.pdf",
            "source_sha256": "a" * 64,
            "source_page": 1,
            "segment_no": 1,
            "query": "示例实业、华夏银行",
            "matched_field": "交易对手、开户行",
            "crop_mode": "candidate",
            "review_status": "confirmed",
            "confidence": 0.98,
            "output_file": "全部匹配结果.pdf",
            "processed_at": PROCESSED_AT,
            "matched_keywords": "示例实业、华夏银行",
            "matched_text": "示例实业、华夏银行",
            "crop_x0": 0,
            "crop_y0": 30,
            "crop_x1": 200,
            "crop_y1": 240,
        },
        {
            "source_file": r"C:\incoming\Statement A.pdf",
            "source_sha256": "a" * 64,
            "source_page": 2,
            "segment_no": 1,
            "query": "示例实业、华夏银行",
            "matched_field": "整页",
            "crop_mode": "full_page",
            "review_status": "confirmed",
            "confidence": 0.98,
            "output_file": "全部匹配结果.pdf",
            "processed_at": PROCESSED_AT,
            "matched_keywords": "",
            "matched_text": "整页证据",
            "crop_x0": 0,
            "crop_y0": 0,
            "crop_x1": 600,
            "crop_y1": 800,
        },
        {
            "source_file": r"C:\incoming\Statement A.pdf",
            "source_sha256": "a" * 64,
            "source_page": 2,
            "segment_no": 2,
            "query": "示例实业、华夏银行",
            "matched_field": "",
            "crop_mode": "full_page",
            "review_status": "confirmed",
            "confidence": 0.98,
            "output_file": "全部匹配结果.pdf",
            "processed_at": PROCESSED_AT,
            "matched_keywords": "",
            "matched_text": "",
            "crop_x0": 0,
            "crop_y0": 0,
            "crop_x1": 600,
            "crop_y1": 800,
        },
    ] + [
        {
            "source_file": r"/incoming/statement a.pdf",
            "source_sha256": "b" * 64,
            "source_page": 1,
            "segment_no": 2,
            "query": "示例实业、华夏银行",
            "matched_field": "",
            "crop_mode": "candidate",
            "review_status": "confirmed",
            "confidence": 0.98,
            "output_file": "全部匹配结果.pdf",
            "processed_at": PROCESSED_AT,
            "matched_keywords": "",
            "matched_text": "",
            "crop_x0": 20,
            "crop_y0": 30,
            "crop_x1": 200,
            "crop_y1": 240,
        },
    ]


@pytest.mark.parametrize(
    "output_mode, expected_file_count, expected_total_pages",
    [("merged", 1, 7), ("by_source", 2, 7), ("both", 3, 14)],
)
def test_identical_non_full_rects_share_pages_but_keep_audit_mappings(
    output_mode: str,
    expected_file_count: int,
    expected_total_pages: int,
) -> None:
    rect = {"x0": 20, "y0": 30, "x1": 200, "y1": 240}
    records = [
        _record("a-candidate", "source-a", 1, 1, final_rect=rect),
        _record("a-manual", "source-a", 1, 2, crop_mode="manual", final_rect=dict(rect)),
        _record("a-adjacent", "source-a", 1, 3, final_rect={"x0": 200, "y0": 30, "x1": 300, "y1": 240}),
        _record("a-overlap", "source-a", 1, 4, final_rect={"x0": 100, "y0": 30, "x1": 220, "y1": 240}),
        _record("a-slight", "source-a", 1, 5, final_rect={"x0": 20.000001, "y0": 30, "x1": 200, "y1": 240}),
        _record("a-full", "source-a", 1, 6, crop_mode="full_page", final_rect=None),
        _record("a-other-page", "source-a", 2, 1, final_rect=dict(rect)),
        _record("b-same-rect", "source-b", 1, 1, final_rect=dict(rect)),
    ]
    original_records = deepcopy(records)

    plan = build_output_plan(SOURCES, records, {}, {"include": []}, output_mode, PROCESSED_AT)

    assert len(plan["files"]) == expected_file_count
    assert plan["total_pages"] == expected_total_pages
    assert plan["merged_pages"] == (7 if output_mode in {"merged", "both"} else 0)
    assert plan["source_pages"] == (7 if output_mode in {"by_source", "both"} else 0)
    assert len(plan["index_rows"]) == len(records)
    assert {
        (row["source_file"], row["source_page"], row["segment_no"])
        for row in plan["index_rows"]
    } == {
        (SOURCES[0]["name"], record["source_page"], record["segment_no"])
        if record["source_key"] == "source-a"
        else (SOURCES[1]["name"], record["source_page"], record["segment_no"])
        for record in records
    }
    assert records == original_records

    merged_file = next((item for item in plan["files"] if item["file_id"] == "merged"), None)
    if merged_file is not None:
        assert merged_file["page_count"] == 7
        merged_pages = merged_file["pages"]
        assert merged_pages[0]["segment_ids"] == ["a-candidate", "a-manual"]
        assert merged_pages[0]["rect"] == rect
        assert merged_pages[1]["segment_ids"] == ["a-adjacent"]
        assert merged_pages[2]["segment_ids"] == ["a-overlap"]
        assert merged_pages[3]["segment_ids"] == ["a-slight"]
        assert merged_pages[4]["segment_ids"] == ["a-full"]
        assert merged_pages[4]["keep_full_page"] is True
        assert merged_pages[5]["segment_ids"] == ["a-other-page"]
        assert merged_pages[6]["segment_ids"] == ["b-same-rect"]

    assert len(plan["mappings"]) == len(records) * (2 if output_mode == "both" else 1)
    for file_item in plan["files"]:
        file_mappings = [row for row in plan["mappings"] if row["output_file"] == file_item["name"]]
        ids_to_pages = {row["segment_id"]: row["output_page"] for row in file_mappings}
        expected_ids = {
            segment_id
            for page in file_item["pages"]
            for segment_id in page["segment_ids"]
        }
        assert set(ids_to_pages) == expected_ids
        if {"a-candidate", "a-manual"} <= expected_ids:
            assert ids_to_pages["a-candidate"] == ids_to_pages["a-manual"]
            assert ids_to_pages["a-candidate"] != ids_to_pages["a-adjacent"]
            assert ids_to_pages["a-candidate"] != ids_to_pages["a-overlap"]
            assert ids_to_pages["a-candidate"] != ids_to_pages["a-slight"]


def test_build_output_plan_by_source_omits_unselected_sources_and_empty_outputs() -> None:
    record = _record("a", "source-a", 3, 1, final_rect={"x0": 1, "y0": 2, "x1": 100, "y1": 120})
    by_source = build_output_plan(SOURCES, [record], {}, {"include": ["单词"]}, "by_source", PROCESSED_AT)
    assert [item["file_id"] for item in by_source["files"]] == ["source-001"]
    assert by_source["files"][0]["source_key"] == "source-a"
    assert by_source["index_rows"][0]["output_file"] == "001__Statement A__匹配结果.pdf"
    assert by_source["merged_pages"] == 0
    assert by_source["source_pages"] == 1
    assert by_source["total_pages"] == 1

    empty = build_output_plan(SOURCES, [], {}, {"include": []}, "both", PROCESSED_AT)
    assert empty["files"] == []
    assert empty["mappings"] == []
    assert empty["merged_pages"] == empty["source_pages"] == empty["total_pages"] == 0


@pytest.mark.parametrize("output_mode", ["merged", "by_source", "both"])
def test_custom_name_budget_truncates_long_source_stems_in_every_mode(output_mode: str) -> None:
    long_name = "名" * 120
    source = {**SOURCES[0], "name": f"{'源' * 120}.pdf"}
    record = _record("long-name", "source-a", 1, 1, final_rect={"x0": 1, "y0": 2, "x1": 100, "y1": 120})

    plan = build_output_plan(
        [source], [record], {}, {"include": ["词"]}, output_mode, PROCESSED_AT,
        output_name=f"{long_name}.pdf.pdf",
    )

    assert plan["output_name"] == long_name
    assert all(len(item["name"].encode("utf-16-le")) // 2 <= 240 for item in plan["files"])
    assert all(item["name"].endswith(".pdf") for item in plan["files"])
    if output_mode != "by_source":
        assert plan["files"][0]["name"] == f"{long_name}.pdf"
    if output_mode != "merged":
        source_file = next(item for item in plan["files"] if item["file_id"] == "source-001")
        assert source_file["name"].startswith(f"{long_name}_001__")
        assert source_file["name"].endswith("__匹配结果.pdf")


@pytest.mark.parametrize("output_name", ["结果 .pdf", "结果..pdf", "结果 ", "结果."])
def test_custom_name_rejects_trailing_dot_or_space_after_extension_normalization(output_name: str) -> None:
    record = _record("invalid-name", "source-a", 1, 1, final_rect={"x0": 1, "y0": 2, "x1": 100, "y1": 120})
    with pytest.raises(ValueError):
        build_output_plan(SOURCES, [record], {}, {"include": ["词"]}, "merged", PROCESSED_AT, output_name=output_name)


def test_build_output_plan_sanitizes_names_and_rejects_identity_errors() -> None:
    source = {
        "source_key": "reserved",
        "name": r"C:\folder\CON:bad*name?.pdf...",
        "source_path": r"C:\folder\CON:bad*name?.pdf...",
        "source_sha256": "c" * 64,
    }
    record = {
        **_record("reserved-id", "source-a", 1, 1, final_rect={"x0": 1, "y0": 2, "x1": 100, "y1": 120}),
        "source_key": "reserved",
        "source_path": source["source_path"],
        "source_sha256": source["source_sha256"],
    }
    long_source = {**source, "name": "\x00" + "x" * 200 + ".pdf"}
    plan = build_output_plan([long_source], [record], {"reserved-id": []}, {"include": ["词"]}, "by_source", PROCESSED_AT)
    output_name = plan["files"][0]["name"]
    assert output_name.startswith("001__") and output_name.endswith("__匹配结果.pdf")
    output_stem = output_name[len("001__") : -len("__匹配结果.pdf")]
    assert "?" not in output_stem and "*" not in output_stem and "\x00" not in output_stem
    assert len(output_stem.encode("utf-16-le")) // 2 <= 120

    reserved_source = {**source, "name": "CON.pdf"}
    reserved_record = {**record, "source_path": reserved_source["source_path"], "source_sha256": reserved_source["source_sha256"]}
    reserved_plan = build_output_plan([reserved_source], [reserved_record], {"reserved-id": []}, {"include": ["词"]}, "by_source", PROCESSED_AT)
    assert reserved_plan["files"][0]["name"] == "001__CON___匹配结果.pdf"

    with pytest.raises(ValueError):
        build_output_plan(SOURCES, [record], {}, {"include": []}, "invalid", PROCESSED_AT)
    with pytest.raises(ValueError):
        valid = _record("duplicate", "source-a", 1, 1, final_rect={"x0": 1, "y0": 2, "x1": 100, "y1": 120})
        build_output_plan(SOURCES, [valid, deepcopy(valid)], {}, {"include": []}, "merged", PROCESSED_AT)
    unknown = {**_record("unknown", "source-a", 1, 1, final_rect={"x0": 1, "y0": 2, "x1": 100, "y1": 120}), "source_key": "missing"}
    with pytest.raises(ValueError):
        build_output_plan(SOURCES, [unknown], {}, {"include": []}, "merged", PROCESSED_AT)


def test_single_include_legacy_evidence_without_query_id_is_exported() -> None:
    record = _record("legacy", "source-a", 1, 1, final_rect={"x0": 1, "y0": 2, "x1": 100, "y1": 120})
    plan = build_output_plan(
        SOURCES,
        [record],
        {"legacy": [{"matched_field": "交易对手", "matched_text": "示例实业"}]},
        {"include": ["示例实业"]},
        "merged",
        PROCESSED_AT,
    )
    assert plan["index_rows"][0]["matched_keywords"] == "示例实业"
    assert plan["index_rows"][0]["matched_field"] == "交易对手"
