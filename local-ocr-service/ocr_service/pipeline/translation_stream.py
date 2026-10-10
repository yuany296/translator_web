from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi.responses import StreamingResponse

from ..dependencies import runtime
from term_extractor import _is_local_url

MAX_MODEL_LINE = 256 * 1024
HEARTBEAT_SECONDS = 15.0

# 报错点名了思考参数才算「上游不认它」：限流、鉴权这类 4xx 不能让我们把用户的设置悄悄改掉。
# 与扩展侧 translation-utils.js#shouldRetryWithoutThinkingFields 同一口径。
_THINKING_FIELD_RE = re.compile(r"enable_thinking|reasoning_effort|thinking", re.IGNORECASE)


class _UpstreamRejected(RuntimeError):
    """上游 4xx：带原文，供调用方判断是不是「思考参数不被接受」，据此决定要不要剥掉重发。"""

# 对话引号是内容不是格式。流式 NDJSON 下模型最容易把引号当格式吞掉，
# 一旦丢了，扩展侧只能按"原文整段被引号包住"这一种情形做确定性兜底，
# 更复杂的（引号 + 叙述混排）就救不回来，所以提示词里必须写死这条规则。
DIALOGUE_QUOTE_RULE = (
    "Dialogue quotation marks are content, not formatting: reproduce the source's own quote "
    "characters exactly (“ ” 「 」 『 』 ‘ ’ and the ASCII double/single quotes). "
    "If a source paragraph is wrapped in quotes, the whole translated paragraph must stay "
    "wrapped in that same pair; if quoted speech sits inside a longer paragraph, keep a "
    "matching quoted span in the same place. Never drop the quotes, never swap them for "
    "another style, and never add quotes the source does not have. "
    'Example: source `"난 무조건 탈색부터 한다."` -> correct `“我不管，肯定要先漂发。”`, '
    "wrong `我不管，肯定要先漂发。`"
)

# 术语「判了没有」必须可核对（与小批链路 novel-translation.js#buildPrompt 同一套规则）。
# 字符串命中经常不是那个意思（봄=春天/人名、줄=排队/人名），所以「命中就必须逐字用」会把
# 句子改坏；但完全不校验，模型又可以默默不用注入的术语 —— 用户看到的就是「术语有时候
# 不生效」。这里把裁决权留给模型，只要求它逐条交代：用上，或写明这次语境不是它。
GLOSSARY_ACCOUNTING_RULE = (
    "For every glossary row that occurs in an item, account for it in that line's `terms` object: "
    "put its source in `terms.used` when the translation contains that row's target string verbatim, "
    'or list it in `terms.skipped` as {"source":"…","reason":"…"} when this occurrence really means '
    "something else (an ordinary noun, an idiom, a different person, or part of a longer word). "
    "Never leave a matching row unaccounted for, and never claim `used` when the target string is absent."
)


def _event(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _endpoint(base_url: Any) -> str:
    normalized = str(base_url or "").strip().rstrip("/")
    normalized = normalized.removesuffix("/chat/completions").removesuffix("/responses")
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("invalid OpenAI-compatible base URL")
    return f"{normalized}/chat/completions"


def _glossary_lines(payload: runtime.TranslationStreamPayload) -> list[str]:
    """术语段必须与小批链路(extension/src/shared/glossary.js#buildPrompt)同一条规则。

    以前这里只有一句 `Required glossary: [...]`,既没有「逐字照用/最长优先」的硬规则,
    也丢掉了条目备注(角色性别、年龄、身份、语气)—— 同一批术语在流式链路和小批链路
    上效果并不一致,用户看到的就是「术语有时候不正确」。
    """
    terms = []
    for item in payload.glossary:
        source = str(item.get("source") or "")
        target = str(item.get("target") or "")
        if not source or not target:
            continue
        note = str(item.get("note") or "")
        terms.append({"source": source, "target": target, **({"note": note} if note else {})})
    if not terms:
        return []
    return [
        "Mandatory terminology glossary:",
        "When the source text contains a listed source term, the translated text must contain "
        "its target string verbatim.",
        "Never replace a glossary target with a synonym, alternate spelling, transliteration, "
        "or your own rendering of the term.",
        "Apply the longest matching source term first. The glossary overrides general translation "
        "preferences.",
        "Entry notes describe the character (gender, age, role, speech style). Use notes to choose "
        "pronouns and voice for that character, even in sentences that refer to them only by a pronoun.",
        json.dumps(terms, ensure_ascii=False),
    ]


def _prompt(payload: runtime.TranslationStreamPayload) -> str:
    rows = [{"paragraphKey": str(item.get("paragraphKey") or ""),
             "text": str(item.get("originalText") or "")} for item in payload.items]
    context = json.dumps(payload.context, ensure_ascii=False)[:12_000]
    glossary_lines = _glossary_lines(payload)
    return "\n".join([
        f"Translate this web novel from {payload.sourceLanguage} to {payload.targetLanguage}.",
        "Output exactly one compact JSON object per line as soon as that paragraph is complete.",
        "Emit exactly one JSON line per input paragraphKey; each translation must cover only its own paragraph; "
        "never merge two paragraphs into one line and never repeat a neighboring paragraph's translation.",
        # 带术语时每行多一个 terms 字段:漏用术语必须能查出来(见 GLOSSARY_ACCOUNTING_RULE)。
        ('Schema: {"paragraphKey":"the supplied key","translation":"translated text",'
         '"terms":{"used":["…"],"skipped":[{"source":"…","reason":"…"}]}}') if glossary_lines
        else 'Schema: {"paragraphKey":"the supplied key","translation":"translated text"}',
        "Do not output Markdown fences, arrays, explanations, blank translations, or duplicate keys.",
        "Preserve meaning, names, tone, paragraph boundaries, and every supplied paragraphKey.",
        DIALOGUE_QUOTE_RULE,
        GLOSSARY_ACCOUNTING_RULE if glossary_lines else "",
        f"Continuity context: {context}" if context else "",
        *glossary_lines,
        f"Input paragraphs: {json.dumps(rows, ensure_ascii=False)}",
    ])


async def _stream_upstream(
    client: httpx.AsyncClient, url: str, request_body: dict[str, Any], headers: dict[str, str],
) -> AsyncIterator[str]:
    """发一次上游流式请求，只吐出 content 增量；4xx 抛 _UpstreamRejected 带上原文。

    拆出来是为了「思考参数被拒 → 剥掉重发一次」，见 _openai_content_chunks。
    """
    async with client.stream("POST", url, json=request_body, headers=headers) as response:
        if response.status_code >= 400:
            detail = (await response.aread()).decode("utf-8", "replace")[:1000]
            raise _UpstreamRejected(f"upstream HTTP {response.status_code}: {detail}")
        async for line in response.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                continue
            try:
                packet = json.loads(data)
                content = packet.get("choices", [{}])[0].get("delta", {}).get("content", "")
            except (ValueError, TypeError, IndexError, AttributeError):
                continue
            if content:
                yield str(content)


async def _openai_content_chunks(payload: runtime.TranslationStreamPayload) -> AsyncIterator[str]:
    provider = runtime._translation_stream_provider
    if callable(provider):
        async for chunk in provider(payload):
            yield str(chunk)
        return
    upstream = payload.upstream
    api_key = str(upstream.get("apiKey") or "")
    # thinking / enable_thinking 由扩展侧算好（shared/thinking-mode.js 是唯一定义处），
    # 这里只原样转发，不再按服务商判断该发哪个参数名。
    thinking_fields = {
        key: value for key, value in dict(upstream.get("thinking") or {}).items()
        if key in {"thinking", "enable_thinking"}
    }
    request_body: dict[str, Any] = {
        "model": str(upstream.get("model") or ""), "temperature": 0, "stream": True,
        "messages": [
            {"role": "system", "content": "You are a literary translator. Return NDJSON only."},
            {"role": "user", "content": _prompt(payload)},
        ],
        **thinking_fields,
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    timeout = httpx.Timeout(connect=15, read=None, write=30, pool=15)
    url = _endpoint(upstream.get("baseUrl"))
    async with httpx.AsyncClient(timeout=timeout, trust_env=not _is_local_url(url)) as client:
        try:
            async for content in _stream_upstream(client, url, request_body, headers):
                yield content
            return
        except _UpstreamRejected as rejected:
            # 上游不认思考参数：剥掉重发一次。被拒的请求没有输出、不计费，但用户等的是一个
            # 来回。这里不重试的后果更糟 —— 整条流式链路会在每个批次上都失败一次。
            # 与扩展侧 translation-utils.js#shouldRetryWithoutThinkingFields 同一口径：
            # 只有报错确实点名了这两个参数才剥。
            if not thinking_fields or not _THINKING_FIELD_RE.search(rejected.detail):
                raise RuntimeError(str(rejected)) from None
            request_body.pop("thinking", None)
            request_body.pop("enable_thinking", None)
        async for content in _stream_upstream(client, url, request_body, headers):
            yield content


async def _with_heartbeats(source: AsyncIterator[str]) -> AsyncIterator[str | None]:
    iterator = source.__aiter__()
    pending: asyncio.Task | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.create_task(iterator.__anext__())
            done, _ = await asyncio.wait({pending}, timeout=HEARTBEAT_SECONDS)
            if not done:
                yield None
                continue
            try:
                chunk = pending.result()
            except StopAsyncIteration:
                return
            pending = None
            yield chunk
    finally:
        if pending is not None and not pending.done():
            pending.cancel()


def _validated_items(payload: runtime.TranslationStreamPayload) -> dict[str, dict[str, Any]]:
    indexed: dict[str, dict[str, Any]] = {}
    for item in payload.items:
        paragraph_key = str(item.get("paragraphKey") or "")[:200]
        original = str(item.get("originalText") or "")[:100_000]
        record_key = str(item.get("recordKey") or "")[:160]
        record_payload = item.get("recordPayload")
        if not paragraph_key or not original.strip() or not record_key or not isinstance(record_payload, dict):
            raise ValueError("invalid stream paragraph")
        indexed.setdefault(paragraph_key, {
            "paragraphKey": paragraph_key, "originalText": original,
            "recordKey": record_key, "recordPayload": record_payload,
        })
    if not indexed:
        raise ValueError("no valid stream paragraphs")
    return indexed


def _parse_line(line: str) -> dict[str, Any] | None:
    cleaned = line.strip()
    if not cleaned or cleaned.startswith("```"):
        return None
    if len(cleaned) > MAX_MODEL_LINE:
        raise ValueError("model NDJSON line is too long")
    value = json.loads(cleaned)
    if not isinstance(value, dict):
        raise ValueError("model NDJSON event must be an object")
    return value


def _commit_paragraph(payload, item, translated: str, sequence: int,
                      terms: Any = None) -> dict[str, Any]:
    operation = {
        "operationId": f"stream:{payload.taskId}:{item['paragraphKey']}",
        "type": "commit_translation", "recordKey": item["recordKey"],
        "payload": {**item["recordPayload"], "translatedText": translated,
                    "source": "api", "configFingerprint": payload.configFingerprint},
    }
    result = runtime.get_translation_store().apply_operation(operation)
    record = result["record"]
    active = record.get("activeVersion") or {}
    event = {
        "type": "paragraph", "taskId": payload.taskId, "sequence": sequence,
        "paragraphKey": item["paragraphKey"], "translation": translated,
        "recordId": record["recordId"], "versionId": active.get("versionId", ""),
        "recordRevision": record["recordRevision"], "changeSeq": result["changeSeq"],
        "record": record,
    }
    # 术语交代按原样转发给扩展侧核对；模型整行没给 terms 时**不带这个字段**，
    # 扩展侧据此知道「这条响应没按新 schema 回」，退回旧的字符串硬校验，
    # 而不是把所有命中的术语都判成「没交代」而后整章重试。
    if isinstance(terms, dict):
        event["terms"] = terms
    return event


async def _stream_events(payload: runtime.TranslationStreamPayload) -> AsyncIterator[bytes]:
    items = _validated_items(payload)
    emitted: set[str] = set()
    buffer = ""
    completed = 0
    protocol_errors = 0
    try:
        async for chunk in _with_heartbeats(_openai_content_chunks(payload)):
            if chunk is None:
                yield _event({"type": "heartbeat", "taskId": payload.taskId})
                continue
            buffer += chunk
            if len(buffer) > MAX_MODEL_LINE and "\n" not in buffer:
                raise ValueError("model NDJSON line is too long")
            lines = buffer.split("\n")
            buffer = lines.pop()
            for line in lines:
                try:
                    row = _parse_line(line)
                    if row is None:
                        continue
                    key = str(row.get("paragraphKey") or "")
                    translated = str(row.get("translation") or "").strip()
                    if key not in items or key in emitted or not translated:
                        continue
                    event = _commit_paragraph(payload, items[key], translated, completed + 1,
                                              row.get("terms"))
                    emitted.add(key)
                    completed += 1
                    yield _event(event)
                    yield _event({"type": "progress", "taskId": payload.taskId,
                                  "completed": completed, "total": len(items)})
                except (ValueError, TypeError, json.JSONDecodeError) as exc:
                    protocol_errors += 1
                    yield _event({"type": "error", "taskId": payload.taskId,
                                  "code": "invalid_model_event", "error": str(exc)[:500]})
        if buffer.strip():
            try:
                row = _parse_line(buffer)
                key = str(row.get("paragraphKey") or "") if row else ""
                translated = str(row.get("translation") or "").strip() if row else ""
                if key in items and key not in emitted and translated:
                    yield _event(_commit_paragraph(payload, items[key], translated, completed + 1,
                                                   row.get("terms") if row else None))
                    emitted.add(key)
                    completed += 1
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                protocol_errors += 1
                yield _event({"type": "error", "taskId": payload.taskId,
                              "code": "invalid_final_event", "error": str(exc)[:500]})
    except (httpx.HTTPError, RuntimeError, ValueError) as exc:
        protocol_errors += 1
        yield _event({"type": "error", "taskId": payload.taskId,
                      "code": "stream_failed", "error": str(exc)[:500]})
    failed = len(items) - len(emitted)
    yield _event({"type": "done", "taskId": payload.taskId,
                  "completed": completed, "failed": failed, "total": len(items),
                  "protocolErrors": protocol_errors})


def translations_stream(payload: runtime.TranslationStreamPayload):
    return StreamingResponse(_stream_events(payload), media_type="application/x-ndjson")


runtime.translations_stream = translations_stream
