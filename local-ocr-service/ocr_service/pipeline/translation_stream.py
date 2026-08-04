from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi.responses import StreamingResponse

from ..dependencies import runtime

MAX_MODEL_LINE = 256 * 1024
HEARTBEAT_SECONDS = 15.0


def _event(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _endpoint(base_url: Any) -> str:
    normalized = str(base_url or "").strip().rstrip("/")
    normalized = normalized.removesuffix("/chat/completions").removesuffix("/responses")
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("invalid OpenAI-compatible base URL")
    return f"{normalized}/chat/completions"


def _prompt(payload: runtime.TranslationStreamPayload) -> str:
    rows = [{"paragraphKey": str(item.get("paragraphKey") or ""),
             "text": str(item.get("originalText") or "")} for item in payload.items]
    terms = [{"source": str(item.get("source") or ""),
              "target": str(item.get("target") or "")} for item in payload.glossary]
    context = json.dumps(payload.context, ensure_ascii=False)[:12_000]
    return "\n".join([
        f"Translate this web novel from {payload.sourceLanguage} to {payload.targetLanguage}.",
        "Output exactly one compact JSON object per line as soon as that paragraph is complete.",
        'Schema: {"paragraphKey":"the supplied key","translation":"translated text"}',
        "Do not output Markdown fences, arrays, explanations, blank translations, or duplicate keys.",
        "Preserve meaning, names, tone, paragraph boundaries, and every supplied paragraphKey.",
        f"Continuity context: {context}" if context else "",
        f"Required glossary: {json.dumps(terms, ensure_ascii=False)}" if terms else "",
        f"Input paragraphs: {json.dumps(rows, ensure_ascii=False)}",
    ])


async def _openai_content_chunks(payload: runtime.TranslationStreamPayload) -> AsyncIterator[str]:
    provider = runtime._translation_stream_provider
    if callable(provider):
        async for chunk in provider(payload):
            yield str(chunk)
        return
    upstream = payload.upstream
    api_key = str(upstream.get("apiKey") or "")
    if not api_key:
        raise ValueError("translation API key is required")
    request_body = {
        "model": str(upstream.get("model") or ""), "temperature": 0, "stream": True,
        "messages": [
            {"role": "system", "content": "You are a literary translator. Return NDJSON only."},
            {"role": "user", "content": _prompt(payload)},
        ],
    }
    timeout = httpx.Timeout(connect=15, read=None, write=30, pool=15)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream(
            "POST", _endpoint(upstream.get("baseUrl")), json=request_body,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        ) as response:
            if response.status_code >= 400:
                detail = (await response.aread()).decode("utf-8", "replace")[:1000]
                raise RuntimeError(f"upstream HTTP {response.status_code}: {detail}")
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


def _commit_paragraph(payload, item, translated: str, sequence: int) -> dict[str, Any]:
    operation = {
        "operationId": f"stream:{payload.taskId}:{item['paragraphKey']}",
        "type": "commit_translation", "recordKey": item["recordKey"],
        "payload": {**item["recordPayload"], "translatedText": translated,
                    "source": "api", "configFingerprint": payload.configFingerprint},
    }
    result = runtime.get_translation_store().apply_operation(operation)
    record = result["record"]
    active = record.get("activeVersion") or {}
    return {
        "type": "paragraph", "taskId": payload.taskId, "sequence": sequence,
        "paragraphKey": item["paragraphKey"], "translation": translated,
        "recordId": record["recordId"], "versionId": active.get("versionId", ""),
        "recordRevision": record["recordRevision"], "changeSeq": result["changeSeq"],
        "record": record,
    }


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
                    event = _commit_paragraph(payload, items[key], translated, completed + 1)
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
                    yield _event(_commit_paragraph(payload, items[key], translated, completed + 1))
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
