import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

for (const relative of process.argv.slice(2)) {
  const source = fs.readFileSync(relative, "utf8");
  const ast = parse(source, { sourceType: "module", plugins: ["topLevelAwait"] });
  const tests = ast.program.body.filter((node) =>
    node.type === "ExpressionStatement" &&
    node.expression.type === "CallExpression" &&
    node.expression.callee.type === "Identifier" &&
    node.expression.callee.name === "test"
  );
  const support = ast.program.body.filter((node) => !tests.includes(node));
  const supportLines = support.reduce((total, node) => total + node.loc.end.line - node.loc.start.line + 1, 0);
  console.log(`${path.basename(relative)} tests=${tests.length} supportLines=${supportLines}`);
  for (const node of support) {
    console.log(`  ${node.type} ${node.loc.start.line}-${node.loc.end.line}`);
  }
}
