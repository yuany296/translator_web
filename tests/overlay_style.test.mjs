import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("根目录覆盖层的原图模式会彻底隐藏译文及其描边", () => {
  const css = readFileSync(path.resolve(projectRoot, "styles.css"), "utf8");
  const selector = ".mt-overlay-root.mt-show-source .mt-bubble";
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`))?.[1] ?? "";

  assert.match(rule, /color:\s*transparent\s*!important/);
  assert.match(rule, /background:\s*transparent\s*!important/);
  assert.match(rule, /border-color:\s*transparent\s*!important/);
  assert.match(rule, /-webkit-text-stroke:\s*0\s+transparent\s*!important/);
  assert.match(rule, /text-shadow:\s*none\s*!important/);
  assert.match(rule, /opacity:\s*0\s*;/);
});
