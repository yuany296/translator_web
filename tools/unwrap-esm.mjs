import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import generatorModule from "@babel/generator";
import * as t from "@babel/types";

const generate = generatorModule.default || generatorModule;
const root = path.resolve(import.meta.dirname, "..");
const files = [
  ["src/glossary-core.js", "extension/src/shared/glossary.js"],
  ["src/term-discovery-core.js", "extension/src/shared/term-discovery.js"],
  ["src/core/utils.js", "extension/src/shared/utils.js"]
];

for (const [input, output] of files) {
  const ast = parse(fs.readFileSync(path.join(root, input), "utf8"), { sourceType: "script" });
  const call = ast.program.body[0]?.expression;
  if (!t.isCallExpression(call) || !t.isBlockStatement(call.callee?.body)) throw new Error(`${input} is not an IIFE`);
  const body = call.callee.body.body.filter((node) => !(t.isIfStatement(node) && node.loc.start.line < 15));
  const finalNode = body.at(-1);
  if (!t.isExpressionStatement(finalNode) || !t.isAssignmentExpression(finalNode.expression)) {
    throw new Error(`${input} does not end with an API assignment`);
  }
  const apiExpression = finalNode.expression.right;
  body.splice(-1, 1, t.exportDefaultDeclaration(apiExpression));
  const program = t.program(body);
  program.directives = [];
  fs.mkdirSync(path.dirname(path.join(root, output)), { recursive: true });
  fs.writeFileSync(path.join(root, output), `${generate(program, { comments: true }).code}\n`);
  console.log(output);
}
