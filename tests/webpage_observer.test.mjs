import assert from "node:assert/strict";
import test from "node:test";

import {
  hasWebpagePageMutation, isExtensionWebpageMutation
} from "../extension/src/content/modules/webpage-observer.js";

function element(extensionOwned = false) {
  return {
    nodeType: 1,
    closest(selector) {
      if (!extensionOwned) return null;
      assert.match(selector, /mt-webpage-progress-panel/);
      assert.match(selector, /data-manga-translator-overlay/);
      return this;
    }
  };
}

function textNode(parentElement) {
  return { nodeType: 3, parentElement };
}

test("progress, tooltip and bilingual renderer mutations are extension-owned", () => {
  assert.equal(isExtensionWebpageMutation(element(true)), true);
  assert.equal(isExtensionWebpageMutation(textNode(element(true))), true);
  assert.equal(isExtensionWebpageMutation(element(false)), false);
});

test("extension progress updates do not schedule another webpage translation", () => {
  const state = { nodeStore: { activeNodes: new Set() } };
  const extensionChild = element(true);
  assert.equal(hasWebpagePageMutation([
    { type: "childList", addedNodes: [extensionChild] }
  ], state), false);

  const extensionText = textNode(element(true));
  assert.equal(hasWebpagePageMutation([
    { type: "characterData", target: extensionText }
  ], state), false);
});

test("real page additions still trigger and managed text replacements do not", () => {
  const managed = textNode(element(false));
  const state = { nodeStore: { activeNodes: new Set([managed]) } };
  assert.equal(hasWebpagePageMutation([
    { type: "characterData", target: managed }
  ], state), false);
  assert.equal(hasWebpagePageMutation([
    { type: "childList", addedNodes: [element(false)] }
  ], state), true);
  assert.equal(hasWebpagePageMutation([
    { type: "characterData", target: textNode(element(false)) }
  ], state), true);
});

import {
  collectWebpageMutatedEntries
} from "../extension/src/content/modules/webpage-observer.js";

function fakeWalker(nodes) {
  let index = 0;
  return {
    nextNode() {
      return index < nodes.length ? nodes[index++] : null;
    }
  };
}

function fakeDoc(nodesByRoot) {
  const walkers = new Map();
  return {
    createTreeWalker(root, filter, acceptNode) {
      const nodes = walkers.get(root) || [];
      return fakeWalker(nodes);
    },
    registerSubtree(root, nodes) {
      walkers.set(root, nodes);
    }
  };
}

function fakeText(name, value, parent = null) {
  return {
    nodeType: 3, name, nodeValue: value,
    parentElement: parent || { closest: () => null, tagName: "P" }
  };
}

function fakeElement(name, parent = null) {
  return {
    nodeType: 1, name, parentElement: parent || { closest: () => null, tagName: "DIV" },
    closest(selector) {
      if (name === "ext") return this;
      return null;
    }
  };
}

const eligibleState = () => ({ nodeStore: { activeNodes: new Set() } });

test("added subtree mutations collect only text nodes inside the added root", () => {
  const doc = fakeDoc();
  const container = fakeElement("container");
  const text1 = fakeText("t1", "한국어 문장");
  const text2 = fakeText("t2", "영어 sentence");
  doc.registerSubtree(container, [text1, text2]);
  const entries = collectWebpageMutatedEntries(
    [{ type: "childList", addedNodes: [container] }], eligibleState(), doc
  );
  assert.deepEqual(entries.map(entry => entry.node), [text1, text2]);
});

test("characterData on a page-rewritten text node is collected as new source", () => {
  const node = fakeText("t", "웹 페이지에서 다시 쓴 문장");
  const entries = collectWebpageMutatedEntries(
    [{ type: "characterData", target: node }], eligibleState(), fakeDoc()
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "웹 페이지에서 다시 쓴 문장");
});

test("managed and extension-owned nodes never enter the mutated entries", () => {
  const doc = fakeDoc();
  const managed = fakeText("m", "已管理文本");
  const state = { nodeStore: { activeNodes: new Set([managed]) } };
  const ext = fakeElement("ext");
  doc.registerSubtree(ext, [fakeText("e1", "扩展自己渲染的文本")]);
  const entries = collectWebpageMutatedEntries([
    { type: "characterData", target: managed },
    { type: "childList", addedNodes: [ext] }
  ], state, doc);
  assert.equal(entries.length, 0, "观察器不循环自己的渲染");
});

test("empty or punctuation-only added text is skipped by eligibility", () => {
  const doc = fakeDoc();
  const container = fakeElement("container");
  doc.registerSubtree(container, [
    fakeText("punct", "→"), fakeText("empty", "   "), fakeText("real", "안녕하세요")
  ]);
  const entries = collectWebpageMutatedEntries(
    [{ type: "childList", addedNodes: [container] }], eligibleState(), doc
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "안녕하세요");
});

test("mutated collection caps at MAX_MUTATED_ENTRIES", () => {
  const doc = fakeDoc();
  const container = fakeElement("big");
  const many = [];
  for (let i = 0; i < 500; i += 1) many.push(fakeText(`t${i}`, `문장 ${i}`));
  doc.registerSubtree(container, many);
  const entries = collectWebpageMutatedEntries(
    [{ type: "childList", addedNodes: [container] }], eligibleState(), doc
  );
  assert.equal(entries.length, 400);
});
