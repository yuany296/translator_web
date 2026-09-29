/**
 * 手机版内容脚本入口。
 *
 * 装配顺序与 content/index.js 一致，但用同一份 contentPhases 数组自行装配，
 * 并在 startup 之前插入覆盖层（reader-startup 在 startup 阶段调 runtime.init()，
 * 覆盖必须在那之前生效）。
 */
import { canonicalPipeline } from "../canonical/pipeline.js";
import { reconciler } from "../canonical/reconciler.js";
import { contentPhases } from "../content/modules/index.js";
import { completeContentRuntime, prepareContentRuntime } from "../content/configure.js";
import novelCore from "../shared/novel.js";
import { applyContentLocal } from "./content-local.js";

const existing = globalThis.__MANGA_TRANSLATOR_V3__;
if (existing && !existing.invalidated) {
  existing.rescan?.();
} else {
  const runtime = Object.assign(Object.create(null), {
    KP: canonicalPipeline,
    KR: reconciler,
    novelCore,
    // 必须在 contentPhases.functions 装配循环之前就位：
    // installNovelFocusClick 据此跳过安装（手机版没有章节译文管理面板）。
    IS_NOVEL_MOBILE: true
  });
  for (const install of contentPhases.functions) install(runtime);
  prepareContentRuntime(runtime);
  for (const install of contentPhases.state) install(runtime);
  completeContentRuntime(runtime);
  applyContentLocal(runtime);
  for (const install of contentPhases.startup) install(runtime);
  // 手机上不好开 DevTools，留一个可检查的入口。
  globalThis.__MT_NOVEL_MOBILE_CONTENT__ = runtime;
}
