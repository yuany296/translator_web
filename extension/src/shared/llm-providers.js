const LLM_PROVIDERS = Object.freeze([
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    needsKey: true
  },
  {
    id: "qwen",
    label: "千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-vl-max-latest",
    needsKey: true
  },
  {
    id: "glm",
    label: "GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4v-plus",
    needsKey: true
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    needsKey: true
  },
  {
    id: "kimi",
    label: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
    needsKey: true
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "Qwen/Qwen2.5-VL-7B-Instruct",
    needsKey: true
  },
  {
    id: "volces",
    label: "火山方舟",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "",
    needsKey: true
  },
  {
    id: "custom",
    label: "自定义（OpenAI 兼容）",
    baseUrl: "",
    defaultModel: "",
    needsKey: false
  },
  {
    id: "ollama",
    label: "Ollama（本地）",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "",
    needsKey: false
  }
]);

function getProvider(id) {
  return LLM_PROVIDERS.find(provider => provider.id === id) || null;
}

function inferProviderId(baseUrlValue) {
  const url = String(baseUrlValue || "").trim().toLowerCase();
  if (!url) return "";
  if (url.includes("11434")) return "ollama";
  if (url.includes("api.deepseek.com")) return "deepseek";
  if (url.includes("api.openai.com")) return "openai";
  if (url.includes("dashscope.aliyuncs.com")) return "qwen";
  if (url.includes("open.bigmodel.cn")) return "glm";
  if (url.includes("api.moonshot.cn")) return "kimi";
  if (url.includes("api.siliconflow.cn")) return "siliconflow";
  if (url.includes("ark.cn-beijing.volces.com")) return "volces";
  return "custom";
}

function providerLabel(id) {
  const provider = getProvider(id);
  return provider ? provider.label : "未配置";
}

/**
 * 服务商是否必须配置 API Key。本地 Ollama、自定义 OpenAI 兼容服务等
 * needsKey=false 的服务商必须允许空密钥,否则免密钥本地服务无法翻译。
 * 与 providers/translation.js 的 validate() 保持同一语义。
 */
function keyRequired(id) {
  const provider = getProvider(id);
  return provider ? provider.needsKey === true : false;
}

/**
 * 密钥输入框的 placeholder / 提示文案。needsKey=false 只表示"不强制填写",
 * 不表示"不能填写":自定义 OpenAI 兼容地址常挂在需要鉴权的自建网关
 * (one-api / new-api 等)后面,本地 Ollama 也可能被反向代理加上鉴权。
 * 因此输入框一律可编辑,是否必填只由 keyRequired() 决定。
 */
function keyFieldHint(id) {
  const provider = getProvider(id);
  if (provider && provider.needsKey) return { placeholder: "粘贴 API Key", hint: "" };
  if (provider && provider.id === "ollama") {
    return {
      placeholder: "可留空（本地 Ollama 通常无需密钥）",
      hint: "可留空。若 Ollama 经反向代理启用了鉴权，请填入该 Key。"
    };
  }
  return {
    placeholder: "可留空（免鉴权服务不用填）",
    hint: "可留空。自建或代理服务启用鉴权时请填入，会以 Bearer 发送。"
  };
}

export default Object.freeze({
  LLM_PROVIDERS,
  getProvider,
  inferProviderId,
  providerLabel,
  keyRequired,
  keyFieldHint
});
