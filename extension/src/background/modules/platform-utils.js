export function installPlatformUtils(runtime) {
  function sanitizeLocalOcrBaseUrl(value) {
    const normalized = String(value || "").trim().replace(/\/+$/u, "");
    if (!normalized) return runtime.DEFAULT_LOCAL_OCR_BASE_URL;
    return /^https?:\/\//iu.test(normalized) ? normalized : `http://${normalized}`;
  }
  runtime.sanitizeLocalOcrBaseUrl = sanitizeLocalOcrBaseUrl;

  function normalizeLocalOcrLang(value) {
    const text = String(value || "").trim().toLowerCase();
    return ["japan", "korean"].includes(text) ? text : runtime.DEFAULT_LOCAL_OCR_LANG;
  }
  runtime.normalizeLocalOcrLang = normalizeLocalOcrLang;

  function normalizeLocalOcrMode(value) {
    const text = String(value || "").trim().toLowerCase();
    return text === "enhanced" ? "enhanced" : runtime.DEFAULT_LOCAL_OCR_MODE;
  }
  runtime.normalizeLocalOcrMode = normalizeLocalOcrMode;

  function normalizeLocalOcrNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  runtime.normalizeLocalOcrNumber = normalizeLocalOcrNumber;

  function normalizeRenderMode(value) {
    return String(value || "").trim().toLowerCase() === "embedded" ? "embedded" : "overlay";
  }
  runtime.normalizeRenderMode = normalizeRenderMode;

  function normalizeCaptureMode(value) {
    return String(value || "").trim().toLowerCase() === "screenshot" ? "screenshot" : "direct";
  }
  runtime.normalizeCaptureMode = normalizeCaptureMode;
  runtime.buildTabStatusKey = (tabId) => `${runtime.TAB_STATUS_PREFIX}${tabId}`;

  function toNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }
  runtime.toNumber = toNumber;
  runtime.clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

  function hashString(input) {
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16);
  }
  runtime.hashString = hashString;

  function stableHash128(input) {
    const text = String(input || "");
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    let h3 = 0x85ebca6b;
    let h4 = 0xc2b2ae35;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 0x01000193);
      h2 = Math.imul(h2 ^ code, 0x5bd1e995);
      h3 = Math.imul(h3 ^ code, 0x27d4eb2d);
      h4 = Math.imul(h4 ^ code, 0x165667b1);
      h2 ^= h1 >>> 13;
      h3 ^= h2 >>> 15;
      h4 ^= h3 >>> 16;
    }
    return [h1, h2, h3, h4].map((part) => (part >>> 0).toString(16).padStart(8, "0")).join("");
  }
  runtime.stableHash128 = stableHash128;
  runtime.isDataUrl = (value) => /^data:[^;]+;base64,/iu.test(String(value || ""));
  runtime.getDataUrlMimeType = (dataUrl) => {
    const match = String(dataUrl).match(/^data:([^;]+);base64,/iu);
    return match ? String(match[1]).toLowerCase() : "";
  };

  function parseDataUrl(dataUrl) {
    const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/iu);
    if (!match) throw new Error("Invalid data URL format");
    return { mediaType: String(match[1]).toLowerCase(), base64Data: match[2] };
  }
  runtime.parseDataUrl = parseDataUrl;

  async function blobToPreferredDataUrl(blob) {
    const type = String(blob?.type || "").toLowerCase();
    if (type === "image/jpeg" && blob.size > 0 && blob.size <= runtime.FAST_PATH_MAX_JPEG_BYTES) {
      return runtime.blobToDataUrl(blob);
    }
    const jpegBlob = await runtime.transcodeBlob(blob, "image/jpeg", runtime.IMAGE_JPEG_QUALITY);
    if (jpegBlob) return runtime.blobToDataUrl(jpegBlob);
    const pngBlob = await runtime.transcodeBlob(blob, "image/png", 0.92);
    return runtime.blobToDataUrl(pngBlob || blob);
  }
  runtime.blobToPreferredDataUrl = blobToPreferredDataUrl;

  async function transcodeDataUrlToJpeg(dataUrl) {
    try {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const jpegBlob = await runtime.transcodeBlob(blob, "image/jpeg", runtime.IMAGE_JPEG_QUALITY);
      return jpegBlob ? runtime.blobToDataUrl(jpegBlob) : "";
    } catch {
      return "";
    }
  }
  runtime.transcodeDataUrlToJpeg = transcodeDataUrlToJpeg;
}
