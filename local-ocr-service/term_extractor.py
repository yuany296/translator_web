from __future__ import annotations

import re
import threading
import unicodedata
from collections.abc import Iterable
from typing import Any

try:
    from kiwipiepy import Kiwi
except Exception as exc:  # pragma: no cover - 由健康检查暴露依赖问题
    Kiwi = None
    KIWI_IMPORT_ERROR = exc
else:
    KIWI_IMPORT_ERROR = None


NOUN_TAGS = {"NNP", "NNG"}
COMMON_KOREAN_SURNAMES = set(
    "김이박최정강조윤장임한오서신권황안송전홍유고문양손배백허남심노하곽성차주우구민진지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예봉사부가복"
)
COMPOUND_KOREAN_SURNAMES = {"남궁", "독고", "동방", "망절", "사공", "서문", "선우", "제갈", "황보"}
LATIN_STOP_TERMS = {
    "AD",
    "CEO",
    "CFO",
    "CTO",
    "DJ",
    "DR",
    "ETC",
    "MR",
    "MRS",
    "NO",
    "OK",
    "PD",
    "SNS",
    "TV",
    "VS",
    "YES",
}
LATIN_PHRASE_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:[A-Z][A-Z0-9&'.-]*)(?:[ \t]+[A-Z][A-Z0-9&'.-]*){0,4}(?![A-Za-z0-9])"
)
MODEL_PLACEHOLDER_RE = re.compile(r"[\[（(【<]\s*image\s*#?\s*\d+\s*[\]）)】>]", re.IGNORECASE)

_kiwi_instance: Any = None
_kiwi_lock = threading.Lock()
_kiwi_user_word_lock = threading.Lock()


def get_term_extractor_status(check_runtime: bool = False) -> dict[str, Any]:
    runtime_error = KIWI_IMPORT_ERROR
    if check_runtime and runtime_error is None:
        try:
            get_kiwi()
        except Exception as exc:  # pragma: no cover - 依赖或词典损坏时由接口健康检查暴露
            runtime_error = exc
    return {
        "available": runtime_error is None,
        "engine": "kiwi",
        "error": str(runtime_error) if runtime_error else "",
    }


def get_kiwi() -> Any:
    global _kiwi_instance
    if KIWI_IMPORT_ERROR is not None or Kiwi is None:
        raise RuntimeError(f"Kiwi import failed: {KIWI_IMPORT_ERROR}")
    if _kiwi_instance is not None:
        return _kiwi_instance
    with _kiwi_lock:
        if _kiwi_instance is None:
            # 内置维基词典有助于识别作品名和公开人物名，未知漫画角色仍由上下文词性与姓名结构兜底。
            _kiwi_instance = Kiwi(num_workers=1, load_default_dict=True)
    return _kiwi_instance


def extract_term_candidates(
    blocks: Iterable[dict[str, Any]],
    analyzer: Any | None = None,
    user_terms: Iterable[str] | None = None,
) -> list[dict[str, Any]]:
    kiwi = analyzer or get_kiwi()
    register_confirmed_person_aliases(kiwi, user_terms or [])
    merged: dict[str, dict[str, Any]] = {}
    prepared_blocks = [
        {"id": str(block.get("id") or "").strip(), "text": normalize_text(block.get("text"))}
        for block in blocks
    ]

    # 先学习同批次中可确定的全名，再正式分析；即使“성현”排在“김성현”前面，
    # 第二遍也能把无姓称呼按独立 NNP 候选提取出来。
    for block in prepared_blocks:
        text = block["text"]
        if not block["id"] or not text:
            continue
        tokens = normalize_tokens(kiwi.tokenize(text), text)
        person_names = [
            item["source"]
            for item in extract_korean_candidates(text, tokens)
            if item.get("kind") == "person"
        ]
        register_confirmed_person_aliases(kiwi, person_names)

    for raw_block in prepared_blocks:
        evidence_id = raw_block["id"]
        text = raw_block["text"]
        if not evidence_id or not text:
            continue

        tokens = normalize_tokens(kiwi.tokenize(text), text)
        candidates = extract_korean_candidates(text, tokens) + extract_latin_candidates(text)
        for candidate in candidates:
            source = normalize_candidate(candidate.get("source"))
            if not is_usable_candidate(source):
                continue
            key = source.casefold()
            current = merged.get(key)
            if current is None:
                current = {
                    "source": source,
                    "kind": str(candidate.get("kind") or "proper_noun"),
                    "score": float(candidate.get("score") or 0.0),
                    "evidenceIds": [],
                }
                merged[key] = current
            elif float(candidate.get("score") or 0.0) > current["score"]:
                current["kind"] = str(candidate.get("kind") or current["kind"])
                current["score"] = float(candidate.get("score") or current["score"])
            if evidence_id not in current["evidenceIds"]:
                current["evidenceIds"].append(evidence_id)
            if candidate.get("kind") == "person":
                register_confirmed_person_aliases(kiwi, [source])

    return sorted(
        merged.values(),
        key=lambda item: (-float(item["score"]), -len(str(item["source"])), str(item["source"])),
    )


def normalize_tokens(tokens: Iterable[Any], text: str) -> list[dict[str, Any]]:
    normalized = []
    for token in tokens:
        start = max(0, int(getattr(token, "start", 0) or 0))
        length = max(0, int(getattr(token, "len", 0) or 0))
        form = str(getattr(token, "form", "") or "").strip()
        tag = str(getattr(token, "tag", "") or "").strip().upper()
        if not form or not tag:
            continue
        surface = text[start : start + length] if length > 0 else form
        normalized.append(
            {
                "form": form,
                "tag": tag,
                "start": start,
                "end": start + max(length, len(surface)),
                "surface": surface or form,
                "baseForm": str(getattr(token, "base_form", "") or "").strip(),
            }
        )
    return sorted(normalized, key=lambda item: (item["start"], item["end"]))


def extract_korean_candidates(text: str, tokens: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    stripped_text = normalize_candidate(text)
    compact_text = re.sub(r"\s+", "", stripped_text)
    # Kiwi 偶尔会把姓名末字误判成语尾，例如“김솔음”中的“음/EF”。
    # 对恰好占满 OCR 块且满足姓名结构的文本，先用完整 token 序列恢复全名，避免只留下“김솔”。
    if is_korean_person_name(compact_text, tokens):
        return [{"source": stripped_text, "kind": "person", "score": 0.94}]
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []

    for token in tokens:
        if token["tag"] not in NOUN_TAGS or not contains_hangul(token["form"]):
            if current:
                groups.append(current)
                current = []
            continue
        if current and not can_join_noun_tokens(text, current[-1], token, len(current)):
            groups.append(current)
            current = []
        current.append(token)
    if current:
        groups.append(current)

    for group in groups:
        start = group[0]["start"]
        end = group[-1]["end"]
        surface = normalize_candidate(text[start:end])
        tags = {token["tag"] for token in group}
        compact = re.sub(r"\s+", "", surface)
        is_full_block = compact == re.sub(r"\s+", "", stripped_text)
        is_person = is_korean_person_name(compact, group)

        if is_person:
            candidates.append({"source": surface, "kind": "person", "score": 0.94})
            continue
        if "NNP" in tags and len(compact) >= 2:
            kind = "title" if len(group) >= 2 and is_full_block else "proper_noun"
            candidates.append({"source": surface, "kind": kind, "score": 0.9 if kind == "proper_noun" else 0.86})
            continue
        # 平衡模式允许完整 OCR 块中的短名词短语进入人工确认，但不接受普通单个名词。
        if is_full_block and 2 <= len(group) <= 4 and " " in surface and len(compact) >= 4:
            candidates.append({"source": surface, "kind": "title", "score": 0.72})

    return candidates


def extract_latin_candidates(text: str) -> list[dict[str, Any]]:
    candidates = []
    for match in LATIN_PHRASE_RE.finditer(text):
        source = normalize_candidate(match.group(0))
        words = source.split()
        if not source or not words:
            continue
        if len(words) == 1:
            word = words[0].upper()
            if len(word) < 3 or word in LATIN_STOP_TERMS:
                continue
            kind = "latin_name"
            score = 0.82
        else:
            if all(word.upper() in LATIN_STOP_TERMS or word.upper() == "THE" for word in words):
                continue
            kind = "latin_title"
            score = 0.9
        candidates.append({"source": source, "kind": kind, "score": score})
    return candidates


def can_join_noun_tokens(text: str, previous: dict[str, Any], current: dict[str, Any], group_size: int) -> bool:
    if group_size >= 4:
        return False
    gap = text[int(previous["end"]) : int(current["start"])]
    return not gap or gap.isspace()


def is_korean_person_name(value: str, tokens: list[dict[str, Any]] | None = None) -> bool:
    has_single_surname_shape = len(value) == 3 and value[:1] in COMMON_KOREAN_SURNAMES
    has_compound_surname_shape = len(value) == 4 and value[:2] in COMPOUND_KOREAN_SURNAMES
    if not (
        all("가" <= char <= "힣" for char in value)
        and (has_single_surname_shape or has_compound_surname_shape)
    ):
        return False
    if not tokens:
        return True
    # 姓氏结构本身会把“마법사”“김밥집”等普通词误判成人名；要求 Kiwi 给出专名，
    # 或整词是词典外低频词，再交给人工待确认区。
    return any(token.get("tag") == "NNP" for token in tokens) or all(
        not token.get("baseForm") for token in tokens
    )


def register_confirmed_person_aliases(kiwi: Any, terms: Iterable[str]) -> None:
    add_user_word = getattr(kiwi, "add_user_word", None)
    if not callable(add_user_word):
        return
    aliases = []
    for raw_term in terms:
        term = re.sub(r"\s+", "", normalize_candidate(raw_term))
        tokens = normalize_tokens(kiwi.tokenize(term), term)
        if not is_korean_person_name(term, tokens):
            continue
        surname_length = 2 if term[:2] in COMPOUND_KOREAN_SURNAMES else 1
        alias = term[surname_length:]
        if 2 <= len(alias) <= 3 and alias not in aliases:
            aliases.append(alias)
    with _kiwi_user_word_lock:
        for alias in aliases:
            try:
                add_user_word(alias, "NNP")
            except Exception:
                # 某些测试分析器或只读实现不支持动态词典，跳过即可。
                continue


def is_usable_candidate(value: str) -> bool:
    if not value or len(value) < 2 or len(value) > 60:
        return False
    if MODEL_PLACEHOLDER_RE.fullmatch(value):
        return False
    if all(char.isdigit() or char.isspace() or unicodedata.category(char).startswith("P") for char in value):
        return False
    return contains_hangul(value) or bool(re.search(r"[A-Za-z]", value))


def normalize_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = MODEL_PLACEHOLDER_RE.sub(" ", text)
    return re.sub(r"[ \t]+", " ", text.replace("\r", "\n")).strip()


def normalize_candidate(value: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or ""))).strip(" \t\r\n.,!?;:，。！？；：()（）[]【】\"'“”‘’")


def contains_hangul(value: str) -> bool:
    return bool(re.search(r"[가-힣]", value))
