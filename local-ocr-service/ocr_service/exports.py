from . import dependencies as _dependencies
from . import models as _models
from . import pipeline as _pipeline
from .runtime import runtime

__all__ = sorted(name for name in runtime.__dict__ if name != "runtime")


def __getattr__(name: str):
    try:
        return getattr(runtime, name)
    except AttributeError as exc:
        raise AttributeError(name) from exc
