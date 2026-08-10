from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

SERVICE_ROOT = Path(__file__).resolve().parents[1] / "local-ocr-service"
sys.path.insert(0, str(SERVICE_ROOT))

from translation_store import (  # noqa: E402
    TranslationConflict, TranslationStore,
)
from translation_store.dedupe import dedupe_translation_records  # noqa: E402


def record_payload(text: str = "译文") -> dict:
    return {
        "mode": "novel",
        "scopeKey": "kakao:book-1",
        "segmentKey": "paragraph-1",
        "workId": "book-1",
        "chapterId": "chapter-1",
        "rawSourceText": "원문",
        "normalizedSourceText": "원문",
        "rawSourceHash": "raw-hash",
        "normalizedSourceHash": "normalized-hash",
        "configuredSourceLanguage": "auto",
        "resolvedSourceLanguage": "ko",
        "targetLanguage": "zh-CN",
        "translatedText": text,
        "source": "api",
        "configFingerprint": "fp-1",
    }


def operation(operation_id: str, kind: str = "commit_translation", **extra) -> dict:
    return {
        "operationId": operation_id,
        "type": kind,
        "recordKey": "record-key-1",
        "payload": record_payload(),
        "createdAt": 1,
        **extra,
    }


def test_schema_uses_wal_foreign_keys_and_unique_identity(tmp_path):
    database_path = tmp_path / "translations.db"
    store = TranslationStore(str(database_path))
    with store.connect() as connection:
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        indexes = {row[1] for row in connection.execute("PRAGMA index_list(translation_records)")}
        assert "idx_translation_record_identity" in indexes
        connection.execute("PRAGMA foreign_keys=ON")
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO translation_versions(id,record_id,translated_text,source,created_at) "
                "VALUES('v','missing','x','api',1)"
            )


def test_schema_migrates_v2_database_before_creating_v3_index(tmp_path):
    database_path = tmp_path / "translations.db"
    with sqlite3.connect(database_path) as connection:
        connection.executescript("""
            CREATE TABLE translation_meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE translation_records (
              id TEXT PRIMARY KEY,
              record_key TEXT NOT NULL UNIQUE,
              mode TEXT NOT NULL,
              scope_key TEXT NOT NULL,
              segment_key TEXT NOT NULL,
              work_id TEXT NOT NULL DEFAULT '',
              chapter_id TEXT NOT NULL DEFAULT '',
              page_key TEXT NOT NULL DEFAULT '',
              raw_source_text TEXT NOT NULL,
              normalized_source_text TEXT NOT NULL,
              raw_source_hash TEXT NOT NULL,
              normalized_source_hash TEXT NOT NULL,
              configured_source_language TEXT NOT NULL,
              resolved_source_language TEXT NOT NULL,
              target_language TEXT NOT NULL,
              recovery_json TEXT NOT NULL DEFAULT '{}',
              active_version_id TEXT,
              record_revision INTEGER NOT NULL DEFAULT 0,
              change_seq INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              deleted_at INTEGER,
              deleted_by_operation_id TEXT
            );
            INSERT INTO translation_meta(key, value) VALUES('schema_version', '2');
        """)

    store = TranslationStore(str(database_path))

    with store.connect() as connection:
        columns = {
            row[1] for row in connection.execute("PRAGMA table_info(translation_records)")
        }
        indexes = {
            row[1] for row in connection.execute("PRAGMA index_list(translation_records)")
        }
        schema_version = connection.execute(
            "SELECT value FROM translation_meta WHERE key='schema_version'"
        ).fetchone()[0]
    assert {"binding_key", "translation_key"}.issubset(columns)
    assert "idx_translation_key" in indexes
    assert schema_version == "5"


def test_operation_is_idempotent_and_revisions_are_server_owned(tmp_path):
    store = TranslationStore(str(tmp_path / "translations.db"))
    first = store.apply_operation(operation("op-1"))
    repeated = store.apply_operation(operation("op-1"))
    assert repeated == first
    assert first["record"]["recordRevision"] == 1
    assert first["record"]["changeSeq"] == 1
    assert len(store.versions(first["record"]["recordId"])["versions"]) == 1

    edited = store.apply_operation(operation(
        "op-2", "edit", recordId=first["record"]["recordId"],
        expectedRecordRevision=1,
        baseActiveVersionId=first["record"]["activeVersionId"],
        payload={"translatedText": "人工译文", "source": "manual"},
    ))
    assert edited["record"]["recordRevision"] == 2
    assert edited["record"]["changeSeq"] == 2
    assert edited["record"]["activeVersion"]["source"] == "manual"


def test_dedupe_soft_deletes_duplicate_records_keeping_one(tmp_path):
    store = TranslationStore(str(tmp_path / "translations.db"))
    first = store.apply_operation(operation("op-1", recordKey="record-key-1"))["record"]
    # 同原文同译文、不同页面 scope（旧缓存键在不同页面产生的重复）
    second = store.apply_operation(operation(
        "op-2", recordKey="record-key-2",
        payload={**record_payload(), "scopeKey": "kakao:book-2"},
    ))["record"]
    assert second["recordId"] != first["recordId"]
    result = dedupe_translation_records(store)
    assert result["removed"] == 1
    assert result["total"] == 2
    alive = store.query(["record-key-1", "record-key-2"])["records"]
    assert len(alive) == 1
    # 不同译文的记录不合并
    store.apply_operation(operation(
        "op-3", recordKey="record-key-3",
        payload={**record_payload("不同译文"), "scopeKey": "kakao:book-3", "normalizedSourceHash": "other-hash"},
    ))
    assert dedupe_translation_records(store)["removed"] == 0


def test_select_pin_and_soft_delete_require_current_revision(tmp_path):
    store = TranslationStore(str(tmp_path / "translations.db"))
    first = store.apply_operation(operation("op-1"))["record"]
    second = store.apply_operation(operation(
        "op-2", "edit", recordId=first["recordId"],
        expectedRecordRevision=1,
        payload={"translatedText": "人工译文", "source": "manual"},
    ))["record"]
    selected = store.apply_operation(operation(
        "op-3", "select_version", recordId=first["recordId"],
        expectedRecordRevision=2,
        payload={"versionId": first["activeVersionId"], "pinned": True},
    ))["record"]
    assert selected["activeVersionId"] == first["activeVersionId"]
    assert selected["activeVersion"]["pinned"] is True

    with pytest.raises(TranslationConflict):
        store.apply_operation(operation(
            "op-delete-stale", "delete", recordId=first["recordId"],
            expectedRecordRevision=2, payload={},
        ))
    deleted = store.apply_operation(operation(
        "op-delete", "delete", recordId=first["recordId"],
        expectedRecordRevision=3, payload={},
    ))["record"]
    assert deleted["deletedAt"] is not None
    assert store.query(["record-key-1"])["records"] == []
    assert store.query(["record-key-1"], include_deleted=True)["records"][0]["recordRevision"] == 4


def test_select_version_requires_expected_revision(tmp_path):
    store = TranslationStore(str(tmp_path / "translations.db"))
    first = store.apply_operation(operation("op-1"))["record"]
    with pytest.raises(TranslationConflict):
        store.apply_operation(operation(
            "op-select-without-revision", "select_version", recordId=first["recordId"],
            payload={"versionId": first["activeVersionId"]},
        ))


def test_export_import_roundtrip_preserves_history_and_active_version(tmp_path):
    source = TranslationStore(str(tmp_path / "source.db"))
    first = source.apply_operation(operation("op-1"))["record"]
    edited = source.apply_operation(operation(
        "op-2", "edit", recordId=first["recordId"], expectedRecordRevision=1,
        payload={"translatedText": "人工译文", "source": "manual", "pinned": True},
    ))["record"]
    exported = source.export_data()

    target = TranslationStore(str(tmp_path / "target.db"))
    imported = target.import_export_records(exported["records"])
    assert imported["imported"] == 1
    record = target.query(["record-key-1"])["records"][0]
    assert record["activeVersion"]["translatedText"] == "人工译文"
    assert record["activeVersionId"] == edited["activeVersionId"]
    assert len(target.versions(record["recordId"])["versions"]) == 2


def test_batch_is_transactional(tmp_path):
    store = TranslationStore(str(tmp_path / "translations.db"))
    invalid = operation("op-2")
    invalid["recordKey"] = "record-key-2"
    invalid["payload"] = {**record_payload(), "segmentKey": "paragraph-2", "targetLanguage": "ko"}
    with pytest.raises(ValueError):
        store.apply_operations([operation("op-1"), invalid])
    assert store.query(["record-key-1", "record-key-2"])["records"] == []


def test_same_segment_with_different_record_key_reuses_existing_record(tmp_path):
    store = TranslationStore(str(tmp_path / "translations.db"))
    first = store.apply_operation(operation("op-1"))
    # 前端重复翻译同一段落时会生成新的 recordKey；唯一约束以
    # mode+scope+segment+语言 为准，不允许 INSERT 撞唯一索引。
    second = store.apply_operation(operation(
        "op-2", recordKey="record-key-2",
        payload={**record_payload(), "translatedText": "第二次译文"},
    ))
    assert second["record"]["recordId"] == first["record"]["recordId"]
    assert second["record"]["recordKey"] == "record-key-1"
    assert second["record"]["recordRevision"] == 2
    assert len(store.versions(first["record"]["recordId"])["versions"]) == 2


def test_rewriting_a_soft_deleted_segment_restores_the_record(tmp_path):
    store = TranslationStore(str(tmp_path / "translations.db"))
    first = store.apply_operation(operation("op-1"))
    store.apply_operation(operation(
        "op-2", "delete", recordId=first["record"]["recordId"],
        expectedRecordRevision=1, recordKey="record-key-1",
    ))
    restored = store.apply_operation(operation(
        "op-3", recordKey="record-key-3",
        payload={**record_payload(), "translatedText": "恢复后的译文"},
    ))
    assert restored["record"]["recordId"] == first["record"]["recordId"]
    assert restored["record"]["deletedAt"] is None
    assert restored["record"]["recordRevision"] >= 2


def test_rest_api_works_without_pairing_and_drops_legacy_pairing_table(tmp_path):
    database_path = tmp_path / "translations.db"
    with sqlite3.connect(database_path) as connection:
        connection.executescript("""
            CREATE TABLE translation_meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE paired_extensions (
              extension_origin TEXT PRIMARY KEY,
              access_token_hash TEXT NOT NULL,
              paired_at INTEGER NOT NULL
            );
            INSERT INTO translation_meta(key,value) VALUES('schema_version','4');
        """)
    store = TranslationStore(str(database_path))
    with store.connect() as connection:
        tables = {
            row[0] for row in connection.execute("SELECT name FROM sqlite_master")
        }
    assert "paired_extensions" not in tables

    from fastapi.testclient import TestClient
    import server

    server.runtime._translation_store = TranslationStore(str(tmp_path / "api.db"))
    client = TestClient(server.app)

    assert client.post("/translations/pair", json={
        "pairingCode": "000000", "token": "t" * 64,
    }).status_code == 404
    assert client.get("/translations/health").json()["ok"] is True
    committed = client.post("/translations/operations", json={
        "operations": [operation("rest-op-1")],
    }).json()["results"][0]["record"]
    conflict = client.post("/translations/operations", json={
        "operations": [operation(
            "rest-select-stale", "select_version", recordId=committed["recordId"],
            payload={"versionId": committed["activeVersionId"]},
        )],
    })
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["currentRecord"]["recordRevision"] == 1
