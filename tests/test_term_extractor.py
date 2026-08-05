from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
import sys

import pytest
from fastapi import HTTPException


ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "local-ocr-service"
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from term_extractor import extract_term_candidates  # noqa: E402


@dataclass
class FakeToken:
    form: str
    tag: str
    start: int
    len: int


class FakeKiwi:
    def tokenize(self, text: str) -> list[FakeToken]:
        fixtures = {
            "김성현": [FakeToken("김성현", "NNP", 0, 3)],
            "김솔음": [FakeToken("김", "NNP", 0, 1), FakeToken("솔", "NNG", 1, 1), FakeToken("음", "EF", 2, 1)],
            "서호윤": [FakeToken("서호윤", "NNP", 0, 3)],
            "오리엔테": [FakeToken("오리엔테", "NNG", 0, 4)],
            "샤이닝 스타": [FakeToken("샤이닝", "NNP", 0, 3), FakeToken("스타", "NNG", 4, 2)],
            "정다준 성인": [FakeToken("정다준", "NNP", 0, 3), FakeToken("성인", "NNG", 4, 2)],
            "연습 시간": [FakeToken("연습", "NNG", 0, 2), FakeToken("시간", "NNG", 3, 2)],
            "평범한 말입니다": [
                FakeToken("평범", "NNG", 0, 2),
                FakeToken("하", "XSA", 2, 1),
                FakeToken("말", "NNG", 4, 1),
                FakeToken("이", "VCP", 5, 1),
            ],
        }
        return fixtures.get(text, [])


def test_balanced_extractor_finds_names_and_titles_but_rejects_pd() -> None:
    blocks = [
        {"id": "b1", "text": "김성현"},
        {"id": "b2", "text": "서호윤"},
        {"id": "b3", "text": "THE DAWN"},
        {"id": "b4", "text": "샤이닝 스타"},
        {"id": "b5", "text": "PD"},
    ]
    result = extract_term_candidates(blocks, analyzer=FakeKiwi())

    assert [item["source"] for item in result] == ["김성현", "서호윤", "THE DAWN", "샤이닝 스타"]
    assert all(item["evidenceIds"] for item in result)


def test_balanced_extractor_rejects_ordinary_sentence_and_keeps_reviewable_noun_phrase() -> None:
    blocks = [
        {"id": "ordinary", "text": "평범한 말입니다"},
        {"id": "phrase", "text": "연습 시간"},
        {"id": "number", "text": "2026"},
    ]
    result = extract_term_candidates(blocks, analyzer=FakeKiwi())

    assert [item["source"] for item in result] == ["연습 시간"]


def test_mixed_person_plus_common_noun_group_is_rejected_but_pure_name_survives() -> None:
    blocks = [
        {"id": "mixed", "text": "정다준 성인"},
        {"id": "name", "text": "김성현"},
    ]
    result = extract_term_candidates(blocks, analyzer=FakeKiwi())

    assert [item["source"] for item in result] == ["김성현"]


def test_real_kiwi_rejects_person_plus_common_noun_glue() -> None:
    result = extract_term_candidates(
        [{"id": "glue", "text": "으아앜!! 정다준 성인되기 59초 전!!"}],
    )

    assert all("정다준 성인" != item["source"] for item in result)


def test_person_structure_keeps_the_full_name_and_rejects_four_syllable_loanword() -> None:
    result = extract_term_candidates(
        [
            {"id": "name", "text": "김솔음"},
            {"id": "loanword", "text": "오리엔테"},
        ],
        analyzer=FakeKiwi(),
    )

    assert result == [{"source": "김솔음", "kind": "person", "score": 0.94, "evidenceIds": ["name"]}]


def test_extractor_merges_repeated_evidence_without_losing_full_and_short_names() -> None:
    blocks = [
        {"id": "full", "text": "김성현"},
        {"id": "repeat", "text": "김성현"},
        {"id": "short", "text": "성현"},
    ]
    kiwi = FakeKiwi()
    kiwi.tokenize = lambda text: [FakeToken(text, "NNP", 0, len(text))]
    result = extract_term_candidates(blocks, analyzer=kiwi)
    by_source = {item["source"]: item for item in result}

    assert set(by_source) == {"김성현", "성현"}
    assert by_source["김성현"]["evidenceIds"] == ["full", "repeat"]


def test_real_kiwi_learns_short_name_from_full_name_without_accepting_common_nouns() -> None:
    result = extract_term_candidates(
        [
            {"id": "short", "text": "성현"},
            {"id": "full", "text": "김성현"},
            {"id": "occupation", "text": "마법사"},
            {"id": "school", "text": "학교"},
            {"id": "split-name", "text": "김솔음"},
            {"id": "loanword", "text": "오리엔테"},
        ]
    )

    assert {item["source"] for item in result} == {"김성현", "성현", "김솔음"}


def test_extract_endpoint_returns_503_when_kiwi_cannot_load(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setattr(
        server,
        "get_term_extractor_status",
        lambda check_runtime=True: {"available": False, "engine": "kiwi", "error": "broken dictionary"},
    )
    payload = server.TermExtractionRequest(blocks=[{"id": "b1", "text": "김성현"}])

    with pytest.raises(HTTPException) as caught:
        asyncio.run(server.extract_terms(payload))

    assert caught.value.status_code == 503
    assert "broken dictionary" in str(caught.value.detail)


def test_extract_endpoint_returns_candidates_without_a_translation(monkeypatch: pytest.MonkeyPatch) -> None:
    import server

    monkeypatch.setattr(
        server,
        "get_term_extractor_status",
        lambda check_runtime=True: {"available": True, "engine": "kiwi", "error": ""},
    )
    monkeypatch.setattr(
        server,
        "extract_term_candidates",
        lambda blocks, analyzer=None, user_terms=None: [
            {"source": "THE DAWN", "kind": "latin_title", "score": 0.9, "evidenceIds": ["b1"]}
        ],
    )
    payload = server.TermExtractionRequest(blocks=[{"id": "b1", "text": "THE DAWN"}])

    result = asyncio.run(server.extract_terms(payload))

    assert result["engine"] == "kiwi"
    assert result["candidates"][0] == {
        "source": "THE DAWN",
        "kind": "latin_title",
        "score": 0.9,
        "evidenceIds": ["b1"],
    }
    assert "target" not in result["candidates"][0]
