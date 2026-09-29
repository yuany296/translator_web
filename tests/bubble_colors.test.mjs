import assert from "node:assert/strict";
import test from "node:test";
import {
  applySampledBubbleColors,
  chooseReadableTextColors,
  colorChroma,
  contrastRatio,
  sampleBubbleAppearance
} from "../extension/src/rendering/bubble-colors.js";

/** 造一张 sample 形状的 ImageData：底色 + 中间一块"墨色"文字块。 */
function makeSample({ width = 40, height = 20, background = [250, 250, 250], ink = null } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = ink && x >= 8 && x < 32 && y >= 5 && y < 15;
      const [red, green, blue] = inside ? ink : background;
      const offset = (y * width + x) * 4;
      data[offset] = red;
      data[offset + 1] = green;
      data[offset + 2] = blue;
      data[offset + 3] = 255;
    }
  }
  return { data, width, height, scale: 1, sourceWidth: width, sourceHeight: height };
}

test("浅底深字采样成黑字白边，深底浅字采样成白字黑边", () => {
  const box = { left: 0, top: 0, width: 40, height: 20 };
  const dark = sampleBubbleAppearance(makeSample({ ink: [16, 16, 16] }), box);
  assert.equal(dark.bgColor, "#fafafa");
  assert.equal(dark.inkColor, "#101010");
  const darkChoice = chooseReadableTextColors(dark.inkColor, dark.bgColor);
  assert.equal(darkChoice.textColor, "#101010", "原图墨色对比度足够时必须保留原墨色");
  assert.equal(darkChoice.strokeColor, "#ffffff");

  const light = sampleBubbleAppearance(makeSample({ background: [20, 20, 24], ink: [242, 242, 242] }), box);
  const lightChoice = chooseReadableTextColors(light.inkColor, light.bgColor);
  assert.equal(lightChoice.textColor, "#f2f2f2");
  assert.equal(lightChoice.strokeColor, "#000000");
});

test("低对比墨色按背景对比度回落，不再写死黑字白边", () => {
  // 灰底 + 中灰"墨色"：对比度不足，应按背景选白字/黑描边。
  const appearance = sampleBubbleAppearance(makeSample({ background: [40, 40, 40], ink: [96, 96, 96] }), box0());
  const choice = chooseReadableTextColors(appearance.inkColor, appearance.bgColor);
  assert.ok(contrastRatio(appearance.inkColor, appearance.bgColor) < 4.5);
  assert.equal(choice.textColor, "#ffffff");
  assert.equal(choice.strokeColor, "#000000");
});

function box0() {
  return { left: 0, top: 0, width: 40, height: 20 };
}

test("applySampledBubbleColors 只补缺色条目，已有采样值不覆盖", () => {
  const sample = makeSample({ ink: [16, 16, 16] });
  const imageAnalysis = { sample };
  const items = [
    { box: box0() },
    { box: box0(), text_color: "#abcdef", stroke_color: "#123456" }
  ];
  const filled = applySampledBubbleColors(items, imageAnalysis);
  assert.equal(filled, 2);
  assert.equal(items[0].text_color, "#101010");
  assert.equal(items[0].stroke_color, "#ffffff");
  assert.equal(items[0].bg_color, "#fafafa");
  assert.equal(items[1].text_color, "#abcdef", "服务已经采样过的颜色不能被覆盖");
  assert.equal(items[1].stroke_color, "#123456");
  assert.equal(items[1].bg_color, "#fafafa", "缺背景色时仍补采样，供渲染层做对比度推导");
  assert.equal(applySampledBubbleColors(items, null), 0);
});

/** 造一张 200x150 纯底图，patches 为 [color, left, top, right, bottom] 的色块列表。 */
function makeFlatSample(background, patches = []) {
  const width = 200;
  const height = 150;
  const data = new Uint8ClampedArray(width * height * 4);
  const set = (x, y, [red, green, blue]) => {
    const offset = (y * width + x) * 4;
    data[offset] = red;
    data[offset + 1] = green;
    data[offset + 2] = blue;
    data[offset + 3] = 255;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) set(x, y, background);
  }
  patches.forEach(([color, left, top, right, bottom]) => {
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) set(x, y, color);
    }
  });
  return { data, width, height, scale: 1 };
}

/**
 * RIDI 第 8 话现场形态：浅灰紫渐变背景 + 白色描边 + 饱和蓝笔画。白描边像素
 * （~9600，54%）远大于蓝笔画（~640，3.6%），旧逻辑按像素数取主色必然选中白。
 */
function makeStrokeOutlineSample() {
  const sample = makeFlatSample([208, 207, 211]); // #d0cfd3
  const white = [255, 255, 255];
  const blue = [55, 89, 205]; // #3759cd
  const set = (x, y, color) => {
    const offset = (y * sample.width + x) * 4;
    sample.data[offset] = color[0];
    sample.data[offset + 1] = color[1];
    sample.data[offset + 2] = color[2];
    sample.data[offset + 3] = 255;
  };
  // box {left:20,top:20,w:160,h:110} 的外圈 13px 保持背景（环中位数取背景），
  // 白描边与蓝笔画只画在内部：每个 8x8 cell 外圈 2px 白、中心 2x2 蓝。
  for (let cellY = 33; cellY + 8 <= 117; cellY += 8) {
    for (let cellX = 33; cellX + 8 <= 167; cellX += 8) {
      for (let y = cellY; y < cellY + 8; y += 1) {
        for (let x = cellX; x < cellX + 8; x += 1) {
          const inBlue = x >= cellX + 3 && x < cellX + 5 && y >= cellY + 3 && y < cellY + 5;
          set(x, y, inBlue ? blue : white);
        }
      }
    }
  }
  return sample;
}

test("白描边不再劫持墨色主色：蓝字白边的旁白必须采出蓝墨色", () => {
  const appearance = sampleBubbleAppearance(makeStrokeOutlineSample(), { left: 20, top: 20, width: 160, height: 110 });
  assert.equal(appearance.bgColor, "#d0cfd3");
  assert.ok(contrastRatio("#ffffff", "#d0cfd3") < 2, "前提：白描边与背景对比度不足 2（必须被跳过）");
  assert.notEqual(appearance.inkColor, "#ffffff", "像素数最多的白描边桶不能当选主色");
  assert.ok(colorChroma(appearance.inkColor) >= 40, "必须选中彩色笔画而不是白描边");
  // 合成图无反锯齿，桶内均值 = 原笔画色。
  assert.equal(appearance.inkColor, "#3759cd");
  const colors = chooseReadableTextColors(appearance.inkColor, appearance.bgColor);
  assert.equal(colors.textColor, "#3759cd", "彩色墨色必须被保留，不能再压成黑字白边");
  assert.equal(colors.strokeColor, "#ffffff");
});

test("全部墨色桶与背景对比度都不足 2 时，回退旧的像素最多行为", () => {
  // 背景 #f0f0f4 + 两个浅灰墨色桶：#d0d0d4（大块）与 #b8b8bc（小块），对比度都 <2。
  const appearance = sampleBubbleAppearance(makeFlatSample([240, 240, 244], [
    [[208, 208, 212], 30, 30, 100, 80],
    [[184, 184, 188], 120, 100, 150, 120]
  ]), { left: 0, top: 0, width: 200, height: 150 });
  assert.ok(contrastRatio("#d0d0d4", "#f0f0f4") < 2);
  assert.ok(contrastRatio("#b8b8bc", "#f0f0f4") < 2);
  assert.equal(appearance.inkColor, "#d0d0d4",
    "回退 = 像素数最多的桶（旧行为），可读性交给 chooseReadableTextColors 兜底");
});

test("黑字白底行为不变：唯一的高对比桶就是主色", () => {
  const appearance = sampleBubbleAppearance(makeSample({ ink: [0, 0, 0] }), box0());
  assert.equal(appearance.inkColor, "#000000");
  const colors = chooseReadableTextColors(appearance.inkColor, appearance.bgColor);
  assert.equal(colors.textColor, "#000000");
  assert.equal(colors.strokeColor, "#ffffff");
});

test("深背景白描边让位艳粉笔画：粉字白边不能再渲染成白字黑边", () => {
  // RIDI 第 8 话「这幅肖像画」现场形态（真机取证：背景 #3d0f2f 深紫，白描边桶
  // #fefbfe 20048px / 27.7% / contrast 15.64 当选，艳粉笔画 #f50398 4389px /
  // 6.1% / chroma 242 / contrast 4.08 被埋没）。v2 的对比度过滤在深背景上反而
  // 放大白描边（15.6 远超 2），必须靠白描边守卫让位。
  const background = [61, 15, 47]; // #3d0f2f
  const appearance = sampleBubbleAppearance(makeFlatSample(background, [
    [[254, 251, 254], 18, 18, 118, 68], // 白描边 #fefbfe（5000px，TOP，contrast 15.6）
    [[132, 57, 107], 18, 68, 118, 88], // #84396b（2000px，chroma 75，contrast 2.12）
    [[245, 3, 152], 18, 88, 93, 108], // 艳粉笔画 #f50398（1500px，chroma 242，contrast 4.08）
    [[233, 7, 148], 93, 88, 153, 108], // #e90794（1200px，chroma 226，contrast 3.77）
    [[254, 230, 255], 153, 88, 180, 108], // #ffe6fe（540px，chroma 25 < 40 排除）
    [[159, 79, 132], 18, 108, 68, 128], // #9f4f84（1000px，chroma 80，contrast 3.07）
    [[193, 43, 133], 68, 108, 108, 128], // #c12b85（800px，chroma 150，contrast 3.18）
    [[106, 40, 84], 108, 108, 168, 128] // #6a2854（1200px，contrast 1.56 < 2 排除）
  ]), { left: 0, top: 0, width: 200, height: 150 });
  assert.equal(appearance.bgColor, "#3d0f2f");
  assert.equal(appearance.inkColor, "#f50398",
    "白描边守卫：彩色候选像素合计 6500 ≥ 白描边 5000 → 让位给色度最高的艳粉");
  const colors = chooseReadableTextColors(appearance.inkColor, appearance.bgColor);
  assert.equal(colors.textColor, "#f50398", "粉字必须保留，不能再渲染成白字");
  assert.equal(colors.strokeColor, "#ffffff", "深底粉字配白描边，而不是黑描边");

  // 暖白变体：#ffe0c0 近白但 min 通道 192 < 200（且 chroma 63 ≥ 20），不是
  // 无彩近白 → 守卫不触发，维持 TOP（Python 端桶中心 #fce4cc chroma 48 同样
  // 不触发；两端挂的条件不同但结果一致：都不让位）。
  const warmWhite = sampleBubbleAppearance(makeFlatSample(background, [
    [[255, 224, 192], 18, 18, 118, 68], // 暖白 #ffe0c0（5000px，TOP，contrast 12.75）
    [[245, 3, 152], 18, 88, 93, 108] // 艳粉 #f50398（1500px）
  ]), { left: 0, top: 0, width: 200, height: 150 });
  assert.equal(warmWhite.inkColor, "#ffe0c0", "暖白不是无彩近白，守卫不触发，维持 TOP");
});

test("白色实底大块不被彩色小桶抢走：单桶占比不足 4% 时维持 TOP", () => {
  // 深灰底 + 白色实底 12000px（~54%）+ 艳粉小块 400px（1.8%）：守卫触发
  // （TOP 无彩近白），小块通过 chroma/dist/totalInk 门槛（400 ≥ max(64,
  // 0.005×totalInk=60)）但被单桶占比门槛挡住（400 < 4% × 12000 = 480）→
  // 无候选 → 维持白。v4 让位不比总量（厚描边下彩色合计永远比不过白桶），
  // 防矫枉过正靠 4% 门槛。
  const appearance = sampleBubbleAppearance(makeFlatSample([32, 32, 40], [
    [[255, 255, 255], 18, 18, 138, 118], // 白色实底 12000px（TOP，contrast 16.2）
    [[255, 0, 170], 138, 18, 158, 38] // 艳粉小块 400px（chroma 255，contrast 4.49）
  ]), { left: 0, top: 0, width: 200, height: 150 });
  assert.equal(appearance.bgColor, "#202028");
  assert.equal(appearance.inkColor, "#ffffff", "艳粉单桶 400 < 4% × 12000 = 480 → 无候选 → 维持 TOP");
  const colors = chooseReadableTextColors(appearance.inkColor, appearance.bgColor);
  assert.equal(colors.textColor, "#ffffff", "深底白字行为不变");
  assert.equal(colors.strokeColor, "#000000");
});

test("描边救援必须跟文字色配对：白字不得被配成白描边", () => {
  // 真机实证（「不是怪物。」句）：服务端成对返回 text #fcfcfc + stroke #000000，
  // 但 stroke 纯黑触发描边救援 → 独立重采的深色墨在亮底上算出白描边 → 覆盖
  // 已有黑描边 → 白字白边（描边失效）。修复后描边从最终生效的文字色推导：
  // 亮度 ≥ 0.45 → 黑描边，否则白描边。
  const appearance = makeSample({ background: [208, 207, 211], ink: [5, 11, 14] });
  const items = [{
    box: box0(),
    bg_color: "#d0cfd3",
    text_color: "#fcfcfc", // 非纯黑/纯白 → 文字色保留（needsText=false）
    stroke_color: "#000000" // 纯黑 → 触发描边救援（needsStroke=true）
  }];
  applySampledBubbleColors(items, { sample: appearance });
  assert.equal(items[0].text_color, "#fcfcfc", "非兜底值的文字色必须保留");
  assert.equal(items[0].stroke_color, "#000000",
    "白字（亮度 ≥ 0.45）必须配黑描边，不得用重采墨色产出白描边");
  assert.notEqual(items[0].stroke_color, "#ffffff", "白字白边 = 描边失效，禁止复现");
  assert.equal(items[0].strokeColor, "#000000", "camelCase 别名同步");
});

test("中灰蓝背景渐变红字白描边：红笔画胜出且被保留成红字白边", () => {
  // RIDI 第 8 话「30年前袭击地球的'地下城'正是」现场形态（真机取证：背景
  // #60778f 中灰蓝，红笔画与背景亮度几乎相同 ct 1.0~1.8，被 v2 的 ct≥2 全跳过；
  // 白描边 #fdfbfe 24.5% ct 4.5 当选；v3 守卫候选被 ct≥2 过滤只剩暗蓝 AA，
  // 合计 < 白桶 → 不让位）。v4 判别尺 = 色度 + 与背景 RGB 距离 + 像素数。
  const background = [96, 119, 143]; // #60778f
  const appearance = sampleBubbleAppearance(makeFlatSample(background, [
    [[253, 251, 254], 18, 18, 118, 68], // 白描边 #fdfbfe（5000px，TOP，ct 4.5）
    [[253, 231, 250], 118, 18, 153, 38], // #fde7fa（700px，chroma 22 < 40 排除）
    [[204, 5, 90], 18, 68, 78, 88], // 红 #cc055a（1200px，chroma 199，dist 166）
    [[178, 8, 81], 78, 68, 128, 88], // 红 #b20851（1000px，chroma 170，dist 151）
    [[229, 5, 101], 128, 68, 168, 88], // 红 #e50565（800px，chroma 224，dist 180）
    [[155, 4, 68], 18, 88, 68, 108], // 暗红 #9b0444（1000px，chroma 151，dist 149）
    [[5, 11, 14], 68, 88, 108, 108], // #050b0e（800px，chroma 9 < 40 排除）
    [[15, 39, 55], 108, 88, 148, 108], // 暗蓝 AA #0f2737（800px，chroma 40，dist 144）
    [[35, 62, 81], 148, 88, 178, 108], // 暗蓝 AA #233e51（600px，chroma 46，dist 104）
    [[243, 2, 105], 18, 108, 28, 118] // #f30269（100px，chroma 241 但 < 4% × TOP 被挡）
  ]), { left: 0, top: 0, width: 200, height: 150 });
  assert.equal(appearance.bgColor, "#60778f");
  assert.ok(contrastRatio("#e50565", "#60778f") < 2.2,
    "前提：红笔画与背景亮度几乎相同（亮度判别尺对它失效）");
  assert.equal(appearance.inkColor, "#e50565",
    "守卫让位给色度最高的红桶（不比总量：厚描边下彩色合计远小于白桶）");
  const colors = chooseReadableTextColors(appearance.inkColor, appearance.bgColor);
  assert.equal(colors.textColor, "#e50565", "红字必须保留（ct 1.0 < 2.2，靠色度线保留）");
  assert.equal(colors.strokeColor, "#ffffff", "红字配白描边，与原图一致");
});
