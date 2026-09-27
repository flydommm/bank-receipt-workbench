from __future__ import annotations

from hashlib import sha256
from pathlib import Path

import pymupdf
import pytest

from engine.crop_templates import describe_crop_page
from engine.layout import infer_receipt_candidates
from engine.pdf_geometry import read_page_geometry
from engine.pdf_parser import parse_loaded_page
from engine.receipt_layout import PageLayoutEvidence, suggest_layout
from engine.receipt_layout_reference import apply_reference, save_reference_layout
from engine.receipt_layout_review import CalibrationPreparation


_STARTS = (0.0, 280.0, 560.0)
_TITLE_BASELINE_OFFSET = 32.68
_ISSUER_KEY = sha256("上海银行".encode("utf-8")).hexdigest()


def _write_heading_band_pdf(
    path: Path,
    *,
    body_crossing: bool = False,
    title: str = "上海银行业务回单",
    transaction_bank_only: bool = False,
    value_suffix: str = "",
    header_shift: tuple[float, float] = (0.0, 0.0),
    shifted_slot: int | None = None,
    missing_fields: tuple[str, ...] = (),
    missing_field_slot: tuple[int, str] | None = None,
    duplicate_field: str | None = None,
    duplicate_field_slot: int | None = None,
    body_header_reference: bool = False,
    narrow_body_crossing: bool = False,
    diagonal_watermarks: bool = False,
) -> None:
    """Write a synthetic three-slot page with two rows in each title band.

    The geometry mirrors the affected SH-A header: the title of slot two has
    a visible y0 of 301.68; ``回单编号`` is above that title and ``记账日期``
    overlaps its lower edge.  Values are synthetic and vary by slot/file.
    """

    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        for index, start in enumerate(_STARTS, 1):
            baseline = start + _TITLE_BASELINE_OFFSET
            shift_x, shift_y = header_shift
            if shifted_slot is not None and shifted_slot != index:
                shift_x = shift_y = 0.0
            number_missing = (
                "number" in missing_fields
                or missing_field_slot == (index, "number")
            )
            date_missing = (
                "date" in missing_fields
                or missing_field_slot == (index, "date")
            )
            if not number_missing:
                page.insert_text(
                    (400 + shift_x, baseline - 6.06 + shift_y),
                    f"回单编号：合成编号-{index}{value_suffix}",
                    fontname="china-s",
                    fontsize=9,
                )
                if duplicate_field == "number" and (
                    duplicate_field_slot is None or duplicate_field_slot == index
                ):
                    page.insert_text(
                        (405 + shift_x, baseline - 6.06 + shift_y),
                        f"回单编号：重复编号-{index}{value_suffix}",
                        fontname="china-s",
                        fontsize=9,
                    )
            if not date_missing:
                page.insert_text(
                    (30 + shift_x, baseline + 2.94 + shift_y),
                    f"记账日期：合成日期-{index}{value_suffix}",
                    fontname="china-s",
                    fontsize=7,
                )
                if duplicate_field == "date" and (
                    duplicate_field_slot is None or duplicate_field_slot == index
                ):
                    page.insert_text(
                        (35 + shift_x, baseline + 2.94 + shift_y),
                        f"记账日期：重复日期-{index}{value_suffix}",
                        fontname="china-s",
                        fontsize=7,
                    )
            page.insert_text(
                (250, baseline),
                title,
                fontname="china-s",
                fontsize=11,
            )
            if transaction_bank_only:
                page.insert_text(
                    (30, baseline + 55),
                    "付款人开户行：中国建设银行",
                    fontname="china-s",
                    fontsize=10,
                )
            else:
                page.insert_text(
                    (30, baseline + 55),
                    f"付款人名称：合成甲公司-{index}{value_suffix}",
                    fontname="china-s",
                    fontsize=10,
                )
                page.insert_text(
                    (30, baseline + 85),
                    f"收款人名称：合成乙公司-{index}{value_suffix}",
                    fontname="china-s",
                    fontsize=10,
                )
                page.insert_text(
                    (30, baseline + 115),
                    f"交易金额：合成金额-{index}{value_suffix}",
                    fontname="china-s",
                    fontsize=10,
                )
            page.draw_line((20, baseline + 190), (580, baseline + 190))

        if body_crossing:
            # The second title starts at y0=301.68.  This is actual body text
            # whose second line crosses that heading, rather than a heading
            # field that happens to overlap the title band.
            page.insert_text(
                (30, 280),
                "合成正文上行",
                fontname="china-s",
                fontsize=11,
            )
            page.insert_text(
                (30, 305),
                "合成正文跨越下一标题",
                fontname="china-s",
                fontsize=11,
            )
        if narrow_body_crossing:
            # This line begins after the next receipt's protected header start
            # (the number field at about y=297.62), but its bbox still crosses
            # the next title y0=301.68.  It must remain real body content.
            page.insert_text(
                (180, 310),
                "合成正文窄带跨越标题",
                fontname="china-s",
                fontsize=11,
            )
        if body_header_reference:
            # Lexical references in body text cannot substitute for the two
            # repeated metadata fields in the title band.
            page.insert_text(
                (180, 280),
                "正文引用：回单编号：合成引用",
                fontname="china-s",
                fontsize=9,
            )
            page.insert_text(
                (180, 305),
                "正文引用：记账日期：合成引用",
                fontname="china-s",
                fontsize=7,
            )
        if diagonal_watermarks:
            # The third real title starts at y0=581.68.  The final repeated
            # diagonal watermark intentionally occupies about 531.5..589.3,
            # reproducing the source geometry that used to move that heading
            # start into the preceding receipt.
            for watermark_y in (120.0, 400.0, 586.0):
                point = pymupdf.Point(80, watermark_y)
                page.insert_text(
                    point,
                    "上海银行",
                    fontname="china-s",
                    fontsize=19,
                    morph=(point, pymupdf.Matrix(30)),
                )
        document.save(path)


def _describe(path: Path) -> dict[str, object]:
    with pymupdf.open(path) as document:
        return describe_crop_page(document[0])


def _layout_identity(path: Path, descriptor: dict[str, object]) -> dict[str, object]:
    with pymupdf.open(path) as document:
        page = document[0]
        parsed = parse_loaded_page(page, 1)
        evidence = PageLayoutEvidence(
            read_page_geometry(page),
            parsed,
            tuple(infer_receipt_candidates(parsed)),
            descriptor,
        )
        return suggest_layout(evidence).layout_definition


def _assert_no_verified_identity(path: Path, descriptor: dict[str, object]) -> None:
    """Allow conservative unavailability, but never a false reusable identity."""

    assert descriptor["status"] in {"ready", "unavailable"}
    if descriptor["status"] == "unavailable":
        return
    receipts = descriptor["receipts"]
    assert isinstance(receipts, list)
    layout = _layout_identity(path, descriptor)
    # A title can still identify its issuing bank, but incomplete header
    # evidence must not produce a reusable family identity.
    assert layout["family_id"] is None


def test_repeated_heading_band_fields_keep_three_slots_ready_and_verified(
    tmp_path: Path,
) -> None:
    path = tmp_path / "synthetic-heading-band.pdf"
    _write_heading_band_pdf(path)

    descriptor = _describe(path)

    assert descriptor["status"] == "ready"
    receipts = descriptor["receipts"]
    assert isinstance(receipts, list) and len(receipts) == 3
    assert {receipt["issuer_bank_name"] for receipt in receipts} == {"上海银行"}
    assert {receipt["issuer_bank_key"] for receipt in receipts} == {_ISSUER_KEY}
    assert all(
        isinstance(receipt["template_fingerprint"], str)
        and len(receipt["template_fingerprint"]) == 64
        for receipt in receipts
    )
    assert all(
        receipt["bounds"]["y0"] <= receipt["anchor_y"] < receipt["bounds"]["y1"]
        for receipt in receipts
    )

    layout = _layout_identity(path, descriptor)
    assert layout["issuer_id"] == _ISSUER_KEY
    assert isinstance(layout["family_id"], str) and len(layout["family_id"]) == 64


def test_heading_band_values_do_not_change_verified_geometry_or_identity(
    tmp_path: Path,
) -> None:
    first_path = tmp_path / "synthetic-heading-band-first.pdf"
    second_path = tmp_path / "synthetic-heading-band-second.pdf"
    _write_heading_band_pdf(first_path, value_suffix="-A")
    _write_heading_band_pdf(second_path, value_suffix="-B-longer")

    first = _describe(first_path)
    second = _describe(second_path)

    assert first["status"] == second["status"] == "ready"
    assert first["fingerprint"] == second["fingerprint"]
    first_receipts = first["receipts"]
    second_receipts = second["receipts"]
    assert isinstance(first_receipts, list) and isinstance(second_receipts, list)
    assert [item["template_fingerprint"] for item in first_receipts] == [
        item["template_fingerprint"] for item in second_receipts
    ]
    assert [item["issuer_bank_key"] for item in first_receipts] == [
        item["issuer_bank_key"] for item in second_receipts
    ]
    assert _layout_identity(first_path, first)["family_id"] == _layout_identity(
        second_path, second,
    )["family_id"]


def test_real_body_text_crossing_next_heading_remains_unavailable(tmp_path: Path) -> None:
    path = tmp_path / "synthetic-heading-band-body-crossing.pdf"
    _write_heading_band_pdf(path, body_crossing=True)

    assert _describe(path) == {
        "status": "unavailable",
        "reason": "ambiguous_layout",
    }


def test_transaction_bank_value_cannot_establish_receipt_issuer(tmp_path: Path) -> None:
    path = tmp_path / "synthetic-heading-band-transaction-bank.pdf"
    _write_heading_band_pdf(
        path,
        title="业务回单",
        transaction_bank_only=True,
    )

    descriptor = _describe(path)

    # A page with no trusted issuer may conservatively be unavailable.  If it
    # is described, the transaction-field bank still cannot provide identity.
    assert descriptor["status"] in {"ready", "unavailable"}
    if descriptor["status"] == "ready":
        receipts = descriptor["receipts"]
        assert isinstance(receipts, list) and len(receipts) == 3
        assert all(receipt["issuer_bank_name"] is None for receipt in receipts)
        assert all(receipt["issuer_bank_key"] is None for receipt in receipts)
        assert all(receipt["template_fingerprint"] is None for receipt in receipts)
        layout = _layout_identity(path, descriptor)
        assert layout["issuer_id"] is None
        assert layout["family_id"] is None


def test_diagonal_bank_watermark_near_next_title_does_not_move_boundary(
    tmp_path: Path,
) -> None:
    baseline_path = tmp_path / "synthetic-heading-band-baseline.pdf"
    watermark_path = tmp_path / "synthetic-heading-band-watermark.pdf"
    _write_heading_band_pdf(baseline_path)
    _write_heading_band_pdf(watermark_path, diagonal_watermarks=True)

    baseline = _describe(baseline_path)
    watermarked = _describe(watermark_path)

    assert watermarked == baseline
    with pymupdf.open(watermark_path) as document:
        watermarks = [
            block
            for block in parse_loaded_page(document[0], 1).blocks
            if block.is_watermark and "上海银行" in block.text
        ]
    assert len(watermarks) == 3
    assert any(
        block.y0 == pytest.approx(531.54, abs=0.2)
        and block.y1 == pytest.approx(589.29, abs=0.2)
        for block in watermarks
    )


def test_shifted_heading_band_is_a_distinct_verified_form(tmp_path: Path) -> None:
    first_path = tmp_path / "synthetic-heading-band-reference.pdf"
    shifted_path = tmp_path / "synthetic-heading-band-shifted.pdf"
    _write_heading_band_pdf(first_path)
    _write_heading_band_pdf(shifted_path, header_shift=(8.0, 0.0))

    first = _describe(first_path)
    shifted = _describe(shifted_path)

    assert first["status"] == shifted["status"] == "ready"
    assert first["fingerprint"] == shifted["fingerprint"]
    first_receipts = first["receipts"]
    shifted_receipts = shifted["receipts"]
    assert isinstance(first_receipts, list) and isinstance(shifted_receipts, list)
    assert [item["template_fingerprint"] for item in first_receipts]
    assert [item["template_fingerprint"] for item in shifted_receipts]
    assert [item["template_fingerprint"] for item in first_receipts] != [
        item["template_fingerprint"] for item in shifted_receipts
    ]
    assert _layout_identity(first_path, first)["family_id"] != _layout_identity(
        shifted_path, shifted,
    )["family_id"]


def test_saved_heading_band_reference_applies_only_to_same_verified_form(
    tmp_path: Path,
) -> None:
    reference_path = tmp_path / "synthetic-heading-band-reference.pdf"
    value_variant_path = tmp_path / "synthetic-heading-band-value-variant.pdf"
    shifted_path = tmp_path / "synthetic-heading-band-shifted.pdf"
    database = tmp_path / "templates.sqlite3"
    _write_heading_band_pdf(reference_path)
    _write_heading_band_pdf(value_variant_path, value_suffix="-different")
    _write_heading_band_pdf(shifted_path, header_shift=(8.0, 0.0))
    reference = _describe(reference_path)
    value_variant = _describe(value_variant_path)
    shifted = _describe(shifted_path)
    reference_layout = _layout_identity(reference_path, reference)
    value_variant_layout = _layout_identity(value_variant_path, value_variant)
    shifted_layout = _layout_identity(shifted_path, shifted)

    saved_layout = {
        **reference_layout,
        "uniform_height": False,
        "slots": [
            (
                {**slot, "height_pt": slot["height_pt"] - 1.0}
                if index == 0 else {**slot}
            )
            for index, slot in enumerate(reference_layout["slots"])
        ],
    }
    save_reference_layout(
        saved_layout,
        database,
        "synthetic-heading-band",
        confirmed_slot_ids=["slot-1"],
    )

    def prepared(layout: dict[str, object]) -> CalibrationPreparation:
        return CalibrationPreparation(
            {}, [], {}, "synthetic-heading-band", {"id": "sample"},
            layout, (("synthetic", 1),), {},
        )

    applied_input = prepared(value_variant_layout)
    applied = apply_reference(applied_input, database)
    assert applied.layout["issuer_id"] == value_variant_layout["issuer_id"]
    assert applied.layout["family_id"] == value_variant_layout["family_id"]
    assert applied.layout["uniform_height"] is False
    assert applied.layout["slots"][0]["height_pt"] == pytest.approx(
        saved_layout["slots"][0]["height_pt"],
    )
    assert [slot["top_pt"] for slot in applied.layout["slots"]] == [
        slot["top_pt"] for slot in value_variant_layout["slots"]
    ]
    assert [slot["height_pt"] for slot in applied.layout["slots"][1:]] == [
        slot["height_pt"] for slot in value_variant_layout["slots"][1:]
    ]

    shifted_input = prepared(shifted_layout)
    assert apply_reference(shifted_input, database) is shifted_input


@pytest.mark.parametrize(
    ("name", "options"),
    [
        (
            "missing-all-header-fields",
            {"missing_fields": ("date", "number"), "transaction_bank_only": True},
        ),
        (
            "missing-one-slot-field",
            {"missing_field_slot": (2, "number")},
        ),
        (
            "misaligned-one-slot-field",
            {"shifted_slot": 2, "header_shift": (0.0, 25.0)},
        ),
        (
            "duplicate-one-slot-field",
            {"duplicate_field": "number", "duplicate_field_slot": 2},
        ),
        (
            "body-field-reference",
            {
                "missing_fields": ("date", "number"),
                "transaction_bank_only": True,
                "body_header_reference": True,
            },
        ),
    ],
)
def test_incomplete_or_ambiguous_heading_band_never_creates_reusable_identity(
    tmp_path: Path,
    name: str,
    options: dict[str, object],
) -> None:
    path = tmp_path / f"synthetic-heading-band-{name}.pdf"
    _write_heading_band_pdf(path, **options)

    _assert_no_verified_identity(path, _describe(path))


def test_body_line_crossing_protected_heading_band_remains_unavailable(
    tmp_path: Path,
) -> None:
    path = tmp_path / "synthetic-heading-band-narrow-body-crossing.pdf"
    _write_heading_band_pdf(path, narrow_body_crossing=True)

    assert _describe(path) == {
        "status": "unavailable",
        "reason": "ambiguous_layout",
    }
