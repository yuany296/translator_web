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

def terms_health(request: runtime.Request) -> dict[str, runtime.Any]:
    query = request.query_params
    base_url = str(query.get('base_url') or '').strip()
    api_key = str(query.get('api_key') or '').strip()
    status = runtime.get_term_extractor_status(
        check_runtime=bool(base_url),
        base_url=base_url,
        api_key=api_key,
    )
    return {'ok': status['available'], **status}

runtime.terms_health = terms_health

async def extract_terms(payload: runtime.TermExtractionRequest) -> dict[str, runtime.Any]:
    blocks = [
        {'id': block.id.strip(), 'text': block.text.strip(), 'translatedText': block.translatedText.strip()}
        for block in payload.blocks
        if block.id.strip() and block.text.strip()
    ]
    if not blocks:
        return {'ok': True, 'engine': 'heuristic', 'candidates': []}
    upstream = {
        'baseUrl': (payload.upstream.baseUrl or '').strip() if payload.upstream else '',
        'model': (payload.upstream.model or '').strip() if payload.upstream else '',
        'apiKey': (payload.upstream.apiKey or '').strip() if payload.upstream else '',
    }
    engine = 'ollama' if upstream['baseUrl'] else 'heuristic'
    candidates = await runtime.asyncio.to_thread(
        runtime.extract_term_candidates, blocks, upstream, payload.target_language or 'zh-CN'
    )
    return {'ok': True, 'engine': engine, 'candidates': candidates}

runtime.extract_terms = extract_terms

def glossary_health() -> dict[str, runtime.Any]:
    try:
        from glossary_store.common import SCHEMA_VERSION
        db = runtime.get_glossary_db()
        count = db.get_entry_count()
        pending = db.get_pending_count()
        revision = db.get_revision()
        return {'ok': True, 'entryCount': count, 'pendingCount': pending, 'revision': revision, 'schemaVersion': SCHEMA_VERSION, 'libraryCount': len(db.list_libraries())}
    except Exception as exc:
        import traceback; traceback.print_exc()
        return {'ok': False, 'error': str(exc)}

runtime.glossary_health = glossary_health

def glossary_list(
    search: str = '', enabled_only: bool = False,
    tgt_lng: str = '', keyword: str = '',
    limit: int = 0, offset: int = 0,
    updated_after: float = 0.0, library_id: str = '',
) -> dict[str, runtime.Any]:
    try:
        db = runtime.get_glossary_db()
        entries = db.get_entries(
            search=search, enabled_only=enabled_only,
            tgt_lng=tgt_lng, keyword=keyword,
            limit=limit, offset=offset,
            updated_after=updated_after, library_id=library_id,
        )
        total = db.get_entry_count(tgt_lng=tgt_lng, keyword=keyword or search, enabled_only=enabled_only)
        revision = db.get_revision()
        return {'ok': True, 'entries': entries, 'total': total, 'revision': revision, 'libraries': db.list_libraries()}
    except Exception as exc:
        import traceback; traceback.print_exc()
        raise runtime.HTTPException(status_code=500, detail=str(exc))

runtime.glossary_list = glossary_list

def glossary_upsert(payload: runtime.GlossaryEntryPayload) -> dict[str, runtime.Any]:
    try:
        db = runtime.get_glossary_db()
        entry = db.upsert_entry(
            source=payload.source, target=payload.target,
            src_lng=getattr(payload, 'src_lng', 'ko'),
            tgt_lng=getattr(payload, 'tgt_lng', ''),
            note=getattr(payload, 'note', ''),
            enabled=getattr(payload, 'enabled', True),
            entry_id=getattr(payload, 'id', ''),
            scope_type=getattr(payload, 'scope_type', 'global'),
            scope_key=getattr(payload, 'scope_key', ''),
            scope_label=getattr(payload, 'scope_label', ''),
            library_id=getattr(payload, 'library_id', ''),
            library_name=getattr(payload, 'library_name', ''),
        )
        return {'ok': True, 'entry': entry}
    except Exception as exc:
        import traceback; traceback.print_exc()
        raise runtime.HTTPException(status_code=500, detail=str(exc))

runtime.glossary_upsert = glossary_upsert

def glossary_batch_upsert(payload: runtime.GlossaryBatchPayload) -> dict[str, runtime.Any]:
    try:
        db = runtime.get_glossary_db()
        entries = getattr(payload, 'entries', []) or []
        tgt_lng = getattr(payload, 'tgt_lng', '')
        stats = db.upsert_batch(entries, tgt_lng=tgt_lng)
        stats['ok'] = stats['failed'] == 0
        stats['revision'] = db.get_revision()
        return stats
    except Exception as exc:
        import traceback; traceback.print_exc()
        raise runtime.HTTPException(status_code=500, detail=str(exc))

runtime.glossary_batch_upsert = glossary_batch_upsert

def glossary_delete(entry_id: str) -> dict[str, runtime.Any]:
    try:
        db = runtime.get_glossary_db()
        deleted = db.delete_entry(entry_id)
        if not deleted:
            raise runtime.HTTPException(status_code=404, detail='Entry not found')
        return {'ok': True}
    except Exception as exc:
        import traceback; traceback.print_exc()
        raise runtime.HTTPException(status_code=500, detail=str(exc))

runtime.glossary_delete = glossary_delete

def glossary_clear() -> dict[str, runtime.Any]:
    try:
        db = runtime.get_glossary_db()
        count = db.clear_all_entries()
        return {'ok': True, 'deleted': count}
    except Exception as exc:
        import traceback; traceback.print_exc()
        raise runtime.HTTPException(status_code=500, detail=str(exc))

runtime.glossary_clear = glossary_clear

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

def glossary_pending_add(payload: runtime.GlossaryAddPendingPayload) -> dict[str, runtime.Any]:
    db = runtime.get_glossary_db()
    db.add_pending(source=payload.source, kind=payload.kind, score=payload.score, evidence_ids=payload.evidence_ids, chapter_key=payload.chapter_key, chapter_url=payload.chapter_url, chapter_title=payload.chapter_title, library_id=getattr(payload, 'library_id', ''))
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
        result = await runtime.asyncio.to_thread(
            runtime.run_ocr,
            image_bytes,
            lang,
            mode,
            params,
            bool(payload.debug),
            payload.debug_id,
            payload.seam_rows,
        )
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
