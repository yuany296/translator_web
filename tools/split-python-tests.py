from __future__ import annotations

import ast
import sys
from pathlib import Path


def source_segment(lines: list[str], node: ast.AST) -> str:
    start = node.lineno - 1
    end = node.end_lineno
    return "".join(lines[start:end]).rstrip() + "\n"


for raw_path in sys.argv[1:]:
    path = Path(raw_path)
    source = path.read_text(encoding="utf-8")
    lines = source.splitlines(keepends=True)
    module = ast.parse(source)
    tests = [
        node for node in module.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_")
    ]
    support = [node for node in module.body if node not in tests]
    support_text = "\n\n".join(source_segment(lines, node).rstrip() for node in support).rstrip() + "\n\n"
    chunks: list[list[ast.AST]] = []
    chunk: list[ast.AST] = []
    for node in tests:
        candidate = support_text + "\n\n".join(source_segment(lines, item).rstrip() for item in [*chunk, node])
        if chunk and len(candidate.splitlines()) > 700:
            chunks.append(chunk)
            chunk = [node]
        else:
            chunk.append(node)
    if chunk:
        chunks.append(chunk)

    stem = path.stem.removeprefix("test_")
    for existing in path.parent.glob(f"test_{stem}_part*.py"):
        existing.unlink()
    for index, nodes in enumerate(chunks, 1):
        output = path.parent / f"test_{stem}_part{index:02d}.py"
        body = "\n\n".join(source_segment(lines, node).rstrip() for node in nodes)
        output.write_text(support_text + body + "\n", encoding="utf-8")
    path.unlink()
    print(f"{path}: {len(tests)} tests -> {len(chunks)} files")
