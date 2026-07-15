from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from .common import normalize_source


class EntriesMixin:
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
        src_key = normalize_source(source)
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
            params.append(normalize_source(source))
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
