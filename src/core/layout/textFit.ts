export interface TextFitOptions {
  minFontSize: number;
  maxFontSize: number;
  width: number;
  height: number;
}

export interface TextFitResult {
  fontSize: number;
  lines: string[];
}

export function fitTextToBox(text: string, options: TextFitOptions): TextFitResult {
  const words = splitText(text);
  for (let size = options.maxFontSize; size >= options.minFontSize; size -= 1) {
    const lines = wrapWords(words, Math.max(1, Math.floor(options.width / (size * 0.58))));
    if (lines.length * size * 1.25 <= options.height) {
      return { fontSize: size, lines };
    }
  }
  return {
    fontSize: options.minFontSize,
    lines: wrapWords(words, Math.max(1, Math.floor(options.width / (options.minFontSize * 0.58))))
  };
}

function splitText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (/\s/.test(trimmed)) {
    return trimmed.split(/\s+/);
  }
  return Array.from(trimmed);
}

function wrapWords(words: string[], maxChars: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current}${word.length === 1 ? "" : " "}${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}
