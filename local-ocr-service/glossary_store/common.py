from __future__ import annotations

import os
import sqlite3
import threading

SCHEMA_VERSION = 4
DEFAULT_SRC_LNG = "ko"
DEFAULT_TGT_LNG = "zh-CN"


def normalize_source(value: str) -> str:
    return value.strip().lower() if value else ""


def normalize_tgt_lng(value: str) -> str:
    v = (value or "").strip()
    if not v:
        return DEFAULT_TGT_LNG
    if "-" in v:
        return v
    # Map short codes: zh → zh-CN, ko → ko-KR, ja → ja-JP, en → en-US
    mapping = {"zh": "zh-CN", "ko": "ko-KR", "ja": "ja-JP", "en": "en-US"}
    return mapping.get(v.lower(), v)


def normalize_src_lng(value: str) -> str:
    value = (value or DEFAULT_SRC_LNG).strip()
    mapping = {"korean": "ko", "japan": "ja", "japanese": "ja", "english": "en"}
    return mapping.get(value.lower(), value)


def normalize_scope(scope_type: str, scope_key: str) -> tuple[str, str]:
    """Normalize glossary scope while keeping legacy rows global."""
    key = (scope_key or "").strip()[:160]
    return ("work", key) if scope_type in {"series", "work"} and key else ("global", "")


class GlossaryBase:
    def __init__(self, db_path: str) -> None:
        self._path = os.path.abspath(db_path)
        self._lock = threading.Lock()
        self._init_db()

    def _init_db(self) -> None:
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                cur_ver = 0
                try:
                    row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
                    if row:
                        cur_ver = int(row[0])
                except Exception:
                    pass
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
                        src_lng    TEXT NOT NULL DEFAULT 'ko',
                        tgt_lng    TEXT NOT NULL DEFAULT 'zh-CN',
                        note       TEXT NOT NULL DEFAULT '',
                        enabled    INTEGER NOT NULL DEFAULT 1,
                        source_key TEXT NOT NULL,
                        scope_type TEXT NOT NULL DEFAULT 'global',
                        scope_key  TEXT NOT NULL DEFAULT '',
                        scope_label TEXT NOT NULL DEFAULT '',
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
                if cur_ver < 2:
                    self._migrate_v2(conn)
                if cur_ver < 3:
                    self._migrate_v3(conn)
                if cur_ver < 4:
                    self._migrate_v4(conn)
                conn.execute(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
                    (str(SCHEMA_VERSION),),
                )
                conn.commit()
            finally:
                conn.close()

    @staticmethod
    def _migrate_v2(conn: sqlite3.Connection) -> None:
        """Add tgt_lng column and unique index (source_key, tgt_lng)."""
        cols = [r[1] for r in conn.execute("PRAGMA table_info(glossary_entries)").fetchall()]
        if "tgt_lng" not in cols:
            conn.execute("ALTER TABLE glossary_entries ADD COLUMN tgt_lng TEXT NOT NULL DEFAULT '" + DEFAULT_TGT_LNG + "'")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_glossary_tgt_lng ON glossary_entries(tgt_lng)")
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_glossary_unique ON glossary_entries(source_key, tgt_lng)")

    @staticmethod
    def _migrate_v3(conn: sqlite3.Connection) -> None:
        """Add per-series scope and replace the legacy uniqueness constraint."""
        cols = [r[1] for r in conn.execute("PRAGMA table_info(glossary_entries)").fetchall()]
        if "scope_type" not in cols:
            conn.execute("ALTER TABLE glossary_entries ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'global'")
        if "scope_key" not in cols:
            conn.execute("ALTER TABLE glossary_entries ADD COLUMN scope_key TEXT NOT NULL DEFAULT ''")
        if "scope_label" not in cols:
            conn.execute("ALTER TABLE glossary_entries ADD COLUMN scope_label TEXT NOT NULL DEFAULT ''")
        conn.execute("DROP INDEX IF EXISTS idx_glossary_unique")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_glossary_unique_scope "
            "ON glossary_entries(source_key, tgt_lng, scope_type, scope_key)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_glossary_scope ON glossary_entries(scope_type, scope_key)")

    @staticmethod
    def _migrate_v4(conn: sqlite3.Connection) -> None:
        """Add source language and make the language pair part of identity."""
        cols = [r[1] for r in conn.execute("PRAGMA table_info(glossary_entries)").fetchall()]
        if "src_lng" not in cols:
            conn.execute("ALTER TABLE glossary_entries ADD COLUMN src_lng TEXT NOT NULL DEFAULT 'ko'")
        conn.execute("UPDATE glossary_entries SET scope_type='work' WHERE scope_type='series'")
        conn.execute("DROP INDEX IF EXISTS idx_glossary_unique_scope")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_glossary_unique_language_scope "
            "ON glossary_entries(source_key, src_lng, tgt_lng, scope_type, scope_key)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_glossary_src_lng ON glossary_entries(src_lng)")
