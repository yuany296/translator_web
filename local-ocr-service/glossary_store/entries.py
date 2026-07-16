from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from .common import normalize_source, normalize_tgt_lng, DEFAULT_TGT_LNG


class EntriesMixin:
    def get_entries(
        self, search: str = "", enabled_only: bool = False,
        tgt_lng: str = "", keyword: str = "",
        limit: int = 0, offset: int = 0,
        updated_after: float = 0.0,
    ) -> list[dict[str, Any]]:
        """Return glossary entries, optionally filtered and paginated."""
        parts = ["SELECT id, source, target, tgt_lng, note, enabled, source_key, created_at, updated_at FROM glossary_entries"]
        params: list[Any] = []
        where = []
        if enabled_only:
            where.append("enabled = 1")
        if tgt_lng:
            where.append("tgt_lng = ?")
            params.append(normalize_tgt_lng(tgt_lng))
        if keyword:
            where.append("(source LIKE ? OR target LIKE ? OR note LIKE ?)")
            like = f"%{keyword}%"
            params.extend([like, like, like])
        elif search:
            where.append("(source LIKE ? OR target LIKE ? OR note LIKE ?)")
            like = f"%{search}%"
            params.extend([like, like, like])
        if updated_after > 0:
            where.append("updated_at > ?")
            params.append(updated_after)
        if where:
            parts.append("WHERE " + " AND ".join(where))
        parts.append("ORDER BY source_key ASC, tgt_lng ASC")
        if limit > 0:
            parts.append("LIMIT ?")
            params.append(limit)
            if offset > 0:
                parts.append("OFFSET ?")
                params.append(offset)
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                rows = conn.execute(" ".join(parts), params).fetchall()
                return [self._row_to_entry(r) for r in rows]
            finally:
                conn.close()

    def get_entry_count(
        self, tgt_lng: str = "", keyword: str = "", enabled_only: bool = False
    ) -> int:
        parts = ["SELECT COUNT(*) FROM glossary_entries"]
        params: list[Any] = []
        where = []
        if enabled_only:
            where.append("enabled = 1")
        if tgt_lng:
            where.append("tgt_lng = ?")
            params.append(normalize_tgt_lng(tgt_lng))
        if keyword:
            where.append("(source LIKE ? OR target LIKE ?)")
            like = f"%{keyword}%"
            params.extend([like, like])
        if where:
            parts.append("WHERE " + " AND ".join(where))
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                row = conn.execute(" ".join(parts), params).fetchone()
                return row[0] if row else 0
            finally:
                conn.close()

    def get_revision(self) -> float:
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                row = conn.execute("SELECT MAX(updated_at) FROM glossary_entries").fetchone()
                return row[0] if row and row[0] else 0.0
            finally:
                conn.close()

    def get_entry(self, entry_id: str) -> dict[str, Any] | None:
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                row = conn.execute(
                    "SELECT id, source, target, tgt_lng, note, enabled, source_key, created_at, updated_at FROM glossary_entries WHERE id = ?",
                    (entry_id,),
                ).fetchone()
                return self._row_to_entry(row) if row else None
            finally:
                conn.close()

    def upsert_entry(
        self, source: str, target: str, tgt_lng: str = "",
        note: str = "", enabled: bool = True, entry_id: str = "",
    ) -> dict[str, Any]:
        """Upsert by (source_key, tgt_lng). Returns the row after upsert."""
        src = source.strip()
        if not src or not target.strip():
            raise ValueError("source and target are required")
        src_key = normalize_source(src)
        lng = normalize_tgt_lng(tgt_lng)
        now = time.time()
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                existing = conn.execute(
                    "SELECT id FROM glossary_entries WHERE source_key = ? AND tgt_lng = ?",
                    (src_key, lng),
                ).fetchone()
                if existing:
                    eid = existing[0]
                    conn.execute(
                        "UPDATE glossary_entries SET source=?, target=?, note=?, enabled=?, updated_at=? WHERE id=?",
                        (src, target.strip(), note.strip(), 1 if enabled else 0, now, eid),
                    )
                else:
                    eid = entry_id or f"term-{now}-{hash(src)}"
                    conn.execute(
                        "INSERT INTO glossary_entries (id, source, target, tgt_lng, note, enabled, source_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                        (eid, src, target.strip(), lng, note.strip(), 1 if enabled else 0, src_key, now, now),
                    )
                conn.commit()
                row = conn.execute(
                    "SELECT id, source, target, tgt_lng, note, enabled, source_key, created_at, updated_at FROM glossary_entries WHERE id = ?",
                    (eid,),
                ).fetchone()
                return self._row_to_entry(row) if row else {}
            finally:
                conn.close()

    def upsert_batch(
        self, entries: list[dict[str, Any]], tgt_lng: str = ""
    ) -> dict[str, Any]:
        """Batch upsert in a single transaction. Returns import stats."""
        stats = {"read": len(entries), "added": 0, "updated": 0, "skipped": 0, "failed": 0, "failures": []}
        lng = normalize_tgt_lng(tgt_lng)
        now = time.time()
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                for idx, entry in enumerate(entries):
                    try:
                        src = (entry.get("source") or "").strip()
                        tgt = (entry.get("target") or "").strip()
                        if not src or not tgt:
                            stats["skipped"] += 1
                            continue
                        entry_lng = normalize_tgt_lng(entry.get("tgt_lng") or tgt_lng)
                        src_key = normalize_source(src)
                        existing = conn.execute(
                            "SELECT id FROM glossary_entries WHERE source_key = ? AND tgt_lng = ?",
                            (src_key, entry_lng),
                        ).fetchone()
                        note = (entry.get("note") or "").strip()
                        enabled = 0 if entry.get("enabled") is False else 1
                        if existing:
                            conn.execute(
                                "UPDATE glossary_entries SET source=?, target=?, note=?, enabled=?, updated_at=? WHERE id=?",
                                (src, tgt, note, enabled, now, existing[0]),
                            )
                            stats["updated"] += 1
                        else:
                            eid = entry.get("id") or f"batch-{now}-{idx}"
                            conn.execute(
                                "INSERT INTO glossary_entries (id, source, target, tgt_lng, note, enabled, source_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                                (eid, src, tgt, entry_lng, note, enabled, src_key, now, now),
                            )
                            stats["added"] += 1
                    except Exception as exc:
                        stats["failed"] += 1
                        stats["failures"].append({"index": idx, "source": str(entry.get("source", ""))[:60], "error": str(exc)})
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()
        return stats

    def add_entry(
        self, source: str, target: str, tgt_lng: str = "",
        note: str = "", enabled: bool = True, entry_id: str = "",
    ) -> str:
        """Deprecated — prefer upsert_entry. Returns the entry id."""
        result = self.upsert_entry(source=source, target=target, tgt_lng=tgt_lng, note=note, enabled=enabled, entry_id=entry_id)
        return result.get("id", "")

    def update_entry(self, entry_id: str, *, source: str = "", target: str = "",
                     tgt_lng: str = "", note: str | None = None,
                     enabled: bool | None = None) -> bool:
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
        if tgt_lng:
            fields.append("tgt_lng = ?")
            params.append(normalize_tgt_lng(tgt_lng))
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

    def get_enabled_entries(self, tgt_lng: str = "") -> list[dict[str, Any]]:
        filters = {}
        if tgt_lng:
            filters["tgt_lng"] = tgt_lng
        return self.get_entries(enabled_only=True, **filters)
