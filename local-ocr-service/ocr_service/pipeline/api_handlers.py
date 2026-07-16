from __future__ import annotations

from ..dependencies import runtime

def get_glossary_db() -> runtime.GlossaryDB:
    if runtime._glossary_db is None:
        runtime._glossary_db = runtime.GlossaryDB(runtime.GLOSSARY_DB_PATH)
    return runtime._glossary_db

runtime.get_glossary_db = get_glossary_db

def health() -> dict[str, runtime.Any]:
    device_error = ''
    try:
        device = runtime.get_runtime_device()
    except Exception as exc:
        device = ''
        device_error = str(exc)
    term_extractor = runtime.get_term_extractor_status()
    return {'ok': runtime.PADDLE_IMPORT_ERROR is None and (not device_error), 'engine': 'paddleocr', 'ocrGeometryVersion': runtime.OCR_GEOMETRY_CONTRACT_VERSION, 'device': device, 'cuda': runtime.is_cuda_available(), 'cv2_available': runtime.CV2_AVAILABLE, 'term_extractor_available': term_extractor['available'], 'term_extractor_engine': term_extractor['engine'], 'term_extractor_error': term_extractor['error'], 'error': str(runtime.PADDLE_IMPORT_ERROR) if runtime.PADDLE_IMPORT_ERROR else device_error}

runtime.health = health

def terms_health() -> dict[str, runtime.Any]:
    status = runtime.get_term_extractor_status(check_runtime=True)
    return {'ok': status['available'], **status}

runtime.terms_health = terms_health

async def extract_terms(payload: runtime.TermExtractionRequest) -> dict[str, runtime.Any]:
    status = await runtime.asyncio.to_thread(runtime.get_term_extractor_status, True)
    if not status['available']:
        raise runtime.HTTPException(status_code=503, detail=status['error'] or 'Kiwi is unavailable')
    if payload.mode != 'balanced':
        raise runtime.HTTPException(status_code=400, detail='only balanced mode is supported')
    blocks = [{'id': block.id.strip(), 'text': block.text.strip()} for block in payload.blocks if block.id.strip() and block.text.strip()]
    candidates = await runtime.asyncio.to_thread(runtime.extract_term_candidates, blocks, None, payload.user_terms)
    return {'ok': True, 'engine': 'kiwi', 'candidates': candidates}

runtime.extract_terms = extract_terms

def glossary_health() -> dict[str, runtime.Any]:
    try:
        db = runtime.get_glossary_db()
        count = db.get_entry_count()
        pending = db.get_pending_count()
        return {'ok': True, 'entryCount': count, 'pendingCount': pending, 'revision': db.get_revision()}
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}

runtime.glossary_health = glossary_health

def glossary_list(
    search: str = '', enabled_only: bool = False,
    tgt_lng: str = '', keyword: str = '',
    limit: int = 0, offset: int = 0,
    updated_after: float = 0.0,
) -> dict[str, runtime.Any]:
    db = runtime.get_glossary_db()
    entries = db.get_entries(
        search=search, enabled_only=enabled_only,
        tgt_lng=tgt_lng, keyword=keyword,
        limit=limit, offset=offset,
        updated_after=updated_after,
    )
    total = db.get_entry_count(tgt_lng=tgt_lng, keyword=keyword or search, enabled_only=enabled_only)
    revision = db.get_revision()
    return {'ok': True, 'entries': entries, 'total': total, 'revision': revision}

runtime.glossary_list = glossary_list

def glossary_upsert(payload: runtime.GlossaryEntryPayload) -> dict[str, runtime.Any]:
    db = runtime.get_glossary_db()
    entry = db.upsert_entry(
        source=payload.source, target=payload.target,
        tgt_lng=getattr(payload, 'tgt_lng', ''),
        note=getattr(payload, 'note', ''),
        enabled=getattr(payload, 'enabled', True),
        entry_id=getattr(payload, 'id', ''),
    )
    return {'ok': True, 'entry': entry}

runtime.glossary_upsert = glossary_upsert

def glossary_batch_upsert(payload: runtime.GlossaryBatchPayload) -> dict[str, runtime.Any]:
    db = runtime.get_glossary_db()
    entries = getattr(payload, 'entries', []) or []
    tgt_lng = getattr(payload, 'tgt_lng', '')
    stats = db.upsert_batch(entries, tgt_lng=tgt_lng)
    stats['ok'] = stats['failed'] == 0
    stats['revision'] = db.get_revision()
    return stats

runtime.glossary_batch_upsert = glossary_batch_upsert

def glossary_delete(entry_id: str) -> dict[str, runtime.Any]:
    db = runtime.get_glossary_db()
    deleted = db.delete_entry(entry_id)
    if not deleted:
        raise runtime.HTTPException(status_code=404, detail='Entry not found')
    return {'ok': True}

runtime.glossary_delete = glossary_delete

def glossary_pending_list() -> dict[str, runtime.Any]:
    db = runtime.get_glossary_db()
    chapters = db.get_pending_chapters()
    candidates = db.get_pending()
    return {'ok': True, 'chapters': chapters, 'candidates': candidates}

runtime.glossary_pending_list = glossary_pending_list

def glossary_pending_confirm(payload: runtime.GlossaryConfirmPayload) -> dict[str, runtime.Any]:
    db = runtime.get_glossary_db()
    ok = db.confirm_pending(source=payload.source, target=payload.target)
    if not ok:
        raise runtime.HTTPException(status_code=404, detail='Pending candidate not found')
    return {'ok': True}

runtime.glossary_pending_confirm = glossary_pending_confirm

def glossary_pending_ignore(payload: runtime.GlossaryIgnorePayload) -> dict[str, runtime.Any]:
    db = runtime.get_glossary_db()
    db.add_ignored(source=payload.source)
    db.delete_pending(source=payload.source)
    return {'ok': True}

runtime.glossary_pending_ignore = glossary_pending_ignore

def glossary_ignored_list() -> dict[str, runtime.Any]:
    db = runtime.get_glossary_db()
    return {'ok': True, 'sources': db.get_ignored()}

runtime.glossary_ignored_list = glossary_ignored_list

def glossary_ignored_restore(payload: runtime.GlossaryIgnorePayload) -> dict[str, runtime.Any]:
    db = runtime.get_glossary_db()
    db.remove_ignored(source=payload.source)
    return {'ok': True}

runtime.glossary_ignored_restore = glossary_ignored_restore

def glossary_export() -> dict[str, runtime.Any]:
    db = runtime.get_glossary_db()
    data = db.export_json()
    return {'ok': True, 'data': data}

runtime.glossary_export = glossary_export

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
                select_cols = ["source", "target"]
                if has_tgt:
                    select_cols.append("tgt_lng")
                if has_note:
                    select_cols.append("note")
                if has_enabled:
                    select_cols.append("enabled")
                rows = src.execute(f"SELECT {', '.join(select_cols)} FROM glossary_entries").fetchall()
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
        if not entries:
            return {"ok": True, "read": 0, "added": 0, "updated": 0, "skipped": 0, "failed": 0, "failures": [], "backup": ""}
        # Backup current DB
        db = runtime.get_glossary_db()
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

def glossary_pending_add(payload: runtime.GlossaryAddPendingPayload) -> dict[str, runtime.Any]:
    db = runtime.get_glossary_db()
    db.add_pending(source=payload.source, kind=payload.kind, score=payload.score, evidence_ids=payload.evidence_ids, chapter_key=payload.chapter_key, chapter_url=payload.chapter_url, chapter_title=payload.chapter_title)
    return {'ok': True}

runtime.glossary_pending_add = glossary_pending_add

def glossary_pending_count() -> dict[str, runtime.Any]:
    db = runtime.get_glossary_db()
    return {'ok': True, 'count': db.get_pending_count()}

runtime.glossary_pending_count = glossary_pending_count

async def ocr(payload: runtime.OcrRequest) -> dict[str, runtime.Any]:
    if payload.ocr_geometry_version and payload.ocr_geometry_version != runtime.OCR_GEOMETRY_CONTRACT_VERSION:
        raise runtime.HTTPException(status_code=409, detail='OCR geometry contract mismatch; restart local-ocr-service')
    if runtime.PADDLE_IMPORT_ERROR is not None:
        raise runtime.HTTPException(status_code=500, detail=f'PaddleOCR import failed: {runtime.PADDLE_IMPORT_ERROR}')
    lang = runtime.normalize_lang(payload.lang)
    mode = runtime.normalize_ocr_mode(payload.mode)
    image_bytes = runtime.decode_data_url(payload.image)
    params = runtime.normalize_ocr_params(payload)
    async with runtime._ocr_runtime_lock:
        result = await runtime.asyncio.to_thread(runtime.run_ocr, image_bytes, lang, mode, params, bool(payload.debug), payload.debug_id)
    response = {'items': result['items'], 'boxes': result['boxes'], 'regions': result.get('regions', []), 'detectedRegions': result.get('detectedRegions', []), 'recognizedRegions': result.get('recognizedRegions', []), 'semanticBlocks': result.get('semanticBlocks', []), 'geometryReliability': result.get('geometryReliability', 'fallback'), 'lang': lang, 'mode': mode, 'ocrGeometryVersion': runtime.OCR_GEOMETRY_CONTRACT_VERSION, 'imageWidth': result['imageWidth'], 'imageHeight': result['imageHeight'], 'debug': result.get('debug', {}), 'counts': result.get('counts', {}), 'rawItems': result.get('rawItems', [])}
    if payload.return_cleaned_image:
        cleaned_image = runtime.build_cleaned_image_data_url(image_bytes, result['items'], payload.cleaned_masks)
        if cleaned_image:
            response['cleanedImage'] = cleaned_image
        response['cleanedMaskToken'] = payload.cleaned_mask_token
    return response

runtime.ocr = ocr

async def debug_background(payload: runtime.BackgroundDebugRequest) -> dict[str, runtime.Any]:
    """运行独立背景判定实验，不获取模型锁，也不改变生产阈值。"""
    if not runtime.CV2_AVAILABLE:
        raise runtime.HTTPException(status_code=503, detail='OpenCV is unavailable')
    if not payload.parameterGroups:
        raise runtime.HTTPException(status_code=400, detail='parameterGroups must not be empty')
    try:
        from background_debug import run_background_debug
        image_bytes = runtime.decode_data_url(payload.image)
        return await runtime.asyncio.to_thread(run_background_debug, image_bytes, payload.ocr, payload.labels, payload.parameterGroups)
    except ValueError as exc:
        raise runtime.HTTPException(status_code=400, detail=str(exc)) from exc

runtime.debug_background = debug_background
