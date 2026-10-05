"""Only controlled institution aliases can make source-bank manifests equal."""
import pytest

from engine.receipt_grouping_store import GroupingStore, _manifest_bank
from test_receipt_grouping_store import ACCOUNT, receipt


@pytest.mark.parametrize("values,expected", [
    (["网上银行", "企业网上银行"], ("", "unknown")),
    (["中国银行", "企业网上银行"], ("中国银行", "unknown")),
    (["深圳农商银行", "深圳农村商业银行股份有限公司"], ("深圳农商银行", "present")),
    (["农业银行", "中国农业银行"], ("中国农业银行", "present")),
    (["中国银行", "中国农业银行"], ("", "mixed")),
    (["深圳农商银行", "北京农商银行"], ("", "mixed")),
    (["农商银行", "深圳农商银行"], ("", "mixed")),
])
def test_manifest_uses_shared_institution_identity(values, expected):
    assert _manifest_bank([{"source_bank": {"bank_name": bank}} for bank in values]) == expected


def test_equivalent_bank_names_do_not_block_grouping_but_other_bank_still_does(tmp_path):
    pdf = tmp_path / "synthetic.pdf"; pdf.write_bytes(b"synthetic receipt bytes")
    with GroupingStore(tmp_path / "grouping.sqlite3") as store:
        account = store.account_save({**ACCOUNT, "bank_name": "深圳农商银行"}, expected_account_revision=0, active=True)
        store.set_account("job-1", expected_grouping_revision=0,
                          account_selection={"kind": "saved", "account_id": account["account_id"], "account_revision": 1})
        value = receipt(pdf, source_bank="深圳农商银行")
        def prepare(banks):
            return store.prepare("job-1", result_revision="result-1", expected_grouping_revision=-1,
                                 authoritative=[value], source_manifest=[{"source_bank": bank} for bank in banks],
                                 source_bank="深圳农商银行", review_fingerprint="review-1")
        same = prepare(["深圳农商银行", "深圳农村商业银行股份有限公司"])
        assert same["items"][0]["route"] == "named"
        different = prepare(["深圳农商银行", "北京农商银行"])
        assert different["items"][0]["route"] == "counterparty_pending"
        assert "source_bank_mismatch" in different["items"][0]["warnings"]
