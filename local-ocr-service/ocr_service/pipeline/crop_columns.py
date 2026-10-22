from __future__ import annotations

from ..dependencies import runtime

def column_split_enabled() -> bool:
    """列拆分总开关（LOCAL_OCR_COLUMN_SPLIT=off/0/false 关闭）。"""
    return str(runtime.os.environ.get("LOCAL_OCR_COLUMN_SPLIT", "on")).strip().lower() not in {"off", "0", "false"}

runtime.column_split_enabled = column_split_enabled

def detect_column_bands(
    crop: runtime.Any,
    min_band_width: int = 4,
    max_bands: int = 3,
) -> list[tuple[int, int]]:
    """竖排 crop 的列带检测：返回按 x 升序的 (x0, x1)（crop 像素坐标）。

    只在「清晰的多列」时返回 ≥2 段：列与列之间必须有贯穿整列高度的干净空隙
    （该 x 上的墨水投影 < 高度的 2%）。实测列缝窄到 1px 也真实存在（ルビ紧贴
    正文、邻列出血），所以 1px 通道即算列界、不做跨空隙合并；单列的假名间隙在
    y 方向、不会在 x 投影上断开，正常单列返回 []。碎带（< min_band_width，
    裁剪边缘的出血/噪点）直接丢弃。
    """
    if not runtime.CV2_AVAILABLE or crop is None or getattr(crop, "ndim", 0) not in (2, 3):
        return []
    height, width = crop.shape[:2]
    if height < 40 or width < 12:
        return []
    gray = runtime.cv2.cvtColor(crop, runtime.cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    binary = runtime.cv2.threshold(
        gray,
        0,
        255,
        runtime.cv2.THRESH_BINARY_INV + runtime.cv2.THRESH_OTSU,
    )[1]
    ink_per_x = binary.sum(axis=0) / 255.0
    gutter_floor = max(1.0, height * 0.02)
    has_ink = ink_per_x >= gutter_floor
    spans: list[tuple[int, int]] = []
    start: int | None = None
    for x in range(width):
        if has_ink[x] and start is None:
            start = x
        elif not has_ink[x] and start is not None:
            spans.append((start, x))
            start = None
    if start is not None:
        spans.append((start, width))
    spans = [span for span in spans if span[1] - span[0] >= min_band_width]
    if not 2 <= len(spans) <= max_bands:
        return []
    return spans

runtime.detect_column_bands = detect_column_bands

# 参与拆分判定的碎带下限是 min_band_width（4px）；但为碎带**创建检测**用更高的下限：
# 4~7px 的带几乎都是邻列出血/ルビ碎片，识别只会产出垃圾条目（真ルビ列 8~11px 不受影响，
# 拆分本身已经把它们从主列里摘掉）。全部碎带都不足 8px 时不拆（回退整列识别）。
COLUMN_DET_MIN_WIDTH = 8

runtime.COLUMN_DET_MIN_WIDTH = COLUMN_DET_MIN_WIDTH

def det_worthy_column_bands(bands: list[tuple[int, int]]) -> list[tuple[int, int]]:
    return [band for band in bands if band[1] - band[0] >= COLUMN_DET_MIN_WIDTH]

runtime.det_worthy_column_bands = det_worthy_column_bands

def column_detection_polygons(crop_result: dict[str, runtime.Any], bands: list[tuple[int, int]]) -> list[list[list[float]]]:
    """把 crop 坐标里的列带映射回原图四边形（走 deskew 契约的 cropToSource）。"""
    height = float((crop_result['detectedRegion'].get('cropSize') or {}).get('height') or 0)
    if height <= 0:
        return []
    matrix = runtime.np.array(crop_result['detectedRegion']['cropToSource'], dtype=runtime.np.float64).reshape(3, 3)
    polygons: list[list[list[float]]] = []
    for x0, x1 in bands:
        corners = runtime.np.array(
            [[float(x0), 0.0], [float(x1), 0.0], [float(x1), height], [float(x0), height]],
            dtype=runtime.np.float32,
        )
        ones = runtime.np.hstack([corners, runtime.np.ones((4, 1), dtype=runtime.np.float32)])
        mapped = (matrix @ ones.T).T
        mapped = mapped[:, :2] / mapped[:, 2:3]
        polygons.append([[float(point[0]), float(point[1])] for point in runtime._order_polygon_points(mapped)])
    return polygons

runtime.column_detection_polygons = column_detection_polygons
