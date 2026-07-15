from __future__ import annotations

from ..dependencies import runtime

def extract_items(raw_result: runtime.Any, filter_symbols: bool=True, min_score: float=0.0) -> list[dict[str, runtime.Any]]:
    rows: list[dict[str, runtime.Any]] = []
    for page in runtime.as_list(raw_result):
        mapping = runtime.result_to_mapping(page)
        if mapping:
            rows.extend(runtime.extract_mapping_items(mapping))
            continue
        rows.extend(runtime.extract_legacy_items(page))
    filtered = []
    for row in rows:
        if not row.get('text') or not row.get('box'):
            continue
        if float(row.get('score') or 0.0) < min_score:
            continue
        if filter_symbols and runtime.is_symbol_only_text(row.get('text')):
            continue
        filtered.append(row)
    return filtered

runtime.extract_items = extract_items

def result_to_mapping(value: runtime.Any) -> dict[str, runtime.Any] | None:
    if isinstance(value, dict):
        return value.get('res') if isinstance(value.get('res'), dict) else value
    json_value = getattr(value, 'json', None)
    if isinstance(json_value, dict):
        return json_value.get('res') if isinstance(json_value.get('res'), dict) else json_value
    if callable(json_value):
        try:
            data = json_value()
            if isinstance(data, dict):
                return data.get('res') if isinstance(data.get('res'), dict) else data
        except Exception:
            pass
    for attr in ('res', 'data'):
        data = getattr(value, attr, None)
        if isinstance(data, dict):
            return data
    return None

runtime.result_to_mapping = result_to_mapping

def extract_mapping_items(mapping: dict[str, runtime.Any]) -> list[dict[str, runtime.Any]]:
    data = mapping.get('res') if isinstance(mapping.get('res'), dict) else mapping
    raw_texts = runtime.first_present(data, 'rec_texts', 'texts', 'text')
    raw_scores = runtime.first_present(data, 'rec_scores', 'scores')
    raw_boxes = runtime.first_present(data, 'rec_boxes', 'rec_polys', 'dt_polys', 'boxes')
    texts = runtime.as_list([] if raw_texts is None else raw_texts)
    scores = runtime.as_list([] if raw_scores is None else raw_scores)
    boxes = runtime.as_list([] if raw_boxes is None else raw_boxes)
    rows: list[dict[str, runtime.Any]] = []
    for index, text in enumerate(texts):
        raw_box = boxes[index] if index < len(boxes) else None
        box = runtime.box_from_any(raw_box)
        if not box:
            continue
        row = {'text': str(text).strip(), 'box': box, 'score': float(scores[index]) if index < len(scores) and runtime.is_number(scores[index]) else 0.0}
        polygon = runtime.polygon_from_any(raw_box)
        if polygon:
            row['polygon'] = polygon
            row['rotation_deg'] = runtime.polygon_rotation_deg(polygon)
        rows.append(row)
    return rows

runtime.extract_mapping_items = extract_mapping_items

def polygon_from_any(value: runtime.Any) -> list[list[float]] | None:
    points: list[list[float]] = []
    for point in runtime.as_list(value):
        pair = runtime.to_plain(point)
        if isinstance(pair, (list, tuple)) and len(pair) >= 2 and runtime.is_number(pair[0]) and runtime.is_number(pair[1]):
            points.append([float(pair[0]), float(pair[1])])
    return points[:4] if len(points) >= 4 else None

runtime.polygon_from_any = polygon_from_any

def first_present(mapping: dict[str, runtime.Any], *keys: str) -> runtime.Any:
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None

runtime.first_present = first_present

def extract_legacy_items(value: runtime.Any) -> list[dict[str, runtime.Any]]:
    rows: list[dict[str, runtime.Any]] = []
    for item in runtime.as_list(value):
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        box = runtime.box_from_any(item[0])
        text = ''
        score = 0.0
        payload = item[1]
        if isinstance(payload, (list, tuple)) and payload:
            text = str(payload[0]).strip()
            if len(payload) > 1 and runtime.is_number(payload[1]):
                score = float(payload[1])
        else:
            text = str(payload).strip()
        if box and text:
            rows.append({'text': text, 'box': box, 'score': score})
    return rows

runtime.extract_legacy_items = extract_legacy_items

def box_from_any(value: runtime.Any) -> dict[str, float] | None:
    plain = runtime.to_plain(value)
    if isinstance(plain, dict):
        left = runtime.as_float(plain.get('left', plain.get('x')))
        top = runtime.as_float(plain.get('top', plain.get('y')))
        width = runtime.as_float(plain.get('width', plain.get('w')))
        height = runtime.as_float(plain.get('height', plain.get('h')))
        right = runtime.as_float(plain.get('right'))
        bottom = runtime.as_float(plain.get('bottom'))
        if right is None and left is not None and (width is not None):
            right = left + width
        if bottom is None and top is not None and (height is not None):
            bottom = top + height
        return runtime.build_box(left, top, right, bottom)
    if isinstance(plain, list) and len(plain) >= 4 and all((runtime.is_number(v) for v in plain[:4])):
        left, top, third, fourth = [float(v) for v in plain[:4]]
        right = third if third > left else left + max(1.0, third)
        bottom = fourth if fourth > top else top + max(1.0, fourth)
        return runtime.build_box(left, top, right, bottom)
    if isinstance(plain, list) and plain:
        points = []
        for point in plain:
            if isinstance(point, list) and len(point) >= 2 and runtime.is_number(point[0]) and runtime.is_number(point[1]):
                points.append((float(point[0]), float(point[1])))
            elif isinstance(point, dict) and runtime.is_number(point.get('x')) and runtime.is_number(point.get('y')):
                points.append((float(point['x']), float(point['y'])))
        if points:
            xs = [p[0] for p in points]
            ys = [p[1] for p in points]
            return runtime.build_box(min(xs), min(ys), max(xs), max(ys))
    return None

runtime.box_from_any = box_from_any

def build_box(left: float | None, top: float | None, right: float | None, bottom: float | None) -> dict[str, float] | None:
    if left is None or top is None or right is None or (bottom is None):
        return None
    if right <= left or bottom <= top:
        return None
    return {'left': left, 'top': top, 'width': right - left, 'height': bottom - top}

runtime.build_box = build_box
