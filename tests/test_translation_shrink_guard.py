from __future__ import annotations

import sys
from pathlib import Path

import pytest

SERVICE_ROOT = Path(__file__).resolve().parents[1] / "local-ocr-service"
sys.path.insert(0, str(SERVICE_ROOT))

from translation_store import TranslationStore  # noqa: E402

# 真实事故：同一条原文，完整译文先写入，随后被流式截尾的短译文覆盖。
SOURCE = "어트랙션 안내에는 이 테마파크 관련 내용이 담겨 있다고 하더군요."
FULL = "听说游乐设施指南里包含这个主题公园的相关内容。"
TRUNCATED = "游乐设施"


def payload(text: str, source: str = SOURCE, kind: str = "api") -> dict:
    return {
        "mode": "comic",
        "scopeKey": "comic:bb95fb7d",
        "segmentKey": "canonical_2bede0c8914cf1",
        "pageKey": "https://page.kakao.com/content/1/viewer/2/",
        "rawSourceText": source,
        "normalizedSourceText": source,
        "rawSourceHash": "raw-hash",
        "normalizedSourceHash": "normalized-hash",
        "configuredSourceLanguage": "auto",
        "resolvedSourceLanguage": "ko",
        "targetLanguage": "zh-CN",
        "translatedText": text,
        "source": kind,
        "configFingerprint": "fp-1",
    }


def commit(store: TranslationStore, operation_id: str, value: dict) -> dict:
    return store.apply_operation({
        "operationId": operation_id,
        "type": "commit_translation",
        "recordKey": "record-key-1",
        "payload": value,
        "createdAt": 1,
    })


def export_record(store: TranslationStore) -> dict:
    entry = store.export_data()["records"][0]
    assert entry["ok"] is True
    return entry


def active_text(store: TranslationStore) -> str:
    entry = export_record(store)
    active_id = entry["record"]["activeVersionId"]
    return next(version["translatedText"] for version in entry["versions"] if version["versionId"] == active_id)


def version_texts(store: TranslationStore) -> list[str]:
    return [version["translatedText"] for version in export_record(store)["versions"]]


def test_truncated_api_translation_does_not_replace_complete_version(tmp_path, monkeypatch):
    monkeypatch.delenv("TRANSLATION_SHRINK_GUARD", raising=False)
    store = TranslationStore(str(tmp_path / "translations.db"))

    commit(store, "op-1", payload(FULL))
    assert active_text(store) == FULL

    commit(store, "op-2", payload(TRUNCATED))

    assert active_text(store) == FULL, "被截尾的自动译文不得覆盖完整版本"
    assert TRUNCATED in version_texts(store), "短译文仍要留在历史里便于排查"


def test_manual_edit_still_wins_even_if_shorter(tmp_path, monkeypatch):
    monkeypatch.delenv("TRANSLATION_SHRINK_GUARD", raising=False)
    store = TranslationStore(str(tmp_path / "translations.db"))

    commit(store, "op-1", payload(FULL))
    store.apply_operation({
        "operationId": "op-2",
        "type": "edit",
        "recordKey": "record-key-1",
        "payload": payload(TRUNCATED, kind="manual"),
        "createdAt": 2,
    })

    assert active_text(store) == TRUNCATED


def test_short_sources_are_not_guarded(tmp_path, monkeypatch):
    """短句本来就容易「更短更好」，不能一刀切拦掉。"""
    monkeypatch.delenv("TRANSLATION_SHRINK_GUARD", raising=False)
    store = TranslationStore(str(tmp_path / "translations.db"))

    commit(store, "op-1", payload("你好啊", source="안녕하세요"))
    commit(store, "op-2", payload("你好", source="안녕하세요"))

    assert active_text(store) == "你好"


def test_guard_can_be_disabled_by_env(tmp_path, monkeypatch):
    monkeypatch.setenv("TRANSLATION_SHRINK_GUARD", "0")
    store = TranslationStore(str(tmp_path / "translations.db"))

    commit(store, "op-1", payload(FULL))
    commit(store, "op-2", payload(TRUNCATED))

    assert active_text(store) == TRUNCATED


def test_comparable_length_retranslation_still_replaces(tmp_path, monkeypatch):
    monkeypatch.delenv("TRANSLATION_SHRINK_GUARD", raising=False)
    store = TranslationStore(str(tmp_path / "translations.db"))

    commit(store, "op-1", payload(FULL))
    better = "游乐设施指南里包含这个主题公园的相关内容"
    commit(store, "op-2", payload(better))

    assert active_text(store) == better


def test_first_truncated_translation_never_becomes_active(tmp_path, monkeypatch):
    """首次写入没有旧值可比：37 字符原句回 4 个字不得成为启用版本。"""
    monkeypatch.delenv("TRANSLATION_SHRINK_GUARD", raising=False)
    store = TranslationStore(str(tmp_path / "translations.db"))

    commit(store, "op-1", payload(TRUNCATED))

    entry = export_record(store)
    assert not entry["record"]["activeVersionId"], "截尾的首次译文不得设为启用版本"
    assert TRUNCATED in version_texts(store), "候选仍要留在历史里便于排查"


def test_first_reasonable_translation_is_activated(tmp_path, monkeypatch):
    """长原文的合理译文、以及短句，都要正常成为启用版本。"""
    monkeypatch.delenv("TRANSLATION_SHRINK_GUARD", raising=False)
    store = TranslationStore(str(tmp_path / "translations.db"))

    commit(store, "op-1", payload(FULL))
    assert active_text(store) == FULL

    short = TranslationStore(str(tmp_path / "translations-2.db"))
    commit(short, "op-1", payload("你好", source="안녕하세요"))
    assert active_text(short) == "你好"


def test_implausibly_short_candidate_is_not_activated_even_with_a_previous_version(
    tmp_path, monkeypatch
):
    """有旧版本时同样要拦「原文很长、只回几个字」。

    旧值本身可能就是上一轮的截尾值，拿它当 60% 基准是比不出来的：这条以前会落到
    「没短到 60% → 允许替换」的分支，把截尾值设成启用版本。
    """
    monkeypatch.delenv("TRANSLATION_SHRINK_GUARD", raising=False)
    store = TranslationStore(str(tmp_path / "translations.db"))

    previous = "听说游乐设施"  # 6 字：自身不算「不成比例」，所以能正常启用
    commit(store, "op-1", payload(previous))
    assert active_text(store) == previous

    commit(store, "op-2", payload(TRUNCATED))  # 37 字原文回 4 字，且没短到旧值的 60%
    assert active_text(store) == previous, "不成比例的候选不得成为启用版本"
    assert TRUNCATED in version_texts(store), "候选仍要留在历史里便于排查"


def test_implausibly_short_candidate_does_not_overwrite_a_manual_version(tmp_path, monkeypatch):
    """旧值是人工编辑时也一样：截尾值不得顶掉人工译文。"""
    monkeypatch.delenv("TRANSLATION_SHRINK_GUARD", raising=False)
    store = TranslationStore(str(tmp_path / "translations.db"))

    manual = "听说游乐设施指南里包含这个主题公园的相关内容。"
    store.apply_operation({
        "operationId": "op-1",
        "type": "edit",
        "recordKey": "record-key-1",
        "payload": payload(manual, kind="manual"),
        "createdAt": 1,
    })
    assert active_text(store) == manual

    commit(store, "op-2", payload(TRUNCATED))
    assert active_text(store) == manual, "人工译文必须守住"
    assert TRUNCATED in version_texts(store)
