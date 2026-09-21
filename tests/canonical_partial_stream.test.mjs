import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { installCanonicalPartialTranslations } from "../extension/src/content/modules/canonical-partial.js";

const source = relative => readFileSync(new URL(`../extension/src/${relative}`, import.meta.url), "utf8");
const DEBOUNCE_WAIT_MS = 200;

function makeRuntime(options = {}) {
  const settled = [];
  const rendered = [];
  const store = {
    getCanonicalSnapshot: () => options.canonicals || [{ id: "c1", revision: 2 }, { id: "c2", revision: 1 }],
    settleTranslation: (item, translation) => {
      if (String(item.id) === "unknown") return false;
      settled.push({ id: item.id, revision: item.revision, text: translation.translated_text });
      return true;
    }
  };
  const runtime = {
    comicStreamingEnabled: options.enabled === true,
    kakaoCanonicalPipeline: {
      store,
      renderSettled: reason => {
        rendered.push(reason);
        return Promise.resolve(true);
      }
    },
    getErrorMessage: error => String(error && error.message || error)
  };
  installCanonicalPartialTranslations(runtime);
  return { runtime, settled, rendered };
}

test("漫画流式默认关闭：增量行不结算也不渲染", () => {
  const { runtime, settled, rendered } = makeRuntime({ enabled: false });
  assert.equal(runtime.isComicStreamingEnabled(), false);
  assert.equal(runtime.applyComicPartialTranslations({ rows: [{ id: "c1", translatedText: "你好" }] }), 0);
  assert.deepEqual(settled, []);
  assert.deepEqual(rendered, []);
});

test("开启后按当前 revision 结算增量行并忽略无效行", () => {
  const { runtime, settled } = makeRuntime({ enabled: true });
  const count = runtime.applyComicPartialTranslations({
    rows: [
      { id: "c1", translatedText: "你好" },
      { id: "unknown", translatedText: "不该出现" },
      { id: "c2", translatedText: "   " },
      { id: "c2", translatedText: "世界" }
    ]
  });

  assert.equal(count, 2);
  assert.deepEqual(settled, [
    { id: "c1", revision: 2, text: "你好" },
    { id: "c2", revision: 1, text: "世界" }
  ]);
});

test("同一去抖窗口内的多次增量只渲染一次", async () => {
  const { runtime, rendered } = makeRuntime({ enabled: true });
  runtime.applyComicPartialTranslations({ rows: [{ id: "c1", translatedText: "一" }] });
  runtime.applyComicPartialTranslations({ rows: [{ id: "c2", translatedText: "二" }] });
  assert.deepEqual(rendered, [], "去抖期间不应该已经渲染");

  await new Promise(resolve => setTimeout(resolve, DEBOUNCE_WAIT_MS));

  assert.deepEqual(rendered, ["partial-translation"]);
});

test("管线与消息通道把漫画增量行接了起来", () => {
  assert.match(source("canonical/canonical-pipeline-factory/canonical-translate.js"), /taskId: runId/u);
  assert.match(source("canonical/canonical-pipeline-factory/canonical-render.js"), /renderSettled: scope\.renderSettledTranslations/u);
  const pipeline = source("background/modules/ocr-pipeline.js");
  assert.match(pipeline, /const partialType = mode === "webpage" \? "WEBPAGE_TRANSLATION_PARTIAL" : "COMIC_TRANSLATION_PARTIAL";/u);
  assert.match(pipeline, /mode === "webpage" \|\| mode === "comic" && !!taskId/u);
  assert.match(source("content/modules/reader-init.js"), /message\.type === "COMIC_TRANSLATION_PARTIAL"[\s\S]*applyComicPartialTranslations/u);
});
