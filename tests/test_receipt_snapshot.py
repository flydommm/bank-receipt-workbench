"""Schema-3 snapshots assembled solely from synthetic durable checkpoints."""
from copy import deepcopy
import hashlib

import pytest

from engine.batch_models import canonical_json
from engine.receipt_layout import suggest_equal_slots
from engine.receipt_layout_models import make_instance_id, slot_rect
from engine.receipt_snapshot import (
    ReceiptSnapshotError, assemble_receipt_results, processing_fingerprint, validate_receipt_snapshot_item,
)


SHA = 'a' * 64
GEOMETRY = {'pdf_box': {'x0': 0, 'y0': 0, 'x1': 600, 'y1': 900}, 'rotation': 0,
            'user_unit': 1, 'width_pt': 600, 'height_pt': 900}
SEARCH = {'processing_mode': 'search', 'criteria': {'include': ['fee'], 'includeMode': 'all', 'exclude': []}}
SPLIT = {'processing_mode': 'split_all', 'criteria': None}


def source(index=0, count=1):
    path = f'/documents/source-{index}.pdf'
    return {'source_id': f's{index}', 'source_key': path, 'position': index,
            'initial_path': path, 'access_path': path, 'sha256': SHA, 'page_count': count}


def durable(index=0, page=1, *, positions=(3,), mode='search', review=False, query_ids=('include-0',)):
    layout = suggest_equal_slots(GEOMETRY, 3).layout_definition
    instances = [{'instance_id': make_instance_id(SHA, page, layout, slot['slot_id']), 'source_sha256': SHA,
                  'page': page, 'layout_id': layout['layout_id'], 'layout_revision': layout['revision'],
                  'slot_id': slot['slot_id'], 'position_index': slot['position_index'],
                  'rect': slot_rect(layout, slot), 'occupancy': 'occupied'} for slot in layout['slots']]
    candidates = []
    for instance in reversed(instances):
        if mode == 'search' and instance['position_index'] not in positions:
            continue
        candidates.append({'instance_id': instance['instance_id'], 'needs_review': review,
            'selection_basis': 'keyword' if mode == 'search' else 'occupied_slot',
            'evidence': [{'query_id': query, 'rect': {'x0': 20, 'y0': instance['rect']['y0'] + 20,
                        'x1': 150, 'y1': instance['rect']['y0'] + 40}} for query in query_ids] if mode == 'search' else []})
    payload = {'schema': 2, 'page': page, 'receipt_page': {'schema_version': 1, 'page': page,
        'source_sha256': SHA, 'processing_mode': mode, 'layout_definition': layout,
        'instances': instances, 'excluded_slots': [], 'candidates': candidates},
        'suggestion': {'basis': 'page_evidence', 'needs_review': review}, 'diagnostics': []}
    # Durable storage hashes the normalized checkpoint rather than the caller's
    # original int/float spelling.
    from engine.receipt_checkpoint import validate_receipt_checkpoint
    payload = validate_receipt_checkpoint(payload)
    return {'source_id': f's{index}', 'page': page, 'payload': payload,
            'sha256': hashlib.sha256(canonical_json(payload)).hexdigest(),
            'budget': {'processed_pages': 1, 'text_characters': 3, 'fuzzy_work': 0,
                       'matches': len(candidates), 'matched_text_characters': 3}}


def refresh(row):
    from engine.receipt_checkpoint import validate_receipt_checkpoint
    try:
        row['payload'] = validate_receipt_checkpoint(row['payload'])
    except ValueError:
        pass  # Deliberately malformed shape still needs a fresh checksum.
    row['sha256'] = hashlib.sha256(canonical_json(row['payload'])).hexdigest()
    return row


def assemble(rows=None, sources=None, options=None):
    return assemble_receipt_results('job-test', sources or [source()], options or SEARCH,
                                    'exact', 'synthetic-v3', rows if rows is not None else [durable()])


def test_third_slot_keeps_position_identity_and_real_evidence():
    result = assemble()
    item = result['items'][0]
    segment, original = item['segment'], item['original']
    assert original['position_index'] == 3 and original['slot_id'] == 'slot-3'
    assert segment['final_rect'] == original['candidate_rect'] == {'x0': 0, 'y0': 600, 'x1': 600, 'y1': 900}
    assert segment['crop_mode'] == 'candidate' and segment['review_status'] == 'confirmed'
    assert not segment['manual_adjusted']
    assert item['evidence'] == durable()['payload']['receipt_page']['candidates'][0]['evidence']
    assert not {'confidence', 'match_rect', 'match_text', 'segment_no'} & segment.keys()
    assert result['context']['version'] == 3
    assert validate_receipt_snapshot_item(item) == item


def test_mode_switch_changes_processing_fingerprint_and_keeps_instance_identity():
    searched = assemble()
    split = assemble(rows=[durable(mode='split_all')], options=SPLIT)
    assert [item['segment']['position_index'] for item in split['items']] == [1, 2, 3]
    assert all(item['evidence'] == [] for item in split['items'])
    assert split['items'][2]['segment']['id'] == searched['items'][0]['segment']['id']
    assert searched['context']['criteria_fingerprint'] != split['context']['criteria_fingerprint']
    normalized = deepcopy(SEARCH)
    normalized['criteria']['include'] = [' fee ', 'fee']
    assert processing_fingerprint(normalized, 'exact') == processing_fingerprint(SEARCH, 'exact')


def test_import_page_and_true_position_order_and_same_sha_distinct_sources():
    rows = [durable(1), durable(page=2, positions=(1, 3)), durable(positions=())]
    result = assemble(rows, [source(count=2), source(1)])
    assert [(item['segment']['source_key'], item['segment']['source_page'], item['segment']['position_index'])
            for item in result['items']] == [('/documents/source-0.pdf', 2, 1), ('/documents/source-0.pdf', 2, 3),
                                             ('/documents/source-1.pdf', 1, 3)]
    two = assemble([durable(), durable(1)], [source(), source(1)])
    assert two['items'][0]['segment']['instance_id'] == two['items'][1]['segment']['instance_id']
    assert two['items'][0]['segment']['id'] != two['items'][1]['segment']['id']


def test_zero_match_pages_are_required_and_bound_even_without_snapshot_items():
    with pytest.raises(ReceiptSnapshotError):
        assemble([durable()], [source(count=2)])
    assert assemble([durable(positions=())])['items'] == []
    bad = durable(positions=())
    bad['payload']['receipt_page']['source_sha256'] = 'b' * 64
    bad['payload']['receipt_page']['instances'] = []
    bad['payload']['receipt_page']['excluded_slots'] = [
        {'slot_id': f'slot-{position}', 'reason': 'blank'} for position in (1, 2, 3)]
    with pytest.raises(ReceiptSnapshotError):
        assemble([refresh(bad)])


@pytest.mark.parametrize('mutation', [
    lambda row: row.update(sha256='0' * 64),
    lambda row: row.update(page=2),
    lambda row: row.update(source_id='unknown'),
    lambda row: row['payload'].update(schema=1),
    lambda row: row['payload']['receipt_page'].update(processing_mode='split_all'),
    lambda row: row['payload']['receipt_page']['candidates'][0]['evidence'][0].update(query_id='include-1'),
    lambda row: row['payload'].update(diagnostics=[{'code': 'unassigned_block', 'query_id': 'exclude-9',
                                                  'rect': {'x0': 0, 'y0': 0, 'x1': 20, 'y1': 20}, 'instance_ids': []}]),
    lambda row: row.update(payload=b'not JSON'),
])
def test_rejects_mismatched_durable_source_page_schema_queries_and_bytes(mutation):
    row = durable()
    mutation(row)
    if isinstance(row['payload'], dict) and row['sha256'] != '0' * 64:
        refresh(row)
    with pytest.raises(ReceiptSnapshotError):
        assemble([row])


def test_all_requires_each_include_while_any_accepts_one():
    options = deepcopy(SEARCH)
    options['criteria']['include'] = ['fee', 'bank']
    with pytest.raises(ReceiptSnapshotError):
        assemble(options=options)
    assert len(assemble([durable(query_ids=('include-0', 'include-1'))], options=options)['items']) == 1
    options['criteria']['includeMode'] = 'any'
    assert len(assemble(options=options)['items']) == 1


def test_deep_copies_and_binds_diagnostic_and_complete_layout_changes():
    row = durable(review=True)
    before = deepcopy(row)
    result = assemble([row])
    assert row == before
    variant = deepcopy(row)
    variant['payload']['diagnostics'] = [{'code': 'occupancy_uncertain', 'slot_id': 'slot-3'}]
    changed = assemble([refresh(variant)])
    assert changed['originals'][0]['analysis_signature'] != result['originals'][0]['analysis_signature']
    result['items'][0]['segment']['candidate_rect']['y0'] = 123
    result['items'][0]['evidence'][0]['rect']['x0'] = 99
    assert result['originals'][0]['candidate_rect']['y0'] == 600
    assert row == before


@pytest.mark.parametrize('mutation', [
    lambda item: item['segment'].update(confidence=.99),
    lambda item: item['segment'].update(source_sha256='b' * 64),
    lambda item: item['segment'].update(position_index=1),
    lambda item: item['segment'].update(crop_mode='full_page'),
    lambda item: item['segment'].update(manual_adjusted=True),
    lambda item: item['original'].update(analysis_signature='bad'),
    lambda item: item['evidence'][0]['rect'].update(y0=0, y1=100),
    lambda item: item['segment']['final_rect'].update(y0=610),
])
def test_strict_snapshot_item_rejects_fabrication_and_inconsistent_geometry(mutation):
    item = assemble()['items'][0]
    mutation(item)
    with pytest.raises(ReceiptSnapshotError):
        validate_receipt_snapshot_item(item)


def test_keyword_cross_slot_evidence_requires_review_and_positive_intersection():
    row = durable(review=True)
    row['payload']['receipt_page']['candidates'][0]['evidence'][0]['rect'].update(y0=590, y1=620)
    item = assemble([refresh(row)])['items'][0]
    assert validate_receipt_snapshot_item(item) == item
    item['original']['needs_review'] = item['segment']['needs_review'] = False
    item['segment']['review_status'] = 'confirmed'
    with pytest.raises(ReceiptSnapshotError):
        validate_receipt_snapshot_item(item)


@pytest.mark.parametrize('field', ['source_page', 'position_index', 'layout_revision', 'needs_review'])
def test_segment_original_comparison_does_not_equate_booleans_with_numbers(field):
    item = assemble([durable(positions=(1,), review=True)])['items'][0]
    item['segment'][field] = 1 if field == 'needs_review' else True
    with pytest.raises(ReceiptSnapshotError):
        validate_receipt_snapshot_item(item)


def test_complete_layout_signature_binds_non_geometric_layout_metadata():
    row = durable()
    initial = assemble([row])
    row['payload']['receipt_page']['layout_definition']['workspace_id'] = 'other-workspace'
    changed = assemble([refresh(row)])
    assert initial['originals'][0]['instance_id'] == changed['originals'][0]['instance_id']
    assert initial['originals'][0]['layout_signature'] != changed['originals'][0]['layout_signature']
    assert initial['originals'][0]['analysis_signature'] != changed['originals'][0]['analysis_signature']


@pytest.mark.parametrize('change', [
    lambda sources: sources[0].update(sha256='A' * 64),
    lambda sources: sources[0].update(position=True),
    lambda sources: sources[0].update(page_count=True),
    lambda sources: sources[0].update(source_key='/elsewhere.pdf'),
    lambda sources: sources[0].update(access_path='relative.pdf'),
    lambda sources: sources[0].update(initial_path='\ud800'),
    lambda sources: sources[0].update(source_id='x' * 1025),
])
def test_source_manifest_is_strictly_bound_and_utf8_bounded(change):
    values = [source()]
    change(values)
    with pytest.raises(ReceiptSnapshotError):
        assemble(sources=values)


def test_rejects_duplicate_page_and_zero_match_row_checksum_corruption():
    with pytest.raises(ReceiptSnapshotError):
        assemble([durable(), durable()], [source(count=2)])
    row = durable(positions=())
    row['sha256'] = '0' * 64
    with pytest.raises(ReceiptSnapshotError):
        assemble([row])


def test_snapshot_byte_and_item_limits_are_checked_before_large_copy(monkeypatch):
    from engine import receipt_snapshot, receipt_checkpoint
    row = durable()
    monkeypatch.setattr(receipt_snapshot, 'MAX_SNAPSHOT_ITEMS', 0)
    with pytest.raises(ReceiptSnapshotError):
        assemble([row])
    monkeypatch.setattr(receipt_snapshot, 'MAX_SNAPSHOT_ITEMS', 50_000)
    item = assemble([row])['items'][0]
    monkeypatch.setattr(receipt_snapshot, 'MAX_RESULTS_PAGE_BYTES', 100)
    with pytest.raises(ReceiptSnapshotError):
        validate_receipt_snapshot_item(item)
    monkeypatch.setattr(receipt_checkpoint, 'MAX_CHECKPOINT_BYTES', 100)
    with pytest.raises(ReceiptSnapshotError):
        assemble([row])


def test_item_validator_returns_a_fully_independent_copy():
    item = assemble()['items'][0]
    before = deepcopy(item)
    copied = validate_receipt_snapshot_item(item)
    copied['original']['page_geometry']['pdf_box']['x0'] = 100
    copied['evidence'][0]['rect']['y0'] = 999
    assert item == before


def test_ids_use_job_persisted_source_and_instance_not_filtered_index():
    result = assemble([durable(positions=(1, 3))])
    third = result['items'][1]['original']
    assert third['id'] == hashlib.sha256(canonical_json(['job-test', 's0', third['instance_id']])).hexdigest()
    assert third['id'] == assemble()['items'][0]['original']['id']


def test_large_slot_definition_is_not_copied_into_each_snapshot_item():
    row = durable(mode='split_all')
    result = assemble([row], options=SPLIT)
    for item in result['items']:
        assert 'layout_definition' not in item and 'diagnostics' not in item
        assert 'layout_definition' not in item['segment'] and 'slots' not in item['segment']
        assert 'layout_definition' not in item['original'] and 'slots' not in item['original']


def test_thousand_slots_summarize_risks_once_and_only_bind_applicable_diagnostics():
    geometry = deepcopy(GEOMETRY)
    geometry['pdf_box']['y1'] = geometry['height_pt'] = 12_000
    layout = suggest_equal_slots(geometry, 1000).layout_definition
    row = durable(mode='split_all', review=True)
    receipt = row['payload']['receipt_page']
    receipt['layout_definition'] = layout
    receipt['instances'] = []
    receipt['candidates'] = []
    for slot in layout['slots']:
        instance_id = make_instance_id(SHA, 1, layout, slot['slot_id'])
        receipt['instances'].append({'instance_id': instance_id, 'source_sha256': SHA,
            'page': 1, 'layout_id': layout['layout_id'], 'layout_revision': layout['revision'],
            'slot_id': slot['slot_id'], 'position_index': slot['position_index'],
            'rect': slot_rect(layout, slot), 'occupancy': 'uncertain'})
        receipt['candidates'].append({'instance_id': instance_id, 'selection_basis': 'occupied_slot',
                                      'evidence': [], 'needs_review': True})
    row['payload']['diagnostics'] = [{'code': 'occupancy_uncertain', 'slot_id': slot['slot_id']} for slot in layout['slots']]
    result = assemble([refresh(row)], options=SPLIT)
    assert len(result['items']) == 1000
    assert len(canonical_json(result['items'][-1])) < 4000
    assert result['items'][-1]['segment']['position_index'] == 1000
    # Changing one slot's diagnostic must not invalidate another slot's proof.
    row['payload']['diagnostics'][-1] = {'code': 'uncertain_text', 'slot_id': 'slot-1000',
                                        'rect': {'x0': 20, 'y0': 11990, 'x1': 40, 'y1': 11999}}
    revised = assemble([refresh(row)], options=SPLIT)
    assert result['originals'][0]['analysis_signature'] == revised['originals'][0]['analysis_signature']
    assert result['originals'][-1]['analysis_signature'] != revised['originals'][-1]['analysis_signature']


def test_valid_checkpoint_cannot_be_rebound_to_another_processing_mode():
    with pytest.raises(ReceiptSnapshotError):
        assemble([durable(mode='split_all')], options=SEARCH)


def test_identical_analysis_keeps_proof_when_only_the_publishing_job_changes():
    first = assemble()
    other = assemble_receipt_results('another-job', [source()], SEARCH, 'exact', 'synthetic-v3', [durable()])
    assert first['context'] == other['context']
    before, after = first['originals'][0], other['originals'][0]
    assert before['id'] != after['id']
    assert before['analysis_signature'] == after['analysis_signature']
    assert before['instance_id'] == after['instance_id']
