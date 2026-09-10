from engine.crop import normalize_region, region_from_points
from engine.layout import LayoutCandidate, Rect


def test_region_from_points_is_clamped_to_page() -> None:
    rect = region_from_points(580, 780, 10, 5, 600, 800)
    assert rect == Rect(10, 5, 580, 780)


def test_normalize_region_preserves_confidence_and_clamps_rect() -> None:
    candidate = LayoutCandidate(Rect(-5, -5, 1000, 1000), 0.8, 3, "test")
    normalized = normalize_region(candidate, 600, 800)
    assert normalized.confidence == 0.8
    assert normalized.rect == Rect(0, 0, 600, 800)
