"""Read-only extraction of payer and payee fields from one receipt region.

This module deliberately stops at the text-layer boundary.  It does not decide
which side belongs to the user's company and it does not assign a counterparty
group.  The caller supplies a loaded page (or a :class:`ParsedPage`) and a
visible rectangle; all text and geometry used by the result must come from that
rectangle.

``extract_receipt_parties`` returns a JSON-friendly dictionary::

    {
        "payer": {"name": field, "account": field, "bank": field},
        "payee": {"name": field, "account": field, "bank": field},
        "diagnostics": {"status": "ok"|"needs_review", "issues": [...], ...},
    }

Each field has ``raw``, ``value`` (also exposed as ``normalized`` for callers
that use that name), ``state`` and ``evidence``.  State is
one of ``present``, ``blank``, ``missing`` or ``ambiguous``.  A blank state is
only emitted for an explicit empty-value marker or a fully bounded table cell
whose visible interior has been checked as empty. A label ending in ``:``
without cell evidence remains ``missing``.
Masked or suffix-only account numbers are ``ambiguous`` so that the outer
workflow can request confirmation instead of guessing.

The parser is intentionally conservative.  It works with the labelled layouts
validated by tests (vertical blocks, two-column tables and label/value lines),
and reports unknown layouts as missing or ambiguous.  It does not use OCR,
amounts, dates, fuzzy company-name correction, or a whole-page regular
expression.
"""

from __future__ import annotations

from dataclasses import dataclass, field as dataclass_field
import math
import re
import unicodedata
from typing import Any, Iterable, Mapping, Sequence

try:
    from .pdf_parser import ParsedPage, TextBlock, fitz
except ImportError:  # pragma: no cover - direct script compatibility
    from pdf_parser import ParsedPage, TextBlock, fitz  # type: ignore[no-redef]


FIELD_NAMES = ("name", "account", "bank")
SIDES = ("payer", "payee")
STATES = ("present", "blank", "missing", "ambiguous")


@dataclass(frozen=True)
class _Piece:
    text: str
    rect: tuple[float, float, float, float]


@dataclass(frozen=True)
class _Line:
    pieces: tuple[_Piece, ...]
    rect: tuple[float, float, float, float]
    source_index: int

    @property
    def text(self) -> str:
        # Text blocks and word records already carry reading order.  Joining
        # without invented spaces lets labels split over separate words (e.g.
        # ``付款方 名称``) still match.  Geometry remains available on pieces.
        return "".join(piece.text for piece in self.pieces)

    def text_with_map(self) -> tuple[str, tuple[int, ...]]:
        """Return concatenated text and piece index for every character."""

        chars: list[str] = []
        piece_indices: list[int] = []
        for index, piece in enumerate(self.pieces):
            chars.extend(piece.text)
            piece_indices.extend([index] * len(piece.text))
        return "".join(chars), tuple(piece_indices)

    def rect_for_span(self, start: int, end: int) -> tuple[float, float, float, float] | None:
        text, indices = self.text_with_map()
        if start < 0 or end <= start or start >= len(text) or not indices:
            return None
        end = min(end, len(text))
        chosen = [self.pieces[index].rect for index in set(indices[start:end])]
        return _union_rects(chosen)


@dataclass(frozen=True)
class _Label:
    side: str
    field: str
    text: str
    start: int
    end: int
    rect: tuple[float, float, float, float]
    line_index: int
    explicit_side: bool
    delimiter: bool = False
    value_stop: int | None = None


@dataclass(frozen=True)
class _Candidate:
    side: str
    field: str
    raw: str
    normalized: str
    state: str
    evidence: dict[str, Any]
    line_index: int
    source: str


@dataclass(frozen=True)
class _VerticalHeader:
    side: str
    rect: tuple[float, float, float, float]
    line_indexes: tuple[int, ...]
    unit_height: float = 0.0


@dataclass(frozen=True)
class _Rect:
    x0: float
    y0: float
    x1: float
    y1: float

    def as_dict(self) -> dict[str, float]:
        return {"x0": self.x0, "y0": self.y0, "x1": self.x1, "y1": self.y1}


_SIDE_ALIASES: dict[str, tuple[str, ...]] = {
    "payer": (
        "付款方", "付款人", "付款单位", "付款户名", "付款账户", "付款账号",
        "付款", "付方", "付出方",
    ),
    "payee": (
        "收款方", "收款人", "收款单位", "收款户名", "收款账户", "收款账号",
        "收款", "收方", "收款方",
    ),
}

_FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "name": ("账户名称", "帐户名称", "名称", "户名", "单位名称", "姓名"),
    "account": ("账号", "帐号", "账户号码", "账户", "卡号", "账号户号"),
    "bank": ("开户银行名称", "开户行名称", "开户行名", "开户银行", "开户行", "开户机构", "银行", "行名"),
}

# Direct labels prevent a bare ``付款账号`` from being interpreted as a name
# label plus an account-valued string.  Longer aliases are always considered
# first when line matches are collected.
_DIRECT_LABELS: tuple[tuple[str, str, str], ...] = (
    ("付款方账号", "payer", "account"),
    ("付款方帐号", "payer", "account"),
    ("付款方账户", "payer", "account"),
    ("付款人账号", "payer", "account"),
    ("付款人帐号", "payer", "account"),
    ("付款人账户", "payer", "account"),
    ("付款户名", "payer", "name"),
    ("付款名称", "payer", "name"),
    ("付款行行名", "payer", "bank"),
    ("付款行名称", "payer", "bank"),
    ("收款方账号", "payee", "account"),
    ("收款方帐号", "payee", "account"),
    ("收款方账户", "payee", "account"),
    ("收款人账号", "payee", "account"),
    ("收款人帐号", "payee", "account"),
    ("收款人账户", "payee", "account"),
    ("收款人户名", "payee", "name"),
    ("收款人名称", "payee", "name"),
    ("收款行行名", "payee", "bank"),
    ("收款行名称", "payee", "bank"),
    ("付款账号", "payer", "account"),
    ("付款帐号", "payer", "account"),
    ("付款账户", "payer", "account"),
    ("收款账号", "payee", "account"),
    ("收款帐号", "payee", "account"),
    ("收款账户", "payee", "account"),
    ("付款行", "payer", "bank"),
    ("收款行", "payee", "bank"),
)

# Electronic tax payment vouchers use labels whose business meaning is more
# specific than the generic payer/payee vocabulary.  In particular, the
# collection authority and the treasury bank are two different values.  Keep
# these aliases behind the tax-voucher context gate below so text from a tax
# explanation on an ordinary receipt cannot invent a party field.
_TAX_LABELS: tuple[tuple[str, str, str, bool], ...] = (
    ("付款人全称", "payer", "name", True),
    ("付款方全称", "payer", "name", True),
    ("付款人开户银行", "payer", "bank", True),
    ("付款人开户行", "payer", "bank", True),
    ("征收机关名称", "payee", "name", True),
    ("收款国库（银行）名称", "payee", "bank", True),
    ("收款国库(银行)名称", "payee", "bank", True),
)

_TAX_VOUCHER_TITLES = frozenset({"电子缴税付款凭证", "上海银行电子缴税付款凭证"})

# 宁波银行客户回单把本方的账号、户名、开户银行放在一张没有付款／
# 收款前缀的表格中，再用“转账存入／转账支取”说明方向。只有在当前
# 回单范围内同时看到完整标题、唯一方向和三类通用字段时才启用该版式
# 规则；这样不会把普通回单或相邻片段的通用标签强行归到一侧。
_NINGBO_RECEIPT_TITLES = frozenset({"宁波银行客户回单"})
_NINGBO_DIRECTIONS = {"转账存入": "payee", "转账支取": "payer"}
_NINGBO_GENERIC_FIELDS = frozenset({"name", "account", "bank"})

_HUAXIA_ONLINE_TITLE = "客户回单网上支付跨行清算业务"
_HUAXIA_SMALL_TITLE = "客户回单小额支付系统业务"

_GENERIC_FIELD_ALIASES: dict[str, str] = {
    alias: field_name
    for field_name, aliases in _FIELD_ALIASES.items()
    for alias in aliases
}

_VALUE_SEPARATORS = "：:;；=\t "
_BLANK_MARKERS = {"", "空", "空白", "未提供", "无", "—", "–", "-", "/", "\\"}
_MASK_CHARS = set("*＊×xX")
_ACCOUNT_DIGIT_RE = re.compile(r"\d")
_SUFFIX_ACCOUNT_RE = re.compile(r"(?:尾号|末四位|后四位|后\d+位)\s*[：:]?\s*\d{2,8}$")


def _finite(value: Any) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("rectangle coordinates must be finite")
    return number


def _coerce_rect(value: Any, *, name: str = "rect") -> _Rect:
    if isinstance(value, Mapping):
        try:
            numbers = tuple(_finite(value[key]) for key in ("x0", "y0", "x1", "y1"))
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"{name} must contain x0/y0/x1/y1") from error
    else:
        try:
            numbers = tuple(_finite(item) for item in value)
        except (TypeError, ValueError) as error:
            raise ValueError(f"{name} must contain four finite numbers") from error
        if len(numbers) != 4:
            raise ValueError(f"{name} must contain four finite numbers")
    x0, y0, x1, y1 = numbers
    if x1 <= x0 or y1 <= y0:
        raise ValueError(f"{name} must be ordered and non-empty")
    return _Rect(x0, y0, x1, y1)


def _rect_tuple(value: Any) -> tuple[float, float, float, float]:
    return tuple(_finite(item) for item in value)  # type: ignore[return-value]


def _intersection_area(first: tuple[float, float, float, float], second: _Rect) -> float:
    return max(0.0, min(first[2], second.x1) - max(first[0], second.x0)) * max(
        0.0, min(first[3], second.y1) - max(first[1], second.y0)
    )


def _rect_area(rect: tuple[float, float, float, float]) -> float:
    return max(0.0, rect[2] - rect[0]) * max(0.0, rect[3] - rect[1])


def _inside(rect: tuple[float, float, float, float], scope: _Rect, tolerance: float = 0.5) -> bool:
    return (
        rect[0] >= scope.x0 - tolerance
        and rect[1] >= scope.y0 - tolerance
        and rect[2] <= scope.x1 + tolerance
        and rect[3] <= scope.y1 + tolerance
    )


def _union_rects(rects: Iterable[tuple[float, float, float, float]]) -> tuple[float, float, float, float] | None:
    records = list(rects)
    if not records:
        return None
    return (
        min(rect[0] for rect in records), min(rect[1] for rect in records),
        max(rect[2] for rect in records), max(rect[3] for rect in records),
    )


def _normal_text(value: str) -> str:
    # NFKC handles full-width punctuation/digits.  We intentionally do not
    # remove meaningful characters or attempt name correction.
    return " ".join(unicodedata.normalize("NFKC", value).split())


def _normal_account(value: str) -> str:
    return "".join(unicodedata.normalize("NFKC", value).split())


def _field_normalized(field_name: str, value: str) -> str:
    return _normal_account(value) if field_name == "account" else _normal_text(value)


def _account_state(value: str) -> tuple[str, str]:
    normalized = _normal_account(value)
    if not normalized:
        return "blank", normalized
    if any(char in normalized for char in _MASK_CHARS) or _SUFFIX_ACCOUNT_RE.search(normalized):
        return "ambiguous", normalized
    # An account with no digits is a labelled value but cannot be treated as a
    # usable account identifier.  Preserve the value for the review screen.
    if not _ACCOUNT_DIGIT_RE.search(normalized):
        return "ambiguous", normalized
    return "present", normalized


def _line_rect(pieces: Sequence[_Piece]) -> tuple[float, float, float, float]:
    rect = _union_rects(piece.rect for piece in pieces)
    if rect is None:
        raise ValueError("a line needs at least one text piece")
    return rect


def _text_piece(text: Any, bbox: Any) -> _Piece | None:
    if not isinstance(text, str) or not text.strip():
        return None
    try:
        rect = _rect_tuple(bbox)
    except (TypeError, ValueError):
        return None
    if rect[2] <= rect[0] or rect[3] <= rect[1]:
        return None
    return _Piece(text, rect)


def _page_scope(page: Any) -> _Rect:
    if isinstance(page, ParsedPage):
        return _Rect(0.0, 0.0, float(page.width), float(page.height))
    rect = getattr(page, "rect", None)
    if rect is None:
        raise ValueError("page must be a ParsedPage or expose a rect")
    return _coerce_rect((rect.x0, rect.y0, rect.x1, rect.y1), name="page rect")


def _call_get_text(page: Any, mode: str, scope: _Rect) -> Any:
    """Read text with a clip; fallback is still filtered geometrically."""

    options = {}
    if mode in {"dict", "rawdict"}:
        # Images do not supply characters. The default dict flags encode all
        # image blocks too, which can dominate extraction of stamped PDFs.
        options["flags"] = getattr(fitz, "TEXTFLAGS_" + mode.upper()) & ~fitz.TEXT_PRESERVE_IMAGES
    try:
        return page.get_text(mode, clip=(scope.x0, scope.y0, scope.x1, scope.y1), sort=True, **options)
    except TypeError:
        # Lightweight page doubles in the existing tests may not accept clip or
        # sort.  Their returned geometry is filtered below before use.
        try:
            return page.get_text(mode, sort=True)
        except TypeError:
            return page.get_text(mode)


def _filter_piece(piece: _Piece, scope: _Rect, issues: list[dict[str, Any]]) -> _Piece | None:
    if _inside(piece.rect, scope):
        return piece
    overlap = _intersection_area(piece.rect, scope)
    if overlap > 0 and _rect_area(piece.rect) > 0:
        issues.append({
            "code": "text_crosses_scope",
            "message": "文字框跨过当前回单边界，已排除以避免拼入邻栏或相邻回单",
            "rect": _rect_dict(piece.rect),
        })
    return None


def _lines_from_parsed_page(page: ParsedPage, scope: _Rect, issues: list[dict[str, Any]]) -> list[_Line]:
    lines: list[_Line] = []
    for block in page.blocks:
        if block.is_watermark:
            continue
        raw_lines = str(block.text).splitlines() or [str(block.text)]
        block_rect = (float(block.x0), float(block.y0), float(block.x1), float(block.y1))
        line_height = (block_rect[3] - block_rect[1]) / max(1, len(raw_lines))
        for line_offset, raw_line in enumerate(raw_lines):
            if not raw_line.strip():
                continue
            line_rect = (
                block_rect[0], block_rect[1] + line_offset * line_height,
                block_rect[2], block_rect[1] + (line_offset + 1) * line_height,
            )
            piece = _text_piece(raw_line.strip(), line_rect)
            if piece is None:
                continue
            piece = _filter_piece(piece, scope, issues)
            if piece is not None:
                lines.append(_Line((piece,), line_rect, len(lines)))
    return lines


def _lines_from_words(page: Any, scope: _Rect, issues: list[dict[str, Any]]) -> list[_Line]:
    raw_words = _call_get_text(page, "words", scope)
    if not isinstance(raw_words, (list, tuple)):
        return []
    grouped: dict[tuple[Any, Any], list[_Piece]] = {}
    fallback_lines: list[list[_Piece]] = []
    for item in raw_words:
        if not isinstance(item, (list, tuple)) or len(item) < 5:
            continue
        piece = _text_piece(item[4], item[:4])
        if piece is None:
            continue
        filtered = _filter_piece(piece, scope, issues)
        if filtered is None:
            continue
        if len(item) >= 8:
            key = (item[5], item[6])
            grouped.setdefault(key, []).append(filtered)
        else:
            fallback_lines.append([filtered])
    if grouped:
        raw_lines = list(grouped.values()) + fallback_lines
    else:
        raw_lines = fallback_lines
    lines: list[_Line] = []
    for pieces in raw_lines:
        pieces.sort(key=lambda piece: (piece.rect[1], piece.rect[0]))
        lines.append(_Line(tuple(pieces), _line_rect(pieces), len(lines)))
    lines.sort(key=lambda line: (line.rect[1], line.rect[0]))
    return [_Line(line.pieces, line.rect, index) for index, line in enumerate(lines)]


def _lines_from_dict(page: Any, scope: _Rect, issues: list[dict[str, Any]]) -> list[_Line]:
    payload = _call_get_text(page, "dict", scope)
    if not isinstance(payload, Mapping):
        return []
    lines: list[_Line] = []
    for block in payload.get("blocks", []):
        if not isinstance(block, Mapping) or block.get("type", 0) != 0:
            continue
        for raw_line in block.get("lines", []):
            if not isinstance(raw_line, Mapping):
                continue
            pieces: list[_Piece] = []
            for span in raw_line.get("spans", []):
                if not isinstance(span, Mapping):
                    continue
                piece = _text_piece(span.get("text"), span.get("bbox"))
                if piece is None:
                    continue
                piece = _filter_piece(piece, scope, issues)
                if piece is not None:
                    pieces.append(piece)
            if not pieces:
                continue
            pieces.sort(key=lambda piece: (piece.rect[0], piece.rect[1]))
            lines.append(_Line(tuple(pieces), _line_rect(pieces), len(lines)))
    lines.sort(key=lambda line: (line.rect[1], line.rect[0]))
    return [_Line(line.pieces, line.rect, index) for index, line in enumerate(lines)]


def _extract_lines(page: Any, scope: _Rect, issues: list[dict[str, Any]]) -> list[_Line]:
    if isinstance(page, ParsedPage):
        return _lines_from_parsed_page(page, scope, issues)
    # Span text preserves meaningful spaces within company/person names.
    # Word extraction intentionally drops those spaces and is only a fallback.
    lines = _lines_from_dict(page, scope, issues)
    if lines:
        return lines
    return _lines_from_words(page, scope, issues)


def _rect_dict(rect: tuple[float, float, float, float] | None) -> dict[str, float] | None:
    if rect is None:
        return None
    return {"x0": float(rect[0]), "y0": float(rect[1]), "x1": float(rect[2]), "y1": float(rect[3])}


def _label_text_norm(text: str) -> str:
    return "".join(unicodedata.normalize("NFKC", text).split())


def _label_text_with_map(text: str) -> tuple[str, tuple[int, ...]]:
    """Normalize label text while retaining indexes into the raw line.

    Labels are frequently emitted as separate words (``付款方 名称``).  A
    simple ``find`` on whitespace-stripped text would otherwise point to the
    wrong geometry as soon as a space occurs before the value.
    """

    normalized: list[str] = []
    indexes: list[int] = []
    for raw_index, character in enumerate(text):
        for normalized_character in unicodedata.normalize("NFKC", character):
            if normalized_character.isspace():
                continue
            normalized.append(normalized_character)
            indexes.append(raw_index)
    return "".join(normalized), tuple(indexes)


def _label_aliases(*, tax_context: bool = False) -> list[tuple[str, str, str, bool]]:
    aliases: list[tuple[str, str, str, bool]] = []
    for alias, side, field_name in _DIRECT_LABELS:
        aliases.append((alias, side, field_name, True))
    for side, side_aliases in _SIDE_ALIASES.items():
        for side_alias in side_aliases:
            # A bare side header is the party name field.  It is useful for
            # vertical blocks and as a column anchor for generic fields.
            aliases.append((side_alias, side, "name", True))
            for field_name, field_aliases in _FIELD_ALIASES.items():
                for field_alias in field_aliases:
                    aliases.append((side_alias + field_alias, side, field_name, True))
    if tax_context:
        aliases.extend(_TAX_LABELS)
    # Longest alias wins, then duplicate spans are removed.
    return sorted(set(aliases), key=lambda item: len(_label_text_norm(item[0])), reverse=True)


def _regex_matches(line: _Line, line_index: int, *, tax_context: bool = False) -> list[_Label]:
    raw_text = line.text
    text, raw_indexes = _label_text_with_map(raw_text)
    if not text:
        return []
    matches: list[_Label] = []
    for alias, side, field_name, explicit_side in _label_aliases(tax_context=tax_context):
        normalized_alias = _label_text_norm(alias)
        start = 0
        while True:
            found = text.find(normalized_alias, start)
            if found < 0:
                break
            end = found + len(normalized_alias)
            raw_start = raw_indexes[found]
            raw_end = raw_indexes[end - 1] + 1
            # An explicit label must have label geometry too.  Without this
            # boundary check, a value such as ``合成代付款服务公司`` creates a
            # second payer label from the embedded word ``付款``.
            if not _generic_span_is_label(line, raw_start, raw_end, alias):
                start = found + 1
                continue
            matches.append(_Label(
                side, field_name, raw_text[raw_start:raw_end], raw_start, raw_end,
                line.rect_for_span(raw_start, raw_end) or line.rect, line_index, explicit_side,
                _has_delimiter_after(raw_text, raw_end),
            ))
            start = found + 1
    # Remove contained labels (付款方名称 contains the shorter 付款方/name
    # candidates) and exact duplicates.  Text order remains deterministic.
    unique: list[_Label] = []
    for candidate in sorted(matches, key=lambda item: (item.start, -(item.end - item.start), item.side, item.field)):
        if any(
            candidate.start >= existing.start and candidate.end <= existing.end
            and candidate.side == existing.side and candidate.field == existing.field
            for existing in unique
        ):
            continue
        if any(candidate.start < existing.end and existing.start < candidate.end for existing in unique):
            # Prefer the longest label at an overlapping position.  The sort
            # above puts it first.
            continue
        unique.append(candidate)
    return sorted(unique, key=lambda item: (item.start, item.end))


def _generic_matches(line: _Line, line_index: int, explicit: Sequence[_Label]) -> list[_Label]:
    # Once a side-specific label exists on a line, a generic word such as
    # ``银行`` inside its value (``中国银行``) is data, not a second label.
    # Generic labels are reserved for header/value rows whose side must be
    # inferred from the column anchors.
    if explicit:
        return []
    text, raw_indexes = _label_text_with_map(line.text)
    if not text:
        return []
    anchors = [(item.start, item.end) for item in explicit]
    matches: list[_Label] = []
    for alias, field_name in sorted(_GENERIC_FIELD_ALIASES.items(), key=lambda item: len(item[0]), reverse=True):
        start = 0
        while True:
            found = text.find(alias, start)
            if found < 0:
                break
            end = found + len(alias)
            raw_start = raw_indexes[found]
            raw_end = raw_indexes[end - 1] + 1
            if not _generic_span_is_label(line, raw_start, raw_end, alias):
                start = found + 1
                continue
            if any(raw_start >= left and raw_end <= right for left, right in anchors):
                start = found + 1
                continue
            matches.append(_Label(
                "", field_name, line.text[raw_start:raw_end], raw_start, raw_end,
                line.rect_for_span(raw_start, raw_end) or line.rect, line_index, False,
                _has_delimiter_after(line.text, raw_end),
            ))
            start = found + 1
    unique: list[_Label] = []
    for candidate in sorted(matches, key=lambda item: (item.start, -(item.end - item.start))):
        if any(candidate.start < existing.end and existing.start < candidate.end for existing in unique):
            continue
        unique.append(candidate)
    return sorted(unique, key=lambda item: (item.start, item.end))


def _generic_span_is_label(line: _Line, start: int, end: int, alias: str) -> bool:
    """Reject field words embedded in a value such as ``建设银行``.

    A generic label is reliable when it occupies a whole text piece or starts
    a piece followed by a value separator.  A suffix occurrence inside a
    company/bank name has no label geometry and must remain value text.
    """

    text, piece_indexes = line.text_with_map()
    if start < 0 or end <= start or end > len(text) or not piece_indexes:
        return False
    # Both ends matter. A trailing colon alone does not turn the suffix
    # “名称” of “业务名称” into a party label, and “付款凭证” is a title,
    # not a bare “付款” header followed by a company called “凭证”.
    left_boundary = (start == 0 or text[start - 1].isspace() or text[start - 1] in _VALUE_SEPARATORS
                     or piece_indexes[start - 1] != piece_indexes[start])
    right_boundary = (end == len(text) or text[end].isspace() or text[end] in _VALUE_SEPARATORS
                      or piece_indexes[end - 1] != piece_indexes[end])
    return left_boundary and right_boundary


def _has_delimiter_after(text: str, end: int) -> bool:
    # Text may have full-width spaces removed during label matching.  Looking
    # only until the next non-space character avoids treating a normal header
    # as an explicitly empty value.
    tail = text[end:]
    return bool(tail and (tail[0].isspace() or tail[0] in _VALUE_SEPARATORS))


def _strip_value_separators(value: str) -> str:
    return value.strip().strip(_VALUE_SEPARATORS).strip()


def _column_centers(labels: Sequence[_Label]) -> dict[str, float]:
    centers: dict[str, list[float]] = {side: [] for side in SIDES}
    for label in labels:
        if label.side in centers:
            centers[label.side].append((label.rect[0] + label.rect[2]) / 2)
    return {side: sum(values) / len(values) for side, values in centers.items() if values}


def _nearest_side(x: float, centers: Mapping[str, float]) -> str | None:
    if not centers:
        return None
    return min(centers, key=lambda side: abs(x - centers[side]))


def _vertical_headers(
    lines: Sequence[_Line], generic_labels: Sequence[_Label],
) -> tuple[_VerticalHeader, ...]:
    """Recognize a paired table header written one character per PDF line.

    These are column anchors only, never party-name values.  Requiring both
    complete, aligned headers and nearby name/account cells prevents isolated
    characters in narrative text or a clipped header from defining a party.
    """

    candidates: list[_VerticalHeader] = []
    for index, line in enumerate(lines):
        if line.text not in {"付", "收"} or len(line.pieces) != 1:
            continue
        width, height = line.rect[2] - line.rect[0], line.rect[3] - line.rect[1]
        if not 0.5 <= width / height <= 1.8:
            continue
        chain = [index]
        for characters in ({"款"}, {"人", "方"}):
            previous = lines[chain[-1]].rect
            possible = [
                other_index for other_index, other in enumerate(lines)
                if other.text in characters and len(other.pieces) == 1
                and abs(other.rect[0] - line.rect[0]) <= max(1.0, width * 0.15)
                and abs((other.rect[2] - other.rect[0]) - width) <= width * 0.25
                and abs((other.rect[3] - other.rect[1]) - height) <= height * 0.25
                and -0.25 <= other.rect[1] - previous[3] <= height * 1.6
            ]
            if len(possible) != 1:
                break
            chain.append(possible[0])
        if len(chain) != 3:
            continue
        rect = _union_rects(lines[item].rect for item in chain)
        assert rect is not None
        fields = {
            label.field for label in generic_labels
            if rect[2] <= label.rect[0] <= rect[2] + height * 5
            and rect[1] - height * 3 <= label.rect[1] <= rect[3] + height * 3
        }
        if {"name", "account"} <= fields:
            candidates.append(_VerticalHeader("payer" if line.text == "付" else "payee", rect, tuple(chain), height))
    # Some tables print the very same row-spanning role horizontally. Only
    # use it as a table header when both name/account cells are nearby;
    # ordinary “付款方：公司” labels keep their existing meaning.
    for index, line in enumerate(lines):
        text = _label_text_norm(line.text)
        if text not in {"付款人", "付款方", "收款人", "收款方"}:
            continue
        height = line.rect[3] - line.rect[1]
        fields = {label.field for label in generic_labels
                  if line.rect[2] <= label.rect[0] <= line.rect[2] + height * 5
                  and abs(label.rect[1] - line.rect[1]) <= height * 3}
        if {"name", "account"} <= fields:
            candidates.append(_VerticalHeader("payer" if text.startswith("付") else "payee",
                                               line.rect, (index,), height))
    if len(candidates) != 2 or {item.side for item in candidates} != set(SIDES):
        return ()
    first, second = candidates
    height = min(lines[item.line_indexes[0]].rect[3] - lines[item.line_indexes[0]].rect[1] for item in candidates)
    if (abs(first.rect[0] - second.rect[0]) <= height * 4
            or abs(first.rect[1] - second.rect[1]) > height * 0.5):
        return ()
    return tuple(candidates)


def _vertical_field_header(label: _Label, headers: Sequence[_VerticalHeader]) -> _VerticalHeader | None:
    for header in headers:
        height = header.unit_height or (header.rect[3] - header.rect[1]) / 3
        if (header.rect[2] <= label.rect[0] <= header.rect[2] + height * 5
                and header.rect[1] - height * 3 <= label.rect[1] <= header.rect[3] + height * 3):
            return header
    return None


def _ningbo_layout(
    lines: Sequence[_Line], scope: _Rect, generic_labels: Sequence[_Label],
) -> tuple[str, float, float] | None:
    """Return the side of Ningbo's upper account table when safely anchored.

    This form has no payer/payee prefix on the upper ``账号／户名／开户银行``
    table.  The exact customer-receipt heading and one exact transfer
    direction are required in the same clipped receipt scope.  Two titles or
    two directions mean that the caller supplied adjacent receipts, so the
    special mapping is deliberately disabled rather than choosing one.
    """

    title_indexes = [
        index for index, line in enumerate(lines)
        if _label_text_norm(line.text).strip(_VALUE_SEPARATORS) in _NINGBO_RECEIPT_TITLES
    ]
    direction_indexes = [
        index for index, line in enumerate(lines)
        if _label_text_norm(line.text).strip(_VALUE_SEPARATORS) in _NINGBO_DIRECTIONS
    ]
    if len(title_indexes) != 1 or len(direction_indexes) != 1:
        return None
    title = lines[title_indexes[0]]
    direction = lines[direction_indexes[0]]
    top_limit = scope.y0 + max(40.0, (scope.y1 - scope.y0) * 0.2)
    if title.rect[1] > top_limit or direction.rect[1] <= title.rect[3]:
        return None
    if direction.rect[1] - title.rect[1] > 160.0:
        return None
    fields = {
        label.field for label in generic_labels
        if title.rect[3] < label.rect[1] < direction.rect[1]
        and label.field in _NINGBO_GENERIC_FIELDS
    }
    if fields != _NINGBO_GENERIC_FIELDS:
        return None
    return _NINGBO_DIRECTIONS[_label_text_norm(direction.text).strip(_VALUE_SEPARATORS)], title.rect[3], direction.rect[1]


def _is_tax_voucher_context(lines: Sequence[_Line], scope: _Rect) -> bool:
    """Recognize an isolated electronic tax-voucher heading in this scope.

    A body sentence can quote the voucher title, so the title must be a whole
    line near the top of the current receipt.  This small gate keeps the
    tax-specific label map out of ordinary bank receipts.
    """

    top_limit = scope.y0 + max(40.0, (scope.y1 - scope.y0) * 0.2)
    for line in lines:
        if line.rect[1] > top_limit:
            continue
        compact = _label_text_norm(line.text).strip(_VALUE_SEPARATORS)
        if compact in _TAX_VOUCHER_TITLES:
            return True
    return False


def _huaxia_layout_labels(lines: Sequence[_Line], scope: _Rect) -> dict[int, list[_Label]] | None:
    """Map two explicitly labelled Huaxia forms, without column guessing.

    Online transfers print own ``名称／账号`` and ``交易对方…``. The debit /
    credit marker supplies their sides. Small-payment credit transfers print
    ``发起人／接收人`` instead; that mapping is only valid for ``普通贷记``.
    Unknown directions, duplicate headings, and other transaction types keep
    the general conservative parser. A bank routing number is never a bank
    name or an account value.
    """

    titles = [line for line in lines if _label_text_norm(line.text).startswith("客户回单")]
    if len(titles) != 1:
        return None
    title = titles[0]
    if title.rect[1] > scope.y0 + max(40.0, (scope.y1 - scope.y0) * 0.2):
        return None

    def metadata(label: str) -> list[str]:
        values = []
        for line in lines:
            match = re.fullmatch(re.escape(label) + r":(.*)", _label_text_norm(line.text))
            if match is not None:
                values.append(match.group(1))
        return values

    title_text = _label_text_norm(title.text)
    if title_text == _HUAXIA_ONLINE_TITLE:
        direction = metadata("借贷标志")
        if len(direction) != 1 or direction[0] not in {"借", "贷"}:
            return None
        own = "payer" if direction[0] == "借" else "payee"
        other = "payee" if own == "payer" else "payer"
        aliases = {"名称": (own, "name"), "账号": (own, "account"),
                   "交易对方名称": (other, "name"), "交易对方账号": (other, "account"),
                   "交易对方银行名称": (other, "bank")}
        required = {"名称", "账号", "交易对方名称"}
    elif title_text == _HUAXIA_SMALL_TITLE:
        if metadata("交易种类") != ["普通贷记"]:
            return None
        aliases = {"发起人名称": ("payer", "name"), "发起人账号": ("payer", "account"),
                   "发起行名称": ("payer", "bank"), "接收人名称": ("payee", "name"),
                   "接收人账号": ("payee", "account"), "接收行名称": ("payee", "bank")}
        required = {"发起人名称", "发起人账号", "接收人名称", "接收人账号"}
    else:
        return None

    mapped: dict[int, list[_Label]] = {}
    observed = set()
    # A PDF text line can contain several cells. Include non-party labels as
    # value boundaries too; routing numbers must never fill an empty name or
    # account that precedes them on the same line.
    boundaries = {"交易对方银行行号", "交易机构", "币种", "发生额", "交易流水号",
                  "来源或用途", "摘要", "借贷标志", "交易种类", "业务类型",
                  "发起人开户行行号", "发起行行号", "接收人开户行行号", "接收行行号"}
    pattern = re.compile("(?:" + "|".join(re.escape(label) for label in
                         sorted(set(aliases) | boundaries, key=len, reverse=True)) + r")(?=:)")
    for index, line in enumerate(lines):
        if line.rect[1] <= title.rect[3]:
            continue
        normalized, indexes = _label_text_with_map(line.text)
        matches = list(pattern.finditer(normalized))
        for position, match in enumerate(matches):
            alias = match.group()
            if alias not in aliases:
                continue
            side, field_name = aliases[alias]
            start, end = indexes[match.start()], indexes[match.end() - 1] + 1
            stop = indexes[matches[position + 1].start()] if position + 1 < len(matches) else None
            observed.add(alias)
            mapped.setdefault(index, []).append(_Label(
                side, field_name, line.text[start:end], start, end,
                line.rect_for_span(start, end) or line.rect, index, True, True, stop,
            ))
    return mapped if required <= observed else None


def _table_value_lines(
    lines: Sequence[_Line], label: _Label, headers: Sequence[_VerticalHeader],
    row_labels: Sequence[_Label] = (),
) -> list[tuple[int, _Line]]:
    header = next(item for item in headers if item.side == label.side)
    right_edge = min((item.rect[0] for item in headers if item.rect[0] > header.rect[0]), default=math.inf)
    height = max(1.0, label.rect[3] - label.rect[1])
    ignored = {index for item in headers for index in item.line_indexes}
    center_y = (label.rect[1] + label.rect[3]) / 2
    neighbour_ys = []
    for other in row_labels:
        if other.line_index == label.line_index or other.line_index in ignored:
            continue
        if abs(other.rect[0] - label.rect[0]) <= height * 2:
            neighbour_ys.append((other.rect[1] + other.rect[3]) / 2)
    upper = max(((y + center_y) / 2 for y in neighbour_ys if y < center_y - height * .5), default=-math.inf)
    lower = min(((y + center_y) / 2 for y in neighbour_ys if y > center_y + height * .5), default=math.inf)
    values = []
    for index, line in enumerate(lines):
        if index in ignored or index == label.line_index:
            continue
        if not (label.rect[2] <= line.rect[0]
                and line.rect[2] <= right_edge
                and upper < (line.rect[1] + line.rect[3]) / 2 < lower
                and _same_text_row(label.rect, line.rect, table=True)):
            continue
        values.append((index, line))
    return values


def _same_text_row(left: tuple, right: tuple, *, table: bool = False) -> bool:
    """Allow smaller value fonts and baseline offsets within one cell row."""
    lh, rh = left[3] - left[1], right[3] - right[1]
    overlap = min(left[3], right[3]) - max(left[1], right[1])
    return (0.35 * lh <= rh <= 1.5 * lh
            and overlap >= min(lh, rh) * (0.15 if table else 0.45)
            and abs((left[1] + left[3]) - (right[1] + right[3])) <= lh * (1.8 if table else 1.2))


def _local_field_side(label: _Label, anchors: Sequence[_Label], centers: Mapping[str, float]) -> str | None:
    """Use preceding role in stacked blocks; column geometry otherwise."""
    height = max(1.0, label.rect[3] - label.rect[1])
    if len(centers) == 2 and abs(centers["payer"] - centers["payee"]) <= height * 4:
        previous = [item for item in anchors if item.rect[1] <= label.rect[1] + height * .25
                    and abs(item.rect[0] - label.rect[0]) <= height * 4]
        if previous:
            nearest_y = max(item.rect[1] for item in previous)
            sides = {item.side for item in previous if nearest_y - item.rect[1] <= height * .25}
            return next(iter(sides)) if len(sides) == 1 else None
        return None
    return _nearest_side((label.rect[0] + label.rect[2]) / 2, centers)


def _same_row_field_values(
    lines: Sequence[_Line], labels_by_line: Mapping[int, Sequence[_Label]], label: _Label,
) -> list[tuple[str, tuple[float, float, float, float]]]:
    """Read detached explicit-label values without relying on PDF line order.

    The next label on this visual row closes the cell. This matters for wide
    left-hand values whose centre happens to be nearer the right-hand role.
    Keep every overlapping value candidate so genuine conflicts survive.
    """
    height = max(1.0, label.rect[3] - label.rect[1])
    right_edge = min((other.rect[0] for row in labels_by_line.values() for other in row
                      if other.line_index != label.line_index and other.rect[0] >= label.rect[2]
                      and _same_text_row(label.rect, other.rect)), default=math.inf)
    # A label can be vertically centred beside a wrapped value. Constrain
    # this relaxed row match by the neighbouring labels in the same column.
    center_y = (label.rect[1] + label.rect[3]) / 2
    neighbour_ys = [(other.rect[1] + other.rect[3]) / 2
                    for row in labels_by_line.values() for other in row
                    if other.line_index != label.line_index and other.side == label.side
                    and abs(other.rect[0] - label.rect[0]) <= height]
    upper = max(((y + center_y) / 2 for y in neighbour_ys if y < center_y - height * .5), default=-math.inf)
    lower = min(((y + center_y) / 2 for y in neighbour_ys if y > center_y + height * .5), default=math.inf)
    values = [(line.text.strip(), line.rect) for index, line in enumerate(lines)
            if index != label.line_index and not labels_by_line.get(index)
            and label.rect[2] <= line.rect[0] <= label.rect[2] + height * 12
            and line.rect[2] <= right_edge
            and upper < (line.rect[1] + line.rect[3]) / 2 < lower
            and _same_text_row(label.rect, line.rect, table=label.field != "account")]
    return _join_wrapped_values(label, values)


def _same_row_table_values(
    lines: Sequence[_Line], labels_by_line: Mapping[int, Sequence[_Label]],
    label: _Label, headers: Sequence[_VerticalHeader],
) -> list[tuple[str, tuple[float, float, float, float]]]:
    """Read the value cell geometrically, independent of PDF reading order."""

    # Preserve conflicting overlapping values for _resolve_candidates rather
    # than selecting whichever happens to occur first in the PDF text layer.
    row_labels = [item for labels in labels_by_line.values() for item in labels]
    values = [(line.text.strip(), line.rect) for index, line in _table_value_lines(lines, label, headers, row_labels)
              if not labels_by_line.get(index)]
    return _join_wrapped_values(label, values)


def _join_wrapped_values(
    label: _Label, values: list[tuple[str, tuple[float, float, float, float]]],
) -> list[tuple[str, tuple[float, float, float, float]]]:
    # Wrapped names use aligned successive text lines inside the same cell.
    # Overlapping alternatives at the same baseline remain separate conflicts.
    ordered = sorted(values, key=lambda item: (item[1][1], item[1][0]))
    if (label.field != "account" and len(ordered) > 1
            and not any(re.search(r"[A-Za-z]", text) for text, _rect in ordered)):
        for previous, following in zip(ordered, ordered[1:]):
            a, b = previous[1], following[1]
            height = min(a[3] - a[1], b[3] - b[1])
            aligned = (abs(a[0] - b[0]) <= height * .3
                       or abs((a[0] + a[2]) - (b[0] + b[2])) <= height * .6)
            if not (aligned
                    and height * .7 <= b[1] - a[1] <= height * 1.5):
                break
        else:
            rect = _union_rects(item[1] for item in ordered)
            assert rect is not None
            return [("".join(item[0] for item in ordered), rect)]
    return values


def _value_rect_for_text(line: _Line, start: int, end: int) -> tuple[float, float, float, float] | None:
    return line.rect_for_span(start, end)


def _empty_table_value_cell(
    page: Any, scope: _Rect, label: _Label, lines: Sequence[_Line],
) -> tuple[float, float, float, float] | None:
    """Prove an empty printed cell, never infer blank from missing text alone.

    This fallback is used only after an established party table has no text
    value. Four visible vector borders identify the value cell; a bounded
    raster check rejects images, outlined glyphs, unreadable text and stamps.
    Text-only/OCR adapters have no such proof and continue to return missing.
    """
    if not hasattr(page, "get_drawings") or not hasattr(page, "get_pixmap"):
        return None
    try:
        import pymupdf

        horizontal, vertical = [], []
        drawings = page.get_drawings()
        if len(drawings) > 20000:
            return None
        for path in drawings:
            # White fills and unpainted paths do not establish a visible cell.
            stroke = path.get("color") if "s" in path.get("type", "") else None
            fill = path.get("fill") if "f" in path.get("type", "") else None
            visible_stroke = (stroke is not None
                              and (path.get("stroke_opacity", 1) or 0) * (1 - min(stroke)) > .2)
            visible_fill = (fill is not None
                            and (path.get("fill_opacity", 1) or 0) * (1 - min(fill)) > .2)
            if not visible_stroke and not visible_fill:
                continue
            for item in path.get("items", ()):
                segments = []
                if item[0] == "l" and visible_stroke:
                    segments.append((*item[1], *item[2]))
                elif item[0] == "re":
                    x0, y0, x1, y1 = item[1]
                    if visible_fill and y1 - y0 <= 1.5:
                        segments.append((x0, (y0 + y1) / 2, x1, (y0 + y1) / 2))
                    elif visible_fill and x1 - x0 <= 1.5:
                        segments.append(((x0 + x1) / 2, y0, (x0 + x1) / 2, y1))
                    elif visible_stroke:
                        segments.extend(((x0, y0, x1, y0), (x0, y1, x1, y1),
                                         (x0, y0, x0, y1), (x1, y0, x1, y1)))
                for x0, y0, x1, y1 in segments:
                    if abs(y0 - y1) <= .2:
                        horizontal.append((min(x0, x1), (y0 + y1) / 2, max(x0, x1)))
                    elif abs(x0 - x1) <= .2:
                        vertical.append(((x0 + x1) / 2, min(y0, y1), max(y0, y1)))
        height = max(1., label.rect[3] - label.rect[1])
        cy = (label.rect[1] + label.rect[3]) / 2
        columns = sorted({x for x, y0, y1 in vertical if x >= label.rect[2] - .2 and y0 <= cy <= y1})
        if len(columns) < 2 or columns[0] - label.rect[2] > height * 6:
            return None
        left = columns[0]
        right = next((x for x in columns if x - left > 2), left)
        tops = [y for x0, y, x1 in horizontal if x0 <= left + 1 and x1 >= right - 1 and y <= label.rect[1] + .2]
        bottoms = [y for x0, y, x1 in horizontal if x0 <= left + 1 and x1 >= right - 1 and y >= label.rect[3] - .2]
        if not tops or not bottoms:
            return None
        top, bottom = max(tops), min(bottoms)
        cell = (left, top, right, bottom)
        if (not _inside(cell, scope) or right - left < height * 2
                or not height * .8 <= bottom - top <= height * 5
                or not all(any(abs(x - edge) <= 1 and y0 <= top + 1 and y1 >= bottom - 1
                               for x, y0, y1 in vertical) for edge in (left, right))):
            return None
        if any(_intersection_area(piece.rect, _coerce_rect(cell)) > 0
               for line in lines for piece in line.pieces):
            return None
        # Inset only the border stroke; retain practically the entire value
        # area so a short glyph at any cell position still prevents blank.
        interior = (left + 1.5, top + 1.5, right - 1.5, bottom - 1.5)
        if _rect_area(interior) <= 0 or _rect_area(interior) > 100000:
            return None
        # A later white paint/mask can hide otherwise valid vector paths.
        # Verify each border is actually visible, not merely in the display
        # list; most of its length must survive in the rendered receipt.
        border = page.get_pixmap(clip=pymupdf.Rect(left - 1, top - 1, right + 1, bottom + 1),
                                 colorspace=pymupdf.csGRAY, matrix=pymupdf.Matrix(1, 1), alpha=False)
        pixels = border.samples
        def visible_line(start, end, fixed, *, horizontal):
            start, end = math.ceil(start + 2), math.floor(end - 2)
            if end <= start:
                return False
            dark = 0
            for position in range(start, end):
                for crossing in range(math.floor(fixed) - 1, math.ceil(fixed) + 2):
                    x, y = (position, crossing) if horizontal else (crossing, position)
                    x, y = x - border.x, y - border.y
                    if 0 <= x < border.width and 0 <= y < border.height and pixels[y * border.stride + x] < 220:
                        dark += 1
                        break
            return dark >= (end - start) * .8
        if not (all(visible_line(left, right, y, horizontal=True) for y in (top, bottom))
                and all(visible_line(top, bottom, x, horizontal=False) for x in (left, right))):
            return None
        pixmap = page.get_pixmap(clip=pymupdf.Rect(interior), matrix=pymupdf.Matrix(1, 1), alpha=False)
        if pixmap.width == 0 or pixmap.height == 0 or not pixmap.samples or min(pixmap.samples) < 254:
            return None
        return interior
    except (AttributeError, KeyError, TypeError, ValueError, RuntimeError):
        return None


def _make_candidate(
    label: _Label,
    value_text: str,
    value_rect: tuple[float, float, float, float] | None,
    *,
    source: str,
    force_blank: bool = False,
) -> _Candidate:
    raw = value_text.strip()
    normalized = _field_normalized(label.field, raw)
    if force_blank or normalized in _BLANK_MARKERS:
        state = "blank"
        if normalized in _BLANK_MARKERS and normalized:
            normalized = ""
    elif label.field == "account":
        state, normalized = _account_state(raw)
    elif label.field == "name" and normalized and not any(char.isalnum() for char in normalized):
        state = "ambiguous"
    else:
        state = "present" if normalized else "missing"
    label_record = {"text": label.text, "rect": _rect_dict(label.rect)}
    value_record = None
    if value_rect is not None:
        value_record = {"text": raw, "rect": _rect_dict(value_rect)}
    evidence_rect = _union_rects([rect for rect in (label.rect, value_rect) if rect is not None])
    evidence = {"label": label_record, "value": value_record, "rect": _rect_dict(evidence_rect)}
    return _Candidate(label.side, label.field, raw, normalized, state, evidence, label.line_index, source)


def _line_value_after(line: _Line, label: _Label, stop: int | None) -> tuple[str, tuple[float, float, float, float] | None]:
    text = line.text
    end = len(text) if stop is None else stop
    if label.value_stop is not None:
        end = min(end, label.value_stop)
    raw = text[label.end:end]
    cleaned = _strip_value_separators(raw)
    if not cleaned:
        return "", None
    leading = len(raw) - len(raw.lstrip(_VALUE_SEPARATORS))
    start = label.end + leading
    value_rect = _value_rect_for_text(line, start, end)
    return cleaned, value_rect


def _next_unlabelled_value(
    lines: Sequence[_Line],
    labels_by_line: Mapping[int, Sequence[_Label]],
    label: _Label,
    *,
    centers: Mapping[str, float],
    allow_cross_column: bool = False,
) -> tuple[str, tuple[float, float, float, float] | None, int] | None:
    current = lines[label.line_index]
    current_height = max(1.0, current.rect[3] - current.rect[1])
    anchor_x = (label.rect[0] + label.rect[2]) / 2
    for index in range(label.line_index + 1, min(len(lines), label.line_index + 3)):
        candidate_line = lines[index]
        gap = candidate_line.rect[1] - current.rect[3]
        if gap > max(18.0, current_height * 2.5):
            break
        line_labels = labels_by_line.get(index)
        if line_labels:
            # In a horizontal table, the next line may contain the other
            # column's label before this column's value row.  Skip that line
            # when its geometry clearly belongs to the other side; stop on a
            # same-side or mixed line to avoid crossing into another field.
            line_sides = {
                item.side or _nearest_side((item.rect[0] + item.rect[2]) / 2, centers)
                for item in line_labels
            }
            line_sides.discard(None)
            if label.side in centers and line_sides and label.side not in line_sides:
                continue
            break
        if not candidate_line.pieces:
            continue
        # In a two-column row choose the piece in the same column.  A single
        # piece is safe to use for vertical label/value layouts.
        piece = min(candidate_line.pieces, key=lambda part: abs((part.rect[0] + part.rect[2]) / 2 - anchor_x))
        if len(candidate_line.pieces) > 1 and label.side in centers:
            side_center = centers[label.side]
            nearest = min(candidate_line.pieces, key=lambda part: abs((part.rect[0] + part.rect[2]) / 2 - side_center))
            if nearest is not piece:
                piece = nearest
        elif not allow_cross_column and len(centers) > 1 and label.side in centers:
            # A single value line can still belong to the other column.  Do
            # not let the first vertically adjacent word from the neighbour
            # column become this side's value.
            piece_side = _nearest_side((piece.rect[0] + piece.rect[2]) / 2, centers)
            if piece_side is not None and piece_side != label.side:
                continue
        return piece.text.strip(), piece.rect, index
    return None


def _resolve_candidates(
    side: str,
    field_name: str,
    candidates: Sequence[_Candidate],
    issues: list[dict[str, Any]],
) -> dict[str, Any]:
    if not candidates:
        return {
            "raw": "", "value": "", "normalized": "", "state": "missing",
            "evidence": {"label": None, "value": None, "rect": None},
        }
    # Remove exact duplicates created by overlapping generic/side labels.
    unique: list[_Candidate] = []
    for candidate in candidates:
        if any(
            candidate.raw == existing.raw and candidate.normalized == existing.normalized
            and candidate.state == existing.state
            for existing in unique
        ):
            continue
        unique.append(candidate)
    if len(unique) == 1:
        candidate = unique[0]
        result = {
            "raw": candidate.raw,
            "value": candidate.normalized,
            "normalized": candidate.normalized,
            "state": candidate.state,
            "evidence": candidate.evidence,
        }
        if candidate.state == "ambiguous":
            issues.append({
                "code": "field_ambiguous",
                "message": "字段内容不完整或无法安全用于归组",
                "side": side, "field": field_name, "rect": candidate.evidence.get("rect"),
            })
        return result
    # A blank plus a present value, or two different values, is a conflict.
    first = unique[0]
    values = [candidate.raw for candidate in unique]
    result = {
        "raw": " | ".join(values),
        "value": " | ".join(candidate.normalized for candidate in unique),
        "normalized": " | ".join(candidate.normalized for candidate in unique),
        "state": "ambiguous",
        "evidence": first.evidence,
        "candidates": [
            {
                "raw": candidate.raw,
                "value": candidate.normalized,
                "normalized": candidate.normalized,
                "state": candidate.state,
                "evidence": candidate.evidence,
            }
            for candidate in unique
        ],
    }
    issues.append({
        "code": "conflicting_field_values",
        "message": "同一方同一字段出现互相冲突的值，需人工核对",
        "side": side, "field": field_name,
        "rect": first.evidence.get("rect"),
        "values": values,
    })
    return result


def _default_rect(page: Any) -> tuple[float, float, float, float]:
    scope = _page_scope(page)
    return (scope.x0, scope.y0, scope.x1, scope.y1)


def _extract_legacy_receipt_parties(page: Any, rect: Any = None) -> dict[str, Any]:
    """Extract labelled payer/payee fields from one visible receipt rectangle.

    ``page`` may be a loaded PyMuPDF page or a ``ParsedPage``.  For a loaded
    page, text is requested with ``clip=rect``; for ``ParsedPage`` each text
    block is filtered against the same rectangle.  Invalid rectangles raise
    ``ValueError`` before any page operation.  The page is never mutated.
    """

    scope = _coerce_rect(_default_rect(page) if rect is None else rect)
    issues: list[dict[str, Any]] = []
    lines = _extract_lines(page, scope, issues)
    if not lines:
        return {
            "payer": {field_name: _resolve_candidates("payer", field_name, (), issues) for field_name in FIELD_NAMES},
            "payee": {field_name: _resolve_candidates("payee", field_name, (), issues) for field_name in FIELD_NAMES},
            "diagnostics": {
                "status": "needs_review", "issues": [{
                    "code": "no_text_in_scope", "message": "当前回单范围没有可用文字层",
                    "rect": scope.as_dict(),
                }, *issues],
                "scope": scope.as_dict(), "line_count": 0,
            },
        }

    tax_context = _is_tax_voucher_context(lines, scope)
    huaxia_labels = _huaxia_layout_labels(lines, scope)
    tax_title_lines = {
        line_index for line_index, line in enumerate(lines)
        if tax_context and _label_text_norm(line.text).strip(_VALUE_SEPARATORS) in _TAX_VOUCHER_TITLES
    }
    explicit_by_line: dict[int, list[_Label]] = {}
    generic_by_line: dict[int, list[_Label]] = {}
    all_labels: list[_Label] = []
    for line_index, line in enumerate(lines):
        # The title contains the word “付款”, but it is document metadata,
        # not the payer name.  Tax vouchers also use their own explicit labels
        # for the collection authority and treasury bank; disabling generic
        # name matching in this context prevents those two fields from being
        # merged into one ambiguous payee name.
        explicit = [] if line_index in tax_title_lines else _regex_matches(
            line, line_index, tax_context=tax_context,
        )
        if huaxia_labels is not None and line_index in huaxia_labels:
            explicit = huaxia_labels[line_index]
        generic = [] if tax_context or huaxia_labels is not None else _generic_matches(line, line_index, explicit)
        explicit_by_line[line_index] = explicit
        generic_by_line[line_index] = generic
        all_labels.extend(explicit)
        all_labels.extend(generic)

    vertical_headers = _vertical_headers(lines, [label for label in all_labels if not label.explicit_side])
    header_line_indexes = {index for header in vertical_headers for index in header.line_indexes}
    for index in header_line_indexes:
        explicit_by_line[index] = []
        generic_by_line[index] = []
    # Inside an established table a value can itself contain words such as
    # "代付款".  Its cell geometry takes precedence over substring labels;
    # otherwise a payee name would invent a second payer-name field.  This
    # does not alter label parsing for ordinary single-line party layouts.
    value_line_indexes: set[int] = set()
    for label in all_labels:
        if label.explicit_side:
            continue
        header = _vertical_field_header(label, vertical_headers)
        if header is None or _label_text_norm(lines[label.line_index].text).strip(_VALUE_SEPARATORS) != _label_text_norm(label.text):
            continue
        assigned = _Label(header.side, label.field, label.text, label.start, label.end,
                          label.rect, label.line_index, False, label.delimiter)
        value_line_indexes.update(index for index, _line in _table_value_lines(lines, assigned, vertical_headers, all_labels))
    for index in value_line_indexes:
        explicit_by_line[index] = []
        generic_by_line[index] = []
    ningbo = _ningbo_layout(
        lines, scope,
        [label for labels in generic_by_line.values() for label in labels],
    )
    if ningbo is not None:
        upper_side, title_bottom, direction_top = ningbo
        for line_index, labels in list(generic_by_line.items()):
            mapped: list[_Label] = []
            for label in labels:
                if title_bottom < label.rect[1] < direction_top:
                    mapped.append(_Label(
                        upper_side, label.field, label.text, label.start, label.end,
                        label.rect, label.line_index, label.explicit_side, label.delimiter,
                    ))
                elif label.side:
                    mapped.append(label)
                # Generic labels outside the upper account table have no
                # reliable side in this layout.  In particular, a bare
                # ``名称`` in the lower transaction block can sit beside a
                # complete ``收款人名称`` label and create a false conflict.
                # Keep the explicit directional label and leave an actually
                # unlabeled value for manual review instead of choosing a
                # column from proximity alone.
            generic_by_line[line_index] = mapped
    anchor_labels = [label for index, labels in explicit_by_line.items()
                     if index not in value_line_indexes for label in labels]
    if ningbo is not None:
        anchor_labels.extend(
            label for index, labels in generic_by_line.items()
            if index not in value_line_indexes for label in labels if label.side
        )
    centers = _column_centers(anchor_labels)
    labels_by_line = {
        index: (*explicit_by_line.get(index, ()), *generic_by_line.get(index, ()))
        for index in range(len(lines))
    }
    candidates: dict[tuple[str, str], list[_Candidate]] = {(side, field_name): [] for side in SIDES for field_name in FIELD_NAMES}
    pending: list[_Label] = []

    for line_index, line in enumerate(lines):
        labels = sorted((*explicit_by_line.get(line_index, ()), *generic_by_line.get(line_index, ())), key=lambda item: (item.start, item.end))
        # Assign generic labels to a side using the nearest explicit column
        # anchor.  If there is no anchor, leave them unassigned and report a
        # visible ambiguity rather than guessing payer/payee.
        assigned: list[_Label] = []
        for label in labels:
            if label.side:
                assigned.append(label)
                continue
            vertical_header = _vertical_field_header(label, vertical_headers)
            side = vertical_header.side if vertical_header is not None else _local_field_side(label, anchor_labels, centers)
            if side is None:
                issues.append({
                    "code": "generic_label_side_unknown",
                    "message": "字段标签没有付款方／收款方的列依据",
                    "field": label.field, "rect": _rect_dict(label.rect),
                })
                continue
            assigned.append(_Label(
                side, label.field, label.text, label.start, label.end, label.rect,
                label.line_index, False, label.delimiter,
            ))

        for position, label in enumerate(assigned):
            next_start = assigned[position + 1].start if position + 1 < len(assigned) else None
            value, value_rect = _line_value_after(line, label, next_start)
            if value:
                candidates[(label.side, label.field)].append(_make_candidate(label, value, value_rect, source="same_line"))
                continue
            if huaxia_labels is not None and line_index in huaxia_labels:
                # These forms have inline values. A blank label must not
                # borrow a neighbouring bank, routing code, or other row.
                pending.append(label)
                continue
            if not label.explicit_side and _vertical_field_header(label, vertical_headers) is not None:
                row_values = _same_row_table_values(lines, labels_by_line, label, vertical_headers)
                for text, rect in row_values:
                    candidates[(label.side, label.field)].append(_make_candidate(label, text, rect, source="same_row"))
                if not row_values:
                    empty_cell = _empty_table_value_cell(page, scope, label, lines)
                    if empty_cell is not None:
                        candidates[(label.side, label.field)].append(_make_candidate(
                            label, "", empty_cell, source="empty_cell", force_blank=True,
                        ))
                    else:
                        pending.append(label)
                continue
            row_values = _same_row_field_values(lines, labels_by_line, label)
            if row_values:
                for text, rect in row_values:
                    candidates[(label.side, label.field)].append(_make_candidate(label, text, rect, source="same_row"))
                continue
            next_value = _next_unlabelled_value(
                lines, labels_by_line, label, centers=centers,
                allow_cross_column=bool(
                    ningbo is not None
                    and label.side == ningbo[0]
                    and ningbo[1] < label.rect[1] < ningbo[2]
                ),
            )
            if next_value is not None:
                next_text, next_rect, next_line = next_value
                candidates[(label.side, label.field)].append(_make_candidate(
                    label, next_text, next_rect, source="next_line",
                ))
                continue
            # Keep a label-only record as missing.  It is deliberately not
            # called blank because no value cell was observed.
            pending.append(label)

    # A label-only two-column row can be followed by a value-only row.  Resolve
    # those only when the value line has no labels and a side column is known.
    for label in pending:
        # Missing labels with no side column are already represented by their
        # missing result.  We don't infer from arbitrary nearby text here.
        continue

    result: dict[str, Any] = {}
    for side in SIDES:
        result[side] = {
            field_name: _resolve_candidates(side, field_name, candidates[(side, field_name)], issues)
            for field_name in FIELD_NAMES
        }
    # A field-level ambiguous/masked result already adds an issue.  Missing
    # values with a visible label get a useful diagnostic for the review UI.
    for side in SIDES:
        for field_name in FIELD_NAMES:
            value = result[side][field_name]
            if value["state"] == "missing":
                matching = [label for label in pending if label.side == side and label.field == field_name]
                if matching:
                    issues.append({
                        "code": "label_without_value",
                        "message": "已找到字段标签，但当前范围没有可确认的值；不能按空字段处理",
                        "side": side, "field": field_name,
                        "rect": _rect_dict(matching[0].rect),
                    })
    diagnostics = {
        "status": "ok" if not issues else "needs_review",
        "issues": issues,
        "scope": scope.as_dict(),
        "line_count": len(lines),
        "text_piece_count": sum(len(line.pieces) for line in lines),
    }
    result["diagnostics"] = diagnostics
    return result


def extract_receipt_parties(page: Any, rect: Any = None) -> dict[str, Any]:
    """Preserve validated payer/payee reads and add role-neutral evidence."""
    from .receipt_field_readers import enrich_legacy_extraction
    scope = _default_rect(page) if rect is None else rect
    legacy = _extract_legacy_receipt_parties(page, scope)
    return enrich_legacy_extraction(page, scope, legacy)


__all__ = ["extract_receipt_parties", "FIELD_NAMES", "SIDES", "STATES"]
