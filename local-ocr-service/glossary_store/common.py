from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import time

SCHEMA_VERSION = 6
DEFAULT_SRC_LNG = "ko"
DEFAULT_TGT_LNG = "zh-CN"
DEFAULT_LIBRARY_ID = "default"
DEFAULT_LIBRARY_NAME = "默认术语库"
MAX_LIBRARY_NAME = 60
MAX_LIBRARY_URLS = 20


def normalize_source(value: str) -> str:
    return value.strip().lower() if value else ""


def normalize_library_id(value: str) -> str:
    """库标识只保留字母数字与 `-`/`_`；空值表示"未指定"，由调用方决定是否落到默认库。"""
    cleaned = "".join(ch for ch in (value or "").strip() if ch.isalnum() or ch in "-_")
    return cleaned[:60]


def normalize_library_name(value: str) -> str:
    return " ".join((value or "").split())[:MAX_LIBRARY_NAME] or DEFAULT_LIBRARY_NAME


_LIBRARY_URL_PATTERN_RE = re.compile(
    r"^(?:https?://)?(?:\*|[A-Za-z0-9.*\-]+)(?::\d+)?(?:/.*)?$"
)


def _looks_like_library_url_pattern(value: str) -> bool:
    """`*.google.com` / `google.com/mail/*` / `https://www.google.com/*` 这类通配写法。"""
    text = value.strip()
    if not text or "*" not in text or " " in text:
        return False
    return bool(_LIBRARY_URL_PATTERN_RE.match(text))


def normalize_library_urls(value) -> list[str]:
    """绑定网址只保存 `协议//主机/路径`（去查询串、片段与末尾斜杠）。

    通配模式（`*.google.com`、`google.com/mail/*`、`https://www.google.com/*`）原样保留：
    匹配由扩展侧做，服务端只负责存下来；不带协议的写法表示 http/https 都匹配。
    """
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            parsed = [value]
        value = parsed
    result: list[str] = []
    for item in value if isinstance(value, list) else []:
        raw = str(item or "").strip()
        if "*" in raw:
            pattern = raw.split("#", 1)[0].split("?", 1)[0].rstrip("/")
            if _looks_like_library_url_pattern(pattern) and pattern not in result:
                result.append(pattern)
            if len(result) >= MAX_LIBRARY_URLS:
                break
            continue
        if not raw.lower().startswith(("http://", "https://")):
            continue
        url = raw.split("#", 1)[0].split("?", 1)[0].rstrip("/")
        if url and url not in result:
            result.append(url)
        if len(result) >= MAX_LIBRARY_URLS:
            break
    return result


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
        # 可重入锁：条目写入会在持锁期间补建/查询术语库定义。
        self._lock = threading.RLock()
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

                    CREATE TABLE IF NOT EXISTS glossary_libraries (
                        id         TEXT PRIMARY KEY,
                        name       TEXT NOT NULL,
                        enabled    INTEGER NOT NULL DEFAULT 1,
                        urls       TEXT NOT NULL DEFAULT '[]',
                        apply_urls TEXT NOT NULL DEFAULT '[]',
                        created_at REAL NOT NULL,
                        updated_at REAL NOT NULL
                    );

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
                if cur_ver < 5:
                    self._migrate_v5(conn)
                if cur_ver < 6:
                    self._migrate_v6(conn)
                # 默认库必须始终存在：新库、旧库迁移、以及被手工删空的情况都要补回。
                now = time.time()
                conn.execute(
                    "INSERT OR IGNORE INTO glossary_libraries "
                    "(id, name, enabled, urls, created_at, updated_at) VALUES (?, ?, 1, '[]', ?, ?)",
                    (DEFAULT_LIBRARY_ID, DEFAULT_LIBRARY_NAME, now, now),
                )
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

    @staticmethod
    def _migrate_v5(conn: sqlite3.Connection) -> None:
        """Add term libraries: existing entries and pending candidates join the default library."""
        cols = [r[1] for r in conn.execute("PRAGMA table_info(glossary_entries)").fetchall()]
        if "library_id" not in cols:
            conn.execute(
                "ALTER TABLE glossary_entries ADD COLUMN library_id TEXT NOT NULL DEFAULT '"
                + DEFAULT_LIBRARY_ID + "'"
            )
        pending_cols = [r[1] for r in conn.execute("PRAGMA table_info(pending_candidates)").fetchall()]
        if "library_id" not in pending_cols:
            conn.execute(
                "ALTER TABLE pending_candidates ADD COLUMN library_id TEXT NOT NULL DEFAULT '"
                + DEFAULT_LIBRARY_ID + "'"
            )
        conn.execute("UPDATE glossary_entries SET library_id = ? WHERE library_id = ''", (DEFAULT_LIBRARY_ID,))
        # 新唯一索引比旧索引多一列（library_id），旧索引严格更窄，因此重建不会因重复行失败。
        conn.execute("DROP INDEX IF EXISTS idx_glossary_unique_language_scope")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_glossary_unique_library_language_scope "
            "ON glossary_entries(source_key, src_lng, tgt_lng, scope_type, scope_key, library_id)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_glossary_library ON glossary_entries(library_id)")

    @staticmethod
    def _migrate_v6(conn: sqlite3.Connection) -> None:
        """Add apply_urls to glossary_libraries: empty list means the library applies on every page."""
        cols = [r[1] for r in conn.execute("PRAGMA table_info(glossary_libraries)").fetchall()]
        if "apply_urls" not in cols:
            conn.execute("ALTER TABLE glossary_libraries ADD COLUMN apply_urls TEXT NOT NULL DEFAULT '[]'")
