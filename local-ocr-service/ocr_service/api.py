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
    allow_origins=["*"],
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)
runtime.app = app

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
]
for route_path, endpoint, methods in routes:
    app.add_api_route(route_path, endpoint, methods=methods)
