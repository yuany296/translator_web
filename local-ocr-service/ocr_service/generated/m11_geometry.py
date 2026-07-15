from __future__ import annotations

from ..dependencies import runtime

def _order_polygon_points(pts: runtime.np.ndarray) -> runtime.np.ndarray:
    """将四点排列为左上、右上、右下、左下。"""
    points = runtime.np.asarray(pts, dtype=runtime.np.float32).reshape(-1, 2)
    center = points.mean(axis=0)
    angles = runtime.np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0])
    ordered = points[runtime.np.argsort(angles)]
    start = int(runtime.np.argmin(ordered.sum(axis=1)))
    ordered = runtime.np.roll(ordered, -start, axis=0)
    first_edge = ordered[1] - ordered[0]
    second_edge = ordered[2] - ordered[1]
    cross = float(first_edge[0] * second_edge[1] - first_edge[1] * second_edge[0])
    if cross < 0:
        ordered = ordered[[0, 3, 2, 1]]
    return ordered.astype(runtime.np.float32)

runtime._order_polygon_points = _order_polygon_points

def _deskew_crop_image(image_bytes: bytes, polygon: list[list[float]]) -> bytes | None:
    """使用 OpenCV 透视变换裁剪四边形，失败时返回 ``None``。"""
    result = runtime._deskew_crop_region(image_bytes, polygon, "compat-crop")
    return result["imageBytes"] if result else None

runtime._deskew_crop_image = _deskew_crop_image

def _deskew_crop_region(image_bytes: bytes, polygon: list[list[float]], region_id: str) -> dict[str, runtime.Any] | None:
    """返回透视 crop 与不可变的 source↔crop 几何契约。"""
    if not runtime.CV2_AVAILABLE:
        return None
    try:
        np_arr = runtime.np.frombuffer(image_bytes, runtime.np.uint8)
        image = runtime.cv2.imdecode(np_arr, runtime.cv2.IMREAD_COLOR)
        if image is None:
            return None
        source_pts = runtime._order_polygon_points(runtime.np.array(polygon, dtype=runtime.np.float32))
        pts = source_pts.copy()
        center = pts.mean(axis=0)
        edge = max(runtime.np.linalg.norm(pts[1] - pts[0]), runtime.np.linalg.norm(pts[3] - pts[0]))
        padding = min(12.0, max(2.0, float(edge) * 0.06))
        for index in range(4):
            vector = pts[index] - center
            length = max(1.0, float(runtime.np.linalg.norm(vector)))
            pts[index] += vector / length * padding
        pts[:, 0] = runtime.np.clip(pts[:, 0], 0, image.shape[1] - 1)
        pts[:, 1] = runtime.np.clip(pts[:, 1], 0, image.shape[0] - 1)
        width = max(1, int(round(max(runtime.np.linalg.norm(pts[1] - pts[0]), runtime.np.linalg.norm(pts[2] - pts[3])))))
        height = max(1, int(round(max(runtime.np.linalg.norm(pts[3] - pts[0]), runtime.np.linalg.norm(pts[2] - pts[1])))))
        source_thickness = float(min(
            (runtime.np.linalg.norm(source_pts[1] - source_pts[0]) + runtime.np.linalg.norm(source_pts[2] - source_pts[3])) / 2,
            (runtime.np.linalg.norm(source_pts[3] - source_pts[0]) + runtime.np.linalg.norm(source_pts[2] - source_pts[1])) / 2,
        ))
        dst = runtime.np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype=runtime.np.float32)
        matrix = runtime.cv2.getPerspectiveTransform(pts, dst)
        inverse = runtime.cv2.getPerspectiveTransform(dst, pts)
        warped = runtime.cv2.warpPerspective(image, matrix, (width, height), flags=runtime.cv2.INTER_CUBIC)
        _, buf = runtime.cv2.imencode('.png', warped)
        source_polygon = [[float(point[0]), float(point[1])] for point in source_pts]
        source_box = runtime._polygon_to_box(source_polygon)
        return {
            "imageBytes": buf.tobytes(),
            "detectedRegion": {
                "regionId": region_id,
                "sourcePolygon": [{"x": point[0], "y": point[1]} for point in source_polygon],
                "sourceBox": {"x": source_box["left"], "y": source_box["top"], "width": source_box["width"], "height": source_box["height"]},
                "rotationDeg": runtime.polygon_rotation_deg(source_polygon),
                "cropSize": {"width": width, "height": height},
                "sourceToCrop": [float(value) for value in matrix.reshape(-1)],
                "cropToSource": [float(value) for value in inverse.reshape(-1)],
                # crop 会为识别加 padding；字厚必须来自不可变的原检测多边形。
                "lineThickness": max(1.0, source_thickness),
                "geometryReliability": "detected",
            },
        }
    except Exception as exc:
        print(f'[slice-ocr] deskew_crop_image failed: {exc}', flush=True)
        return None

runtime._deskew_crop_region = _deskew_crop_region

def _polygon_to_box(polygon: list[list[float]]) -> dict[str, float]:
    """将四边形转换为兼容旧链路的轴对齐矩形。"""
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    left = min(xs)
    top = min(ys)
    return {'left': left, 'top': top, 'width': max(xs) - left, 'height': max(ys) - top}

runtime._polygon_to_box = _polygon_to_box

def detection_box_overlap(first: dict[str, runtime.Any], second: dict[str, runtime.Any]) -> tuple[float, float]:
    """返回检测框的 IoU 与较小框覆盖率，用于合并两轮检测结果。"""
    first_box = first.get('box') or {}
    second_box = second.get('box') or {}
    first_left = float(first_box.get('left') or 0.0)
    first_top = float(first_box.get('top') or 0.0)
    first_width = max(0.0, float(first_box.get('width') or 0.0))
    first_height = max(0.0, float(first_box.get('height') or 0.0))
    second_left = float(second_box.get('left') or 0.0)
    second_top = float(second_box.get('top') or 0.0)
    second_width = max(0.0, float(second_box.get('width') or 0.0))
    second_height = max(0.0, float(second_box.get('height') or 0.0))
    intersection_width = max(0.0, min(first_left + first_width, second_left + second_width) - max(first_left, second_left))
    intersection_height = max(0.0, min(first_top + first_height, second_top + second_height) - max(first_top, second_top))
    intersection = intersection_width * intersection_height
    first_area = first_width * first_height
    second_area = second_width * second_height
    union = first_area + second_area - intersection
    smaller_area = min(first_area, second_area)
    iou = intersection / union if union > 0 else 0.0
    smaller_coverage = intersection / smaller_area if smaller_area > 0 else 0.0
    return (iou, smaller_coverage)

runtime.detection_box_overlap = detection_box_overlap

def merge_detection_passes(primary: list[dict[str, runtime.Any]], recovery: list[dict[str, runtime.Any]]) -> tuple[list[dict[str, runtime.Any]], int]:
    """主检测优先；宽松检测只补充没有被主检测框覆盖的新区域。"""
    merged = list(primary)
    recovery_added = 0
    for candidate in recovery:
        duplicate = False
        for existing in merged:
            iou, smaller_coverage = runtime.detection_box_overlap(existing, candidate)
            if iou >= 0.45 or smaller_coverage >= 0.7:
                duplicate = True
                break
        if duplicate:
            continue
        merged.append(candidate)
        recovery_added += 1
    return (merged, recovery_added)

runtime.merge_detection_passes = merge_detection_passes

def _run_detection_only(image_bytes: bytes, lang: str, params: dict[str, float]) -> list[dict[str, runtime.Any]]:
    """使用 Paddle 独立检测模型返回原图四边形，不执行文字识别。"""
    client = runtime.get_text_detection_client(params)
    image = runtime.decode_cv_image(image_bytes)
    raw = client.predict(image, batch_size=1)
    items: list[dict[str, runtime.Any]] = []
    for page in runtime.as_list(raw):
        mapping = runtime.result_to_mapping(page) or {}
        raw_polygons = runtime.first_present(mapping, 'dt_polys', 'polys', 'boxes')
        raw_scores = runtime.first_present(mapping, 'dt_scores', 'scores')
        polygons = runtime.as_list([] if raw_polygons is None else raw_polygons)
        scores = runtime.as_list([] if raw_scores is None else raw_scores)
        for index, value in enumerate(polygons):
            polygon = runtime.normalize_detection_polygon(value, image.shape[1], image.shape[0])
            if not polygon:
                continue
            items.append({'polygon': polygon, 'box': runtime._polygon_to_box(polygon), 'det_score': float(scores[index]) if index < len(scores) and runtime.is_number(scores[index]) else 0.0, 'rotation_deg': runtime.polygon_rotation_deg(polygon)})
    return items

runtime._run_detection_only = _run_detection_only

def decode_cv_image(image_bytes: bytes) -> runtime.Any:
    image = runtime.cv2.imdecode(runtime.np.frombuffer(image_bytes, runtime.np.uint8), runtime.cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError('OpenCV cannot decode image')
    return image

runtime.decode_cv_image = decode_cv_image

def get_text_detection_client(params: dict[str, float]) -> runtime.Any:
    device = runtime.get_runtime_device()
    model_name = runtime.get_detection_model_name('auto')
    key = '|'.join([device, model_name, f"{params['text_det_thresh']:.4f}", f"{params['text_det_box_thresh']:.4f}", f"{params['text_det_unclip_ratio']:.4f}"])
    with runtime._ocr_client_lock:
        client = runtime._text_detection_clients.get(key)
        if client is None:
            client = runtime.TextDetection(model_name=model_name, device=device, thresh=params['text_det_thresh'], box_thresh=params['text_det_box_thresh'], unclip_ratio=params['text_det_unclip_ratio'], **{'enable_mkldnn': False, 'cpu_threads': 4} if device == 'cpu' else {})
            runtime._text_detection_clients[key] = client
        return client

runtime.get_text_detection_client = get_text_detection_client

def get_text_recognition_client(lang: str) -> runtime.Any:
    device = runtime.get_runtime_device()
    model_name = runtime.get_recognition_model_name(lang)
    key = '|'.join([device, model_name])
    with runtime._ocr_client_lock:
        client = runtime._text_recognition_clients.get(key)
        if client is None:
            client = runtime.TextRecognition(model_name=model_name, device=device, **{'enable_mkldnn': False, 'cpu_threads': 4} if device == 'cpu' else {})
            runtime._text_recognition_clients[key] = client
        return client

runtime.get_text_recognition_client = get_text_recognition_client

def normalize_detection_polygon(value: runtime.Any, image_width: int, image_height: int) -> list[list[float]] | None:
    points = runtime.polygon_from_any(value)
    if not points:
        return None
    pts = runtime.np.asarray(points, dtype=runtime.np.float32)
    if pts.shape[0] != 4:
        pts = runtime.cv2.boxPoints(runtime.cv2.minAreaRect(pts))
    if abs(float(runtime.cv2.contourArea(pts))) < 4:
        return None
    ordered = runtime._order_polygon_points(pts)
    ordered[:, 0] = runtime.np.clip(ordered[:, 0], 0, max(0, image_width - 1))
    ordered[:, 1] = runtime.np.clip(ordered[:, 1], 0, max(0, image_height - 1))
    return [[float(point[0]), float(point[1])] for point in ordered]

runtime.normalize_detection_polygon = normalize_detection_polygon

def polygon_rotation_deg(polygon: list[list[float]]) -> float:
    pts = runtime._order_polygon_points(runtime.np.asarray(polygon, dtype=runtime.np.float32))
    top_vector = pts[1] - pts[0]
    side_vector = pts[3] - pts[0]
    top_length = float(runtime.np.linalg.norm(top_vector))
    side_length = float(runtime.np.linalg.norm(side_vector))
    aspect_ratio = max(top_length, side_length) / max(1.0, min(top_length, side_length))
    vector = top_vector if aspect_ratio < runtime.VERTICAL_CROP_MIN_ASPECT_RATIO or top_length >= side_length else side_vector
    angle = runtime.math.degrees(runtime.math.atan2(float(vector[1]), float(vector[0])))
    while angle >= 90:
        angle -= 180
    while angle < -90:
        angle += 180
    return float(angle)

runtime.polygon_rotation_deg = polygon_rotation_deg

def is_confident_vertical_crop(width: int, height: int) -> bool:
    return height >= max(1, width) * runtime.VERTICAL_CROP_MIN_ASPECT_RATIO

runtime.is_confident_vertical_crop = is_confident_vertical_crop
