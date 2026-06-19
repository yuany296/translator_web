import { useEffect, useState } from "react";
import { clearTranslationCache, getCacheStats } from "../core/cache/cacheManager";
import type { ExtensionSettings } from "../core/types";
import { defaultSettings } from "../core/settings/settingsManager";
import { getSettings, persistSettings, sendToActiveTab } from "./settings";

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(defaultSettings);
  const [status, setStatus] = useState("正在读取设置...");
  const [busy, setBusy] = useState(false);
  const [cacheEntries, setCacheEntries] = useState(0);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    try {
      const loaded = await getSettings();
      setSettings(loaded);
      const stats = await getCacheStats();
      setCacheEntries(stats.entries);
      setStatus("设置已加载");
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function save() {
    await runBusy(async () => {
      const saved = await persistSettings(settings);
      setSettings(saved);
      setStatus("设置已保存");
    });
  }

  async function scanPage() {
    await runBusy(async () => {
      const response = await sendToActiveTab<{ candidates: unknown[] }>({ type: "SCAN_PAGE" });
      if (!response.ok) {
        throw new Error(response.error || "扫描失败");
      }
      setStatus(`发现 ${response.data?.candidates.length || 0} 个候选图片`);
    });
  }

  async function translatePage() {
    await save();
    await runBusy(async () => {
      const response = await sendToActiveTab<{ translated: unknown[]; errors: string[] }>({ type: "TRANSLATE_PAGE" });
      if (!response.ok) {
        throw new Error(response.error || "翻译失败");
      }
      const translated = response.data?.translated.length || 0;
      const errors = response.data?.errors.length || 0;
      setStatus(`已处理 ${translated} 张图片${errors ? `，${errors} 个错误` : ""}`);
    });
  }

  async function clearCache() {
    await runBusy(async () => {
      const stats = await clearTranslationCache();
      setCacheEntries(0);
      setStatus(`已清除 ${stats.entries} 条缓存`);
    });
  }

  async function pauseOrResume() {
    const paused = !settings.paused;
    const next = { ...settings, paused };
    setSettings(next);
    await persistSettings(next);
    await sendToActiveTab({ type: "PAUSE_TRANSLATION", paused });
    setStatus(paused ? "翻译已暂停" : "翻译已恢复");
  }

  async function toggleOverlay() {
    await sendToActiveTab({ type: "TOGGLE_OVERLAY", visible: true });
    setStatus("翻译层已显示");
  }

  async function runBusy(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="popup">
      <h1>漫画图片翻译</h1>
      <section className="panel">
        <div className="actions">
          <button type="button" onClick={translatePage} disabled={busy}>
            翻译当前页面
          </button>
          <button type="button" onClick={pauseOrResume} disabled={busy}>
            {settings.paused ? "恢复" : "暂停"}
          </button>
        </div>
        <div className="actions secondary">
          <button type="button" onClick={scanPage} disabled={busy}>
            扫描图片
          </button>
          <button type="button" onClick={toggleOverlay} disabled={busy}>
            显示译层
          </button>
          <button type="button" onClick={clearCache} disabled={busy}>
            清缓存
          </button>
        </div>

        <label>
          OCR 引擎
          <select
            value={settings.ocrProvider}
            onChange={(event) => setSettings({ ...settings, ocrProvider: event.target.value as ExtensionSettings["ocrProvider"] })}
          >
            <option value="baidu">百度 OCR</option>
            <option value="local">本地 OCR 服务</option>
            <option value="custom">自定义 OCR 服务</option>
          </select>
        </label>

        <label>
          翻译模型
          <select
            value={settings.translatorProvider}
            onChange={(event) =>
              setSettings({ ...settings, translatorProvider: event.target.value as ExtensionSettings["translatorProvider"] })
            }
          >
            <option value="openai-compatible">OpenAI-compatible</option>
            <option value="custom-http">自定义 HTTP</option>
          </select>
        </label>

        <div className="grid">
          <label>
            源语言
            <select
              value={settings.sourceLanguage}
              onChange={(event) =>
                setSettings({ ...settings, sourceLanguage: event.target.value as ExtensionSettings["sourceLanguage"] })
              }
            >
              <option value="auto">自动检测</option>
              <option value="ja">日语</option>
              <option value="ko">韩语</option>
              <option value="zh">中文</option>
              <option value="en">英文</option>
            </select>
          </label>
          <label>
            目标语言
            <select
              value={settings.targetLanguage}
              onChange={(event) =>
                setSettings({ ...settings, targetLanguage: event.target.value as ExtensionSettings["targetLanguage"] })
              }
            >
              <option value="zh-CN">简体中文</option>
              <option value="en">英文</option>
              <option value="ja">日语</option>
              <option value="ko">韩语</option>
            </select>
          </label>
        </div>

        <label>
          Base URL
          <input
            value={settings.openaiBaseUrl}
            onChange={(event) => setSettings({ ...settings, openaiBaseUrl: event.target.value })}
            placeholder="https://api.deepseek.com"
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            value={settings.openaiApiKey}
            onChange={(event) => setSettings({ ...settings, openaiApiKey: event.target.value })}
            placeholder="sk-..."
          />
        </label>
        <label>
          Model Name
          <input
            value={settings.openaiModel}
            onChange={(event) => setSettings({ ...settings, openaiModel: event.target.value })}
            placeholder="deepseek-chat"
          />
        </label>

        <details>
          <summary>OCR / 自定义接口</summary>
          <label>
            百度 API Key
            <input
              type="password"
              value={settings.baiduApiKey}
              onChange={(event) => setSettings({ ...settings, baiduApiKey: event.target.value })}
            />
          </label>
          <label>
            百度 Secret Key
            <input
              type="password"
              value={settings.baiduSecretKey}
              onChange={(event) => setSettings({ ...settings, baiduSecretKey: event.target.value })}
            />
          </label>
          <label>
            本地 OCR 地址
            <input
              value={settings.localOcrBaseUrl}
              onChange={(event) => setSettings({ ...settings, localOcrBaseUrl: event.target.value })}
            />
          </label>
          <label>
            自定义 OCR URL
            <input
              value={settings.customOcrUrl}
              onChange={(event) => setSettings({ ...settings, customOcrUrl: event.target.value })}
            />
          </label>
          <label>
            自定义翻译 URL
            <input
              value={settings.customTranslateUrl}
              onChange={(event) => setSettings({ ...settings, customTranslateUrl: event.target.value })}
            />
          </label>
        </details>

        <div className="grid">
          <label>
            显示模式
            <select
              value={settings.renderMode}
              onChange={(event) => setSettings({ ...settings, renderMode: event.target.value as ExtensionSettings["renderMode"] })}
            >
              <option value="overlay">覆盖层改图</option>
              <option value="embedded">嵌入式改图</option>
            </select>
          </label>
          <label>
            文本显示
            <select
              value={settings.textDisplayMode}
              onChange={(event) =>
                setSettings({ ...settings, textDisplayMode: event.target.value as ExtensionSettings["textDisplayMode"] })
              }
            >
              <option value="translation">译文</option>
              <option value="source">原文</option>
              <option value="bilingual">双语</option>
            </select>
          </label>
        </div>

        <div className="grid">
          <label>
            字号
            <input
              type="number"
              min={8}
              max={48}
              value={settings.font.fontSize}
              onChange={(event) =>
                setSettings({ ...settings, font: { ...settings.font, fontSize: Number(event.target.value) } })
              }
            />
          </label>
          <label>
            背景透明度
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={settings.font.backgroundOpacity}
              onChange={(event) =>
                setSettings({ ...settings, font: { ...settings.font, backgroundOpacity: Number(event.target.value) } })
              }
            />
          </label>
        </div>

        <div className="switches">
          <label>
            <input
              type="checkbox"
              checked={settings.debugMode}
              onChange={(event) => setSettings({ ...settings, debugMode: event.target.checked })}
            />
            调试框
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
            />
            启用插件
          </label>
        </div>

        <button className="save" type="button" onClick={save} disabled={busy}>
          保存设置
        </button>
        <p className="status">{status}</p>
        <p className="meta">缓存：{cacheEntries} 条</p>
      </section>
    </main>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "未知错误");
}
