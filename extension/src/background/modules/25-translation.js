export function installBackground25(runtime) {
  function getPercentBubbleGroupBox(group) {
    const boxes = group.map(bubble => runtime.getPercentBubbleBox(bubble)).filter(Boolean);
    if (boxes.length === 0) {
      return null;
    }
    const left = Math.min(...boxes.map(box => box.left));
    const top = Math.min(...boxes.map(box => box.top));
    const right = Math.max(...boxes.map(box => box.right));
    const bottom = Math.max(...boxes.map(box => box.bottom));
    return runtime.buildPercentBox(left, top, right, bottom);
  }
  runtime.getPercentBubbleGroupBox = getPercentBubbleGroupBox;
  function getPercentBubbleBox(bubble) {
    const left = Number(bubble && bubble.x);
    const top = Number(bubble && bubble.y);
    const width = Number(bubble && bubble.w);
    const height = Number(bubble && bubble.h);
    if (!(Number.isFinite(left) && Number.isFinite(top) && width > 0 && height > 0)) {
      return null;
    }
    return runtime.buildPercentBox(left, top, left + width, top + height);
  }
  runtime.getPercentBubbleBox = getPercentBubbleBox;
  function buildPercentBox(left, top, right, bottom) {
    const width = Math.max(0.1, right - left);
    const height = Math.max(0.1, bottom - top);
    return {
      left,
      top,
      right,
      bottom,
      width,
      height,
      centerX: left + width / 2,
      centerY: top + height / 2
    };
  }
  runtime.buildPercentBox = buildPercentBox;
  function getPercentBoxGapY(left, right) {
    if (left.top > right.bottom) {
      return left.top - right.bottom;
    }
    if (right.top > left.bottom) {
      return right.top - left.bottom;
    }
    return 0;
  }
  runtime.getPercentBoxGapY = getPercentBoxGapY;
  function isLatinOnlyFragment(text) {
    const raw = String(text || "").trim();
    if (!raw) {
      return false;
    }
    return /^[A-Za-z'`-]+$/.test(raw);
  }
  runtime.isLatinOnlyFragment = isLatinOnlyFragment;
  function isMeaningfulLatinToken(text) {
    const token = String(text || "").trim().toUpperCase();
    if (!token) {
      return false;
    }
    const whitelist = new Set(["AI", "DNA", "RNA", "CPU", "GPU", "USB", "PC", "TV", "OK", "NO", "YES"]);
    return whitelist.has(token);
  }
  runtime.isMeaningfulLatinToken = isMeaningfulLatinToken;
  function isSymbolOnlyText(text) {
    const raw = String(text || "").trim();
    if (!raw) {
      return true;
    }

    // Keep bubbles that contain meaningful scripts/numbers.
    if (/[0-9A-Za-z]/.test(raw)) {
      return false;
    }
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(raw)) {
      return false;
    }
    return /^[\p{P}\p{S}\s]+$/u.test(raw);
  }
  runtime.isSymbolOnlyText = isSymbolOnlyText;
  function isConfidentSimplifiedChinese(text) {
    const raw = String(text || "").trim();
    if (!raw) {
      return false;
    }

    // Keep Japanese/Korean text to avoid false filtering.
    if (/[\u3040-\u30ff]/.test(raw) || /[\uac00-\ud7af]/.test(raw)) {
      return false;
    }
    const hanChars = raw.match(/[\u4e00-\u9fff]/g) || [];
    if (hanChars.length === 0) {
      return false;
    }
    const hanRatio = hanChars.length / Math.max(raw.length, 1);
    if (hanRatio < 0.45) {
      return false;
    }
    const simplifiedSignal = /[这为来会与后发学实点话说们]|(我们|你们|他们|这个|那个|因为|所以|已经|没有|时候|什么)/.test(raw);
    if (!simplifiedSignal) {
      return false;
    }
    const traditionalSignal = /[這為來會與後發學實點話說們]/.test(raw);
    return !traditionalSignal;
  }
  runtime.isConfidentSimplifiedChinese = isConfidentSimplifiedChinese;
  function extractOpenAIMessageText(content) {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map(item => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item.text === "string") {
          return item.text;
        }
        return "";
      }).join("\n");
    }
    return "";
  }
  runtime.extractOpenAIMessageText = extractOpenAIMessageText;
  function shouldRetryWithJpeg(reason) {
    const text = String(reason || "").toLowerCase();
    return /image format is not supported|unsupported image format|invalid image|invalid image_url/.test(text);
  }
  runtime.shouldRetryWithJpeg = shouldRetryWithJpeg;
  function shouldRetryWithoutJsonResponseFormat(reason) {
    const text = String(reason || "").toLowerCase();
    return /response_format|unknown field|unsupported field/.test(text);
  }
  runtime.shouldRetryWithoutJsonResponseFormat = shouldRetryWithoutJsonResponseFormat;
  function toProviderError(payload, status, statusText, defaultMessage) {
    const messageFromPayload = payload && payload.error && payload.error.message || payload && payload.message || `${status} ${statusText}`;
    const error = new Error(`${defaultMessage}: ${messageFromPayload}`);
    error.status = status;
    error.payload = payload;
    return error;
  }
  runtime.toProviderError = toProviderError;
}
