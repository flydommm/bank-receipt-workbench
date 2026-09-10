from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from engine.layout import (
    Rect,
    extract_separators,
    extract_frame_anchors,
    extract_visual_anchors,
    infer_receipt_candidates,
    select_candidate_for_match,
)
from engine.pdf_parser import iter_pages


INPUT_DIR = Path(__file__).parents[1] / ".local-data" / "input"
REAL_PDFS = sorted(INPUT_DIR.glob("*.pdf"))


def _extract_visual_anchors(pdf_path: Path, page_number: int):
    """Combine bitmap anchors and closed vector receipt frames for one page."""

    return [
        *extract_visual_anchors(pdf_path, page_number),
        *extract_frame_anchors(pdf_path, page_number),
    ]


@pytest.mark.skipif(not REAL_PDFS, reason="真实样本未放入 .local-data/input")
def test_real_samples_keep_candidate_width_equal_to_pdf_page() -> None:
    input_digests = {
        pdf_path: _file_size_and_sha256(pdf_path) for pdf_path in REAL_PDFS
    }
    checked_pages = 0
    checked_candidates = 0
    framed_candidates = []
    fallback_candidates = []

    for pdf_path in REAL_PDFS:
        for page in iter_pages(pdf_path):
            candidates = infer_receipt_candidates(
                page,
                separators=extract_separators(pdf_path, page.page_number),
                visual_anchors=_extract_visual_anchors(pdf_path, page.page_number),
            )
            checked_pages += 1
            checked_candidates += len(candidates)
            assert candidates, f"未生成候选区域: {pdf_path.name} 第 {page.page_number} 页"
            framed_candidates.extend(
                candidate for candidate in candidates if "frame" in candidate.evidence
            )
            fallback_candidates.extend(
                (candidate, page.width)
                for candidate in candidates
                if "frame" not in candidate.evidence
            )
            assert all(
                0 <= candidate.rect.x0 < candidate.rect.x1 <= page.width
                for candidate in candidates
            )
            assert all(
                (
                    "frame" in candidate.evidence
                    and "page_width" not in candidate.evidence
                )
                or (
                    candidate.rect.x0 == 0
                    and candidate.rect.x1 == page.width
                )
                for candidate in candidates
            )
            assert all(0 <= candidate.rect.y0 < candidate.rect.y1 <= page.height for candidate in candidates)

    assert checked_pages > 0
    assert checked_candidates >= checked_pages
    assert framed_candidates, "真实样本应至少包含一个四边闭合框候选"
    assert fallback_candidates, "真实样本应保留无闭合框时的回退候选"
    assert all("page_width" not in candidate.evidence for candidate in framed_candidates)
    assert all(
        candidate.rect.x0 == 0 and candidate.rect.x1 == page_width
        for candidate, page_width in fallback_candidates
    )
    assert {
        pdf_path: _file_size_and_sha256(pdf_path) for pdf_path in REAL_PDFS
    } == input_digests


@pytest.mark.skipif(not REAL_PDFS, reason="真实样本未放入 .local-data/input")
def test_real_samples_expose_boundary_evidence_without_text_payload() -> None:
    evidence = set()

    for pdf_path in REAL_PDFS:
        first_page = next(iter_pages(pdf_path), None)
        if first_page is None:
            continue
        candidates = infer_receipt_candidates(
            first_page,
            separators=extract_separators(pdf_path, first_page.page_number),
            visual_anchors=_extract_visual_anchors(pdf_path, first_page.page_number),
        )
        evidence.update(item for candidate in candidates for item in candidate.evidence)

    assert "page_width" in evidence
    assert "repeated_title" in evidence or "text blocks and vertical gaps" in evidence


@pytest.mark.skipif(not REAL_PDFS, reason="真实样本未放入 .local-data/input")
def test_xingye_interest_match_selects_the_first_receipt() -> None:
    pdf_path = INPUT_DIR / "银行回单_演示开发_兴业银行_202306.pdf"
    if not pdf_path.is_file():
        pytest.skip("兴业银行真实样本未放入 .local-data/input")

    page = next(iter_pages(pdf_path))
    candidates = infer_receipt_candidates(
        page,
        separators=extract_separators(pdf_path, page.page_number),
        visual_anchors=_extract_visual_anchors(pdf_path, page.page_number),
    )

    assert len(candidates) == 2
    selected = select_candidate_for_match(candidates, Rect(83.0, 218.1, 404.1, 230.1))
    assert selected is not None
    assert selected.slot == "slot-1"
    assert selected.confidence >= 0.9


@pytest.mark.skipif(not REAL_PDFS, reason="真实样本未放入 .local-data/input")
def test_representative_bank_pages_keep_expected_receipt_counts() -> None:
    expected = {
        "银行回单_演示开发_兴业银行_202306.pdf": 2,
        "银行回单_演示开发_宝生村镇_202512.pdf": 2,
        "银行回单_演示开发_招商银行_202601.pdf": 3,
        "银行回单_示例农牧_广发银行_202603.pdf": 3,
        "银行回单_示例实业_光大银行_202406.pdf": 2,
        "银行回单_示例实业_华夏银行_202603.pdf": 3,
        "银行回单_示例实业_邮政银行_202512.pdf": 2,
        "银行回单_示例实业_中信银行_202412.pdf": 1,
        "银行回单_样例甲_上海银行_202607.pdf": 3,
    }
    for filename, count in expected.items():
        pdf_path = INPUT_DIR / filename
        if not pdf_path.is_file():
            continue
        page = next(iter_pages(pdf_path))
        candidates = infer_receipt_candidates(
            page,
            separators=extract_separators(pdf_path, page.page_number),
            visual_anchors=_extract_visual_anchors(pdf_path, page.page_number),
        )
        assert len(candidates) == count, filename


@pytest.mark.skipif(not REAL_PDFS, reason="真实样本未放入 .local-data/input")
def test_huaxia_closed_frames_cover_all_three_receipts() -> None:
    pdf_path = INPUT_DIR / "银行回单_示例实业_华夏银行_202603.pdf"
    if not pdf_path.is_file():
        pytest.skip("华夏银行真实样本未放入 .local-data/input")

    page = next(iter_pages(pdf_path))
    raw_frames = extract_frame_anchors(pdf_path, page.page_number)
    assert len(raw_frames) == 3
    expected_frames = (
        (10.125, 10.125, 583.875, 277.875),
        (10.125, 288.125, 583.875, 554.875),
        (10.125, 565.125, 583.875, 831.875),
    )
    for frame, expected in zip(raw_frames, expected_frames, strict=True):
        assert (frame.x0, frame.y0, frame.x1, frame.y1) == pytest.approx(
            expected,
            abs=0.3,
        )

    candidates = infer_receipt_candidates(
        page,
        separators=extract_separators(pdf_path, page.page_number),
        visual_anchors=[
            *extract_visual_anchors(pdf_path, page.page_number),
            *raw_frames,
        ],
    )
    assert [candidate.slot for candidate in candidates] == ["top", "middle", "bottom"]
    for candidate, frame in zip(candidates, raw_frames, strict=True):
        expected = Rect(frame.x0 - 1, frame.y0 - 1, frame.x1 + 1, frame.y1 + 1)
        assert (candidate.rect.x0, candidate.rect.y0, candidate.rect.x1, candidate.rect.y1) == pytest.approx(
            (expected.x0, expected.y0, expected.x1, expected.y1),
            abs=0.01,
        )
        assert "frame" in candidate.evidence
        assert "page_width" not in candidate.evidence
        assert candidate.rect.x0 <= frame.x0
        assert candidate.rect.y0 <= frame.y0
        assert candidate.rect.x1 >= frame.x1
        assert candidate.rect.y1 >= frame.y1

    for candidate, match_rect in zip(
        candidates,
        (
            Rect(150, 100, 250, 120),
            Rect(150, 380, 250, 400),
            Rect(150, 660, 250, 680),
        ),
        strict=True,
    ):
        selected = select_candidate_for_match(candidates, match_rect)
        assert selected is candidate


@pytest.mark.skipif(not REAL_PDFS, reason="真实样本未放入 .local-data/input")
def test_baosheng_borderless_receipts_include_the_outer_bottom_frame() -> None:
    pdf_path = INPUT_DIR / "银行回单_演示开发_宝生村镇_202512.pdf"
    if not pdf_path.is_file():
        pytest.skip("宝生村镇银行真实样本未放入 .local-data/input")

    page = next(iter_pages(pdf_path))
    candidates = infer_receipt_candidates(
        page,
        separators=extract_separators(pdf_path, page.page_number),
        visual_anchors=_extract_visual_anchors(pdf_path, page.page_number),
    )

    assert len(candidates) == 2
    # The dotted outer frame is not exposed as a long PDF drawing.  The
    # candidate therefore needs a tail allowance beyond the final text row.
    assert candidates[0].rect.y1 >= 395
    assert candidates[1].rect.y1 >= 730


def _file_size_and_sha256(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return path.stat().st_size, digest.hexdigest()


@pytest.mark.skipif(not REAL_PDFS, reason="真实样本未放入 .local-data/input")
def test_real_guangfa_all_pages_keep_stamps_and_slot_isolation() -> None:
    pdf_path = INPUT_DIR / "银行回单_示例农牧_广发银行_202603.pdf"
    if not pdf_path.is_file():
        pytest.skip("广发银行真实样本未放入 .local-data/input")

    before = _file_size_and_sha256(pdf_path)
    pages = list(iter_pages(pdf_path))
    assert len(pages) == 21
    for page in pages:
        anchors = extract_visual_anchors(pdf_path, page.page_number)
        candidates = infer_receipt_candidates(
            page,
            separators=extract_separators(pdf_path, page.page_number),
            visual_anchors=[*anchors, *extract_frame_anchors(pdf_path, page.page_number)],
        )
        assert len(candidates) == 3
        assert candidates[0].rect.y1 >= 270.7
        assert candidates[1].rect.y1 >= 511.1
        assert candidates[2].rect.y1 >= 751.5
        image_starts = sorted(anchor.y0 for anchor in anchors)
        assert len(image_starts) >= 6
        assert candidates[0].rect.y1 <= image_starts[2]
        assert candidates[1].rect.y1 <= image_starts[4]
    assert _file_size_and_sha256(pdf_path) == before


@pytest.mark.skipif(not REAL_PDFS, reason="真实样本未放入 .local-data/input")
def test_real_everbright_all_pages_keep_logos_above_candidate_tops() -> None:
    pdf_path = INPUT_DIR / "银行回单_示例实业_光大银行_202406.pdf"
    if not pdf_path.is_file():
        pytest.skip("光大银行真实样本未放入 .local-data/input")

    before = _file_size_and_sha256(pdf_path)
    pages = list(iter_pages(pdf_path))
    assert len(pages) == 73
    for page in pages:
        anchors = extract_visual_anchors(pdf_path, page.page_number)
        candidates = infer_receipt_candidates(
            page,
            separators=extract_separators(pdf_path, page.page_number),
            visual_anchors=[*anchors, *extract_frame_anchors(pdf_path, page.page_number)],
        )
        assert len(candidates) == 2
        assert candidates[0].rect.y0 <= 17.7
        assert candidates[1].rect.y0 <= 435.6
        assert candidates[0].rect.y0 <= min(anchor.y0 for anchor in anchors)
        assert candidates[1].rect.y0 <= sorted(anchor.y0 for anchor in anchors)[-2]
    assert _file_size_and_sha256(pdf_path) == before


@pytest.mark.skipif(not REAL_PDFS, reason="真实样本未放入 .local-data/input")
def test_real_postal_all_pages_keep_second_bottom_frame_without_first_fallback() -> None:
    pdf_path = INPUT_DIR / "银行回单_示例实业_邮政银行_202512.pdf"
    if not pdf_path.is_file():
        pytest.skip("邮政银行真实样本未放入 .local-data/input")

    before = _file_size_and_sha256(pdf_path)
    pages = list(iter_pages(pdf_path))
    assert len(pages) == 8
    for page in pages:
        anchors = extract_visual_anchors(pdf_path, page.page_number)
        candidates = infer_receipt_candidates(
            page,
            separators=extract_separators(pdf_path, page.page_number),
            visual_anchors=[*anchors, *extract_frame_anchors(pdf_path, page.page_number)],
        )
        assert len(candidates) == 2
        assert candidates[0].rect.y1 >= 337.8
        assert candidates[1].rect.y1 >= 661.0
        assert candidates[0].rect.y1 < candidates[1].rect.y0 + 16.0
        assert all("single" not in candidate.slot for candidate in candidates)
    assert _file_size_and_sha256(pdf_path) == before


@pytest.mark.skipif(not REAL_PDFS, reason="真实样本未放入 .local-data/input")
def test_real_baosheng_all_pages_keep_dotted_bottom_frames() -> None:
    pdf_path = INPUT_DIR / "银行回单_演示开发_宝生村镇_202512.pdf"
    if not pdf_path.is_file():
        pytest.skip("宝生村镇银行真实样本未放入 .local-data/input")

    before = _file_size_and_sha256(pdf_path)
    pages = list(iter_pages(pdf_path))
    assert pages
    for page in pages:
        candidates = infer_receipt_candidates(
            page,
            separators=extract_separators(pdf_path, page.page_number),
            visual_anchors=_extract_visual_anchors(pdf_path, page.page_number),
        )
        assert len(candidates) == 2
        assert candidates[0].rect.y1 >= 402.0
        assert candidates[1].rect.y1 >= 736.0
    assert _file_size_and_sha256(pdf_path) == before


@pytest.mark.skipif(not REAL_PDFS, reason="真实样本未放入 .local-data/input")
def test_real_agricultural_first_page_keeps_qr_with_following_slot() -> None:
    pdf_path = INPUT_DIR / "银行回单_样例甲_农业银行_深圳西乡支行_202607.pdf"
    if not pdf_path.is_file():
        pytest.skip("农业银行真实样本未放入 .local-data/input")

    before = _file_size_and_sha256(pdf_path)
    page = next(iter_pages(pdf_path))
    anchors = extract_visual_anchors(pdf_path, page.page_number)
    candidates = infer_receipt_candidates(
        page,
        separators=extract_separators(pdf_path, page.page_number),
        visual_anchors=[*anchors, *extract_frame_anchors(pdf_path, page.page_number)],
    )

    assert len(candidates) == 3
    assert candidates[0].rect.y1 <= candidates[1].rect.y0
    assert candidates[1].rect.y0 == pytest.approx(304.75, abs=0.2)
    assert "anchor" in candidates[1].evidence
    assert candidates[1].rect.y1 >= 357.75
    assert _file_size_and_sha256(pdf_path) == before


@pytest.mark.skipif(not REAL_PDFS, reason="真实样本未放入 .local-data/input")
def test_real_agricultural_first_two_pages_keep_clean_leading_slots() -> None:
    pdf_path = INPUT_DIR / "银行回单_样例甲_农业银行_深圳西乡支行_202607.pdf"
    if not pdf_path.is_file():
        pytest.skip("农业银行真实样本未放入 .local-data/input")

    before = _file_size_and_sha256(pdf_path)
    pages = list(iter_pages(pdf_path))
    assert len(pages) >= 2
    for page in pages[:2]:
        anchors = extract_visual_anchors(pdf_path, page.page_number)
        candidates = infer_receipt_candidates(
            page,
            separators=extract_separators(pdf_path, page.page_number),
            visual_anchors=[*anchors, *extract_frame_anchors(pdf_path, page.page_number)],
        )
        assert len(candidates) == 3
        assert all("ambiguous_boundary" not in candidate.evidence for candidate in candidates)
        assert all(
            0 <= candidate.rect.y0 < candidate.rect.y1 <= page.height
            for candidate in candidates
        )
        middle_leading_y0 = min(
            anchor.y0 for anchor in anchors if 300.0 <= anchor.y0 <= 370.0
        )
        bottom_leading_y0 = min(
            anchor.y0 for anchor in anchors if 580.0 <= anchor.y0 <= 650.0
        )
        assert candidates[1].rect.y0 <= middle_leading_y0
        assert candidates[2].rect.y0 <= bottom_leading_y0
        assert "anchor" in candidates[1].evidence
        assert "anchor" in candidates[2].evidence
    assert _file_size_and_sha256(pdf_path) == before


@pytest.mark.skipif(not REAL_PDFS, reason="真实样本未放入 .local-data/input")
def test_real_shanghai_watermarks_do_not_mark_candidates_ambiguous() -> None:
    pdf_path = INPUT_DIR / "银行回单_样例甲_上海银行_202607.pdf"
    if not pdf_path.is_file():
        pytest.skip("上海银行真实样本未放入 .local-data/input")

    before = _file_size_and_sha256(pdf_path)
    pages = list(iter_pages(pdf_path))
    assert pages
    for page in pages:
        candidates = infer_receipt_candidates(
            page,
            separators=extract_separators(pdf_path, page.page_number),
            visual_anchors=_extract_visual_anchors(pdf_path, page.page_number),
        )
        assert all("ambiguous_boundary" not in candidate.evidence for candidate in candidates)
    assert _file_size_and_sha256(pdf_path) == before


@pytest.mark.skipif(not REAL_PDFS, reason="真实样本未放入 .local-data/input")
def test_real_china_bank_keeps_baseline_bottoms_without_global_tail() -> None:
    pdf_path = INPUT_DIR / "银行回单_样例甲_中国银行_松安支行_202607.pdf"
    if not pdf_path.is_file():
        pytest.skip("中国银行真实样本未放入 .local-data/input")

    before = _file_size_and_sha256(pdf_path)
    page = next(iter_pages(pdf_path))
    candidates = infer_receipt_candidates(
        page,
        separators=extract_separators(pdf_path, page.page_number),
        visual_anchors=_extract_visual_anchors(pdf_path, page.page_number),
    )
    assert [candidate.rect.y1 for candidate in candidates] == pytest.approx(
        [414.95099, 821.95093],
        abs=0.01,
    )
    assert all("ambiguous_boundary" not in candidate.evidence for candidate in candidates)
    assert _file_size_and_sha256(pdf_path) == before
