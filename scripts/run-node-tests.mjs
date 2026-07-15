import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = fs.readdirSync(path.join(root, "tests"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(root, "tests", name));
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
  cwd: root, stdio: "inherit"
});
process.exitCode = result.status ?? 1;
