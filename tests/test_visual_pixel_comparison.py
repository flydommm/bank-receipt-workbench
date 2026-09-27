"""Visible-form speedups must keep the exact color and overpainting gates."""
from itertools import permutations
import random

import pytest

from engine.receipt_visual_identity import _colored_pixel_count, _pixels_differ


def test_color_threshold_and_all_rgb_channel_orders():
    pixels = [(40, 40, 40), (40, 55, 70), (40, 55, 71), (255, 0, 127)]
    pixels = [pixel for triple in pixels for pixel in permutations(triple)]
    assert _colored_pixel_count(bytes(channel for pixel in pixels for channel in pixel)) == 12


def test_pixel_mean_threshold_is_inclusive_without_relaxation():
    expected = bytes(300)
    assert not _pixels_differ(bytes([3]) * 300, expected)
    assert _pixels_differ(bytes([3]) * 299 + bytes([4]), expected)


def test_sparse_overpainting_threshold_and_difference_32_boundary():
    expected = bytes(300)
    assert not _pixels_differ(bytes([33]) * 6 + bytes(294), expected)
    assert _pixels_differ(bytes([33]) * 7 + bytes(293), expected)
    assert not _pixels_differ(bytes([32]) * 7 + bytes(293), expected)


def test_identical_buffers_match_but_missing_or_mismatched_buffers_do_not():
    assert not _pixels_differ(b"\x00\x7f\xff", b"\x00\x7f\xff")
    for left, right in ((b"", b""), (b"abc", b"ab"), (b"a", b"ab")):
        with pytest.raises(ValueError):
            _pixels_differ(left, right)


def test_optimized_gates_match_reference_on_seeded_pixel_variations():
    rng = random.Random(71035)
    for count in (1, 33, 100, 1024):
        original = bytes(rng.randrange(256) for _ in range(count * 3))
        assert _colored_pixel_count(original) == sum(
            max(original[i:i+3]) - min(original[i:i+3]) > 30 for i in range(0, len(original), 3))
        for delta, stride in ((1, 1), (3, 1), (4, 1), (32, 49), (33, 50), (255, 48)):
            altered = bytes(min(255, value + delta) if i % stride == 0 else value
                            for i, value in enumerate(original))
            differences = [abs(a-b) for a, b in zip(altered, original, strict=True)]
            reference = sum(differences) / len(differences) > 3 or sum(v > 32 for v in differences) > len(differences) * .02
            assert _pixels_differ(altered, original) == reference
