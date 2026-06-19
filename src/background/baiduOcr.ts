import type { BaiduTokenProvider } from "../core/ocr/baiduProvider";

const TOKEN_ENDPOINT = "https://aip.baidubce.com/oauth/2.0/token";
const EXPIRY_SAFETY_MS = 5 * 60 * 1000;

interface TokenCacheEntry {
  key: string;
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCacheEntry | null = null;

export const baiduTokenProvider: BaiduTokenProvider = {
  async getAccessToken(apiKey: string, secretKey: string): Promise<string> {
    const cacheKey = `${apiKey}:${secretKey}`;
    if (tokenCache && tokenCache.key === cacheKey && tokenCache.expiresAt - EXPIRY_SAFETY_MS > Date.now()) {
      return tokenCache.token;
    }

    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    body.set("client_id", apiKey);
    body.set("client_secret", secretKey);

    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });
    const payload = await response.json();
    if (!response.ok || !payload.access_token) {
      throw new Error(`百度 OCR token 获取失败：${payload.error_description || response.statusText}`);
    }
    tokenCache = {
      key: cacheKey,
      token: String(payload.access_token),
      expiresAt: Date.now() + Number(payload.expires_in || 0) * 1000
    };
    return tokenCache.token;
  }
};
