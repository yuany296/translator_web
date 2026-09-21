from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sys
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "local-ocr-service"
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from term_extractor import (  # noqa: E402
    extract_candidate_sentences,
    extract_term_candidates,
    extract_term_candidates_llm,
    extract_term_candidates_llm_with_stats,
    get_term_extractor_status,
)


class FakeResponse:
    def __init__(self, payload: Any, status_code: int = 200):
        self.payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload, ensure_ascii=False)

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> Any:
        return self.payload


class FakeClient:
    """httpx.Client stand-in recording requests."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    def __enter__(self) -> "FakeClient":
        return self

    def __exit__(self, *args: Any) -> None:
        return None

    def post(self, url: str, json=None, headers=None) -> FakeResponse:
        model = (json or {}).get("model") or ""
        content = self._answer_content(json or {})
        self.calls.append((url, model, json or {}))
        return FakeResponse({
            "choices": [{"message": {"content": content}}]
        })

    def get(self, url: str, headers=None) -> FakeResponse:
        self.calls.append((url, "", {}))
        return FakeResponse({"models": [{"name": "qwen2.5:7b"}, {"name": "qwen3:8b"}]})

    def _answer_content(self, body: dict[str, Any]) -> str:
        return json.dumps([{
            "source": "하이파이브",
            "kind": "group",
            "note": "男团",
            "suggestedTarget": "Hi-Five",
        }, {
            "source": "정다준",
            "kind": "person",
            "note": "角色",
            "suggestedTarget": "郑多俊",
        }], ensure_ascii=False)


def test_llm_extraction_parses_and_validates_candidates(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("httpx.Client", FakeClient)
    result = extract_term_candidates_llm(
        [{"id": "b1", "text": "정다준과 하이파이브가 출연했다."}],
        "http://127.0.0.1:11434/v1",
        "qwen2.5:7b",
        "",
    )
    by_source = {item["source"]: item for item in result}
    assert set(by_source) == {"하이파이브", "정다준"}
    assert by_source["하이파이브"]["kind"] == "group"
    assert by_source["하이파이브"]["note"] == "男团"
    assert by_source["하이파이브"]["suggestedTarget"] == "Hi-Five"
    assert by_source["정다준"]["evidenceIds"] == ["b1"]


def test_llm_extraction_sends_paired_translation(monkeypatch: pytest.MonkeyPatch) -> None:
    class RecordingClient(FakeClient):
        def post(self, url: str, json=None, headers=None) -> FakeResponse:
            self.last_body = json or {}
            return super().post(url, json=json, headers=headers)

    fake = RecordingClient()
    monkeypatch.setattr("httpx.Client", lambda *a, **k: fake)
    extract_term_candidates_llm(
        [{"id": "b1", "text": "정다준과 하이파이브가 출연했다.", "translatedText": "郑多俊和Hi-Five出演了。"}],
        "http://127.0.0.1:11434/v1",
        "qwen2.5:7b",
        "",
    )
    prompt = fake.last_body["messages"][1]["content"]
    assert "译文：郑多俊和Hi-Five出演了。" in prompt
    assert "suggestedTarget" in prompt
    assert "有参考译文时不得留空" in prompt


def test_llm_extraction_drops_hallucinated_and_invalid_kinds(monkeypatch: pytest.MonkeyPatch) -> None:
    class HallucinatingClient(FakeClient):
        def _answer_content(self, body: dict[str, Any]) -> str:
            return json.dumps([
                {"source": "김성현", "kind": "person", "note": "", "suggestedTarget": ""},
                {"source": "존재하지않는인물", "kind": "person", "note": "", "suggestedTarget": ""},
                {"source": "하이파이브", "kind": "common_noun", "note": "", "suggestedTarget": ""},
            ], ensure_ascii=False)

    monkeypatch.setattr("httpx.Client", HallucinatingClient)
    result = extract_term_candidates_llm(
        [{"id": "b1", "text": "김성현이 하이파이브를 소개했다."}],
        "http://127.0.0.1:11434/v1",
        "qwen2.5:7b",
        "",
    )
    assert [item["source"] for item in result] == ["김성현"]


def test_llm_extraction_keeps_unknown_kinds_as_proper_noun_with_stats(monkeypatch: pytest.MonkeyPatch) -> None:
    """自造 kind（character / 系统道具）不再整条丢掉 —— 那正是「术语老漏」的来源。

    以前 `kind not in VALID_KINDS: continue`：云模型写「人名」「character」这类取值时，
    条目光是被静默丢弃，用户什么也看不到。现在归一成 proper_noun 保留并计数。
    """
    from term_extractor import extract_term_candidates_llm_with_stats

    class CustomKindClient(FakeClient):
        def _answer_content(self, body: dict[str, Any]) -> str:
            return json.dumps([
                {"source": "정다준", "kind": "character", "note": "", "suggestedTarget": ""},
                {"source": "하이파이브", "kind": "系统道具", "note": "", "suggestedTarget": ""},
                {"source": "없는사람", "kind": "character", "note": "", "suggestedTarget": ""},
                {"source": "출연했다", "kind": "动词", "note": "", "suggestedTarget": ""},
            ], ensure_ascii=False)

    monkeypatch.setattr("httpx.Client", CustomKindClient)
    candidates, stats = extract_term_candidates_llm_with_stats(
        [{"id": "b1", "text": "정다준과 하이파이브가 출연했다."}],
        "http://127.0.0.1:11434/v1",
        "qwen2.5:7b",
        "",
    )
    assert {item["source"] for item in candidates} == {"정다준", "하이파이브"}
    assert {item["kind"] for item in candidates} == {"proper_noun"}
    assert stats["unknownKind"] == 3  # 含原文里没有的那条
    assert stats["notInSource"] == 1
    assert stats["invalidKind"] == 1


def test_llm_extraction_accepts_chinese_field_names_and_kinds(monkeypatch: pytest.MonkeyPatch) -> None:
    """中文提示词下模型常把字段名/kind 写成中文：归一化后必须能收到，不能整条丢。"""
    from term_extractor import extract_term_candidates_llm_with_stats

    class ChineseFieldsClient(FakeClient):
        def _answer_content(self, body: dict[str, Any]) -> str:
            return json.dumps([
                {"原文": "정다준", "类型": "人名", "译名": "郑多俊", "备注": "主角"},
            ], ensure_ascii=False)

    monkeypatch.setattr("httpx.Client", ChineseFieldsClient)
    candidates, stats = extract_term_candidates_llm_with_stats(
        [{"id": "b1", "text": "정다준이 말했다."}],
        "http://127.0.0.1:11434/v1",
        "qwen2.5:7b",
        "",
    )
    assert [(item["source"], item["kind"], item["suggestedTarget"]) for item in candidates] == [
        ("정다준", "person", "郑多俊")
    ]
    assert stats == {}


def test_llm_extraction_without_model_fails_clearly_for_remote_endpoint() -> None:
    """模型为空时不再静默退到 qwen2.5:7b：云端地址直接报错说清原因。

    以前会拿一个本地 Ollama 的模型名去打云端接口 —— 提取必然失败，而翻译照常，
    用户看到的是「翻译没事、术语一条都收不到」。
    """
    with pytest.raises(RuntimeError, match="未配置术语提取模型"):
        extract_term_candidates_llm(
            [{"id": "b1", "text": "정다준이 말했다."}],
            "https://api.example.com/v1",
            "",
            "k",
        )


def test_llm_extraction_chunks_long_text(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient()
    monkeypatch.setattr("httpx.Client", lambda *a, **k: fake)
    long_text = ("정다준이 말했다. " * 4000)[:35000]
    result = extract_term_candidates_llm(
        [{"id": "long", "text": long_text}],
        "http://127.0.0.1:11434/v1",
        "qwen2.5:7b",
        "",
    )
    assert len(fake.calls) > 1
    assert result


def test_llm_extraction_drops_source_taken_from_translated_text(monkeypatch: pytest.MonkeyPatch) -> None:
    """模型从「译文：」行抓中文词填进 source：必须丢弃，不能进入待确认区。"""

    class TranslatedSourceClient(FakeClient):
        def _answer_content(self, body: dict[str, Any]) -> str:
            return json.dumps([
                {"source": "郑多俊", "kind": "person", "note": "", "suggestedTarget": "郑多俊"},
                {"source": "정다준", "kind": "person", "note": "", "suggestedTarget": "郑多俊"},
            ], ensure_ascii=False)

    monkeypatch.setattr("httpx.Client", TranslatedSourceClient)
    result = extract_term_candidates_llm(
        [{"id": "b1", "text": "정다준이 말했다.", "translatedText": "郑多俊说道。"}],
        "http://127.0.0.1:11434/v1",
        "qwen2.5:7b",
        "",
    )
    assert [item["source"] for item in result] == ["정다준"]
    assert result[0]["suggestedTarget"] == "郑多俊"


def test_llm_extraction_swaps_reversed_source_and_target(monkeypatch: pytest.MonkeyPatch) -> None:
    """模型把 source/suggestedTarget 填反（source 是译文、target 是原文）：交换修正。"""

    class ReversedClient(FakeClient):
        def _answer_content(self, body: dict[str, Any]) -> str:
            return json.dumps([
                {"source": "郑多俊", "kind": "person", "note": "", "suggestedTarget": "정다준"},
            ], ensure_ascii=False)

    monkeypatch.setattr("httpx.Client", ReversedClient)
    result = extract_term_candidates_llm(
        [{"id": "b1", "text": "정다준이 말했다.", "translatedText": "郑多俊说道。"}],
        "http://127.0.0.1:11434/v1",
        "qwen2.5:7b",
        "",
    )
    assert [item["source"] for item in result] == ["정다준"]
    assert result[0]["suggestedTarget"] == "郑多俊"


def test_llm_extraction_source_with_trailing_josa_still_validated(monkeypatch: pytest.MonkeyPatch) -> None:
    """模型返回带结尾助词的 source（如 정다준이）：容忍助词后按原文校验。"""

    class JosaClient(FakeClient):
        def _answer_content(self, body: dict[str, Any]) -> str:
            return json.dumps([
                {"source": "정다준이", "kind": "person", "note": "", "suggestedTarget": "郑多俊"},
            ], ensure_ascii=False)

    monkeypatch.setattr("httpx.Client", JosaClient)
    result = extract_term_candidates_llm(
        [{"id": "b1", "text": "정다준이 말했다."}],
        "http://127.0.0.1:11434/v1",
        "qwen2.5:7b",
        "",
    )
    assert [item["source"] for item in result] == ["정다준이"]


def test_sentence_mode_finds_names_latin_and_bracketed() -> None:
    blocks = [
        {"id": "name", "text": "김성현이 말했다."},
        {"id": "latin", "text": "THE DAWN 무대가 시작됐다."},
        {"id": "bracket", "text": "【미다스의 손】이 울렸다."},
        {"id": "katakana", "text": "タナカさんが来た。"},
    ]
    result = extract_candidate_sentences(blocks)
    by_source = {item["source"]: item for item in result}
    assert by_source["김성현"]["kind"] == "person"
    assert by_source["김성현"]["evidenceIds"] == ["name"]
    assert by_source["THE DAWN"]["kind"] == "latin_title"
    assert by_source["미다스의 손"]["kind"] == "title"
    assert by_source["タナカ"]["kind"] == "latin_name"


def test_sentence_mode_repeated_phrases_are_sentence_only() -> None:
    blocks = [
        {"id": "a", "text": "하이파이브가 무대에 올랐다."},
        {"id": "b", "text": "하이파이브의 공연이 끝났다."},
        {"id": "c", "text": "하이파이브가 인사했다."},
    ]
    result = extract_candidate_sentences(blocks)
    candidate = next(item for item in result if item["source"] == "하이파이브")
    assert candidate["sentenceOnly"] is True
    assert candidate["score"] <= 0.5
    assert len(candidate["evidenceIds"]) == 3


def test_dispatch_uses_heuristic_without_upstream() -> None:
    blocks = [{"id": "a", "text": "김성현이 말했다."}]
    result = extract_term_candidates(blocks)
    assert result[0]["source"] == "김성현"
    assert result[0]["kind"] == "person"


def test_dispatch_uses_llm_with_upstream(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("httpx.Client", FakeClient)
    result = extract_term_candidates(
        [{"id": "a", "text": "정다준과 하이파이브가 출연했다."}],
        {"baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen2.5:7b", "apiKey": ""},
    )
    assert {item["source"] for item in result} == {"하이파이브", "정다준"}


def test_status_is_heuristic_without_base_url() -> None:
    status = get_term_extractor_status()
    assert status["available"] is True
    assert status["engine"] == "heuristic"


def test_status_probes_ollama_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient()
    monkeypatch.setattr("httpx.Client", lambda *a, **k: fake)
    status = get_term_extractor_status(check_runtime=True, base_url="http://127.0.0.1:11434/v1")
    assert status["available"] is True
    assert status["engine"] == "ollama"
    assert fake.calls[0][0].endswith("/models")


def test_extract_endpoint_heuristic_without_upstream() -> None:
    import server

    payload = server.TermExtractionRequest(blocks=[{"id": "b1", "text": "김성현이 말했다."}])
    result = asyncio.run(server.extract_terms(payload))
    assert result["engine"] == "heuristic"
    assert result["candidates"][0]["source"] == "김성현"


def test_extract_endpoint_llm_with_upstream(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    class RecordingClient(FakeClient):
        def post(self, url: str, json=None, headers=None) -> FakeResponse:
            self.last_body = json or {}
            return super().post(url, json=json, headers=headers)

    fake = RecordingClient()
    monkeypatch.setattr("httpx.Client", lambda *a, **k: fake)
    payload = server.TermExtractionRequest(
        blocks=[{"id": "b1", "text": "정다준과 하이파이브가 출연했다.", "translatedText": "郑多俊和Hi-Five出演了。"}],
        upstream=server.TermExtractionUpstream(
            baseUrl="http://127.0.0.1:11434/v1", model="qwen2.5:7b", apiKey=""
        ),
    )
    result = asyncio.run(server.extract_terms(payload))
    assert result["engine"] == "ollama"
    assert {item["source"] for item in result["candidates"]} == {"하이파이브", "정다준"}
    prompt = fake.last_body["messages"][1]["content"]
    assert "译文：郑多俊和Hi-Five出演了。" in prompt


def test_extract_endpoint_empty_blocks_returns_no_candidates() -> None:
    import server

    payload = server.TermExtractionRequest(blocks=[])
    result = asyncio.run(server.extract_terms(payload))
    assert result == {"ok": True, "engine": "heuristic", "candidates": []}
