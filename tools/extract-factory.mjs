import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import generatorModule from "@babel/generator";
import * as t from "@babel/types";

const traverse = traverseModule.default || traverseModule;
const generate = generatorModule.default || generatorModule;
const root = path.resolve(import.meta.dirname, "..");
const tasks = [
  ["extension/src/canonical/modules/06-page-store.js", "createStore", "page-store-factory", "installPipeline06"],
  ["extension/src/canonical/modules/08-pipeline.js", "createPipeline", "pipeline-factory", "installPipeline08"],
  ["extension/src/canonical/modules/09-canonical-pipeline.js", "createCanonicalPipeline", "canonical-pipeline-factory", "installPipeline09"]
];

function patternNames(pattern, names = []) {
  if (t.isIdentifier(pattern)) names.push(pattern.name);
  else if (t.isRestElement(pattern)) patternNames(pattern.argument, names);
  else if (t.isAssignmentPattern(pattern)) patternNames(pattern.left, names);
  else if (t.isObjectPattern(pattern)) for (const property of pattern.properties) patternNames(t.isRestElement(property) ? property.argument : property.value, names);
  else if (t.isArrayPattern(pattern)) for (const item of pattern.elements) if (item) patternNames(item, names);
  return names;
}

function declarationNames(node) {
  if (t.isFunctionDeclaration(node) || t.isClassDeclaration(node)) return node.id ? [node.id.name] : [];
  if (t.isVariableDeclaration(node)) return node.declarations.flatMap((item) => patternNames(item.id));
  return [];
}

function isValueUse(identifierPath) {
  if (identifierPath.isReferencedIdentifier()) return true;
  const parent = identifierPath.parentPath;
  return (parent.isAssignmentExpression() && parent.get("left") === identifierPath)
    || (parent.isUpdateExpression() && parent.get("argument") === identifierPath);
}

function scopeAssignment(name) {
  return t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier("scope"), t.identifier(name)), t.identifier(name)));
}

function moduleSource(name, statements) {
  const fn = t.functionDeclaration(t.identifier(name), [t.identifier("runtime"), t.identifier("scope")], t.blockStatement(statements));
  return `${generate(t.program([t.exportNamedDeclaration(fn)]), { comments: true }).code}\n`;
}

for (const [input, factoryName, outputName, outerInstallerName] of tasks) {
  const inputPath = path.join(root, input);
  const ast = parse(fs.readFileSync(inputPath, "utf8"), { sourceType: "module" });
  let targetPath = null;
  traverse(ast, {
    FunctionDeclaration(current) {
      if (current.node.id?.name === factoryName) targetPath = current;
    }
  });
  if (!targetPath) throw new Error(`${factoryName} not found in ${input}`);
  const target = targetPath.node;
  const localNames = new Set(target.body.body.flatMap(declarationNames));
  for (const parameter of target.params) for (const name of patternNames(parameter)) localNames.add(name);
  traverse(ast, {
    Identifier(identifierPath) {
      const name = identifierPath.node.name;
      if (!localNames.has(name) || !isValueUse(identifierPath)) return;
      const binding = identifierPath.scope.getBinding(name);
      if (!binding || binding.scope.block !== target) return;
      identifierPath.replaceWith(t.memberExpression(t.identifier("scope"), t.identifier(name)));
      identifierPath.skip();
    }
  });

  const transformed = targetPath.node;
  const statements = [];
  for (const node of transformed.body.body) {
    if (t.isReturnStatement(node)) {
      if (t.isObjectExpression(node.argument)) {
        statements.push(t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier("scope"), t.identifier("result")), t.objectExpression([]))));
        let properties = [];
        let lines = 0;
        const flush = () => {
          if (properties.length === 0) return;
          statements.push(t.expressionStatement(t.callExpression(t.memberExpression(t.identifier("Object"), t.identifier("assign")), [
            t.memberExpression(t.identifier("scope"), t.identifier("result")), t.objectExpression(properties)
          ])));
          properties = [];
          lines = 0;
        };
        for (const property of node.argument.properties) {
          const propertyLines = generate(property, { comments: true }).code.split(/\r?\n/u).length;
          if (properties.length && lines + propertyLines > 300) flush();
          properties.push(property);
          lines += propertyLines;
        }
        flush();
        continue;
      }
      statements.push(t.expressionStatement(t.assignmentExpression("=", t.memberExpression(t.identifier("scope"), t.identifier("result")), node.argument || t.identifier("undefined"))));
      continue;
    }
    statements.push(node, ...declarationNames(node).map(scopeAssignment));
  }
  const outputDir = path.join(root, "extension/src/canonical", outputName);
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const chunks = [];
  let current = [];
  let currentLines = 0;
  for (const statement of statements) {
    const lines = generate(statement, { comments: true }).code.split(/\r?\n/u).length;
    if (current.length && currentLines + lines > 335) {
      chunks.push(current);
      current = [];
      currentLines = 0;
    }
    current.push(statement);
    currentLines += lines;
  }
  if (current.length) chunks.push(current);
  const imports = [];
  const calls = [];
  chunks.forEach((chunk, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    const installer = `install${factoryName[0].toUpperCase()}${factoryName.slice(1)}${suffix}`;
    const file = `${suffix}.js`;
    fs.writeFileSync(path.join(outputDir, file), moduleSource(installer, chunk));
    imports.push(`import { ${installer} } from "../${outputName}/${file}";`);
    calls.push(installer);
  });
  const replacement = `${imports.join("\n")}\n\nexport function ${outerInstallerName}(runtime) {\n`
    + `  const installers = [${calls.join(", ")}];\n`
    + `  runtime.${factoryName} = function ${factoryName}(...args) {\n`
    + "    const scope = Object.assign(Object.create(null), { "
    + transformed.params.map((parameter, index) => `${parameter.name}: args[${index}]`).join(", ") + " });\n"
    + "    for (const install of installers) install(runtime, scope);\n"
    + "    return scope.result;\n  };\n}\n";
  fs.writeFileSync(inputPath, replacement);
  console.log(`${factoryName}: ${chunks.length} modules`);
}
