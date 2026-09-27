"""Bounded, text-only ownership of print-count prefixes shared by crop paths."""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from typing import Protocol, Sequence
import unicodedata


_LINE_TOLERANCE = 2.0
_PRINT_COUNT_PREFIX = "打印次数"
_PRINT_COUNT_TITLE_GAP = 16.0
_PRINT_COUNT_SPLIT_MAX_GAP = 16.0
_PRINT_COUNT_SPLIT_MAX_HEIGHT_DELTA = 2.0
MAX_PRINT_COUNT_PAIR_COMPARISONS = 4_096


class PrintCountBudgetExceeded(Exception):
    """A partial prefix assignment cannot be trusted after the budget is spent."""


class TitleGeometry(Protocol):
    @property
    def y0(self) -> float: ...

    @property
    def y1(self) -> float: ...


def is_print_count_line(text: str) -> bool:
    """Recognize only an isolated print-count line.

    Banks commonly put ``打印次数：0`` immediately above the next copy.  PDF
    text extraction may merge that line with the following receipt title, so
    callers use the line-level boxes when available.  Requiring the complete
    label, one colon, and digits keeps body prose such as ``备注：打印次数：0``
    eligible as receipt content.
    """

    if not isinstance(text, str):
        return False
    compact = "".join(unicodedata.normalize("NFC", text).split())
    if not compact.startswith(_PRINT_COUNT_PREFIX):
        return False
    suffix = compact[len(_PRINT_COUNT_PREFIX):]
    return len(suffix) > 1 and suffix[0] in ":：" and suffix[1:].isdigit()


def is_print_count_label(text: str) -> bool:
    """Recognize only the label half of a split print-count line."""

    if not isinstance(text, str):
        return False
    compact = "".join(unicodedata.normalize("NFC", text).split())
    return compact in (f"{_PRINT_COUNT_PREFIX}:", f"{_PRINT_COUNT_PREFIX}：")


def is_print_count_value(text: str) -> bool:
    """Recognize a compact ASCII digit value for a split print-count line."""

    if not isinstance(text, str):
        return False
    compact = "".join(unicodedata.normalize("NFC", text).split())
    return bool(compact) and compact.isascii() and compact.isdigit()


def split_print_count_pair_candidates(
    line_boxes: list[tuple[str, tuple[float, float, float, float]]],
    *,
    pair_budget: int = MAX_PRINT_COUNT_PAIR_COMPARISONS,
) -> list[tuple[tuple[float, float, float, float], tuple[float, float, float, float]]]:
    """Return unambiguous label/value pairs emitted as separate text lines.

    Some PDFs put ``打印次数：`` and its numeric value in separate text
    objects.  Pair only lines with matching vertical geometry, a short gap to
    the right, and a compact value.  Requiring one-to-one geometry and no
    intervening line keeps an isolated label from becoming a prefix merely
    because an unrelated number happens to be nearby.
    """

    labels = sorted(
        {
            box for text, box in line_boxes
            if is_print_count_label(text)
        },
        key=lambda box: (box[1], box[0], box[3], box[2]),
    )
    values = sorted(
        {
            box for text, box in line_boxes
            if is_print_count_value(text)
        },
        key=lambda box: (box[1], box[0], box[3], box[2]),
    )

    def compatible(
        label: tuple[float, float, float, float],
        value: tuple[float, float, float, float],
    ) -> bool:
        label_height = label[3] - label[1]
        value_height = value[3] - value[1]
        value_width = value[2] - value[0]
        if (
            label_height <= 0
            or value_height <= 0
            or value_width <= 0
            or abs(label[1] - value[1]) > _PRINT_COUNT_SPLIT_MAX_HEIGHT_DELTA
            or abs(label[3] - value[3]) > _PRINT_COUNT_SPLIT_MAX_HEIGHT_DELTA
            or abs(label_height - value_height) > _PRINT_COUNT_SPLIT_MAX_HEIGHT_DELTA
            or value[0] < label[2] - _LINE_TOLERANCE
            or value[0] - label[2] > _PRINT_COUNT_SPLIT_MAX_GAP
            or value_width > max(label[2] - label[0], label_height * 4.0)
        ):
            return False
        return True

    candidates_by_label: dict[
        tuple[float, float, float, float],
        list[tuple[float, float, float, float]],
    ] = {}
    candidates_by_value: dict[
        tuple[float, float, float, float],
        list[tuple[float, float, float, float]],
    ] = {}
    baseline_entries = sorted(
        ((box[1], box) for _text, box in line_boxes),
        key=lambda item: (item[0], item[1][3], item[1][0], item[1][2]),
    )
    baseline_y0s = [item[0] for item in baseline_entries]
    pair_comparisons = 0
    for label in labels:
        for value in values:
            pair_comparisons += 1
            if pair_comparisons > pair_budget:
                raise PrintCountBudgetExceeded
            if not compatible(label, value):
                continue
            candidates_by_label.setdefault(label, []).append(value)
            candidates_by_value.setdefault(value, []).append(label)

    pairs = []
    for label, values_for_label in candidates_by_label.items():
        if len(values_for_label) != 1:
            continue
        value = values_for_label[0]
        if len(candidates_by_value.get(value, ())) != 1:
            continue
        # A line occupying the gap makes the horizontal association
        # ambiguous, even when its text is not numeric.  Do this after the
        # one-to-one check so a second nearby value cannot be hidden by the
        # first pair's gap test.
        baseline_start = bisect_left(
            baseline_y0s,
            label[1] - _LINE_TOLERANCE,
        )
        baseline_end = bisect_right(
            baseline_y0s,
            label[1] + _LINE_TOLERANCE,
        )
        if any(
            other_box not in (label, value)
            and abs(other_box[3] - label[3]) <= _LINE_TOLERANCE
            and other_box[0] < value[0] + _LINE_TOLERANCE
            and other_box[2] > label[2] - _LINE_TOLERANCE
            for _other_y0, other_box in baseline_entries[baseline_start:baseline_end]
        ):
            continue
        pairs.append((label, value))
    return pairs


def print_count_prefixes(
    titles: Sequence[TitleGeometry],
    line_boxes: list[tuple[str, tuple[float, float, float, float]]],
    *,
    pair_budget: int = MAX_PRINT_COUNT_PAIR_COMPARISONS,
) -> tuple[set[tuple[float, float, float, float]], list[float | None]]:
    """Find print-count lines that are clearly the next title's prefix.

    A footer count on the current receipt can have the same lexical form, so
    text alone is insufficient.  Only a unique count line whose lower edge is
    at most ``_PRINT_COUNT_TITLE_GAP`` points above the next title is assigned
    forward.  Ambiguous duplicates are left in the ordinary text stream.
    """

    assigned: set[tuple[float, float, float, float]] = set()
    starts: list[float | None] = [None] * len(titles)
    marker_groups = [
        ((box,), box[1], box[3])
        for box in sorted(
            {
                box for text, box in line_boxes
                if is_print_count_line(text)
            },
            key=lambda item: (item[1], item[0], item[3], item[2]),
        )
    ]
    marker_groups.extend(
        ((label, value), min(label[1], value[1]), max(label[3], value[3]))
        for label, value in split_print_count_pair_candidates(line_boxes, pair_budget=pair_budget)
    )
    for index, title in enumerate(titles):
        previous_y1 = titles[index - 1].y1 if index else 0.0
        candidates = [
            group
            for group in marker_groups
            if group[1] >= previous_y1 - _LINE_TOLERANCE
            and -_LINE_TOLERANCE <= title.y0 - group[2] <= _PRINT_COUNT_TITLE_GAP
        ]
        if len(candidates) != 1:
            continue
        marker_boxes, marker_start, _marker_end = candidates[0]
        assigned.update(marker_boxes)
        starts[index] = marker_start
    return assigned, starts
