/**
 * 页面覆盖层的挂载宿主与图层（与跨页接缝层同一个思路）。
 *
 * 覆盖层挂进阅读器内容容器后，容器滚动时原图和覆盖层由浏览器合成线程一起移动，
 * 不再需要逐帧 rAF 追赶；fixed 层只能被 JS 拖着走，就是用户看到的「拖拽感」。
 * 每个宿主一个图层：同一页面里不同分片容器不会互相抢同一个图层（抢图层会让
 * 另一片的覆盖层坐标系漂掉，看起来又是一层在追）。
 */
export function installOverlayHost(runtime) {
  function state() {
    if (!(runtime.state.overlayLayersByHost instanceof WeakMap)) {
      runtime.state.overlayLayersByHost = new WeakMap();
    }
    if (!(runtime.state.overlayLayers instanceof Set)) {
      runtime.state.overlayLayers = new Set();
    }
    return runtime.state;
  }
  runtime.overlayLayerState = state;
  function isOverlayScrollHost(node) {
    if (!node || typeof getComputedStyle !== "function") {
      return false;
    }
    const style = getComputedStyle(node);
    // hidden 也算：RIDI 的文字层窗口是 overflow:hidden 但可滚动的盒子。
    const scrollValues = /(auto|scroll|overlay|hidden)/u;
    const scrolls = scrollValues.test(String(style.overflowY || "").toLowerCase()) ||
      scrollValues.test(String(style.overflowX || "").toLowerCase());
    if (!scrolls) {
      return false;
    }
    return node.scrollHeight > node.clientHeight + 4 || node.scrollWidth > node.clientWidth + 4;
  }
  runtime.isOverlayScrollHost = isOverlayScrollHost;
  function liveTargets() {
    const scope = state();
    const targets = [];
    scope.overlaysById?.forEach?.(overlayState => {
      if (overlayState && overlayState.target) targets.push(overlayState.target);
    });
    return targets;
  }
  function hostContainsEvery(host, targets) {
    if (!host || targets.length === 0 || typeof host.getBoundingClientRect !== "function") return false;
    const rect = host.getBoundingClientRect();
    return targets.every(target => {
      const targetRect = target.getBoundingClientRect();
      return targetRect.top >= rect.top - 1 && targetRect.bottom <= rect.bottom + 1 &&
        targetRect.left >= rect.left - 1 && targetRect.right <= rect.right + 1;
    });
  }
  runtime.overlayHostContainsEvery = hostContainsEvery;
  function isDocumentHost(node) {
    return !node || node === document.documentElement || node === document.body;
  }
  runtime.isOverlayDocumentHost = isDocumentHost;
  /** 全体目标共享的、最深的那层祖先（第一个能包含所有目标的祖先节点）。 */
  function deepestSharedAncestor(values) {
    if (values.length === 0) return null;
    for (let node = values[0].parentElement; node; node = node.parentElement) {
      if (values.every(value => node.contains(value))) return node;
    }
    return null;
  }
  runtime.deepestSharedAncestor = deepestSharedAncestor;
  /** 共享祖先链上第一个「真的在滚动」的容器：覆盖层与原文共享滚动上下文。 */
  function findSharedScrollHost(values) {
    for (let node = deepestSharedAncestor(values); node; node = node.parentElement) {
      if (isOverlayScrollHost(node)) return node;
    }
    return null;
  }
  runtime.findSharedScrollHost = findSharedScrollHost;
  function resolveOverlayHost(target) {
    // 与跨页（接缝）层同一套宿主选择：不裁剪的内容级祖先。
    // 关键是用"当前所有目标"求共同祖先，而不是单个目标的直接父节点 —— 单个目标会拿到
    // 分片自己的小盒子（每片一个图层、还会把别的分片的覆盖层挤到盒子外，撑大滚动区域、
    // 多出一条滚动条）。取全体目标就落到整条内容容器上，和接缝层是同一个宿主。
    const targets = [...new Set([...liveTargets(), target].filter(Boolean))];
    if (targets.length > 0 && typeof runtime.findCrossPageOverlayHost === "function") {
      const shared = runtime.findCrossPageOverlayHost(targets);
      // 共同祖先可能一路退到 documentElement（目标分散在不同子树时）——它**不能**当宿主：
      // 那层不随阅读器内容滚动，覆盖层每帧都得靠 rAF 追上去（用户看到的「被拖开再追回来」），
      // 而且覆盖层在窗口坐标下的正坐标会把 document 的滚动区撑大（多出一条滚动条）。
      if (shared && !isDocumentHost(shared)) {
        return shared;
      }
    }
    // 退回「全体目标共享的、真正可滚动的祖先」：与原文同一个滚动上下文，
    // 滚动时图层和原文由浏览器一起移动，坐标只在滚动前后同步一次。
    const scrollHost = findSharedScrollHost(targets.length > 0 ? targets : [target].filter(Boolean));
    if (scrollHost) {
      return scrollHost;
    }
    let node = target && target.parentElement;
    while (node && node !== document.documentElement) {
      if (isOverlayScrollHost(node)) {
        return node;
      }
      node = node.parentElement;
    }
    return document.documentElement;
  }
  runtime.resolveOverlayHost = resolveOverlayHost;
  function ensureHostPosition(host) {
    if (!host || host === document.documentElement || typeof getComputedStyle !== "function" || !host.style) {
      return;
    }
    const position = getComputedStyle(host).position;
    if (!position || position === "static") {
      host.style.position = "relative";
    }
  }
  /** 宿主换了以后，旧图层会空置：空壳必须立刻清掉，否则它会一直挂在 document 上。 */
  function pruneEmptyLayers(keep) {
    const scope = state();
    for (const layer of [...scope.overlayLayers]) {
      if (layer === keep) continue;
      if (!layer || !layer.isConnected) {
        scope.overlayLayers.delete(layer);
        continue;
      }
      if (layer.childElementCount > 0) continue;
      layer.remove();
      scope.overlayLayers.delete(layer);
    }
    if (scope.overlayLayer && !scope.overlayLayer.isConnected) {
      scope.overlayLayer = null;
    }
    if (!scope.overlayLayer && keep) {
      scope.overlayLayer = keep;
    }
    // 首选图层已经空了（覆盖层都迁到别的宿主）时，把引用切到真正还在用的那一层。
    if (scope.overlayLayer && scope.overlayLayer !== keep && scope.overlayLayer.childElementCount === 0) {
      scope.overlayLayer = keep || null;
    }
  }
  runtime.pruneEmptyOverlayLayers = pruneEmptyLayers;
  function createLayerForHost(host) {
    const scope = state();
    const layer = document.createElement("div");
    layer.className = "mt-overlay-layer";
    layer.dataset.mangaTranslatorOverlay = "true";
    host.appendChild(layer);
    // 宿主内容盒能装下所有目标时才允许裁剪：绝对定位的后代本来会把滚动容器的
    // 滚动区域撑大（多出一条滚动条），裁剪把贡献限制在内容盒内。容器装不下所有目标时
    // 不裁，宁可不管滚动条也不能把覆盖层切掉。
    if (host !== document.documentElement && hostContainsEvery(host, liveTargets())) {
      layer.style.overflow = "clip";
    }
    scope.overlayLayersByHost.set(host, layer);
    scope.overlayLayers.add(layer);
    // 图层按宿主缓存，所以宿主一旦变好（例如整章内容加载完才出现真正的滚动容器），
    // 旧的空壳必须让位：state.overlayLayer 留着它会让「截图前隐藏覆盖层」藏错对象。
    pruneEmptyLayers(layer);
    if (!scope.overlayLayer || !scope.overlayLayer.isConnected) {
      scope.overlayLayer = layer;
    }
    return layer;
  }
  runtime.createOverlayLayerForHost = createLayerForHost;
  function ensureOverlayLayerOnHost(target = null) {
    const scope = state();
    const host = resolveOverlayHost(target);
    const known = host ? scope.overlayLayersByHost.get(host) : null;
    if (known && known.isConnected) {
      // 每次都顺手清一遍空置图层：覆盖层都搬到更合适的宿主之后，原来挂在
      // documentElement 上的空壳必须消失，否则 state.overlayLayer 会一直指着它。
      pruneEmptyLayers(known);
      return known;
    }
    ensureHostPosition(host);
    return createLayerForHost(host);
  }
  runtime.ensureOverlayLayerOnHost = ensureOverlayLayerOnHost;
  function overlayLayerFor(target) {
    return ensureOverlayLayerOnHost(target);
  }
  runtime.overlayLayerFor = overlayLayerFor;
  function forEachOverlayLayer(callback) {
    const scope = state();
    for (const layer of [...scope.overlayLayers]) {
      if (!layer || !layer.isConnected) {
        scope.overlayLayers.delete(layer);
        continue;
      }
      callback(layer);
    }
  }
  runtime.forEachOverlayLayer = forEachOverlayLayer;
}
