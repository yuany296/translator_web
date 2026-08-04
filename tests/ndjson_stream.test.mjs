import assert from "node:assert/strict";
import test from "node:test";
import { createNdjsonParser } from "../extension/src/shared/ndjson.js";

test("NDJSON parser accepts split lines, multiple lines and a final line without newline", () => {
  const parser = createNdjsonParser();
  assert.deepEqual(parser.feed('{"type":"para'), { events: [], errors: [] });
  const middle = parser.feed('graph","sequence":1}\r\n{"type":"heartbeat"}\n{"type"');
  assert.deepEqual(middle.events, [
    { type: "paragraph", sequence: 1 }, { type: "heartbeat" }
  ]);
  assert.deepEqual(middle.errors, []);
  const final = parser.feed(':"done","completed":1}', true);
  assert.deepEqual(final.events, [{ type: "done", completed: 1 }]);
  assert.equal(parser.getBufferedLength(), 0);
});

test("NDJSON parser reports damaged data and continues with later events", () => {
  const parser = createNdjsonParser();
  const parsed = parser.feed('not-json\n[1,2]\n{"type":"done"}\n');
  assert.deepEqual(parsed.events, [{ type: "done" }]);
  assert.deepEqual(parsed.errors.map(error => error.code), ["invalid_json", "invalid_event"]);
});

test("NDJSON parser rejects an overlong unterminated line without retaining it", () => {
  const parser = createNdjsonParser({ maxLineLength: 256 });
  const parsed = parser.feed("x".repeat(300));
  assert.equal(parsed.errors[0].code, "line_too_long");
  assert.equal(parser.getBufferedLength(), 0);
});
