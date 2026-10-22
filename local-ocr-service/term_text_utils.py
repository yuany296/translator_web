"""术语提取共用的文本规范化与「原文里有没有这个词」判定。

LLM 路径（term_extractor.py）与 NER worker（ner_worker.py）共用这一份，
避免两边对同一条原文给出不同的判断。
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

MAX_SOURCE_LENGTH = 120
MODEL_PLACEHOLDER_RE = re.compile(r"[\[（(【<]\s*image\s*#?\s*\d+\s*[\]）)】>]", re.IGNORECASE)
KOREAN_JOSA_RE = re.compile(r"[은는이가을를의에와]$")


def normalize_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = MODEL_PLACEHOLDER_RE.sub(" ", text)
    return re.sub(r"[ \t]+", " ", text.replace("\r", "\n")).strip()


def normalize_candidate(value: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or ""))).strip(" \t\r\n.,!?;:，。！？；：()（）[]【】\"'“”‘’")


def contains_hangul(value: str) -> bool:
    return bool(re.search(r"[가-힣]", value))


def in_source_text(text: str, term: str) -> bool:
    """term 是否逐字出现在原文中；忽略空白差异并容忍一个结尾韩语助词。"""
    haystack = re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(text or ""))).casefold()
    needle = re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(term or ""))).casefold()
    if not needle or not haystack:
        return False
    if needle in haystack:
        return True
    stripped = KOREAN_JOSA_RE.sub("", needle)
    return len(stripped) >= 2 and stripped in haystack
