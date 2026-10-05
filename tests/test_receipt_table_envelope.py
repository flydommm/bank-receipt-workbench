"""Synthetic variable-body tables must reuse only proven outer crop geometry."""
from copy import deepcopy
from hashlib import sha256

import pymupdf as fitz
import pytest

from engine.crop_templates import describe_crop_page
from engine.receipt_visual_identity import consume_visual_identity
from tests.test_receipt_visual_identity import _bitmap


def online_page(document, *, columns=(150, 300, 410), body_height=120, shift=0,
                logo_color=(0, .5, .3), missing_label=False, covered=False,
                width=522, title="网上银行电子回单", count=3, soft_mask=False,
                hide_separator=False):
    page=document.new_page(width=595, height=842)
    logo=_bitmap(240, 48, logo_color)
    mask = None
    if soft_mask:
        with fitz.open() as mask_document:
            mask = mask_document.new_page(width=240, height=48).get_pixmap(colorspace=fitz.csGRAY).tobytes("png")
    for index, top in enumerate((50, 325, 605)[:count]):
        top += shift
        logo_rect=fitz.Rect(36,top+4,156,top+28)
        page.insert_image(logo_rect,stream=logo,mask=mask,keep_proportion=False)
        page.insert_text((245,top+15), title, fontname="china-s",fontsize=12)
        table=fitz.Rect(36,top+40,36+width,top+40+body_height)
        xs=[36, *columns, 36+width]
        ys=[table.y0, table.y0+12,table.y0+24,table.y0+40,table.y1-32,table.y1]
        for x in xs: page.draw_line((x,table.y0),(x,table.y1),color=(.4,.4,.4),width=.75)
        for y in ys:
            for x0,x1 in zip(xs,xs[1:]):page.draw_line((x0,y),(x1,y),color=(.4,.4,.4),width=.75)
        for x in (70,335):
            for label,y in zip(("账号","户名","开户行"),(10,22,38)):
                if not (missing_label and label=="户名"):
                    page.insert_text((x,table.y0+y),label,fontname="china-s",fontsize=8)
        page.insert_text((70,table.y1-22),"币种",fontname="china-s",fontsize=8)
        page.insert_text((70,table.y1-10),"摘要",fontname="china-s",fontsize=8)
        if index<count-1:
            page.draw_line((20,top+230),(575,top+230),dashes='[3.75 2.55] 5.03')
            if hide_separator:page.draw_rect(fitz.Rect(19,top+229,576,top+231),fill=(1,1,1),color=(1,1,1))
        if covered:page.draw_rect(logo_rect,color=(1,1,1),fill=(1,1,1))
    return page


def test_variable_body_columns_heights_keep_crop_identity_but_not_fine_fingerprint(monkeypatch):
    monkeypatch.setattr("engine.crop_templates.image_masthead_lines",lambda *_: [])
    with fitz.open() as document:
        a=describe_crop_page(online_page(document))
        b=describe_crop_page(online_page(document,columns=(162,312,428),body_height=132))
        assert a['status']==b['status']=='ready'
        assert a['receipts'][0]['template_fingerprint'] is None  # no bank-name guess from a channel title
        left,right=consume_visual_identity(a),consume_visual_identity(b)
        assert left is not None and right is not None
        assert left==right


@pytest.mark.parametrize('options',[{'logo_color':(.7,.1,.1)},{'width':512},{'title':'企业网上银行电子回单'}, {'shift':3}])
def test_other_logo_outer_form_title_and_positions_are_distinct(options,monkeypatch):
    monkeypatch.setattr("engine.crop_templates.image_masthead_lines",lambda *_: [])
    with fitz.open() as document:
        a=consume_visual_identity(describe_crop_page(online_page(document)))
        b=consume_visual_identity(describe_crop_page(online_page(document,**options)))
        assert a is not None
        assert b is None or a!=b


@pytest.mark.parametrize('options',[{'missing_label':True},{'covered':True},{'title':'贷款利息到期通知书'},
                                  {'hide_separator':True},{'count':1}])
def test_missing_structure_hidden_logo_and_special_title_cannot_supply_crop_identity(options,monkeypatch):
    monkeypatch.setattr("engine.crop_templates.image_masthead_lines",lambda *_: [])
    with fitz.open() as document:
        assert consume_visual_identity(describe_crop_page(online_page(document,**options))) is None


def test_visible_masked_logo_is_proven_and_overpainting_still_rejected(monkeypatch):
    monkeypatch.setattr("engine.crop_templates.image_masthead_lines",lambda *_: [])
    with fitz.open() as document:
        assert consume_visual_identity(describe_crop_page(online_page(document,soft_mask=True))) is not None
        assert consume_visual_identity(describe_crop_page(online_page(document,soft_mask=True,covered=True))) is None


def test_same_anonymous_logo_cannot_replace_conflicting_native_bank_evidence(monkeypatch):
    from engine.receipt_layout import _definition
    from engine.pdf_geometry import read_page_geometry
    monkeypatch.setattr("engine.crop_templates.image_masthead_lines", lambda *_: [])
    with fitz.open() as document:
        page = online_page(document)
        descriptor = describe_crop_page(page)
        slots = [{"slot_id": f"slot-{index + 1}", "position_index": index + 1,
                  "top_pt": top, "height_pt": 205} for index, top in enumerate((45, 320, 600))]
        first, second = deepcopy(descriptor), deepcopy(descriptor)
        for receipt in first['receipts']:
            receipt['issuer_bank_key'] = 'a' * 64
        for receipt in second['receipts']:
            receipt['issuer_bank_key'] = 'b' * 64
        layouts = [_definition(read_page_geometry(page), slots, 'default', value, uniform=True)
                   for value in (first, second)]
        assert layouts[0]['family_id'] == layouts[1]['family_id']
        assert layouts[0]['issuer_id'] != layouts[1]['issuer_id']


def _two_page_source(tmp_path):
    path=tmp_path/'synthetic-tables.pdf'
    with fitz.open() as document:
        online_page(document)
        online_page(document,columns=(162,312,428),body_height=132)
        document.save(path)
    return path


def test_template_applies_to_variable_table_preserving_first_page_review(tmp_path,monkeypatch):
    from engine.batch_store import BatchStore
    from engine.batch_review import save_batch_receipt_review,read_batch_receipt_review_page
    from engine.receipt_layout_reference import save_reference_layout
    from tests.test_receipt_layout_review import _ready,_prepared
    from tests.test_receipt_batch_pdf import ALL
    from tests.test_batch_receipt_review_api import _make_edit
    from tests.test_receipt_template_apply import _apply,_save
    monkeypatch.setenv('PDF_SEARCH_PRIVATE_TEMP',str(tmp_path/'private'))
    monkeypatch.setattr("engine.crop_templates.image_masthead_lines",lambda *_: [])
    review=templates=tmp_path/'pdf-search.sqlite3'
    path=_two_page_source(tmp_path)
    before=sha256(path.read_bytes()).hexdigest()
    with BatchStore(tmp_path/'tasks.sqlite3') as store:
        ready=_ready(store,[path],ALL)
        prepared=_prepared(store,ready,review)
        assert len(prepared.eligible_page_keys)==2
        originals=store.review_snapshot(ready['id'],ready['result_revision'])['originals']
        edits=[_make_edit(prepared.context_key,ready['result_revision'],item) for item in originals if item['source_page']==1]
        save_batch_receipt_review(store,ready['id'],ready['result_revision'],edits,review)
        first=read_batch_receipt_review_page(store,ready['id'],ready['result_revision'],0,200,review)['items'][:3]
        draft=deepcopy(prepared.layout)
        for slot,top in zip(draft['slots'],(45,320,600)):
            slot.update(top_pt=top,height_pt=205)
        draft['uniform_height']=True
        template=save_reference_layout(draft,templates,'synthetic-reviewed-layout')
        preview=_apply(store,ready,review,templates,template['id'])
        assert preview['can_save'] and preview['page_count']==1
        assert preview['excluded_page_counts']=={'prior_review_scope':1}
        assert {item['page'] for item in preview['affected']}=={2}
        saved=_save(store,ready,review,templates,preview)
        after=read_batch_receipt_review_page(store,ready['id'],saved['result_revision'],0,200,review)['items']
        assert [item['original'] for item in after[:3]]==[item['original'] for item in first]
        for before_item, after_item in zip(first, after[:3], strict=True):
            assert {key:value for key,value in after_item['record'].items() if key not in {'record_revision','result_revision'}} == {
                key:value for key,value in before_item['record'].items() if key not in {'record_revision','result_revision'}}
            assert after_item['record']['record_revision']==before_item['record']['record_revision']+1
        assert len(after)==6 and len({item['original']['id'] for item in after})==6
        assert all(item['record'] is None for item in after[3:])
    assert sha256(path.read_bytes()).hexdigest()==before


def test_compatible_form_does_not_allow_cropping_away_its_body(tmp_path,monkeypatch):
    from engine.batch_store import BatchStore,BatchConflict
    from engine.receipt_layout_reference import save_reference_layout
    from tests.test_receipt_layout_review import _ready,_prepared
    from tests.test_receipt_batch_pdf import ALL
    from tests.test_receipt_template_apply import _apply,_save
    monkeypatch.setenv('PDF_SEARCH_PRIVATE_TEMP',str(tmp_path/'private'))
    monkeypatch.setattr("engine.crop_templates.image_masthead_lines",lambda *_: [])
    review=templates=tmp_path/'pdf-search.sqlite3'
    with BatchStore(tmp_path/'tasks.sqlite3') as store:
        ready=_ready(store,[_two_page_source(tmp_path)],ALL)
        prepared=_prepared(store,ready,review)
        draft=deepcopy(prepared.layout)
        for slot,top in zip(draft['slots'],(45,320,600)):
            slot.update(top_pt=top,height_pt=40)
        draft['uniform_height']=True
        template=save_reference_layout(draft,templates,'synthetic-too-short')
        preview=_apply(store,ready,review,templates,template['id'])
        assert not preview['can_save'] and preview['blockers']
        assert {item['code'] for item in preview['blockers']}=={'template_content_outside_crop'}
        with pytest.raises(BatchConflict):_save(store,ready,review,templates,preview)
        assert store.get_job(ready['id'])['result_revision']==ready['result_revision']


def test_active_legacy_template_no_targets_is_not_reported_as_deactivated(tmp_path,monkeypatch):
    from engine.batch_store import BatchStore
    from engine.batch_api import handle_batch_request
    from engine.receipt_layout_reference import save_reference_layout
    from engine.layout_template_store import LayoutTemplateStore
    from tests.test_receipt_layout_review import _ready,_prepared
    from tests.test_receipt_batch_pdf import ALL
    monkeypatch.setenv('PDF_SEARCH_PRIVATE_TEMP',str(tmp_path/'private'))
    monkeypatch.setattr("engine.crop_templates.image_masthead_lines",lambda *_: [])
    review=templates=tmp_path/'pdf-search.sqlite3';database=tmp_path/'tasks.sqlite3'
    with BatchStore(database) as store:
        ready=_ready(store,[_two_page_source(tmp_path)],ALL)
        prepared=_prepared(store,ready,review)
        legacy={**deepcopy(prepared.layout),'issuer_id':'a'*64,'family_id':'b'*64,'evidence_version':'receipt-layout-evidence-v1'}
        template=save_reference_layout(legacy,templates,'synthetic-legacy-layout')
        request={'op':'batch_receipt_template_apply_preview','database_path':str(database),'job_id':ready['id'],
                 'result_revision':ready['result_revision'],'template_id':template['id'],
                 'review_database_path':str(review),'template_database_path':str(templates)}
        response=handle_batch_request(request)
        assert response['code']=='template_no_compatible_pages'
        assert '另存新模板' in response['message'] and '原模板仍保留' in response['message']
        assert LayoutTemplateStore(templates).list_page()['items'][0]['active']
        LayoutTemplateStore(templates).deactivate(template['id'])
        assert handle_batch_request(request)['code']=='template_unavailable'


def test_template_crop_proof_unavailable_must_block_instead_of_skipping_guard(tmp_path, monkeypatch):
    from engine.batch_store import BatchStore
    from engine.receipt_layout_reference import save_reference_layout
    from tests.test_receipt_layout_review import _ready, _prepared
    from tests.test_receipt_batch_pdf import ALL
    from tests.test_receipt_template_apply import _apply
    monkeypatch.setenv('PDF_SEARCH_PRIVATE_TEMP', str(tmp_path / 'private'))
    monkeypatch.setattr('engine.crop_templates.image_masthead_lines', lambda *_: [])
    review = tmp_path / 'review.sqlite3'
    with BatchStore(tmp_path / 'tasks.sqlite3') as store:
        ready = _ready(store, [_two_page_source(tmp_path)], ALL)
        prepared = _prepared(store, ready, review)
        template = save_reference_layout(prepared.layout, review, 'synthetic-unavailable-proof')
        monkeypatch.setattr('engine.batch_pdf.BatchPdfSource.verified_template_crop_envelopes', lambda *_: ())
        preview = _apply(store, ready, review, review, template['id'])
        assert not preview['can_save']
        assert {item['code'] for item in preview['blockers']} == {'template_content_outside_crop'}


@pytest.mark.parametrize(('height', 'proof_missing', 'applied'), [(40, False, False), (205, True, False), (205, False, True)])
def test_automatic_history_requires_complete_current_body_and_available_proof(tmp_path, monkeypatch, height, proof_missing, applied):
    from engine.batch_pdf import open_batch_source
    from engine.receipt_layout_reference import historical_reference, save_reference_layout
    from engine.search import SearchBudget
    from tests.test_receipt_batch_pdf import ALL
    monkeypatch.setenv('PDF_SEARCH_PRIVATE_TEMP', str(tmp_path / 'private'))
    monkeypatch.setattr('engine.crop_templates.image_masthead_lines', lambda *_: [])
    source = _two_page_source(tmp_path)
    with open_batch_source(source, sha256(source.read_bytes()).hexdigest()) as opened:
        current = opened.compute_receipt_page(2, ALL, 'exact', SearchBudget())
        draft = deepcopy(current.result['layout_definition'])
        for slot, top in zip(draft['slots'], (45, 320, 600)):
            slot.update(top_pt=top, height_pt=height)
        draft['uniform_height'] = True
        template = save_reference_layout(draft, tmp_path / 'templates.sqlite3', 'synthetic-history')
        if proof_missing:
            monkeypatch.setattr('engine.batch_pdf.BatchPdfSource.verified_template_crop_envelopes', lambda *_: ())
        recomputed = opened.compute_receipt_page(2, ALL, 'exact', SearchBudget(),
            historical_layouts=(historical_reference(template),))
        assert recomputed.suggestion.needs_review
        if applied:
            assert recomputed.result['layout_definition']['slots'] == draft['slots']
            assert {'code': 'historical_layout_applied'} in recomputed.diagnostics
        else:
            assert recomputed.result['layout_definition'] == current.result['layout_definition']
            assert {'code': 'reference_layout_conflict'} in recomputed.diagnostics
            assert not any(item['code'] == 'historical_layout_applied' for item in recomputed.diagnostics)
