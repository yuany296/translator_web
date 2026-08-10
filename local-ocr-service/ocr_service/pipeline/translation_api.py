from __future__ import annotations

from typing import Any

from ..dependencies import runtime
from translation_store import TranslationConflict, TranslationNotFound


def get_translation_store():
    if runtime._translation_store is None:
        runtime._translation_store = runtime.TranslationStore(runtime.TRANSLATION_DB_PATH)
    return runtime._translation_store


runtime.get_translation_store = get_translation_store


def translations_health() -> dict[str, Any]:
    snapshot = get_translation_store().query([])
    return {"ok": True, "schemaVersion": 1, "changeSeq": snapshot["changeSeq"]}


runtime.translations_health = translations_health


def translations_query(payload: runtime.TranslationQueryPayload):
    return get_translation_store().query(payload.recordKeys, payload.includeDeleted)


runtime.translations_query = translations_query


def translations_operations(payload: runtime.TranslationOperationsPayload):
    store = get_translation_store()
    try:
        results = store.apply_operations(payload.operations)
        return {"ok": True, "results": results,
                "changeSeq": max((item.get("changeSeq", 0) for item in results), default=0)}
    except TranslationConflict as exc:
        operation = payload.operations[0] if payload.operations else {}
        current = store.resolve_snapshot(
            str(operation.get("recordId") or ""), str(operation.get("recordKey") or "")
        )
        raise runtime.HTTPException(status_code=409, detail={
            "error": str(exc), "currentRecord": current,
        }) from exc
    except TranslationNotFound as exc:
        raise runtime.HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise runtime.HTTPException(status_code=400, detail=str(exc)) from exc


runtime.translations_operations = translations_operations


def _legacy_operation(record: dict[str, Any]) -> dict[str, Any] | None:
    record_key = str(record.get("recordKey") or record.get("id") or "")[:160]
    translated = str(record.get("translatedText") or "")[:100_000]
    if not record_key or not translated:
        return None
    return {
        "operationId": f"legacy-import:{record_key}",
        "type": "commit_translation", "recordKey": record_key,
        "payload": {**record, "translatedText": translated, "source": "import",
                    "scopeKey": record.get("scopeKey") or "legacy",
                    "segmentKey": record.get("segmentKey") or record_key,
                    "mode": record.get("mode") or "webpage",
                    "resolvedSourceLanguage": record.get("resolvedSourceLanguage") or "auto",
                    "targetLanguage": record.get("targetLanguage") or "zh-CN"},
        "createdAt": int(record.get("updatedAt") or 0),
    }


def translations_batch_import(payload: runtime.TranslationImportPayload):
    operations = [_legacy_operation(record) for record in payload.records if isinstance(record, dict)]
    operations = [operation for operation in operations if operation]
    if not operations:
        return {"ok": True, "imported": 0, "results": []}
    try:
        results = get_translation_store().apply_operations(operations[:500])
    except (TranslationConflict, ValueError) as exc:
        raise runtime.HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "imported": len(results), "results": results}


runtime.translations_batch_import = translations_batch_import


def translations_versions(record_id: str):
    try:
        return get_translation_store().versions(record_id)
    except TranslationNotFound as exc:
        raise runtime.HTTPException(status_code=404, detail=str(exc)) from exc


runtime.translations_versions = translations_versions


def translations_export():
    return {"ok": True, "data": get_translation_store().export_data()}


runtime.translations_export = translations_export


def translations_dedupe():
    from translation_store.dedupe import dedupe_translation_records
    return {"ok": True, **dedupe_translation_records(get_translation_store())}


runtime.translations_dedupe = translations_dedupe


def translations_import(payload: runtime.TranslationImportPayload):
    if payload.confirmation != "IMPORT_TRANSLATIONS":
        raise runtime.HTTPException(status_code=400, detail="explicit import confirmation is required")
    exported = [entry for entry in payload.records
                if isinstance(entry, dict) and isinstance(entry.get("record"), dict)]
    if exported:
        try:
            return get_translation_store().import_export_records(exported)
        except (TranslationConflict, ValueError) as exc:
            raise runtime.HTTPException(status_code=400, detail=str(exc)) from exc
    return translations_batch_import(payload)


runtime.translations_import = translations_import
