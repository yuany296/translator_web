from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from .common import normalize_source


class PendingMixin:
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
        src_key = normalize_source(source)
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
        src_key = normalize_source(source)
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
        src_key = normalize_source(source)
        with self._lock:
            conn = sqlite3.connect(self._path, check_same_thread=False)
            try:
                cur = conn.execute(
                    "DELETE FROM pending_candidates WHERE source_key = ?", (src_key,))
                conn.commit()
                return cur.rowcount > 0
            finally:
                conn.close()
