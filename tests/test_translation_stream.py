from __future__ import annotations

import json
import asyncio
import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1] / "local-ocr-service"
sys.path.insert(0, str(SERVICE_ROOT))

from translation_store import TranslationStore  # noqa: E402


def _record_payload(segment: str, source: str) -> dict:
    return {
        "mode": "novel", "scopeKey": "book:chapter", "segmentKey": segment,
        "workId": "book", "chapterId": "chapter", "rawSourceText": source,
        "normalizedSourceText": source, "rawSourceHash": f"raw-{segment}",
        "normalizedSourceHash": f"normalized-{segment}",
        "configuredSourceLanguage": "auto", "resolvedSourceLanguage": "ko",
        "targetLanguage": "zh-CN",
    }


def test_stream_heartbeat_does_not_cancel_a_slow_upstream_chunk():
    from ocr_service.pipeline import translation_stream

    async def source():
        await asyncio.sleep(0.03)
        yield "complete"

    async def collect():
        original = translation_stream.HEARTBEAT_SECONDS
        translation_stream.HEARTBEAT_SECONDS = 0.005
        try:
            return [item async for item in translation_stream._with_heartbeats(source())]
        finally:
            translation_stream.HEARTBEAT_SECONDS = original

    values = asyncio.run(collect())
    assert values.count(None) >= 1
    assert values[-1] == "complete"


def test_stream_commits_before_emitting_and_handles_fragments_duplicates_and_final_line(tmp_path):
    import server
    from fastapi.testclient import TestClient

    async def provider(_payload):
        yield '{"paragraphKey":"p1","translation":"第'
        yield '一段"}\n{"paragraphKey":"p1","translation":"重复"}\n{broken}\n'
        yield '{"paragraphKey":"p2","translation":"第二段"}'

    server.runtime._translation_store = TranslationStore(str(tmp_path / "stream.db"))
    server.runtime._translation_stream_provider = provider
    server.runtime.TRANSLATION_PAIRING_CODE = "stream-pair"
    server.runtime._translation_pairing_used = False
    client = TestClient(server.app)
    origin = "chrome-extension://hihgkmkbdndlnbpleclokbijancgmiil"
    token = "s" * 64
    assert client.post("/translations/pair", headers={"Origin": origin}, json={
        "pairingCode": "stream-pair", "token": token,
    }).status_code == 200
    headers = {"Origin": origin, "Authorization": f"Bearer {token}"}
    payload = {
        "taskId": "task-1", "upstream": {"apiKey": "unused", "baseUrl": "https://example.test"},
        "sourceLanguage": "auto", "targetLanguage": "zh-CN", "configFingerprint": "fp-stream",
        "items": [
            {"paragraphKey": "p1", "recordKey": "r1", "originalText": "첫째",
             "recordPayload": _record_payload("p1", "첫째")},
            {"paragraphKey": "p2", "recordKey": "r2", "originalText": "둘째",
             "recordPayload": _record_payload("p2", "둘째")},
        ],
    }
    with client.stream("POST", "/translations/stream", headers=headers, json=payload) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        events = [json.loads(line) for line in response.iter_lines() if line]
    paragraphs = [event for event in events if event["type"] == "paragraph"]
    assert [event["paragraphKey"] for event in paragraphs] == ["p1", "p2"]
    assert paragraphs[0]["record"]["activeVersion"]["translatedText"] == "第一段"
    assert paragraphs[0]["record"]["activeVersionId"]
    assert [event for event in events if event["type"] == "error"]
    done = [event for event in events if event["type"] == "done"][0]
    assert done["completed"] == 2
    assert done["failed"] == 0
    assert done["protocolErrors"] == 1
    assert server.runtime._translation_store.query(["r1", "r2"])["records"]

    # 同一 taskId 重试由 operationId 幂等保护，不生成重复版本。
    with client.stream("POST", "/translations/stream", headers=headers, json=payload) as response:
        list(response.iter_lines())
    record = server.runtime._translation_store.query(["r1"])["records"][0]
    versions = server.runtime._translation_store.versions(record["recordId"])["versions"]
    assert len(versions) == 1
