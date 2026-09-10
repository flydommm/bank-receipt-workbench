"""OCR boundary contracts, using synthetic predictions rather than model IO."""
from pathlib import Path
import sys
import types

import numpy as np
import pytest

from engine import ocr


@pytest.fixture(autouse=True)
def isolated_ocr(tmp_path, monkeypatch):
    ocr._OCR_INSTANCES.clear()
    monkeypatch.setenv('PDF_SEARCH_PRIVATE_TEMP', str(tmp_path / 'private'))
    yield
    ocr._OCR_INSTANCES.clear()


def install_fake(monkeypatch, *, result=None, init_error=None, predict_error=None):
    calls = []
    class FakeOCR:
        def __init__(self, **kwargs):
            calls.append(('init', kwargs))
            if init_error:
                raise init_error
        def predict(self, path):
            calls.append(('predict', path))
            if predict_error:
                raise predict_error
            return result
    monkeypatch.setitem(sys.modules, 'paddleocr', types.SimpleNamespace(PaddleOCR=FakeOCR))
    monkeypatch.setitem(sys.modules, 'paddlex.inference', types.SimpleNamespace(
        load_pipeline_config=lambda _name: {
            'pipeline_name': 'OCR',
            'SubModules': {'TextDetection': {'limit_side_len': 64}, 'TextRecognition': {'batch_size': 6}},
        },
    ))
    return calls


def payload(box=None, text='OCR TEST', score=0.98):
    return {'rec_texts': [text], 'rec_scores': [score], 'rec_boxes': [box if box is not None else [10, 10, 100, 40]]}


def test_real_sdk_dict_subclass_array_boxes_become_json_safe_lists(monkeypatch):
    class Result(dict):
        @property
        def json(self):
            return {'res': {**self, 'rec_boxes': self['rec_boxes'].tolist()}}
    install_fake(monkeypatch, result=[Result(rec_texts=['fee'], rec_scores=np.array([0.98]), rec_boxes=np.array([[1, 2, 30, 40]]))])
    records = ocr.recognize_image('synthetic.png')
    assert records == [{'text': 'fee', 'confidence': 0.98, 'box': [1.0, 2.0, 30.0, 40.0]}]
    assert type(records[0]['box']) is list
    assert all(type(value) is float for value in records[0]['box'])


def test_health_import_does_not_claim_model_was_verified(monkeypatch):
    calls = install_fake(monkeypatch, result=[payload()])
    assert ocr.runtime_status()['readiness'] == 'installed'
    assert calls == []


def test_cpu_runtime_avoids_known_failing_accelerator_and_sdk_model_defaults(monkeypatch):
    calls = install_fake(monkeypatch, result=[payload()])
    ocr.recognize_image('synthetic.png')
    settings = calls[0][1]
    assert settings['device'] == 'cpu'
    assert settings['enable_mkldnn'] is False
    assert settings['text_detection_model_name'] == 'PP-OCRv5_mobile_det'
    assert settings['text_recognition_model_name'] == 'PP-OCRv5_mobile_rec'
    assert settings['cpu_threads'] == 4
    modules = settings['paddlex_config']['SubModules']
    assert modules['TextDetection'] == {'limit_side_len': 64}
    assert modules['TextRecognition']['batch_size'] == 6
    assert modules['TextRecognition']['engine_config'] == {
        'paddle_static': {'run_mode': 'mkldnn', 'cpu_threads': 4},
    }
    assert 'recognition_engine_config' not in settings


def test_explicit_health_verifies_synthetic_image_and_cleans_it(monkeypatch):
    calls = install_fake(monkeypatch, result=[payload()])
    status = ocr.runtime_status(verify=True)
    assert status['available'] is True and status['readiness'] == 'ready'
    assert len([x for x in calls if x[0] == 'predict']) == 1
    probe_path = Path(next(value for key, value in calls if key == 'predict'))
    assert not probe_path.exists()


@pytest.mark.parametrize('init_error,predict_error,code', [
    (RuntimeError('private model path'), None, 'ocr_initialization_failed'),
    (None, NotImplementedError('private inference path'), 'ocr_inference_failed'),
])
def test_model_errors_are_classified_and_do_not_expose_raw_messages(monkeypatch, init_error, predict_error, code):
    install_fake(monkeypatch, result=[payload()], init_error=init_error, predict_error=predict_error)
    with pytest.raises(ocr.OcrRuntimeError) as failed:
        ocr.recognize_image('synthetic.png')
    assert failed.value.code == code
    assert 'private' not in str(failed.value)
    status = ocr.runtime_status(verify=True)
    assert status['readiness'] == 'failed' and status['code'] == code
    assert 'private' not in status['message']


@pytest.mark.parametrize('result', [[payload(box=[1, 2, float('nan'), 5])], [payload(box=[3, 4, 1, 2])], [payload(score=float('inf'))], [payload(box=[1, 2])], [{'rec_texts': ['fee'], 'rec_boxes': [], 'rec_scores': []}], [{}]])
def test_bad_prediction_shape_is_explicit_failure(monkeypatch, result):
    install_fake(monkeypatch, result=result)
    with pytest.raises(ocr.OcrRuntimeError) as failed:
        ocr.recognize_image('synthetic.png')
    assert failed.value.code == 'ocr_result_invalid'


def test_empty_but_valid_page_prediction_is_allowed(monkeypatch):
    install_fake(monkeypatch, result=[{'rec_texts': [], 'rec_scores': [], 'rec_boxes': []}])
    assert ocr.recognize_image('synthetic.png') == []


def test_probe_empty_prediction_is_not_marked_ready(monkeypatch):
    install_fake(monkeypatch, result=[{'rec_texts': [], 'rec_scores': [], 'rec_boxes': []}])
    status = ocr.runtime_status(verify=True)
    assert status['readiness'] == 'failed' and status['code'] == 'ocr_result_invalid'


def test_failed_predictor_is_not_reused_on_retry(monkeypatch):
    install_fake(monkeypatch, predict_error=RuntimeError('failure'))
    with pytest.raises(ocr.OcrRuntimeError):
        ocr.recognize_image('synthetic.png')
    calls = install_fake(monkeypatch, result=[payload()])
    assert ocr.recognize_image('synthetic.png')
    assert calls[0][0] == 'init'
