import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import generatorModule from "@babel/generator";
import * as t from "@babel/types";

const traverse = traverseModule.default || traverseModule;
const generate = generatorModule.default || generatorModule;
const root = path.resolve(import.meta.dirname, "..");

const plans = {
  glossary: {
    source: "src/glossary.js",
    output: "extension/src/glossary/modules",
    iife: false,
    seedBindings: new Set(["glossaryCore", "termDiscoveryCore"]),
    domains: [[0, 260, "editor"], [261, 520, "pending"], [521, 99999, "storage"]]
  },
  background: {
    source: "src/background.js",
    output: "extension/src/background/modules",
    iife: false,
    seedBindings: new Set(["glossaryCore", "termDiscoveryCore", "Utils"]),
    domains: [
      [0, 232, "bootstrap"], [233, 677, "messages"], [678, 1909, "observations"],
      [1910, 2160, "capture"], [2161, 2626, "combined-legacy"], [2627, 3109, "ocr-provider"],
      [3110, 4409, "ocr-grouping"], [4410, 5745, "ocr-geometry"], [5746, 6335, "baidu"],
      [6336, 7600, "translation"], [7601, 99999, "platform"]
    ]
  },
  content: {
    source: "src/content.js",
    output: "extension/src/content/modules",
    iife: true,
    seedBindings: new Set(["KP", "KR"]),
    skipBeforeLine: 9,
    domains: [
      [0, 1000, "reader-runtime"], [1001, 1417, "scheduler"], [1418, 3179, "recognition"],
      [3180, 3578, "capture"], [3579, 4703, "scene"], [4704, 5570, "renderer"],
      [5571, 6815, "lifecycle"], [6816, 7599, "reader-controls"], [7600, 8330, "target-discovery"],
      [8331, 99999, "platform"]
    ]
  },
  pipeline: {
    source: "src/kakao-pipeline.js",
    output: "extension/src/canonical/modules",
    iife: true,
    globalExport: "MangaTranslatorKakaoPipeline",
    domains: [
      [0, 1619, "geometry"], [1620, 2419, "page-store"], [2420, 2849, "pipeline"],
      [2850, 4339, "canonical-pipeline"], [4340, 4898, "projection"], [4899, 5709, "scene-index"],
      [5710, 99999, "dedupe"]
    ]
  },
  reconciler: {
    source: "src/kakao-reconciler.js",
    output: "extension/src/canonical/reconciler-modules",
    iife: true,
    globalExport: "MangaTranslatorKakaoReconciler",
    domains: [[0, 299, "observation"], [300, 854, "seam"], [855, 1286, "canonical"], [1287, 1757, "projection"], [1758, 99999, "store"]]
  }
};

function bindingNames(pattern, result = []) {
  if (t.isIdentifier(pattern)) result.push(pattern.name);
  else if (t.isRestElement(pattern)) bindingNames(pattern.argument, result);
  else if (t.isAssignmentPattern(pattern)) bindingNames(pattern.left, result);
  else if (t.isObjectPattern(pattern)) {
    for (const property of pattern.properties) bindingNames(t.isRestElement(property) ? property.argument : property.value, result);
  } else if (t.isArrayPattern(pattern)) {
    for (const item of pattern.elements) if (item) bindingNames(item, result);
  }
  return result;
}

function declarationNames(node) {
  if (t.isFunctionDeclaration(node) || t.isClassDeclaration(node)) return node.id ? [node.id.name] : [];
  if (t.isVariableDeclaration(node)) return node.declarations.flatMap((item) => bindingNames(item.id));
  return [];
}

function isWritableIdentifier(identifierPath) {
  if (identifierPath.isReferencedIdentifier()) return true;
  const parent = identifierPath.parentPath;
  return (parent.isAssignmentExpression() && parent.get("left") === identifierPath)
    || (parent.isUpdateExpression() && parent.get("argument") === identifierPath);
}

function assignmentFor(name) {
  return t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier("runtime"), t.identifier(name)), t.identifier(name)));
}

function installerStatements(node) {
  const names = declarationNames(node);
  if (names.length === 0) return [node];
  return [node, ...names.map(assignmentFor)];
}

function domainFor(plan, line) {
  return plan.domains.find(([start, end]) => line >= start && line <= end)?.[2] || "misc";
}

function phaseFor(node) {
  if (t.isFunctionDeclaration(node)) return "functions";
  if (t.isVariableDeclaration(node) || t.isClassDeclaration(node)) return "state";
  return "startup";
}

function moduleCode(installerName, statements) {
  const body = t.blockStatement(statements);
  const fn = t.exportNamedDeclaration(t.functionDeclaration(t.identifier(installerName), [t.identifier("runtime")], body));
  return `${generate(t.program([fn]), { comments: true }).code}\n`;
}

function splitPlan(name, plan) {
  const sourcePath = path.join(root, plan.source);
  const ast = parse(fs.readFileSync(sourcePath, "utf8"), { sourceType: "script" });
  let body = ast.program.body;
  let topScopeBlock = ast.program;
  if (plan.iife) {
    const expression = body[0]?.expression;
    const callee = t.isCallExpression(expression) ? expression.callee : null;
    if (!callee || !t.isBlockStatement(callee.body)) throw new Error(`${plan.source} is not an IIFE`);
    body = callee.body.body;
    topScopeBlock = callee;
  }
  const topNames = new Set(body.flatMap(declarationNames));
  traverse(ast, {
    Identifier(identifierPath) {
      const nameValue = identifierPath.node.name;
      if (!topNames.has(nameValue) || !isWritableIdentifier(identifierPath)) return;
      const binding = identifierPath.scope.getBinding(nameValue);
      if (!binding || binding.scope.block !== topScopeBlock) return;
      identifierPath.replaceWith(t.memberExpression(t.identifier("runtime"), t.identifier(nameValue)));
      identifierPath.skip();
    },
    AssignmentExpression(assignmentPath) {
      const left = assignmentPath.node.left;
      if (!plan.globalExport || !t.isMemberExpression(left) || !t.isIdentifier(left.object, { name: "globalThis" })) return;
      if (!t.isIdentifier(left.property, { name: plan.globalExport })) return;
      assignmentPath.node.left = t.memberExpression(t.identifier("runtime"), t.identifier("api"));
    }
  });

  const transformedBody = plan.iife
    ? ast.program.body[0].expression.callee.body.body
    : ast.program.body;
  const filtered = transformedBody.filter((node) => {
    if (plan.skipBeforeLine && node.loc.start.line < plan.skipBeforeLine) return false;
    const names = declarationNames(node);
    if (names.some((item) => plan.seedBindings?.has(item))) return false;
    if (t.isIfStatement(node) && node.loc.start.line < 20) return false;
    return true;
  });

  fs.rmSync(path.join(root, plan.output), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, plan.output), { recursive: true });
  // ESM 拆分后不再共享原脚本的函数声明提升；先安装全部函数，再按原顺序
  // 初始化常量和执行启动语句，保持 API 对后置函数的引用语义。
  const ordered = [
    ...filtered.filter((node) => t.isFunctionDeclaration(node)),
    ...filtered.filter((node) => !t.isFunctionDeclaration(node))
  ];
  const groups = [];
  let current = null;
  for (const node of ordered) {
    const domain = domainFor(plan, node.loc.start.line);
    const phase = phaseFor(node);
    const statements = installerStatements(node);
    const renderedLines = generate(t.program(statements), { comments: true }).code.split(/\r?\n/u).length;
    if (!current || current.domain !== domain || current.phase !== phase || current.lines + renderedLines > 340) {
      current = { domain, phase, statements: [], lines: 0 };
      groups.push(current);
    }
    current.statements.push(...statements);
    current.lines += renderedLines;
  }
  const installers = [];
  groups.forEach((group, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    const fileName = `${suffix}-${group.domain}.js`;
    const installerName = `install${name[0].toUpperCase()}${name.slice(1)}${suffix}`;
    fs.writeFileSync(path.join(root, plan.output, fileName), moduleCode(installerName, group.statements));
    installers.push({ fileName, installerName, phase: group.phase });
  });
  return installers;
}

for (const [name, plan] of Object.entries(plans)) {
  const installers = splitPlan(name, plan);
  const indexCode = installers.map(({ fileName, installerName }) => `import { ${installerName} } from "./${fileName}";`).join("\n")
    + `\n\nexport const ${name}Installers = Object.freeze([\n`
    + installers.map(({ installerName }) => `  ${installerName}`).join(",\n")
    + `\n]);\n\nexport const ${name}Phases = Object.freeze({\n`
    + ["functions", "state", "startup"].map((phase) => `  ${phase}: Object.freeze([${installers.filter((item) => item.phase === phase).map((item) => item.installerName).join(", ")}])`).join(",\n")
    + "\n});\n";
  fs.writeFileSync(path.join(root, plan.output, "index.js"), indexCode);
  console.log(`${name}: ${installers.length} modules`);
}
