/**
 * 手机版后台入口。
 *
 * 与 background/index.js 的装配顺序保持一致（functions + state → configure → startup），
 * 但不 import 那个模块：它在模块作用域就执行了一次 createBackgroundRuntime()，会连带
 * 注册一整套 chrome.runtime 监听器；再创建第二份 runtime 会让每条消息被处理两次
 * （译文会被请求两遍）。这里只用它导出的阶段数组自行装配，阶段数组本身是同一份，
 * 不存在顺序漂移。
 *
 * 覆盖层必须落在 startup 之前：bootstrap 在 startup 阶段注册 onMessage/onConnect。
 */
import glossaryCore from "../shared/glossary.js";
import termDiscoveryCore from "../shared/term-discovery.js";
import novelCore from "../shared/novel.js";
import languages from "../shared/languages.js";
import Utils from "../shared/utils.js";
import { backgroundPhases } from "../background/modules/index.js";
import { configureBackgroundRuntime } from "../background/configure.js";
import { applyBackgroundLocal } from "./background-local.js";

const runtime = Object.assign(Object.create(null), {
  glossaryCore,
  termDiscoveryCore,
  novelCore,
  languages,
  Utils
});
for (const install of [...backgroundPhases.functions, ...backgroundPhases.state]) install(runtime);
configureBackgroundRuntime(runtime);
applyBackgroundLocal(runtime);
for (const install of backgroundPhases.startup) install(runtime);

// 手机上没法像桌面那样方便地「检查服务工作线程」，把 runtime 挂到全局便于排查。
globalThis.__MT_NOVEL_MOBILE_BACKGROUND__ = runtime;
