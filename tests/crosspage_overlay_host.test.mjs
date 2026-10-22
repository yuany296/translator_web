import assert from "node:assert/strict";
import test from "node:test";
import { installRendererCrossPage } from "../extension/src/content/modules/renderer-crosspage.js";

/**
 * 覆盖层宿主解析（findCrossPageOverlayHost）的回归钉子。
 *
 * 现场：Lezhin 阅读页上覆盖层与 loading 卡突然全部不可见。实测根因是宿主
 * 被解析进了推荐位轮播容器（`carousel` overflow:hidden）内部 —— 旧实现只比较
 * **前两个**目标的共同祖先，而目标顺序是 overlaysById 的插入顺序，一对"碰巧
 * 同属小盒子"的缩略图就决定了整套覆盖层的宿主，之后所有内容都被裁掉。
 * 这里把「宿主必须包含全体目标、且与顺序无关」钉住。
 */

/** 极简节点：只需要 parentElement / contains，足以驱动宿主解析。 */
function makeNode(name, style = {}) {
  const el = {
    name,
    parentElement: null,
    children: [],
    __style: Object.assign({ overflow: "visible", overflowX: "visible", overflowY: "visible", clipPath: "none", contain: "" }, style),
    contains(other) {
      for (let current = other; current; current = current.parentElement) {
        if (current === el) return true;
      }
      return false;
    }
  };
  return el;
}

function attach(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

globalThis.getComputedStyle = node => (node && node.__style) || { overflow: "visible", overflowX: "visible", overflowY: "visible", clipPath: "none", contain: "" };

function installHostResolver() {
  const runtime = { state: {} };
  installRendererCrossPage(runtime);
  return runtime.findCrossPageOverlayHost;
}

/** Lezhin 形状：正文页与推荐位轮播同处一个不裁剪的内容容器下。 */
function buildLezhinLikeTree() {
  const body = makeNode("body");
  const main = attach(body, makeNode("main"));
  const content = attach(main, makeNode("content"));
  const pagesBox = attach(content, makeNode("pages"));
  const pageA = attach(pagesBox, makeNode("img-a"));
  const pageB = attach(pagesBox, makeNode("img-b"));
  const carousel = attach(content, makeNode("carousel", { overflow: "hidden" }));
  const carouselFlex = attach(carousel, makeNode("carousel-flex"));
  const thumbC = attach(carouselFlex, makeNode("img-thumb-c"));
  const thumbD = attach(carouselFlex, makeNode("img-thumb-d"));
  return { body, main, content, pagesBox, pageA, pageB, carousel, carouselFlex, thumbC, thumbD };
}

test("宿主是全体目标的最深共同祖先，而不是「前两个目标」的小盒子", () => {
  const findHost = installHostResolver();
  const { content, carouselFlex, pageA, pageB, thumbC, thumbD } = buildLezhinLikeTree();
  // 旧实现只看前两个：这里是两个轮播缩略图 → 宿主落进 carousel 内部（被裁掉）。
  const host = findHost([thumbC, thumbD, pageA, pageB]);
  assert.notEqual(host, carouselFlex);
  for (const target of [thumbC, thumbD, pageA, pageB]) {
    assert.ok(host.contains(target), `宿主必须包含目标 ${target.name}`);
  }
  assert.equal(host, content);
});

test("宿主解析与目标顺序无关", () => {
  const findHost = installHostResolver();
  const { content, pageA, pageB, thumbC, thumbD } = buildLezhinLikeTree();
  const orders = [
    [thumbC, thumbD, pageA, pageB],
    [pageA, pageB, thumbC, thumbD],
    [pageB, thumbD, pageA, thumbC],
    [thumbD, pageB, thumbC, pageA]
  ];
  for (const order of orders) {
    assert.equal(findHost(order), content, `顺序 ${order.map(item => item.name).join(",")}`);
  }
});

test("共同祖先自身裁剪时继续向上找，不把宿主留在裁剪盒里", () => {
  const findHost = installHostResolver();
  const outer = makeNode("outer");
  const clipping = attach(outer, makeNode("clipping", { overflow: "hidden" }));
  const left = attach(clipping, makeNode("left"));
  const right = attach(clipping, makeNode("right"));
  assert.equal(findHost([left, right]), outer);
});

test("单个目标退化为它的父节点（保持既有行为）", () => {
  const findHost = installHostResolver();
  const parent = makeNode("parent");
  const only = attach(parent, makeNode("only"));
  assert.equal(findHost([only]), parent);
});
