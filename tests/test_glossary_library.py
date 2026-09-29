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
from glossary_store.common import (  # noqa: E402
    DEFAULT_LIBRARY_ID,
    DEFAULT_LIBRARY_NAME,
    SCHEMA_VERSION,
    normalize_library_urls,
)


def test_fresh_database_starts_with_only_the_default_library(tmp_path: Path) -> None:
    database = GlossaryDB(str(tmp_path / "fresh.db"))
    libraries = database.list_libraries()

    assert SCHEMA_VERSION == 6
    assert [library["id"] for library in libraries] == [DEFAULT_LIBRARY_ID]
    assert libraries[0]["name"] == DEFAULT_LIBRARY_NAME
    assert libraries[0]["enabled"] is True
    assert libraries[0]["urls"] == []
    assert libraries[0]["applyUrls"] == []
    # 没有指定库的旧式写入自动落到默认库
    entry = database.upsert_entry("성현", "成贤")
    assert entry["libraryId"] == DEFAULT_LIBRARY_ID
    assert database.get_entries(library_id=DEFAULT_LIBRARY_ID)[0]["id"] == entry["id"]


def test_library_apply_urls_survive_the_server_roundtrip(tmp_path: Path) -> None:
    """应用网址与绑定网址同一套通配语义，且留空表示全站生效。"""
    database = GlossaryDB(str(tmp_path / "apply.db"))
    created = database.upsert_library(
        "novel-1", "骸骨皇女", True,
        ["https://page.kakao.com/content/69299983/"],
        ["*.google.com", "https://page.kakao.com/content/69299983/*"],
    )
    assert created["applyUrls"] == ["*.google.com", "https://page.kakao.com/content/69299983/*"]

    updated = database.upsert_library("novel-1", "骸骨皇女", True, [], [])
    assert updated["applyUrls"] == []
    assert database.get_library("novel-1")["applyUrls"] == []


def test_target_language_codes_are_upgraded_and_round_trip(tmp_path: Path) -> None:
    """扩展侧发短码 ja，服务端升格成 ja-JP 落库并原样回传；折回短码由扩展侧负责。

    这是跨端契约的一端：extension/src/shared/languages.js 的别名表必须能把这里
    产出的 ja-JP / ko-KR / en-US 折回 ja / ko / en（同步断言见
    tests/glossary_language_codes.test.mjs）。不做归一，扩展侧的严格相等比较会
    把这些词条整库滤掉。
    """
    database = GlossaryDB(str(tmp_path / "target-lang.db"))
    entry = database.upsert_entry("지오", "地奥", tgt_lng="ja", src_lng="ko")
    assert entry["targetLanguage"] == "ja-JP"
    assert entry["tgtLng"] == "ja-JP"
    assert entry["tgt_lng"] == "ja-JP"

    # 身份键用的是升格后的值：同一条短码再写一次不得产生第二行
    again = database.upsert_entry("지오", "地奥", tgt_lng="ja-JP", src_lng="ko")
    assert again["id"] == entry["id"]
    assert len(database.get_entries(tgt_lng="ja")) == 1
    assert len(database.get_entries(tgt_lng="ja-JP")) == 1


def test_library_urls_normalize_query_hash_and_trailing_slash() -> None:
    urls = normalize_library_urls([
        "https://page.kakao.com/content/69299983/?tab=episodes#list",
        "https://page.kakao.com/content/69299983",
        "ftp://page.kakao.com/content/1",
        "   ",
    ])
    assert urls == ["https://page.kakao.com/content/69299983"]


def test_library_url_wildcards_survive_the_server_roundtrip() -> None:
    """通配写法（沉浸式翻译那套）必须原样存下来，否则同步一次就被服务端吃掉。"""
    urls = normalize_library_urls([
        "*.google.com",
        "google.com/mail/*",
        "https://www.google.com/*?hl=zh#top",
        "*.google.com",
        "随便*写点什么",
        "ftp://*.google.com",
        "https://page.kakao.com/content/69299983",
    ])
    assert urls == [
        "*.google.com",
        "google.com/mail/*",
        "https://www.google.com/*",
        "https://page.kakao.com/content/69299983",
    ]


def test_entries_keep_library_membership_and_same_source_may_live_in_two_libraries(tmp_path: Path) -> None:
    database = GlossaryDB(str(tmp_path / "libraries.db"))
    novel = database.upsert_library("kakao-69299983", "骸骨皇女", True, ["https://page.kakao.com/content/69299983/"])
    assert novel["id"] == "kakao-69299983"
    assert novel["urls"] == ["https://page.kakao.com/content/69299983"]

    global_entry = database.upsert_entry("성현", "成贤")
    novel_entry = database.upsert_entry("성현", "晟玄", library_id="kakao-69299983", library_name="骸骨皇女")

    assert {item["target"] for item in database.get_entries()} == {"成贤", "晟玄"}
    assert [item["target"] for item in database.get_entries(library_id="kakao-69299983")] == ["晟玄"]
    assert len(database.get_entries(library_id=DEFAULT_LIBRARY_ID)) == 1
    # 同库同原文重复写入仍然合并为一条
    database.upsert_entry("성현", "晟玄", library_id="kakao-69299983")
    assert len(database.get_entries(library_id="kakao-69299983")) == 1
    assert global_entry["libraryId"] == DEFAULT_LIBRARY_ID
    assert novel_entry["libraryId"] == "kakao-69299983"


def test_unknown_library_id_creates_the_library_from_the_batch_name(tmp_path: Path) -> None:
    database = GlossaryDB(str(tmp_path / "batch.db"))
    stats = database.upsert_batch([
        {"source": "왕국", "target": "王国", "library_id": "novel-1", "library_name": "骸骨皇女"},
        {"source": "마법", "target": "魔法"},
    ])

    assert stats["added"] == 2
    assert [library["id"] for library in database.list_libraries()] == [DEFAULT_LIBRARY_ID, "novel-1"]
    assert database.get_library("novel-1")["name"] == "骸骨皇女"
    assert [entry["target"] for entry in database.get_entries(library_id="novel-1")] == ["王国"]
    assert database.get_entries(library_id=DEFAULT_LIBRARY_ID)[0]["target"] == "魔法"


def test_upsert_library_generates_ids_and_updates_the_switch(tmp_path: Path) -> None:
    database = GlossaryDB(str(tmp_path / "crud.db"))
    created = database.upsert_library("", "骸骨皇女", True, ["https://page.kakao.com/content/69299983"])
    assert created["id"].startswith("骸骨皇女-") or created["id"].startswith("library-")

    updated = database.upsert_library(created["id"], "骸骨皇女（停用）", False, ["https://example.com/a/"])
    assert updated["id"] == created["id"]
    assert updated["name"] == "骸骨皇女（停用）"
    assert updated["enabled"] is False
    assert updated["urls"] == ["https://example.com/a"]
    assert len(database.list_libraries()) == 2


def test_delete_library_moves_entries_back_to_the_default_library(tmp_path: Path) -> None:
    database = GlossaryDB(str(tmp_path / "delete.db"))
    database.upsert_library("novel-1", "骸骨皇女", True, [])
    entry = database.upsert_entry("성현", "晟玄", library_id="novel-1")
    database.add_pending("왕국", chapter_key="https://example.com/1", library_id="novel-1")

    result = database.delete_library("novel-1")

    assert result == {"deleted": True, "moved": 1}
    assert [library["id"] for library in database.list_libraries()] == [DEFAULT_LIBRARY_ID]
    assert database.get_entry(entry["id"])["libraryId"] == DEFAULT_LIBRARY_ID
    assert database.get_pending()[0]["libraryId"] == DEFAULT_LIBRARY_ID
    # 默认库不允许删除，避免出现"无库可用"的状态
    assert database.delete_library(DEFAULT_LIBRARY_ID)["deleted"] is False
    assert len(database.list_libraries()) == 1


def test_export_json_carries_libraries(tmp_path: Path) -> None:
    database = GlossaryDB(str(tmp_path / "export.db"))
    database.upsert_library("novel-1", "骸骨皇女", True, ["https://page.kakao.com/content/69299983"])
    database.upsert_entry("성현", "晟玄", library_id="novel-1")

    exported = database.export_json()

    assert [library["id"] for library in exported["libraries"]] == [DEFAULT_LIBRARY_ID, "novel-1"]
    assert exported["entries"][0]["libraryId"] == "novel-1"


def test_confirming_a_pending_candidate_keeps_its_library(tmp_path: Path) -> None:
    database = GlossaryDB(str(tmp_path / "pending.db"))
    database.upsert_library("novel-1", "骸骨皇女", True, [])
    database.add_pending("성현", chapter_key="https://page.kakao.com/content/69299983/viewer/1", library_id="novel-1")

    assert database.get_pending()[0]["libraryId"] == "novel-1"
    assert database.confirm_pending("성현", "成贤") is True
    assert [entry["libraryId"] for entry in database.get_entries(library_id="novel-1")] == ["novel-1"]


def test_v4_database_migrates_entries_into_the_default_library(tmp_path: Path) -> None:
    path = tmp_path / "legacy-v4.db"
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta (key, value) VALUES ('schema_version', '4');
        CREATE TABLE glossary_entries (
            id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL,
            src_lng TEXT NOT NULL DEFAULT 'ko', tgt_lng TEXT NOT NULL DEFAULT 'zh-CN',
            note TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
            source_key TEXT NOT NULL, scope_type TEXT NOT NULL DEFAULT 'global',
            scope_key TEXT NOT NULL DEFAULT '', scope_label TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL, updated_at REAL NOT NULL
        );
        CREATE UNIQUE INDEX idx_glossary_unique_language_scope
            ON glossary_entries(source_key, src_lng, tgt_lng, scope_type, scope_key);
        """
    )
    now = time.time()
    connection.execute(
        "INSERT INTO glossary_entries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("legacy", "성현", "成贤", "ko", "zh-CN", "", 1, "성현", "global", "", "", now, now),
    )
    connection.commit()
    connection.close()

    database = GlossaryDB(str(path))
    migrated = database.get_entry("legacy")

    assert migrated is not None
    assert migrated["libraryId"] == DEFAULT_LIBRARY_ID
    assert database.list_libraries()[0]["id"] == DEFAULT_LIBRARY_ID
    assert connection_schema_version(str(path)) == str(SCHEMA_VERSION)
    # 新的唯一索引允许同一术语进入第二个库
    database.upsert_entry("성현", "晟玄", library_id="novel-1")
    assert database.get_entry_count() == 2


def connection_schema_version(path: str) -> str:
    connection = sqlite3.connect(path)
    try:
        row = connection.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        return row[0] if row else ""
    finally:
        connection.close()
