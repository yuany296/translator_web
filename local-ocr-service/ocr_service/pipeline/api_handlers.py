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
    return {'ok': runtime.PADDLE_IMPORT_ERROR is None and (not device_error), 'engine': 'paddleocr', 'ocrGeometryVersion': runtime.OCR_GEOMETRY_CONTRACT_VERSION, 'device': device, 'cuda': runtime.is_cuda_available(), 'cv2_available': runtime.CV2_AVAILABLE, 'warmup': getattr(runtime, 'ocr_warmup_state', None), 'term_extractor_available': term_extractor['available'], 'term_extractor_engine': term_extractor['engine'], 'term_extractor_error': term_extractor['error'], 'error': str(runtime.PADDLE_IMPORT_ERROR) if runtime.PADDLE_IMPORT_ERROR else device_error}

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

def terms_warm() -> dict[str, runtime.Any]:
    """预热本地模型：把 worker 拉起并跑一句最小推理。

    冷启动（加载权重）实测 10~45 秒；它藏在第一次真实提取里就会顶着扩展的超时预算跑，
    表现出来是「第一章一条术语都没收到」。已热时直接回 cached，不再重复推理。
    """
    status = runtime.get_term_extractor_status()
    if status['engine'] != 'ner':
        return {'ok': False, 'engine': status['engine'], 'elapsedMs': 0, 'error': status['nerError']}
    if runtime.ner_is_warm():
        return {'ok': True, 'engine': 'ner', 'elapsedMs': 0, 'error': '', 'cached': True}
    result = runtime.warm_up_term_extractor()
    return {'ok': bool(result['warmed']), 'engine': 'ner', 'elapsedMs': result['elapsedMs'], 'error': result['error']}

runtime.terms_warm = terms_warm

async def extract_terms(payload: runtime.TermExtractionRequest) -> dict[str, runtime.Any]:
    blocks = [
        {'id': block.id.strip(), 'text': block.text.strip(), 'translatedText': block.translatedText.strip()}
        for block in payload.blocks
        if block.id.strip() and block.text.strip()
    ]
    if not blocks:
        return {'ok': True, 'engine': 'none', 'candidates': []}
    upstream = {
        'baseUrl': (payload.upstream.baseUrl or '').strip() if payload.upstream else '',
        'model': (payload.upstream.model or '').strip() if payload.upstream else '',
        'apiKey': (payload.upstream.apiKey or '').strip() if payload.upstream else '',
        # 只放行这两个已知参数名：空 dict = 不干预（扩展侧「跟随模型默认」时的取值）
        'thinking': {
            key: value for key, value in dict(payload.upstream.thinking or {}).items()
            if key in {'thinking', 'enable_thinking'}
        } if payload.upstream else {},
    }
    # 没配 LLM 时引擎由本地服务自己定：模型在位是 ner，缺失是 none（见 ner_engine_status）。
    engine = 'ollama' if upstream['baseUrl'] else runtime.get_term_extractor_status()['engine']
    candidates, dropped = await runtime.asyncio.to_thread(
        runtime.extract_term_candidates_with_stats, blocks, upstream, payload.target_language or 'zh-CN'
    )
    # dropped：模型返回了但被判掉的条数与原因（kind 非法 / 原文里找不到 / schema 不符）。
    # 扩展侧把它写进「最近一次提取」，术语没收集到时才能分清是「模型没给」还是「给了被丢」。
    return {'ok': True, 'engine': engine, 'candidates': candidates, 'dropped': dropped}

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
            # 404 必须原样返回：这里吞掉它包成 500 的话，客户端只能报「删除失败」，
            # 而真实原因是「服务端没有这个 id」（本地与服务端 id 不一致）。
            raise runtime.HTTPException(status_code=404, detail='Entry not found')
        return {'ok': True}
    except runtime.HTTPException:
        raise
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
    # 计时从收到请求开始；decode 与推理槽位排队都单独记账。
    timings = runtime.ocr_request_timings_begin()
    request_started = runtime.ocr_request_timings_now()
    image_bytes = runtime.decode_data_url(payload.image)
    runtime.ocr_request_timings_add('decode', (runtime.ocr_request_timings_now() - request_started) * 1000.0)
    params = runtime.normalize_ocr_params(payload)
    # 不再用一把全局锁包住整个 run_ocr：只有 Paddle 推理走预测槽位（runtime.predict_guard），
    # 解码/透视裁剪/外观分析/清理图/写盘可以与其他请求的推理重叠。
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
        cleaned_started = runtime.ocr_request_timings_now()
        cleaned_image = runtime.build_cleaned_image_data_url(image_bytes, result['items'], payload.cleaned_masks)
        runtime.ocr_request_timings_add('cleanedImage', (runtime.ocr_request_timings_now() - cleaned_started) * 1000.0)
        if cleaned_image:
            response['cleanedImage'] = cleaned_image
        response['cleanedMaskToken'] = payload.cleaned_mask_token
    response['timings'] = runtime.ocr_request_timings_finish(timings, (runtime.ocr_request_timings_now() - request_started) * 1000.0)
    return response

runtime.ocr = ocr

def ocr_timings() -> dict[str, runtime.Any]:
    """最近若干次 /ocr 请求的分阶段耗时（p50/p95），用于定位慢在哪一段。"""
    return runtime.ocr_request_timings_summarize()

runtime.ocr_timings = ocr_timings

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
