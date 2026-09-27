"""Pure schema-3 review snapshots from complete schema-2 checkpoints.

No PDF is opened and no review state is written here. Publishing must compare
this reconstruction against the proposed snapshot under the store's owner CAS.
The standalone item validator checks structure/identity/geometry, not the
authenticity of a signature whose checkpoint diagnostics are deliberately not
duplicated into every item.
"""
from __future__ import annotations

from collections.abc import Iterable
from copy import deepcopy
import hashlib
import math
import re
from typing import Any
import unicodedata

from .batch_models import (
    BUDGET_LIMITS, MAX_IDENTIFIER_BYTES, MAX_JSON_BYTES, MAX_JSON_ITEMS, MAX_PATH_BYTES,
    MAX_RESULTS_PAGE_BYTES, MAX_SOURCES, MAX_VERSION_BYTES, canonical_json, clone_json,
    normalize_match_mode, validate_budget,
)
from .receipt_checkpoint import validate_receipt_checkpoint
from .receipt_layout_models import (
    MAX_LAYOUT_SLOTS, MAX_SAFE_INTEGER, MIN_CROP_SIZE, make_instance_id, near,
    parse_page_geometry, parse_processing_options,
)


MAX_SNAPSHOT_ITEMS = 50_000
_SHA = re.compile(r'[a-f0-9]{64}\Z')
_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z')
_INCLUDE = re.compile(r'include-(?:[0-9]|[12][0-9]|3[01])\Z')
_RECT = ('x0', 'y0', 'x1', 'y1')
_ORIGINAL_FIELDS = frozenset({
    'id', 'source_key', 'source_page', 'instance_id', 'slot_id', 'position_index',
    'layout_id', 'layout_revision', 'layout_signature', 'page_geometry',
    'candidate_rect', 'occupancy', 'selection_basis', 'needs_review', 'analysis_signature',
})
_SEGMENT_FIELDS = _ORIGINAL_FIELDS | {
    'source_path', 'source_sha256', 'final_rect', 'crop_mode', 'review_status', 'manual_adjusted',
}
_ROW_FIELDS = {'source_id', 'page', 'payload', 'budget', 'sha256'}


class ReceiptSnapshotError(ValueError):
    """A durable result cannot establish a complete, consistent snapshot."""


def _require(condition: object, message: str) -> None:
    if not condition:
        raise ReceiptSnapshotError(message)


def _digest(value: object) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def _text(value: Any, limit: int) -> bool:
    if not isinstance(value, str) or not value.strip() or '\0' in value or len(value) > limit:
        return False
    try:
        return len(value.encode('utf-8', 'strict')) <= limit
    except UnicodeError:
        return False


def _positive_int(value: Any) -> bool:
    return type(value) is int and 0 < value <= MAX_SAFE_INTEGER


def _sha(value: Any) -> bool:
    return isinstance(value, str) and _SHA.fullmatch(value) is not None


def _normalize_path(path: str) -> str:
    return unicodedata.normalize('NFC', path.strip()).replace('\\', '/').lower()


def _absolute_path(path: str) -> bool:
    normalized = path.replace('\\', '/')
    return normalized.startswith('/') or bool(re.match(r'^[A-Za-z]:/', normalized))


def processing_fingerprint(processing_options: object, match_mode: object) -> str:
    """Canonical task binding shared by schema-2 jobs and schema-3 snapshots."""
    try:
        return _digest({'page_result_schema': 2, 'layout_schema_version': 1,
                        'processing_options': parse_processing_options(processing_options),
                        'match_mode': normalize_match_mode(match_mode)})
    except (ValueError, TypeError, OverflowError) as exc:
        raise ReceiptSnapshotError('invalid receipt processing context') from exc


def _rect(value: Any, geometry: dict[str, Any], *, crop: bool) -> dict[str, float]:
    _require(isinstance(value, dict) and set(value) == set(_RECT), 'invalid snapshot rectangle')
    try:
        _require(all(type(value[key]) in (int, float) for key in _RECT), 'invalid snapshot rectangle number')
        result = {key: float(value[key]) for key in _RECT}
        _require(all(math.isfinite(number) for number in result.values()), 'nonfinite snapshot rectangle')
    except OverflowError as exc:
        raise ReceiptSnapshotError('snapshot rectangle exceeds numeric range') from exc
    for axis, size in (('x', geometry['width_pt']), ('y', geometry['height_pt'])):
        start, end = result[axis + '0'], result[axis + '1']
        _require(start < end and (start >= 0 or near(start, 0)) and (end <= size or near(end, size)),
                 'snapshot rectangle is outside the visible page')
        if crop:
            if size < MIN_CROP_SIZE:
                _require(start == 0 and end == size, 'small page dimension must be retained in full')
            else:
                _require(end - start >= MIN_CROP_SIZE or near(end - start, MIN_CROP_SIZE),
                         'snapshot crop is below minimum size')
    return result


def _contains(outer: dict[str, float], inner: dict[str, float]) -> bool:
    return all(outer[key] <= inner[key] or near(outer[key], inner[key]) for key in ('x0', 'y0')) and all(
        inner[key] <= outer[key] or near(inner[key], outer[key]) for key in ('x1', 'y1'))


def _intersects(a: dict[str, float], b: dict[str, float]) -> bool:
    return min(a['x1'], b['x1']) > max(a['x0'], b['x0']) and min(a['y1'], b['y1']) > max(a['y0'], b['y0'])


def validate_receipt_snapshot_item(item: object) -> dict[str, Any]:
    """Validate a newly assembled immutable item, returning a deep JSON copy.

    This validates initial candidate geometry/status only. Editable review rows
    have a separate lifecycle and must not replace their registered original.
    A store must verify analysis signatures by reconstructing from checkpoints.
    """
    try:
        checked = clone_json(item, max_bytes=MAX_RESULTS_PAGE_BYTES)
        _require(isinstance(checked, dict) and set(checked) == {'segment', 'evidence', 'original'},
                 'invalid receipt snapshot item fields')
        original, segment = checked['original'], checked['segment']
        _require(isinstance(original, dict) and set(original) == _ORIGINAL_FIELDS, 'invalid original fields')
        _require(isinstance(segment, dict) and set(segment) == _SEGMENT_FIELDS, 'invalid segment fields')
        # Python equality equates True with 1. An immutable JSON binding must
        # also preserve the actual primitive types of every nested field.
        _require(canonical_json({key: segment[key] for key in _ORIGINAL_FIELDS}) == canonical_json(original),
                 'segment original binding differs')
        _require(all(_sha(original[key]) for key in ('id', 'layout_signature', 'analysis_signature')),
                 'invalid snapshot digest')
        _require(_text(original['source_key'], MAX_PATH_BYTES)
                 and _normalize_path(original['source_key']) == original['source_key'], 'invalid source key')
        _require(_text(segment['source_path'], MAX_PATH_BYTES) and _absolute_path(segment['source_path']),
                 'invalid source access path')
        _require(_sha(segment['source_sha256']), 'invalid source SHA')
        for key in ('source_page', 'position_index', 'layout_revision'):
            _require(_positive_int(original[key]), 'invalid snapshot position or revision')
        _require(original['position_index'] <= MAX_LAYOUT_SLOTS, 'invalid slot position')
        for key in ('slot_id', 'layout_id'):
            _require(isinstance(original[key], str) and _ID.fullmatch(original[key]), 'invalid layout identity')
        expected_id = make_instance_id(segment['source_sha256'], original['source_page'],
            {'layout_id': original['layout_id'], 'revision': original['layout_revision'],
             'slots': [{'slot_id': original['slot_id']}]}, original['slot_id'])
        _require(original['instance_id'] == expected_id, 'instance is not bound to its source and layout')
        geometry = parse_page_geometry(original['page_geometry'])
        candidate = _rect(original['candidate_rect'], geometry, crop=True)
        final = _rect(segment['final_rect'], geometry, crop=True)
        _require(final == candidate, 'initial final rectangle differs from the candidate')
        _require(type(original['needs_review']) is bool, 'invalid review flag')
        _require(original['occupancy'] in {'occupied', 'uncertain'}, 'invalid occupancy')
        _require(original['selection_basis'] in {'keyword', 'occupied_slot', 'manual_slot'}, 'invalid selection basis')
        _require(original['occupancy'] != 'uncertain' or original['selection_basis'] == 'manual_slot'
                 or original['needs_review'], 'uncertain occupancy is missing review')
        _require(segment['crop_mode'] == 'candidate' and segment['manual_adjusted'] is False,
                 'initial snapshot contains manual review changes')
        _require(segment['review_status'] == ('needs_review' if original['needs_review'] else 'confirmed'),
                 'initial review status differs from its original')
        evidence = checked['evidence']
        _require(isinstance(evidence, list) and len(evidence) <= 10_000, 'invalid evidence array')
        _require(bool(evidence) == (original['selection_basis'] == 'keyword'), 'selection basis and evidence disagree')
        for hit in evidence:
            _require(isinstance(hit, dict) and set(hit) == {'query_id', 'rect'}, 'invalid evidence fields')
            _require(isinstance(hit['query_id'], str) and _INCLUDE.fullmatch(hit['query_id']), 'invalid evidence query')
            hit_rect = _rect(hit['rect'], geometry, crop=False)
            _require(_intersects(candidate, hit_rect) and (_contains(candidate, hit_rect) or original['needs_review']),
                     'evidence lies outside its candidate without review')
        return checked
    except ReceiptSnapshotError:
        raise
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        raise ReceiptSnapshotError('invalid receipt snapshot item') from exc


def _bound_queries(checkpoint: dict[str, Any], options: dict[str, Any]) -> None:
    receipt = checkpoint['receipt_page']
    _require(receipt['processing_mode'] == options['processing_mode'], 'checkpoint processing mode differs')
    criteria = options['criteria']
    includes = set() if criteria is None else {f'include-{i}' for i in range(len(criteria['include']))}
    excludes = set() if criteria is None else {f'exclude-{i}' for i in range(len(criteria['exclude']))}
    for candidate in receipt['candidates']:
        queries = {hit['query_id'] for hit in candidate['evidence']}
        _require(queries <= includes, 'checkpoint refers to an unknown include query')
        if criteria is not None:
            _require(queries and (criteria['includeMode'] == 'any' or queries == includes),
                     'checkpoint does not satisfy the task include clauses')
    for diagnostic in checkpoint['diagnostics']:
        query = diagnostic.get('query_id')
        _require(query is None or query in includes | excludes, 'checkpoint diagnostic refers to an unknown query')


def _assemble_page(job_id: str, source: dict[str, Any], checkpoint: dict[str, Any]) -> list[dict[str, Any]]:
    receipt = checkpoint['receipt_page']
    layout = receipt['layout_definition']
    layout_signature = _digest(layout)
    by_id = {instance['instance_id']: instance for instance in receipt['instances']}
    # Index/hash validated diagnostics once. A thousand slots with a thousand
    # individual risks must not copy or rescan the full page for every item.
    global_diagnostics: list[str] = []
    slot_diagnostics: dict[str, list[str]] = {}
    instance_diagnostics: dict[str, list[str]] = {}
    references = 0
    for diagnostic in checkpoint['diagnostics']:
        digest = _digest(diagnostic)
        if 'slot_id' in diagnostic:
            slot_diagnostics.setdefault(diagnostic['slot_id'], []).append(digest)
        elif diagnostic.get('instance_ids'):
            for instance_id in diagnostic['instance_ids']:
                references += 1
                _require(references <= MAX_JSON_ITEMS, 'snapshot diagnostic summary exceeds work budget')
                instance_diagnostics.setdefault(instance_id, []).append(digest)
        else:
            global_diagnostics.append(digest)
    global_summary = _digest(global_diagnostics)
    slot_summaries = {key: _digest(values) for key, values in slot_diagnostics.items()}
    instance_summaries = {key: _digest(values) for key, values in instance_diagnostics.items()}
    items = []
    for candidate in sorted(receipt['candidates'], key=lambda item: by_id[item['instance_id']]['position_index']):
        instance = by_id[candidate['instance_id']]
        applicable = {'page': global_summary, 'slot': slot_summaries.get(instance['slot_id']),
                      'instance': instance_summaries.get(instance['instance_id'])}
        original = {
            'id': _digest([job_id, source['source_id'], instance['instance_id']]),
            'source_key': source['source_key'], 'source_page': receipt['page'],
            **{key: instance[key] for key in ('instance_id', 'slot_id', 'position_index', 'layout_id', 'layout_revision')},
            'layout_signature': layout_signature, 'page_geometry': deepcopy(layout['page_geometry']),
            'candidate_rect': deepcopy(instance['rect']), 'occupancy': instance['occupancy'],
            'selection_basis': candidate['selection_basis'], 'needs_review': candidate['needs_review'],
        }
        evidence = deepcopy(candidate['evidence'])
        # The row id belongs to the publishing job. An identical analysis of
        # the same logical source may restore its review under a new job/id;
        # all content/slot/geometry evidence remains bound independently.
        signature_original = {key: value for key, value in original.items() if key != 'id'}
        original['analysis_signature'] = _digest({'original': signature_original, 'evidence': evidence,
            'diagnostics': applicable, 'suggestion': checkpoint['suggestion']})
        segment = {**deepcopy(original), 'source_path': source['access_path'], 'source_sha256': source['sha256'],
                   'final_rect': deepcopy(original['candidate_rect']), 'crop_mode': 'candidate',
                   'review_status': 'needs_review' if original['needs_review'] else 'confirmed', 'manual_adjusted': False}
        items.append(validate_receipt_snapshot_item({'segment': segment, 'evidence': evidence, 'original': original}))
    return items


def assemble_receipt_results(job_id: str, sources: list[dict[str, Any]], processing_options: dict[str, Any],
                            match_mode: str, computation_version: str,
                            page_results: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Reconstruct a complete immutable snapshot; zero-hit pages are mandatory."""
    try:
        _require(_text(job_id, MAX_IDENTIFIER_BYTES) and _text(computation_version, MAX_VERSION_BYTES),
                 'invalid receipt task identity')
        options = parse_processing_options(processing_options)
        mode = normalize_match_mode(match_mode)
        _require(isinstance(sources, list) and 0 < len(sources) <= MAX_SOURCES, 'invalid receipt source count')
        # The source collection follows the existing bounded JSON manifest.
        checked_sources = clone_json(sources, max_bytes=MAX_JSON_BYTES)
        source_by_id = {}
        source_keys = set()
        expected_pages = 0
        for position, source in enumerate(checked_sources):
            _require(isinstance(source, dict) and type(source.get('position')) is int and source['position'] == position,
                     'sources are not in import order')
            _require(_text(source.get('source_id'), MAX_IDENTIFIER_BYTES) and source['source_id'] not in source_by_id,
                     'duplicate or invalid persisted source identity')
            _require(all(_text(source.get(key), MAX_PATH_BYTES) for key in ('source_key', 'initial_path', 'access_path')),
                     'invalid source paths')
            _require(source['source_key'] == _normalize_path(source['initial_path'])
                     and source['source_key'] not in source_keys
                     and _absolute_path(source['initial_path']) and _absolute_path(source['access_path']),
                     'duplicate or inconsistent source path binding')
            _require(_sha(source.get('sha256')) and _positive_int(source.get('page_count')), 'source lacks SHA/page binding')
            expected_pages += source['page_count']
            _require(expected_pages <= BUDGET_LIMITS['processed_pages'], 'source pages exceed task budget')
            source_keys.add(source['source_key'])
            source_by_id[source['source_id']] = source
        by_source: dict[str, dict[int, list]] = {key: {} for key in source_by_id}
        count, item_count = 0, 0
        for incoming in page_results:
            count += 1
            _require(count <= expected_pages, 'too many durable pages')
            _require(isinstance(incoming, dict) and set(incoming) == _ROW_FIELDS, 'invalid durable row fields')
            source_id = incoming['source_id']
            _require(isinstance(source_id, str) and source_id in source_by_id, 'unknown durable source')
            source = source_by_id[source_id]
            checkpoint = validate_receipt_checkpoint(incoming['payload'])
            page = checkpoint['page']
            _require(type(incoming['page']) is int and page == incoming['page'] and page <= source['page_count']
                     and page not in by_source[source_id], 'duplicate or inconsistent durable page')
            _require(checkpoint['receipt_page']['source_sha256'] == source['sha256'], 'checkpoint source SHA differs')
            _require(_sha(incoming['sha256']) and incoming['sha256'] == _digest(checkpoint), 'checkpoint checksum differs')
            _require(isinstance(incoming['budget'], dict), 'durable budget must be JSON metadata')
            validate_budget(incoming['budget'])
            _bound_queries(checkpoint, options)
            item_count += len(checkpoint['receipt_page']['candidates'])
            _require(item_count <= MAX_SNAPSHOT_ITEMS, 'snapshot exceeds item budget')
            by_source[source_id][page] = _assemble_page(job_id, source, checkpoint)
        _require(all(len(by_source[key]) == source['page_count'] for key, source in source_by_id.items()),
                 'snapshot has incomplete durable pages')
        items = [item for source_id in source_by_id for page in sorted(by_source[source_id])
                 for item in by_source[source_id][page]]
        context = {'version': 3,
            'sources': [{'source_key': source['source_key'], 'source_path': source['access_path'],
                         'source_sha256': source['sha256']} for source in source_by_id.values()],
            'criteria_fingerprint': processing_fingerprint(options, mode), 'computation_version': computation_version,
            'processing_options': deepcopy(options), 'match_mode': mode}
        return {'context': context, 'originals': [deepcopy(item['original']) for item in items], 'items': items}
    except ReceiptSnapshotError:
        raise
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        raise ReceiptSnapshotError('invalid receipt checkpoint collection') from exc
