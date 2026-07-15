from __future__ import annotations

import asyncio
import os
import sys
import types

from ocr_service.api import app
from ocr_service.exports import __all__
from ocr_service.runtime import runtime


def __getattr__(name: str):
    try:
        return getattr(runtime, name)
    except AttributeError as exc:
        raise AttributeError(name) from exc


class _RuntimeProxyModule(types.ModuleType):
    """让旧测试或调试脚本的 monkeypatch 同步进入模块化运行时。"""

    def __setattr__(self, name: str, value) -> None:
        if name not in {"app", "runtime"} and hasattr(runtime, name):
            setattr(runtime, name, value)
        super().__setattr__(name, value)


sys.modules[__name__].__class__ = _RuntimeProxyModule


if __name__ == "__main__":
    import uvicorn

    if os.name == "nt" and hasattr(asyncio, "WindowsSelectorEventLoopPolicy"):
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    uvicorn.run(app, host="127.0.0.1", port=8765)
