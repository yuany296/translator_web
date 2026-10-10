/**
 * 分片长条阅读器（RIDI 1280 宽分片）里「一行字被分片边界劈成两半」的现场回归。
 *
 * 现场：`ridibooks.com/books/6305000008/view`，上片 page-c5f2a563 / 下片 page-ad0902ba，
 * 一行特效字 `「지오의 초상화」` 被劈成上片 62px（字头）+ 下片 80px（字身）。
 * 上片整页 OCR 只拿到字头碎片（乱码 `[기0 이 국 사히`，被服务端丢弃），下片整页 OCR 拿到
 * 字身并读成 `'지오의조정화]`，而接缝复合图（上片末 96 行 + 下片首 96 行 = 1280x192）
 * 把这行正确识别成两个框 `[지오의` / `초상화]`（置信度 0.99）。
 *
 * 修复前：两个框字高 150~153px，都超过「带宽 × 1.5 = 144」的跨缝上限，被判
 * `seam_not_cross_boundary` 丢掉 —— 接缝跑了、也识别对了，证据却一条没留：canonical 只剩
 * 下面那半句，遮罩只盖住下片那一部分（用户看到「覆盖框没完全对齐原图」）。
 */
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { canonicalPipeline as P } from "../extension/src/canonical/pipeline.js";
import { reconciler as R } from "../extension/src/canonical/reconciler.js";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "test", "background.iife.js"), "utf8");
const listeners = { addListener() {} };
const context = vm.createContext({
  chrome: {
    runtime: { onInstalled: listeners, onStartup: listeners, onMessage: listeners },
    tabs: {},
    storage: { local: {} }
  },
  console, fetch, URL, Blob, AbortController, atob, crypto: webcrypto, setTimeout, clearTimeout
});
vm.runInContext(`${source}\nglobalThis.__backgroundTest = MtBackgroundModule.backgroundRuntime;`, context, {
  filename: "background.iife.js"
});

const UPPER = "page-c5f2a56328ea399357cc2a0017b84c16545e4894062a4e8a1d0b65f528fa68a5";
const LOWER = "page-ad0902ba6007123139057f95f7910741ffe220255e94f831aee66884247e647c";
const CHAPTER = "chapter-ridi-6305000008";
const IMAGE_SIZE = { width: 1280, height: 192 };
const REQUEST = {
  sourceType: "seam",
  pageIds: [UPPER, LOWER],
  imageRevisionByPage: { [UPPER]: "rev-upper", [LOWER]: "rev-lower" },
  imageMeta: {
    sourceType: "seam",
    pageSpans: [{
      pageId: UPPER,
      canvasBox: { x: 0, y: 0, w: 1280, h: 96 },
      pageBox: { x: 0, y: 1184, w: 1280, h: 96 },
      pageWidth: 1280,
      pageHeight: 1280
    }, {
      pageId: LOWER,
      canvasBox: { x: 0, y: 96, w: 1280, h: 96 },
      pageBox: { x: 0, y: 0, w: 1280, h: 96 },
      pageWidth: 1280,
      pageHeight: 1280
    }]
  }
};

function candidate(text, rawBox, regionType = "effect_text") {
  return {
    original_text: text,
    x: rawBox.left / IMAGE_SIZE.width * 100,
    y: rawBox.top / IMAGE_SIZE.height * 100,
    w: rawBox.width / IMAGE_SIZE.width * 100,
    h: rawBox.height / IMAGE_SIZE.height * 100,
    rawBox,
    confidence: 0.99,
    bg_type: "none",
    region_type: regionType,
    region_id: "",
    rotation_deg: 0
  };
}

// 现场真实框（接缝复合图上的聚类结果）
const CUT_LEFT = { left: 256.4, top: 28.32, width: 385.2, height: 153.36 };
const CUT_RIGHT = { left: 640.085, top: 34.44, width: 394.83, height: 150.12 };

test("被分片边界劈开的整行特效字：字高超过「带宽 × 1.5」也不算不跨缝", () => {
  const background = context.__backgroundTest;
  const result = background.filterSeamOcrCandidates([
    candidate("[지오의", CUT_LEFT),
    candidate("초상화]", CUT_RIGHT)
  ], REQUEST, IMAGE_SIZE);
  assert.deepEqual(Array.from(result.retained, item => item.original_text), ["[지오의", "초상화]"]);
  assert.equal(result.rejected.length, 0);
  // 判据本身：两个框都完整落在复合图内部（上下不贴画布边），所以按「被劈开的一行」接受。
  assert.equal(background.seamLineFitsComposite(CUT_LEFT, IMAGE_SIZE), true);
  assert.equal(background.seamLineFitsComposite(CUT_RIGHT, IMAGE_SIZE), true);
});

test("整幅复合图大小的场景框仍然不算跨缝（原来的上限继续挡住它）", () => {
  const background = context.__backgroundTest;
  const scene = { left: 20, top: 0, width: 680, height: 192 };
  const result = background.filterSeamOcrCandidates([candidate("oversized mixed seam scene", scene)], REQUEST, IMAGE_SIZE);
  assert.equal(result.retained.length, 0);
  assert.equal(result.rejected[0].reason, "seam_not_cross_boundary");
  assert.equal(background.seamLineFitsComposite(scene, IMAGE_SIZE), false);
  assert.equal(background.seamLineFitsComposite({ left: 20, top: 1, width: 680, height: 190 }, IMAGE_SIZE), false);
});

function page(pageId, readingOrder, nextPageId, previousPageId) {
  return {
    pageId, chapterId: CHAPTER, imageRevision: `rev-${readingOrder}`, width: 1280, height: 1280,
    readingOrder, shortPage: false, nextPageId, previousPageId
  };
}

function seamObservation(text, upperBox, lowerBox, captureId = "local_paddle|seam|cut-line") {
  return R.createObservation({
    provider: "local_paddle",
    captureId,
    sourceType: "seam",
    pageIds: [UPPER, LOWER],
    imageRevisionByPage: { [UPPER]: "rev-0", [LOWER]: "rev-1" },
    pageSpans: [{
      pageId: UPPER, box: upperBox, coordinateSpace: "percent", regionType: "effect_text", overlapRatio: 0.44
    }, {
      pageId: LOWER, box: lowerBox, coordinateSpace: "percent", regionType: "effect_text", overlapRatio: 0.56
    }],
    originalText: text,
    confidence: 0.99,
    visual: { regionType: "effect_text" }
  });
}

function pageObservation(text, box) {
  return R.createObservation({
    provider: "local_paddle",
    captureId: `local_paddle|page|${text}`,
    sourceType: "page",
    pageIds: [LOWER],
    imageRevisionByPage: { [LOWER]: "rev-1" },
    pageSpans: [{ pageId: LOWER, box, coordinateSpace: "percent", regionType: "caption_panel", overlapRatio: 1 }],
    originalText: text,
    confidence: 0.81,
    visual: { regionType: "caption_panel" }
  });
}

test("同一次复合图的左右两半整体挂到同一条 canonical，原文取拼出的整行", () => {
  const pages = [page(UPPER, 0, LOWER, ""), page(LOWER, 1, "", UPPER)];
  const cutLine = pageObservation("'지오의조정화]", { x: 20.33, y: 0, w: 62.15, h: 7.72 });
  const restOfPanel = pageObservation("탐색3일차, 종료", { x: 26.5, y: 5.21, w: 47.4, h: 23.96 });
  const result = R.reconcile({
    pages,
    observations: [
      seamObservation("[지오의", { x: 20.03, y: 94.71, w: 30.09, h: 5.29 }, { x: 20.03, y: 0, w: 30.09, h: 6.69 }),
      seamObservation("초상화]", { x: 50.01, y: 95.19, w: 30.85, h: 4.81 }, { x: 50.01, y: 0, w: 30.85, h: 6.92 }),
      cutLine,
      restOfPanel
    ]
  });
  const merged = result.canonicals.find(canonical => canonical.memberObservationIds.includes(cutLine.id));
  assert.ok(merged, "被劈开那一行必须和接缝证据并成同一条 canonical");
  assert.equal(merged.originalText, "[지오의 초상화]");
  assert.deepEqual(Object.keys(merged.geometryByPage).sort(), [UPPER, LOWER].sort());
  // 两片各自的几何都要覆盖整行的左右两半（原来只盖住下片，才出现「覆盖框没对齐」）。
  const toBox = row => {
    const source = row.box || {};
    return {
      left: Number(source.left ?? source.x),
      width: Number(source.width ?? source.w)
    };
  };
  for (const pageId of [UPPER, LOWER]) {
    const boxes = merged.geometryByPage[pageId].map(toBox);
    const left = Math.min(...boxes.map(box => box.left));
    const right = Math.max(...boxes.map(box => box.left + box.width));
    assert.ok(left <= 21 && right >= 80, `${pageId} 的接缝几何只盖到 ${left}~${right}%`);
  }
  // 面板的其余两行仍是独立一条，不被并进这一行。
  assert.ok(result.canonicals.some(canonical => canonical.originalText === "탐색3일차, 종료"));
  assert.equal(result.canonicals.length, 2);
});

test("后台入口必须原样透传接缝带提示（白名单漏字段 = 提示没发）", () => {
  const background = context.__backgroundTest;
  const meta = background.normalizeImageMeta({
    width: 1280,
    height: 1280,
    source: "img-fetch",
    edgeLineBandPx: 96
  });
  assert.equal(meta.edgeLineBandPx, 96, "normalizeImageMeta 的白名单重建不能丢掉接缝带提示");
  assert.equal(background.normalizeImageMeta({ width: 1280, height: 1280 }).edgeLineBandPx, 0);
});

test("页级聚类：被分片边界剪断的那一行独立成观测，带内的正常行仍成段", async () => {
  const background = context.__backgroundTest;
  const panelRegion = { left: 192, top: 0, width: 931.37, height: 409.26 };
  const polygon = box => [[box.left, box.top], [box.left + box.width, box.top], [box.left + box.width, box.top + box.height], [box.left, box.top + box.height]];
  const pageItems = [
    { text: "'지오의조정화]", score: 0.8058, box: { left: 284, top: 0, width: 748, height: 95 } },
    { text: "탐색3일차,", score: 0.9973, box: { left: 359, top: 78, width: 567, height: 153 } },
    { text: "종료", score: 0.9999, box: { left: 531, top: 228, width: 225, height: 133 } }
  ].map(item => ({
    ...item,
    polygon: polygon(item.box),
    region_id: "region-1",
    region_type: "caption_panel",
    region_box: panelRegion,
    region_confidence: 0.9987,
    bg_color: "#2b2337",
    text_color: "#fce46c"
  }));
  const imageSize = { width: 1280, height: 1280 };
  const cluster = async imageMeta => {
    const tuning = background.getDefaultOcrTuning();
    const debugSession = background.createOcrDebugSession("local_paddle", imageSize, tuning);
    return background.buildLocalPaddleBubbleItems(
      { imageWidth: imageSize.width, imageHeight: imageSize.height, items: pageItems },
      imageSize, "", false, null, tuning, debugSession, imageMeta, {}
    );
  };
  const withoutHint = await cluster(null);
  assert.equal(withoutHint.length, 1, "没有分片提示时三行仍并成一个面板块（普通阅读器行为不变）");
  const withHint = await cluster({ edgeLineBandPx: 96 });
  assert.equal(withHint.length, 2, "被剪断的那一行必须独立成观测，其余两行保持整段");
  assert.equal(withHint[0].original_text || withHint[0].words, "'지오의조정화]");
  assert.match(String(withHint[1].original_text || withHint[1].words), /탐색3일차,[\s\S]*종료/u);
  // 带内但没被剪断的行（离画布边几十像素）不能被当成被切行，否则整段会被拆成单行气泡。
  assert.equal(background.isLocalPaddleEdgeCutLine({ box: { top: 71.88, height: 165.24 } }, 96, 1280), false);
  assert.equal(background.isLocalPaddleEdgeCutLine({ box: { top: 0, height: 98.8 } }, 96, 1280), true);
});

test("接缝面吸收同一面板的相邻行：整块并成一条气泡，不再两份覆盖", () => {
  const segments = [{
    pageId: UPPER, drawRect: { x: 0, y: 0, w: 1280, h: 96 }, sourceCrop: { x: 0, y: 1184, w: 1280, h: 96 }, naturalWidth: 1280, naturalHeight: 1280
  }, {
    pageId: LOWER, drawRect: { x: 0, y: 96, w: 1280, h: 96 }, sourceCrop: { x: 0, y: 0, w: 1280, h: 96 }, naturalWidth: 1280, naturalHeight: 1280
  }];
  // winner = 被剪断那一行（接缝面）；residual = 面板其余两行（页级气泡）。
  const winner = {
    canonical: { id: "canonical_cut_line", originalText: "[지오의 초상화]", memberObservationIds: ["seam-a", "seam-b"] },
    bubble: { page_text_boxes: [{ pageId: LOWER, x: 22.19, y: 0, w: 58.44, h: 7.42 }] }
  };
  const residualCanonical = { id: "canonical_rest_of_panel", status: "ready", originalText: "탐색3일차, 종료", memberObservationIds: ["page-rest"] };
  const observationsById = new Map([
    ["seam-a", { id: "seam-a", sourceType: "seam", pageSpans: [] }],
    ["seam-b", { id: "seam-b", sourceType: "seam", pageSpans: [] }],
    ["page-rest", {
      id: "page-rest",
      sourceType: "page",
      visual: { translationRole: "" },
      pageSpans: [{ pageId: LOWER, box: { x: 26.5, y: 5.21, w: 47.4, h: 23.96 } }]
    }]
  ]);
  // 现场实测：标题行框高 7.42%、正文行组从 5.21% 起 → 重叠 2.21% = 较矮行高的 0.30，
  // 旧容差 0.25 差一点点就吸收不了，同一块内容于是被画两遍。
  const absorbed = P.findSeamCoveredResidualCanonicals([winner], [residualCanonical], observationsById, segments);
  assert.deepEqual(absorbed.map(item => [item.canonical.id, item.kind]), [["canonical_rest_of_panel", "adjacent_line"]]);
  const ownership = P.collectSeamSurfaceOwnership([winner], [], [residualCanonical], observationsById, segments);
  assert.equal(ownership.absorbedIdSet.has("canonical_rest_of_panel"), true, "被吸收的页级气泡必须从渲染里摘掉");
});

test("复合图把两半合成一条完整读法时，页级残缺读法仍按几何认作同一行", () => {
  const pages = [page(UPPER, 0, LOWER, ""), page(LOWER, 1, "", UPPER)];
  // 现场这一次的形状：接缝复合图输出一条观测（原文是完整的一行），页级只读到下半截。
  const mergedLine = R.createObservation({
    provider: "local_paddle",
    captureId: "local_paddle|seam|merged-line",
    sourceType: "seam",
    pageIds: [UPPER, LOWER],
    imageRevisionByPage: { [UPPER]: "rev-0", [LOWER]: "rev-1" },
    pageSpans: [{
      pageId: UPPER, box: { x: 20.0, y: 94.7, w: 60.9, h: 5.3 }, coordinateSpace: "percent", regionType: "effect_text", overlapRatio: 0.44
    }, {
      pageId: LOWER, box: { x: 20.0, y: 0, w: 60.9, h: 7.1 }, coordinateSpace: "percent", regionType: "effect_text", overlapRatio: 0.56
    }],
    originalText: "[지오의 초상화]",
    confidence: 0.99,
    visual: { regionType: "effect_text" }
  });
  const pageFragment = pageObservation("'지오의조정화]", { x: 20.33, y: 0, w: 62.15, h: 7.72 });
  const restOfPanel = pageObservation("탐색3일차, 종료", { x: 26.5, y: 5.21, w: 47.4, h: 23.96 });
  const result = R.reconcile({ pages, observations: [mergedLine, pageFragment, restOfPanel] });
  const merged = result.canonicals.find(canonical => canonical.memberObservationIds.includes(pageFragment.id));
  assert.ok(merged, "页级残缺读法必须和接缝证据并成同一条 canonical（几何同一行）");
  assert.equal(merged.memberObservationIds.length, 2);
  assert.equal(merged.originalText, "[지오의 초상화]");
  assert.deepEqual(Object.keys(merged.geometryByPage).sort(), [UPPER, LOWER].sort());
  assert.equal(result.canonicals.filter(canonical => canonical.memberObservationIds.includes(restOfPanel.id)).length, 1);
  assert.equal(result.canonicals.length, 2, "面板其余两行仍是一条独立 canonical");
});

test("对照：把左右两半当成两次独立证据（修复前的挂载口径）就只会各成半句", () => {
  const pages = [page(UPPER, 0, LOWER, ""), page(LOWER, 1, "", UPPER)];
  const cutLine = pageObservation("'지오의조정화]", { x: 20.33, y: 0, w: 62.15, h: 7.72 });
  const result = R.reconcile({
    pages,
    observations: [
      seamObservation("[지오의", { x: 20.03, y: 94.71, w: 30.09, h: 5.29 }, { x: 20.03, y: 0, w: 30.09, h: 6.69 }, "capture-left"),
      seamObservation("초상화]", { x: 50.01, y: 95.19, w: 30.85, h: 4.81 }, { x: 50.01, y: 0, w: 30.85, h: 6.92 }, "capture-right"),
      cutLine
    ]
  });
  const merged = result.canonicals.find(canonical => canonical.memberObservationIds.includes(cutLine.id));
  assert.ok(merged);
  assert.notEqual(merged.originalText, "[지오의 초상화]", "独立证据不该拼出整行");
  // 右半没有并进这一行 → 它自己成了另一条只有半句原文 + 右半几何的 canonical。
  const orphan = result.canonicals.find(canonical => canonical.originalText === "초상화]");
  assert.ok(orphan, "修复前右半会自成一条");
  const upperLeft = Math.min(...merged.geometryByPage[UPPER].map(row => Number(row.box.left ?? row.box.x)));
  const upperRight = Math.max(...merged.geometryByPage[UPPER].map(row => Number(row.box.left ?? row.box.x) + Number(row.box.width ?? row.box.w)));
  assert.ok(upperRight < 80, `独立证据下上片只该盖到左半，实际盖到 ${upperLeft}~${upperRight}%`);
});

/**
 * 「气泡轮廓越过分页线、文字像素全在下一页」的现场（用户缺陷：上一页顶部长出一条白色实底）。
 *
 * 接缝复合图把气泡整体读成一个实底 speech_bubble：容器跨过边界，文字框只在下一片，
 * 且离边界不超过边缘窗口 → `describeSeamOcrCandidate` 的 visualCrossesBoundary 判它跨缝、
 * 于是 `buildObservationPageSpans` 会把这一页的贡献扩成**整个视觉容器**（建立双页渲染面
 * 所必需）。代价是上一页拿到一个没有文字的空壳 span —— 这里必须显式声明
 * `hasTextPixels: false`，canonical 层才不会给上一页发遮罩/投影。
 */
test("跨页气泡：文字像素不在上一页时，span 显式声明没有文字像素", () => {
  const background = context.__backgroundTest;
  const toPercentBox = box => ({
    x: box.left / IMAGE_SIZE.width * 100,
    y: box.top / IMAGE_SIZE.height * 100,
    w: box.width / IMAGE_SIZE.width * 100,
    h: box.height / IMAGE_SIZE.height * 100
  });
  const toPercentPolygon = box => [
    { x: box.left / IMAGE_SIZE.width * 100, y: box.top / IMAGE_SIZE.height * 100 },
    { x: (box.left + box.width) / IMAGE_SIZE.width * 100, y: box.top / IMAGE_SIZE.height * 100 },
    { x: (box.left + box.width) / IMAGE_SIZE.width * 100, y: (box.top + box.height) / IMAGE_SIZE.height * 100 },
    { x: box.left / IMAGE_SIZE.width * 100, y: (box.top + box.height) / IMAGE_SIZE.height * 100 }
  ];
  // 文字框整体落在下片（96~192），且离边界不超过边缘窗口；容器（44~182）跨过边界。
  const textBox = { left: 256.4, top: 110, width: 385.2, height: 60 };
  const regionBox = { left: 236, top: 44, width: 420, height: 138 };
  const candidate = {
    original_text: "지오의 초상화",
    confidence: 0.99,
    bg_type: "solid",
    bg_color: "#ffffff",
    region_id: "region-seam-1",
    region_type: "speech_bubble",
    rotation_deg: 0,
    rawBox: textBox,
    ...toPercentBox(textBox),
    polygon: toPercentPolygon(textBox),
    fill_box: toPercentBox(regionBox),
    region_polygon: toPercentPolygon(regionBox)
  };

  const spans = background.buildObservationPageSpans(REQUEST, candidate, IMAGE_SIZE);
  assert.equal(spans.length, 2);
  const upperSpan = spans.find(span => span.pageId === UPPER);
  const lowerSpan = spans.find(span => span.pageId === LOWER);
  assert.ok(upperSpan.box.h > 0, "上一页仍需保留容器切片（双页渲染面靠它建立）");
  assert.equal(upperSpan.visual.textBox, null, "文字框与上一页画布不相交");
  assert.equal(upperSpan.visual.hasTextPixels, false, "上一页没有文字像素：必须显式声明");
  assert.ok(upperSpan.visual.fillBox, "容器切片照发（只声明「没有文字」，不删几何）");
  assert.equal(lowerSpan.visual.hasTextPixels, true);
  assert.ok(lowerSpan.visual.textBox, "文字所在页必须有文字框");

  // 普通页请求没有 pageSpans 元数据：整条 span 不带 visual（= 未声明），消费端不得据此收窄。
  const pageSpans = background.buildObservationPageSpans({
    sourceType: "page",
    pageIds: [LOWER],
    imageMeta: { sourceType: "page" }
  }, candidate, IMAGE_SIZE);
  assert.equal(pageSpans[0].visual, undefined);
});
