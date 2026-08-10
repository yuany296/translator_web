import assert from "node:assert/strict";
import test from "node:test";
import { installNovelRenderer } from "../extension/src/content/modules/novel-renderer.js";

function createElementStub(tagName) {
  return {
    tagName,
    className: "",
    textContent: "",
    dataset: {},
    style: {},
    classList: {
      toggle() {}
    },
    appendChild() {}
  };
}

function withFakeDocument(run) {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: createElementStub
  };
  try {
    return run();
  } finally {
    globalThis.document = originalDocument;
  }
}

test("injectNovelStyles appends bilingual block rules into a shadow root once", () => {
  withFakeDocument(() => {
    const runtime = {};
    installNovelRenderer(runtime);
    const created = [];
    const root = {
      nodeType: 11,
      appendChild(node) {
        created.push(node);
      }
    };
    runtime.injectNovelStyles(root);
    assert.equal(created.length, 1, "one style element is appended");
    const css = created[0].textContent;
    assert.match(css, /\[data-p-id\] \.mt-novel-source \{ display: contents; \}/);
    assert.match(css, /\[data-p-id\] \.mt-novel-translation \{ white-space: pre-wrap; font: inherit; color: inherit; \}/);
    assert.match(css, /\[data-p-id\] \.mt-novel-source-bilingual \{ display: block; margin-bottom: 0\.42em; \}/);
    assert.match(css, /\[data-p-id\] \.mt-novel-translation\[hidden\] \{ display: none !important; \}/);
    runtime.injectNovelStyles(root);
    assert.equal(created.length, 1, "second injection is a no-op");
  });
});

test("injectNovelStyles skips the main document and non-fragment roots", () => {
  withFakeDocument(() => {
    const runtime = {};
    installNovelRenderer(runtime);
    const created = [];
    const documentRoot = { nodeType: 9, appendChild: node => created.push(node) };
    const elementRoot = { nodeType: 1, appendChild: node => created.push(node) };
    runtime.injectNovelStyles(documentRoot);
    runtime.injectNovelStyles(elementRoot);
    runtime.injectNovelStyles(null);
    assert.equal(created.length, 0, "no style is injected outside a shadow root");
  });
});

test("renderNovelTranslation injects styles into the paragraph's root node", () => {
  withFakeDocument(() => {
    const runtime = { state: { displayMode: "bilingual" } };
    installNovelRenderer(runtime);
    const shadowRoot = { nodeType: 11, appendChild() {} };
    const node = {
      dataset: {},
      style: {},
      firstChild: null,
      querySelector() {
        return null;
      },
      appendChild() {},
      getRootNode() {
        return shadowRoot;
      }
    };
    assert.equal(runtime.renderNovelTranslation(node, "译文"), true);
    assert.equal(shadowRoot.__mtNovelStylesInjected, true,
      "wrapping a paragraph must inject styles into its shadow root");
  });
});
