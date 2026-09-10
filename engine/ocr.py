"""Optional OCR boundary for scanned PDF pages.

PaddleOCR remains an optional installation because it is a large native
dependency. The rest of the engine can detect scanned pages and return a
clear, actionable error until the OCR runtime is installed.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from copy import deepcopy
import json
import math

from .private_temp import private_temporary_directory

try:
    from .pdf_parser import ParsedPage
except ImportError:  # Support direct engine script execution.
    from pdf_parser import ParsedPage  # type: ignore[no-redef]


class OcrUnavailableError(RuntimeError):
    """Raised when OCR was requested but PaddleOCR is not installed."""


_RUNTIME_MESSAGES = {
    'ocr_initialization_failed': 'OCR 模型初始化失败，请检查本地模型与运行时后重试。',
    'ocr_inference_failed': 'OCR 识别运行失败，请在帮助与反馈中检测 OCR 后重试。',
    'ocr_result_invalid': 'OCR 返回的识别结果无效，请检查 OCR 运行时版本。',
}


class OcrRuntimeError(RuntimeError):
    """Classified OCR failure with a safe, stable public message."""

    def __init__(self, code: str) -> None:
        if code not in _RUNTIME_MESSAGES:
            raise ValueError('invalid OCR error code')
        self.code = code
        super().__init__(_RUNTIME_MESSAGES[code])


# Detection must avoid the Windows oneDNN/PIR failure. Recognition can use
# oneDNN independently; disabling both makes each scanned page much slower.
# The whole profile is also included in the persisted computation fingerprint.
OCR_RUNTIME_PROFILE = {
    'device': 'cpu',
    'ocr_version': 'PP-OCRv5',
    'text_detection_model_name': 'PP-OCRv5_mobile_det',
    'text_recognition_model_name': 'PP-OCRv5_mobile_rec',
    'enable_mkldnn': False,
    'cpu_threads': 4,
    'recognition_engine_config': {
        'paddle_static': {'run_mode': 'mkldnn', 'cpu_threads': 4},
    },
}


_OCR_INSTANCES: dict[str, Any] = {}


def _paddle_options() -> dict[str, Any]:
    """Keep SDK preprocessing defaults and override only the recognizer engine."""
    from paddlex.inference import load_pipeline_config

    options = deepcopy(OCR_RUNTIME_PROFILE)
    recognition_config = options.pop('recognition_engine_config')
    pipeline = deepcopy(load_pipeline_config('OCR'))
    pipeline['SubModules']['TextRecognition']['engine_config'] = recognition_config
    options['paddlex_config'] = pipeline
    return options


def runtime_status(*, verify: bool = False) -> dict[str, str | bool]:
    """Import-only by default; explicit verification uses public synthetic text."""

    try:
        import paddleocr  # type: ignore[import-not-found]  # noqa: F401
    except Exception:
        return {'available': False, 'engine': 'paddleocr', 'readiness': 'unavailable',
                'message': 'OCR 运行时不可用，请安装或检查本地 OCR 依赖。'}
    if not verify:
        return {'available': True, 'engine': 'paddleocr', 'readiness': 'installed',
                'message': 'OCR 已安装，尚未验证实际识别能力。'}
    try:
        _verify_runtime()
    except OcrUnavailableError:
        return {'available': False, 'engine': 'paddleocr', 'readiness': 'unavailable',
                'message': 'OCR 运行时不可用，请安装或检查本地 OCR 依赖。'}
    except OcrRuntimeError as error:
        return {'available': True, 'engine': 'paddleocr', 'readiness': 'failed',
                'code': error.code, 'message': str(error)}
    except Exception:
        return {'available': True, 'engine': 'paddleocr', 'readiness': 'failed',
                'code': 'ocr_initialization_failed', 'message': _RUNTIME_MESSAGES['ocr_initialization_failed']}
    return {'available': True, 'engine': 'paddleocr', 'readiness': 'ready',
            'message': 'OCR 已通过本地样本文字识别验证。'}


def _verify_runtime() -> None:
    # No user PDF, path, or extracted text is used by the health probe.
    import pymupdf
    with private_temporary_directory('ocr-probe') as directory:
        image = directory / 'probe.png'
        with pymupdf.open() as document:
            page = document.new_page(width=320, height=80)
            page.insert_text((20, 50), 'OCR TEST 123', fontsize=28)
            page.get_pixmap(alpha=False).save(str(image))
        records = recognize_image(image)
        if not any('OCR' in str(record['text']).upper().replace(' ', '') for record in records):
            raise OcrRuntimeError('ocr_result_invalid')


def normalize_result_payload(page_result: Any) -> dict[str, Any]:
    """Normalize PaddleOCR 2.x/3.x result wrappers for deterministic parsing."""

    payload: Any = page_result if isinstance(page_result, (dict, str)) else getattr(page_result, "json", {})
    if callable(payload):
        payload = payload()
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            payload = {}
    if not isinstance(payload, dict):
        return {}
    data = payload.get("res", payload)
    return data if isinstance(data, dict) else {}


def is_scanned_page(page: ParsedPage, minimum_text_length: int = 12) -> bool:
    """Conservatively identify pages that have no useful text layer."""

    return not page.blocks or len("".join(page.text.split())) < minimum_text_length


def recognize_image(image_path: str | Path, language: str = "ch") -> list[dict[str, Any]]:
    """Recognize an image and normalize PaddleOCR output into engine records."""

    try:
        from paddleocr import PaddleOCR  # type: ignore[import-not-found]
    except Exception as error:
        raise OcrUnavailableError(
            "PaddleOCR is not installed; install the OCR extra before processing scanned PDFs."
        ) from error

    ocr = _OCR_INSTANCES.get(language)
    if ocr is None:
        try:
            ocr = PaddleOCR(
                lang=language,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                **_paddle_options(),
            )
        except Exception as error:
            raise OcrRuntimeError('ocr_initialization_failed') from error
        _OCR_INSTANCES[language] = ocr
    try:
        result = list(ocr.predict(str(image_path)))
    except Exception as error:
        _OCR_INSTANCES.pop(language, None)
        raise OcrRuntimeError('ocr_inference_failed') from error
    try:
        return _normalize_records(result)
    except Exception as error:
        _OCR_INSTANCES.pop(language, None)
        raise OcrRuntimeError('ocr_result_invalid') from error


def _normalize_records(result: list[Any]) -> list[dict[str, Any]]:
    if not result:
        raise ValueError('missing OCR page result')
    records: list[dict[str, Any]] = []
    for page_result in result:
        data = normalize_result_payload(page_result)
        texts = data['rec_texts']
        scores = data['rec_scores']
        boxes = data['rec_boxes']
        if isinstance(texts, (str, bytes)) or len(texts) != len(scores) or len(texts) != len(boxes):
            raise ValueError('inconsistent OCR record lengths')
        for index, text in enumerate(texts):
            if not isinstance(text, str):
                raise ValueError('invalid OCR text')
            if not text.strip():
                continue
            box = boxes[index]
            if hasattr(box, 'tolist'):
                box = box.tolist()
            if not isinstance(box, (list, tuple)) or len(box) != 4:
                raise ValueError('invalid OCR coordinates')
            values = [float(value) for value in box]
            confidence = float(scores[index])
            if (not all(math.isfinite(value) for value in values)
                    or values[2] <= values[0] or values[3] <= values[1]
                    or not math.isfinite(confidence) or not 0 <= confidence <= 1):
                raise ValueError('invalid OCR record values')
            records.append({'text': text, 'confidence': confidence, 'box': values})
    return records
