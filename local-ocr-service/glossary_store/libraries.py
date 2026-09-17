from __future__ import annotations

import json
import re
import sqlite3
import time
from typing import Any

from .common import (
    DEFAULT_LIBRARY_ID,
    DEFAULT_LIBRARY_NAME,
    normalize_library_id,
    normalize_library_name,
    normalize_library_urls,
)

LIBRARY_COLUMNS = "id, name, enabled, urls, apply_urls, created_at, updated_at"
MAX_LIBRARIES = 50


class LibrariesMixin:
    """术语库定义（名称、启用开关、绑定网址、应用网址）。条目通过 library_id 归组。"""

    def list_libraries(self) -> list[dict[str, Any]]:
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                rows = conn.execute(
                    f"SELECT {LIBRARY_COLUMNS} FROM glossary_libraries "
                    "ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at ASC, id ASC",
                    (DEFAULT_LIBRARY_ID,),
                ).fetchall()
                return [self._row_to_library(row) for row in rows]
            finally:
                conn.close()

    def get_library(self, library_id: str) -> dict[str, Any] | None:
        lid = normalize_library_id(library_id)
        if not lid:
            return None
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                row = conn.execute(
                    f"SELECT {LIBRARY_COLUMNS} FROM glossary_libraries WHERE id = ?", (lid,)
                ).fetchone()
                return self._row_to_library(row) if row else None
            finally:
                conn.close()

    def upsert_library(self, library_id: str = "", name: str = "",
                       enabled: bool = True, urls=None, apply_urls=None) -> dict[str, Any]:
        """新建或更新术语库；`library_id` 留空时按名称生成稳定标识。"""
        lid = normalize_library_id(library_id)
        library_name = normalize_library_name(name)
        library_urls = normalize_library_urls(urls)
        library_apply_urls = normalize_library_urls(apply_urls)
        now = time.time()
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                existing = conn.execute(
                    "SELECT id FROM glossary_libraries WHERE id = ?", (lid,)
                ).fetchone() if lid else None
                if existing:
                    lid = existing[0]
                    conn.execute(
                        "UPDATE glossary_libraries SET name = ?, enabled = ?, urls = ?, apply_urls = ?, updated_at = ? "
                        "WHERE id = ?",
                        (library_name, 1 if enabled else 0,
                         json.dumps(library_urls, ensure_ascii=False),
                         json.dumps(library_apply_urls, ensure_ascii=False), now, lid),
                    )
                else:
                    lid = lid or self._new_library_id(conn, library_name, now)
                    conn.execute(
                        "INSERT INTO glossary_libraries (id, name, enabled, urls, apply_urls, created_at, updated_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (lid, library_name, 1 if enabled else 0,
                         json.dumps(library_urls, ensure_ascii=False),
                         json.dumps(library_apply_urls, ensure_ascii=False), now, now),
                    )
                conn.commit()
                row = conn.execute(
                    f"SELECT {LIBRARY_COLUMNS} FROM glossary_libraries WHERE id = ?", (lid,)
                ).fetchone()
                return self._row_to_library(row) if row else {}
            finally:
                conn.close()

    def ensure_library(self, library_id: str, name: str = "") -> str:
        """返回可用的库标识：未指定或不存在时回退（必要时创建）。"""
        lid = normalize_library_id(library_id) or DEFAULT_LIBRARY_ID
        if self.get_library(lid):
            return lid
        if len(self.list_libraries()) >= MAX_LIBRARIES:
            return DEFAULT_LIBRARY_ID
        return self.upsert_library(lid, name or lid, True, []).get("id", DEFAULT_LIBRARY_ID)

    def delete_library(self, library_id: str) -> dict[str, Any]:
        """删除术语库定义，条目与待确认候选退回默认库（不删除术语本身）。"""
        lid = normalize_library_id(library_id)
        if not lid:
            return {"deleted": False, "moved": 0, "error": "缺少术语库标识"}
        if lid == DEFAULT_LIBRARY_ID:
            return {"deleted": False, "moved": 0, "error": "默认术语库不能删除"}
        now = time.time()
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                deleted = conn.execute("DELETE FROM glossary_libraries WHERE id = ?", (lid,)).rowcount > 0
                moved = conn.execute(
                    "UPDATE glossary_entries SET library_id = ?, updated_at = ? WHERE library_id = ?",
                    (DEFAULT_LIBRARY_ID, now, lid),
                ).rowcount
                conn.execute(
                    "UPDATE pending_candidates SET library_id = ? WHERE library_id = ?",
                    (DEFAULT_LIBRARY_ID, lid),
                )
                conn.commit()
                return {"deleted": deleted, "moved": max(0, moved)}
            finally:
                conn.close()

    def import_libraries(self, rows: list[tuple[Any, ...]]) -> int:
        """导入上传数据库里的 glossary_libraries 行：(id, name, enabled, urls[, apply_urls])。"""
        count = 0
        for row in rows or []:
            if len(row) < 2:
                continue
            lid = normalize_library_id(str(row[0] or ""))
            if not lid or lid == DEFAULT_LIBRARY_ID:
                continue
            self.upsert_library(lid, str(row[1] or ""), bool(row[2]) if len(row) > 2 else True,
                                row[3] if len(row) > 3 else [],
                                row[4] if len(row) > 4 else [])
            count += 1
        return count

    @staticmethod
    def _new_library_id(conn: sqlite3.Connection, name: str, now: float) -> str:
        slug = re.sub(r"[^0-9A-Za-z_-]+", "-", name).strip("-")[:40] or "library"
        candidate = f"{slug}-{int(now)}"
        suffix = 1
        while conn.execute("SELECT 1 FROM glossary_libraries WHERE id = ?", (candidate,)).fetchone():
            suffix += 1
            candidate = f"{slug}-{int(now)}-{suffix}"
        return candidate

    @staticmethod
    def _row_to_library(row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0],
            "name": row[1],
            "enabled": bool(row[2]),
            "urls": normalize_library_urls(row[3]),
            "applyUrls": normalize_library_urls(row[4]),
            "createdAt": row[5],
            "updatedAt": row[6],
        }
