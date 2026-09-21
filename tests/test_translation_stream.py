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


def test_stream_prompt_forbids_merging_neighbor_paragraphs():
    from types import SimpleNamespace

    from ocr_service.pipeline import translation_stream

    payload = SimpleNamespace(
        items=[
            {"paragraphKey": "p1", "originalText": "첫째"},
            {"paragraphKey": "p2", "originalText": "둘째"},
        ],
        glossary=[], context={}, sourceLanguage="auto", targetLanguage="zh-CN",
    )
    prompt = translation_stream._prompt(payload)
    assert "cover only its own paragraph" in prompt
    assert "never merge two paragraphs into one line" in prompt
    assert "never repeat a neighboring paragraph's translation" in prompt
    assert '"paragraphKey": "p1"' in prompt
    assert '"paragraphKey": "p2"' in prompt


def test_stream_prompt_carries_mandatory_glossary_rules_and_character_notes():
    """术语段必须与小批链路同一套硬规则,并带上角色备注。

    以前这里只有一句 `Required glossary: [...]`:没有「逐字照用/最长优先」的规则,
    也丢掉了条目备注(性别/年龄/身份/语气)。同一批术语在流式链路和小批链路上效果
    不一致,用户看到的就是「术语有时候不正确」。
    """
    from types import SimpleNamespace

    from ocr_service.pipeline import translation_stream

    payload = SimpleNamespace(
        items=[{"paragraphKey": "p1", "originalText": "레오나르도가 말했다."}],
        glossary=[
            {"source": "레오나르도", "target": "莱昂纳多", "note": "남성, 20대 기사"},
            {"source": "", "target": "空 source 必须丢掉"},
        ],
        context={}, sourceLanguage="ko", targetLanguage="zh-CN",
    )
    prompt = translation_stream._prompt(payload)
    assert "Mandatory terminology glossary:" in prompt
    assert "must contain its target string verbatim" in prompt
    assert "Never replace a glossary target with a synonym" in prompt
    assert "Apply the longest matching source term first" in prompt
    assert "Use notes to choose pronouns and voice" in prompt
    assert ('"source": "레오나르도", "target": "莱昂纳多", "note": "남성, 20대 기사"') in prompt
    assert "空 source 必须丢掉" not in prompt
    # 术语交代（used / skipped+理由）必须写进提示词，否则漏用术语查不出来
    assert "account for it in that line's `terms` object" in prompt
    assert "Never leave a matching row unaccounted for" in prompt
    assert '"terms":{"used":["…"],"skipped":[{"source":"…","reason":"…"}]}' in prompt


def test_stream_prompt_omits_the_glossary_block_when_there_are_no_terms():
    from types import SimpleNamespace

    from ocr_service.pipeline import translation_stream

    payload = SimpleNamespace(
        items=[{"paragraphKey": "p1", "originalText": "첫째"}],
        glossary=[], context={}, sourceLanguage="auto", targetLanguage="zh-CN",
    )
    prompt = translation_stream._prompt(payload)
    assert "Mandatory terminology glossary:" not in prompt
    assert "glossary" not in prompt
    assert "terms" not in prompt, "没有术语时不夹带术语交代的 schema"
    assert 'Schema: {"paragraphKey":"the supplied key","translation":"translated text"}' in prompt


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
    client = TestClient(server.app)
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
    with client.stream("POST", "/translations/stream", json=payload) as response:
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
    with client.stream("POST", "/translations/stream", json=payload) as response:
        list(response.iter_lines())
    record = server.runtime._translation_store.query(["r1"])["records"][0]
    versions = server.runtime._translation_store.versions(record["recordId"])["versions"]
    assert len(versions) == 1
