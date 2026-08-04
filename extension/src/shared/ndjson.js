const DEFAULT_MAX_LINE_LENGTH = 256 * 1024;

export function createNdjsonParser(options = {}) {
  const maxLineLength = Math.max(256, Number(options.maxLineLength) || DEFAULT_MAX_LINE_LENGTH);
  let buffer = "";
  let lineNumber = 0;

  function parseLine(rawLine, events, errors) {
    lineNumber += 1;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) return;
    if (line.length > maxLineLength) {
      errors.push({ code: "line_too_long", lineNumber, length: line.length });
      return;
    }
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        errors.push({ code: "invalid_event", lineNumber });
        return;
      }
      events.push(value);
    } catch (error) {
      errors.push({ code: "invalid_json", lineNumber, message: String(error?.message || error) });
    }
  }

  function feed(chunk = "", final = false) {
    const events = [];
    const errors = [];
    buffer += String(chunk || "");
    if (buffer.length > maxLineLength && !buffer.includes("\n")) {
      errors.push({ code: "line_too_long", lineNumber: lineNumber + 1, length: buffer.length });
      buffer = "";
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    lines.forEach(line => parseLine(line, events, errors));
    if (final && buffer) {
      parseLine(buffer, events, errors);
      buffer = "";
    }
    return { events, errors };
  }

  return { feed, getBufferedLength: () => buffer.length };
}

export default { createNdjsonParser };
