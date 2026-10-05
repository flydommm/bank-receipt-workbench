"""Pure synthetic rules; no PDF or persistent database is opened."""
from copy import deepcopy

import pytest

from engine.receipt_grouping_models import (
    AccountValidationError, GroupingConflict, GroupingIncomplete, GroupingSourceChanged,
    GroupingValidationError, derive_grouping_decision, normalize_party_field,
    normalize_text, validate_account,
    stable_item_identity,
)


PROFILE = {"company_name": "合成测试公司", "bank_name": "中国工商银行",
           "branch_name": "合成测试支行", "account_number": "0000123456"}


def field(value: str = "", state: str | None = None):
    return {"raw": value, "value": value, "state": state or ("present" if value else "missing"),
            "evidence": [{"rect": {"x0": 10, "y0": 20, "x1": 150, "y1": 40},
                          "label": "合成字段", "method": "label"}], "diagnostics": []}


def receipt():
    return {"job_id": "synthetic-job", "source_bank": {"value": "中国工商银行", "state": "present"},
            "parties": {"payer": {"name": field(PROFILE["company_name"]), "account": field(PROFILE["account_number"]), "bank": field("合成来源支行")},
                        "payee": {"name": field("合成对手公司"), "account": field("00009876"), "bank": field("合成对手银行")}},
            "review_status": "confirmed", "document_type": "ordinary"}


def confirmation(side="payer"):
    return {"side": side, "confirms_selected_account": True, "confirms_source_bank": True,
            "reason": "逐张查看合成原件后确认"}


def run(item=None, **kwargs):
    return derive_grouping_decision(item or receipt(), PROFILE, **kwargs)


def test_normal_receipt_preserves_original_evidence_and_accepts_bank_canonical_spelling():
    item = receipt(); original = deepcopy(item)
    item["source_bank"]["value"] = "工商银行"
    result = run(item)
    assert result["route"] == "named"
    assert result["own_decision"] == {"status": "confirmed", "method": "account_match", "side": "payer",
                                      "source_bank_status": "matched", "reasons": []}
    assert result["counterparty"]["account"]["raw"] == "00009876"
    assert item["parties"] == original["parties"]


def test_matching_payee_account_selects_payer_as_counterparty():
    item = receipt()
    item["parties"]["payer"], item["parties"]["payee"] = item["parties"]["payee"], item["parties"]["payer"]
    result = run(item)
    assert result["our_side"] == "payee"
    assert result["counterparty_side"] == "payer"
    assert result["group"]["display_name"] == "合成对手公司"


@pytest.mark.parametrize("problem", ["different_bank", "different_company", "both_accounts", "neither_account", "wrong_manual_side"])
def test_explicit_conflicts_go_to_counterparty_pending_without_blocking_batch(problem):
    item = receipt(); manual = {"own_confirmation": confirmation()}
    if problem == "different_bank": item["source_bank"]["value"] = "中国银行"
    elif problem == "different_company": item["parties"]["payer"]["name"] = field("合成其他公司")
    elif problem == "both_accounts": item["parties"]["payee"]["account"] = field(PROFILE["account_number"])
    elif problem == "neither_account": item["parties"]["payer"]["account"] = field("00004444")
    else: manual["own_confirmation"] = confirmation("payee")
    result = run(item, manual=manual)
    assert result["route"] == "counterparty_pending"
    assert result["group"]["kind"] == "counterparty_pending"
    assert result["own_decision"]["status"] == "confirmed"
    assert result["own_decision"]["method"] == "batch_profile"
    assert result["reason"] == "batch_identity_conflict"


@pytest.mark.parametrize("missing_kind", ["missing", "masked", "suffix", "source_unknown"])
def test_missing_identity_uses_batch_profile_without_inventing_account(missing_kind):
    item = receipt()
    if missing_kind == "source_unknown": item["source_bank"] = {"value": "", "state": "unknown"}
    else: item["parties"]["payer"]["account"] = field({"missing": "", "masked": "****3456", "suffix": "尾号3456"}[missing_kind])
    automatic = run(item)
    assert automatic["route"] == "named"
    assert automatic["own_decision"]["method"] == "batch_profile"
    assert automatic["parties"]["payer"]["account"]["value"] == item["parties"]["payer"]["account"]["value"]
    confirmed = run(item, manual={"own_confirmation": confirmation()})
    assert confirmed["route"] == "named"
    assert confirmed["own_decision"]["method"] == "manual"
    if missing_kind == "source_unknown": assert confirmed["own_decision"]["source_bank_status"] == "manual"


def test_bare_legacy_side_selection_does_not_override_batch_name_match():
    item = receipt(); item["parties"]["payer"]["account"] = field()
    item.update(our_side="payee", manual_confirmed=True)
    result = run(item)
    assert result["route"] == "named"
    assert result["our_side"] == "payer"
    assert result["own_decision"]["method"] == "batch_profile"


def test_manual_single_party_voucher_can_confirm_blank_counterparty():
    item = {"source_bank": {"value": "", "state": "unknown"}, "parties": {}}
    manual = {"own_confirmation": confirmation("single"), "field_overrides": [
        {"side": "counterparty", "field": "name", "value": "", "state": "blank", "reason": "确认原件未列对手"}]}
    result = run(item, manual=manual)
    assert result["own_decision"]["side"] == "single"
    assert result["route"] == "blank"


def test_confirmed_special_classification_is_kept_with_batch_identity_warning():
    item = receipt(); item.update(document_type="electronic_tax_payment", document_type_confirmed=True)
    item["parties"]["payee"]["name"] = field("", "blank")
    assert run(item)["route"] == "special"
    item["source_bank"]["value"] = "中国银行"
    assert run(item)["route"] == "special"
    assert "source_bank_mismatch" in run(item)["warnings"]
    assert run(item)["group"]["display_name"] == "电子缴税付款凭证"
    item["review_status"] = "excluded"
    excluded = run(item)
    assert excluded["route"] == "excluded" and excluded["group"] is None


def test_summary_words_do_not_classify_and_ordinary_is_not_special():
    item = receipt(); item["summary"] = "手续费 缴税 付息"; item["document_type_confirmed"] = True
    assert run(item)["route"] == "named"


@pytest.mark.parametrize("state,expected", [("blank", "blank"), ("missing", "counterparty_pending"), ("ambiguous", "counterparty_pending")])
def test_true_blank_is_different_from_missing_or_ambiguous(state, expected):
    item = receipt(); item["parties"]["payee"]["name"] = field("", state)
    result = run(item)
    assert result["route"] == expected
    assert result["group"] is not None
    assert result["group"]["kind"] == expected
    assert result["own_decision"]["status"] == "confirmed"


def test_absence_of_field_state_does_not_prove_original_blank():
    assert normalize_party_field({"raw": "", "value": ""}, "name")["state"] == "missing"
    with pytest.raises(GroupingValidationError): normalize_party_field({"raw": "名称", "value": "有内容", "state": "blank"}, "name")


def test_same_full_name_uses_same_group_across_accounts_but_similar_names_do_not():
    first = receipt(); second = deepcopy(first)
    second["parties"]["payee"]["account"] = field("11112222")
    second["parties"]["payee"]["bank"] = field("另一合成银行")
    assert run(first)["group"]["group_id"] == run(second)["group"]["group_id"]
    second["parties"]["payee"]["name"] = field("合成对手有限公司")
    assert run(first)["group"]["group_id"] != run(second)["group"]["group_id"]
    second["parties"]["payee"]["account"] = field("", "blank")
    assert run(second)["route"] == "named"


def test_name_normalization_preserves_meaningful_characters_and_internal_space():
    assert normalize_text(" ＡＢＣ　公司  ") == "ABC 公司"
    assert normalize_text("某 公司") != normalize_text("某公司")
    assert normalize_text("①公司") != normalize_text("1公司")


def test_internal_accounts_share_one_company_name_group():
    item = receipt(); item["parties"]["payee"]["name"] = field(PROFILE["company_name"])
    first = run(item)
    assert first["route"] == "internal"
    item["parties"]["payee"]["bank"] = field("中国银行合成支行")
    second = run(item)
    assert second["route"] == "internal"  # Counterparty bank does not change source bank.
    assert second["group"]["group_id"] == first["group"]["group_id"]
    assert second["group"]["display_name"] == PROFILE["company_name"]
    item["parties"]["payee"]["account"] = field("00006666")
    assert run(item)["group"]["group_id"] == second["group"]["group_id"]
    assert run(item)["counterparty"]["account"]["value"] == "00006666"


@pytest.mark.parametrize("field_name", ["bank", "account"])
def test_internal_name_is_sufficient_when_bank_or_account_is_empty(field_name):
    item = receipt(); item["parties"]["payee"]["name"] = field(PROFILE["company_name"])
    item["parties"]["payee"][field_name] = field("", "blank")
    assert run(item)["route"] == "internal"
    assert run(item)["counterparty"][field_name]["state"] == "blank"


def test_manual_fields_recompute_decision_without_changing_raw_and_restoring_default_is_pure():
    item = receipt(); original = deepcopy(item)
    manual = {"field_overrides": [{"side": "payee", "field": "name", "value": "", "state": "blank", "reason": "合成原件空白"}]}
    corrected = run(item, manual=manual)
    assert corrected["route"] == "blank"
    assert corrected["counterparty"]["name"]["raw"] == "合成对手公司"
    assert item == original
    target = {"group_id": "manual-synthetic", "kind": "named", "display_name": "人工组", "key": None}
    assigned = run(item, manual={"assignment": {"group_id": target["group_id"], "reason": "已核对"}}, groups={target["group_id"]: target})
    assert assigned["group"]["manual"] is True
    assert run(item, manual={"assignment": None})["group"] == run(item)["group"]


def test_correcting_bad_own_field_then_confirming_uses_new_effective_value():
    item = receipt(); item["parties"]["payer"]["name"] = field("合成误提取名称")
    assert run(item)["route"] == "counterparty_pending"
    manual = {"own_confirmation": confirmation(), "field_overrides": [
        {"side": "payer", "field": "name", "value": PROFILE["company_name"], "state": "present", "reason": "核对原件更正"}]}
    assert run(item, manual=manual)["route"] == "named"
    assert item["parties"]["payer"]["name"]["raw"] == "合成误提取名称"


def test_manual_group_never_resolves_identity_or_changes_special_classification():
    group = {"group_id": "manual-synthetic", "kind": "named", "display_name": "人工组", "key": None}
    manual = {"assignment": {"group_id": group["group_id"], "reason": "已核对"}}
    item = receipt(); item["source_bank"]["value"] = "中国银行"
    assert run(item, manual=manual, groups={group["group_id"]: group})["route"] == "counterparty_pending"
    item = receipt(); item.update(document_type="loan_interest_notice", document_type_confirmed=True)
    assert run(item, manual=manual, groups={group["group_id"]: group})["route"] == "special"


@pytest.mark.parametrize("changes", [
    {"account_number": 1234}, {"account_number": True}, {"account_number": "尾号3456"},
    {"account_number": "****3456"}, {"account_number": "0000\0"}, {"account_number": "1" * 129},
    {"company_name": True}, {"company_name": "a" * 257}, {"company_name": ""},
    {"account_revision": True}, {"account_revision": 2**53}, {"active": 1},
])
def test_invalid_account_values_have_stable_private_errors(changes):
    with pytest.raises(AccountValidationError) as captured:
        validate_account({**PROFILE, **changes})
    assert captured.value.code == "account_invalid"
    assert "3456" not in str(captured.value)


def test_valid_account_and_stable_error_codes():
    assert validate_account(PROFILE).account_number == "0000123456"
    assert validate_account({**PROFILE, "company_name": "合" * 256}).company_name == "合" * 256
    assert GroupingConflict.code == "grouping_conflict"
    assert GroupingSourceChanged.code == "source_changed"
    assert GroupingIncomplete.code == "grouping_incomplete"


def test_manual_inputs_need_both_assertions_and_cannot_inject_extraction_evidence():
    incomplete = confirmation(); incomplete["confirms_source_bank"] = False
    with pytest.raises(GroupingValidationError): run(manual={"own_confirmation": incomplete})
    override = {"side": "payee", "field": "name", "value": "人工名称", "state": "present", "reason": "原件", "evidence": []}
    with pytest.raises(GroupingValidationError): run(manual={"field_overrides": [override]})


def test_stable_identity_does_not_merge_distinct_imported_sources_with_identical_bytes():
    base = {"source_sha256": "a" * 64, "source_page": 1, "slot_id": "slot-1", "final_rect": {"x0": 0, "y0": 0, "x1": 100, "y1": 100}}
    assert stable_item_identity({**base, "source_key": "synthetic-a"}) != stable_item_identity({**base, "source_key": "synthetic-b"})


def test_actual_extractor_output_feeds_rules_without_changing_evidence():
    from engine.pdf_parser import ParsedPage, TextBlock
    from engine.receipt_parties import extract_receipt_parties
    texts = ["付款方名称：合成测试公司", "付款方账号：0000123456", "付款方开户行：中国工商银行合成支行",
             "收款方名称：合成对手公司", "收款方账号：00009876", "收款方开户行：中国银行合成支行"]
    blocks = tuple(TextBlock(1, text, 10, 10 + index * 25, 480, 24 + index * 25, index) for index, text in enumerate(texts))
    parsed = ParsedPage(1, 600, 600, "\n".join(texts), blocks)
    extracted = extract_receipt_parties(parsed, {"x0": 0, "y0": 0, "x1": 600, "y1": 600})
    before = deepcopy(extracted)
    item = receipt(); item["parties"] = extracted
    result = run(item)
    assert result["route"] == "named"
    assert result["counterparty"]["name"]["value"] == "合成对手公司"
    assert extracted == before


def test_unknown_side_is_batch_owned_and_direct_counterparty_can_be_corrected():
    item = {"parties": {}, "source_bank": {"value": "", "state": "unknown"}}
    before = deepcopy(item)
    pending = run(item)
    assert pending["route"] == "counterparty_pending"
    assert pending["own_decision"]["side"] is None
    assert pending["own_decision"]["method"] == "batch_profile"
    assert pending["own_decision"]["status"] == "confirmed"
    fixed = run(item, manual={"field_overrides": [
        {"side": "counterparty", "field": "name", "value": "合成确认对手", "state": "present", "reason": "对照原件"},
    ]})
    assert fixed["route"] == "named"
    assert fixed["group"]["display_name"] == "合成确认对手"
    assert fixed["counterparty"]["account"]["state"] == "missing"
    assert item == before


def test_exact_own_account_with_unclear_own_name_keeps_reliable_counterparty():
    item = receipt()
    item["parties"]["payer"]["name"] = field("合成名称甲 | 合成名称乙", state="ambiguous")
    original = deepcopy(item)
    result = run(item)
    assert result["route"] == "named"
    assert result["own_decision"]["side"] == "payer"
    assert result["own_decision"]["method"] == "batch_profile"
    assert "own_company_ambiguous" in result["warnings"]
    assert result["counterparty"]["name"]["value"] == item["parties"]["payee"]["name"]["value"]
    assert item == original


def test_internal_name_group_cannot_be_split_by_existing_manual_assignment():
    item = receipt()
    item["parties"]["payee"]["name"] = field(PROFILE["company_name"])
    target = {"group_id": "manual-old", "kind": "named", "display_name": "旧分组", "key": None}
    result = run(item, manual={"assignment": {"group_id": "manual-old", "reason": "旧记录"}}, groups={"manual-old": target})
    assert result["route"] == "internal"
    assert result["group"]["display_name"] == PROFILE["company_name"]
    assert not result["group"]["manual"]


@pytest.mark.parametrize("number", ["", PROFILE["account_number"]])
def test_both_company_names_establish_internal_group_without_guessing_direction(number):
    item = receipt()
    for side in ("payer", "payee"):
        item["parties"][side]["name"] = field(PROFILE["company_name"])
        item["parties"][side]["account"] = field(number)
    result = run(item)
    assert result["route"] == "internal"
    assert result["own_decision"]["side"] is None
    assert result["counterparty"]["account"]["state"] == "missing"
