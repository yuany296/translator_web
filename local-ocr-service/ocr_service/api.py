from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import dependencies as _dependencies
from . import models as _models
from . import pipeline as _pipeline
from .runtime import runtime

app = FastAPI(title="Manga Translator Local OCR")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=runtime.EXTENSION_ORIGIN_PATTERN,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["authorization", "content-type", "x-manga-translator-origin"],
)
runtime.app = app


@app.middleware("http")
async def require_local_service_auth(request, call_next):
    path = request.url.path
    try:
        content_length = int(request.headers.get("content-length") or 0)
    except ValueError:
        content_length = 0
    if path == "/translations/import" and content_length > 10 * 1024 * 1024:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=413, content={"detail": "translation import exceeds 10 MiB"})
    if request.method == "OPTIONS" or path in {"/health", "/translations/pair"}:
        return await call_next(request)
    authorization = str(request.headers.get("authorization") or "")
    token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    origin = str(request.headers.get("origin") or
                 request.headers.get("x-manga-translator-origin") or "")
    if not token or not runtime.get_translation_store().verify_access(token, origin):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=401, content={"detail": "local service authentication required"})
    return await call_next(request)

routes = [
    ("/health", runtime.health, ["GET"]),
    ("/terms/health", runtime.terms_health, ["GET"]),
    ("/terms/extract", runtime.extract_terms, ["POST"]),
    ("/glossary/health", runtime.glossary_health, ["GET"]),
    ("/glossary", runtime.glossary_list, ["GET"]),
    ("/glossary", runtime.glossary_upsert, ["PUT"]),
    ("/glossary/batch", runtime.glossary_batch_upsert, ["POST"]),
    ("/glossary/clear", runtime.glossary_clear, ["POST"]),
    ("/glossary/import-db", runtime.glossary_import_db, ["POST"]),
    ("/glossary/{entry_id}", runtime.glossary_delete, ["DELETE"]),
    ("/glossary/pending", runtime.glossary_pending_list, ["GET"]),
    ("/glossary/pending/confirm", runtime.glossary_pending_confirm, ["POST"]),
    ("/glossary/pending/ignore", runtime.glossary_pending_ignore, ["POST"]),
    ("/glossary/ignored", runtime.glossary_ignored_list, ["GET"]),
    ("/glossary/ignored/restore", runtime.glossary_ignored_restore, ["POST"]),
    ("/glossary/export", runtime.glossary_export, ["POST"]),
    ("/glossary/import", runtime.glossary_import, ["POST"]),
    ("/glossary/pending", runtime.glossary_pending_add, ["POST"]),
    ("/glossary/pending/count", runtime.glossary_pending_count, ["GET"]),
    ("/ocr", runtime.ocr, ["POST"]),
    ("/debug-background", runtime.debug_background, ["POST"]),
    ("/translations/pair", runtime.translations_pair, ["POST"]),
    ("/translations/health", runtime.translations_health, ["GET"]),
    ("/translations/query", runtime.translations_query, ["POST"]),
    ("/translations/operations", runtime.translations_operations, ["POST"]),
    ("/translations/stream", runtime.translations_stream, ["POST"]),
    ("/translations/batch-import", runtime.translations_batch_import, ["POST"]),
    ("/translations/{record_id}/versions", runtime.translations_versions, ["GET"]),
    ("/translations/export", runtime.translations_export, ["GET"]),
    ("/translations/import", runtime.translations_import, ["POST"]),
]
for route_path, endpoint, methods in routes:
    app.add_api_route(route_path, endpoint, methods=methods)
