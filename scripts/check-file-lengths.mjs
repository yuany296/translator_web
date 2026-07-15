import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const excluded = new Set([".git", ".local-data", "dist", "node_modules", "__pycache__"]);
const entrypoints = new Set([
  "extension/src/background/index.js", "extension/src/content/index.js",
  "extension/src/popup/index.js", "extension/src/glossary/index.js",
  "local-ocr-service/server.py", "local-ocr-service/ocr_service/api.py"
]);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (excluded.has(entry.name)) return [];
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

export function lineCount(source) {
  return String(source).replace(/\r\n/gu, "\n").split("\n").length;
}

export function validateLength(relative, source) {
  const normalized = relative.replaceAll("\\", "/");
  const lines = lineCount(source);
  const isTest = normalized.startsWith("tests/")
    && (/\.test\.mjs$/u.test(normalized) || /(^|\/)test_.*\.py$/u.test(normalized));
  const isProduction = normalized.startsWith("extension/src/") && normalized.endsWith(".js")
    || normalized.startsWith("local-ocr-service/") && normalized.endsWith(".py");
  const limit = entrypoints.has(normalized) ? 120 : isTest ? 800 : isProduction ? 400 : null;
  return limit !== null && lines > limit ? { relative: normalized, lines, limit } : null;
}

export function checkRepository(directory = root) {
  return walk(directory).map((absolute) => {
    const relative = path.relative(directory, absolute);
    return validateLength(relative, fs.readFileSync(absolute, "utf8"));
  }).filter(Boolean);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkRepository();
  if (failures.length) {
    failures.forEach(({ relative, lines, limit }) => console.error(`${relative}: ${lines} lines (limit ${limit})`));
    process.exitCode = 1;
  } else {
    console.log("File length gate passed (production 400, entrypoints 120, tests 800).")
  }
}
