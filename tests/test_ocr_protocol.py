"""OCR protocol errors must be useful without leaking parser/model details."""
import pytest
import pymupdf
from engine import engine as core
from engine.ocr import OcrRuntimeError


def test_health_passes_explicit_verify_only_when_boolean(monkeypatch):
    calls = []
    def status(*, verify=False):
        calls.append(verify)
        return {'available': True, 'engine': 'paddleocr', 'readiness': 'ready' if verify else 'installed', 'message': 'safe'}
    monkeypatch.setattr(core, 'runtime_status', status)
    assert core.handle_request({'op': 'ocr_health'})['readiness'] == 'installed'
    assert core.handle_request({'op': 'ocr_health', 'verify': True})['readiness'] == 'ready'
    assert core.handle_request({'op': 'ocr_health', 'verify': 'true'})['code'] == 'invalid_request'
    assert calls == [False, True]


@pytest.mark.parametrize('op', ['search', 'search_multi'])
@pytest.mark.parametrize('code', ['ocr_initialization_failed', 'ocr_inference_failed', 'ocr_result_invalid'])
def test_search_preserves_classified_ocr_error(tmp_path, monkeypatch, op, code):
    source = tmp_path / 'source.pdf'
    with pymupdf.open() as doc:
        doc.new_page()
        doc.save(source)
    monkeypatch.setenv('PDF_SEARCH_PRIVATE_TEMP', str(tmp_path / 'private'))
    def failed(*args, **kwargs):
        raise OcrRuntimeError(code) from RuntimeError('sensitive model path')
    monkeypatch.setattr(core, 'recognize_image', failed)
    request = {'op': op, 'path': str(source), 'keyword': 'fee', 'exact': True}
    if op == 'search_multi':
        request['queries'] = [{'id': 'include-0', 'keyword': 'fee', 'role': 'include'}]
    result = core.handle_request(request)
    assert result['code'] == code
    assert 'sensitive' not in str(result) and str(source) not in str(result)
