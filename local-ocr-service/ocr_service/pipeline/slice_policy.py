from __future__ import annotations

from ..dependencies import runtime

# 「可选遍数」的开关策略：默认保持既有召回，只有显式打开时才用时间换召回。
# 这些开关都会改变识别结果，所以默认值等于改造前的行为，翻默认值前必须过 fixtures 对照。


def should_run_recovery_detection(primary_detections: list[dict[str, runtime.Any]]) -> bool:
    """宽松（recovery）检测是否要跑。

    默认 always：主检测 + 宽松检测两遍，召回优先。
    LOCAL_OCR_RECOVERY_DETECT=on-demand 时，主检测已找到不少于
    LOCAL_OCR_RECOVERY_MIN_PRIMARY（默认 8）个文本框的页面跳过第二遍。
    """
    mode = str(runtime.os.environ.get('LOCAL_OCR_RECOVERY_DETECT', 'always') or '').strip().lower()
    if mode != 'on-demand':
        return True
    threshold = max(1, int(runtime.env_float('LOCAL_OCR_RECOVERY_MIN_PRIMARY', 8)))
    return len(primary_detections or []) < threshold


def second_language_on_demand() -> bool:
    """lang=auto 时是否只补跑可疑 crop 的第二语言。

    默认关闭（LOCAL_OCR_AUTO_LANG_SECOND_PASS 缺省视为 1）：auto 会对每个 crop 跑
    japan + korean 两遍识别，识别耗时翻倍。
    """
    raw = runtime.os.environ.get('LOCAL_OCR_AUTO_LANG_SECOND_PASS')
    if raw is None:
        return False
    return str(raw).strip().lower() in {'0', 'false', 'no', 'off', ''}


def weak_detection_indexes(recognized: list[dict[str, runtime.Any]], primary_language: str) -> set:
    """第一语言识别得可疑的 detection（低分或该语言字符数为 0）。"""
    weak = set()
    for row in recognized or []:
        if not isinstance(row, dict) or str(row.get('lang') or '') != str(primary_language):
            continue
        index = row.get('detection_index')
        if index is None:
            continue
        text = str(row.get('text') or '')
        if float(row.get('score') or 0.0) < 0.72 or runtime.count_target_script_chars(text, primary_language) == 0:
            weak.add(index)
    return weak


def select_rows_needing_second_language(
    recognized: list[dict[str, runtime.Any]],
    candidate_rows: list[dict[str, runtime.Any]],
    primary_language: str,
) -> list[dict[str, runtime.Any]]:
    """挑出需要补跑第二语言的 crop。

    页面里大部分 detection 都弱，说明主语言选错了：这时整页补跑第二语言，
    避免只补几行、其余行留成乱码。只有少量弱框时，才只补这些框。
    """
    total = len({row.get('detection_index') for row in candidate_rows if isinstance(row, dict)})
    weak = weak_detection_indexes(recognized, primary_language)
    if total <= 0 or not weak:
        return []
    if len(weak) / total >= runtime.env_float('LOCAL_OCR_AUTO_LANG_FULL_PAGE_RATIO', 0.4):
        return list(candidate_rows)
    return [row for row in candidate_rows if isinstance(row, dict) and row.get('detection_index') in weak]


runtime.should_run_recovery_detection = should_run_recovery_detection
runtime.second_language_on_demand = second_language_on_demand
runtime.weak_detection_indexes = weak_detection_indexes
runtime.select_rows_needing_second_language = select_rows_needing_second_language
