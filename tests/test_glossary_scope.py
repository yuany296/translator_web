from __future__ import annotations

from pathlib import Path
import sqlite3
import sys
import time


ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "local-ocr-service"
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from glossary_db import GlossaryDB  # noqa: E402


def test_glossary_keeps_global_and_per_book_entries(tmp_path: Path) -> None:
    database = GlossaryDB(str(tmp_path / "scope.db"))
    global_entry = database.upsert_entry("성현", "成贤")
    book_entry = database.upsert_entry(
        "성현", "晟玄", scope_type="series",
        scope_key="kakao:65171279", scope_label="测试作品",
    )

    assert global_entry["scope"] == "global"
    assert book_entry["scope"] == "series"
    assert book_entry["scopeKey"] == "kakao:65171279"
    assert {entry["target"] for entry in database.get_entries()} == {"成贤", "晟玄"}


def test_v2_database_migrates_existing_terms_to_global_scope(tmp_path: Path) -> None:
    path = tmp_path / "legacy.db"
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta (key, value) VALUES ('schema_version', '2');
        CREATE TABLE glossary_entries (
            id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL,
            tgt_lng TEXT NOT NULL DEFAULT 'zh-CN', note TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1, source_key TEXT NOT NULL,
            created_at REAL NOT NULL, updated_at REAL NOT NULL
        );
        CREATE UNIQUE INDEX idx_glossary_unique
            ON glossary_entries(source_key, tgt_lng);
        """
    )
    now = time.time()
    connection.execute(
        "INSERT INTO glossary_entries VALUES (?,?,?,?,?,?,?,?,?)",
        ("legacy", "성현", "成贤", "zh-CN", "", 1, "성현", now, now),
    )
    connection.commit()
    connection.close()

    database = GlossaryDB(str(path))
    migrated = database.get_entry("legacy")
    assert migrated is not None
    assert migrated["scope"] == "global"
    database.upsert_entry(
        "성현", "晟玄", scope_type="series", scope_key="kakao:1"
    )
    assert database.get_entry_count() == 2
