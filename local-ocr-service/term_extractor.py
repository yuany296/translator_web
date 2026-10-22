from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Iterable
from typing import Any
from urllib.parse import urlparse

import httpx

from ner_extractor import ner_engine_status, try_extract_ner_candidates
from term_text_utils import (
    MAX_SOURCE_LENGTH,
    contains_hangul,
    in_source_text as _in_source_text,
    normalize_candidate,
    normalize_text,
)

LLM_READ_TIMEOUT = 300.0
LLM_CONNECT_TIMEOUT = 10.0
# 分段过大会让 8B 级模型脱轨（输出总结而非 JSON）；3000 字符 ≈ 800 tokens 稳定。
LLM_MAX_CHUNK_CHARS = 3000
LLM_CHUNK_OVERLAP = 200
# 报错点名了思考参数才算「上游不认它」：限流、鉴权这类 4xx 不能让我们把用户的设置悄悄改掉。
# 与 extension/src/background/modules/translation-utils.js 同一口径。
THINKING_FIELD_RE = re.compile(r"enable_thinking|reasoning_effort|thinking", re.IGNORECASE)
VALID_KINDS = {"person", "location", "organization", "title", "group", "latin_name", "latin_title"}
# 字段名与 kind 取值的容错表 —— 必须与手机版
# extension/src/novel-mobile/term-extract-prompt.js 的 FIELD_ALIASES / KIND_ALIASES /
# INVALID_KIND_ALIASES 逐键一致（tests/term_extractor_parity.test.mjs 会比对两边）。
FIELD_ALIASES = {
    "source": ("source", "term", "name", "原文", "术语", "原文术语"),
    "kind": ("kind", "type", "类型", "类别"),
    "note": ("note", "备注", "说明", "description"),
    "target": ("suggestedTarget", "suggested_target", "target", "translation", "译名", "译文", "中文译名"),
}
KIND_ALIASES = {
    "person": "person", "人名": "person", "人物": "person", "角色": "person", "姓名": "person",
    "location": "location", "地名": "location", "地点": "location", "place": "location",
    "organization": "organization", "org": "organization", "机构": "organization",
    "机构名": "organization", "组织": "organization", "组织名": "organization",
    "title": "title", "作品名": "title", "书名": "title", "标题": "title", "work": "title",
    "group": "group", "团体": "group", "团体名": "group", "组合": "group", "队伍": "group",
    "latin_name": "latin_name", "英文名": "latin_name", "拉丁名": "latin_name", "英文人名": "latin_name",
    "latin_title": "latin_title", "英文作品名": "latin_title", "英文标题": "latin_title",
    "proper_noun": "proper_noun", "专有名词": "proper_noun", "固有名词": "proper_noun",
}
# 明确不是术语的词性：这些必须丢，否则「말했다」这种也会被当成术语塞进候选。
INVALID_KIND_ALIASES = {
    "verb", "noun", "common_noun", "common_noun_phrase", "adjective", "adverb", "particle",
    "pronoun", "phrase", "动词", "名词", "普通名词", "形容词", "副词", "助词", "代词", "短语",
}
# 本地 Ollama 的兜底模型名：只在 base_url 指向本机时才有意义（见 _resolve_model）。
OLLAMA_DEFAULT_MODEL = "qwen2.5:7b"

MAX_NOTE_LENGTH = 240
MAX_TARGET_LENGTH = 120


def _is_local_url(url: str) -> bool:
    return urlparse(str(url or "")).hostname in {"127.0.0.1", "localhost", "::1"}


def get_term_extractor_status(
    check_runtime: bool = False,
    base_url: str = "",
    api_key: str = "",
) -> dict[str, Any]:
    """Extraction engine availability: NER model when it is on disk, else nothing; LLM URL wins."""
    normalized = str(base_url or "").strip().rstrip("/")
    if not normalized:
        return ner_engine_status()
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


def _pick_field(value: dict[str, Any], aliases: tuple[str, ...]) -> str:
    """从多个可能的字段名里取第一个非空字符串值（与手机版 pickField 一致）。"""
    for key in aliases:
        raw = value.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw
    return ""


def _normalize_kind(raw: Any) -> str | None:
    """把模型给的 kind 归一成白名单值。

    返回 "" = 明确不是术语（动词/普通名词…，必须丢）；
    返回 None = 完全不认识 —— 归一成 proper_noun（宁可多留一条让用户自己忽略，
    也不要像以前那样静默丢掉，用户看到的就是「术语老漏」）。
    """
    text = str(raw or "").strip()
    if not text:
        return None
    key = text.lower()
    if key in VALID_KINDS:
        return key
    if key in KIND_ALIASES:
        return KIND_ALIASES[key]
    if key in INVALID_KIND_ALIASES:
        return ""
    return None


def _resolve_model(base_url: str, model: Any) -> str:
    """整章提取用哪个模型。

    以前模型为空时一律退到 `qwen2.5:7b` —— 那个名字只对本地 Ollama 有意义；配置里没填
    model 时，云端接口会拿一个不存在的模型名去请求，提取静默失败，而翻译照常
    （翻译自己有默认模型）。所以：本机地址才用 Ollama 兜底，其余情况直接报错说清原因。
    """
    name = str(model or "").strip()
    if name:
        return name
    if _is_local_url(base_url):
        return OLLAMA_DEFAULT_MODEL
    raise RuntimeError("未配置术语提取模型：请在设置页「翻译服务」里为整章术语提取选择带 model 的配置")


def _endpoint(base_url: Any) -> str:
    normalized = str(base_url or "").strip().rstrip("/")
    normalized = normalized.removesuffix("/chat/completions").removesuffix("/responses")
    if not normalized.startswith(("http://", "https://")):
        raise ValueError("invalid LLM base URL")
    return f"{normalized}/chat/completions"


def _chunk_prompt(chunk: str, target_language: str) -> str:
    """单段提取提示词 —— 必须与手机版 buildChunkPrompt 逐行一致。

    tests/term_extractor_parity.test.mjs 会拿两边比文本：桌面走本地服务的这份，手机走
    novel-mobile/term-extract-prompt.js 那份，任何一边改规则都必须同步另一边，
    否则同一个模型在两个端上会给出不同质量的候选（用户实测「手机漏术语」时最先
    被怀疑的就是这里）。
    """
    return "\n".join([
        "你是网络小说/漫画术语提取助手。从下面的源语言文本中提取所有专有名词与人名：",
        "- 人名（含姓氏的完整写法）、地名、机构名、作品名、团体名、英文/外来专名；不要提取普通名词、动词、助词或描述性短语",
        "- 文本可能是韩语、日语、英语、中文或其他语言，按文本实际语言提取；同一实体有多种写法时使用最完整写法",
        "- 每段原文后可能带一行「译文：xxx」参考译文，suggestedTarget 必须从参考译文对应处得出并填写；没有参考译文（没有「译文：」行）时才可留空",
        f"- 目标语言为 {target_language}",
        "输出 JSON 数组，每项格式：",
        '{"source": "原文术语", "kind": "person|location|organization|title|group|latin_name|latin_title", "note": "目标语言简短说明，无把握则留空", "suggestedTarget": "建议的目标语言译文；有参考译文时不得留空"}',
        "字段名必须是这四个英文名：source、kind、note、suggestedTarget，不要用中文或其它拼写。",
        "kind 只能填这七个英文单词之一：person、location、organization、title、group、latin_name、latin_title（人名用 person），不要填中文。",
        "suggestedTarget 必须给出目标语言译法：人名按目标语言常见音译写；有「译文：」参考译文的，必须与参考译文里的写法一致。不要留空，也不要把原文照抄一遍。",
        "只输出 JSON 数组本身，不要 Markdown 代码块、不要多余解释。",
        f"源文本：\n{chunk}",
    ])


def _llm_extract_chunk(chunk: str, base_url: str, model: str, api_key: str,
                       target_language: str, source_text: str = "",
                       stats: dict[str, int] | None = None,
                       thinking: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    prompt = _chunk_prompt(chunk, target_language)
    # thinking / enable_thinking 由扩展侧算好（shared/thinking-mode.js 是唯一定义处），这里只转发。
    thinking_fields = {k: v for k, v in dict(thinking or {}).items() if k in {"thinking", "enable_thinking"}}
    body: dict[str, Any] = {
        "model": _resolve_model(base_url, model),
        "temperature": 0,
        "stream": False,
        "messages": [
            {"role": "system", "content": "You are a web-novel terminology extractor. Return strict JSON only."},
            {"role": "user", "content": prompt},
        ],
        **thinking_fields,
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    endpoint = _endpoint(base_url)
    timeout = httpx.Timeout(connect=LLM_CONNECT_TIMEOUT, read=LLM_READ_TIMEOUT, write=30, pool=5)
    for attempt in range(2):
        try:
            with httpx.Client(timeout=timeout, trust_env=not _is_local_url(endpoint)) as client:
                response = client.post(endpoint, json=body, headers=headers)
        except httpx.TimeoutException as exc:
            raise RuntimeError("LLM 术语提取超时") from exc
        except httpx.HTTPError as exc:
            raise RuntimeError(f"LLM 术语提取请求失败：{exc}") from exc
        if response.status_code < 400:
            break
        # 上游不认思考参数就剥掉重发一次（被拒的请求没有输出、不计费）；否则照旧报错
        if attempt == 0 and thinking_fields and THINKING_FIELD_RE.search(response.text[:300]):
            body.pop("thinking", None)
            body.pop("enable_thinking", None)
            continue
        raise RuntimeError(f"LLM 服务 HTTP {response.status_code}: {response.text[:300]}")
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
    return _validate_llm_output(content, source_text or chunk, stats)


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


def _validate_llm_output(content: str, source_text: str,
                         stats: dict[str, int] | None = None) -> list[dict[str, Any]]:
    """Parse the model answer; drop hallucinated or out-of-schema entries.

    source 必须出现在原文里（source_text 不含「译文：」行——模型偶尔会从译文行抓词填
    source，否则待确认区会出现"原文术语=中文译文"）；source/suggestedTarget 填反时交换。

    字段名与 kind 先过容错表（与手机版同一份，见 FIELD_ALIASES / KIND_ALIASES）：
    云模型经常把 kind 写成「人名」、把译名写成 target，严格版本会把这些整条丢掉 ——
    用户看到的就是「术语老漏」。完全不认识的 kind 归一成 proper_noun 保留，
    只有明确是动词/普通名词这类词性才丢。丢弃数量记进 `stats`，随接口回给扩展侧展示。
    """
    def bump(key: str) -> None:
        if isinstance(stats, dict):
            stats[key] = int(stats.get(key, 0)) + 1

    values = _extract_json_array(content)
    if not values:
        bump("noJson")
        return []
    seen: set[str] = set()
    candidates: list[dict[str, Any]] = []
    for value in values:
        if not isinstance(value, dict):
            bump("schema")
            continue
        source = unicodedata.normalize("NFKC", _pick_field(value, FIELD_ALIASES["source"])).strip()
        raw_kind = _pick_field(value, FIELD_ALIASES["kind"])
        kind = _normalize_kind(raw_kind)
        note = _pick_field(value, FIELD_ALIASES["note"]).strip()
        target = _pick_field(value, FIELD_ALIASES["target"]).strip()
        if not source or len(source) > MAX_SOURCE_LENGTH:
            bump("schema")
            continue
        if kind == "":
            bump("invalidKind")
            continue
        if kind is None:
            bump("unknownKind")
            kind = "proper_noun"
        if not _in_source_text(source_text, source) and target and _in_source_text(source_text, target):
            source, target = target, source
        if not _in_source_text(source_text, source):
            bump("notInSource")
            continue
        key = source.casefold()
        if key in seen:
            bump("duplicate")
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
    scores = {"person": 0.94, "title": 0.9, "group": 0.9, "organization": 0.88, "location": 0.88,
              "latin_name": 0.82, "latin_title": 0.9, "proper_noun": 0.85}
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
    candidates, _stats = extract_term_candidates_llm_with_stats(
        blocks, base_url, model, api_key, target_language
    )
    return candidates


def extract_term_candidates_llm_with_stats(
    blocks: Iterable[dict[str, Any]],
    base_url: str,
    model: str,
    api_key: str,
    target_language: str = "zh-CN",
    thinking: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """同上，另外把「丢弃了多少条、为什么丢」带出来给扩展侧展示。

    用户反馈「术语比电脑少/老漏」时，最常见的两个原因是：模型把 kind 写成中文被整条丢掉、
    以及 source 没在（采样到的）原文里出现。以前这两种都静默，界面上看不出任何原因。
    """
    stats: dict[str, int] = {}
    prepared = [
        {"id": str(block.get("id") or "").strip(), "text": normalize_text(block.get("text")), "translatedText": normalize_text(block.get("translatedText"))}
        for block in blocks
        if str(block.get("id") or "").strip() and normalize_text(block.get("text"))
    ]
    if not prepared:
        return [], stats
    full_text = "\n".join(f"{block['text']}\n译文：{block['translatedText']}" if block["translatedText"] else block["text"] for block in prepared)
    original_text = "\n".join(block["text"] for block in prepared)  # 校验基准只含原文：译文行绝不能作为 source 来源
    if not full_text.strip():
        return [], stats
    merged: dict[str, dict[str, Any]] = {}
    for chunk in _split_chunks(full_text):
        for candidate in _llm_extract_chunk(chunk, base_url, model, api_key, target_language,
                                            source_text=original_text, stats=stats, thinking=thinking):
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
    return sorted(merged.values(), key=lambda item: (-float(item["score"]), -len(str(item["source"])), str(item["source"]))), stats



def extract_term_candidates(
    blocks: Iterable[dict[str, Any]],
    upstream: dict[str, Any] | None = None,
    target_language: str = "zh-CN",
) -> list[dict[str, Any]]:
    """Dispatch: LLM when configured, else the local NER model; nothing else (no heuristic)."""
    return extract_term_candidates_with_stats(blocks, upstream, target_language)[0]


def extract_term_candidates_with_stats(
    blocks: Iterable[dict[str, Any]],
    upstream: dict[str, Any] | None = None,
    target_language: str = "zh-CN",
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """同上，另外带回「丢弃统计」（LLM 分段丢弃 / NER 低质词条丢弃）。"""
    base_url = str((upstream or {}).get("baseUrl") or "").strip()
    if base_url:
        return extract_term_candidates_llm_with_stats(
            blocks, base_url, str((upstream or {}).get("model") or ""),
            str((upstream or {}).get("apiKey") or ""), target_language,
            thinking=dict((upstream or {}).get("thinking") or {}),
        )
    # 没有第三条路：本地模型缺失/不可用时**一条都不产出**。以前这里会落回「句子模式」启发式，
    # 它对任何 3 字韩文首字命中姓氏表就给 person 0.94 —— 实测 3 句普通韩文产出 5 条候选、
    # 0 条真专名，等于往术语库里灌垃圾。宁可空着，让界面说清「没提取到」。
    return try_extract_ner_candidates(list(blocks)) or ([], {})
