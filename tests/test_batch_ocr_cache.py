"""Durable OCR reuse through production task execution with isolated synthetic PDFs."""
from hashlib import sha256
import json
import shutil
import subprocess
import sys

import pymupdf
import pytest

from engine import batch_pdf, ocr_cache
from engine.batch_pdf import BatchSourceError, open_batch_source
from engine.batch_processor import BatchProcessor, BatchProgress
from engine.batch_store import BatchStore
from engine.search import SearchBudget


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv('PDF_SEARCH_PRIVATE_TEMP', str(tmp_path / 'private'))


def make_pdf(tmp_path, native=False):
    path = tmp_path / 'source.pdf'
    with pymupdf.open() as document:
        for _ in range(2):
            page = document.new_page(width=600, height=800)
            page.draw_rect(pymupdf.Rect(30, 20, 570, 400))
            if native:
                page.insert_text((50, 60), 'fee bank')
        document.save(path)
    return path


def records():
    return [{'text': 'fee bank', 'box': [200, 200, 500, 250], 'confidence': 0.99}]


def run_job(database, path, keyword='fee'):
    with BatchStore(database) as store:
        store.activate_supervisor('cache-test')
        job = store.create_job('cache-test', [{'source_path': str(path), 'name': path.name}],
                               {'include': [keyword], 'includeMode': 'all', 'exclude': []}, 'exact', 'test-cache-v1')
        running = store.start_job(job['id'], 0, 'cache-test', 'test-cache-v1')
        ready = BatchProcessor(store, job['id'], running['generation'], 'cache-test', 'test-cache-v1',
                               BatchProgress(lambda *_: None)).run()
        result = store.results_page(job['id'], ready['result_revision']) if ready['result_revision'] else None
        return ready, result


def test_new_tasks_reopen_store_and_change_keyword_without_ocr_or_raster(tmp_path, monkeypatch):
    path = make_pdf(tmp_path)
    digest = sha256(path.read_bytes()).hexdigest()
    calls = []
    monkeypatch.setattr(batch_pdf, 'recognize_image', lambda *_a, **_k: calls.append(1) or records())
    ready, first = run_job(tmp_path / 'tasks.db', path)
    first_id = ready['id']
    assert ready['state'] == 'ready_for_review' and first['total'] == 2
    assert len(calls) == 2 and ocr_cache.cache_info()['entries'] == 2
    renamed = tmp_path / 'renamed.pdf'
    shutil.copyfile(path, renamed)
    monkeypatch.setattr(batch_pdf, 'recognize_image', lambda *_a, **_k: pytest.fail('warm task called OCR'))
    monkeypatch.setattr(pymupdf.Page, 'get_pixmap', lambda *_a, **_k: pytest.fail('warm task rasterized'))
    for word, total in [('bank', 2), ('absent', 0)]:
        ready, warm = run_job(tmp_path / 'tasks.db', renamed, word)
        assert ready['state'] == 'ready_for_review' and warm['total'] == total
        assert ready['id'] != first_id
    assert sha256(path.read_bytes()).hexdigest() == digest


def test_new_process_reuses_persisted_records(tmp_path):
    path = make_pdf(tmp_path)
    script = '''
import json, sys
from engine import batch_pdf
from engine.batch_pdf import open_batch_source
from engine.search import SearchBudget
calls = []
def recognize(*a, **k):
    calls.append(1)
    if sys.argv[2] == 'warm': raise RuntimeError('OCR must not run')
    return [{'text':'fee bank','box':[200,200,500,250],'confidence':0.99}]
batch_pdf.recognize_image = recognize
with open_batch_source(sys.argv[1], reuse_ocr=True) as source:
    result = source.compute_page(1, {'include':['bank'],'includeMode':'all','exclude':[]}, 'exact', SearchBudget())
print(json.dumps({'ocr_calls':len(calls),'matches':len(result['matches'])}))
'''
    for mode, expected in [('cold', 1), ('warm', 0)]:
        completed = subprocess.run([sys.executable, '-X', 'utf8', '-c', script, str(path), mode],
                                   capture_output=True, text=True, encoding='utf-8', check=True, timeout=30)
        assert json.loads(completed.stdout) == {'ocr_calls': expected, 'matches': 1}


def test_corrupt_page_only_recomputes_that_page_and_failed_ocr_is_not_cached(tmp_path, monkeypatch):
    path = make_pdf(tmp_path)
    calls = []
    def recognize(*_a, **_k):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError('synthetic OCR failure')
        return records()
    monkeypatch.setattr(batch_pdf, 'recognize_image', recognize)
    ready, _ = run_job(tmp_path / 'tasks.db', path)
    assert ready['state'] == 'partial_failed' and ocr_cache.cache_info()['entries'] == 1
    ready, result = run_job(tmp_path / 'tasks.db', path)
    assert ready['state'] == 'ready_for_review' and result['total'] == 2 and len(calls) == 3
    next((tmp_path / 'private' / 'ocr-text-cache').glob('*.json')).write_bytes(b'broken')
    ready, result = run_job(tmp_path / 'tasks.db', path)
    assert ready['state'] == 'ready_for_review' and result['total'] == 2 and len(calls) == 4


def test_changed_source_or_recipe_recomputes_and_wrong_sha_rejects(tmp_path, monkeypatch):
    path = make_pdf(tmp_path)
    calls = []
    monkeypatch.setattr(batch_pdf, 'recognize_image', lambda *_a, **_k: calls.append(1) or records())
    run_job(tmp_path / 'tasks.db', path)
    old_digest = sha256(path.read_bytes()).hexdigest()
    # This PDF is a generated test input, never a business original.
    with path.open('ab') as stream:
        stream.write(b'\n% changed synthetic metadata\n')
    with pytest.raises(BatchSourceError, match='source'):
        with open_batch_source(path, old_digest, reuse_ocr=True):
            pytest.fail('changed source accepted')
    run_job(tmp_path / 'tasks.db', path)
    assert len(calls) == 4
    monkeypatch.setattr(ocr_cache, 'ocr_recipe_signature', lambda: 'b' * 64)
    run_job(tmp_path / 'tasks.db', path)
    assert len(calls) == 6


def test_native_pdf_and_default_standalone_path_do_not_persist_ocr(tmp_path, monkeypatch):
    path = make_pdf(tmp_path, native=True)
    monkeypatch.setattr(batch_pdf, 'recognize_image', lambda *_a, **_k: pytest.fail('native PDF called OCR'))
    ready, _ = run_job(tmp_path / 'tasks.db', path)
    assert ready['state'] == 'ready_for_review'
    assert not (tmp_path / 'private' / 'ocr-text-cache').exists()
    path.unlink()  # Generated test input.
    path = make_pdf(tmp_path)
    monkeypatch.setattr(batch_pdf, 'recognize_image', lambda *_a, **_k: records())
    with open_batch_source(path) as source:
        source.compute_page(1, {'include':['fee'], 'includeMode':'all', 'exclude':[]}, 'exact', SearchBudget())
    assert not (tmp_path / 'private' / 'ocr-text-cache').exists()
