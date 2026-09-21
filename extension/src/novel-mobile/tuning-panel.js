/**
 * 手机版设置页：可调的「翻译速度」卡片。
 *
 * 并发与每块字数以前是写死的常量，手机上根本改不了 —— 但服务商限流、模型快慢、
 * 小说段落长短因人而异，这两个数只能让用户自己试出来（含义见 novel-tuning.js）。
 *
 * 卡片是运行时**注入**的，不改公共的 settings.html：桌面版设置页不会多出这一块。
 * 保存后写 chrome.storage.local，内容脚本每次开始翻译时读一次 —— 改完下一次翻译即生效，
 * 不用重开标签页，也不用重新加载扩展。
 */
import { injectNovelMobileStyles } from "./styles.js";
import {
  DEFAULT_TUNING, TUNING_KEY, TUNING_LIMITS, describeTuning, normalizeTuning
} from "./novel-tuning.js";

export const TUNING_CARD_ID = "mtNovelTuningCard";

function readStored(storage) {
  return new Promise(resolve => {
    try {
      storage.get([TUNING_KEY], result => resolve(result || {}));
    } catch (error) {
      resolve({});
    }
  });
}

function writeStored(storage, value) {
  return new Promise((resolve, reject) => {
    try {
      storage.set(value, () => {
        const failure = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError;
        if (failure) reject(new Error(failure.message || String(failure)));
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function numberField(doc, id, labelText, value, limit) {
  const label = doc.createElement("label");
  const input = doc.createElement("input");
  input.type = "number";
  input.id = id;
  input.value = String(value);
  input.min = String(limit.min);
  input.max = String(limit.max);
  input.step = String(limit.step);
  label.append(doc.createTextNode(labelText), input);
  return { label, input };
}

export function buildTuningCard(doc) {
  const card = doc.createElement("article");
  card.className = "setting-card";
  card.id = TUNING_CARD_ID;
  const title = doc.createElement("div");
  title.className = "card-title";
  const heading = doc.createElement("div");
  const h2 = doc.createElement("h2");
  h2.textContent = "翻译速度";
  const note = doc.createElement("p");
  note.textContent = "并发越高越容易一轮发完，但更容易被服务商限流；每块字数越小回来越快，"
    + "但块数更多、每块的固定开销也要重付一遍。改完下一次翻译生效。";
  heading.append(h2, note);
  title.append(heading);
  const grid = doc.createElement("div");
  grid.className = "form-grid two";
  const concurrency = numberField(doc, "mtNovelConcurrency", "并发请求数", DEFAULT_TUNING.concurrency,
    TUNING_LIMITS.concurrency);
  const chunkChars = numberField(doc, "mtNovelChunkChars", "每块字数", DEFAULT_TUNING.chunkChars,
    TUNING_LIMITS.chunkChars);
  const repairs = numberField(doc, "mtNovelRepairParagraphs", "修正每批段数",
    DEFAULT_TUNING.repairParagraphs, TUNING_LIMITS.repairParagraphs);
  grid.append(concurrency.label, chunkChars.label, repairs.label);
  const hint = doc.createElement("small");
  hint.id = "mtNovelTuningHint";
  const actions = doc.createElement("div");
  actions.className = "panel-actions";
  const save = doc.createElement("button");
  save.type = "button";
  save.id = "mtNovelTuningSave";
  save.className = "primary";
  save.textContent = "保存速度设置";
  const reset = doc.createElement("button");
  reset.type = "button";
  reset.id = "mtNovelTuningReset";
  reset.textContent = "恢复默认";
  const status = doc.createElement("span");
  status.id = "mtNovelTuningStatus";
  status.className = "inline-status";
  actions.append(save, reset, status);
  card.append(title, grid, hint, actions);
  return {
    card,
    inputs: { concurrency: concurrency.input, chunkChars: chunkChars.input, repairParagraphs: repairs.input },
    hint,
    save,
    reset,
    status
  };
}

export function readTuningInputs(inputs) {
  return normalizeTuning({
    concurrency: inputs.concurrency.value,
    chunkChars: inputs.chunkChars.value,
    repairParagraphs: inputs.repairParagraphs.value
  });
}

export function applyTuningToInputs(inputs, tuning) {
  const value = normalizeTuning(tuning);
  inputs.concurrency.value = String(value.concurrency);
  inputs.chunkChars.value = String(value.chunkChars);
  inputs.repairParagraphs.value = String(value.repairParagraphs);
  return value;
}

/** 注入卡片并接线；设置页里没有「常规」面板时安静跳过（例如术语库单独的 iframe）。 */
export function installTuningPanel(doc = globalThis.document, storage = globalThis.chrome && chrome.storage.local) {
  if (!storage) return null;
  const panel = doc.querySelector('[data-panel="general"]');
  if (!panel || doc.getElementById(TUNING_CARD_ID)) return null;
  injectNovelMobileStyles(doc);
  const ui = buildTuningCard(doc);
  const persist = async tuning => {
    // 收敛后的值写回输入框：填 99 会被夹到 10，输入框里也要显示 10，否则用户以为存了 99
    const saved = applyTuningToInputs(ui.inputs, tuning);
    await writeStored(storage, { [TUNING_KEY]: saved });
    ui.hint.textContent = describeTuning(saved);
    ui.status.textContent = `已保存（并发 ${saved.concurrency} · 每块 ${saved.chunkChars} 字），下一次翻译生效`;
  };
  ui.save.addEventListener("click", () => {
    void persist(readTuningInputs(ui.inputs)).catch(error => {
      ui.status.textContent = `保存失败：${error && error.message || error}`;
    });
  });
  ui.reset.addEventListener("click", () => {
    void persist(applyTuningToInputs(ui.inputs, DEFAULT_TUNING)).catch(error => {
      ui.status.textContent = `保存失败：${error && error.message || error}`;
    });
  });
  // 插在「保存常规设置」那一行之前，保持设置页的既有节奏
  const actions = doc.querySelector('[data-panel="general"] .panel-actions');
  if (actions && typeof actions.before === "function") actions.before(ui.card);
  else panel.append(ui.card);
  void readStored(storage).then(result => {
    const tuning = applyTuningToInputs(ui.inputs, result[TUNING_KEY]);
    ui.hint.textContent = describeTuning(tuning);
  });
  return ui;
}
