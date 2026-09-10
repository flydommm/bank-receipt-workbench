from __future__ import annotations

import hashlib
from pathlib import Path
from zipfile import ZipFile

import pymupdf

from engine.engine import handle_request


def test_task_chain_search_review_and_export_preserves_source(tmp_path: Path) -> None:
    source = tmp_path / "bank-receipts.pdf"
    document = pymupdf.open()
    for page_number in range(1, 4):
        page = document.new_page(width=300, height=300)
        page.insert_text((30, 50), f"手续费 第 {page_number} 页 target-receipt", fontname="china-s")
    document.save(source)
    document.close()
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    source_document = pymupdf.open(source)
    source_page_count = source_document.page_count
    source_document.close()

    search = handle_request({"op": "search", "path": str(source), "keyword": "手续费"})
    assert search["status"] == "ok"
    assert len(search["matches"]) == 3

    rows = [
        {"source_file": source.name, "source_page": match["page"], "review_status": "confirmed"}
        for match in search["matches"]
    ]
    index = tmp_path / "output" / "index.xlsx"
    export_token = "e2e-export-token-000000001"
    exported = handle_request({"op": "export_index", "output_path": str(index), "export_token": export_token, "rows": rows})
    assert exported["status"] == "ok"
    with ZipFile(index) as workbook:
        assert "xl/worksheets/sheet1.xml" in workbook.namelist()

    result = handle_request({
        "op": "export_pdf",
        "output_path": str(tmp_path / "output" / "results.pdf"),
        "export_token": export_token,
        "selections": [{
            "source_path": str(source),
            "source_sha256": source_hash,
            "segments": [{
                "page_number": 1,
                "segment_no": 1,
                "rect": {"x0": 0, "y0": 0, "x1": 300, "y1": 120},
                "review_status": "confirmed",
            }],
        }],
    })
    assert result["status"] == "ok"
    assert result["page_count"] == 1
    output = pymupdf.open(result["output_path"])
    assert output[0].rect.height == 120
    assert "target-receipt" in output[0].get_text()
    output.close()
    source_document = pymupdf.open(source)
    assert source_document.page_count == source_page_count
    source_document.close()
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
