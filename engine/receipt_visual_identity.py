"""Bounded, anonymous evidence for the same visible receipt form.

This does not identify a named bank.  A rendered masthead fragment, the native
receipt title, the actually placed separator graphic and its relative geometry
must all agree.  Filenames, account fields and unused PDF image resources are
never evidence.  The original masthead positions remain bound after editing.
"""
from __future__ import annotations

from hashlib import sha256
from functools import lru_cache
import json
import math
from operator import sub
import re
from typing import Any, Mapping

import pymupdf as fitz


_PREFIX = "receipt-visual-v1"
_HASH = re.compile(r"^[0-9a-f]{64}$")
_MAX_IMAGES = 128
_MAX_ROWS = 12
_SMALL_PIXEL_DIFFERENCES = bytes(range(33))
_CUSTOMER_RECEIPT_TITLES = frozenset({
    "客户回单通用回单", "客户回单网上支付跨行清算业务",
    "客户回单大额支付系统业务", "客户回单小额支付系统业务",
})


def _digest(value: object) -> str:
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _colored_pixel_count(samples: bytes) -> int:
    """Count the same RGB channel spread without allocating a slice per pixel."""
    return sum(abs(r - g) > 30 or abs(r - b) > 30 or abs(g - b) > 30
               for r, g, b in zip(samples[::3], samples[1::3], samples[2::3], strict=True))


def _pixels_differ(samples: bytes, expected: bytes) -> bool:
    """Keep both visible-logo tolerances exact, using bounded byte operations."""
    if not samples or len(samples) != len(expected):
        raise ValueError("incompatible visible pixel buffers")
    if samples == expected:
        return False
    # Each absolute difference is in [0, 255]. Keeping bytes instead of Python
    # integers avoids a per-channel list and a second Python counting loop.
    differences = bytes(map(abs, map(sub, samples, expected)))
    return (sum(differences) > len(differences) * 3
            or len(differences.translate(None, _SMALL_PIXEL_DIFFERENCES)) > len(differences) * 0.02)


@lru_cache(maxsize=32)
def _reference_logo(data: bytes, width: float, height: float, color_mask: str, soft_mask: bytes) -> tuple[bytes, int, int]:
    with fitz.open() as document:
        page = document.new_page(width=width + 2, height=height + 2)
        xref = page.insert_image(fitz.Rect(0, 0, width, height), stream=data,
                                mask=soft_mask or None, keep_proportion=False)
        if color_mask:
            document.xref_set_key(xref, "Mask", color_mask)
        rendered = page.get_pixmap(matrix=fitz.Matrix(2, 2),
            clip=fitz.Rect(0, 4, width * 0.25, height - 2), colorspace=fitz.csRGB, alpha=False)
        return rendered.samples, rendered.width, rendered.height


def visual_positions(layout: Mapping[str, Any]) -> tuple[float, ...] | None:
    version = layout.get("evidence_version", "")
    if not isinstance(version, str) or not version.startswith(_PREFIX + "."):
        return None
    parts = version[len(_PREFIX) + 1:].split(".")
    if not 1 <= len(parts) <= _MAX_ROWS or any(not re.fullmatch(r"[pn][0-9]{1,6}", part) for part in parts):
        return None
    positions = tuple(int(part[1:]) * (-0.1 if part[0] == "n" else 0.1) for part in parts)
    return positions if all(a < b for a, b in zip(positions, positions[1:])) else None


def consume_visual_identity(descriptor: Mapping[str, Any]) -> tuple[str, str, str] | None:
    value = descriptor.get("layout_compatibility")
    if not isinstance(value, dict) or value.get("kind") != "visible_form_v1":
        return None
    issuer, family = value.get("issuer_id"), value.get("family_id")
    if (not isinstance(issuer, str) or not issuer.startswith("visual-")
            or not _HASH.fullmatch(issuer[7:]) or not isinstance(family, str)
            or not _HASH.fullmatch(family) or visual_positions(value) is None):
        return None
    return issuer, family, value["evidence_version"]


def compatible_visual_positions(sample: Mapping[str, Any], target: Mapping[str, Any]) -> bool:
    a, b = visual_positions(sample), visual_positions(target)
    # Only a prefix tail is proven here. A shifted/middle-only receipt must not
    # acquire a first-position identity merely because it is first on its page.
    return bool(a and b and all(abs(x - y) <= 0.5 for x, y in zip(a, b)))


@lru_cache(maxsize=32)
def _reference_compact_logo(data: bytes, width: float, height: float) -> tuple[bytes, int, int]:
    with fitz.open() as document:
        page = document.new_page(width=width + 2, height=height + 2)
        page.insert_image(fitz.Rect(0, 0, width, height), stream=data, keep_proportion=False)
        rendered = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=fitz.Rect(0, 0, width, height),
                                   colorspace=fitz.csRGB, alpha=False)
        return rendered.samples, rendered.width, rendered.height


def _visible_frame(page: Any, frame: fitz.Rect) -> bool:
    # Native path objects can be hidden by later paint. Verify continuous ink
    # on all four edges, retaining no body pixels as identifying evidence.
    strips = [(fitz.Rect(frame.x0, y - 1, frame.x1, y + 1), True) for y in (frame.y0, frame.y1)]
    strips += [(fitz.Rect(x - 1, frame.y0, x + 1, frame.y1), False) for x in (frame.x0, frame.x1)]
    for strip, horizontal in strips:
        pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=strip, colorspace=fitz.csGRAY, alpha=False)
        samples, width, height = pixmap.samples, pixmap.width, pixmap.height
        if not width or not height:
            return False
        if horizontal:
            ink = sum(any(samples[y * width + x] < 220 for y in range(height)) for x in range(width))
            length = width
        else:
            ink = sum(any(samples[y * width + x] < 220 for x in range(width)) for y in range(height))
            length = height
        if ink < length * 0.95:
            return False
    return True


def _describe_framed_customer(page: Any, titles: list[Any], frames: list[Any]) -> dict[str, str] | None:
    """One bounded customer-receipt form with controlled business subtitles.

    The subtype may differ while the physical form stays the same. This gate
    does not apply to other receipt titles or nonstandard certificates.
    """
    if len(frames) != len(titles) or any(title.title_text not in _CUSTOMER_RECEIPT_TITLES for title in titles):
        return None
    frames = sorted((fitz.Rect(frame) for frame in frames), key=lambda frame: frame.y0)
    first = frames[0]
    for index, (frame, title) in enumerate(zip(frames, titles, strict=True)):
        if (not all(math.isfinite(number) for number in frame) or not page.rect.contains(frame)
                or not page.rect.width * 0.7 <= frame.width <= page.rect.width
                or not page.rect.height * 0.15 <= frame.height <= page.rect.height * 0.55
                or abs(frame.x0 - first.x0) > 0.5 or abs(frame.width - first.width) > 0.5
                or abs(frame.height - first.height) > 1.5
                or (index and frames[index - 1].y1 >= frame.y0)
                or not frame.x0 < title.x0 < title.x1 < frame.x1
                or abs((title.x0 + title.x1) / 2 - (frame.x0 + frame.x1) / 2) > 8
                or not 15 <= title.y0 - frame.y0 < title.y1 - frame.y0 <= 60
                or not _visible_frame(page, frame)):
            return None
    images = page.get_images(full=True)
    if len(images) > _MAX_IMAGES:
        return None
    graphics, placements = {}, {}
    placement_count = 0
    for xref, item in {image[0]: image for image in images}.items():
        if not 100 <= item[2] <= 2048 or not 14 <= item[3] <= 256:
            continue
        # This small-logo branch has no need to infer transparency semantics.
        if any(page.parent.xref_get_key(xref, key)[0] != "null" for key in ("Mask", "SMask")):
            continue
        image_placements = page.get_image_rects(xref, transform=True)
        placement_count += len(image_placements)
        if placement_count > _MAX_IMAGES:
            return None
        for rect, matrix in image_placements:
            if (matrix.a <= 0 or matrix.d <= 0 or abs(matrix.b) > 0.001 or abs(matrix.c) > 0.001
                    or not all(math.isfinite(number) for number in rect) or not page.rect.contains(rect)
                    or not page.rect.width * 0.15 <= rect.width <= page.rect.width * 0.4
                    or not 14 <= rect.height <= 60):
                continue
            if xref not in graphics:
                pixmap = fitz.Pixmap(page.parent, xref)
                data = page.parent.extract_image(xref).get("image", b"")
                if pixmap.n != 3 or pixmap.alpha or not data or len(data) > 2 * 1024 * 1024:
                    continue
                # Identical decoded RGB pixels may have different PNG/ICC
                # encodings. Bind pixels, then verify their actual rendering.
                identity = _digest([pixmap.width, pixmap.height, sha256(pixmap.samples).hexdigest()])
                graphics[xref] = identity, data
            identity, data = graphics[xref]
            placements[(tuple(rect), identity)] = (rect, identity, data)
            if len(placements) > _MAX_IMAGES:
                return None
    logos = []
    for frame, title in zip(frames, titles, strict=True):
        matches = [item for item in placements.values() if frame.x0 < item[0].x0 < frame.x0 + frame.width * 0.15
                   and item[0].x1 + 2 < title.x0 and 0 <= item[0].y0 - frame.y0 <= 20
                   and abs(item[0].y1 - title.y1) <= 8]
        if len(matches) != 1:
            return None
        rect, identity, data = matches[0]
        shown = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=rect, colorspace=fitz.csRGB, alpha=False)
        expected, width, height = _reference_compact_logo(data, rect.width, rect.height)
        if (shown.width, shown.height) != (width, height):
            return None
        samples = shown.samples
        if _colored_pixel_count(samples) < width * height * 0.015:
            return None
        if _pixels_differ(samples, expected):
            return None
        logos.append((rect, identity))
    if len({identity for _rect, identity in logos}) != 1:
        return None
    logo = logos[0][0]
    if any(abs(rect.x0 - logo.x0) > 0.5 or abs(rect.width - logo.width) > 0.5
           or abs(rect.height - logo.height) > 0.5
           or abs((rect.y0 - frame.y0) - (logo.y0 - first.y0)) > 1.5
           for (rect, _identity), frame in zip(logos, frames, strict=True)):
        return None
    positions = [round(frame.y0 * 10) for frame in frames]
    version = _PREFIX + "." + ".".join("p" + str(value) for value in positions)
    if len(version) > 128:
        return None
    family = _digest(["framed-customer-receipt-v1", round(page.rect.width, 1), round(page.rect.height, 1),
                      *[round(value, 1) for value in (first.x0, first.width, first.height,
                          logo.x0 - first.x0, logo.y0 - first.y0, logo.width, logo.height)]])
    return {"kind": "visible_form_v1", "issuer_id": "visual-" + logos[0][1],
            "family_id": family, "evidence_version": version}


def _electronic_table_lines(page: Any) -> list[tuple[str, float, float, float, float, float]]:
    """Keep short native cell edges for this bounded form, not candidate slicing.

    General crop detection deliberately discards short lines. These receipts
    build their outer border from adjacent short strokes, so discarding them
    would lose both the closed border and the internal table structure.
    """
    drawings = page.get_drawings()
    if len(drawings) > 4096:
        raise ValueError("table drawing budget exceeded")
    lines = set()
    item_count = 0
    for drawing in drawings:
        items = drawing.get("items", ())
        item_count += len(items)
        if item_count > 16384:
            raise ValueError("table item budget exceeded")
        color, width = drawing.get("color"), drawing.get("width")
        if (drawing.get("type") not in {"s", "fs"} or not color or max(color) > 0.35
                or drawing.get("stroke_opacity", 0) < 0.99
                or not isinstance(width, (float, int)) or not 0 < width <= 2):
            continue
        for item in items:
            if item[0] == "l":
                edges = [(item[1].x, item[1].y, item[2].x, item[2].y)]
            elif item[0] == "re":
                rect = fitz.Rect(item[1])
                edges = [(rect.x0, rect.y0, rect.x1, rect.y0), (rect.x0, rect.y1, rect.x1, rect.y1),
                         (rect.x0, rect.y0, rect.x0, rect.y1), (rect.x1, rect.y0, rect.x1, rect.y1)]
            else:
                continue
            for ax, ay, bx, by in edges:
                if not all(math.isfinite(value) for value in (ax, ay, bx, by)):
                    raise ValueError("invalid table geometry")
                x0, x1 = sorted((ax, bx))
                y0, y1 = sorted((ay, by))
                if not (0 <= x0 <= x1 <= page.rect.width and 0 <= y0 <= y1 <= page.rect.height):
                    continue
                if y1 - y0 <= .01 and x1 - x0 >= 2:
                    lines.add(("h", x0, (y0 + y1) / 2, x1, (y0 + y1) / 2, float(width)))
                elif x1 - x0 <= .01 and y1 - y0 >= 2:
                    lines.add(("v", (x0 + x1) / 2, y0, (x0 + x1) / 2, y1, float(width)))
    if len(lines) > 4096:
        raise ValueError("table line budget exceeded")
    return sorted(lines)


def _visible_electronic_table(page: Any, table: fitz.Rect,
                              lines: list[tuple[str, float, float, float, float, float]]) -> bool:
    # Render the band once. Per-stroke rendering repeatedly replays the entire
    # display list and made the 30-page native fixture more than ten times slower.
    clip = fitz.Rect(table.x0 - 1, table.y0 - 1, table.x1 + 1, table.y1 + 1)
    if clip.width * clip.height * 4 > 4_000_000:
        return False
    pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=clip, colorspace=fitz.csGRAY, alpha=False)
    samples, width, height = pixmap.samples, pixmap.width, pixmap.height
    if not width or not height:
        return False
    edges = [("h", table.x0, y, table.x1, y, 1) for y in (table.y0, table.y1)]
    edges += [("v", x, table.y0, x, table.y1, 1) for x in (table.x0, table.x1)]
    for direction, x0, y0, x1, y1, _stroke in [*edges, *lines]:
        horizontal = direction == "h"
        left = math.floor((x0 - (0 if horizontal else 1)) * 2) - pixmap.x
        right = math.ceil((x1 + (0 if horizontal else 1)) * 2) - pixmap.x
        top = math.floor((y0 - (1 if horizontal else 0)) * 2) - pixmap.y
        bottom = math.ceil((y1 + (1 if horizontal else 0)) * 2) - pixmap.y
        if not (0 <= left < right <= width and 0 <= top < bottom <= height):
            return False
        if horizontal:
            ink = sum(any(samples[y * width + x] < 220 for y in range(top, bottom)) for x in range(left, right))
            length = right - left
        else:
            ink = sum(any(samples[y * width + x] < 220 for x in range(left, right)) for y in range(top, bottom))
            length = bottom - top
        if ink < length * .95:
            return False
    return True


@lru_cache(maxsize=64)
def _reference_positioned_logo(data: bytes, placement: tuple[float, ...]) -> tuple[bytes, int, int]:
    # Preserve the subpixel placement phase. Rendering at (0, 0) changes edge
    # interpolation for small logos at fractional PDF coordinates.
    x0, y0, x1, y1 = placement
    rect = fitz.Rect(x0 % 1, y0 % 1, x0 % 1 + x1 - x0, y0 % 1 + y1 - y0)
    with fitz.open() as document:
        page = document.new_page(width=rect.x1 + 2, height=rect.y1 + 2)
        page.insert_image(rect, stream=data, keep_proportion=False)
        pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=rect, colorspace=fitz.csRGB, alpha=False)
        return pixmap.samples, pixmap.width, pixmap.height


def _describe_electronic_customer(page: Any, titles: list[Any]) -> dict[str, str] | None:
    """An anonymous small masthead above a complete native customer-receipt table.

    This is positive visual form evidence, not a bank-name guess. Bind the
    actual logo pixels, native title, all visible table strokes and their
    relative geometry; never account text, transaction values or crop edits.
    """
    lines = _electronic_table_lines(page)
    images = page.get_images(full=True)
    if len(images) > _MAX_IMAGES:
        return None
    placements = {}
    graphics = {}
    placement_count = 0
    for xref, item in {image[0]: image for image in images}.items():
        if not (100 <= item[2] <= 1024 and 20 <= item[3] <= 256 and 2 <= item[2] / item[3] <= 12):
            continue
        if any(page.parent.xref_get_key(xref, key)[0] != "null" for key in ("Mask", "SMask")):
            continue
        positioned = page.get_image_rects(xref, transform=True)
        placement_count += len(positioned)
        if placement_count > _MAX_IMAGES:
            return None
        for rect, matrix in positioned:
            if (matrix.a <= 0 or matrix.d <= 0 or abs(matrix.b) > .001 or abs(matrix.c) > .001
                    or not all(math.isfinite(value) for value in rect) or not page.rect.contains(rect)
                    or not page.rect.width * .08 <= rect.width <= page.rect.width * .3
                    or not 14 <= rect.height <= 40):
                continue
            placements[(xref, tuple(rect))] = (xref, rect)
    forms, logos, positions = [], [], []
    # Quantize geometric evidence after removing row origin; the small epsilon
    # absorbs float32 arithmetic at exact decimal rounding boundaries.
    def rounded(values):
        return [round(value + .0001, 1) for value in values]
    for index, title in enumerate(titles):
        next_top = titles[index + 1].y0 if index + 1 < len(titles) else page.rect.height
        table_lines = [line for line in lines if title.y1 < line[2] <= line[4] < next_top]
        if (len(table_lines) > 256 or sum(line[0] == "h" for line in table_lines) < 6
                or sum(line[0] == "v" for line in table_lines) < 6):
            return None
        table = fitz.Rect(min(line[1] for line in table_lines), min(line[2] for line in table_lines),
                          max(line[3] for line in table_lines), max(line[4] for line in table_lines))
        if (not page.rect.width * .7 <= table.width <= page.rect.width * .95
                or not page.rect.height * .15 <= table.height <= page.rect.height * .35
                or not 2 <= table.y0 - title.y1 <= 20
                or not table.x0 < title.x0 < title.x1 < table.x1
                or not _visible_electronic_table(page, table, table_lines)):
            return None
        matches = [(xref, rect) for xref, rect in placements.values()
                   if table.x0 < rect.x0 < rect.x1 + 8 < title.x0
                   and abs(rect.y1 - title.y1) <= 8 and abs(rect.y0 - title.y0) <= 12
                   and rect.y1 < table.y0 and 2 <= table.y0 - rect.y1 <= 20]
        if len(matches) != 1:
            return None
        xref, logo = matches[0]
        if xref not in graphics:
            pixmap = fitz.Pixmap(page.parent, xref)
            data = page.parent.extract_image(xref).get("image", b"")
            if pixmap.n != 3 or pixmap.alpha or not data or len(data) > 2 * 1024 * 1024:
                return None
            graphics[xref] = _digest([pixmap.width, pixmap.height, sha256(pixmap.samples).hexdigest()]), data
        identity, data = graphics[xref]
        shown = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=logo, colorspace=fitz.csRGB, alpha=False)
        expected, width, height = _reference_positioned_logo(data, tuple(logo))
        if ((shown.width, shown.height) != (width, height)
                or _colored_pixel_count(shown.samples) < width * height * .015
                or _pixels_differ(shown.samples, expected)):
            return None
        forms.append(_digest(["electronic-customer-table-v1", title.title_key,
            rounded((page.rect.width, page.rect.height, table.x0, table.width, table.height,
                     title.x0, title.x1, title.y0 - table.y0, title.y1 - table.y0,
                     logo.x0, logo.width, logo.height, logo.y0 - table.y0)),
            [[line[0], *rounded((line[1], line[2] - table.y0, line[3], line[4] - table.y0, line[5]))]
             for line in table_lines]]))
        logos.append(identity)
        positions.append(round(logo.y0 * 10))
    if len(set(forms)) != 1 or len(set(logos)) != 1 or any(a >= b for a, b in zip(positions, positions[1:])):
        return None
    version = _PREFIX + "." + ".".join("p" + str(position) for position in positions)
    if len(version) > 128:
        return None
    return {"kind": "visible_form_v1", "issuer_id": "visual-" + logos[0],
            "family_id": forms[0], "evidence_version": version}


def describe_visual_form(page: Any, titles: list[Any], *, frames: list[Any] | None = None) -> dict[str, str] | None:
    """Describe repeated native receipts with visible bitmap mastheads/rules.

    This intentionally narrow Core fallback accepts a fully evidenced form,
    rather than guessing the bank when local OCR is unavailable.
    """
    if not 1 <= len(titles) <= _MAX_ROWS or any("回单" not in title.title_text for title in titles):
        return None
    if all(title.title_text == "客户电子回单" for title in titles):
        try:
            return _describe_electronic_customer(page, titles)
        except (RuntimeError, ValueError, TypeError, AttributeError, KeyError, OSError):
            return None
    if frames and all(title.title_text in _CUSTOMER_RECEIPT_TITLES for title in titles):
        try:
            return _describe_framed_customer(page, titles, frames)
        except (RuntimeError, ValueError, TypeError, AttributeError, KeyError, OSError):
            return None
    if len({title.title_key for title in titles}) != 1:
        return None
    try:
        images = page.get_images(full=True)
        if len(images) > _MAX_IMAGES:
            return None
        boxes = []
        for xref, info in {image[0]: image for image in images}.items():
            width, height = info[2:4]
            if not 100 <= width <= 2048 or not 2 <= height <= 256:
                continue
            placements = page.get_image_rects(xref, transform=True)
            if len(boxes) + len(placements) > _MAX_IMAGES:
                return None
            for rect, matrix in placements:
                if (matrix.a <= 0 or matrix.d <= 0 or abs(matrix.b) > 0.001 or abs(matrix.c) > 0.001
                        or not all(math.isfinite(number) for number in rect)):
                    continue
                if not (0 <= rect.x0 < rect.x1 <= page.rect.width and -4 <= rect.y0 < rect.y1 <= page.rect.height):
                    continue
                boxes.append((xref, width, height, rect))
        headers = []
        for title in titles:
            matches = [(xref, rect) for xref, _w, _h, rect in boxes
                       if rect.width >= page.rect.width * 0.65 and 14 <= rect.height <= 48
                       and rect.x0 < title.x0 < title.x1 < rect.x1
                       and -8 <= title.y0 - rect.y0 <= 12 and title.y1 <= rect.y1
                       and rect.x0 + rect.width * 0.25 + 4 < title.x0]
            if len(matches) != 1:
                return None
            xref, rect = matches[0]
            # Render only actually visible pixels to reject masks/overpainting.
            # The common interior omits at most four clipped top points, allowing
            # a zero-margin first row to match fully visible subsequent rows.
            logo = fitz.Rect(rect.x0, rect.y0 + 4, rect.x0 + rect.width * 0.25, rect.y1 - 2)
            if logo.y0 < 0 or logo.height < 8:
                return None
            pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=logo, colorspace=fitz.csRGB, alpha=False)
            samples = pixmap.samples
            colored = _colored_pixel_count(samples)
            if colored < pixmap.width * pixmap.height * 0.015:
                return None
            # Bind the complete displayed graphic as well as its visible logo.
            graphic = page.parent.extract_image(xref)
            data = graphic.get("image", b"")
            if not data or len(data) > 2 * 1024 * 1024:
                return None
            mask_type, color_mask = page.parent.xref_get_key(xref, "Mask")
            soft_type, soft_ref = page.parent.xref_get_key(xref, "SMask")
            if soft_type not in {"null", "xref"} or mask_type not in {"null", "array"}:
                return None
            if mask_type == "array" and not re.fullmatch(r"\[\s*(?:[0-9]{1,3}\s*){2,8}\]", color_mask):
                return None
            soft_mask = page.parent.extract_image(int(soft_ref.split()[0])).get("image", b"") if soft_type == "xref" else b""
            if len(soft_mask) > 2 * 1024 * 1024:
                return None
            expected, expected_width, expected_height = _reference_logo(data, rect.width, rect.height,
                color_mask if mask_type == "array" else "", soft_mask)
            if (pixmap.width, pixmap.height) != (expected_width, expected_height):
                return None
            # A partially clipped bitmap can change interpolation at its edge.
            # Permit a small rendering difference, not a missing/covered logo.
            if _pixels_differ(samples, expected):
                return None
            headers.append((rect, _digest([sha256(expected).hexdigest(), expected_width, expected_height,
                                          sha256(data).hexdigest()])))
        if len({identity for _box, identity in headers}) != 1:
            return None
        separator_keys = []
        for index, (header, _identity) in enumerate(headers):
            next_top = headers[index + 1][0].y0 if index + 1 < len(headers) else page.rect.height
            separators = [(xref, rect) for xref, _w, _h, rect in boxes
                          if rect.width >= page.rect.width * 0.8 and 2 <= rect.height <= 12
                          and header.y1 + 50 <= rect.y0 < rect.y1 <= next_top]
            if len(separators) > 1 or (index + 1 < len(headers) and not separators):
                return None
            if separators:
                xref, rect = separators[0]
                data = page.parent.extract_image(xref).get("image", b"")
                if not data or len(data) > 2 * 1024 * 1024:
                    return None
                separator_keys.append([sha256(data).hexdigest(), *[round(value, 1) for value in
                    (rect.x0, rect.width, rect.height, rect.y0 - header.y0)]])
        if not separator_keys or any(value != separator_keys[0] for value in separator_keys):
            return None
        positions = [round(header.y0 * 10) for header, _identity in headers]
        version = _PREFIX + "." + ".".join(("n" if value < 0 else "p") + str(abs(value)) for value in positions)
        if len(version) > 128:
            return None
        first = headers[0][0]
        family = _digest(["visible-form-v1", titles[0].title_key, round(page.rect.width, 1),
                          round(page.rect.height, 1), [round(value, 1) for value in (first.x0, first.width, first.height)],
                          separator_keys[0]])
        return {"kind": "visible_form_v1", "issuer_id": "visual-" + headers[0][1],
                "family_id": family, "evidence_version": version}
    except (RuntimeError, ValueError, TypeError, AttributeError, KeyError, OSError):
        return None
