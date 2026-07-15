import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

for (const file of process.argv.slice(2)) {
  const source = fs.readFileSync(file, "utf8");
  const ast = parse(source, { sourceType: "script", plugins: ["topLevelAwait"] });
  console.log(`\n${file}`);
  let body = ast.program.body;
  if (body.length === 1 && body[0].type === "ExpressionStatement") {
    const expression = body[0].expression;
    const call = expression?.type === "CallExpression" ? expression : null;
    const callee = call?.callee;
    if (callee?.body?.type === "BlockStatement") body = callee.body.body;
  }
  for (const node of body) {
    const lines = node.loc.end.line - node.loc.start.line + 1;
    let name = node.type;
    if (node.type === "FunctionDeclaration") name = node.id?.name || name;
    if (node.type === "ClassDeclaration") name = node.id?.name || name;
    if (node.type === "VariableDeclaration") {
      name = node.declarations.map((item) => item.id?.name || item.id?.type).join(",");
    }
    if (lines >= 20) console.log(`${node.loc.start.line}-${node.loc.end.line}\t${lines}\t${name}`);
  }
}
