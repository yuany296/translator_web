from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from .common import normalize_source


class TransferMixin:
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
        src_key = normalize_source(source)
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
        src_key = normalize_source(source)
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                cur = conn.execute(
                    "DELETE FROM ignored_terms WHERE source_key = ?", (src_key,))
                conn.commit()
                return cur.rowcount > 0
            finally:
                conn.close()

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
                         normalize_source(source), now, now),
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

    def _row_to_entry(row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0],
            "source": row[1],
            "target": row[2],
            "tgtLng": row[3] if len(row) > 7 else "zh-CN",
            "note": row[4] if len(row) > 7 else row[3],
            "enabled": bool(row[5] if len(row) > 7 else row[4]),
            "sourceKey": row[6] if len(row) > 7 else row[5],
            "createdAt": row[7] if len(row) > 7 else row[6],
            "updatedAt": row[8] if len(row) > 7 else row[7],
        }

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
