"""术语删除之所以「删不掉」的两处成因：id 不一致 + 404 被包成 500。"""

from __future__ import annotations

from pathlib import Path
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "local-ocr-service"
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from glossary_db import GlossaryDB  # noqa: E402


def test_reconfirming_an_entry_adopts_the_client_id(tmp_path: Path) -> None:
    database = GlossaryDB(str(tmp_path / "ids.db"))
    created = database.upsert_entry("성현", "成贤")
    assert created["id"] != "term-auto-a5a16840"

    # 同一身份再次写入：客户端带的 id 必须生效，否则客户端删的是服务端不存在的行。
    updated = database.upsert_entry("성현", "成贤", entry_id="term-auto-a5a16840")

    assert updated["id"] == "term-auto-a5a16840"
    assert database.get_entry_count() == 1
    assert database.delete_entry("term-auto-a5a16840") is True
    assert database.get_entry_count() == 0


def test_batch_upsert_adopts_the_client_id_too(tmp_path: Path) -> None:
    """术语库页加载时用 /glossary/batch 回灌本地条目，这是修好历史脏行的入口。"""
    database = GlossaryDB(str(tmp_path / "batch.db"))
    database.upsert_entry("성현", "成贤")

    stats = database.upsert_batch([{"id": "term-auto-batch", "source": "성현", "target": "成贤"}])

    assert stats["failed"] == 0
    assert stats["updated"] == 1
    assert database.get_entry_count() == 1
    assert database.get_entry("term-auto-batch") is not None


def test_an_id_owned_by_another_row_is_not_stolen(tmp_path: Path) -> None:
    database = GlossaryDB(str(tmp_path / "taken.db"))
    database.upsert_entry("가", "A", entry_id="term-keep")
    kept = database.upsert_entry("나", "B")

    other = database.upsert_entry("나", "B", entry_id="term-keep")

    assert other["id"] == kept["id"]
    assert database.get_entry("term-keep")["source"] == "가"


def test_delete_of_an_unknown_id_answers_404_not_500(tmp_path: Path) -> None:
    from fastapi import HTTPException

    from ocr_service import models as _models  # noqa: F401  注册请求模型到 runtime
    from ocr_service.pipeline import api_handlers
    from ocr_service.runtime import runtime

    previous = runtime._glossary_db
    runtime._glossary_db = GlossaryDB(str(tmp_path / "handler.db"))
    try:
        with pytest.raises(HTTPException) as missing:
            api_handlers.glossary_delete("term-auto-a5a16840")
        assert missing.value.status_code == 404

        api_handlers.glossary_upsert(runtime.GlossaryEntryPayload(source="성현", target="成贤", id="term-auto-a5a16840"))
        assert api_handlers.glossary_delete("term-auto-a5a16840") == {"ok": True}
        assert runtime._glossary_db.get_entry_count() == 0
    finally:
        runtime._glossary_db = previous
