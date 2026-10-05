"""Exercise XLSX account import in the selected private Python runtime."""
from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path
import sys


def verify() -> None:
    # Isolated Python does not add the checkout to sys.path automatically.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from openpyxl import Workbook
    from engine.company_account_import import HEADERS, import_accounts, preview_accounts
    from engine.receipt_grouping_store import GroupingStore

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "本方账户"
    sheet.append(list(HEADERS))
    sheet.append(["示例公司", "示例银行", "示例支行", "00123456789012345678"])
    output = BytesIO()
    workbook.save(output)
    workbook.close()
    with GroupingStore() as store:
        preview = preview_accounts(store, base64.b64encode(output.getvalue()).decode("ascii"))
        assert preview["counts"] == {"ready": 1, "duplicate": 0, "error": 0}
        account = preview["rows"][0]["account"]
        assert account["account_number"] == "00123456789012345678"
        assert import_accounts(store, [account]) == {"created": 1, "skipped": 0}
        assert import_accounts(store, [account]) == {"created": 0, "skipped": 1}


if __name__ == "__main__":
    verify()
    print("Private runtime XLSX account import passed.")
