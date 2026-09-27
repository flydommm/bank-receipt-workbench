"""Anonymous visual form evidence and cross-source prefix-tail calibration."""
from copy import deepcopy
from hashlib import sha256
from types import SimpleNamespace

import pymupdf as fitz
import pytest

from engine.receipt_visual_identity import describe_visual_form, consume_visual_identity, visual_positions
from engine.receipt_layout_review import _incompatibility, _target_layout, prepare_receipt_calibration, preview_receipt_calibration
from engine.receipt_layout_models import parse_layout_definition
from engine.receipt_calibration_journal import retain_calibration_preview, undo_calibration_operation
from engine.batch_store import BatchStore, BatchConflict
from tests.test_receipt_layout_review import _ready, _prepared, _pdf, private_temp
from tests.test_receipt_calibration_journal import _save
from tests.test_receipt_batch_pdf import ALL


def _bitmap(width, height, color=(0, 0.5, 0.7)):
    with fitz.open() as doc:
        page = doc.new_page(width=width, height=height)
        page.draw_rect(fitz.Rect(10, 6, 110, height - 3), color=color, fill=color)
        page.draw_line((0, height - 1), (width, height - 1), color=color)
        return page.get_pixmap(alpha=False).tobytes("png")


def _visual_page(doc, *, count=3, color=(0, 0.5, 0.7), title="支付业务回单", covered=False, unused=False):
    page = doc.new_page(width=595, height=842)
    header = _bitmap(536, 30, color)
    rule = _bitmap(586, 8, (0.2, 0.2, 0.2))
    titles = []
    for top in (-3, 290, 575)[:count]:
        if not unused:
            page.insert_image(fitz.Rect(28, top, 564, top + 30), stream=header)
        page.insert_text((170, top + 20), title, fontname="china-s", fontsize=11)
        if covered:
            page.draw_rect(fitz.Rect(28, top, 162, top + 30), fill=(1, 1, 1), color=(1, 1, 1))
        if top + 280 <= 842:
            page.insert_image(fitz.Rect(2, top + 272, 588, top + 280), stream=rule)
        titles.append(SimpleNamespace(title_text=title, title_key=sha256(title.encode()).hexdigest(),
            x0=170, x1=320, y0=top + 5, y1=top + 20))
    if unused:
        xref = page.insert_image(fitz.Rect(28, 40, 564, 70), stream=header)
        # Resource remains reachable but its drawing operator is removed.
        contents = page.get_contents()
        doc.update_stream(contents[-1], b"")
        assert xref in [image[0] for image in page.get_images(full=True)]
    return page, titles


def test_visible_form_works_without_bank_ocr_and_preserves_prefix_positions():
    with fitz.open() as document:
        forms = []
        for count in (3, 2, 1):
            page, titles = _visual_page(document, count=count)
            forms.append(describe_visual_form(page, titles))
        assert all(forms)
        assert len({form["issuer_id"] for form in forms}) == 1
        assert len({form["family_id"] for form in forms}) == 1
        assert all(form["issuer_id"].startswith("visual-") for form in forms)
        assert [len(visual_positions(form)) for form in forms] == [3, 2, 1]
        assert consume_visual_identity({"layout_compatibility": forms[0]}) is not None


@pytest.mark.parametrize("kind", ["covered", "unused", "special"])
def test_hidden_unused_or_non_receipt_form_cannot_supply_visual_identity(kind):
    with fitz.open() as document:
        page, titles = _visual_page(document, covered=kind == "covered", unused=kind == "unused",
                                  title="贷款利息到期通知书" if kind == "special" else "支付业务回单")
        assert describe_visual_form(page, titles) is None


def test_visible_graphic_or_native_receipt_type_changes_identity():
    with fitz.open() as document:
        identities = []
        for color, title in [((0, 0.5, 0.7), "支付业务回单"), ((0.8, 0.1, 0.1), "支付业务回单"),
                             ((0, 0.5, 0.7), "贷款业务回单")]:
            page, titles = _visual_page(document, color=color, title=title)
            identities.append(describe_visual_form(page, titles))
        assert all(identities)
        assert identities[0]["issuer_id"] != identities[1]["issuer_id"]
        assert identities[0]["family_id"] != identities[2]["family_id"]


def test_mixed_native_receipt_titles_do_not_join_one_uniform_form():
    with fitz.open() as document:
        page, titles = _visual_page(document)
        # July's real page 147 has payment in the first position and electronic
        # banking in positions 2/3. A shared logo cannot erase that distinction.
        for title in titles[1:]:
            title.title_text = "电子银行业务回单"
            title.title_key = sha256(title.title_text.encode()).hexdigest()
        assert describe_visual_form(page, titles) is None


def _framed_customer_page(document, *, count=3, color=(0.7, 0.1, 0.1), title_variant=True,
                          cover_logo=False, cover_frame=False, unused_logo=False,
                          frame_width=574, title="客户回单通用回单"):
    page = document.new_page(width=595, height=842)
    logo = _bitmap(320, 82, color)
    titles, frames = [], []
    for index, top in enumerate((10, 288, 565)[:count]):
        frame = fitz.Rect(10, top, 10 + frame_width, top + 267)
        page.draw_rect(frame, color=(0, 0, 0), width=0.5)
        frames.append(tuple(frame))
        logo_rect = fitz.Rect(20, top + 8, 180, top + 48)
        page.insert_image(logo_rect, stream=logo, keep_proportion=False)
        if unused_logo:
            document.update_stream(page.get_contents()[-1], b"")
        if cover_logo:
            page.draw_rect(logo_rect, color=(1, 1, 1), fill=(1, 1, 1))
        if cover_frame:
            page.draw_rect(fitz.Rect(9, top - 1, 11 + frame_width, top + 1), color=(1, 1, 1), fill=(1, 1, 1))
        label = "客户回单大额支付系统业务" if index == 1 and title_variant else title
        page.insert_text((205, top + 42), label, fontname="china-s", fontsize=12)
        titles.append(SimpleNamespace(title_text=label, title_key=sha256(label.encode()).hexdigest(),
                                      x0=205, x1=389, y0=top + 29, y1=top + 44))
    return page, titles, frames


def test_framed_customer_receipts_allow_controlled_business_subtitles_and_prefix_tails():
    with fitz.open() as document:
        identities = []
        for count in (3, 2, 1):
            page, titles, frames = _framed_customer_page(document, count=count)
            identities.append(describe_visual_form(page, titles, frames=frames))
        assert all(identities)
        assert len({item["issuer_id"] for item in identities}) == 1
        assert len({item["family_id"] for item in identities}) == 1
        assert [len(visual_positions(item)) for item in identities] == [3, 2, 1]


@pytest.mark.parametrize("fault", ["covered_logo", "unused_logo", "covered_frame", "missing_frame", "special_title"])
def test_framed_customer_identity_requires_visible_logo_closed_frame_and_controlled_title(fault):
    with fitz.open() as document:
        page, titles, frames = _framed_customer_page(document,
            cover_logo=fault == "covered_logo", unused_logo=fault == "unused_logo", cover_frame=fault == "covered_frame",
            title="客户回单贷款利息到期通知书" if fault == "special_title" else "客户回单通用回单")
        assert describe_visual_form(page, titles, frames=frames[:-1] if fault == "missing_frame" else frames) is None


def test_framed_customer_different_logo_or_border_does_not_share_identity():
    with fitz.open() as document:
        identities = []
        for options in ({}, {"color": (0.1, 0.5, 0.7)}, {"frame_width": 565}):
            page, titles, frames = _framed_customer_page(document, **options)
            identities.append(describe_visual_form(page, titles, frames=frames))
        assert all(identities)
        assert identities[0]["issuer_id"] != identities[1]["issuer_id"]
        assert identities[0]["family_id"] != identities[2]["family_id"]


def test_framed_customer_same_decoded_logo_survives_color_space_encoding_change():
    identities = []
    for alternate in (False, True):
        with fitz.open() as document:
            page, titles, frames = _framed_customer_page(document)
            if alternate:
                for xref in {item[0] for item in page.get_images(full=True)}:
                    document.xref_set_key(xref, "ColorSpace", "[/CalRGB << /Gamma [2.2 2.2 2.2] "
                        "/WhitePoint [.95043 1 1.09] /Matrix [.41239 .21264 .01933 .35758 .71517 .11919 .18045 .07218 .9504] >>]")
                # Font metrics vary across PDF generators while the visible
                # logo, closed frames and actual physical positions agree.
                for title in titles:
                    title.y1 -= 2.1
            identities.append(describe_visual_form(page, titles, frames=frames))
    assert identities[0] is not None
    assert identities[0] == identities[1]


def _electronic_customer_page(document, *, positions=(0, 257, 514), color=(0.7, 0.1, 0.1),
                              fault=None, divider_x=310, body="合成交易甲", title="客户电子回单"):
    """Small masthead above a segmented native table; never use real business values."""
    from engine.crop_templates import _title_records
    from engine.pdf_parser import parse_loaded_page
    page = document.new_page(width=595, height=842)
    logo = _bitmap(130, 38, color)
    for index, offset in enumerate(positions):
        logo_rect = fitz.Rect(156.19, 13.9 + offset, 231.8, 36 + offset)
        page.insert_image(logo_rect, stream=logo, keep_proportion=False, rotate=180 if fault == "rotated_logo" else 0)
        if fault == "unused_logo":
            document.update_stream(page.get_contents()[-1], b"")
        page.insert_text((258.68, 31 + offset), title + ("（贷）" if index == 2 else "（借）"),
                         fontname="china-s", fontsize=18)
        for y in (40.5, 56.5, 72.5, 88.5, 110.5, 228.5):
            # The production PDF splits edges into short table-cell segments.
            for left, right in ((50.5, 76), (76, divider_x), (divider_x, 336), (336, 569)):
                page.draw_line((left, y + offset), (right, y + offset), width=.5)
        for x, top, bottom in ((50.5, 40.5, 228.5), (569, 40.5, 228.5),
                               (76, 40.5, 88.5), (divider_x, 40.5, 88.5), (336, 40.5, 88.5),
                               (102, 88.5, 110.5), (465, 88.5, 110.5)):
            page.draw_line((x, top + offset), (x, bottom + offset), width=.5)
        page.insert_text((80, 155 + offset), body, fontname="china-s", fontsize=10)
        page.insert_text((80, 247 + offset), "打印时间：2026-09-26", fontname="china-s", fontsize=7)
        if fault == "covered_logo":
            page.draw_rect(logo_rect, color=(1, 1, 1), fill=(1, 1, 1))
        if fault == "covered_table":
            page.draw_rect(fitz.Rect(49, 40 + offset, 52, 230 + offset), color=(1, 1, 1), fill=(1, 1, 1))
        if fault == "covered_divider":
            page.draw_rect(fitz.Rect(divider_x - 1, 41 + offset, divider_x + 1, 87 + offset),
                           color=(1, 1, 1), fill=(1, 1, 1))
    return page, _title_records(page, parse_loaded_page(page, page.number + 1), 595, 842)


def test_electronic_customer_small_masthead_proves_native_table_without_ocr(monkeypatch):
    from engine.crop_templates import describe_crop_page
    monkeypatch.setattr("engine.crop_templates.image_masthead_lines", lambda *_: [])
    with fitz.open() as document:
        forms = []
        for positions in ((0, 257, 514), (0, 257), (0,)):
            page, titles = _electronic_customer_page(document, positions=positions)
            descriptor = describe_crop_page(page)
            assert descriptor["status"] == "ready"
            assert all(row["issuer_bank_key"] is None for row in descriptor["receipts"])
            form = descriptor.get("layout_compatibility")
            assert form is not None
            assert form == describe_visual_form(page, titles)
            forms.append(form)
        assert len({form["issuer_id"] for form in forms}) == 1
        assert len({form["family_id"] for form in forms}) == 1
        assert [len(visual_positions(form)) for form in forms] == [3, 2, 1]


@pytest.mark.parametrize("fault", ["covered_logo", "unused_logo", "rotated_logo", "covered_table", "covered_divider", "special_title"])
def test_electronic_customer_identity_requires_visible_masthead_complete_table_and_native_type(fault):
    with fitz.open() as document:
        page, titles = _electronic_customer_page(document, fault=fault,
            title="贷款利息到期通知书" if fault == "special_title" else "客户电子回单")
        assert describe_visual_form(page, titles) is None


def test_electronic_customer_identity_binds_form_and_logo_but_excludes_body_and_absolute_row():
    from engine.receipt_visual_identity import compatible_visual_positions
    with fitz.open() as document:
        forms = []
        for options in ({}, {"body": "合成交易乙"}, {"divider_x": 314},
                        {"color": (0.1, 0.5, 0.7)}, {"positions": (257,)}):
            page, titles = _electronic_customer_page(document, **options)
            forms.append(describe_visual_form(page, titles))
        assert all(forms)
        assert forms[0] == forms[1]
        assert forms[0]["issuer_id"] == forms[2]["issuer_id"]
        assert forms[0]["family_id"] != forms[2]["family_id"]
        assert forms[0]["issuer_id"] != forms[3]["issuer_id"]
        assert forms[0]["family_id"] == forms[4]["family_id"]
        assert not compatible_visual_positions(forms[0], forms[4])


def test_electronic_customer_template_persistence_reuses_only_proven_prefix_rows(tmp_path, monkeypatch):
    from engine.batch_pdf import BatchPdfSource
    from engine.receipt_layout import suggest_layout
    from engine.receipt_layout_reference import save_reference_layout, historical_reference, apply_historical_reference
    monkeypatch.setattr("engine.crop_templates.image_masthead_lines", lambda *_: [])
    layouts = []
    for options in ({}, {"positions": (0, 257)}, {"positions": (257,)},
                    {"positions": (2, 259, 516)}, {"divider_x": 314}):
        with fitz.open() as document:
            _electronic_customer_page(document, **options)
            source = BatchPdfSource(tmp_path / "synthetic.pdf", "a" * 64, 0, 1, document)
            layouts.append(suggest_layout(source._page_evidence(1, allow_ocr=False)).layout_definition)
    saved_layout = deepcopy(layouts[0])
    saved_layout["uniform_height"] = False
    for slot in saved_layout["slots"]:
        slot["height_pt"] -= 1
    saved = save_reference_layout(saved_layout, tmp_path / "templates.sqlite3", "synthetic-operation")
    reference = historical_reference(saved)
    assert reference is not None
    full, prefix = [apply_historical_reference(layout, (reference,)) for layout in layouts[:2]]
    assert full is not None and prefix is not None
    assert len(full["slots"]) == 3 and len(prefix["slots"]) == 2
    assert [slot["height_pt"] for slot in prefix["slots"]] == [slot["height_pt"] for slot in saved_layout["slots"][:2]]
    assert all(apply_historical_reference(layout, (reference,)) is None for layout in layouts[2:])


@pytest.mark.parametrize("kind", ["drawings", "placements"])
def test_electronic_customer_resource_budget_fails_before_rendering(kind, monkeypatch):
    with fitz.open() as document:
        page, titles = _electronic_customer_page(document)
        if kind == "drawings":
            monkeypatch.setattr(page, "get_drawings", lambda: [{}] * 4097)
        else:
            original = page.get_image_rects
            monkeypatch.setattr(page, "get_image_rects", lambda *args, **kwargs: original(*args, **kwargs) * 44)
        monkeypatch.setattr(page, "get_pixmap", lambda **_: pytest.fail("budget rejection must precede rendering"))
        assert describe_visual_form(page, titles) is None


def _layout(count=3):
    from tests.test_receipt_layout_review import _unverified_layout
    value = _unverified_layout()
    value.update(issuer_id="visual-" + "a" * 64, family_id="b" * 64,
                 evidence_version="receipt-visual-v1." + ".".join(("n30", "p2900", "p5750")[:count]))
    value["slots"] = value["slots"][:count]
    return parse_layout_definition(value)


def test_prefix_tail_projection_preserves_actual_count_and_original_position_evidence():
    sample, tail = _layout(), _layout(2)
    assert _incompatibility(sample, tail, False) is None
    assert _incompatibility(tail, sample, False) is None
    draft = deepcopy(sample)
    draft["uniform_height"] = True
    for slot in draft["slots"]:
        slot["height_pt"] = 270
    result = _target_layout(sample, draft, tail, {"slot-1", "slot-2", "slot-3"}, 2)
    assert len(result["slots"]) == 2
    assert result["evidence_version"] == tail["evidence_version"]
    assert [slot["height_pt"] for slot in result["slots"]] == [270, 270]


@pytest.mark.parametrize("fault", ["image", "type", "position", "unverified", "malformed"])
def test_cross_source_visual_gate_rejects_unproven_or_contradictory_evidence(fault):
    sample, target = _layout(), _layout(2)
    if fault == "image": target["issuer_id"] = "visual-" + "c" * 64
    if fault == "type": target["family_id"] = "d" * 64
    if fault == "position": target["evidence_version"] = "receipt-visual-v1.p2900.p5750"
    if fault == "unverified": target["issuer_id"] = None
    if fault == "malformed": target["evidence_version"] = "receipt-visual-v1.pnan"
    assert _incompatibility(sample, target, False) is not None


def _install_visual_computation(monkeypatch, sequences):
    # Use real PDFs/checkpoints/journal, replacing only optional identity evidence
    # and disabling automatic reference expansion to keep actual tail counts.
    from engine.batch_pdf import BatchPdfSource
    from engine.receipt_layout import LayoutSuggestion
    from engine.receipt_layout import compute_receipt_page
    from engine.pdf_parser import visible_page
    from engine.receipt_layout_calibration import suggest_calibrated_layout
    original = BatchPdfSource.compute_receipt_page
    def computation(self, page, options, mode, budget, **kwargs):
        if kwargs.get("layout_definition") is not None:
            return original(self, page, options, mode, budget, **kwargs)
        positions = sequences[page - 1]
        count = len(positions)
        evidence = self._page_evidence(page, allow_ocr=False)
        layout = suggest_calibrated_layout(evidence.geometry, 3, top_pt=20, bottom_pt=20,
            issuer_id="visual-" + "a" * 64, family_id="b" * 64)
        layout["slots"] = layout["slots"][:count]
        layout["evidence_version"] = "receipt-visual-v1." + ".".join(positions)
        return compute_receipt_page(evidence, self.sha256, options, match_mode=mode, budget=budget,
            suggestion=LayoutSuggestion(layout, "page_evidence", False), visible_page=visible_page(self._document[page-1]))
    monkeypatch.setattr(BatchPdfSource, "compute_receipt_page", computation)


def test_tail_sample_promotes_full_editor_but_save_and_undo_preserve_each_page(tmp_path, monkeypatch):
    _install_visual_computation(monkeypatch, [("p650", "p3650", "p6650"), ("p650",)])
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "one"), _pdf(tmp_path, "two")], ALL)
        snapshot = store.review_snapshot(ready["id"], ready["result_revision"])
        index = next(index for index, item in enumerate(snapshot["originals"]) if item["source_page"] == 2)
        prepared = _prepared(store, ready, review, index)
        assert prepared.sample["source_page"] == 2
        assert len(prepared.layout["slots"]) == 3
        assert prepared.view()["source_count"] == 2
        assert prepared.view()["page_count"] == 4
        before = store.read_page_results(ready["id"])
        draft = deepcopy(prepared.layout)
        draft["revision"] += 1
        draft["uniform_height"] = True
        for index, slot in enumerate(draft["slots"]):
            slot.update(top_pt=10 + 300 * index, height_pt=285)
        preview = preview_receipt_calibration(store, prepared, draft, review)
        assert preview.can_save, preview.blockers
        assert len(preview.proposed["originals"]) == 8
        assert [len(row["payload"]["receipt_page"]["layout_definition"]["slots"]) for row in preview.page_rows] == [3, 1, 3, 1]
        assert store.read_page_results(ready["id"]) == before
        retained = retain_calibration_preview(store, preview, review)
        saved = _save(store, ready, review, retained, remember_reference=False)
        assert saved["state"] == "applied"
        undone = undo_calibration_operation(store, ready["id"], retained["operation_id"], review)
        assert undone["state"] == "undone"
        assert [row["payload"] for row in store.read_page_results(ready["id"])] == [row["payload"] for row in before]


@pytest.mark.parametrize("sequences", [
    [("p0",), ("n4", "p3000", "p6000"), ("p4",)],
    [("p0", "p3000"), ("p0", "p3000", "p6000"), ("p0", "p3000", "p6100")],
], ids=["position-tolerance-is-not-transitive", "tail-cannot-bridge-different-third-positions"])
def test_tail_editor_scope_must_also_match_full_representative(tmp_path, monkeypatch, sequences):
    _install_visual_computation(monkeypatch, sequences)
    review = tmp_path / "review.sqlite3"
    with BatchStore(tmp_path / "tasks.sqlite3") as store:
        ready = _ready(store, [_pdf(tmp_path, "mixed", counts=tuple(map(len, sequences)))], ALL)
        prepared = _prepared(store, ready, review)
        assert prepared.sample["source_page"] == 1
        assert [page for _source, page in prepared.eligible_page_keys] == [1, 2]
        assert prepared.excluded_page_counts == {"different_slot_structure": 1}
        assert len(prepared.layout["slots"]) == 3
        draft = deepcopy(prepared.layout)
        draft["revision"] += 1
        draft["uniform_height"] = True
        for index, slot in enumerate(draft["slots"]):
            slot.update(top_pt=10 + 300 * index, height_pt=285)
        before = store.read_page_results(ready["id"])
        preview = preview_receipt_calibration(store, prepared, draft, review)
        assert preview.can_save, preview.blockers
        assert len(preview.page_rows[0]["payload"]["receipt_page"]["layout_definition"]["slots"]) == len(sequences[0])
        assert preview.page_rows[2]["payload"] == before[2]["payload"]


def test_unproven_tail_projection_fails_without_adding_slots():
    sample, tail = _layout(), _layout(1)
    sample["evidence_version"] = "receipt-visual-v1.n4.p3000.p6000"
    tail["evidence_version"] = "receipt-visual-v1.p4"
    with pytest.raises(BatchConflict, match="corresponding positions"):
        _target_layout(sample, sample, tail, {"slot-1", "slot-2", "slot-3"}, 2)
