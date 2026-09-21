import assert from "node:assert/strict";
import test from "node:test";
import { installControlsUtils } from "../extension/src/content/modules/controls-utils.js";
import { installNovelBatch, NOVEL_BATCH_DEFAULTS, splitEvenly } from "../extension/src/novel-mobile/novel-batch.js";
import novelCore from "../extension/src/shared/novel.js";

// 并发小批的行为测试：这块的存在意义就是「别一块一块串行等」，所以核心断言是
// 「同时在飞的请求数 > 1」，以及「某块失败不会拖死其它块、漏段会走逐段补齐」。
function makeParagraphs(count, chars) {
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index);
    return {
      id: suffix,
      index,
      kind: "paragraph",
      original_text: `${"가".repeat(chars - suffix.length)}${suffix}`,
      paragraphKey: `p${index}`,
      rawSourceHash: `raw-${index}`,
      normalizedSourceHash: `norm-${index}`,
      node: { dataset: {} }
    };
  });
}

function makeHarness({
  paragraphs = makeParagraphs(8, 400), failFirstIds = new Set(), retryAttempts = 1, requestDelayMs = 5,
  termUsage = null, translatedText = null, requestDelay = null
} = {}) {
  const requests = [];
  const phases = [];
  const committed = [];
  const renderOrder = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let signature = "sig-screen-1";
  let progressHook = null;
  // 发出顺序（在 await 之前记），用来断言「开头小块最先发」
  let orderSeq = 0;
  const state = {
    taskId: "task-1",
    translations: new Map(),
    pendingParagraphs: new Set(),
    progress: { textDone: 0, textTotal: 0, textPhase: "" }
  };
  const chapter = {
    scopeKey: "kakao:1", seriesId: "1", chapterId: "c1", chapterTitle: "1화", chapterOrder: 1, paragraphs,
    surface: { root: {} }
  };
  // 「当前 surface 上的活节点」与「提取时抓到的节点」是两套对象：模拟阅读器把节点重建了。
  // 收尾的 reapplyNovelTranslations 负责把译文按 id 贴到活节点上 —— 这就是「翻译完成但页面
  // 没替换」的修复点，所以测试里让 renderNovelTranslation 只写进提取时的旧节点。
  const liveNodes = new Map(paragraphs.map(item => [item.id, { text: "" }]));
  const reapplySurfaces = [];
  const runtime = {
    novelCore,
    getConfiguredSourceLanguage: () => "auto",
    getTargetLanguage: () => "zh-CN",
    resolveSourceLanguage: () => "ko",
    normalizeTranslationCacheText: value => String(value || ""),
    buildNovelRecordKey: (chapterValue, item) => `key-${item.id}`,
    createTranslationOperation: (type, recordKey, payload) => ({ type, recordKey, payload }),
    commitTranslationOperation: async operation => {
      committed.push(operation);
      return { ok: true, pending: false, record: { activeVersion: { translatedText: operation.payload.translatedText } } };
    },
    renderNovelTranslation: (node, text) => {
      node.rendered = text;
      const item = paragraphs.find(candidate => candidate.node === node);
      if (item) renderOrder.push(item.id);
    },
    findKakaoNovelSurface: () => chapter.surface,
    novelSurfaceSignature: () => signature,
    // 模仿 novel-renderer.js#reapplyNovelTranslations：按段落 id 在当前 surface 上重贴
    reapplyNovelTranslations: surface => {
      reapplySurfaces.push(surface);
      paragraphs.forEach(item => {
        liveNodes.get(item.id).text = state.translations.get(item.id) || "";
      });
    },
    setNovelTextStatus: (status, progress) => {
      phases.push(progress.textPhase);
      if (progressHook) progressHook();
    },
    collectTextDiagnostics: () => {},
    getErrorMessage: error => String(error && error.message || error || ""),
    sendRuntimeMessage: async request => {
      const items = request.items || [];
      orderSeq += 1;
      const sendOrder = orderSeq;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, requestDelay ? requestDelay(items) : requestDelayMs));
      inFlight -= 1;
      requests.push({
        ids: items.map(item => item.id),
        size: items.length,
        order: sendOrder,
        previousTranslation: request.previousTranslation,
        beforeText: request.beforeText,
        afterText: request.afterText,
        revisionInstruction: request.revisionInstruction || ""
      });
      if (items.length > 1 && items.some(item => failFirstIds.has(item.id))) {
        return { ok: false, error: "chunk failed" };
      }
      return {
        ok: true,
        translations: items.map(item => ({
          id: item.id,
          translated_text: translatedText ? translatedText(item) : `译:${item.original_text}`
        })),
        errors: [],
        warnings: [],
        // 后台每个模型请求留一条诊断：默认 1 条，用 retryAttempts 模拟「被校验打回、单独重试」
        diagnostics: Array.from({ length: retryAttempts }, () => ({ status: "parsed" })),
        ...(termUsage ? { termUsage } : {})
      };
    }
  };
  installControlsUtils(runtime);
  installNovelBatch(runtime);
  return {
    runtime, state, chapter, requests, phases, committed, liveNodes, reapplySurfaces, renderOrder,
    maxInFlight: () => maxInFlight,
    setSignature: value => { signature = value; },
    setProgressHook: hook => { progressHook = hook; }
  };
}

function runBatch(harness, options = {}) {
  const { runtime, state, chapter } = harness;
  const allItems = chapter.paragraphs;
  return runtime.runNovelProgressiveTranslation({
    chapter,
    state,
    allItems,
    pending: allItems.filter(item => !state.translations.has(item.id)),
    force: false,
    fingerprint: "fp",
    ...options
  });
}

test("块比桌面默认小、并发更高：常见一屏一轮就能发完", async () => {
  const paragraphs = makeParagraphs(12, 400);
  assert.ok(NOVEL_BATCH_DEFAULTS.chunkChars < 1400, "要比桌面默认的 1400 字小");
  assert.ok(NOVEL_BATCH_DEFAULTS.concurrency >= 6, "并发要够高，块数不多的屏才能一轮发完");
  const harness = makeHarness({ paragraphs });
  const result = await runBatch(harness);
  // 没有失败就没有逐段补齐，所以「请求数 == 块数」
  assert.equal(harness.requests.length, result.diagnostics.chunks);
  // 每个段落恰好被请求一次：不重不漏
  const requested = harness.requests.flatMap(request => request.ids);
  assert.equal(requested.length, paragraphs.length);
  assert.deepEqual([...requested].sort((left, right) => Number(left) - Number(right)), paragraphs.map(item => item.id));
  assert.ok(result.diagnostics.chunks <= NOVEL_BATCH_DEFAULTS.concurrency,
    `常见一屏的块数（${result.diagnostics.chunks}）应落在并发上限内，一轮发完`);
  assert.ok(harness.maxInFlight() > 1, "一轮内应同时发出多个块");
});

test("真并发：多个块同时在飞（桌面版是等前一块返回才发下一块）", async () => {
  const harness = makeHarness({ paragraphs: makeParagraphs(8, 400) });
  await runBatch(harness);
  assert.ok(harness.maxInFlight() >= 3, `同时在飞的请求数应 >= 3，实际 ${harness.maxInFlight()}`);
  assert.ok(harness.maxInFlight() <= NOVEL_BATCH_DEFAULTS.concurrency, "并发不应超过上限");
});

test("翻译期间节点被重建也不怕：收尾一定按当前 surface 重贴一遍", async () => {
  const harness = makeHarness({ paragraphs: makeParagraphs(6, 300) });
  await runBatch(harness);
  // renderNovelTranslation 只写进了提取时的旧节点；活节点上的译文只能来自收尾的 reapply。
  assert.deepEqual(harness.reapplySurfaces, [harness.chapter.surface], "收尾要按当前 surface 重贴");
  harness.chapter.paragraphs.forEach(item => {
    assert.equal(harness.liveNodes.get(item.id).text, `译:${item.original_text}`, `${item.id} 应被贴到活节点上`);
  });
});

test("翻屏导致 surface 换了：诊断里如实标出 surfaceChanged", async () => {
  const same = makeHarness({ paragraphs: makeParagraphs(4, 300) });
  const sameResult = await runBatch(same);
  assert.equal(sameResult.diagnostics.surfaceChanged, false);

  const flipped = makeHarness({ paragraphs: makeParagraphs(4, 300) });
  // 提取之后、收尾之前翻了屏：进度刷新时就换掉 surface 签名
  flipped.setProgressHook(() => flipped.setSignature("sig-screen-2"));
  const flippedResult = await runBatch(flipped);
  assert.equal(flippedResult.diagnostics.surfaceChanged, true, "翻了屏必须能看出来，上层据此接着翻新屏");
});

test("块是平均切的：不再有「前面只装 2 段」的小块，块大小接近、块数最少", async () => {
  const harness = makeHarness({ paragraphs: makeParagraphs(12, 400) });
  const result = await runBatch(harness);
  // 12 段 × 400 字 = 4800 字 → 4 块，每块 3 段 1200 字（完全平均）
  assert.equal(result.diagnostics.chunks, 4);
  const sizes = harness.requests.map(request => request.ids.length).sort();
  assert.deepEqual(sizes, [3, 3, 3, 3], "每块段数应一致，不该再出现 2 段 / 6 段这种悬殊切法");
  assert.equal(harness.requests[0].ids[0], "0", "第一块仍然从屏幕最上面开始，且最先发出");
  assert.equal(harness.requests[0].order, 1);
});

test("平均切块的余数也是均分的：1800 字切两块各 900，而不是 1200 + 600", async () => {
  const harness = makeHarness({ paragraphs: makeParagraphs(6, 300) });
  const result = await runBatch(harness);
  assert.equal(result.diagnostics.chunks, 2);
  assert.deepEqual(harness.requests.map(request => request.ids.length), [3, 3]);
});

test("进度里能看出后台重试：块数 < 模型请求数，并给出平均每次耗时", async () => {
  // 每块要 100ms，才能显出「平均 X.Xs/次」这一项
  const harness = makeHarness({ paragraphs: makeParagraphs(6, 300), retryAttempts: 2, requestDelayMs: 100 });
  const result = await runBatch(harness);
  // 6 段 × 300 字 = 1800 字 → 平均两块，各 3 段
  assert.equal(result.diagnostics.chunks, 2);
  assert.equal(result.diagnostics.modelCalls, 4, "每块 2 次请求 = 4 次，说明每块都被打回重试过一次");
  assert.ok(harness.phases.some(phase => /请求 4 次/u.test(phase)), "进度文案要显示请求次数");
  assert.ok(harness.phases.some(phase => /重试 2 次/u.test(phase)), "请求数多于块数要显式说成「重试」");
  assert.ok(harness.phases.some(phase => /平均 0\.\ds\/次/u.test(phase)), "进度文案要显示平均每次耗时");
  assert.equal(result.diagnostics.chunkStats.length, 2);
  assert.ok(result.diagnostics.chunkStats.every(stat => stat.attempts === 2 && stat.ok === true));
  assert.ok(result.diagnostics.chunkStats[0].ms >= result.diagnostics.chunkStats.at(-1).ms, "按耗时降序");
});

test("全部段落都落库并渲染，进度文案带块数与用时", async () => {
  const harness = makeHarness({ paragraphs: makeParagraphs(8, 400) });
  const result = await runBatch(harness);
  assert.equal(harness.state.translations.size, 8);
  assert.equal(harness.committed.length, 8);
  harness.chapter.paragraphs.forEach(item => {
    assert.equal(item.node.rendered, `译:${item.original_text}`);
    assert.equal(item.node.dataset.mtNovelStatus, "current");
  });
  assert.ok(harness.phases.some(phase => /（\d+\/\d+ 块 · 请求 \d+ 次 · \d+s）/u.test(phase)), "进度要能看到块数、请求次数与耗时");
  assert.ok(harness.phases.every(phase => !/重试/u.test(phase)), "一次都没被打回的运行不该出现「重试」字样");
  assert.equal(result.errors.length, 0);
  assert.equal(result.diagnostics.missing, 0);
});

test("术语使用情况显示在进度行上：注入了却没用，看得见", async () => {
  const harness = makeHarness({
    paragraphs: makeParagraphs(6, 300),
    termUsage: { entries: 2, enabled: 2, injected: 1, used: 0, reason: "ok" }
  });
  const result = await runBatch(harness);
  assert.ok(harness.phases.some(phase => /术语用上 0\/\d+/u.test(phase)),
    "进度里要能看出术语有没有被模型用上");
  assert.equal(result.termUsage.reason, "ok");
  assert.ok(result.termUsage.injected >= 2, "多块的结果要累加");
});

test("术语没生效的原因（如本页不在应用网址内）直接写在进度行上", async () => {
  const harness = makeHarness({
    paragraphs: makeParagraphs(3, 300),
    termUsage: { entries: 5, enabled: 0, injected: 0, used: 0, reason: "page" }
  });
  const result = await runBatch(harness);
  assert.ok(harness.phases.some(phase => /术语未生效：本页不在应用网址内/u.test(phase)));
  assert.equal(result.termUsage.reason, "page");
});

test("术语被模型自己发挥时：定点补翻受影响的段落，并点名要求用哪个译名", async () => {
  const harness = makeHarness({
    paragraphs: makeParagraphs(6, 300),
    termUsage: {
      entries: 2, enabled: 2, injected: 2, used: 0, reason: "ok",
      unused: [
        { id: "0", source: "레오나르도", target: "莱昂纳多" },
        { id: "1", source: "봄", target: "春" }
      ]
    }
  });
  const result = await runBatch(harness);
  const repairs = harness.requests.filter(request => request.revisionInstruction);
  // 默认每批 3 段，两段受影响的段落并成一批：只问受影响的段落，不重翻整块
  assert.deepEqual(repairs.map(request => request.ids).flat().sort(), ["0", "1"]);
  assert.ok(repairs.every(request => request.size <= 3), "一批不超过设置里的批大小");
  assert.match(repairs[0].revisionInstruction, /레오나르도→莱昂纳多/u);
  assert.match(repairs[0].revisionInstruction, /봄→春/u);
  assert.match(repairs[0].revisionInstruction, /确实不是指这个对象，可以保留原译/u, "要允许按语境跳过，不能硬掰");
  assert.match(repairs[0].revisionInstruction, /- 0：/u, "修正要求要按段落 id 逐条点名");
  assert.ok(harness.phases.some(phase => /正在修正译文（2 段）/u.test(phase)));
  // 2 块 × 注入 2 + 1 个补翻请求 × 注入 2（测试桩对每个请求都回同一份统计）
  assert.equal(result.termUsage.injected, 6, "补翻请求的统计也要并回来");
});

test("术语补翻不再限量：未使用的再多也全部补上（按批发，不留尾巴）", async () => {
  const unused = ["0", "1", "2", "3", "4"].map(id => ({ id, source: `이름${id}`, target: `名字${id}` }));
  const harness = makeHarness({
    paragraphs: makeParagraphs(6, 300),
    termUsage: { entries: 5, enabled: 5, injected: 5, used: 0, reason: "ok", unused }
  });
  const result = await runBatch(harness);
  const repairs = harness.requests.filter(request => request.revisionInstruction);
  // 5 段 × 每批 3 段 → 2 批；旧实现只修前 3 段，剩下两段永远不会被修
  assert.equal(repairs.length, 2, "按批发完，不是只修前几段");
  assert.deepEqual(repairs.map(request => request.ids).flat().sort(), ["0", "1", "2", "3", "4"]);
  assert.equal(result.diagnostics.missing, 0);
  assert.equal(harness.state.translations.size, 6);
});

test("目标是简体却出现繁体字：定点重问那一段，并点名要求改成简体", async () => {
  const harness = makeHarness({
    paragraphs: makeParagraphs(4, 300),
    translatedText: item => (item.id === "1" ? "這個時候他說。" : "他说了一句。")
  });
  await runBatch(harness);
  const repairs = harness.requests.filter(request => request.revisionInstruction);
  assert.deepEqual(repairs.map(request => request.ids[0]), ["1"], "只补出现繁体字的那一段");
  assert.match(repairs[0].revisionInstruction, /必须全部改用简体中文/u);
  assert.match(repairs[0].revisionInstruction, /「時」「說」/u, "举出实际出现的繁体字更管用");
  assert.ok(harness.phases.some(phase => /正在修正译文（1 段）/u.test(phase)));
});

test("目标是繁体（zh-TW）时不判繁体字，也不补问", async () => {
  const harness = makeHarness({
    paragraphs: makeParagraphs(4, 300),
    translatedText: () => "這個時候他說。"
  });
  harness.runtime.getTargetLanguage = () => "zh-TW";
  await runBatch(harness);
  assert.equal(harness.requests.filter(request => request.revisionInstruction).length, 0);
});

test("后一块先回来也不会先上屏：结果按块顺序贴，屏幕从上往下长", async () => {
  // 故意让开头那一块慢 10 倍：后一块先到达，但绝不能先贴上去
  const harness = makeHarness({
    paragraphs: makeParagraphs(6, 300),
    requestDelay: items => (items[0].id === "0" ? 80 : 5)
  });
  const result = await runBatch(harness);
  assert.equal(result.diagnostics.chunks, 2, "6 段平均切成两块");
  assert.deepEqual(harness.renderOrder, ["0", "1", "2", "3", "4", "5"],
    "「最后一段先出来」不该再发生：上屏顺序必须是从前往后");
  const arrivals = harness.requests.map(request => request.ids[0]);
  assert.deepEqual(arrivals, ["3", "0"], "对照组：确实是后一块先回来的，所以刚才那条断言有意义");
});

test("某块失败也不会卡住后面的块：按空结果推进，其余照常上屏", async () => {
  const harness = makeHarness({ paragraphs: makeParagraphs(6, 300), failFirstIds: new Set(["0"]) });
  const result = await runBatch(harness);
  // 第一块整体失败（0、1、2 三段）：游标立即推进，后 3 段照常上屏；
  // 前三段最后由「漏段逐段补齐」补回来，所以它们排在后面。
  assert.deepEqual(harness.renderOrder.slice(0, 3), ["3", "4", "5"]);
  assert.deepEqual([...harness.renderOrder.slice(3)].sort(), ["0", "1", "2"]);
  assert.equal(result.diagnostics.missing, 0, "失败块最终被补齐，没有漏段");
});

test("splitEvenly：块数取最少、大小尽量平均、单段超限时自己占一块", () => {
  const item = (id, chars) => ({ id, original_text: "가".repeat(chars) });
  assert.deepEqual(splitEvenly([], 1200), []);
  assert.deepEqual(splitEvenly([item("0", 500)], 1200).map(block => block.length), [1]);
  // 正好一块
  assert.deepEqual(splitEvenly([item("0", 400), item("1", 400), item("2", 400)], 1200).map(block => block.length), [3]);
  // 余数均分：1800 字 → 两块各 900，而不是 1200 + 600
  assert.deepEqual(splitEvenly([0, 1, 2, 3, 4, 5].map(id => item(String(id), 300)), 1200)
    .map(block => block.length), [3, 3]);
  // 整块：4800 字 → 四块各 1200
  assert.deepEqual(splitEvenly(Array.from({ length: 12 }, (_, id) => item(String(id), 400)), 1200)
    .map(block => block.length), [3, 3, 3, 3]);
  // 单段就超上限：它自己占一块，后面照常切
  const oversized = splitEvenly([item("big", 5000), item("a", 300), item("b", 300)], 1200);
  assert.deepEqual(oversized.map(block => block.map(entry => entry.id)), [["big"], ["a", "b"]]);
  // 任何情况下都不超过上限（单段本身超限除外）
  splitEvenly(Array.from({ length: 17 }, (_, id) => item(String(id), 137)), 1200).forEach(block => {
    const chars = block.reduce((sum, entry) => sum + entry.original_text.length, 0);
    assert.ok(chars <= 1200, `块超限：${chars}`);
  });
});

test("不传前文译文：块之间没有顺序依赖，上下文只来自原文", async () => {
  const harness = makeHarness({ paragraphs: makeParagraphs(12, 400) });
  await runBatch(harness);
  assert.ok(harness.requests.length > 0);
  assert.ok(harness.requests.every(request => request.previousTranslation === ""),
    "并发的前提是块互相独立：不应再带「前文译文」");
  const chunkRequests = harness.requests;
  // 请求数组是「完成顺序」，不是块顺序：按内容找，不要按下标找
  const chunkWith = id => chunkRequests.find(request => request.ids.includes(id));
  assert.equal(chunkWith("0").beforeText, "", "第一块前面没有原文邻居");
  assert.equal(chunkWith("11").afterText, "", "最后一块后面没有原文邻居");
  assert.ok(chunkWith("3").beforeText.length > 0, "中间块仍有原文邻居");
  assert.ok(chunkWith("3").afterText.length > 0);
  assert.ok(chunkWith("3").beforeText.includes("가"), "前文给的是原文，不是译文");
  // 邻居只留 1 段：这是纯省 token 的取舍（前后文原本比正文还贵）
  assert.equal(chunkWith("3").beforeText.split("\n").length, 1);
  assert.equal(chunkWith("3").afterText.split("\n").length, 1);
});

test("上下文与「前面的块翻没翻完」无关：两次运行的上下文完全一致", async () => {
  const paragraphs = makeParagraphs(12, 400);
  const first = makeHarness({ paragraphs });
  const second = makeHarness({ paragraphs });
  await runBatch(first);
  await runBatch(second);
  const context = harness => harness.requests
    .map(request => [request.ids.join(","), request.beforeText, request.afterText].join("\u0000"))
    .sort();
  assert.deepEqual(context(first), context(second));
});

test("某块失败不拖死其它块：其余块照常出译文，失败块的段落走逐段补齐", async () => {
  const paragraphs = makeParagraphs(8, 400);
  // 8 段 × 400 字 → 3 块（3 + 3 + 2 段），让第一块整体失败
  const harness = makeHarness({ paragraphs, failFirstIds: new Set(["0"]) });
  const result = await runBatch(harness);
  assert.equal(harness.state.translations.size, 8, "漏掉的段落应被逐段补齐");
  assert.equal(result.diagnostics.failures, 1);
  const repairs = harness.requests.filter(request => request.size === 1);
  assert.deepEqual(repairs.map(request => request.ids[0]).sort(), ["0", "1", "2"]);
  assert.equal(result.diagnostics.missing, 0);
});

test("连续失败达到上限后不再发新块，避免 API 挂掉时并发打出一堆失败请求", async () => {
  const paragraphs = makeParagraphs(40, 400);
  const failing = new Set(paragraphs.slice(0, 20).map(item => item.id));
  const harness = makeHarness({ paragraphs, failFirstIds: failing });
  const result = await runBatch(harness);
  const { failures, dispatched, chunks } = result.diagnostics;
  // 并发工作线程各自去取下一个任务，所以失败数最多是「上限 + 已出发的并发数 - 1」
  assert.ok(failures <= 2 + NOVEL_BATCH_DEFAULTS.concurrency, `失败数应被压住，实际 ${failures}`);
  assert.ok(dispatched < chunks, `不应把 ${chunks} 块全发出去（实际发了 ${dispatched}）`);
  assert.ok(dispatched <= 2 + NOVEL_BATCH_DEFAULTS.concurrency, `发出的块数也应被压住，实际 ${dispatched}`);
});

test("逐段补齐也失败时如实报错，不假装成功", async () => {
  const paragraphs = makeParagraphs(2, 400);
  const runtimeHarness = makeHarness({ paragraphs });
  runtimeHarness.runtime.sendRuntimeMessage = async () => ({ ok: false, error: "API 超时" });
  const result = await runBatch(runtimeHarness);
  assert.equal(runtimeHarness.state.translations.size, 0);
  assert.equal(result.diagnostics.missing, 2);
  // 两条来自块级失败、两条来自逐段补齐（去重交给上层 content-local 做）
  assert.equal(result.errors.length, 4);
  assert.ok(result.errors.every(error => error.error === "API 超时" || error.error === "repair_failed"));
});
