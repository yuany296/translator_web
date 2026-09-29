"""修复官方译文库里「被截尾的自动译文覆盖了完整版本」的记录。

起因：漫画/小说自动翻译偶尔返回被截尾的值（'好,马上' → '好,'、整句 → '游乐设施'），
而旧逻辑会把它设为启用版本，页面上就只剩几个字。写入侧的护栏是
`translation_store/shrink_guard.py`；这个脚本用来修复**已经写坏的历史记录**。

判定（与护栏一致，且只修「回归特征」）：
  - 启用版本是 api 来源、未置顶，且比同记录里最长的版本短于 60%；
  - 截尾的那条是**后写入**的（否则可能只是用户自己选了旧版本）。

用法：
    python tools/repair_truncated_translations.py          # 只扫描并打印
    python tools/repair_truncated_translations.py --apply  # 通过服务端 select_version 切回最长版本
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / ".local-data" / "translations.db"
SERVICE = "http://127.0.0.1:8765"
SHRINK_RATIO = 0.6
APPLY = "--apply" in sys.argv


def load_damaged() -> list[dict]:
    connection = sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    outer = connection.cursor()
    inner = connection.cursor()
    # 注意：sqlite3 的同一个 cursor 不能在遍历时嵌套查询（会重置外层迭代），所以分两个。
    records = list(outer.execute(
        "SELECT id, mode, raw_source_text, active_version_id, record_revision "
        "FROM translation_records WHERE deleted_at IS NULL"
    ))
    damaged: list[dict] = []
    for row in records:
        versions = list(inner.execute(
            "SELECT id, translated_text, source, created_at, pinned FROM translation_versions "
            "WHERE record_id=? AND deleted_at IS NULL ORDER BY created_at", (row["id"],)
        ))
        if len(versions) < 2:
            continue
        active = next((item for item in versions if item["id"] == row["active_version_id"]), None)
        if active is None:
            continue
        longest = max(versions, key=lambda item: len(str(item["translated_text"])))
        source = str(row["raw_source_text"] or "")
        if len(source) < 4 or len(str(longest["translated_text"])) < 4:
            continue
        if len(str(active["translated_text"])) >= len(str(longest["translated_text"])) * SHRINK_RATIO:
            continue
        if str(active["source"]) != "api" or active["pinned"]:
            continue
        if int(active["created_at"]) <= int(longest["created_at"]):
            continue
        damaged.append({
            "recordId": row["id"], "mode": row["mode"], "source": source,
            "recordRevision": row["record_revision"], "activeVersionId": active["id"],
            "activeText": str(active["translated_text"]), "activeCreatedAt": active["created_at"],
            "goodVersionId": longest["id"], "goodText": str(longest["translated_text"]),
            "goodCreatedAt": longest["created_at"],
        })
    connection.close()
    return damaged


def select_version(entry: dict) -> str:
    operation = {
        "operationId": str(uuid.uuid4()),
        "type": "select_version",
        "recordId": entry["recordId"],
        "expectedRecordRevision": entry["recordRevision"],
        "baseActiveVersionId": entry["activeVersionId"],
        "payload": {"versionId": entry["goodVersionId"]},
        "createdAt": int(time.time() * 1000),
    }
    body = json.dumps({"operations": [operation]}).encode("utf-8")
    request = urllib.request.Request(f"{SERVICE}/translations/operations", data=body,
                                    headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    record = (payload.get("results") or [{}])[0].get("record") or {}
    return str((record.get("activeVersion") or {}).get("translatedText") or "")


def main() -> int:
    if not DB.exists():
        print(f"找不到译文库：{DB}")
        return 1
    damaged = load_damaged()
    print(f"命中「启用版本明显更短且是后写入」的记录：{len(damaged)} 条")
    for entry in damaged:
        active_at = time.strftime("%m-%d %H:%M", time.localtime(entry["activeCreatedAt"] / 1000))
        good_at = time.strftime("%m-%d %H:%M", time.localtime(entry["goodCreatedAt"] / 1000))
        print(f"  [{entry['mode']}] {entry['source'][:40]!r}")
        print(f"      启用({len(entry['activeText']):2d}, {active_at}) {entry['activeText'][:40]!r}")
        print(f"      最长({len(entry['goodText']):2d}, {good_at}) {entry['goodText'][:40]!r}")
    if not APPLY or not damaged:
        print("（加 --apply 才执行修复；修复走服务端 select_version，历史版本全部保留）")
        return 0
    repaired = 0
    for entry in damaged:
        try:
            active = select_version(entry)
        except Exception as exc:  # noqa: BLE001 - 逐条报告，不中断
            print(f"  修复失败 {entry['recordId'][:10]}: {exc}")
            continue
        repaired += 1
        print(f"  已修复 {entry['recordId'][:10]}: 现在启用 {active[:40]!r}")
    print(f"修复 {repaired}/{len(damaged)} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
