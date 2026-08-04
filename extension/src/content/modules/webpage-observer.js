/**
 * Webpage MutationObserver: watches for newly-added subtrees and page-rewritten
 * text nodes only. Each affected node is handed to the viewport scheduler
 * directly (dynamic far content = P3) — it never re-triggers a whole-page
 * `translateWebpage({onlyNew: true})`. Extension-owned mutations (progress
 * panel, bilingual nodes, tooltips, overlays) are ignored so the observer
 * never loops on its own rendering.
 */
import scanner from "./webpage-scanner.js";

const OBSERVER_DEBOUNCE_MS = 350;
const MAX_MUTATED_ENTRIES = 400;
const EXTENSION_MUTATION_SELECTOR = [
  "[data-manga-translator]", "[data-manga-translator-overlay]",
  "[data-mt-webpage-bilingual]", ".mt-webpage-bilingual-translation",
  ".mt-webpage-progress-panel", ".mt-webpage-translation-tooltip"
].join(", ");

export function isExtensionWebpageMutation(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  return Boolean(element?.closest?.(EXTENSION_MUTATION_SELECTOR));
}

export function hasWebpagePageMutation(mutations, state) {
  return mutations.some(mutation => {
    if (mutation.type === "characterData") {
      return !state.nodeStore.activeNodes.has(mutation.target)
        && !isExtensionWebpageMutation(mutation.target);
    }
    return [...mutation.addedNodes].some(node => !isExtensionWebpageMutation(node));
  });
}

/** Collect eligible text entries from a batch of mutations (added subtrees + rewritten text). */
export function collectWebpageMutatedEntries(mutations, state, doc = null) {
  const docObj = doc || (typeof document !== "undefined" ? document : null);
  const entries = [];
  const seen = new Set();
  const push = (node) => {
    if (seen.has(node) || !node) return;
    const info = { hidden: false, editable: false, inExtensionUi: false };
    if (!scanner.isEligibleWebpageText(node.nodeValue, info)) return;
    seen.add(node);
    entries.push({ node, text: scanner.normalizeCandidateText(node.nodeValue), index: entries.length });
  };
  const walkSubtree = (root) => {
    if (!docObj || typeof docObj.createTreeWalker !== "function") return;
    let walker;
    try {
      walker = docObj.createTreeWalker(root, 4 /* SHOW_TEXT */, null);
    } catch {
      return;
    }
    let node = walker.nextNode();
    while (node && entries.length < MAX_MUTATED_ENTRIES) {
      const parent = node.parentElement;
      if (parent && !state.nodeStore.activeNodes.has(node)) push(node);
      node = walker.nextNode();
    }
  };
  for (const mutation of mutations || []) {
    if (entries.length >= MAX_MUTATED_ENTRIES) break;
    if (mutation.type === "characterData") {
      if (state.nodeStore.activeNodes.has(mutation.target) || isExtensionWebpageMutation(mutation.target)) continue;
      push(mutation.target);
      continue;
    }
    for (const node of mutation.addedNodes || []) {
      if (isExtensionWebpageMutation(node)) continue;
      if (node.nodeType === 3) push(node);
      else if (node.nodeType === 1) walkSubtree(node);
    }
  }
  return entries;
}

export function installWebpageObserver(runtime) {
  let observer = null;
  let timer = 0;
  let pendingMutations = [];

  function scheduleNewContentTranslation(mutations) {
    pendingMutations = pendingMutations.concat(mutations || []).slice(-MAX_MUTATED_ENTRIES * 4);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const state = runtime.getWebpageState();
      const collected = pendingMutations;
      pendingMutations = [];
      if (!state.active || !state.session || !collected.length) return;
      // 只扫描新增子树或被页面改写的节点，直接交给调度器（P3 动态内容）
      const entries = collectWebpageMutatedEntries(collected, state);
      if (!entries.length) return;
      const session = state.session;
      const enriched = runtime.enrichWebpageEntries(entries, session.pageKey);
      await runtime.enqueueWebpageSegments(session, enriched, "background", session.generation, { dynamic: true })
        .catch(() => undefined);
      runtime.reprioritizeWebpageViewport?.();
    }, OBSERVER_DEBOUNCE_MS);
  }

  function activateWebpageObserver() {
    if (observer || typeof MutationObserver !== "function" || !document.documentElement) return;
    observer = new MutationObserver(mutations => {
      if (hasWebpagePageMutation(mutations, runtime.getWebpageState())) {
        scheduleNewContentTranslation(mutations);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  }

  function deactivateWebpageObserver() {
    clearTimeout(timer);
    timer = 0;
    pendingMutations = [];
    observer?.disconnect();
    observer = null;
  }

  runtime.activateWebpageObserver = activateWebpageObserver;
  runtime.deactivateWebpageObserver = deactivateWebpageObserver;
  runtime.scheduleNewWebpageContentTranslation = scheduleNewContentTranslation;
}
