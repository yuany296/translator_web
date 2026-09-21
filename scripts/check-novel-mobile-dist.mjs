import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 小说手机版产物门禁：
//   1. manifest 引用的文件必须都在（少了 JS 产物 Chrome 会直接拒绝加载）；
//   2. 手机版不该有 side_panel，也不该留下漫画/本地译文库的页面；
//   3. 每个产物里要能找到「覆盖层确实被打进来了」的标记串。
//
// 第 3 条不能写成「产物里不许出现 /translations/health」：手机版并没有删掉桌面版模块，
// 只是把 runtime 上的入口换掉了，原模块的字符串仍在包里。所以判据改成「覆盖层的标记串
// 存在」，再配合 tests/novel_mobile_isolation.test.mjs 从源码层面证明桌面构建碰不到这些文件。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "dist", "novel-mobile");

const EXPECTED_JS = ["background.js", "content.js", "glossary.js", "quick-popup.js", "settings.js"];
const REMOVED_FILES = ["popup.html", "popup.js", "sidepanel.html", "sidepanel.js", "translations.html", "translations.js"];
// 标记串一律用 ASCII 标识符，不依赖 esbuild 的 charset 设置。
const REQUIRED_MARKERS = {
  "background.js": ["__MT_NOVEL_MOBILE_BACKGROUND__", "applyBackgroundLocal", "installTermExtractLlm", "requestChapterTermExtraction", "installGlossaryJudgementLocal", "GLOSSARY_JUDGEMENT_RULES", "installTranslationGuardLocal", "LANGUAGE_PURITY_RULE", "targetLanguageOf", "repairTermLeftovers", "installTermUsageLocal", "summarizeTermUsage", "rememberRequestContext", "withRequestContext"],
  // 注意：TERM_REPAIR_TAILS 只给测试用，没有内部消费者，esbuild 会把它摇掉，不能当标记串。
  "content.js": ["__MT_NOVEL_MOBILE_CONTENT__", "applyContentLocal", "runNovelProgressiveTranslation", "formatTermUsage", "repairParagraphs", "describeScriptFix", "findTraditionalChars", "drainPaints", "loadNovelTuning"],
  "settings.js": ["novel-mobile.css", "applyNovelMobileSettings", "installTuningPanel", "TUNING_KEY"],
  "glossary.js": ["novel-mobile.css", "applyGlossaryLocal", "installLocalClear", "installServerBaseUrlGuard", "NO_LOCAL_SERVICE_URL", "installApplyUrlWidening", "widenApplyUrl"],
  "quick-popup.js": ["novel-mobile.css", "hideIrrelevantControls"]
};

function readManifest() {
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`产物缺失：${path.relative(root, manifestPath)}（先跑 node scripts/build-novel-mobile.mjs）`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(`manifest.json 解析失败：${error.message}`);
    return null;
  }
}

function collectReferenced(manifest) {
  return [
    manifest.background && manifest.background.service_worker,
    manifest.action && manifest.action.default_popup,
    manifest.options_ui && manifest.options_ui.page,
    ...Object.values(manifest.icons || {}),
    ...(manifest.content_scripts || []).flatMap(script => [...(script.js || []), ...(script.css || [])]),
    ...((manifest.web_accessible_resources || []).flatMap(entry => entry.resources || []))
  ].filter(Boolean).filter(relative => !relative.includes("*"));
}

function collectFileProblems() {
  const problems = [];
  for (const name of EXPECTED_JS) {
    if (!fs.existsSync(path.join(dir, name))) problems.push(`缺失 ${name}`);
  }
  for (const name of REMOVED_FILES) {
    if (fs.existsSync(path.join(dir, name))) problems.push(`不该包含 ${name}`);
  }
  const unexpectedJs = fs.readdirSync(dir).filter(name => name.endsWith(".js") && !EXPECTED_JS.includes(name));
  unexpectedJs.forEach(name => problems.push(`出现预期外的产物 ${name}（构建产生了分包？）`));
  return problems;
}

function collectMarkerProblems() {
  const problems = [];
  for (const [file, markers] of Object.entries(REQUIRED_MARKERS)) {
    const target = path.join(dir, file);
    if (!fs.existsSync(target)) continue;
    const text = fs.readFileSync(target, "utf8");
    markers.forEach(marker => {
      if (!text.includes(marker)) problems.push(`${file} 缺少覆盖层标记「${marker}」`);
    });
  }
  return problems;
}

function main() {
  if (!fs.existsSync(dir)) {
    console.error("产物目录不存在：dist/novel-mobile（先跑 node scripts/build-novel-mobile.mjs）");
    return 1;
  }
  const manifest = readManifest();
  if (!manifest) return 1;
  const problems = [];
  if (manifest.side_panel) problems.push("manifest 不应包含 side_panel（手机版没有章节管理面板）");
  collectReferenced(manifest)
    .filter(relative => !fs.existsSync(path.join(dir, relative)))
    .forEach(item => problems.push(`缺失 ${item}`));
  problems.push(...collectFileProblems(), ...collectMarkerProblems());
  if (problems.length) {
    console.error("小说手机版产物不合格：");
    problems.forEach(item => console.error(`  ${item}`));
    return 1;
  }
  console.log(`小说手机版产物完整（${new Set(collectReferenced(manifest)).size} 个 manifest 引用 + ${EXPECTED_JS.length} 个 JS 产物，覆盖层标记齐全）`);
  return 0;
}

process.exitCode = main();
