"""Glossary SQLite database layer.

Stores glossary entries, pending candidates, and ignored terms persistently
on disk so they survive browser cache clears. Replaces chrome.storage.local
as the primary storage for the extension's glossary system.

Usage:
    db = GlossaryDB("glossary.db")
    db.add_entry("룰루", "露露", note="주인공")
    entries = db.get_entries()
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from typing import Any


SCHEMA_VERSION = 1


def _normalize_source(value: str) -> str:
    return value.strip().lower() if value else ""


class GlossaryDB:
    """Persistent glossary storage backed by SQLite."""

    def __init__(self, db_path: str) -> None:
        self._path = os.path.abspath(db_path)
        self._lock = threading.Lock()
        self._init_db()

    # ── schema ───────────────────────────────────────────────────

    def _init_db(self) -> None:
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                conn.executescript("""
                    PRAGMA journal_mode=WAL;
                    PRAGMA foreign_keys=ON;

                    CREATE TABLE IF NOT EXISTS meta (
                        key   TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS glossary_entries (
                        id         TEXT PRIMARY KEY,
                        source     TEXT NOT NULL,
                        target     TEXT NOT NULL,
                        note       TEXT NOT NULL DEFAULT '',
                        enabled    INTEGER NOT NULL DEFAULT 1,
                        source_key TEXT NOT NULL,
                        created_at REAL NOT NULL,
                        updated_at REAL NOT NULL
                    );

                    CREATE INDEX IF NOT EXISTS idx_glossary_source_key
                        ON glossary_entries(source_key);

                    CREATE TABLE IF NOT EXISTS pending_candidates (
                        id                TEXT PRIMARY KEY,
                        source            TEXT NOT NULL,
                        source_key        TEXT NOT NULL,
                        kind              TEXT NOT NULL DEFAULT 'proper_noun',
                        score             REAL NOT NULL DEFAULT 0.0,
                        occurrences       INTEGER NOT NULL DEFAULT 0,
                        evidence_ids      TEXT NOT NULL DEFAULT '[]',
                        contexts          TEXT NOT NULL DEFAULT '[]',
                        suggested_targets TEXT NOT NULL DEFAULT '[]',
                        suggested_target  TEXT NOT NULL DEFAULT '',
                        ambiguous         INTEGER NOT NULL DEFAULT 0,
                        chapter_key       TEXT NOT NULL DEFAULT '',
                        chapter_url       TEXT NOT NULL DEFAULT '',
                        chapter_title     TEXT NOT NULL DEFAULT '',
                        created_at        REAL NOT NULL,
                        updated_at        REAL NOT NULL
                    );

                    CREATE INDEX IF NOT EXISTS idx_pending_source_key
                        ON pending_candidates(source_key);

                    CREATE TABLE IF NOT EXISTS ignored_terms (
                        id         INTEGER PRIMARY KEY AUTOINCREMENT,
                        source     TEXT NOT NULL,
                        source_key TEXT NOT NULL,
                        ignored_at REAL NOT NULL
                    );

                    CREATE INDEX IF NOT EXISTS idx_ignored_source_key
                        ON ignored_terms(source_key);
                """)
                conn.execute(
                    "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)",
                    (str(SCHEMA_VERSION),),
                )
                conn.commit()
            finally:
                conn.close()

    # ── entries CRUD ─────────────────────────────────────────────

    def get_entries(
        self, search: str = "", enabled_only: bool = False
    ) -> list[dict[str, Any]]:
        """Return glossary entries, optionally filtered."""
        parts = ["SELECT id, source, target, note, enabled, source_key, created_at, updated_at FROM glossary_entries"]
        params: list[Any] = []
        where = []
        if enabled_only:
            where.append("enabled = 1")
        if search:
            where.append("(source LIKE ? OR target LIKE ? OR note LIKE ?)")
            like = f"%{search}%"
            params.extend([like, like, like])
        if where:
            parts.append("WHERE " + " AND ".join(where))
        parts.append("ORDER BY source_key ASC")
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                rows = conn.execute(" ".join(parts), params).fetchall()
                return [self._row_to_entry(r) for r in rows]
            finally:
                conn.close()

    def get_entry(self, entry_id: str) -> dict[str, Any] | None:
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                row = conn.execute(
                    "SELECT id, source, target, note, enabled, source_key, created_at, updated_at FROM glossary_entries WHERE id = ?",
                    (entry_id,),
                ).fetchone()
                return self._row_to_entry(row) if row else None
            finally:
                conn.close()

    def add_entry(
        self, source: str, target: str, note: str = "", enabled: bool = True, entry_id: str = ""
    ) -> str:
        """Add a new entry. Returns its ID."""
        if not source or not target:
            raise ValueError("source and target are required")
        now = time.time()
        src_key = _normalize_source(source)
        eid = entry_id or f"term-{now}-{hash(source)}"
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                conn.execute(
                    """INSERT OR REPLACE INTO glossary_entries
                       (id, source, target, note, enabled, source_key, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (eid, source.strip(), target.strip(), note.strip(),
                     1 if enabled else 0, src_key, now, now),
                )
                conn.commit()
            finally:
                conn.close()
        return eid

    def update_entry(self, entry_id: str, *, source: str = "", target: str = "",
                     note: str | None = None, enabled: bool | None = None) -> bool:
        """Update fields of an existing entry. Returns True if updated."""
        fields = []
        params: list[Any] = []
        if source:
            fields.append("source = ?")
            params.append(source.strip())
            fields.append("source_key = ?")
            params.append(_normalize_source(source))
        if target:
            fields.append("target = ?")
            params.append(target.strip())
        if note is not None:
            fields.append("note = ?")
            params.append(note.strip())
        if enabled is not None:
            fields.append("enabled = ?")
            params.append(1 if enabled else 0)
        if not fields:
            return False
        fields.append("updated_at = ?")
        params.append(time.time())
        params.append(entry_id)
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                cur = conn.execute(
                    f"UPDATE glossary_entries SET {', '.join(fields)} WHERE id = ?",
                    params,
                )
                conn.commit()
                return cur.rowcount > 0
            finally:
                conn.close()

    def delete_entry(self, entry_id: str) -> bool:
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                cur = conn.execute("DELETE FROM glossary_entries WHERE id = ?", (entry_id,))
                conn.commit()
                return cur.rowcount > 0
            finally:
                conn.close()

    def get_enabled_entries(self) -> list[dict[str, Any]]:
        return self.get_entries(enabled_only=True)

    def get_entry_count(self) -> int:
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                row = conn.execute("SELECT COUNT(*) FROM glossary_entries").fetchone()
                return row[0] if row else 0
            finally:
                conn.close()

    # ── pending candidates ───────────────────────────────────────

    def get_pending(self, chapter_key: str = "") -> list[dict[str, Any]]:
        parts = [
            "SELECT id, source, source_key, kind, score, occurrences, evidence_ids, contexts,"
            " suggested_targets, suggested_target, ambiguous, chapter_key, chapter_url, chapter_title,"
            " created_at, updated_at FROM pending_candidates"
        ]
        params: list[Any] = []
        if chapter_key:
            parts.append("WHERE chapter_key = ?")
            params.append(chapter_key)
        parts.append("ORDER BY score DESC, source_key ASC")
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                rows = conn.execute(" ".join(parts), params).fetchall()
                return [self._row_to_pending(r) for r in rows]
            finally:
                conn.close()

    def get_pending_count(self) -> int:
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                row = conn.execute("SELECT COUNT(*) FROM pending_candidates").fetchone()
                return row[0] if row else 0
            finally:
                conn.close()

    def get_pending_chapters(self) -> list[dict[str, Any]]:
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                rows = conn.execute(
                    """SELECT chapter_key, chapter_url, chapter_title,
                              MAX(updated_at) as updated_at,
                              COUNT(*) as candidate_count
                       FROM pending_candidates
                       GROUP BY chapter_key
                       ORDER BY updated_at DESC"""
                ).fetchall()
                return [
                    {"key": r[0], "url": r[1], "title": r[2],
                     "updatedAt": r[3], "candidateCount": r[4]}
                    for r in rows
                ]
            finally:
                conn.close()

    def add_pending(self, source: str, kind: str = "proper_noun", score: float = 0.0,
                    evidence_ids: list[str] | None = None,
                    contexts: list[dict[str, str]] | None = None,
                    suggested_targets: list[str] | None = None,
                    chapter_key: str = "", chapter_url: str = "",
                    chapter_title: str = "") -> str:
        now = time.time()
        src_key = _normalize_source(source)
        eid = f"pending-{now}-{hash(source)}"
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                conn.execute(
                    """INSERT OR REPLACE INTO pending_candidates
                       (id, source, source_key, kind, score, occurrences, evidence_ids, contexts,
                        suggested_targets, suggested_target, ambiguous,
                        chapter_key, chapter_url, chapter_title, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (eid, source.strip(), src_key, kind, score,
                     len(evidence_ids or []),
                     json.dumps(evidence_ids or [], ensure_ascii=False),
                     json.dumps(contexts or [], ensure_ascii=False),
                     json.dumps(suggested_targets or [], ensure_ascii=False),
                     (suggested_targets or [""])[0] if len(suggested_targets or []) == 1 else "",
                     1 if len(suggested_targets or []) > 1 else 0,
                     chapter_key, chapter_url, chapter_title, now, now),
                )
                conn.commit()
            finally:
                conn.close()
        return eid

    def confirm_pending(self, source: str, target: str) -> bool:
        """Move a pending candidate to glossary entries and remove from pending."""
        src_key = _normalize_source(source)
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                # Find matching pending
                row = conn.execute(
                    "SELECT source FROM pending_candidates WHERE source_key = ? LIMIT 1",
                    (src_key,),
                ).fetchone()
                if not row:
                    return False
                original_source = row[0]
                # Add to glossary
                now = time.time()
                eid = f"term-{now}-{hash(original_source)}"
                conn.execute(
                    """INSERT INTO glossary_entries
                       (id, source, target, note, enabled, source_key, created_at, updated_at)
                       VALUES (?, ?, ?, '', 1, ?, ?, ?)""",
                    (eid, original_source, target.strip(), src_key, now, now),
                )
                # Remove from pending
                conn.execute("DELETE FROM pending_candidates WHERE source_key = ?", (src_key,))
                conn.commit()
                return True
            finally:
                conn.close()

    def delete_pending(self, source: str) -> bool:
        src_key = _normalize_source(source)
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                cur = conn.execute(
                    "DELETE FROM pending_candidates WHERE source_key = ?", (src_key,))
                conn.commit()
                return cur.rowcount > 0
            finally:
                conn.close()

    # ── ignored terms ────────────────────────────────────────────

    def get_ignored(self) -> list[dict[str, Any]]:
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                rows = conn.execute(
                    "SELECT id, source, source_key, ignored_at FROM ignored_terms ORDER BY ignored_at DESC"
                ).fetchall()
                return [{"id": r[0], "source": r[1], "sourceKey": r[2], "ignoredAt": r[3]} for r in rows]
            finally:
                conn.close()

    def add_ignored(self, source: str) -> bool:
        src_key = _normalize_source(source)
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO ignored_terms (source, source_key, ignored_at) VALUES (?, ?, ?)",
                    (source.strip(), src_key, time.time()),
                )
                conn.commit()
                return True
            finally:
                conn.close()

    def remove_ignored(self, source: str) -> bool:
        src_key = _normalize_source(source)
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                cur = conn.execute(
                    "DELETE FROM ignored_terms WHERE source_key = ?", (src_key,))
                conn.commit()
                return cur.rowcount > 0
            finally:
                conn.close()

    # ── migration ────────────────────────────────────────────────

    def import_entries(self, entries: list[dict[str, Any]]) -> int:
        """Bulk import entries (from chrome.storage.local migration)."""
        count = 0
        now = time.time()
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                for entry in entries:
                    source = (entry.get("source") or "").strip()
                    target = (entry.get("target") or "").strip()
                    if not source or not target:
                        continue
                    eid = entry.get("id") or f"term-{now}-{hash(source)}"
                    conn.execute(
                        """INSERT OR IGNORE INTO glossary_entries
                           (id, source, target, note, enabled, source_key, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                        (eid, source, target, (entry.get("note") or "").strip(),
                         1 if entry.get("enabled") is not False else 0,
                         _normalize_source(source), now, now),
                    )
                    count += 1
                conn.commit()
            finally:
                conn.close()
        return count

    def export_json(self) -> dict[str, Any]:
        return {
            "entries": self.get_entries(),
            "pending": self.get_pending(),
            "ignored": self.get_ignored(),
            "exportedAt": time.time(),
        }

    # ── helpers ──────────────────────────────────────────────────

    @staticmethod
    def _row_to_entry(row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0],
            "source": row[1],
            "target": row[2],
            "note": row[3],
            "enabled": bool(row[4]),
            "sourceKey": row[5],
            "createdAt": row[6],
            "updatedAt": row[7],
        }

    @staticmethod
    def _row_to_pending(row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0],
            "source": row[1],
            "sourceKey": row[2],
            "kind": row[3],
            "score": row[4],
            "occurrences": row[5],
            "evidenceIds": json.loads(row[6] or "[]"),
            "contexts": json.loads(row[7] or "[]"),
            "suggestedTargets": json.loads(row[8] or "[]"),
            "suggestedTarget": row[9],
            "ambiguous": bool(row[10]),
            "chapterKey": row[11],
            "chapterUrl": row[12],
            "chapterTitle": row[13],
            "createdAt": row[14],
            "updatedAt": row[15],
        }
