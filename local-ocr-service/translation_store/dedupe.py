"""合并 SQLite 正式译文库的重复记录。

旧版缓存键（页面+容器+位置）会让同一原文+译文产生多条记录。按
(normalized_source_hash, 当前译文) 分组，每组保留 updated_at 最新的一条，
其余软删（deleted_at 标记），query 默认不再返回。
"""
from __future__ import annotations

import sqlite3

from .store import _now_ms


def dedupe_translation_records(store) -> dict[str, int]:
    with store.connect() as connection:
        rows = connection.execute(
            "SELECT id, normalized_source_hash, active_version_id, updated_at "
            "FROM translation_records WHERE deleted_at IS NULL"
        ).fetchall()
        version_text = dict(connection.execute(
            "SELECT id, translated_text FROM translation_versions"
        ).fetchall())
        groups: dict[tuple[str, str], list[sqlite3.Row]] = {}
        for row in rows:
            active = version_text.get(row["active_version_id"], "")
            if active:
                groups.setdefault((row["normalized_source_hash"], active), []).append(row)
        removed = 0
        now = _now_ms()
        for members in groups.values():
            if len(members) <= 1:
                continue
            members.sort(key=lambda r: r["updated_at"], reverse=True)
            for row in members[1:]:
                connection.execute(
                    "UPDATE translation_records SET deleted_at=?,deleted_by_operation_id='dedupe' "
                    "WHERE id=?", (now, row["id"])
                )
                removed += 1
        connection.commit()
    return {"removed": removed, "total": len(rows)}
