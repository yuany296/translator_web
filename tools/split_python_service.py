from __future__ import annotations

import ast
import copy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "local-ocr-service" / "server.py"
OUTPUT = ROOT / "local-ocr-service" / "ocr_service" / "generated"
DOMAINS = [
    (179, 429, "api_handlers"), (430, 633, "orchestrator"),
    (634, 1380, "appearance"), (1381, 1569, "debug_artifacts"),
    (1570, 1797, "preprocess"), (1798, 1940, "providers"),
    (1941, 2095, "parsing"), (2096, 2529, "dedupe"),
    (2530, 2786, "geometry"), (2787, 99999, "recognition"),
]


def assigned_names(node: ast.AST) -> set[str]:
    result: set[str] = set()
    if isinstance(node, ast.Name):
        result.add(node.id)
    elif isinstance(node, (ast.Tuple, ast.List)):
        for item in node.elts:
            result.update(assigned_names(item))
    return result


def collect_top_bindings(tree: ast.Module) -> set[str]:
    names: set[str] = set()

    def visit(node: ast.AST) -> None:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
            return
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                names.add(alias.asname or alias.name.split(".")[0])
            return
        if isinstance(node, ast.Assign):
            for target in node.targets:
                names.update(assigned_names(target))
        elif isinstance(node, ast.AnnAssign):
            names.update(assigned_names(node.target))
        for child in ast.iter_child_nodes(node):
            visit(child)

    for statement in tree.body:
        visit(statement)
    names.update({"cv2", "np", "PADDLEOCR_IMPORT_ERROR", "PADDLE_IMPORT_ERROR"})
    return names


class LocalCollector(ast.NodeVisitor):
    def __init__(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self.locals = {
            argument.arg
            for argument in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
        }
        if node.args.vararg:
            self.locals.add(node.args.vararg.arg)
        if node.args.kwarg:
            self.locals.add(node.args.kwarg.arg)
        self.globals: set[str] = set()

    def visit_Global(self, node: ast.Global) -> None:
        self.globals.update(node.names)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            self.locals.add(node.id)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.locals.add(node.name)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.locals.add(node.name)


class RuntimeTransformer(ast.NodeTransformer):
    def __init__(self, global_names: set[str]) -> None:
        self.global_names = global_names
        self.scopes: list[set[str]] = []

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> ast.AST:
        collector = LocalCollector(node)
        for statement in node.body:
            collector.visit(statement)
        self.scopes.append(collector.locals - collector.globals)
        node.decorator_list = []
        node.args = self.visit(node.args)
        node.returns = self.visit(node.returns) if node.returns else None
        node.body = [result for statement in node.body if (result := self.visit(statement)) is not None]
        self.scopes.pop()
        return node

    def visit_FunctionDef(self, node: ast.FunctionDef) -> ast.AST:
        return self._visit_function(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> ast.AST:
        return self._visit_function(node)

    def visit_Global(self, _node: ast.Global) -> None:
        return None

    def visit_Name(self, node: ast.Name) -> ast.AST:
        is_local = bool(self.scopes and node.id in self.scopes[-1])
        if node.id in self.global_names and not is_local:
            return ast.copy_location(
                ast.Attribute(value=ast.Name(id="runtime", ctx=ast.Load()), attr=node.id, ctx=node.ctx),
                node,
            )
        return node


def domain_for(line: int) -> str:
    return next(name for start, end, name in DOMAINS if start <= line <= end)


def render_module(functions: list[ast.AST]) -> str:
    rows = ["from __future__ import annotations", "", "from ..dependencies import runtime", ""]
    for function in functions:
        rows.extend([ast.unparse(function), "", f"runtime.{function.name} = {function.name}", ""])
    return "\n".join(rows).rstrip() + "\n"


tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
global_names = collect_top_bindings(tree)
functions = [
    node for node in tree.body
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.lineno >= 179
]
transformer = RuntimeTransformer(global_names)
transformed = [ast.fix_missing_locations(transformer.visit(copy.deepcopy(node))) for node in functions]

OUTPUT.mkdir(parents=True, exist_ok=True)
for old in OUTPUT.glob("*.py"):
    old.unlink()
groups: list[tuple[str, list[ast.AST]]] = []
current_domain = ""
current: list[ast.AST] = []
current_lines = 0
for original, function in zip(functions, transformed, strict=True):
    domain = domain_for(original.lineno)
    lines = len(ast.unparse(function).splitlines()) + 3
    if current and (domain != current_domain or current_lines + lines > 330):
        groups.append((current_domain, current))
        current = []
        current_lines = 0
    current_domain = domain
    current.append(function)
    current_lines += lines
if current:
    groups.append((current_domain, current))

module_names = []
for index, (domain, group) in enumerate(groups, 1):
    module_name = f"m{index:02d}_{domain}"
    module_names.append(module_name)
    (OUTPUT / f"{module_name}.py").write_text(render_module(group), encoding="utf-8")
(OUTPUT / "__init__.py").write_text(
    "\n".join(f"from . import {name}" for name in module_names) + "\n",
    encoding="utf-8",
)
print(f"generated {len(module_names)} modules and {len(functions)} functions")
