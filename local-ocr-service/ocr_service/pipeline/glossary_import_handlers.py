"""术语库 JSON / SQLite 导入端点（从 api_handlers 拆出，保持单文件行数上限）。"""

from __future__ import annotations

from ..dependencies import runtime


async def glossary_import(request: runtime.Request) -> dict[str, runtime.Any]:
    try:
        body = await request.json()
    except Exception:
        raise runtime.HTTPException(status_code=400, detail='Invalid JSON body')
    entries = body.get('entries', []) if isinstance(body, dict) else []
    if not isinstance(entries, list):
        raise runtime.HTTPException(status_code=400, detail='entries must be a list')
    db = runtime.get_glossary_db()
    try:
        count = db.import_entries(entries)
    except Exception as exc:
        import traceback
        traceback.print_exc()
        raise runtime.HTTPException(status_code=500, detail=f'import_entries failed: {exc}')
    return {'ok': True, 'imported': count}

runtime.glossary_import = glossary_import
async def glossary_import_db(request: runtime.Request) -> dict[str, runtime.Any]:
    """Import entries from an uploaded SQLite glossary database."""
    import os
    import shutil
    import tempfile
    try:
        form = await request.form()
        uploaded = form.get("file")
        if not uploaded or not hasattr(uploaded, "filename"):
            raise runtime.HTTPException(status_code=400, detail="No database file uploaded")
        filename = getattr(uploaded, "filename", "upload.db")
        if not filename.lower().endswith((".db", ".sqlite", ".sqlite3")):
            raise runtime.HTTPException(status_code=400, detail="Only .db / .sqlite / .sqlite3 files are accepted")
        # Save upload to temp file
        content = await uploaded.read()
        tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        try:
            tmp.write(content)
            tmp.close()
            # Verify it's a valid SQLite database with a compatible table
            import sqlite3 as _sqlite3
            src = _sqlite3.connect(tmp.name)
            try:
                tables = [r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
                if "glossary_entries" not in tables:
                    raise runtime.HTTPException(status_code=400, detail=f"Uploaded database has no glossary_entries table. Found tables: {', '.join(tables[:8])}")
                cols = [r[1] for r in src.execute("PRAGMA table_info(glossary_entries)").fetchall()]
                has_source = "source" in cols
                has_target = "target" in cols
                if not has_source or not has_target:
                    raise runtime.HTTPException(status_code=400, detail=f"glossary_entries table must have source and target columns. Found: {', '.join(cols[:12])}")
                has_tgt = "tgt_lng" in cols
                has_note = "note" in cols
                has_enabled = "enabled" in cols
                has_scope_type = "scope_type" in cols
                has_scope_key = "scope_key" in cols
                has_scope_label = "scope_label" in cols
                has_library = "library_id" in cols
                select_cols = ["source", "target"]
                if has_tgt:
                    select_cols.append("tgt_lng")
                if has_note:
                    select_cols.append("note")
                if has_enabled:
                    select_cols.append("enabled")
                if has_scope_type:
                    select_cols.append("scope_type")
                if has_scope_key:
                    select_cols.append("scope_key")
                if has_scope_label:
                    select_cols.append("scope_label")
                if has_library:
                    select_cols.append("library_id")
                rows = src.execute(f"SELECT {', '.join(select_cols)} FROM glossary_entries").fetchall()
                library_rows = []
                if "glossary_libraries" in tables:
                    library_rows = src.execute(
                        "SELECT id, name, enabled, urls FROM glossary_libraries").fetchall()
                entries = []
                for row in rows:
                    entry = {"source": row[0] or "", "target": row[1] or ""}
                    ci = 2
                    if has_tgt:
                        entry["tgt_lng"] = row[ci] or ""
                        ci += 1
                    if has_note:
                        entry["note"] = row[ci] or ""
                        ci += 1
                    if has_enabled:
                        entry["enabled"] = bool(row[ci])
                        ci += 1
                    if has_scope_type:
                        entry["scope_type"] = row[ci] or "global"
                        ci += 1
                    if has_scope_key:
                        entry["scope_key"] = row[ci] or ""
                        ci += 1
                    if has_scope_label:
                        entry["scope_label"] = row[ci] or ""
                        ci += 1
                    if has_library:
                        entry["library_id"] = row[ci] or ""
                    entries.append(entry)
                src.close()
            finally:
                if src:
                    src.close()
                os.unlink(tmp.name)
        except Exception:
            try:
                os.unlink(tmp.name)
            except Exception:
                pass
            raise
        db = runtime.get_glossary_db()
        # 先补建上传文件里的术语库定义，条目导入时才能保留库归属与名称。
        if library_rows:
            db.import_libraries(library_rows)
        if not entries:
            return {"ok": True, "read": 0, "added": 0, "updated": 0, "skipped": 0, "failed": 0, "failures": [], "backup": ""}
        # Backup current DB
        backup_path = ""
        try:
            backup_name = f"glossary_backup_{int(runtime.time.time())}.db"
            backup_path = str(runtime.Path(db._path).parent / backup_name)
            shutil.copy2(db._path, backup_path)
        except Exception:
            backup_path = ""
        # Import
        stats = db.upsert_batch(entries)
        stats["backup"] = backup_path
        return stats
    except runtime.HTTPException:
        raise
    except Exception as exc:
        import traceback
        traceback.print_exc()
        raise runtime.HTTPException(status_code=500, detail=f"Import failed: {exc}")

runtime.glossary_import_db = glossary_import_db
