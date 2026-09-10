"""Dependency-free XLSX writer for small-to-medium result indexes."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import BinaryIO, overload
from zipfile import ZIP_DEFLATED, ZipFile
from xml.etree.ElementTree import Element, SubElement, tostring

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _xml_text(value: object) -> str:
    text = "" if value is None else str(value)
    # XML 1.0 cannot contain most C0 controls.  Keep the three whitespace
    # controls that XML explicitly permits and replace the rest so an audit
    # index remains readable even when a source label is malformed.
    return "".join(
        character
        if (character in "\t\n\r" or 0x20 <= ord(character) <= 0xD7FF
            or 0xE000 <= ord(character) <= 0xFFFD or 0x10000 <= ord(character) <= 0x10FFFF)
        else "_"
        for character in text
    )


def _column_name(index: int) -> str:
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def _cell(parent: Element, reference: str, value: object) -> None:
    cell = SubElement(parent, f"{{{NS}}}c", {"r": reference})
    if isinstance(value, bool | int | float):
        SubElement(cell, f"{{{NS}}}v").text = str(int(value) if isinstance(value, bool) else value)
    else:
        cell.set("t", "inlineStr")
        inline = SubElement(cell, f"{{{NS}}}is")
        text = _xml_text(value)
        text_element = SubElement(inline, f"{{{NS}}}t")
        if text[:1].isspace() or text[-1:].isspace():
            text_element.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        text_element.text = text


def _worksheet(headers: Sequence[str], rows: Iterable[Mapping[str, object]]) -> Element:
    sheet = Element(f"{{{NS}}}worksheet")
    data = SubElement(sheet, f"{{{NS}}}sheetData")
    header_row = SubElement(data, f"{{{NS}}}row", {"r": "1"})
    for index, header in enumerate(headers, 1):
        _cell(header_row, f"{_column_name(index)}1", header)
    for row_number, row in enumerate(rows, 2):
        row_element = SubElement(data, f"{{{NS}}}row", {"r": str(row_number)})
        for index, header in enumerate(headers, 1):
            _cell(row_element, f"{_column_name(index)}{row_number}", row.get(header))
    return sheet


@overload
def write_xlsx_sheets(path: str | Path, sheets: Iterable[tuple[str, Sequence[str], Iterable[Mapping[str, object]]]]) -> Path: ...


@overload
def write_xlsx_sheets(path: BinaryIO, sheets: Iterable[tuple[str, Sequence[str], Iterable[Mapping[str, object]]]]) -> BinaryIO: ...


def write_xlsx_sheets(
    path: str | Path | BinaryIO,
    sheets: Iterable[tuple[str, Sequence[str], Iterable[Mapping[str, object]]]],
) -> Path | BinaryIO:
    """Write one or more named worksheets using inline strings for text cells."""

    output: Path | BinaryIO
    if isinstance(path, (str, Path)):
        output = Path(path)
        output.parent.mkdir(parents=True, exist_ok=True)
    else:
        # The caller retains ownership of an already-open binary stream.
        # ZipFile neither reopens its pathname nor closes this stream.
        output = path
    materialized = list(sheets)
    if not materialized:
        raise ValueError("at least one worksheet is required")
    worksheets: list[tuple[str, Element]] = []
    seen_names: set[str] = set()
    for index, item in enumerate(materialized):
        if isinstance(item, (str, bytes, bytearray)) or not isinstance(item, Sequence) or len(item) != 3:
            raise ValueError(f"worksheet {index} must be a (name, headers, rows) tuple")
        name, headers, rows = item
        if not isinstance(name, str) or not name or len(name) > 31 or any(char in name for char in "[]:*?/\\"):
            raise ValueError(f"worksheet {index} has an invalid name")
        folded_name = name.casefold()
        if folded_name in seen_names:
            raise ValueError(f"duplicate worksheet name: {name}")
        seen_names.add(folded_name)
        if isinstance(headers, (str, bytes, bytearray)):
            raise ValueError(f"worksheet {index} headers must be a sequence")
        try:
            header_values = tuple(headers)
        except TypeError as exc:
            raise ValueError(f"worksheet {index} headers must be a sequence") from exc
        worksheets.append((name, _worksheet(header_values, rows)))

    # The relationships namespace is declared automatically from the namespaced
    # ``r:id`` attributes.  Adding a literal ``xmlns:r`` here can duplicate the
    # declaration after another XML library has registered the ``r`` prefix.
    workbook = Element(f"{{{NS}}}workbook")
    sheets_element = SubElement(workbook, f"{{{NS}}}sheets")
    for index, (name, _sheet) in enumerate(worksheets, 1):
        SubElement(
            sheets_element,
            f"{{{NS}}}sheet",
            {"name": name, "sheetId": str(index), f"{{{REL_NS}}}id": f"rId{index}"},
        )
    styles = f'<styleSheet xmlns="{NS}"><numFmts count="0"/><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" pivotButton="0" quotePrefix="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleMedium9"/></styleSheet>'
    worksheet_overrides = "".join(
        f'<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for index in range(1, len(worksheets) + 1)
    )
    content_types = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>{worksheet_overrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'''
    root_rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    worksheet_rels = "".join(
        f'<Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>'
        for index in range(1, len(worksheets) + 1)
    )
    styles_rel_id = len(worksheets) + 1
    workbook_rels = f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{worksheet_rels}<Relationship Id="rId{styles_rel_id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", root_rels)
        archive.writestr("xl/workbook.xml", tostring(workbook, encoding="utf-8", xml_declaration=True))
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        for index, (_name, sheet) in enumerate(worksheets, 1):
            archive.writestr(f"xl/worksheets/sheet{index}.xml", tostring(sheet, encoding="utf-8", xml_declaration=True))
        archive.writestr("xl/styles.xml", styles)
    return output


def write_xlsx(path: str | Path, headers: Sequence[str], rows: Iterable[Mapping[str, object]]) -> Path:
    """Compatibility wrapper for the original single ``索引`` worksheet."""

    return write_xlsx_sheets(path, (("索引", headers, rows),))
