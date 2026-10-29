"""Bounded, bank-independent geometry for closed grids made of short strokes.

This deliberately does not decide that a grid is a receipt. The layout layer
must still account for every text block and associate nearby visual content.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any


MAX_DRAWINGS = 4_096
MAX_ITEMS = 16_384
MAX_SEGMENTS = 2_048
MAX_COMPARISONS = 250_000
MAX_TABLES = 64
TOLERANCE = 2.0

Box = tuple[float, float, float, float]
Segment = tuple[float, float, float]  # axis position, interval start, interval end


class TableGeometryBudgetExceeded(RuntimeError):
    pass


@dataclass
class _Budget:
    comparisons: int = 0

    def compare(self) -> None:
        self.comparisons += 1
        if self.comparisons > MAX_COMPARISONS:
            raise TableGeometryBudgetExceeded


def _merge(segments: list[Segment], budget: _Budget) -> list[Segment]:
    # Each bucket has a fixed axis: neighbouring coordinates cannot gradually
    # drift into one another and connect distinct grids across a real gap.
    buckets: list[tuple[float, list[tuple[float, float]]]] = []
    for position, start, end in sorted(set(segments)):
        budget.compare()
        if not buckets or position - buckets[-1][0] > TOLERANCE:
            buckets.append((position, []))
        buckets[-1][1].append((start, end))
    merged = []
    for position, intervals in buckets:
        start, end = sorted(intervals)[0]
        for next_start, next_end in sorted(intervals)[1:]:
            budget.compare()
            if next_start <= end + TOLERANCE:
                end = max(end, next_end)
            else:
                merged.append((position, start, end))
                start, end = next_start, next_end
        merged.append((position, start, end))
    return merged


def closed_table_geometry(page: Any, *, images: tuple[Box, ...] = ()) -> tuple[list[Box], list[Box]]:
    """Return independent closed grid envelopes and non-grid drawing bounds.

    A row made of separate cell edges is joined before testing closure. Merely
    having horizontal rules, a fill rectangle or a page border is insufficient.
    All-or-nothing budgets prevent partial geometry from appearing trustworthy.
    """
    horizontal: list[Segment] = []
    vertical: list[Segment] = []
    ink: list[Box] = []
    axis_drawings: list[tuple[Box, list[Box]]] = []
    items_seen = 0

    def line(x0: float, y0: float, x1: float, y1: float) -> bool:
        if not all(math.isfinite(v) for v in (x0, y0, x1, y1)):
            return False
        if abs(y1 - y0) <= TOLERANCE and abs(x1 - x0) > TOLERANCE:
            horizontal.append(((y0 + y1) / 2, min(x0, x1), max(x0, x1)))
        elif abs(x1 - x0) <= TOLERANCE and abs(y1 - y0) > TOLERANCE:
            vertical.append(((x0 + x1) / 2, min(y0, y1), max(y0, y1)))
        else:
            return False
        if len(horizontal) + len(vertical) > MAX_SEGMENTS:
            raise TableGeometryBudgetExceeded
        return True

    for number, drawing in enumerate(page.get_drawings(), 1):
        if number > MAX_DRAWINGS:
            raise TableGeometryBudgetExceeded
        stroked = (drawing.get("type") != "f" and drawing.get("color") is not None
                   and drawing.get("stroke_opacity", 1) != 0)
        non_grid = not stroked
        axis_boxes = []
        for item in drawing.get("items", ()):
            items_seen += 1
            if items_seen > MAX_ITEMS:
                raise TableGeometryBudgetExceeded
            if not stroked:
                continue
            if item[0] == "l":
                non_grid |= not line(*item[1], *item[2])
                axis_boxes.append((min(item[1].x, item[2].x), min(item[1].y, item[2].y),
                                   max(item[1].x, item[2].x), max(item[1].y, item[2].y)))
            elif item[0] == "re":
                x0, y0, x1, y1 = item[1]
                for edge in ((x0, y0, x1, y0), (x0, y1, x1, y1),
                             (x0, y0, x0, y1), (x1, y0, x1, y1)):
                    line(*edge)
                    axis_boxes.append(edge)
            else:
                non_grid = True
        rect = drawing.get("rect")
        visible = stroked or (drawing.get("fill") is not None and drawing.get("fill_opacity", 1) != 0)
        if visible and rect is not None:
            box = tuple(float(v) for v in rect)
            if (all(math.isfinite(v) for v in box) and box[2] >= box[0] and box[3] >= box[1]
                    and not (box[2] - box[0] >= page.rect.width * .85
                             and box[3] - box[1] >= page.rect.height * .85)):
                if non_grid:
                    ink.append(box)
                elif axis_boxes:
                    axis_drawings.append((box, axis_boxes))

    budget = _Budget()
    horizontal, vertical = _merge(horizontal, budget), _merge(vertical, budget)

    def covers(edges: list[Segment], position: float, start: float, end: float) -> bool:
        for p, a, b in edges:
            budget.compare()
            if abs(p - position) <= TOLERANCE and a <= start + TOLERANCE and b >= end - TOLERANCE:
                return True
        return False

    # Test closed envelopes, not the bounding box of a connected component:
    # an intersecting rectangular seal must not distort the table's exterior.
    envelopes: list[Box] = []
    for index, (y0, x0, x1) in enumerate(horizontal):
        if x1 - x0 < page.rect.width * .30:
            continue
        for y1, a, b in horizontal[index + 1:]:
            budget.compare()
            if y1 - y0 < 48 or abs(a - x0) > TOLERANCE or abs(b - x1) > TOLERANCE:
                continue
            if not (0 <= x0 < x1 <= page.rect.width and 0 <= y0 < y1 <= page.rect.height):
                continue
            if not (covers(vertical, x0, y0, y1) and covers(vertical, x1, y0, y1)):
                continue
            starts_here = ends_here = False
            for x, start, end in vertical:
                budget.compare()
                if min(abs(x - x0), abs(x - x1)) <= TOLERANCE:
                    starts_here |= abs(start - y0) <= TOLERANCE
                    ends_here |= abs(end - y1) <= TOLERANCE
            if not starts_here or not ends_here:
                continue  # Interior rows of a broken exterior are not tables.
            has_row = False
            for y, left, right in horizontal:
                budget.compare()
                if y0 + TOLERANCE < y < y1 - TOLERANCE and left <= x0 + TOLERANCE and right >= x1 - TOLERANCE:
                    has_row = True
                    break
            if has_row:
                envelopes.append((x0, y0, x1, y1))

    def contained(inner: Box, outer: Box) -> bool:
        return (inner[0] >= outer[0] - TOLERANCE and inner[1] >= outer[1] - TOLERANCE
                and inner[2] <= outer[2] + TOLERANCE and inner[3] <= outer[3] + TOLERANCE)

    maximal: list[Box] = []
    for box in sorted(envelopes, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True):
        nested = False
        for outer in maximal:
            budget.compare()
            if contained(box, outer):
                nested = True
                break
        if not nested:
            maximal.append(box)
            if len(maximal) > MAX_TABLES:
                raise TableGeometryBudgetExceeded

    tables = []
    for x0, y0, x1, y1 in maximal:
        # A shared page outline may connect independent grids, but a tall
        # merged remarks cell can have exactly the same interrupted columns.
        # Column runs only propose a split; repeated mastheads must support it.
        runs: list[list[float]] = []
        intervals = sorted((max(a, y0), min(b, y1)) for x, a, b in vertical
                           if x0 + TOLERANCE < x < x1 - TOLERANCE and min(b, y1) > max(a, y0))
        for a, b in intervals:
            if runs and a <= runs[-1][1] + 48:
                runs[-1][1] = max(runs[-1][1], b)
            else:
                runs.append([a, b])
        rows = [y for y, a, b in horizontal if a <= x0 + TOLERANCE and b >= x1 - TOLERANCE
                and y0 - TOLERANCE <= y <= y1 + TOLERANCE]
        runs = [run for run in runs if run[1] - run[0] >= 48
                and sum(run[0] - TOLERANCE <= y <= run[1] + TOLERANCE for y in rows) >= 3]
        if len(runs) < 2:
            tables.append((x0, y0, x1, y1))
            continue
        proposed = []
        for index, (start, end) in enumerate(runs):
            lower = (runs[index - 1][1] + start) / 2 if index else y0
            upper = (end + runs[index + 1][0]) / 2 if index + 1 < len(runs) else y1
            relevant = [y for y in rows if lower <= y <= upper]
            proposed.append((x0, min(relevant), x1, max(relevant)))
        headers = []
        for left, top, right, bottom in proposed:
            options = []
            for ix0, iy0, ix1, iy1 in images:
                budget.compare()
                width, height = ix1 - ix0, iy1 - iy0
                if (left <= ix0 < ix1 <= right and top - 48 <= iy0 < top + 24
                        and iy1 <= top + 24 and 8 <= height <= 48
                        and 2 * height <= width <= (right - left) * .65):
                    options.append((ix0 - left, iy0 - top, width, height))
            headers.append(options)
        repeated_header = False
        for reference in headers[0]:
            supported = True
            for options in headers[1:]:
                match = False
                for other in options:
                    budget.compare()
                    if all(abs(a - b) <= 2 for a, b in zip(reference, other)):
                        match = True
                        break
                if not match:
                    supported = False
                    break
            if supported:
                repeated_header = True
                break
        tables.extend(proposed if repeated_header else [(x0, y0, x1, y1)])
    if len(tables) > MAX_TABLES:
        raise TableGeometryBudgetExceeded

    def grid_edge(box: Box) -> bool:
        for table in tables:
            budget.compare()
            if contained(box, table):
                return True
        # The shared side rails above are structure, not a giant stamp.
        if box[2] - box[0] <= TOLERANCE:
            touching = 0
            for table in tables:
                budget.compare()
                if (min(abs(box[0] - table[0]), abs(box[0] - table[2])) <= TOLERANCE
                        and min(box[3], table[3]) >= max(box[1], table[1]) - TOLERANCE):
                    touching += 1
            return touching > 1
        return False

    for box, edges in axis_drawings:
        if not all(grid_edge(edge) for edge in edges):
            ink.append(box)
    return sorted(tables, key=lambda box: (box[1], box[0])), ink
