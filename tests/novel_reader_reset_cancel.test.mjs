import assert from "node:assert/strict";
import test from "node:test";

import { installNovelReader } from "../extension/src/content/modules/novel-reader.js";

// ---------- 夹具 ----------

class FakeObserver {
  observe() {}

  disconnect() {}
}

function makeParagraph(pid, text) {
  return {
    tagName: "P",
    isConnected: true,
    _attrs: { "data-p-id": String(pid) },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
    },
    querySelector() {
      return null;
    },
    get textContent() {
      return text;
    }
  };
}

function makeRuntime() {
  const paragraphs = [makeParagraph(0, "첫 문단입니다"), makeParagraph(1, "둘째 문단입니다")];
  // Kakao 小说正文在 shadow root 里（findNovelSurface 要求 host.shadowRoot）
  const shadowRoot = {
    querySelectorAll: selector => (String(selector) === "[data-p-id]" ? paragraphs : [])
  };
  const viewer = {
    isConnected: true,
    shadowRoot,
    querySelectorAll: () => []
  };
  globalThis.MutationObserver = FakeObserver;
  globalThis.location = { href: "https://page.kakao.com/content/1/viewer/100/" };
  globalThis.document = {
    title: "내가 죽인 최애와 데뷔합니다 58화",
    querySelector: () => viewer,
    querySelectorAll: () => [viewer]
  };
  const cancelled = [];
  const messages = [];
  let chapterId = "100";
  const runtime = {
    state: {},
    IS_KAKAOPAGE_READER: true,
    novelCore: {
      parseKakaoNovelLocation: () => ({
        scopeKey: "book", seriesId: "series", chapterId, chapterTitle: "내가 죽인 최애와 데뷔합니다 58화"
      })
    },
    normalizeTranslationCacheText: value => String(value || "").replace(/\s+/gu, " ").trim(),
    computeTranslationCacheHash: value => `h${String(value || "").length}`,
    updateFloatingBallState: () => {},
    cancelNovelTranslationStream: taskId => cancelled.push(taskId),
    sendRuntimeMessage: message => {
      messages.push(message);
      return Promise.resolve({ ok: true });
    }
  };
  installNovelReader(runtime);
  return { runtime, cancelled, messages, setChapterId: value => { chapterId = value; } };
}

// ---------- 用例 ----------

test("换章时取消上一章在途的流式请求，避免它在界面上「隐身」地跑完", () => {
  const harness = makeRuntime();
  const state = harness.runtime.getNovelState();
  state.chapterKey = "book:100";
  state.taskId = "novel-old-task";
  state.textStatus = "working";
  state.translations.set("0@aaaa0001", "旧译文");
  harness.setChapterId("200");

  harness.runtime.reconcileNovelReader();

  assert.deepEqual(harness.cancelled, ["novel-old-task"], "旧任务的内容侧流必须被取消");
  assert.equal(harness.messages.some(message => message.type === "CANCEL_TRANSLATION_TASK"
    && message.taskId === "novel-old-task"), true, "后台任务也要一起取消");
  assert.equal(state.taskId, "", "任务 id 一并清空，下一次点击会开新任务");
  assert.equal(state.textStatus, "idle");
  assert.equal(state.translations.size, 0);
});

test("同一章内的重新渲染不会误取消正在进行的任务", () => {
  const harness = makeRuntime();
  const state = harness.runtime.getNovelState();
  state.chapterKey = "book:100";
  state.taskId = "novel-running";
  state.textStatus = "working";
  harness.runtime.reconcileNovelReader();
  assert.deepEqual(harness.cancelled, [], "没换章就不能取消在途任务");
  assert.equal(state.taskId, "novel-running");
  assert.equal(state.textStatus, "working");
});
