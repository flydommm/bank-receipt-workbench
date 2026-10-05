from io import BytesIO
from zipfile import ZipFile
from xml.etree import ElementTree as ET
from contextlib import contextmanager
from pathlib import Path
import os

import pytest

from engine.receipt_grouping_draft import _draft_prefix, draft_sheets, write_draft


_DRAFT_NAME = "合成_等2份_交易对手核对草稿.xlsx"
_FINAL_PATTERN = "合成_等2份_交易对手核对草稿_*"


def draft_fixture():
    field = {"raw": "=合成名称", "value": "=合成名称", "state": "present", "evidence": []}
    party = {"name": field, "account": {**field, "raw": "000123", "value": "000123"}, "bank": field}
    item = {"binding": {"segment_id": "s", "source_key": "/synthetic.pdf", "source_sha256": "a" * 64,
                        "source_page": 1, "position_index": 2},
            "own_decision": {"method": "none", "side": None, "source_bank_status": "unknown", "reasons": ["需人工核对"]},
            "group": None, "boundary_status": "pending", "document_type": None, "extraction_state": "ready",
            "route": "own_pending", "decision_method": "none", "field_overrides": [], "warnings": ["账号缺失"],
            "basis_fingerprint": "b" * 64, "extracted": {"payer": party, "payee": party}, "counterparty": party}
    snapshot = {"header": {"own_account": {"company_name": "合成公司", "bank_name": "测试银行", "branch_name": "测试支行",
                                           "account_number": "000001", "fingerprint": "c" * 64},
                           "job_id": "j", "result_revision": "r", "grouping_revision": 2, "review_fingerprint": "d" * 64},
                "items": [item, {**item, "binding": {**item["binding"], "segment_id": "excluded"}, "route": "excluded"}]}
    job = {"sources": [{"source_key": "/synthetic.pdf", "name": "合成.pdf", "access_path": "/synthetic.pdf", "state": "verified"},
                       {"source_key": "/failed.pdf", "name": "失败.pdf", "access_path": "/failed.pdf", "state": "failed"}]}
    return snapshot, job


@pytest.mark.parametrize("names, expected", [
    (["银行回单_合成公司_测试银行_202607.pdf"], "银行回单_合成公司_测试银行_202607_交易对手核对草稿"),
    (["七月回单.PDF", "八月回单.pdf"], "七月回单_等2份_交易对手核对草稿"),
    (["无月份信息.pdf"], "无月份信息_交易对手核对草稿"),
])
def test_draft_names_identify_sources_without_guessing_months(names, expected):
    job = {"sources": [{"name": name} for name in names]}
    assert _draft_prefix(job) == expected


@pytest.mark.parametrize("name", [
    r"C:\private\报告<>:\"|?*.pdf", "../报告.pdf", "..\\报告.pdf",
    "CON.pdf", "CON.报告.pdf", "COM¹.报告.pdf", " 报告 .pdf",
    "报\x00\x1f\x7f\x85\u202e告.pdf", "😀" * 200 + ".pdf", " .pdf",
])
def test_draft_source_names_are_safe_and_length_limited(name):
    import re
    from engine.export_plan import _utf16_units
    prefix = _draft_prefix({"sources": [{"name": name}]})
    assert prefix.endswith("_交易对手核对草稿")
    assert 0 < _utf16_units(prefix) <= 120
    assert not re.search(r'[<>:"/\\|?*\x00-\x1f\x7f-\x9f\u202e]', prefix)
    assert not prefix.startswith((".", " ")) and not prefix.endswith((".", " "))
    assert not re.match(r"(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)", prefix, re.I)


def test_draft_empty_display_name_falls_back_to_source_path_basename():
    assert _draft_prefix({"sources": [{"name": "", "access_path": r"D:\local\来源202607.pdf"}]}) == "来源202607_交易对手核对草稿"


def test_draft_contains_unconfirmed_excluded_and_failed_sources():
    snapshot, job = draft_fixture()
    sheets = draft_sheets(snapshot, job, "2026-09-28T00:00:00Z")
    rows = sheets[1][2]
    assert [row["当前去向"] for row in rows] == ["本方待确认", "已排除"]
    assert rows[0]["原页码"] == 1 and rows[0]["原栏位"] == 2
    assert len(sheets[2][2]) == 1
    assert sheets[2][2][0]["原文件"] == "失败.pdf"


def test_draft_accounts_and_formula_like_source_values_are_text():
    snapshot, job = draft_fixture()
    output = BytesIO()
    write_draft(output, snapshot, job, "2026-09-28T00:00:00Z")
    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with ZipFile(output) as archive:
        cells = []
        for name in archive.namelist():
            if name.startswith("xl/worksheets/sheet"):
                root = ET.fromstring(archive.read(name))
                assert root.findall(".//s:f", ns) == []
                cells.extend(root.findall(".//s:c", ns))
        text_cells = {"".join(cell.itertext()) for cell in cells if cell.attrib.get("t") == "inlineStr"}
        assert {"000123", "000001", "=合成名称"} <= text_cells


def test_draft_translates_special_document_and_batch_profile_labels():
    snapshot, job = draft_fixture()
    item = snapshot["items"][0]
    item.update(route="special", document_type="electronic_tax_payment",
        group={"group_id": "special-tax", "kind": "special", "display_name": "electronic_tax_payment"})
    item["own_decision"] = {**item["own_decision"], "method": "batch_profile"}
    row = draft_sheets(snapshot, job, "now")[1][2][0]
    assert row["凭证类型"] == row["分组名称"] == "电子缴税付款凭证"
    assert row["本方识别方式"] == "本批账户资料"


def test_draft_publication_does_not_overwrite_and_rechecks_snapshot(tmp_path, monkeypatch):
    from contextlib import contextmanager
    from hashlib import sha256
    import os
    import pytest
    import engine.receipt_grouping_draft as module
    from engine.export_scope import ExportScopeError
    if os.name != "nt":
        pytest.skip("native safe directory publication requires Windows")
    snapshot, job = draft_fixture()
    parent = tmp_path / "outputs"
    parent.mkdir()
    existing = parent / "已有核对表.xlsx"
    existing.write_bytes(b"keep-existing")
    request = {"job_id": "j", "result_revision": "r", "expected_grouping_revision": 2,
               "expected_review_fingerprint": "d" * 64, "own_account_fingerprint": "c" * 64,
               "directory": str(parent)}
    calls = []

    @contextmanager
    def current(*_args):
        calls.append(True)
        yield snapshot, job, "same-snapshot"

    monkeypatch.setattr(module, "_hold_draft", current)
    result = module.publish_grouping_draft(tmp_path / "batch.sqlite3", tmp_path / "review.sqlite3", request)
    from pathlib import Path
    output = Path(result["path"])
    assert result["state"] == "draft_published" and result["row_count"] == 2 and len(calls) == 2
    assert output.name == result["name"] == _DRAFT_NAME
    assert output.parent.name.startswith(_DRAFT_NAME[:-5] + "_")
    assert output.parent.parent == parent
    assert sha256(output.read_bytes()).hexdigest() == result["sha256"]
    assert existing.read_bytes() == b"keep-existing"
    calls.clear()

    @contextmanager
    def changed(*_args):
        calls.append(True)
        yield snapshot, job, "first" if len(calls) == 1 else "changed"

    monkeypatch.setattr(module, "_hold_draft", changed)
    with pytest.raises(ExportScopeError) as failure:
        module.publish_grouping_draft(tmp_path / "batch.sqlite3", tmp_path / "review.sqlite3", request)
    assert failure.value.code == "export_scope_stale"
    assert len(list(parent.glob(_FINAL_PATTERN))) == 1
    assert output.is_file() and existing.read_bytes() == b"keep-existing"


def publication_fixture(tmp_path, monkeypatch):
    import engine.receipt_grouping_draft as module
    if os.name != "nt":
        pytest.skip("native safe directory publication requires Windows")
    snapshot, job = draft_fixture()
    parent = tmp_path / "outputs"
    parent.mkdir()
    request = {"job_id": "j", "result_revision": "r", "expected_grouping_revision": 2,
               "expected_review_fingerprint": "d" * 64, "own_account_fingerprint": "c" * 64,
               "directory": str(parent)}

    @contextmanager
    def current(*_args):
        yield snapshot, job, "same-snapshot"

    monkeypatch.setattr(module, "_hold_draft", current)
    return module, parent, request


def test_repeated_drafts_keep_distinct_folders_and_existing_workbook(tmp_path, monkeypatch):
    module, parent, request = publication_fixture(tmp_path, monkeypatch)
    first = module.publish_grouping_draft(tmp_path / "batch.sqlite3", tmp_path / "review.sqlite3", request)
    original = Path(first["path"]).read_bytes()
    second = module.publish_grouping_draft(tmp_path / "batch.sqlite3", tmp_path / "review.sqlite3", request)
    assert first["directory"] != second["directory"]
    assert Path(first["path"]).read_bytes() == original
    assert Path(second["path"]).name == _DRAFT_NAME
    assert len(list(parent.glob(_FINAL_PATTERN))) == 2


@pytest.mark.parametrize("source_name", ["回单_合成公司_测试银行_202607.pdf", "长来源" * 80 + ".pdf"])
def test_single_source_publishes_named_workbook_in_named_folder(tmp_path, monkeypatch, source_name):
    from engine.export_plan import _utf16_units
    module, parent, request = publication_fixture(tmp_path, monkeypatch)
    snapshot, job = draft_fixture()
    job["sources"] = [dict(job["sources"][0], name=source_name)]

    @contextmanager
    def current(*_args):
        yield snapshot, job, "same-snapshot"

    monkeypatch.setattr(module, "_hold_draft", current)
    result = module.publish_grouping_draft(tmp_path / "batch.sqlite3", tmp_path / "review.sqlite3", request)
    output = Path(result["path"])
    assert output.is_file() and output.parent.parent == parent
    assert output.name.startswith(source_name[:3]) and output.name.endswith("_交易对手核对草稿.xlsx")
    assert output.parent.name.startswith(output.stem + "_")
    assert _utf16_units(output.name) <= 240 and _utf16_units(output.parent.name) <= 240
    if "202607" in source_name:
        assert output.name == "回单_合成公司_测试银行_202607_交易对手核对草稿.xlsx"


def test_draft_final_name_collision_preserves_existing_directory(tmp_path, monkeypatch):
    from engine.export_scope import ExportScopeError
    import engine.export_directory as directory
    module, parent, request = publication_fixture(tmp_path, monkeypatch)
    original_rename = directory.rename_directory_no_replace

    def occupy_then_rename(source, target, *args):
        target.mkdir()
        (target / "existing.txt").write_bytes(b"keep-existing-output")
        original_rename(source, target, *args)

    monkeypatch.setattr(directory, "rename_directory_no_replace", occupy_then_rename)
    with pytest.raises(ExportScopeError):
        module.publish_grouping_draft(tmp_path / "batch.sqlite3", tmp_path / "review.sqlite3", request)
    final = next(parent.glob(_FINAL_PATTERN))
    assert (final / "existing.txt").read_bytes() == b"keep-existing-output"
    assert not (final / _DRAFT_NAME).exists()


@pytest.mark.parametrize("when", ["before_final_check", "before_rename", "after_rename"])
def test_draft_rejects_unregistered_files_at_publication_boundaries(tmp_path, monkeypatch, when):
    from engine.export_scope import ExportScopeError
    import engine.export_directory as directory
    module, parent, request = publication_fixture(tmp_path, monkeypatch)
    original_hold, original_rename = module._hold_draft, directory.rename_directory_no_replace
    calls = 0

    def add_file(folder):
        foreign = folder / "unregistered.txt"
        foreign.write_bytes(b"foreign-content")

    @contextmanager
    def hold(*args):
        nonlocal calls
        calls += 1
        if calls == 2 and when == "before_final_check":
            add_file(next(parent.glob("." + _FINAL_PATTERN + ".tmp")))
        with original_hold(*args) as value:
            yield value

    def rename(source, target, *args):
        if when == "before_rename":
            add_file(source)
        original_rename(source, target, *args)
        if when == "after_rename":
            add_file(target)

    monkeypatch.setattr(module, "_hold_draft", hold)
    monkeypatch.setattr(directory, "rename_directory_no_replace", rename)
    with pytest.raises(ExportScopeError) as failure:
        module.publish_grouping_draft(tmp_path / "batch.sqlite3", tmp_path / "review.sqlite3", request)
    assert failure.value.code == "draft_export_failed"
    remaining = list(parent.rglob("unregistered.txt"))
    assert len(remaining) == 1 and remaining[0].read_bytes() == b"foreign-content"
    assert any(Path(row["path"]) == remaining[0].parent for row in failure.value.residuals)
    if when == "before_final_check":
        assert not list(parent.glob(_FINAL_PATTERN))


def test_draft_rejects_write_during_rename_without_reporting_success(tmp_path, monkeypatch):
    from engine.export_scope import ExportScopeError
    import engine.export_directory as directory
    module, parent, request = publication_fixture(tmp_path, monkeypatch)
    original_rename = directory.rename_directory_no_replace

    def rename(source, target, *args):
        (source / _DRAFT_NAME).write_bytes(b"changed-during-rename")
        original_rename(source, target, *args)

    monkeypatch.setattr(directory, "rename_directory_no_replace", rename)
    with pytest.raises(ExportScopeError) as failure:
        module.publish_grouping_draft(tmp_path / "batch.sqlite3", tmp_path / "review.sqlite3", request)
    assert failure.value.code == "draft_export_failed"
    final = next(parent.glob(_FINAL_PATTERN))
    assert (final / _DRAFT_NAME).read_bytes() == b"changed-during-rename"
    assert any(Path(row["path"]) == final for row in failure.value.residuals)


def test_draft_rejects_same_bytes_replacement_during_rename(tmp_path, monkeypatch):
    from engine.export_scope import ExportScopeError
    import engine.export_directory as directory
    module, parent, request = publication_fixture(tmp_path, monkeypatch)
    original_rename = directory.rename_directory_no_replace

    def rename(source, target, *args):
        original = source / _DRAFT_NAME
        replacement = source / "replacement.xlsx"
        replacement.write_bytes(original.read_bytes())
        os.replace(replacement, original)
        original_rename(source, target, *args)

    monkeypatch.setattr(directory, "rename_directory_no_replace", rename)
    with pytest.raises(ExportScopeError) as failure:
        module.publish_grouping_draft(tmp_path / "batch.sqlite3", tmp_path / "review.sqlite3", request)
    assert failure.value.code == "draft_export_failed"
    final = next(parent.glob(_FINAL_PATTERN))
    assert any(Path(row["path"]) == final for row in failure.value.residuals)
    assert (final / _DRAFT_NAME).is_file()


def test_draft_rejects_replaced_directory_after_rename(tmp_path, monkeypatch):
    from engine.export_scope import ExportScopeError
    import engine.export_directory as directory
    module, parent, request = publication_fixture(tmp_path, monkeypatch)
    original_rename = directory.rename_directory_no_replace

    def rename(source, target, *args):
        original_rename(source, target, *args)
        displaced = target.with_name("displaced-draft")
        target.rename(displaced)
        target.mkdir()
        name = _DRAFT_NAME
        (target / name).write_bytes((displaced / name).read_bytes())

    monkeypatch.setattr(directory, "rename_directory_no_replace", rename)
    with pytest.raises(ExportScopeError) as failure:
        module.publish_grouping_draft(tmp_path / "batch.sqlite3", tmp_path / "review.sqlite3", request)
    assert failure.value.code == "draft_export_failed"
    final = next(parent.glob(_FINAL_PATTERN))
    assert any(Path(row["path"]) == final for row in failure.value.residuals)
    assert (parent / "displaced-draft" / _DRAFT_NAME).is_file()


@pytest.mark.parametrize("code", ["source_changed", "file_not_found"])
def test_draft_preserves_source_failure_code(tmp_path, monkeypatch, code):
    from engine.batch_pdf import BatchSourceError
    from engine.export_scope import ExportScopeError
    module, parent, request = publication_fixture(tmp_path, monkeypatch)

    @contextmanager
    def changed(*_args):
        raise BatchSourceError(code)
        yield  # pragma: no cover - context manager protocol

    monkeypatch.setattr(module, "_hold_draft", changed)
    with pytest.raises(ExportScopeError) as failure:
        module.publish_grouping_draft(tmp_path / "batch.sqlite3", tmp_path / "review.sqlite3", request)
    assert failure.value.code == code
    assert list(parent.iterdir()) == []
