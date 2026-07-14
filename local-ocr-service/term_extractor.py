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
KOREAN_STOP_WORDS = {
    # 一般名词（在术语语境中不应作为候选的常见词）
    "한국", "사람", "장소", "이야기", "생각", "시간", "너무", "정말",
    "모든", "우리", "그것", "무엇", "어떤", "때문", "안녕", "감사",
    "다시", "지금", "오늘", "내일", "어제", "여기", "저기", "거기",
    "아마", "진짜", "항상", "가장", "같은", "다른", "이런", "저런",
    "그런", "없이", "함께", "바로", "아직", "이미", "처음", "마지막",
    "사실", "물론", "아니", "응", "그래", "하지만", "그리고", "근데",
    "이제", "저도", "그럼", "아까", "각자", "모두", "전부", "일부",
    "나중", "중간", "옆", "위", "밑", "안", "밖", "앞", "뒤", "근처",
    "주변", "확인", "시작", "끝", "방법", "경우", "이유", "결과",
    "정도", "한번", "가끔", "자주", "늘", "언제", "어디", "누구",
    "왜", "얼마", "몇", "대한", "관한", "의해", "통해",
    "어떠한", "어느", "이것", "저것", "이분", "그분", "저분", "여러분",
    "이쪽", "그쪽", "저쪽", "이런저런",
    # 常见动词词干（可能被误标记为名词）
    "하다", "되다", "있다", "없다", "않다", "그렇다", "이렇다", "저렇다",
    "아니다", "그러다", "모르다", "알다", "보이다", "들리다",
    "좋다", "싫다", "많다", "적다", "크다", "작다", "길다", "짧다",
    "높다", "낮다", "넓다", "좁다", "멀다", "가깝다",
    "예쁘다", "아름답다", "귀엽다", "멋있다", "재미있다",
    # 常见副词
    "아주", "매우", "거의", "별로", "전혀", "결코", "과연", "설마",
    "제일", "조금", "약간", "많이", "빨리", "천천히",
    "드디어", "마침내", "겨우", "간신히", "대충", "일단", "우선",
    "곧", "바로", "방금", "일찍", "늦게",
    "또", "또한", "더", "덜", "아주", "훨씬", "오히려", "도리어",
    # 高频依存名词（조사/어미가 붙은 형태의 어근）
    "것", "수", "데", "거", "게", "줄", "길", "일", "중", "때",
    "곳", "쪽", "분", "군", "듯", "채", "만", "대로", "뿐", "나름",
    "척", "양", "터", "적", "판", "참", "통", "동안", "무렵", "즈음",
}
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

    # 频率过滤："title" 类型（NNG-only）候选词需要至少跨 3 个证据块出现才保留
    filtered: dict[str, dict[str, Any]] = {}
    for key, candidate in merged.items():
        if candidate["kind"] in ("person", "proper_noun", "latin_name", "latin_title"):
            filtered[key] = candidate
        elif candidate["kind"] == "title" and len(candidate["evidenceIds"]) >= 2:
            filtered[key] = candidate
    merged = filtered

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
            # 纯 NNG 组的停用词检查：任意组成词为停用词则丢弃
            if "NNP" not in tags:
                has_stop = False
                for token in group:
                    if token["form"] in KOREAN_STOP_WORDS:
                        has_stop = True
                        break
                if not has_stop:
                    candidates.append({"source": surface, "kind": "title", "score": 0.72})
            else:
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
    has_nnp = any(token.get("tag") == "NNP" for token in tokens)
    all_unseen = all(not token.get("baseForm") for token in tokens)
    # 排除"김밥"(김/NNP+밥/NNG)等混合标签的常见名词：如果前 1~2 字是姓氏且剩余部分
    # 有 baseForm（即词典已知），则不是人名。
    tokens_by_tag = {}
    for token in tokens:
        tokens_by_tag.setdefault(token.get("tag"), []).append(token)
    nng_with_baseform = [
        t for t in tokens_by_tag.get("NNG", []) if t.get("baseForm")
    ]
    nnp_without_baseform = [
        t for t in tokens_by_tag.get("NNP", []) if not t.get("baseForm")
    ]
    # 如果只含 NNP 且全部无 baseForm → 词典外专名，大概率是人名（如"김철수"）
    if has_nnp and not tokens_by_tag.get("NNG") and nnp_without_baseform:
        return True
    # NNP + NNG 混合：NNG 有词典定义 → 是合成名词（如"김밥"）而非人名
    if has_nnp and nng_with_baseform:
        return False
    # 纯 NNP 但有 baseForm → 词典已知词，不一定是人名
    if has_nnp and not all_unseen:
        return False
    return has_nnp or all_unseen


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
    if not contains_hangul(value) and not bool(re.search(r"[A-Za-z]", value)):
        return False
    # 停用词过滤：去除空白后直接匹配
    compact = re.sub(r"\s+", "", value)
    if compact in KOREAN_STOP_WORDS:
        return False
    # 前缀匹配：处理"한국에"→"한국"、"시작이다"→"시작"等变形
    for length in range(2, min(len(compact), 6) + 1):
        if compact[:length] in KOREAN_STOP_WORDS:
            return False
    return True


def normalize_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = MODEL_PLACEHOLDER_RE.sub(" ", text)
    return re.sub(r"[ \t]+", " ", text.replace("\r", "\n")).strip()


def normalize_candidate(value: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or ""))).strip(" \t\r\n.,!?;:，。！？；：()（）[]【】\"'“”‘’")


def contains_hangul(value: str) -> bool:
    return bool(re.search(r"[가-힣]", value))
