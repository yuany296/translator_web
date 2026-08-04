from __future__ import annotations

import sqlite3
from pathlib import Path


def has_saved_pairing(path: str) -> bool:
    database_path = Path(path)
    if not database_path.is_file():
        return False
    try:
        with sqlite3.connect(str(database_path), timeout=1.0) as connection:
            values = dict(connection.execute(
                "SELECT key,value FROM translation_meta "
                "WHERE key IN ('access_token_hash','extension_origin')"
            ).fetchall())
    except sqlite3.Error:
        return False
    return bool(values.get("access_token_hash") and values.get("extension_origin"))
