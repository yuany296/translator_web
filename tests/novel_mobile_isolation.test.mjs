import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// 手机版是「只加新文件」实现的：这组测试从源码层面证明桌面构建碰不到它们，
// 不依赖任何构建产物，所以在 npm run test:node 里一定跑得到。
const root = path.resolve(import.meta.dirname, "..");
const srcRoot = path.join(root, "extension", "src");
const mobilePrefix = "extension/src/novel-mobile/";

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

function relative(absolute) {
  return path.relative(root, absolute).replaceAll("\\", "/");
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("没有任何现有源码引用手机版目录（桌面入口图碰不到新代码）", () => {
  const offenders = walk(srcRoot)
    .filter(file => file.endsWith(".js"))
    .map(relative)
    .filter(name => !name.startsWith(mobilePrefix))
    .filter(name => read(name).includes("novel-mobile"));
  assert.deepEqual(offenders, []);
});

test("共享静态资源里没有手机版字样（dist/extension 内容因此逐字节不变）", () => {
  const publicDir = path.join(root, "extension", "public");
  const offenders = walk(publicDir)
    .map(relative)
    .filter(name => read(name).includes("novel-mobile"));
  assert.deepEqual(offenders, []);
});

test("桌面构建脚本的 entry 列表里没有手机版入口", () => {
  const build = read("scripts/build-extension.mjs");
  assert.equal(build.includes("novel-mobile"), false);
  build.match(/entryPoints: \[[^\]]+\]/gu).forEach(entry => {
    assert.equal(entry.includes("novel-mobile"), false);
  });
});

test("手机版入口复用原模块导出的阶段数组，不手抄安装顺序", () => {
  assert.match(
    read("extension/src/novel-mobile/background.js"),
    /import \{ backgroundPhases \} from "\.\.\/background\/modules\/index\.js"/u
  );
  assert.match(
    read("extension/src/novel-mobile/content.js"),
    /import \{ contentPhases \} from "\.\.\/content\/modules\/index\.js"/u
  );
  assert.match(
    read("extension/src/novel-mobile/glossary.js"),
    /import \{ glossaryInstallers \} from "\.\.\/glossary\/modules\/index\.js"/u
  );
});

test("后台入口不 import background/index.js（否则监听器会注册两份，翻译请求发两遍）", () => {
  const background = read("extension/src/novel-mobile/background.js");
  assert.equal(/from "\.\.\/background\/index\.js"/u.test(background), false);
  // 装配顺序必须与 background/index.js 一致：functions+state → configure → startup
  assert.match(background, /\[\.\.\.backgroundPhases\.functions, \.\.\.backgroundPhases\.state\]/u);
  assert.match(background, /configureBackgroundRuntime\(runtime\);\napplyBackgroundLocal\(runtime\);\nfor \(const install of backgroundPhases\.startup\)/u);
});

test("内容入口的装配顺序与 content/index.js 一致，且覆盖落在 startup 之前", () => {
  const content = read("extension/src/novel-mobile/content.js");
  assert.match(content, /for \(const install of contentPhases\.functions\) install\(runtime\);/u);
  assert.match(content, /prepareContentRuntime\(runtime\);/u);
  assert.match(content, /completeContentRuntime\(runtime\);\n  applyContentLocal\(runtime\);\n  for \(const install of contentPhases\.startup\)/u);
});

test("现有源码里被覆盖的函数都通过 runtime 属性调用（覆盖依赖的就是这个晚绑定）", () => {
  const lateBound = {
    "extension/src/content/modules/controls-triple.js": [
      "runtime.translateNovelChapter(", "runtime.retryNovelImages(", "runtime.bindBallContextMenu?.("
    ],
    "extension/src/content/modules/novel-workflow.js": [
      "runtime.translateNovelImages(", "runtime.ensureTranslationServiceOnline("
    ],
    "extension/src/content/modules/novel-progressive-workflow.js": ["runtime.commitTranslationOperation("],
    "extension/src/background/configure.js": ["runtime.commitOrQueueTranslationOperation("],
    "extension/src/background/modules/bootstrap.js": ["runtime.handleTranslationStreamPort?.("],
    // 手机版把术语从「硬约束」改成「模型判断」、并在请求出口补语言规则，靠的就是这几个晚绑定调用点
    "extension/src/background/modules/novel-translation.js": [
      "runtime.glossaryCore.buildPrompt(", "runtime.novelCore.validateTranslations(",
      "runtime.sendOpenAICompatibleTranslationRequest("
    ],
    "extension/src/background/modules/messages.js": ["runtime.openNovelManageUi("],
    "extension/src/background/modules/term-discovery-messages.js": [
      "runtime.runTermDiscovery(", "runtime.probeTermExtractor("
    ],
    "extension/src/glossary/modules/glossary-storage.js": ["runtime.deleteEntryFromServer("],
    "extension/src/glossary/modules/glossary-terms-view.js": ["runtime.importGlossaryDbFile(", "runtime.persistEntries("],
    "extension/src/glossary/modules/glossary-library-lifecycle.js": ["runtime.saveLibrary("],
    "extension/src/glossary/modules/glossary-library-panel.js": ["runtime.setLibraryEnabled("]
  };
  for (const [file, expressions] of Object.entries(lateBound)) {
    const text = read(file);
    expressions.forEach(expression => {
      assert.ok(text.includes(expression), `${file} 不再通过 ${expression} 调用：覆盖会静默失效`);
    });
  }
});

test("手机版覆盖层消费的 runtime 助手都还在（上游改名会让手机版翻不动）", () => {
  const contentLocal = read("extension/src/novel-mobile/content-local.js");
  [
    "runtime.resetNovelForChapter", "runtime.applyCachedNovelTranslations", "runtime.runNovelProgressiveTranslation",
    "runtime.getTranslationConfigFingerprint", "runtime.setNovelTranslationVisibility", "runtime.reapplyNovelTranslations"
  ].forEach(expression => {
    assert.ok(contentLocal.includes(expression), `content-local.js 缺少 ${expression}`);
  });
  const backgroundLocal = read("extension/src/novel-mobile/background-local.js");
  ["runtime.prepareDiscovery", "runtime.mergeDiscovery"].forEach(expression => {
    assert.ok(backgroundLocal.includes(expression), `background-local.js 缺少 ${expression}`);
  });
});

test("术语库「清空」按钮的绑定必须晚于覆盖层（绑定在 DOMContentLoaded 的 bindEvents 里）", () => {
  const editor = read("extension/src/glossary/modules/glossary-editor.js");
  // 这是立即取值：bindEvents 一旦提前到模块作用域执行，就会抓住桌面版实现。
  assert.ok(editor.includes("runtime.clearBtn.addEventListener(\"click\", runtime.clearGlossary)"));
  assert.ok(editor.includes("document.addEventListener(\"DOMContentLoaded\""));
  const mobileEntry = read("extension/src/novel-mobile/glossary.js");
  assert.ok(mobileEntry.indexOf("applyGlossaryLocal(runtime)") > mobileEntry.indexOf("glossaryInstallers) install(runtime)"));
});
