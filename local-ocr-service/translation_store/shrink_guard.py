"""自动译文「明显变短」护栏。

起因：漫画翻译一度走到供应商流式分支，返回被截尾的译文，并**覆盖**了官方译文库里
本来就完整的版本（实测 `'좋아, 바로'`：`好,马上` → `好,`；整句 → `游乐设施`）。
这是内容质量回归，不该由用户发现。这里在写入之前拦一道：自动（api）译文明显短于
同一记录的当前启用版本时，只把它记进历史，不设为启用版本。

还有第二道：**首次**写入没有旧值可比（37 字符原句回 4 个字），必须按「长得离谱的
原文只回了几个字」单独拦一次，否则截尾值会成为启用版本，之后所有基于旧值的比较
都失效。

只拦「自动 + 明显更短/明显不成比例」：手动版本永远优先，更短的手动/置顶结果不受影响。
用 `TRANSLATION_SHRINK_GUARD=0` 可以整体关闭。
"""

from __future__ import annotations

import os
from typing import Any

MIN_SOURCE_CHARS = 4
MIN_PREVIOUS_CHARS = 4
SHRINK_RATIO = 0.6
# 「原文长、译文只有几个字」判据：绝对上限 6 个字，避免把长原文的合理短译
# （「嗯」「好。」）判成可疑。
MIN_SOURCE_FOR_LENGTH_CHECK = 12
SOURCE_LENGTH_RATIO = 0.15
IMPLAUSIBLE_MAX_CHARS = 6


def guard_enabled() -> bool:
    return str(os.environ.get("TRANSLATION_SHRINK_GUARD", "1")).strip().lower() not in {"0", "false", "no", "off"}


def text(value: Any, limit: int = 100_000) -> str:
    return str(value or "")[:limit]


def is_implausibly_short(candidate: Any, source: Any) -> bool:
    """原文够长、译文却只有几个字：典型截尾形状。"""
    candidate_text = text(candidate).strip()
    source_text = text(source).strip()
    if not candidate_text or not source_text:
        return False
    if len(source_text) < MIN_SOURCE_FOR_LENGTH_CHECK:
        return False
    threshold = min(IMPLAUSIBLE_MAX_CHARS, max(2, int(len(source_text) * SOURCE_LENGTH_RATIO)))
    return len(candidate_text) <= threshold


def should_keep_existing_active(connection: Any, record: Any, candidate_source: str, payload: dict[str, Any]) -> tuple[bool, str]:
    """返回 (是否保留旧版本/不启用候选, 原因)。"""
    if not guard_enabled():
        return False, "guard disabled"
    if text(candidate_source, 32) == "manual" or payload.get("pinned") is True:
        return False, "manual or pinned"
    candidate = text(payload.get("translatedText"))
    source_text = text(payload.get("rawSourceText")) or text(record["raw_source_text"])
    existing_id = text(record["active_version_id"], 80)
    if not existing_id:
        if is_implausibly_short(candidate, source_text):
            return True, f"candidate {len(candidate.strip())} chars vs source {len(source_text.strip())} chars (no previous version)"
        return False, "no existing active version"
    existing = connection.execute(
        "SELECT translated_text, source FROM translation_versions WHERE id=?", (existing_id,)
    ).fetchone()
    if existing is None:
        if is_implausibly_short(candidate, source_text):
            return True, f"candidate {len(candidate.strip())} chars vs source {len(source_text.strip())} chars (existing version missing)"
        return False, "existing version missing"
    if text(existing["source"], 32) == "manual":
        return False, "existing is manual"
    previous = text(existing["translated_text"])
    if len(source_text) < MIN_SOURCE_CHARS or len(previous) < MIN_PREVIOUS_CHARS:
        return False, "too short to judge"
    if len(candidate) >= len(previous) * SHRINK_RATIO:
        return False, "not a shrink"
    return True, f"candidate {len(candidate)} chars vs previous {len(previous)} chars"
