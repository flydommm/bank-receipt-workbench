"""Exercise a relocated app runtime using generated, non-business PDF content."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--resource-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--ocr', action='store_true', help='May download public OCR models; uses synthetic text only.')
    args = parser.parse_args()
    root = args.resource_root.resolve()
    sys.path.insert(0, str(root))
    import pymupdf
    from engine.engine import handle_request
    from engine.ocr import runtime_status

    # Fail if PDF parsing accidentally came from the developer's global Python.
    assert Path(pymupdf.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())
    with tempfile.TemporaryDirectory(prefix='receipt-public-smoke-') as temporary:
        work = Path(temporary)
        source = work / 'synthetic-receipts.pdf'
        with pymupdf.open() as document:
            page = document.new_page(width=300, height=400)
            page.insert_text((30, 60), 'DEMO BANK RECEIPT - FEE', fontsize=14)
            document.save(source)
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        result = handle_request({'op': 'search', 'path': str(source), 'keyword': 'FEE'})
        assert result['status'] == 'ok' and len(result['matches']) == 1, result
        preview = handle_request({'op': 'render_page', 'path': str(source), 'source_sha256': digest, 'page': 1})
        assert preview['status'] == 'ok', preview
        output = work / 'exports' / 'FEE-result.pdf'
        exported = handle_request({
            'op': 'export_pdf', 'output_path': str(output),
            'export_token': 'public-smoke-export-token-001',
            'selections': [{
                'source_path': str(source), 'source_sha256': digest,
                'segments': [{'page_number': 1, 'segment_no': 1,
                              'rect': {'x0': 0, 'y0': 0, 'x1': 300, 'y1': 120},
                              'review_status': 'confirmed'}],
            }],
        })
        assert exported['status'] == 'ok', exported
        with pymupdf.open(output) as document:
            assert len(document) == 1 and 'FEE' in document[0].get_text()
            assert document[0].rect.height == 120
        assert hashlib.sha256(source.read_bytes()).hexdigest() == digest
    ocr = runtime_status(verify=args.ocr)
    if args.ocr:
        assert ocr.get('readiness') == 'ready', ocr
    print(json.dumps({'status': 'passed', 'python': sys.version.split()[0],
                      'checks': ['search', 'page_preview', 'crop_export', 'original_unchanged'],
                      'ocr': ocr}, ensure_ascii=False))


if __name__ == '__main__':
    main()
