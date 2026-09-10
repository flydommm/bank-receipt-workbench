"""Export reviewed result indexes to the single supported spreadsheet format."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import BinaryIO, overload

try:
    from .xlsx_writer import write_xlsx, write_xlsx_sheets
except ImportError:  # Support ``python engine/engine.py --serve``.
    from xlsx_writer import write_xlsx, write_xlsx_sheets  # type: ignore[no-redef]

DEFAULT_HEADERS = (
    "source_file", "source_sha256", "source_page", "segment_no", "query",
    "matched_field", "crop_mode", "review_status", "confidence", "output_file", "processed_at",
    "matched_keywords", "matched_text", "crop_x0", "crop_y0", "crop_x1", "crop_y1",
)


def export_index(path: str | Path, rows: Iterable[Mapping[str, object]], headers: tuple[str, ...] = DEFAULT_HEADERS) -> Path:
    return write_xlsx(path, headers, rows)


@overload
def export_bundle_index(path: str | Path, rows: Iterable[Mapping[str, object]],
                        mappings: Iterable[Mapping[str, object]], scope_rows: Iterable[Mapping[str, object]]) -> Path: ...


@overload
def export_bundle_index(path: BinaryIO, rows: Iterable[Mapping[str, object]],
                        mappings: Iterable[Mapping[str, object]], scope_rows: Iterable[Mapping[str, object]]) -> BinaryIO: ...


def export_bundle_index(
    path: str | Path | BinaryIO,
    rows: Iterable[Mapping[str, object]],
    mappings: Iterable[Mapping[str, object]],
    scope_rows: Iterable[Mapping[str, object]],
) -> Path | BinaryIO:
    """Write the three worksheets used by a multi-file export bundle."""

    return write_xlsx_sheets(
        path,
        (
            ("索引", DEFAULT_HEADERS, rows),
            (
                "输出映射",
                ("segment_id", "source_file", "source_page", "segment_no", "output_file", "output_page"),
                mappings,
            ),
            ("导出范围", ("item", "value"), scope_rows),
        ),
    )
