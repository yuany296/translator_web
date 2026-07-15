from __future__ import annotations

import os
import sqlite3
import threading

SCHEMA_VERSION = 1


def normalize_source(value: str) -> str:
    return value.strip().lower() if value else ""


class GlossaryBase:
    def __init__(self, db_path: str) -> None:
        self._path = os.path.abspath(db_path)
        self._lock = threading.Lock()
        self._init_db()

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
