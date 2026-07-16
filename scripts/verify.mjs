import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const node = process.execPath;
const eslint = fileURLToPath(new URL("../node_modules/eslint/bin/eslint.js", import.meta.url));

const steps = [
  ["文件长度门禁", node, ["scripts/check-file-lengths.mjs"]],
  ["JavaScript lint", node, [eslint, "extension/src"]],
  ["Python lint", node, [
    "scripts/run-python-tool.mjs", "-m", "pylint", "--rcfile=.pylintrc",
    "local-ocr-service/server.py", "local-ocr-service/glossary_db.py",
    "local-ocr-service/glossary_store", "local-ocr-service/ocr_service",
    "local-ocr-service/term_extractor.py",
  ]],
  ["扩展构建", node, ["scripts/build-extension.mjs"]],
  ["Node 测试", node, ["scripts/run-node-tests.mjs"]],
  ["Python 测试", node, ["scripts/run-python-tool.mjs", "-m", "pytest", "tests", "-q"]],
];

for (const [label, command, args] of steps) {
  console.log(`\n[verify] ${label}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[verify] ${label} 无法启动: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("\n[verify] 全部检查通过");
