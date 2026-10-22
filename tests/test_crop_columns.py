from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-ocr-service"))


@pytest.fixture(autouse=True)
def _default_split(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("LOCAL_OCR_COLUMN_SPLIT", raising=False)
    yield


def _vertical_bars_image(height: int = 160, width: int = 30, bands: list[tuple[int, int]] | None = None) -> np.ndarray:
    """白底黑竖条：竖排列的最低限度仿真（每列贯穿全高）。"""
    image = np.full((height, width, 3), 255, dtype=np.uint8)
    for x0, x1 in bands or []:
        image[:, x0:x1] = 0
    return image


def _png_bytes(image: np.ndarray) -> bytes:
    import cv2

    ok, buf = cv2.imencode(".png", image)
    assert ok
    return buf.tobytes()


def test_two_clean_columns_are_detected() -> None:
    import server

    crop = _vertical_bars_image(bands=[(2, 16), (19, 27)])
    assert server.detect_column_bands(crop) == [(2, 16), (19, 27)]


def test_single_column_returns_empty() -> None:
    import server

    crop = _vertical_bars_image(bands=[(2, 16)])
    assert server.detect_column_bands(crop) == []


def test_one_pixel_channel_is_a_column_boundary() -> None:
    import server

    # 实测列缝窄到 1px（ルビ紧贴正文/邻列出血），贯穿整列高度的 1px 通道即列界。
    crop = _vertical_bars_image(bands=[(2, 14), (15, 16), (17, 28)])
    assert server.detect_column_bands(crop) == [(2, 14), (17, 28)]


def test_edge_bleed_below_min_width_is_dropped_from_bands() -> None:
    import server

    # 裁剪边缘出血（≤3px）被丢掉，不构成独立列、也不阻止拆分；
    # 只剩一条列时按契约返回 []（不拆分）。
    crop = _vertical_bars_image(bands=[(0, 1), (5, 25), (27, 30)])
    assert server.detect_column_bands(crop) == []


def test_more_than_max_bands_returns_empty() -> None:
    import server

    crop = _vertical_bars_image(width=60, bands=[(2, 10), (14, 22), (26, 34), (38, 46), (50, 58)])
    assert server.detect_column_bands(crop) == []


def test_small_crop_is_not_analyzed() -> None:
    import server

    crop = _vertical_bars_image(height=30, width=30, bands=[(2, 10), (14, 22)])
    assert server.detect_column_bands(crop) == []


def test_det_worthy_bands_filter_keeps_real_columns_drops_bleed() -> None:
    import server

    # 拆分判定看 4px；为碎带建条目看 8px——4~7px 的出血/碎片不成条（真ルビ列 8~11px 不受影响）。
    bands = [(1, 7), (8, 31), (32, 37)]
    assert server.detect_column_bands(_vertical_bars_image(width=40, bands=bands)) == bands
    assert server.det_worthy_column_bands(bands) == [(8, 31)]
    assert server.det_worthy_column_bands([(5, 25), (27, 31)]) == [(5, 25)]
    assert server.det_worthy_column_bands(bands and [(1, 7)]) == []
    # 全部碎带都不足 8px → 空列表，调用方回退整列识别。
    assert server.det_worthy_column_bands(server.detect_column_bands(_vertical_bars_image(width=40, bands=[(2, 8), (10, 16)]))) == []


def test_column_polygons_map_back_into_source_detection() -> None:
    import server

    # 源图 300×60：两条竖列 x∈[10,26) 与 [34,50)。合并框盖住两列，
    # 列带四边形必须落回原图对应的竖条上。
    image = _vertical_bars_image(height=300, width=60, bands=[(10, 26), (34, 50)])
    merged_polygon = [[6.0, 4.0], [54.0, 4.0], [54.0, 296.0], [6.0, 296.0]]
    crop_result = server._deskew_crop_region(_png_bytes(image), merged_polygon, "split-test")
    assert crop_result is not None
    crop = server.runtime.decode_cv_image(crop_result["imageBytes"])
    bands = server.detect_column_bands(crop)
    assert len(bands) == 2
    polygons = server.column_detection_polygons(crop_result, bands)
    assert len(polygons) == 2
    for polygon in polygons:
        box = server.runtime._polygon_to_box(polygon)
        assert 6.0 - 2.5 <= box["left"] and box["left"] + box["width"] <= 54.0 + 2.5
        assert box["height"] >= 280
    left, right = sorted(polygons, key=lambda p: server.runtime._polygon_to_box(p)["left"])
    assert server.runtime._polygon_to_box(left)["left"] + server.runtime._polygon_to_box(left)["width"] <= 28.0
    assert server.runtime._polygon_to_box(right)["left"] >= 30.0
