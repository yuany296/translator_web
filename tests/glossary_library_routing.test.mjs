import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "test", "background.iife.js"), "utf8");
const CHAPTER_URL = "https://page.kakao.com/content/69299983/viewer/69333586/";
const OVERVIEW_URL = "https://page.kakao.com/content/69299983/";
const listeners = { addListener() {} };
const context = vm.createContext({
  chrome: {
    runtime: { onInstalled: listeners, onStartup: listeners, onMessage: listeners },
    tabs: {},
    storage: { local: {} }
  },
  console,
  fetch,
  URL,
  Blob,
  AbortController,
  atob,
  crypto: webcrypto,
  setTimeout,
  clearTimeout
});
vm.runInContext(`${source}\nglobalThis.__backgroundTest = MtBackgroundModule.backgroundRuntime;`, context, {
  filename: "background.iife.js"
});
const background = context.__backgroundTest;

function installStorage(initial = {}) {
  const stored = JSON.parse(JSON.stringify(initial));
  context.chrome.storage.local.get = (keys, callback) => {
    const list = Array.isArray(keys) ? keys : [keys];
    callback(Object.fromEntries(list.map(key => [key, stored[key]])));
  };
  context.chrome.storage.local.set = (value, callback) => {
    Object.assign(stored, JSON.parse(JSON.stringify(value)));
    callback();
  };
  return stored;
}

function novelGlossary() {
  return {
    version: 4,
    revision: 1,
    libraries: [
      { id: "default", name: "默认术语库", enabled: true, urls: [] },
      { id: "kakao-novel", name: "骸骨皇女", enabled: true, urls: ["https://page.kakao.com/content/69299983"] }
    ],
    entries: []
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function stubExtractor(candidates) {
  background.requestTermExtractorJson = async () => ({ ok: true, engine: "heuristic", candidates });
}

const blocks = [{ id: "b1", originalText: "성현이 말했다", translatedText: "成贤说道" }];

test("discovery routes candidates into the library bound to the page URL", async () => {
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:8765" } }
  });
  stubExtractor([{ source: "성현", kind: "person", score: 0.9, evidenceIds: ["b1"] }]);

  const response = await background.handleDiscoverTerms({
    type: "DISCOVER_TERMS", pageUrl: CHAPTER_URL, pageTitle: "第 12 话", targetKey: "image-1", blocks
  });

  assert.equal(response.ok, true);
  assert.equal(response.libraryId, "kakao-novel");
  const chapter = stored.mt_glossary_pending_v1.chapters[0];
  assert.equal(chapter.libraryId, "kakao-novel");
  assert.equal(chapter.libraryManual, false);
  assert.equal(chapter.candidates[0].source, "성현");
});

test("a disabled library stops capturing terms and falls back to the default library", async () => {
  const glossary = novelGlossary();
  glossary.libraries[1].enabled = false;
  const stored = installStorage({
    mt_glossary_v2: glossary,
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:8765" } }
  });
  stubExtractor([{ source: "성현", kind: "person", score: 0.9, evidenceIds: ["b1"] }]);

  const response = await background.handleDiscoverTerms({
    type: "DISCOVER_TERMS", pageUrl: `${CHAPTER_URL}?case=disabled`, targetKey: "image-1", blocks
  });

  assert.equal(response.libraryId, "");
  assert.equal(stored.mt_glossary_pending_v1.chapters[0].libraryId, "");
});

test("confirming a candidate stores it in the chapter library", async () => {
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:1" } },
    mt_glossary_pending_v1: {
      chapters: [{
        key: CHAPTER_URL, url: CHAPTER_URL, title: "第 12 话", libraryId: "kakao-novel",
        candidates: [{ source: "성현", kind: "person", score: 0.9 }]
      }]
    }
  });

  const confirmed = await background.handleConfirmTermCandidates({
    entries: [{ chapterKey: CHAPTER_URL, candidateSource: "성현", source: "성현", target: "成贤" }]
  });

  assert.equal(confirmed.ok, true, JSON.stringify(plain(confirmed)));
  assert.deepEqual(plain(confirmed.libraryIds), ["kakao-novel"]);
  assert.equal(confirmed.serverSynced, false);
  const entry = stored.mt_glossary_v2.entries[0];
  assert.equal(entry.libraryId, "kakao-novel");
  assert.equal(entry.target, "成贤");
  assert.equal(stored.mt_glossary_pending_v1.chapters.length, 0);
});

test("a manually assigned chapter library wins over the URL match on confirm", async () => {
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:1" } },
    mt_glossary_pending_v1: {
      chapters: [{
        key: CHAPTER_URL, url: CHAPTER_URL, title: "第 12 话", libraryId: "kakao-novel",
        candidates: [{ source: "성현", kind: "person", score: 0.9 }]
      }]
    }
  });

  const reassigned = await background.handleSetPendingChapterLibrary({
    chapterKey: CHAPTER_URL, libraryId: "default"
  });
  assert.equal(reassigned.ok, true);
  assert.equal(reassigned.pending.chapters[0].libraryManual, true);
  assert.equal(reassigned.pending.chapters[0].libraryId, "default");

  const confirmed = await background.handleConfirmTermCandidates({
    entries: [{ chapterKey: CHAPTER_URL, candidateSource: "성현", source: "성현", target: "成贤" }]
  });
  assert.equal(confirmed.ok, true);
  assert.deepEqual(plain(confirmed.libraryIds), ["default"]);
  assert.equal(stored.mt_glossary_v2.entries[0].libraryId, "default");
});

test("an explicit chapter library is not overwritten by a later URL match", async () => {
  const manualUrl = `${CHAPTER_URL}?case=manual`;
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:8765" } },
    mt_glossary_pending_v1: {
      chapters: [{
        key: manualUrl, url: manualUrl, title: "第 12 话",
        libraryId: "default", libraryManual: true, candidates: []
      }]
    }
  });
  stubExtractor([{ source: "성현", kind: "person", score: 0.9, evidenceIds: ["b-manual"] }]);

  await background.handleDiscoverTerms({
    type: "DISCOVER_TERMS",
    pageUrl: manualUrl,
    targetKey: "image-2",
    blocks: [{ id: "b-manual", originalText: "성현이 말했다", translatedText: "成贤说道" }]
  });

  const chapter = stored.mt_glossary_pending_v1.chapters[0];
  assert.equal(chapter.libraryId, "default");
  assert.equal(chapter.libraryManual, true);
  assert.equal(chapter.candidates.length, 1);
});

test("term discovery state exposes library definitions to the panel", async () => {
  installStorage({ mt_glossary_v2: novelGlossary() });

  const state = await background.handleGetTermDiscoveryState({});

  assert.deepEqual(plain(state.libraries).map(library => library.id), ["default", "kakao-novel"]);
  assert.deepEqual(plain(state.libraries)[1].urls, ["https://page.kakao.com/content/69299983"]);
  assert.equal(state.libraries[1].name, "骸骨皇女");
  assert.equal(OVERVIEW_URL.startsWith(state.libraries[1].urls[0]), true);
});
