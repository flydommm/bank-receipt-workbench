"""Business classification crosses extraction/API boundaries per final crop."""
from hashlib import sha256

import pymupdf
import pytest

from engine.receipt_grouping_api import _extract_selected, _public_parties
from engine.receipt_grouping_models import GroupingValidationError, derive_grouping_decision


def test_mixed_page_services_are_extracted_per_fragment_and_projected(tmp_path, monkeypatch):
    monkeypatch.setenv("PDF_SEARCH_PRIVATE_TEMP", str(tmp_path / "private"))
    path = tmp_path / "synthetic-mixed.pdf"
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=900)
        for index, business in enumerate(["转账", "企业银行收费", "活期结息"]):
            top = index * 300 + 30
            lines = ["上海银行业务回单", "业务类型：" + business,
                     "付款方名称：合成本公司", "付款方账号：000012345678"]
            if index == 0:
                lines += ["收款方名称：合成供应商", "附言：本次转账包含手续费"]
            for offset, line in enumerate(lines):
                page.insert_text((30, top + offset * 24), line, fontname="china-s", fontsize=11)
        document.save(path)
    before = sha256(path.read_bytes()).hexdigest()
    source = {"access_path": str(path), "sha256": before, "size_bytes": path.stat().st_size,
              "page_count": 1, "source_key": "synthetic-source"}
    rows = [{"id": str(index), "source_key": source["source_key"], "source_page": 1,
             "final_rect": {"x0": 0, "y0": index * 300, "x1": 600, "y1": (index + 1) * 300}}
            for index in range(3)]
    read = _extract_selected({"job": {"sources": [source]}}, rows, {row["id"] for row in rows})
    assert [read[str(i)]["parties"]["service_type"] for i in range(3)] == [None, "bank_fee", "deposit_interest"]
    profile = {"company_name": "合成本公司", "bank_name": "上海银行", "account_number": "000012345678"}
    decisions = [derive_grouping_decision({**read[str(i)], "review_status": "confirmed"}, profile) for i in range(3)]
    assert [item["route"] for item in decisions] == ["named", "special", "special"]
    assert sha256(path.read_bytes()).hexdigest() == before


def test_public_projection_rejects_unknown_service_metadata_without_echo():
    with pytest.raises(GroupingValidationError, match="凭证业务类型无效"):
        _public_parties({"service_type": "private-untrusted-text"})
