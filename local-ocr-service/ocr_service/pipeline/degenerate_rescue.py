"""
识别退化救援：识别结果退化成符号/无意义文本时，换该语言的**备用模型**对同一 crop 重试一次。

现场（Lezhin 韩漫）：气泡 `응?` 被 `korean_PP-OCRv5_mobile_rec` 读成 `"$?"`（0.785），
按符号噪声丢弃 → 气泡原文裸露、无译文；同页底部 `응` 读成 `"\"`（0.944）同样丢弃
（那一句最后是接缝链路在页边界复合图上重读才出现的）。韩文没有 server 版模型可用：
PP-OCRv5 通用识别模型（`PP-OCRv5_server_rec`）的字符表里只有 2 个 Hangul 字符，
所以只能换 v3 mobile —— 实测同一张图 `응?` v3 读出 `"응?"`（0.718），而
`안 추워요?` 是 v5 更准（0.941 vs 0.875），因此**只在退化时**才换模型。
"""
from __future__ import annotations

from ..dependencies import runtime


def alternate_recognition_model_name(lang: str) -> str:
    """该语言的备用识别模型名（没有可用备用的语言返回空串）。"""
    if lang == 'korean':
        return 'korean_PP-OCRv3_mobile_rec'
    return ''

runtime.alternate_recognition_model_name = alternate_recognition_model_name


def degenerate_rescue_enabled() -> bool:
    return runtime.env_bool('LOCAL_OCR_DEGENERATE_RESCUE', True)

runtime.degenerate_rescue_enabled = degenerate_rescue_enabled


def needs_degenerate_rescue(row: dict[str, runtime.Any], min_score: float) -> bool:
    """这条识别结果“没法用”吗？——与最终筛选**同一口径**（空 / 符号 / 低于识别下限）。"""
    text = str((row or {}).get('text') or '').strip()
    if not text or runtime.is_symbol_only_text(text):
        return True
    return float((row or {}).get('score') or 0.0) < float(min_score or 0.0)

runtime.needs_degenerate_rescue = needs_degenerate_rescue


def recognize_rows_with_alternate_model(rows: list[dict[str, runtime.Any]], lang: str) -> list[dict[str, runtime.Any]]:
    """用该语言的备用模型重跑这批 crop（输出与候选一一对应，不改变几何）。"""
    model_name = runtime.alternate_recognition_model_name(lang)
    if not model_name or not rows:
        return []
    client = runtime.get_alternate_text_recognition_client(model_name)
    images = [row['image'] for row in rows]
    with runtime.predict_guard('rec'):
        results = runtime.as_list(client.predict(images, batch_size=min(16, len(images))))
    output: list[dict[str, runtime.Any]] = []
    for index, result in enumerate(results[:len(rows)]):
        mapping = runtime.result_to_mapping(result) or {}
        text = runtime.scalar_result_value(mapping.get('rec_text'), '')
        score = runtime.scalar_result_value(mapping.get('rec_score'), 0.0)
        candidate = {key: value for key, value in rows[index].items() if key != 'image'}
        output.append({**candidate, 'text': str(text or '').strip(), 'score': float(score) if runtime.is_number(score) else 0.0, 'lang': lang, 'variant': 'degenerate_rescue'})
    return output

runtime.recognize_rows_with_alternate_model = recognize_rows_with_alternate_model


def select_degenerate_rescue(rescue_rows: list[dict[str, runtime.Any]], min_score: float) -> dict[str, runtime.Any] | None:
    """重试结果只有在「实打实该语言文字 + 过识别下限」时才够格替换原结果。"""
    candidates = [
        row for row in rescue_rows
        if isinstance(row, dict)
        and runtime.count_target_script_chars(str(row.get('text') or ''), str(row.get('lang') or '')) > 0
        and float(row.get('score') or 0.0) >= float(min_score or 0.0)
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda row: (float(row.get('score') or 0.0), runtime.count_target_script_chars(str(row.get('text') or ''), str(row.get('lang') or ''))))

runtime.select_degenerate_rescue = select_degenerate_rescue


def rescue_degenerate_recognitions(
    best_by_detection: dict[int, dict[str, runtime.Any]],
    candidate_rows: list[dict[str, runtime.Any]],
    recognized: list[dict[str, runtime.Any]],
    min_score: float,
) -> int:
    """识别退化成符号/无意义文本时，换该语言的备用模型对**同一 crop** 重试一次。

    只替换「重试结果是实打实该语言文字」的那些（见 select_degenerate_rescue），
    返回替换条数（进 counts.degenerate_rescued，供检视台观测）。
    """
    if not runtime.degenerate_rescue_enabled():
        return 0
    targets: dict[str, list[dict[str, runtime.Any]]] = {}
    for det_index, row in best_by_detection.items():
        if not runtime.needs_degenerate_rescue(row, min_score):
            continue
        language = str((row or {}).get('lang') or '')
        if not runtime.alternate_recognition_model_name(language):
            continue
        orientation = int((row or {}).get('orientation') or 0)
        source = next((
            candidate for candidate in candidate_rows
            if candidate['detection_index'] == det_index and int(candidate.get('orientation') or 0) == orientation
        ), None)
        if source is not None:
            targets.setdefault(language, []).append(source)
    if not targets:
        return 0
    rescued_count = 0
    with runtime.ocr_request_timings_scope('recognizeRescue'):
        for language, sources in targets.items():
            for source, rescue_row in zip(sources, runtime.recognize_rows_with_alternate_model(sources, language)):
                chosen = runtime.select_degenerate_rescue([rescue_row], min_score)
                if chosen is None:
                    continue
                best_by_detection[source['detection_index']] = chosen
                recognized.append(chosen)
                rescued_count += 1
    return rescued_count

runtime.rescue_degenerate_recognitions = rescue_degenerate_recognitions
