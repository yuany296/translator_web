import assert from "node:assert/strict";
import test from "node:test";
import { validateLength } from "../scripts/check-file-lengths.mjs";

test("file length gate rejects a synthetic 801-line test", () => {
  const failure = validateLength("tests/test_synthetic_overflow.py", Array(801).fill("pass").join("\n"));
  assert.deepEqual(failure, {
    relative: "tests/test_synthetic_overflow.py",
    lines: 801,
    limit: 800
  });
});

test("file length gate applies the 120-line entrypoint limit", () => {
  const failure = validateLength("extension/src/content/index.js", Array(121).fill("export {}; ").join("\n"));
  assert.equal(failure.limit, 120);
});
