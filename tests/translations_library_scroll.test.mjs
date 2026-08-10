import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const library = fs.readFileSync(
  path.join(projectRoot, "extension", "src", "translations", "library.js"),
  "utf8"
);

test("译文库重绘后保持表格滚动位置", () => {
  assert.match(library, /function currentRowAnchor\(\)/);
  assert.match(library, /function restoreRowAnchor\(/);
  assert.match(library, /tr\.dataset\.recordKey = record\.recordKey/);
  assert.match(library, /const anchor = currentRowAnchor\(\)/);
  assert.match(library, /rows\.replaceChildren\(\)/);
  assert.match(library, /restoreRowAnchor\(anchor\)/);
});
