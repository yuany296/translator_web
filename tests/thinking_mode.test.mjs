import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  THINKING_MODES, normalizeThinkingMode, thinkingBodyFields, thinkingStyle, hasThinkingFields
} from "../extension/src/shared/thinking-mode.js";
import { DEFAULT_TRANSLATION_CONFIG, normalizeTranslationConfig } from "../extension/src/config/schema.js";
import { installTranslationUtils } from "../extension/src/background/modules/translation-utils.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

// ── 纯函数 ──

test("脏值一律回 auto：不认识的取值不能变成「悄悄发一个服务商不认的参数」", () => {
  assert.equal(normalizeThinkingMode("off"), "off");
  assert.equal(normalizeThinkingMode("on"), "on");
  assert.equal(normalizeThinkingMode("auto"), "auto");
  for (const dirty of [undefined, null, "", "OFF", "true", 1, {}, "disabled"]) {
    assert.equal(normalizeThinkingMode(dirty), THINKING_MODES.AUTO, `脏值 ${JSON.stringify(dirty)} 应回 auto`);
  }
});

test("auto 不发送任何参数（升级前的行为必须一字不变）", () => {
  for (const provider of ["deepseek", "qwen", "custom", ""]) {
    assert.deepEqual(thinkingBodyFields("auto", provider), {});
    assert.deepEqual(thinkingBodyFields(undefined, provider), {});
  }
});

test("按服务商选参数名；认不准的一律两种都发（中转站看不出背后是哪家）", () => {
  assert.deepEqual(thinkingBodyFields("off", "deepseek"), { thinking: { type: "disabled" } });
  assert.deepEqual(thinkingBodyFields("on", "glm"), { thinking: { type: "enabled" } });
  assert.deepEqual(thinkingBodyFields("off", "qwen"), { enable_thinking: false });
  assert.deepEqual(thinkingBodyFields("on", "ollama"), { enable_thinking: true });
  assert.deepEqual(thinkingBodyFields("off", "custom"), {
    thinking: { type: "disabled" }, enable_thinking: false
  });
  assert.equal(thinkingStyle("deepseek"), "thinking");
  assert.equal(thinkingStyle("qwen"), "enable_thinking");
  assert.equal(thinkingStyle("custom"), "both");
  assert.equal(thinkingStyle(""), "both");
  assert.equal(hasThinkingFields(thinkingBodyFields("off", "custom")), true);
  assert.equal(hasThinkingFields({ response_format: {} }), false);
});

test("normalizeTranslationConfig 收敛 thinkingMode，默认 auto", () => {
  assert.equal(DEFAULT_TRANSLATION_CONFIG.thinkingMode, "auto");
  assert.equal(normalizeTranslationConfig({}).thinkingMode, "auto");
  assert.equal(normalizeTranslationConfig({ thinkingMode: "off" }).thinkingMode, "off");
  assert.equal(normalizeTranslationConfig({ thinkingMode: "胡说" }).thinkingMode, "auto");
  // 换配置档案时语言等字段保留，思考模式也一样（它不在配置库条目里）。
  // 原文语言已无「自动识别」：缺省/存档 auto 在 normalizeTranslationConfig 迁移为默认语言。
  assert.equal(normalizeTranslationConfig({ provider: "deepseek", thinkingMode: "on" }).sourceLanguage, "en");
});

// ── 请求体上的实际行为 ──

/**
 * 迷你版真实发送：按调用方给的 reason 复现 sendOpenAICompatibleTranslationRequest 的三条出口
 * （思考被拒 → 哨兵 / json 被拒 → null / 其它 4xx → 抛），这样测的是真集成而不是我自己写的假分支。
 */
function makeRuntime(reasons = []) {
  const runtime = { getErrorMessage: error => String(error && error.message || error || "") };
  installTranslationUtils(runtime);
  const seen = [];
  runtime.sendOpenAICompatibleTranslationRequest = async (endpoint, apiKey, body) => {
    seen.push(body);
    const reason = reasons.shift();
    if (reason) {
      if (runtime.shouldRetryWithoutThinkingFields(body, endpoint, reason)) {
        return runtime.RETRY_WITHOUT_THINKING_FIELDS;
      }
      if (body.response_format && runtime.shouldRetryWithoutJsonResponseFormat(reason)) return null;
      throw new Error(reason);
    }
    return { content: "ok", responseMeta: {} };
  };
  return { runtime, seen };
}

const BODY = {
  model: "m",
  messages: [{ role: "user", content: "x" }],
  thinking: { type: "disabled" },
  enable_thinking: false,
  response_format: { type: "json_object" }
};

test("服务商不认思考参数：只剥掉思考字段重发，json 模式保留", async () => {
  const endpoint = "https://relay.example.test/chat/completions";
  const { runtime, seen } = makeRuntime(["Unrecognized request argument supplied: enable_thinking"]);
  const sent = await runtime.sendTranslationBodyWithFallbacks(endpoint, "k", BODY, 1000, { includeResponseMeta: true });
  assert.equal(sent.envelope.content, "ok");
  assert.equal(sent.usedJsonMode, true, "json 模式没被拒，不该被剥掉");
  assert.equal(seen.length, 2);
  assert.equal(hasThinkingFields(seen[1]), false, "第二次不带思考字段");
  assert.deepEqual(seen[1].response_format, { type: "json_object" }, "json 模式必须留着");
  assert.equal(seen[0], BODY, "第一次原样发");
  // 端点被记住之后，同一个端点的下一次请求**第一个**请求体里就不带思考字段了：
  // 否则每个请求都要先撞一次 400，白等一个来回。
  const again = await runtime.sendTranslationBodyWithFallbacks(endpoint, "k", BODY, 1000, { includeResponseMeta: true });
  assert.equal(again.envelope.content, "ok");
  assert.deepEqual(seen.slice(2).map(hasThinkingFields), [false], "记住之后第一个请求就不发思考字段");
  // 别的端点不受影响
  const other = await runtime.sendTranslationBodyWithFallbacks(
    "https://other.test/chat/completions", "k", BODY, 1000, { includeResponseMeta: true }
  );
  assert.equal(other.envelope.content, "ok");
  assert.equal(hasThinkingFields(seen.at(-1)), true, "记忆只作用于那一个端点");
});

test("服务商不认 json 模式：只剥掉 response_format，用户的「关闭思考」必须留着", async () => {
  const { runtime, seen } = makeRuntime(["response_format is not supported"]);
  const sent = await runtime.sendTranslationBodyWithFallbacks(
    "https://local.test/chat/completions", "k", BODY, 1000, { includeResponseMeta: true }
  );
  assert.equal(sent.usedJsonMode, false);
  assert.equal(seen.length, 2);
  assert.equal("response_format" in seen[1], false);
  assert.deepEqual(seen[1].thinking, { type: "disabled" }, "思考设置不能被 json 回落连累");
  assert.equal(seen[1].enable_thinking, false);
});

test("两组都被拒：先剥思考再剥 json，最多两次重发", async () => {
  const { runtime, seen } = makeRuntime([
    "Unrecognized request argument supplied: enable_thinking",
    "response_format is not supported"
  ]);
  const sent = await runtime.sendTranslationBodyWithFallbacks(
    "https://relay.example.test/chat/completions", "k", BODY, 1000, { includeResponseMeta: true }
  );
  assert.equal(sent.usedJsonMode, false);
  assert.equal(seen.length, 3);
  assert.equal("response_format" in seen[2], false);
  assert.equal(hasThinkingFields(seen[2]), false);
});

test("跟思考无关的 4xx 照旧抛错，不改用户任何设置", async () => {
  const endpoint = "https://relay.example.test/chat/completions";
  const { runtime, seen } = makeRuntime(["429 rate limit exceeded", "429 rate limit exceeded"]);
  await assert.rejects(
    () => runtime.sendTranslationBodyWithFallbacks(endpoint, "k", BODY, 1000, { includeResponseMeta: true }),
    /rate limit/
  );
  assert.equal(seen.length, 1, "限流不该触发任何回落重发");
  // 限流不能把端点记成「不认思考参数」：下一次请求还得原样带着
  await assert.rejects(
    () => runtime.sendTranslationBodyWithFallbacks(endpoint, "k", BODY, 1000, { includeResponseMeta: true }),
    /rate limit/
  );
  assert.deepEqual(seen.map(hasThinkingFields), [true, true], "思考字段必须照旧发出去");
});

test("剥字段不修改原对象（第一次请求的 body 会被复用）", () => {
  const runtime = { getErrorMessage: String };
  installTranslationUtils(runtime);
  const thinking = runtime.stripThinkingFields(BODY);
  const json = runtime.stripJsonResponseFormat(BODY);
  assert.equal(hasThinkingFields(thinking), false);
  assert.deepEqual(thinking.response_format, { type: "json_object" });
  assert.equal("response_format" in json, false);
  assert.deepEqual(json.thinking, { type: "disabled" });
  assert.equal(hasThinkingFields(BODY), true, "原对象必须原封不动");
  assert.deepEqual(BODY.response_format, { type: "json_object" });
});

// ── 三条翻译链路都真的带上了 ──

test("三条翻译链路都走同一个回落助手，不再各抄一份", () => {
  const novel = read("extension", "src", "background", "modules", "novel-translation.js");
  const emphasis = read("extension", "src", "background", "modules", "novel-emphasis.js");
  const provider = read("extension", "src", "background", "modules", "translation-provider.js");
  for (const [name, source] of [["novel", novel], ["emphasis", emphasis], ["provider", provider]]) {
    assert.match(source, /runtime\.sendTranslationBodyWithFallbacks\(/, `${name} 未走统一回落`);
  }
  assert.match(novel, /\.\.\.thinkingMode\.thinkingBodyFields\(translation\.thinkingMode, translation\.provider\)/);
  assert.match(emphasis, /\.\.\.thinkingMode\.thinkingBodyFields\(translation\.thinkingMode, translation\.provider\)/);
  assert.match(provider, /\.\.\.\(thinkingFields \|\| \{\}\)/);
  // 思考模式不能进提示词/缓存键：切开关不该让已翻好的内容重新计费，提示词文本也不能变
  const cachePayload = novel.slice(novel.indexOf("const cachePayload"), novel.indexOf("const cacheKey"));
  assert.ok(cachePayload.length > 0, "找不到小说块缓存键的构造处");
  assert.doesNotMatch(cachePayload, /thinking/i, "思考模式不能进小说块缓存键");
  assert.doesNotMatch(provider, /translationOptions:\s*\{[^}]*thinkingFields[^}]*\}/,
    "思考字段不能塞进 translationOptions（它会被序列化进提示词并进缓存键）");
});

test("configure.js 的接缝只做「读配置 + 转交」：思考字段用纯函数算，不引入新的运行时依赖", () => {
  const configure = read("extension", "src", "background", "configure.js");
  assert.match(
    configure,
    /thinkingFields: thinkingMode\.thinkingBodyFields\(config\.translation\.thinkingMode, config\.translation\.provider\)/
  );
  // 那个接缝以前只用 provider.validate + translateBatch；多一个 runtime 助手就会让
  // 「configureBackgroundRuntime 的最小 runtime」这类契约测试崩掉。
  const seam = configure.slice(
    configure.indexOf("runtime.requestCanonicalTranslationBatch"),
    configure.indexOf("const handleLegacyMessage")
  );
  assert.doesNotMatch(seam, /buildOpenAICompatibleEndpoint/);
  assert.doesNotMatch(seam, /runtime\.thinkingRequestFields/);
});

// ── 本地服务的流式链路（桌面版小说走这条） ──

test("流式链路的思考字段在扩展侧算好，本地服务只原样拼进上游请求体", () => {
  const stream = read("extension", "src", "background", "modules", "translation-stream.js");
  assert.match(stream, /thinking: thinkingMode\.thinkingBodyFields\(/);
  const python = read("local-ocr-service", "ocr_service", "pipeline", "translation_stream.py");
  assert.match(python, /\*\*thinking_fields/, "本地服务要把扩展算好的字段拼进请求体");
  assert.doesNotMatch(python, /enable_thinking"?:\s*True/, "本地服务不得自己判断该发哪个参数名");
  // 报错点名了思考参数才剥掉重发，否则照旧抛错
  assert.match(python, /_THINKING_FIELD_RE/);
  assert.match(python, /request_body\.pop\("thinking", None\)/);
});

// ── 术语提取也一起吃这套设置 ──

test("术语提取两条链路都带上了思考字段，并且不再各抄一份回落", () => {
  const context = read("extension", "src", "background", "modules", "term-context-extract.js");
  const chapter = read("extension", "src", "background", "modules", "term-discovery-extract.js");
  const mobile = read("extension", "src", "novel-mobile", "term-extract-llm.js");
  // 句子级提取（两个入口：选中文字、整句）
  assert.equal((context.match(/\.\.\.llm\.thinkingFields/g) || []).length, 2, "两个句子级入口都要带");
  assert.equal((context.match(/runtime\.sendTranslationBodyWithFallbacks\(/g) || []).length, 2);
  assert.doesNotMatch(context, /runtime\.sendOpenAICompatibleTranslationRequest\(/, "回落必须走统一助手");
  // 整章提取：桌面把字段算进 upstream 交给本地服务，手机自己发
  assert.match(chapter, /thinking: thinkingMode\.thinkingBodyFields\(termLlm\.thinkingMode, termLlm\.provider\)/);
  assert.match(mobile, /\.\.\.\(llm\.thinking \|\| \{\}\)/);
  assert.match(mobile, /runtime\.sendTranslationBodyWithFallbacks\(/);
  assert.doesNotMatch(mobile, /runtime\.sendOpenAICompatibleTranslationRequest\(/);
});

test("提取小节自己的 thinkingMode 由配置库条目下发，跟随翻译服务时也跟随", () => {
  const schema = read("extension", "src", "config", "schema.js");
  const store = read("extension", "src", "config", "store.js");
  const vendors = read("extension", "src", "config", "vendors.js");
  assert.match(schema, /thinkingMode: normalizeThinkingMode\(value\.thinkingMode\)/);
  assert.equal((schema.match(/thinkingMode: "auto"/g) || []).length, 3, "翻译 + 两个提取小节都有默认值");
  assert.match(store, /thinkingMode: translation\.thinkingMode/, "跟随翻译服务时思考模式也跟随");
  assert.match(vendors, /thinkingMode: "auto"\s*\n\s*\}\);/, "指向配置条目时小节不再留自己的一份");
});

test("本地服务的整章提取：只转发扩展算好的字段，被拒时剥掉重发一次", () => {
  const models = read("local-ocr-service", "ocr_service", "models.py");
  const handlers = read("local-ocr-service", "ocr_service", "pipeline", "api_handlers.py");
  const extractor = read("local-ocr-service", "term_extractor.py");
  assert.match(models, /thinking: dict\[str, Any\] = Field\(default_factory=dict\)/);
  assert.match(handlers, /key in \{'thinking', 'enable_thinking'\}/);
  assert.match(extractor, /THINKING_FIELD_RE/);
  assert.match(extractor, /thinking=dict\(\(upstream or \{\}\)\.get\("thinking"\) or \{\}\)/);
  assert.match(extractor, /if attempt == 0 and thinking_fields and THINKING_FIELD_RE/);
  // 本地服务不得自己判断该发哪个参数名
  assert.doesNotMatch(models, /enable_thinking.*=.*True/);
});

// ── 设置页：开关在「新建/编辑配置」向导里 ──

class MiniElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.value = "";
    this.textContent = "";
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      }
    };
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type) {
    for (const handler of this.listeners.get(type) || []) handler({ target: this, type });
  }
}

test("设置页：思考模式在配置档案向导里（有密钥的那张卡片），面板上不再另设一个", () => {
  const html = read("extension", "public", "settings.html");
  const panel = html.match(/data-panel="translation"[\s\S]*?<\/section>/)[0];
  const form = panel.match(/id="vendorStepForm"[\s\S]*?<\/div>\s*\n\s*<p id="vendorFormError"/)[0];
  assert.match(form, /id="vendorThinkingMode"/, "必须在向导第二步（Base URL / API Key / Model 那张卡片）里");
  for (const value of ["auto", "off", "on"]) {
    assert.match(form, new RegExp(`<option value="${value}"`));
  }
  assert.match(form, /思考模式默认是开的/, "要说清为什么要管它");
  // 面板级那个控件已经拆掉：设置只从配置档案走
  assert.doesNotMatch(panel, /id="thinkingMode"/);
  assert.doesNotMatch(panel, /id="thinkingModeStatus"/);
  assert.doesNotMatch(read("extension", "src", "settings", "controller.js"), /installThinkingModeUi|thinkingModeUi/);
});

test("设置页：向导把思考模式读进条目、编辑与复制时回填、新建时回默认", () => {
  const wizard = read("extension", "src", "settings", "vendor-ui.js");
  assert.match(wizard, /const thinkingSelect = byId\("vendorThinkingMode"\)/);
  assert.match(wizard, /thinkingSelect\.value = normalizeThinkingMode\(saved\.thinkingMode\)/, "编辑/复制回填");
  assert.match(wizard, /thinkingSelect\.value = "auto"/, "新建回默认");
  assert.match(wizard, /thinkingMode: normalizeThinkingMode\(thinkingSelect\.value\)/, "保存时读进条目");
});

test("配置档案的命名规则已经单独成模块（vendor-ui.js 贴着 400 行门禁）", () => {
  const names = read("extension", "src", "settings", "vendor-names.js");
  const wizard = read("extension", "src", "settings", "vendor-ui.js");
  assert.match(names, /export function nextCopyName/);
  assert.match(wizard, /import \{ nextCopyName \} from "\.\/vendor-names\.js"/);
  assert.match(wizard, /nextCopyName\(state\.names, options\.copyFrom\)/);
  assert.doesNotMatch(wizard, /function nextCopyName/);
});

