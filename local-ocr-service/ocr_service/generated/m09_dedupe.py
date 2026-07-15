from __future__ import annotations

from ..dependencies import runtime

def dedupe_items(items: list[dict[str, runtime.Any]]) -> list[dict[str, runtime.Any]]:
    kept: list[dict[str, runtime.Any]] = []
    for item in sorted(items, key=runtime.item_quality_score, reverse=True):
        box = item.get('box')
        if not box:
            continue
        duplicate_index = next((index for index, other in enumerate(kept) if runtime.are_duplicate_ocr_items(item, other)), None)
        if duplicate_index is None:
            kept.append(item)
            continue
        if runtime.should_replace_duplicate_item(item, kept[duplicate_index]):
            kept[duplicate_index] = item
    return kept

runtime.dedupe_items = dedupe_items

def are_duplicate_ocr_items(first: dict[str, runtime.Any], second: dict[str, runtime.Any]) -> bool:
    first_box = first.get('box')
    second_box = second.get('box')
    if not isinstance(first_box, dict) or not isinstance(second_box, dict):
        return False
    overlap = runtime.intersection_ratio(first_box, second_box)
    iou = runtime.box_iou(first_box, second_box)
    if overlap < 0.55 and iou < 0.42 and (not runtime.are_conflicting_ocr_reads(first, second)):
        return False
    first_text = runtime.normalize_text_for_similarity(first.get('text'))
    second_text = runtime.normalize_text_for_similarity(second.get('text'))
    if not first_text or not second_text:
        return overlap >= 0.88
    if first_text == second_text:
        return overlap >= 0.55
    shorter, longer = sorted((first_text, second_text), key=len)
    contains = len(shorter) >= 2 and shorter in longer
    similarity = runtime.normalized_text_similarity(first_text, second_text)
    return contains and overlap >= 0.62 or (similarity >= 0.82 and (overlap >= 0.6 or iou >= 0.45)) or runtime.are_conflicting_ocr_reads(first, second)

runtime.are_duplicate_ocr_items = are_duplicate_ocr_items

def are_conflicting_ocr_reads(first: dict[str, runtime.Any], second: dict[str, runtime.Any]) -> bool:
    """识别同一视觉行的互斥读法，交由质量排序保留更可信的一项。"""
    first_box = first.get('box')
    second_box = second.get('box')
    if not isinstance(first_box, dict) or not isinstance(second_box, dict):
        return False
    first_region = str(first.get('region_id') or '')
    second_region = str(second.get('region_id') or '')
    if first_region and second_region and (first_region != second_region):
        return False
    first_text = runtime.normalize_text_for_similarity(first.get('text'))
    second_text = runtime.normalize_text_for_similarity(second.get('text'))
    if min(len(first_text), len(second_text)) < 2:
        return False
    length_ratio = min(len(first_text), len(second_text)) / max(len(first_text), len(second_text))
    if length_ratio < 0.72:
        return False
    first_score = float(first.get('score') or 0.0)
    second_score = float(second.get('score') or 0.0)
    if abs(first_score - second_score) < 0.12:
        return False
    first_rotation = float(first.get('rotation_deg') or 0.0)
    second_rotation = float(second.get('rotation_deg') or 0.0)
    if abs(first_rotation - second_rotation) > 4.0:
        return False
    first_left = float(first_box.get('left') or 0.0)
    second_left = float(second_box.get('left') or 0.0)
    first_width = max(1.0, float(first_box.get('width') or 0.0))
    second_width = max(1.0, float(second_box.get('width') or 0.0))
    horizontal_overlap = max(0.0, min(first_left + first_width, second_left + second_width) - max(first_left, second_left)) / min(first_width, second_width)
    first_height = max(1.0, float(first_box.get('height') or 0.0))
    second_height = max(1.0, float(second_box.get('height') or 0.0))
    height_ratio = min(first_height, second_height) / max(first_height, second_height)
    first_center_y = float(first_box.get('top') or 0.0) + first_height / 2
    second_center_y = float(second_box.get('top') or 0.0) + second_height / 2
    center_y_distance = abs(first_center_y - second_center_y)
    return runtime.intersection_ratio(first_box, second_box) >= 0.5 and horizontal_overlap >= 0.85 and (height_ratio >= 0.65) and (center_y_distance <= (first_height + second_height) / 2 * 0.85)

runtime.are_conflicting_ocr_reads = are_conflicting_ocr_reads

def normalize_text_for_similarity(value: runtime.Any) -> str:
    normalized = runtime.unicodedata.normalize('NFKC', str(value or '')).casefold()
    return ''.join((ch for ch in normalized if ch.isalnum()))

runtime.normalize_text_for_similarity = normalize_text_for_similarity

def normalized_text_similarity(first: str, second: str) -> float:
    if first == second:
        return 1.0
    if not first or not second:
        return 0.0
    previous = list(range(len(second) + 1))
    for first_index, first_char in enumerate(first, start=1):
        current = [first_index]
        for second_index, second_char in enumerate(second, start=1):
            current.append(min(current[-1] + 1, previous[second_index] + 1, previous[second_index - 1] + (first_char != second_char)))
        previous = current
    return 1.0 - previous[-1] / max(len(first), len(second))

runtime.normalized_text_similarity = normalized_text_similarity

def box_iou(a: dict[str, float] | None, b: dict[str, float] | None) -> float:
    if not a or not b:
        return 0.0
    ax2 = float(a.get('left') or 0.0) + float(a.get('width') or 0.0)
    ay2 = float(a.get('top') or 0.0) + float(a.get('height') or 0.0)
    bx2 = float(b.get('left') or 0.0) + float(b.get('width') or 0.0)
    by2 = float(b.get('top') or 0.0) + float(b.get('height') or 0.0)
    inter_w = max(0.0, min(ax2, bx2) - max(float(a.get('left') or 0.0), float(b.get('left') or 0.0)))
    inter_h = max(0.0, min(ay2, by2) - max(float(a.get('top') or 0.0), float(b.get('top') or 0.0)))
    intersection = inter_w * inter_h
    union = runtime.box_area(a) + runtime.box_area(b) - intersection
    return intersection / max(1.0, union)

runtime.box_iou = box_iou

def item_quality_score(item: dict[str, runtime.Any]) -> float:
    text_length = len(runtime.normalize_text_for_similarity(item.get('text')))
    score = float(item.get('score') or 0.0)
    variant_support = float(item.get('variantSupport') or 0.0)
    enhanced_support = float(item.get('enhancedVariantSupport') or 0.0)
    return text_length * 0.08 + score + variant_support * 0.12 + enhanced_support * 0.06

runtime.item_quality_score = item_quality_score

def annotate_variant_support(items: list[dict[str, runtime.Any]]) -> None:
    for item in items:
        box = item.get('box')
        if not isinstance(box, dict):
            item['variantSupport'] = 0
            item['enhancedVariantSupport'] = 0
            continue
        variants: set[str] = set()
        enhanced_variants: set[str] = set()
        for other in items:
            other_box = other.get('box')
            if not isinstance(other_box, dict) or runtime.intersection_ratio(box, other_box) < 0.65:
                continue
            if not runtime.are_supporting_texts(item.get('text'), other.get('text')):
                continue
            variant = str(other.get('variant') or 'unknown')
            variants.add(variant)
            if variant != 'original':
                enhanced_variants.add(variant)
        item['variantSupport'] = len(variants)
        item['enhancedVariantSupport'] = len(enhanced_variants)

runtime.annotate_variant_support = annotate_variant_support

def are_supporting_texts(first: runtime.Any, second: runtime.Any) -> bool:
    first_text = runtime.compact_text(first)
    second_text = runtime.compact_text(second)
    if not first_text or not second_text:
        return False
    if first_text == second_text:
        return True
    shorter, longer = sorted((first_text, second_text), key=len)
    return len(shorter) >= 2 and shorter in longer

runtime.are_supporting_texts = are_supporting_texts

def reconstruct_enhanced_items(items: list[dict[str, runtime.Any]]) -> list[dict[str, runtime.Any]]:
    originals = [item for item in items if item.get('variant') == 'original']
    enhanced = [item for item in items if item.get('variant') != 'original']
    if not originals or not enhanced:
        return runtime.dedupe_items(items)
    rebuilt: list[dict[str, runtime.Any]] = []
    for original in originals:
        replacement = runtime.build_enhanced_replacement(original, enhanced)
        rebuilt.append(replacement or original)
    return runtime.dedupe_items(rebuilt + enhanced)

runtime.reconstruct_enhanced_items = reconstruct_enhanced_items

def apply_korean_contextual_corrections(items: list[dict[str, runtime.Any]]) -> list[dict[str, runtime.Any]]:
    corrected: list[dict[str, runtime.Any]] = []
    for item in items:
        replacement = runtime.correct_low_confidence_korean_text(item, items)
        corrected.append(replacement or item)
    return corrected

runtime.apply_korean_contextual_corrections = apply_korean_contextual_corrections

def correct_low_confidence_korean_text(item: dict[str, runtime.Any], items: list[dict[str, runtime.Any]]) -> dict[str, runtime.Any] | None:
    text = runtime.compact_text(item.get('text'))
    score = float(item.get('score') or 0.0)
    if score > 0.75:
        return None
    corrections = {'무래': '대리님.', '뮤래': '대리님.', '무그': '대리님.', '미래': '대리님.', '뭐래': '대리님.'}
    corrected_text = corrections.get(text)
    if not corrected_text:
        return None
    if not runtime.has_nearby_korean_context(item, items, {'은하제'}):
        return None
    replacement = dict(item)
    replacement['text'] = corrected_text
    replacement['ocrOriginalText'] = item.get('text', '')
    replacement['ocrCorrection'] = 'low_confidence_korean_title'
    return replacement

runtime.correct_low_confidence_korean_text = correct_low_confidence_korean_text

def has_nearby_korean_context(item: dict[str, runtime.Any], items: list[dict[str, runtime.Any]], triggers: set[str]) -> bool:
    box = item.get('box')
    if not isinstance(box, dict):
        return False
    for other in items:
        if other is item:
            continue
        other_box = other.get('box')
        if not isinstance(other_box, dict):
            continue
        other_text = runtime.compact_text(other.get('text'))
        if not any((trigger in other_text for trigger in triggers)):
            continue
        if runtime.are_boxes_near_same_line(box, other_box):
            return True
    return False

runtime.has_nearby_korean_context = has_nearby_korean_context

def are_boxes_near_same_line(a: dict[str, float], b: dict[str, float]) -> bool:
    ax1 = float(a.get('left') or 0.0)
    ay1 = float(a.get('top') or 0.0)
    aw = float(a.get('width') or 0.0)
    ah = float(a.get('height') or 0.0)
    bx1 = float(b.get('left') or 0.0)
    by1 = float(b.get('top') or 0.0)
    bw = float(b.get('width') or 0.0)
    bh = float(b.get('height') or 0.0)
    if aw <= 0 or ah <= 0 or bw <= 0 or (bh <= 0):
        return False
    if runtime.vertical_overlap_ratio(a, b) >= 0.45:
        return abs(ax1 + aw / 2.0 - (bx1 + bw / 2.0)) <= max(aw, bw) * 2.5
    return abs(ay1 + ah / 2.0 - (by1 + bh / 2.0)) <= max(ah, bh) * 0.45

runtime.are_boxes_near_same_line = are_boxes_near_same_line

def build_enhanced_replacement(original: dict[str, runtime.Any], enhanced: list[dict[str, runtime.Any]]) -> dict[str, runtime.Any] | None:
    original_score = float(original.get('score') or 0.0)
    original_text = str(original.get('text') or '')
    original_box = original.get('box')
    if original_score >= 0.65 or not isinstance(original_box, dict):
        return None
    fragments = []
    for item in enhanced:
        text = str(item.get('text') or '').strip()
        box = item.get('box')
        score = float(item.get('score') or 0.0)
        if score < 0.75 or not text or (not isinstance(box, dict)):
            continue
        if not runtime.is_box_center_inside(box, original_box):
            continue
        if runtime.vertical_overlap_ratio(box, original_box) < 0.45:
            continue
        fragments.append(item)
    if not fragments:
        return None
    fragments = runtime.dedupe_items(fragments)
    fragments.sort(key=lambda row: (float((row.get('box') or {}).get('left') or 0.0), float((row.get('box') or {}).get('top') or 0.0)))
    combined_text = runtime.join_line_fragments(fragments)
    if runtime.count_hangul(combined_text) <= runtime.count_hangul(original_text) + 2:
        return None
    replacement = dict(original)
    replacement['text'] = combined_text
    replacement['score'] = sum((float(item.get('score') or 0.0) for item in fragments)) / len(fragments)
    replacement['variant'] = 'enhanced_reconstructed'
    replacement['debugFragments'] = [{'text': item.get('text', ''), 'score': float(item.get('score') or 0.0), 'variant': item.get('variant', ''), 'box': item.get('box')} for item in fragments]
    return replacement

runtime.build_enhanced_replacement = build_enhanced_replacement

def join_line_fragments(fragments: list[dict[str, runtime.Any]]) -> str:
    parts: list[str] = []
    for item in fragments:
        text = str(item.get('text') or '').strip()
        if not text:
            continue
        parts.append(text)
    return runtime.clean_reconstructed_text(' '.join(parts))

runtime.join_line_fragments = join_line_fragments

def clean_reconstructed_text(text: str) -> str:
    cleaned = ' '.join(str(text or '').split())
    cleaned = cleaned.replace(': ㅏㅋㅋ', 'ㅋㅋ')
    cleaned = cleaned.replace(':ㅏㅋㅋ', 'ㅋㅋ')
    cleaned = cleaned.replace('ㅏㅋㅋ', 'ㅋㅋ')
    return cleaned.strip()

runtime.clean_reconstructed_text = clean_reconstructed_text

def is_box_center_inside(inner: dict[str, float], outer: dict[str, float]) -> bool:
    center_x = float(inner.get('left') or 0.0) + float(inner.get('width') or 0.0) / 2.0
    center_y = float(inner.get('top') or 0.0) + float(inner.get('height') or 0.0) / 2.0
    left = float(outer.get('left') or 0.0)
    top = float(outer.get('top') or 0.0)
    return left <= center_x <= left + float(outer.get('width') or 0.0) and top <= center_y <= top + float(outer.get('height') or 0.0)

runtime.is_box_center_inside = is_box_center_inside

def vertical_overlap_ratio(a: dict[str, float], b: dict[str, float]) -> float:
    ay1 = float(a.get('top') or 0.0)
    ay2 = ay1 + float(a.get('height') or 0.0)
    by1 = float(b.get('top') or 0.0)
    by2 = by1 + float(b.get('height') or 0.0)
    overlap = max(0.0, min(ay2, by2) - max(ay1, by1))
    return overlap / max(1.0, min(ay2 - ay1, by2 - by1))

runtime.vertical_overlap_ratio = vertical_overlap_ratio

def should_replace_duplicate_item(candidate: dict[str, runtime.Any], existing: dict[str, runtime.Any]) -> bool:
    candidate_text = runtime.normalize_text_for_similarity(candidate.get('text'))
    existing_text = runtime.normalize_text_for_similarity(existing.get('text'))
    if not candidate_text:
        return False
    if not existing_text:
        return True
    candidate_len = len(candidate_text)
    existing_len = len(existing_text)
    candidate_score = float(candidate.get('score') or 0.0)
    existing_score = float(existing.get('score') or 0.0)
    if candidate_text == existing_text:
        return candidate_score > existing_score
    if candidate_len >= existing_len + 3 and runtime.box_area(candidate.get('box')) >= runtime.box_area(existing.get('box')) * 1.2:
        return True
    if existing_text in candidate_text and candidate_len > existing_len:
        return True
    return runtime.item_quality_score(candidate) > runtime.item_quality_score(existing)

runtime.should_replace_duplicate_item = should_replace_duplicate_item
