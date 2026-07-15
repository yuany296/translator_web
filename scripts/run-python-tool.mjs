import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const configured = process.env.MT_PYTHON;
const condaPython = join(homedir(), ".conda", "envs", "manga-translator", "python.exe");
const python = configured || (process.platform === "win32" && existsSync(condaPython) ? condaPython : "python");
const result = spawnSync(python, process.argv.slice(2), {
  cwd: process.cwd(),
  env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  stdio: "inherit",
});

if (result.error) {
  console.error(`无法启动 Python: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
