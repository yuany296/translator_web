import fs from "node:fs";
import path from "node:path";
import generateModule from "@babel/generator";
import { parse } from "@babel/parser";

const generate = generateModule.default || generateModule;
const isTest = (node) => node.type === "ExpressionStatement"
  && node.expression.type === "CallExpression"
  && node.expression.callee.type === "Identifier"
  && node.expression.callee.name === "test";

function testTitle(node) {
  const argument = node.expression.arguments[0];
  return argument?.type === "StringLiteral" ? argument.value : "";
}

function render(nodes) {
  return `${generate({ type: "File", program: {
    type: "Program", sourceType: "module", interpreter: null,
    directives: [], body: nodes
  } }, { comments: true, retainLines: false }).code}\n`;
}

for (const relative of process.argv.slice(2)) {
  const source = fs.readFileSync(relative, "utf8");
  const ast = parse(source, { sourceType: "module", plugins: ["topLevelAwait"] });
  const support = ast.program.body.filter((node) => !isTest(node));
  const tests = ast.program.body.filter(isTest).filter((node) =>
    !/legacy combined adapter/iu.test(testTitle(node))
  );
  const base = render(support);
  const chunks = [];
  let chunk = [];
  for (const node of tests) {
    const candidate = render([...support, ...chunk, node]);
    if (chunk.length > 0 && candidate.split(/\r?\n/u).length > 700) {
      chunks.push(chunk);
      chunk = [node];
    } else {
      chunk.push(node);
    }
  }
  if (chunk.length > 0) chunks.push(chunk);

  const parsed = path.parse(relative);
  const stem = parsed.name.replace(/\.test$/u, "");
  for (const existing of fs.readdirSync(parsed.dir)) {
    if (existing.startsWith(`${stem}.part`) && existing.endsWith(".test.mjs")) {
      fs.rmSync(path.join(parsed.dir, existing));
    }
  }
  chunks.forEach((nodes, index) => {
    const output = path.join(parsed.dir, `${stem}.part${String(index + 1).padStart(2, "0")}.test.mjs`);
    fs.writeFileSync(output, render([...support, ...nodes]));
  });
  fs.rmSync(relative);
  console.log(`${relative}: ${tests.length} tests -> ${chunks.length} files; support=${base.split(/\r?\n/u).length} lines`);
}
