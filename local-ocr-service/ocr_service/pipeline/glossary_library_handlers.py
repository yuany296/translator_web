"""术语库定义的 REST 接口：列表 / 新建或更新 / 删除。

条目本身的增删改仍在 `/glossary` 上；这里只维护库的名称、启用开关、绑定网址与应用网址。
"""

from __future__ import annotations

from ..dependencies import runtime


def glossary_libraries_list() -> dict[str, runtime.Any]:
    try:
        db = runtime.get_glossary_db()
        return {'ok': True, 'libraries': db.list_libraries()}
    except Exception as exc:
        import traceback
        traceback.print_exc()
        raise runtime.HTTPException(status_code=500, detail=str(exc))


runtime.glossary_libraries_list = glossary_libraries_list


def glossary_library_upsert(payload: runtime.GlossaryLibraryPayload) -> dict[str, runtime.Any]:
    try:
        db = runtime.get_glossary_db()
        name = (getattr(payload, 'name', '') or '').strip()
        library_id = (getattr(payload, 'id', '') or '').strip()
        if not library_id and not name:
            raise runtime.HTTPException(status_code=400, detail='术语库需要 id 或名称')
        library = db.upsert_library(
            library_id=library_id,
            name=name,
            enabled=getattr(payload, 'enabled', True) is not False,
            urls=getattr(payload, 'urls', []) or [],
            apply_urls=getattr(payload, 'applyUrls', []) or [],
        )
        return {'ok': True, 'library': library, 'libraries': db.list_libraries()}
    except runtime.HTTPException:
        raise
    except Exception as exc:
        import traceback
        traceback.print_exc()
        raise runtime.HTTPException(status_code=500, detail=str(exc))


runtime.glossary_library_upsert = glossary_library_upsert


def glossary_library_delete(library_id: str) -> dict[str, runtime.Any]:
    try:
        db = runtime.get_glossary_db()
        result = db.delete_library(library_id)
        if result.get('error'):
            raise runtime.HTTPException(status_code=400, detail=str(result['error']))
        return {'ok': True, 'moved': result.get('moved', 0), 'libraries': db.list_libraries()}
    except runtime.HTTPException:
        raise
    except Exception as exc:
        import traceback
        traceback.print_exc()
        raise runtime.HTTPException(status_code=500, detail=str(exc))


runtime.glossary_library_delete = glossary_library_delete
