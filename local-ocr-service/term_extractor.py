from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter
from collections.abc import Iterable
from typing import Any
from urllib.parse import urlparse

import httpx

LLM_READ_TIMEOUT = 300.0
LLM_CONNECT_TIMEOUT = 10.0
# 分段过大会让 8B 级模型脱轨（输出总结而非 JSON）；3000 字符 ≈ 800 tokens 稳定。
LLM_MAX_CHUNK_CHARS = 3000
LLM_CHUNK_OVERLAP = 200
VALID_KINDS = {"person", "location", "organization", "title", "group", "latin_name", "latin_title"}
MAX_SOURCE_LENGTH = 120
MAX_NOTE_LENGTH = 240
MAX_TARGET_LENGTH = 120
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
MODEL_PLACEHOLDER_RE = re.compile(r"[\[（(【<]\s*image\s*#?\s*\d+\s*[\]）)】>]", re.IGNORECASE)
KOREAN_JOSA_RE = re.compile(r"[은는이가을를의에와]$")


def _in_source_text(text: str, term: str) -> bool:
    """term 是否逐字出现在原文中；忽略空白差异并容忍一个结尾韩语助词。"""
    haystack = re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(text or ""))).casefold()
    needle = re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(term or ""))).casefold()
    if not needle or not haystack:
        return False
    if needle in haystack:
        return True
    stripped = KOREAN_JOSA_RE.sub("", needle)
    return len(stripped) >= 2 and stripped in haystack


def _is_local_url(url: str) -> bool:
    return urlparse(str(url or "")).hostname in {"127.0.0.1", "localhost", "::1"}


def get_term_extractor_status(
    check_runtime: bool = False,
    base_url: str = "",
    api_key: str = "",
) -> dict[str, Any]:
    """Extraction engine availability: heuristic mode when no LLM URL, else probe /models."""
    normalized = str(base_url or "").strip().rstrip("/")
    if not normalized:
        return {"available": True, "engine": "heuristic", "error": ""}
    if not check_runtime:
        return {"available": True, "engine": "ollama", "error": ""}
    try:
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        with httpx.Client(timeout=httpx.Timeout(connect=5, read=8, write=5, pool=5), trust_env=not _is_local_url(normalized)) as client:
            response = client.get(f"{normalized}/models", headers=headers)
            response.raise_for_status()
        return {"available": True, "engine": "ollama", "error": ""}
    except Exception as exc:  # noqa: BLE001 - 任何网络/响应异常都视为离线
        return {"available": False, "engine": "ollama", "error": f"LLM 服务不可达：{exc}"}


def _endpoint(base_url: Any) -> str:
    normalized = str(base_url or "").strip().rstrip("/")
    normalized = normalized.removesuffix("/chat/completions").removesuffix("/responses")
    if not normalized.startswith(("http://", "https://")):
        raise ValueError("invalid LLM base URL")
    return f"{normalized}/chat/completions"


def _llm_extract_chunk(chunk: str, base_url: str, model: str, api_key: str,
                       target_language: str, source_text: str = "") -> list[dict[str, Any]]:
    prompt = "\n".join([
        "你是网络小说/漫画术语提取助手。从下面的源语言文本中提取所有专有名词与人名：",
        "- 人名（含姓氏的完整写法）、地名、机构名、作品名、团体名、英文/外来专名；不要提取普通名词、动词、助词或描述性短语",
        "- 文本可能是韩语、日语、英语、中文或其他语言，按文本实际语言提取；同一实体有多种写法时使用最完整写法",
        "- 每段原文后可能带一行「译文：xxx」参考译文，suggestedTarget 必须从参考译文对应处得出并填写；没有参考译文（没有「译文：」行）时才可留空",
        f"- 目标语言为 {target_language}",
        "输出 JSON 数组，每项格式：",
        '{"source": "原文术语", "kind": "person|location|organization|title|group|latin_name|latin_title", "note": "目标语言简短说明，无把握则留空", "suggestedTarget": "建议的目标语言译文；有参考译文时不得留空"}',
        "只输出 JSON 数组本身，不要 Markdown 代码块、不要多余解释。",
        f"源文本：\n{chunk}",
    ])
    body = {
        "model": str(model or "").strip() or "qwen2.5:7b",
        "temperature": 0,
        "stream": False,
        "messages": [
            {"role": "system", "content": "You are a web-novel terminology extractor. Return strict JSON only."},
            {"role": "user", "content": prompt},
        ],
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        endpoint = _endpoint(base_url)
        with httpx.Client(timeout=httpx.Timeout(connect=LLM_CONNECT_TIMEOUT, read=LLM_READ_TIMEOUT, write=30, pool=5), trust_env=not _is_local_url(endpoint)) as client:
            response = client.post(endpoint, json=body, headers=headers)
    except httpx.TimeoutException as exc:
        raise RuntimeError("LLM 术语提取超时") from exc
    except httpx.HTTPError as exc:
        raise RuntimeError(f"LLM 术语提取请求失败：{exc}") from exc
    if response.status_code >= 400:
        detail = response.text[:300]
        raise RuntimeError(f"LLM 服务 HTTP {response.status_code}: {detail}")
    try:
        data = response.json()
    except ValueError as exc:
        raise RuntimeError("LLM 返回了无法解析的响应") from exc
    content = ""
    for choice in data.get("choices") or []:
        message = choice.get("message") or {}
        content = str(message.get("content") or "")
        if content:
            break
    return _validate_llm_output(content, source_text or chunk)


def _extract_json_array(content: str) -> list[Any] | None:
    text = str(content or "").strip()
    if not text:
        return None
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text)
    try:
        value = json.loads(text)
    except ValueError:
        match = re.search(r"\[.*\]", text, re.DOTALL)
        if not match:
            return None
        try:
            value = json.loads(match.group(0))
        except ValueError:
            return None
    return value if isinstance(value, list) else None


def _validate_llm_output(content: str, source_text: str) -> list[dict[str, Any]]:
    """Parse the model answer; drop hallucinated or out-of-schema entries.

    source 必须出现在原文里（source_text 不含「译文：」行——模型偶尔会从译文行抓词填
    source，否则待确认区会出现"原文术语=中文译文"）；source/suggestedTarget 填反时交换。
    """
    values = _extract_json_array(content)
    if not values:
        return []
    seen: set[str] = set()
    candidates: list[dict[str, Any]] = []
    for value in values:
        if not isinstance(value, dict):
            continue
        source = unicodedata.normalize("NFKC", str(value.get("source") or "")).strip()
        kind = str(value.get("kind") or "").strip().lower()
        note = str(value.get("note") or "").strip()
        target = str(value.get("suggestedTarget") or "").strip()
        if not source or len(source) > MAX_SOURCE_LENGTH or kind not in VALID_KINDS:
            continue
        if not _in_source_text(source_text, source) and target and _in_source_text(source_text, target):
            source, target = target, source
        if not _in_source_text(source_text, source):
            continue
        key = source.casefold()
        if key in seen:
            continue
        seen.add(key)
        candidates.append({
            "source": source,
            "kind": kind,
            "note": note[:MAX_NOTE_LENGTH],
            "suggestedTarget": target[:MAX_TARGET_LENGTH],
            "score": _kind_score(kind),
        })
    return candidates


def _kind_score(kind: str) -> float:
    scores = {"person": 0.94, "title": 0.9, "group": 0.9, "organization": 0.88, "location": 0.88, "latin_name": 0.82, "latin_title": 0.9}
    return scores.get(kind, 0.85)


def _split_chunks(text: str, max_chars: int = LLM_MAX_CHUNK_CHARS, overlap: int = LLM_CHUNK_OVERLAP) -> list[str]:
    if len(text) <= max_chars:
        return [text] if text.strip() else []
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + max_chars, len(text))
        chunks.append(text[start:end])
        if end >= len(text):
            break
        start = max(start, end - overlap)
    return chunks


def extract_term_candidates_llm(
    blocks: Iterable[dict[str, Any]],
    base_url: str,
    model: str,
    api_key: str,
    target_language: str = "zh-CN",
) -> list[dict[str, Any]]:
    """Extract proper nouns with an LLM over the whole chapter; 原文/译文 pairs let the model fill suggestedTarget."""
    prepared = [
        {"id": str(block.get("id") or "").strip(), "text": normalize_text(block.get("text")), "translatedText": normalize_text(block.get("translatedText"))}
        for block in blocks
        if str(block.get("id") or "").strip() and normalize_text(block.get("text"))
    ]
    if not prepared:
        return []
    full_text = "\n".join(f"{block['text']}\n译文：{block['translatedText']}" if block["translatedText"] else block["text"] for block in prepared)
    original_text = "\n".join(block["text"] for block in prepared)  # 校验基准只含原文：译文行绝不能作为 source 来源
    if not full_text.strip():
        return []
    merged: dict[str, dict[str, Any]] = {}
    for chunk in _split_chunks(full_text):
        for candidate in _llm_extract_chunk(chunk, base_url, model, api_key, target_language, source_text=original_text):
            key = candidate["source"].casefold()
            current = merged.get(key)
            if current is None:
                merged[key] = candidate
            else:
                for field in ("note", "suggestedTarget"):
                    if not current[field] and candidate.get(field):
                        current[field] = candidate[field]
                current["score"] = max(current["score"], candidate["score"])
    for candidate in merged.values():
        candidate["evidenceIds"] = [block["id"] for block in prepared if _in_source_text(block["text"], candidate["source"])]
    return sorted(merged.values(), key=lambda item: (-float(item["score"]), -len(str(item["source"])), str(item["source"])))


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


def extract_term_candidates(
    blocks: Iterable[dict[str, Any]],
    upstream: dict[str, Any] | None = None,
    target_language: str = "zh-CN",
) -> list[dict[str, Any]]:
    """Dispatch: LLM extraction when an upstream is configured, else heuristic."""
    base_url = str((upstream or {}).get("baseUrl") or "").strip()
    if base_url:
        return extract_term_candidates_llm(
            blocks, base_url, str((upstream or {}).get("model") or ""),
            str((upstream or {}).get("apiKey") or ""), target_language,
        )
    return extract_candidate_sentences(blocks)


def normalize_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = MODEL_PLACEHOLDER_RE.sub(" ", text)
    return re.sub(r"[ \t]+", " ", text.replace("\r", "\n")).strip()


def normalize_candidate(value: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or ""))).strip(" \t\r\n.,!?;:，。！？；：()（）[]【】\"'“”‘’")


def contains_hangul(value: str) -> bool:
    return bool(re.search(r"[가-힣]", value))
