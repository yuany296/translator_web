from __future__ import annotations

from ..dependencies import runtime

def compact_text(value: runtime.Any) -> str:
    return ''.join(str(value or '').split())

runtime.compact_text = compact_text

def count_hangul(text: str) -> int:
    return sum((1 for ch in str(text or '') if '가' <= ch <= '\ud7af'))

runtime.count_hangul = count_hangul

def is_symbol_only_text(text: runtime.Any) -> bool:
    raw = str(text or '').strip()
    if not raw:
        return True
    return not any((ch.isalnum() or '一' <= ch <= '鿿' or '\u3040' <= ch <= 'ヿ' or ('가' <= ch <= '\ud7af') for ch in raw))

runtime.is_symbol_only_text = is_symbol_only_text

def box_area(box: dict[str, float] | None) -> float:
    if not box:
        return 0.0
    return max(0.0, float(box.get('width') or 0.0)) * max(0.0, float(box.get('height') or 0.0))

runtime.box_area = box_area

def intersection_ratio(a: dict[str, float] | None, b: dict[str, float] | None) -> float:
    if not a or not b:
        return 0.0
    ax1, ay1 = (a['left'], a['top'])
    ax2, ay2 = (ax1 + a['width'], ay1 + a['height'])
    bx1, by1 = (b['left'], b['top'])
    bx2, by2 = (bx1 + b['width'], by1 + b['height'])
    inter_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    if inter_w <= 0 or inter_h <= 0:
        return 0.0
    min_area = max(1.0, min(a['width'] * a['height'], b['width'] * b['height']))
    return inter_w * inter_h / min_area

runtime.intersection_ratio = intersection_ratio

def sort_items(items: list[dict[str, runtime.Any]]) -> list[dict[str, runtime.Any]]:
    return sorted(items, key=lambda item: (item['box']['top'], item['box']['left']))

runtime.sort_items = sort_items

def as_list(value: runtime.Any) -> list[runtime.Any]:
    if value is None:
        return []
    plain = runtime.to_plain(value)
    if isinstance(plain, list):
        return plain
    if isinstance(plain, tuple):
        return list(plain)
    return [plain]

runtime.as_list = as_list

def to_plain(value: runtime.Any) -> runtime.Any:
    if hasattr(value, 'tolist'):
        return value.tolist()
    return value

runtime.to_plain = to_plain

def as_float(value: runtime.Any) -> float | None:
    return float(value) if runtime.is_number(value) else None

runtime.as_float = as_float

def is_number(value: runtime.Any) -> bool:
    try:
        float(value)
    except (TypeError, ValueError):
        return False
    return True

runtime.is_number = is_number
