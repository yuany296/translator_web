from __future__ import annotations

import json
import hashlib
import hmac
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from .schema import SCHEMA_VERSION, initialize_schema


class TranslationConflict(RuntimeError):
    pass


class TranslationNotFound(RuntimeError):
    pass


def _now_ms() -> int:
    return int(time.time() * 1000)


def _text(value: Any, limit: int = 100_000) -> str:
    return str(value or "")[:limit]


class TranslationStore:
    def __init__(self, path: str):
        self.path = str(Path(path))
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            initialize_schema(connection)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        return connection

    def pair(self, token: str, origin: str) -> None:
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "INSERT INTO translation_meta(key,value) VALUES('access_token_hash',?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (token_hash,)
            )
            connection.execute(
                "INSERT INTO translation_meta(key,value) VALUES('extension_origin',?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (origin,)
            )
            connection.commit()

    def verify_access(self, token: str, origin: str) -> bool:
        with self.connect() as connection:
            values = dict(connection.execute(
                "SELECT key,value FROM translation_meta WHERE key IN ('access_token_hash','extension_origin')"
            ).fetchall())
        expected_hash = values.get("access_token_hash", "")
        expected_origin = values.get("extension_origin", "")
        supplied_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        return bool(expected_hash and expected_origin and origin == expected_origin
                    and hmac.compare_digest(expected_hash, supplied_hash))

    @staticmethod
    def _next_change_seq(connection: sqlite3.Connection) -> int:
        row = connection.execute(
            "SELECT value FROM translation_meta WHERE key='change_seq'"
        ).fetchone()
        value = int(row[0] if row else 0) + 1
        connection.execute(
            "INSERT INTO translation_meta(key,value) VALUES('change_seq',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(value),)
        )
        return value

    @staticmethod
    def _global_change_seq(connection: sqlite3.Connection) -> int:
        row = connection.execute(
            "SELECT value FROM translation_meta WHERE key='change_seq'"
        ).fetchone()
        return int(row[0] if row else 0)

    @staticmethod
    def _version_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        return {
            "versionId": row["id"], "recordId": row["record_id"],
            "translatedText": row["translated_text"], "source": row["source"],
            "configFingerprint": row["config_fingerprint"],
            "revisionInstruction": row["revision_instruction"],
            "pinned": bool(row["pinned"]), "createdAt": row["created_at"],
            "deletedAt": row["deleted_at"],
        }

    def _snapshot(self, connection: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
        versions = connection.execute(
            "SELECT * FROM translation_versions WHERE record_id=? AND deleted_at IS NULL "
            "ORDER BY created_at DESC LIMIT 2", (row["id"],)
        ).fetchall()
        active = next((version for version in versions if version["id"] == row["active_version_id"]), None)
        if row["active_version_id"] and active is None:
            active = connection.execute(
                "SELECT * FROM translation_versions WHERE id=?", (row["active_version_id"],)
            ).fetchone()
        try:
            recovery = json.loads(row["recovery_json"] or "{}")
        except (TypeError, ValueError):
            recovery = {}
        return {
            "recordId": row["id"], "recordKey": row["record_key"],
            "mode": row["mode"], "scopeKey": row["scope_key"],
            "segmentKey": row["segment_key"], "workId": row["work_id"],
            "chapterId": row["chapter_id"], "pageKey": row["page_key"],
            "rawSourceText": row["raw_source_text"],
            "normalizedSourceText": row["normalized_source_text"],
            "rawSourceHash": row["raw_source_hash"],
            "normalizedSourceHash": row["normalized_source_hash"],
            "configuredSourceLanguage": row["configured_source_language"],
            "resolvedSourceLanguage": row["resolved_source_language"],
            "targetLanguage": row["target_language"],
            "bindingKey": row["binding_key"],
            "translationKey": row["translation_key"],
            "recovery": recovery,
            "activeVersionId": row["active_version_id"],
            "activeVersion": self._version_dict(active),
            "recentVersions": [self._version_dict(version) for version in versions],
            "recordRevision": row["record_revision"], "changeSeq": row["change_seq"],
            "createdAt": row["created_at"], "updatedAt": row["updated_at"],
            "deletedAt": row["deleted_at"],
            "deletedByOperationId": row["deleted_by_operation_id"],
        }

    @staticmethod
    def _record_by_identity(connection: sqlite3.Connection, operation: dict[str, Any]):
        record_id = _text(operation.get("recordId"), 80)
        record_key = _text(operation.get("recordKey"), 160)
        clause, value = ("id=?", (record_id,)) if record_id else ("record_key=?", (record_key,))
        return connection.execute(f"SELECT * FROM translation_records WHERE {clause}", value).fetchone()

    @staticmethod
    def _check_revision(row, operation: dict[str, Any], required: bool = False) -> None:
        expected = operation.get("expectedRecordRevision")
        if required and expected is None:
            raise TranslationConflict("expectedRecordRevision is required")
        if expected is not None and int(expected) != int(row["record_revision"]):
            raise TranslationConflict(
                f"record revision changed: expected {expected}, current {row['record_revision']}"
            )
        base_version = _text(operation.get("baseActiveVersionId"), 80)
        if base_version and base_version != _text(row["active_version_id"], 80):
            raise TranslationConflict("active version changed")

    def _ensure_record(self, connection, operation: dict[str, Any], payload: dict[str, Any]):
        row = self._record_by_identity(connection, operation)
        if row is not None:
            return row
        record_key = _text(operation.get("recordKey"), 160)
        if not record_key:
            raise ValueError("recordKey is required")
        scope_key = _text(payload.get("scopeKey"), 500)
        segment_key = _text(payload.get("segmentKey"), 200)
        if not scope_key or not segment_key:
            raise ValueError("scopeKey and segmentKey are required")
        source = _text(payload.get("resolvedSourceLanguage"), 24)
        target = _text(payload.get("targetLanguage"), 24)
        if not source or not target or source == target:
            raise ValueError("resolved source and target languages must differ")
        mode = _text(payload.get("mode"), 16)
        identity_where = "mode=? AND scope_key=? AND segment_key=? AND resolved_source_language=? AND target_language=?"
        identity_args = (mode, scope_key, segment_key, source, target)
        existing = connection.execute(
            f"SELECT * FROM translation_records WHERE {identity_where}", identity_args
        ).fetchone()
        if existing is not None:
            return existing
        now = _now_ms()
        record_id = str(uuid.uuid4())
        try:
            connection.execute(
                "INSERT INTO translation_records(id,record_key,mode,scope_key,segment_key,work_id,"
                "chapter_id,page_key,raw_source_text,normalized_source_text,raw_source_hash,"
                "normalized_source_hash,configured_source_language,resolved_source_language,"
                "target_language,binding_key,translation_key,recovery_json,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (record_id, record_key, mode, scope_key, segment_key,
                 _text(payload.get("workId"), 300), _text(payload.get("chapterId"), 300),
                 _text(payload.get("pageKey"), 2000), _text(payload.get("rawSourceText")),
                 _text(payload.get("normalizedSourceText")), _text(payload.get("rawSourceHash"), 160),
                 _text(payload.get("normalizedSourceHash"), 160),
                 _text(payload.get("configuredSourceLanguage") or source, 24), source, target,
                 _text(payload.get("bindingKey"), 160), _text(payload.get("translationKey"), 160),
                 json.dumps(payload.get("recovery") or {}, ensure_ascii=False)[:20_000], now, now),
            )
        except sqlite3.IntegrityError:
            # 多连接并发竞态：另一请求已插入同五元组，复用其记录。
            concurrent = connection.execute(
                f"SELECT * FROM translation_records WHERE {identity_where}", identity_args
            ).fetchone()
            if concurrent is None:
                raise
            return concurrent
        return connection.execute("SELECT * FROM translation_records WHERE id=?", (record_id,)).fetchone()

    def _create_version(self, connection, row, operation: dict[str, Any], payload: dict[str, Any]):
        translated = _text(payload.get("translatedText"))
        if not translated.strip():
            raise ValueError("translatedText is required")
        version_id = str(uuid.uuid4())
        now = _now_ms()
        connection.execute(
            "INSERT INTO translation_versions(id,record_id,translated_text,source," 
            "config_fingerprint,revision_instruction,pinned,created_at) VALUES(?,?,?,?,?,?,?,?)",
            (version_id, row["id"], translated, _text(payload.get("source") or "api", 32),
             _text(payload.get("configFingerprint"), 200),
             _text(payload.get("revisionInstruction"), 4000),
             1 if payload.get("pinned") is True else 0, now),
        )
        change_seq = self._next_change_seq(connection)
        connection.execute(
            "UPDATE translation_records SET active_version_id=?,record_revision=record_revision+1," 
            "change_seq=?,updated_at=?,deleted_at=NULL,deleted_by_operation_id=NULL WHERE id=?",
            (version_id, change_seq, now, row["id"]),
        )

    def _apply_mutation(self, connection, operation: dict[str, Any]) -> sqlite3.Row:
        kind = _text(operation.get("type"), 40)
        payload = operation.get("payload") if isinstance(operation.get("payload"), dict) else {}
        if kind in {"commit_translation", "edit"}:
            row = self._ensure_record(connection, operation, payload)
            self._check_revision(row, operation)
            self._create_version(connection, row, operation, {
                **payload, "source": payload.get("source") or ("manual" if kind == "edit" else "api")
            })
        else:
            row = self._record_by_identity(connection, operation)
            if row is None:
                raise TranslationNotFound("translation record not found")
            self._check_revision(row, operation, required=kind in {"delete", "select_version"})
            now = _now_ms()
            change_seq = self._next_change_seq(connection)
            if kind == "select_version":
                version_id = _text(payload.get("versionId"), 80)
                version = connection.execute(
                    "SELECT id FROM translation_versions WHERE id=? AND record_id=? AND deleted_at IS NULL",
                    (version_id, row["id"]),
                ).fetchone()
                if version is None:
                    raise TranslationNotFound("translation version not found")
                if payload.get("pinned") is True:
                    connection.execute(
                        "UPDATE translation_versions SET pinned=CASE WHEN id=? THEN 1 ELSE 0 END "
                        "WHERE record_id=?", (version_id, row["id"])
                    )
                connection.execute(
                    "UPDATE translation_records SET active_version_id=?,record_revision=record_revision+1," 
                    "change_seq=?,updated_at=? WHERE id=?", (version_id, change_seq, now, row["id"])
                )
            elif kind == "delete":
                connection.execute(
                    "UPDATE translation_records SET deleted_at=?,deleted_by_operation_id=?," 
                    "record_revision=record_revision+1,change_seq=?,updated_at=? WHERE id=?",
                    (now, operation["operationId"], change_seq, now, row["id"]),
                )
            else:
                raise ValueError(f"unsupported operation type: {kind}")
        return connection.execute(
            "SELECT * FROM translation_records WHERE id=?", (row["id"],)
        ).fetchone()

    def apply_operation(self, operation: dict[str, Any]) -> dict[str, Any]:
        return self.apply_operations([operation])[0]

    def apply_operations(self, operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not operations or len(operations) > 500:
            raise ValueError("operations must contain 1 to 500 items")
        responses = []
        with self.connect() as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("BEGIN IMMEDIATE")
            for operation in operations:
                responses.append(self._apply_operation_once(connection, operation))
            connection.commit()
        return responses

    def _apply_operation_once(self, connection, operation: dict[str, Any]) -> dict[str, Any]:
        operation_id = _text(operation.get("operationId"), 100)
        if not operation_id:
            raise ValueError("operationId is required")
        applied = connection.execute(
            "SELECT response_json FROM applied_operations WHERE operation_id=?", (operation_id,)
        ).fetchone()
        if applied is not None:
            return json.loads(applied[0])
        row = self._apply_mutation(connection, operation)
        response = {"ok": True, "operationId": operation_id,
                    "record": self._snapshot(connection, row), "changeSeq": self._global_change_seq(connection)}
        connection.execute(
            "INSERT INTO applied_operations(operation_id,response_json,created_at) VALUES(?,?,?)",
            (operation_id, json.dumps(response, ensure_ascii=False), _now_ms()),
        )
        return response

    def query(self, record_keys: list[str], include_deleted: bool = False) -> dict[str, Any]:
        keys = [_text(value, 160) for value in record_keys[:500] if _text(value, 160)]
        with self.connect() as connection:
            if not keys:
                return {"ok": True, "records": [], "changeSeq": self._global_change_seq(connection)}
            placeholders = ",".join("?" for _ in keys)
            deleted = "" if include_deleted else " AND deleted_at IS NULL"
            rows = connection.execute(
                f"SELECT * FROM translation_records WHERE record_key IN ({placeholders}){deleted}", keys
            ).fetchall()
            return {"ok": True, "records": [self._snapshot(connection, row) for row in rows],
                    "changeSeq": self._global_change_seq(connection)}

    def resolve_snapshot(self, record_id: str = "", record_key: str = "") -> dict[str, Any] | None:
        with self.connect() as connection:
            row = self._record_by_identity(connection, {"recordId": record_id, "recordKey": record_key})
            return self._snapshot(connection, row) if row is not None else None

    def versions(self, record_id: str) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM translation_records WHERE id=?", (_text(record_id, 80),)).fetchone()
            if row is None:
                raise TranslationNotFound("translation record not found")
            versions = connection.execute(
                "SELECT * FROM translation_versions WHERE record_id=? ORDER BY created_at DESC", (row["id"],)
            ).fetchall()
            return {"ok": True, "record": self._snapshot(connection, row),
                    "versions": [self._version_dict(version) for version in versions]}

    def export_data(self) -> dict[str, Any]:
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM translation_records WHERE deleted_at IS NULL").fetchall()
            return {"schemaVersion": SCHEMA_VERSION, "changeSeq": self._global_change_seq(connection),
                    "records": [self.versions(row["id"]) for row in rows]}

    def import_export_records(self, entries: list[dict[str, Any]]) -> dict[str, Any]:
        imported = []
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            for entry in entries[:5000]:
                snapshot = entry.get("record") if isinstance(entry, dict) else None
                versions = entry.get("versions") if isinstance(entry, dict) else None
                if not isinstance(snapshot, dict) or not isinstance(versions, list):
                    continue
                operation = {"recordKey": _text(snapshot.get("recordKey"), 160)}
                row = self._ensure_record(connection, operation, {
                    **snapshot,
                    "scopeKey": snapshot.get("scopeKey") or "import",
                    "segmentKey": snapshot.get("segmentKey") or snapshot.get("recordKey"),
                })
                version_map = {}
                for version in versions[:200]:
                    if not isinstance(version, dict):
                        continue
                    translated = _text(version.get("translatedText"))
                    old_id = _text(version.get("versionId") or version.get("id"), 80)
                    if not old_id or not translated.strip():
                        continue
                    collision = connection.execute(
                        "SELECT record_id FROM translation_versions WHERE id=?", (old_id,)
                    ).fetchone()
                    version_id = old_id if collision is None or collision[0] == row["id"] else str(uuid.uuid4())
                    connection.execute(
                        "INSERT OR IGNORE INTO translation_versions(id,record_id,translated_text,source," 
                        "config_fingerprint,revision_instruction,pinned,created_at,deleted_at) "
                        "VALUES(?,?,?,?,?,?,?,?,?)",
                        (version_id, row["id"], translated, _text(version.get("source") or "import", 32),
                         _text(version.get("configFingerprint"), 200),
                         _text(version.get("revisionInstruction"), 4000),
                         1 if version.get("pinned") is True else 0,
                         max(1, int(version.get("createdAt") or _now_ms())), version.get("deletedAt")),
                    )
                    version_map[old_id] = version_id
                active_id = version_map.get(_text(snapshot.get("activeVersionId"), 80))
                if not active_id and version_map:
                    active_id = next(iter(version_map.values()))
                if not active_id:
                    continue
                change_seq = self._next_change_seq(connection)
                connection.execute(
                    "UPDATE translation_records SET active_version_id=?,record_revision=record_revision+1," 
                    "change_seq=?,updated_at=?,deleted_at=?,deleted_by_operation_id=? WHERE id=?",
                    (active_id, change_seq, _now_ms(), snapshot.get("deletedAt"),
                     _text(snapshot.get("deletedByOperationId"), 100), row["id"]),
                )
                current = connection.execute(
                    "SELECT * FROM translation_records WHERE id=?", (row["id"],)
                ).fetchone()
                imported.append(self._snapshot(connection, current))
            connection.commit()
        return {"ok": True, "imported": len(imported), "records": imported,
                "changeSeq": max((row["changeSeq"] for row in imported), default=0)}
