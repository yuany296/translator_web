"""零依赖的启发式术语提取（没有配置 LLM 时的兜底通道）。

高置信度通道（韩文姓氏+名字、连续片假名、拉丁大写短语、书名号）直接进候选，
只在多处重复出现的短语标成 sentenceOnly（0.35 分）留在「句子级」候选里。

与 LLM 路径共用 term_text_utils.py 的规范化与包含判定；LLM 路径在 term_extractor.py。
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

from term_text_utils import MAX_SOURCE_LENGTH, normalize_candidate, normalize_text
SENTENCE_ONLY_SCORE = 0.35
COMMON_KOREAN_SURNAMES = set(
    "김이박최정강조윤장임한오서신권황안송전홍유고문양손배백허남심노하곽성차주우구민진지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예봉사부가복"
)
COMPOUND_KOREAN_SURNAMES = {"남궁", "독고", "동방", "망절", "사공", "서문", "선우", "제갈", "황보"}
LATIN_STOP_TERMS = {"AD", "CEO", "CFO", "CTO", "DJ", "DR", "ETC", "MR", "MRS", "NO", "OK", "PD", "SNS", "TV", "VS", "YES"}
LATIN_PHRASE_RE = re.compile(r"(?<![A-Za-z0-9])(?:[A-Z][A-Z0-9&'.-]*)(?:[ \t]+[A-Z][A-Z0-9&'.-]*){0,4}(?![A-Za-z0-9])")
KOREAN_PARTICLES = ("이", "가", "은", "는", "을", "를", "의", "에", "에서", "에게", "한테", "께", "으로", "로", "와", "과", "도", "만", "부터", "까지", "마다", "보다", "처럼", "이나", "나", "이라도", "라도", "밖에", "조차", "마저", "커녕", "이고", "이며", "이랑", "랑", "이라고", "라고", "이면", "면", "이다", "이었다", "였다", "이야", "야", "아")
KATAKANA_SEQ_RE = re.compile(r"(?<![ァ-ヺー])([ァ-ヺー]{2,6})(?![ァ-ヺー])")
BRACKETED_RE = re.compile(r"[【『][^【】『』\n]{2,40}[】』]")
CJK_REPEAT_RE = re.compile(r"[가-힣ぁ-ゖァ-ヺ一-鿿]+")
LATIN_WORD_RE = re.compile(r"[A-Za-z]{4,}")


def extract_candidate_sentences(blocks: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Zero-dependency fallback: high-confidence channels pre-fill terms, repeated phrases stay sentence-only."""
    prepared = [
        {"id": str(block.get("id") or "").strip(), "text": normalize_text(block.get("text"))}
        for block in blocks
        if str(block.get("id") or "").strip() and normalize_text(block.get("text"))
    ]
    if not prepared:
        return []
    merged: dict[str, dict[str, Any]] = {}
    phrase_counts = _repeated_phrase_counts(prepared)

    def add(source: str, kind: str, score: float, evidence_id: str, sentence_only: bool = False) -> None:
        if not source or len(source) > MAX_SOURCE_LENGTH:
            return
        key = source.casefold()
        current = merged.get(key)
        if current is None:
            current = {"source": source, "kind": kind, "score": score, "note": "", "suggestedTarget": "",
                       "evidenceIds": [], "sentenceOnly": sentence_only}
            merged[key] = current
        if evidence_id and evidence_id not in current["evidenceIds"]:
            current["evidenceIds"].append(evidence_id)
        if not current["sentenceOnly"] and sentence_only:
            current["sentenceOnly"] = True
        current["score"] = max(current["score"], score)

    for block in prepared:
        text = block["text"]
        evidence_id = block["id"]
        for word in _scan_korean_names(text):
            add(word, "person", 0.94, evidence_id)
        for match in KATAKANA_SEQ_RE.finditer(text):
            # 连续片假名通常是日语人名或外来专名。
            add(match.group(1), "latin_name", 0.82, evidence_id)
        for match in LATIN_PHRASE_RE.finditer(text):
            source = normalize_candidate(match.group(0))
            words = source.split()
            if not words:
                continue
            if len(words) == 1:
                word = words[0].upper()
                if len(word) < 3 or word in LATIN_STOP_TERMS:
                    continue
                add(source, "latin_name", 0.82, evidence_id)
            else:
                if all(word.upper() in LATIN_STOP_TERMS or word.upper() == "THE" for word in words):
                    continue
                add(source, "latin_title", 0.9, evidence_id)
        for match in BRACKETED_RE.finditer(text):
            add(normalize_candidate(match.group(0)[1:-1]), "title", 0.86, evidence_id)
    for phrase in phrase_counts:
        if phrase.casefold() in merged:
            continue
        # 丢弃被更长候选完整包含的碎片短语（如 "하이파이" ⊂ "하이파이브"）。
        if any(phrase in other["source"].replace(" ", "") and len(other["source"]) > len(phrase) for other in merged.values()):
            continue
        matching = [
            block["id"] for block in prepared
            if phrase in re.sub(r"\s+", "", block["text"])
        ]
        add(phrase, "proper_noun", SENTENCE_ONLY_SCORE, "", sentence_only=True)
        merged[phrase.casefold()]["evidenceIds"] = matching
    # 外来词截断抑制：人名被非人名候选完整包含则丢弃（如 "하이파" ⊂ "하이파이브"）；
    # 人名简称（"성현" ⊂ "김성현"）不受影响，彼此时 kind 都是 person。
    for key in list(merged.keys()):
        item = merged[key]
        if item["kind"] != "person":
            continue
        if any(item["source"] in other["source"].replace(" ", "") and other["source"] != item["source"] for other in merged.values() if other is not item):
            del merged[key]
    return sorted(
        merged.values(),
        key=lambda item: (-float(item["score"]), -len(str(item["source"])), str(item["source"])),
    )


def _scan_korean_names(text: str) -> list[str]:
    """3-4 syllable Korean names inside Hangul runs, tolerating a following particle."""
    names: list[str] = []
    for run in re.finditer(r"[가-힣]+", text):
        chunk = run.group(0)
        for size in (4, 3):
            head = chunk[:size]
            if not _is_name_shape(head):
                continue
            rest = chunk[size:]
            if not rest or any(rest.startswith(particle) for particle in KOREAN_PARTICLES):
                names.append(head)
                break
    return names


def _is_name_shape(value: str) -> bool:
    return (len(value) == 3 and value[:1] in COMMON_KOREAN_SURNAMES) or (len(value) == 4 and value[:2] in COMPOUND_KOREAN_SURNAMES)


def _repeated_phrase_counts(prepared: list[dict[str, Any]]) -> list[str]:
    """Repeated terms: CJK/kana n-grams or 4+ letter Latin words seen in ≥2 blocks."""
    counts: Counter[str] = Counter()
    block_keys: dict[str, set[str]] = {}
    for block in prepared:
        compact = re.sub(r"\s+", "", block["text"])
        if not compact:
            continue
        phrases: set[str] = set()
        for size in (5, 4, 3, 2):
            for index in range(0, max(1, len(compact) - size + 1)):
                phrase = compact[index : index + size]
                if not phrase or not CJK_REPEAT_RE.fullmatch(phrase) or _is_name_shape(phrase):
                    continue
                phrases.add(phrase)
        for match in LATIN_WORD_RE.finditer(block["text"]):
            word = match.group(0)
            if word.upper() not in LATIN_STOP_TERMS:
                phrases.add(word)
        block_keys[block["id"]] = phrases
        for phrase in phrases:
            counts[phrase] += 1
    result: list[str] = []
    for phrase, count in counts.items():
        if count < 2 or sum(1 for phrases in block_keys.values() if phrase in phrases) < 2:
            continue
        result.append(phrase)
    return sorted(result, key=lambda item: (-counts[item], -len(item)))

