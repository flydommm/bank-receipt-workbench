"""Synthetic issuer and service-voucher regressions; no real business data."""
from copy import deepcopy

import pytest

from engine.pdf_parser import ParsedPage, TextBlock
from engine.receipt_document_types import (
    DOCUMENT_TYPES, detect_document_type, detect_grouping_service_type,
)
from engine.receipt_grouping_diagnostics import build_summary
from engine.receipt_grouping_models import GroupingValidationError, derive_grouping_decision, normalize_parties
from engine.receipt_issuer import canonical_bank_heading


RECT = {"x0": 0, "y0": 0, "x1": 600, "y1": 300}
PROFILE = {"company_name": "合成测试公司", "bank_name": "中国银行", "account_number": "00001234"}


def page(*rows):
    blocks = tuple(TextBlock(1, text, x, y, x + width, y + 12, i)
                   for i, (text, x, y, width) in enumerate(rows))
    return ParsedPage(1, 600, 900, "\n".join(b.text for b in blocks), blocks)


def field(text="", state=None):
    return {"raw": text, "value": text, "state": state or ("present" if text else "missing")}


def item(service_type="bank_fee"):
    return {"review_status": "confirmed", "document_type": "ordinary",
            "source_bank": {"value": "中国银行", "state": "present"},
            "parties": {"payer": {"name": field(PROFILE["company_name"]), "account": field(PROFILE["account_number"]),
                                  "bank": field("中国银行")},
                        "payee": {"name": field(), "account": field(), "bank": field()},
                        "service_type": service_type}}


@pytest.mark.parametrize("channel", ["网上银行", "企业网上银行", "个人网上银行", "电子银行", "手机银行", "网络银行"])
def test_channel_is_not_an_issuer_even_in_cached_grouping_read(channel):
    assert canonical_bank_heading(channel) is None
    value = item(); value["source_bank"]["value"] = channel
    result = derive_grouping_decision(value, PROFILE)
    assert result["own_decision"]["source_bank_status"] == "unknown"
    assert "source_bank_mismatch" not in result["warnings"]


def test_named_rural_bank_aliases_do_not_merge_other_regional_banks():
    aliases = ["深圳农商银行", "深圳农村商业银行", "深圳农村商业银行股份有限公司"]
    assert {canonical_bank_heading(value) for value in aliases} == {"深圳农商银行"}
    assert canonical_bank_heading("农商银行") != canonical_bank_heading("深圳农商银行")
    assert canonical_bank_heading("北京农商银行") != canonical_bank_heading("深圳农商银行")
    assert canonical_bank_heading("浙江网商银行") == "浙江网商银行"
    value = item(); value["source_bank"]["value"] = aliases[-1]
    for bank in aliases:
        result = derive_grouping_decision(value, {**PROFILE, "bank_name": bank})
        assert result["own_decision"]["source_bank_status"] == "matched"
    generic = derive_grouping_decision(value, {**PROFILE, "bank_name": "农商银行"})
    assert generic["own_decision"]["source_bank_status"] == "unknown"
    assert "source_bank_mismatch" not in generic["warnings"]


@pytest.mark.parametrize("generic", ["农商银行", "农村商业银行", "农商行"])
def test_unspecified_rural_bank_is_not_a_confirmed_different_institution(generic):
    value = item(None)
    value["source_bank"]["value"] = "深圳农商银行"
    value["parties"]["payee"]["name"] = field("合成供应商")
    profile = {**PROFILE, "bank_name": generic}
    result = derive_grouping_decision(value, profile)
    assert result["route"] == "named"
    assert result["own_decision"]["source_bank_status"] == "unknown"
    assert "source_bank_unknown" in result["warnings"]
    assert derive_grouping_decision(value, {**profile, "bank_name": "北京农商银行"})["reason"] == "batch_identity_conflict"
    assert derive_grouping_decision(value, {**profile, "bank_name": "农业银行"})["reason"] == "batch_identity_conflict"
    value["parties"]["payer"]["name"] = field("合成另一家公司")
    assert derive_grouping_decision(value, profile)["reason"] == "batch_identity_conflict"
    value["parties"]["payer"]["name"] = field(PROFILE["company_name"])
    value["parties"]["payer"]["account"] = field("00009999")
    assert derive_grouping_decision(value, profile)["reason"] == "batch_identity_conflict"


@pytest.mark.parametrize("text,expected", [
    ("客户付费回单", "bank_fee"), ("存款结息凭证", "deposit_interest"),
    ("存款利息单", "deposit_interest"),
    ("收费回单", "bank_fee"),
    ("业务类型：企业银行收费", "bank_fee"), ("业务类型：活期结息", "deposit_interest"),
    ("业务种类：贷方利息资本化（系统结息）", "deposit_interest"),
    ("摘要：费用外收", "bank_fee"), ("摘要：开户手续费扣收", "bank_fee"),
    ("摘要：汇款费", "bank_fee"), ("摘要：结息转入", "deposit_interest"),
    ("摘要：季度结息", "deposit_interest"), ("回单类型：业务收费凭证", "bank_fee"),
])
def test_exact_service_evidence_is_grouping_only(text, expected):
    parsed = page((text, 200, 25, 250))
    assert detect_grouping_service_type(parsed, RECT) == expected
    assert detect_document_type(parsed) is None
    assert expected not in DOCUMENT_TYPES


def test_service_labels_can_be_separate_same_row_text_objects():
    parsed = page(("摘要", 20, 100, 30), ("自助交易费", 100, 100, 90))
    assert detect_grouping_service_type(parsed, RECT) == "bank_fee"
    parsed = page(("业务种类:", 20, 100, 50), ("贷方利息资本化(系统结息)", 80, 100, 200))
    assert detect_grouping_service_type(parsed, RECT) == "deposit_interest"


@pytest.mark.parametrize("text", [
    "备注：客户付费回单", "摘要：向乙公司支付手续费", "手续费", "摘要：手续费", "备注：活期结息",
    "业务类型：转账", "费用名称：转账汇款手续费（网银）", "业务种类：收费",
    "摘要：货款及费用外收", "备注：开户手续费扣收", "附言：季度结息",
    "附言：汇款费", "备注：结息转入", "摘要：代付汇款费", "摘要：返还结息转入款",
])
def test_body_mentions_and_generic_service_words_do_not_classify(text):
    assert detect_grouping_service_type(page((text, 20, 30, 500)), RECT) is None


def test_service_evidence_cannot_come_from_body_title_neighbor_row_or_adjacent_receipt():
    assert detect_grouping_service_type(page(("客户付费回单", 200, 200, 150)), RECT) is None
    assert detect_grouping_service_type(page(("客户付费回单", 200, 400, 150)), RECT) is None
    assert detect_grouping_service_type(page(("摘要", 20, 100, 30), ("自助交易费", 100, 125, 90)), RECT) is None
    assert detect_grouping_service_type(page(("摘要", 20, 100, 30), ("自助交易费", 400, 100, 90)), RECT) is None
    assert detect_grouping_service_type(page(("摘要", 20, 100, 30), ("用途", 100, 100, 30),
                                            ("自助交易费", 160, 100, 90)), RECT) is None
    assert detect_grouping_service_type(page(("客户付费回单", 200, 20, 150),
                                            ("业务类型：活期结息", 100, 100, 200)), RECT) is None


@pytest.mark.parametrize("kind,label", [("bank_fee", "银行收费凭证"), ("deposit_interest", "存款结息凭证")])
def test_verified_service_without_counterparty_gets_clear_destination_without_review_edits(kind, label):
    value = item(kind); before = deepcopy(value)
    result = derive_grouping_decision(value, PROFILE)
    assert result["route"] == "special"
    assert result["group"]["display_name"] == label
    assert result["group"]["key"] == f"special:{kind}"
    assert result["counterparty"]["name"]["state"] == "missing"
    assert value == before


@pytest.mark.parametrize("state,route", [("present", "named"), ("ambiguous", "counterparty_pending")])
def test_service_never_erases_printed_counterparty(state, route):
    value = item(); value["parties"]["payee"]["name"] = field("合成对手公司", state)
    result = derive_grouping_decision(value, PROFILE)
    assert result["route"] == route
    assert result["counterparty"]["name"]["value"] == "合成对手公司"


@pytest.mark.parametrize("state", ["present", "ambiguous"])
@pytest.mark.parametrize("side", ["payer", "payee"])
def test_service_cannot_hide_an_unassigned_printed_party_when_own_side_is_unknown(state, side):
    value = item()
    value["parties"]["payer"] = {key: field() for key in ("name", "account", "bank")}
    value["parties"][side]["name"] = field("合成未归属公司", state)
    result = derive_grouping_decision(value, PROFILE)
    assert result["our_side"] is None
    assert result["route"] == "counterparty_pending"
    assert result["parties"][side]["name"]["state"] == state


def test_service_cannot_hide_a_manual_party_name_with_unresolved_direction():
    value = item()
    value["parties"]["payer"] = {key: field() for key in ("name", "account", "bank")}
    override = {"side": "payee", "field": "name", "value": "人工核对的合成公司", "state": "present", "reason": "已核对原件"}
    result = derive_grouping_decision(value, PROFILE, manual={"field_overrides": [override]})
    assert result["route"] == "counterparty_pending"
    assert result["field_overrides"] == [override]


@pytest.mark.parametrize("conflict", ["bank", "company", "account"])
def test_service_cannot_hide_explicit_identity_conflict(conflict):
    value = item()
    if conflict == "bank": value["source_bank"]["value"] = "中国农业银行"
    if conflict == "company": value["parties"]["payer"]["name"] = field("另一合成公司")
    if conflict == "account": value["parties"]["payer"]["account"] = field("88889999")
    assert derive_grouping_decision(value, PROFILE)["reason"] == "batch_identity_conflict"


def test_manual_decisions_and_exclusions_take_priority_over_service_destination():
    value = item()
    override = {"side": "counterparty", "field": "name", "value": "", "state": "blank", "reason": "已核对"}
    assert derive_grouping_decision(value, PROFILE, manual={"field_overrides": [override]})["route"] == "blank"
    groups = {"manual-group": {"kind": "named", "group_id": "manual-group", "display_name": "人工指定组", "key": "manual"}}
    result = derive_grouping_decision(value, PROFILE, groups=groups,
                                     manual={"assignment": {"group_id": "manual-group", "reason": "已核对"}})
    assert result["group"]["display_name"] == "人工指定组"
    value["document_type"] = "electronic_tax_payment"; value["special_confirmed"] = True
    assert derive_grouping_decision(value, PROFILE)["group"]["display_name"] == "电子缴税付款凭证"
    value["excluded"] = True
    assert derive_grouping_decision(value, PROFILE)["route"] == "excluded"


def test_service_destination_survives_store_projection_and_can_export_without_document_type_change(tmp_path):
    from test_receipt_grouping_store import configured_store, prepare, receipt

    store, pdf = configured_store(tmp_path)
    try:
        value = receipt(pdf, counterparty="", counterparty_account="", counterparty_bank="")
        value["parties"]["service_type"] = "bank_fee"
        original = deepcopy(value)
        prepared = prepare(store, pdf, [value])
        saved = prepared["items"][0]
        assert saved["route"] == "special"
        assert saved["document_type"] == value["document_type"]
        assert saved["extracted"]["service_type"] == "bank_fee"
        assert saved["binding"]["final_rect"] == value["final_rect"]
        assert value == original
        snapshot = store.export_snapshot("job-1", expected_grouping_revision=prepared["header"]["grouping_revision"],
                                         expected_review_fingerprint="review-1", require_complete=True)
        assert snapshot["exportable"] is True
        assert snapshot["items"][0]["group"]["display_name"] == "银行收费凭证"
    finally:
        store.close()


@pytest.mark.parametrize("bad", ["ordinary", "sensitive-value", {}, [], 1, True])
def test_service_metadata_is_strictly_controlled(bad):
    with pytest.raises(GroupingValidationError):
        normalize_parties({"service_type": bad})


def test_diagnostics_count_identity_conflict_without_repeating_or_leaking_fields():
    secret = "私有公司账号00001111"
    items = [{"own_decision": {"reasons": ["source_bank_mismatch", "own_company_mismatch", secret]},
              "extracted": {"issues": []}},
             {"own_decision": {"reasons": ["own_account_mismatch"]},
              "extracted": {"issues": [{"code": "source_conflict", "message": secret}]}},
             {"own_decision": {"reasons": ["source_bank_unknown"]}, "extracted": {"issues": None}}]
    report = build_summary(items, "a" * 32)
    assert report["issues"] == [{"code": "source_conflict", "count": 2}]
    assert secret not in str(report)
