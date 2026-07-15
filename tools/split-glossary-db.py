from __future__ import annotations

import ast
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source_path = root / "local-ocr-service" / "glossary_db.py"
source = source_path.read_text(encoding="utf-8")
lines = source.splitlines(keepends=True)
module = ast.parse(source)
class_node = next(node for node in module.body if isinstance(node, ast.ClassDef) and node.name == "GlossaryDB")
methods = {node.name: node for node in class_node.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}


def method_source(name: str) -> str:
    node = methods[name]
    return "".join(lines[node.lineno - 1:node.end_lineno]).rstrip()


def write_mixin(path: Path, class_name: str, names: list[str]) -> None:
    header = '''from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from .common import normalize_source


'''
    body = f"class {class_name}:\n" + "\n\n".join(method_source(name) for name in names) + "\n"
    path.write_text(header + body.replace("_normalize_source", "normalize_source"), encoding="utf-8")


package = root / "local-ocr-service" / "glossary_store"
package.mkdir(exist_ok=True)
common = '''from __future__ import annotations

import os
import sqlite3
import threading

SCHEMA_VERSION = 1


def normalize_source(value: str) -> str:
    return value.strip().lower() if value else ""


class GlossaryBase:
'''
common += "\n\n".join(method_source(name) for name in ["__init__", "_init_db"]) + "\n"
(package / "common.py").write_text(common, encoding="utf-8")
write_mixin(package / "entries.py", "EntriesMixin", [
    "get_entries", "get_entry", "add_entry", "update_entry", "delete_entry",
    "get_enabled_entries", "get_entry_count",
])
write_mixin(package / "pending.py", "PendingMixin", [
    "get_pending", "get_pending_count", "get_pending_chapters", "add_pending",
    "confirm_pending", "delete_pending",
])
write_mixin(package / "transfer.py", "TransferMixin", [
    "get_ignored", "add_ignored", "remove_ignored", "import_entries", "export_json",
    "_row_to_entry", "_row_to_pending",
])
(package / "__init__.py").write_text('''from .common import GlossaryBase
from .entries import EntriesMixin
from .pending import PendingMixin
from .transfer import TransferMixin


class GlossaryDB(EntriesMixin, PendingMixin, TransferMixin, GlossaryBase):
    """Persistent glossary storage backed by SQLite."""


__all__ = ["GlossaryDB"]
''', encoding="utf-8")
source_path.write_text('''"""Compatibility import for the modular glossary database."""

from glossary_store import GlossaryDB

__all__ = ["GlossaryDB"]
''', encoding="utf-8")
