/**
 * Per-Text-node translation state for webpage translation.
 *
 * Text nodes have no dataset and wrapping them in spans would break layout,
 * CSS selectors, hydration and text selection — so node state lives in a
 * WeakMap keyed by the Text node itself, with a Set of currently-managed
 * nodes for iteration. Decision helpers are pure predicates so the restore /
 * apply guards are unit-testable without a DOM.
 */

/**
 * Removes disconnected nodes from the managed set. The WeakMap entries die
 * with the nodes themselves; this keeps the Set (which strongly references
 * nodes) from growing on dynamic pages. Idempotent.
 */
export function pruneDisconnectedNodes(activeNodes, nodeStates) {
  if (!activeNodes || !nodeStates) return 0;
  let pruned = 0;
  for (const node of [...activeNodes]) {
    if (!node || node.isConnected !== true) {
      nodeStates.delete(node);
      activeNodes.delete(node);
      pruned += 1;
    }
  }
  return pruned;
}

export function createWebpageNodeStateStore() {
  const nodeStates = new WeakMap();
  const activeNodes = new Set();

  return {
    nodeStates,
    activeNodes,
    set(node, state) {
      nodeStates.set(node, state);
      activeNodes.add(node);
    },
    get(node) {
      return nodeStates.get(node);
    },
    release(node) {
      nodeStates.delete(node);
      activeNodes.delete(node);
    },
    prune() {
      return pruneDisconnectedNodes(activeNodes, nodeStates);
    },
    clear() {
      activeNodes.clear();
    },
    get size() {
      return activeNodes.size;
    },
    forEach(fn) {
      for (const node of activeNodes) fn(node, nodeStates.get(node));
    }
  };
}

/**
 * True when a managed node's current value is neither the original text nor
 * the translation the plugin wrote — i.e. the page itself changed the node.
 * Such nodes must be released and re-scanned as fresh source text.
 */
export function isNodeModifiedByPage(entry, currentValue) {
  if (!entry) return false;
  return currentValue !== entry.originalText && currentValue !== entry.translatedText;
}

/**
 * Guard before applying an async translation result to a node. Every
 * condition must hold, otherwise the node keeps its current content.
 */
export function shouldApplyTranslation(snapshot) {
  if (snapshot.isConnected !== true) return false;
  // 节点原文可能带首尾空白（"로그인 "），与 trim 后的 sourceText 比较前先归一化
  if (String(snapshot.currentValue || "").trim() !== String(snapshot.sourceText || "").trim()) return false;
  if (snapshot.generation !== snapshot.currentGeneration) return false;
  if (snapshot.pageKey !== snapshot.currentPageKey) return false;
  if (snapshot.wantsTranslation !== true) return false;
  return true;
}

/**
 * Guard before restoring a node's original text: only overwrite when the
 * node still shows exactly what the plugin wrote. If the page updated the
 * node meanwhile, the caller must release the record and keep the new text.
 */
export function shouldRestoreNode(snapshot) {
  return snapshot.isConnected === true && snapshot.currentValue === snapshot.translatedText;
}
