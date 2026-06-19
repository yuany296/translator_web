// ==UserScript==
// @name         Manga Realtime Translator Mobile (No Backend)
// @namespace    https://example.com/manga-translator-mobile
// @version      1.0.0
// @description  OCR + translate manga bubbles on mobile via Anthropic/OpenAI-compatible APIs (no backend)
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  if (window.__MT_MOBILE__) return;
  window.__MT_MOBILE__ = true;

  const TARGET_SELECTOR = 'img,canvas';
  const AUTO_MIN_W = 220;
  const AUTO_MIN_H = 200;
  const MANUAL_MIN_W = 120;
  const MANUAL_MIN_H = 120;
  const MAX_PARALLEL = 2;
  const MAX_MANUAL = 4;
  const IMAGE_MAX_SIDE = 1280;
  const IMAGE_QUALITY = 0.78;
  const FONT_MIN = 8;
  const FONT_MAX = 18;
  const FONT_BASE = 0.2;
  const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
  const CACHE_MAX_ENTRIES = 80;
  const SPA_POLL_MS = 1000;

  function preloadMarginPx() {
    return Math.max(window.innerHeight * 3, 3000);
  }

  const SETTINGS_KEY = 'mt_mobile_settings_v1';
  const DEFAULTS = {
    enabled: true,
    auto: true,
    showBall: true,
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    apiKey: '',
    baseUrl: '',
    ignoreSimplifiedChinese: false
  };

  const state = {
    settings: { ...DEFAULTS },
    io: null,
    mo: null,
    observed: new WeakSet(),
    queue: [],
    queued: new WeakSet(),
    running: 0,
    inflight: new WeakMap(),
    // overlay DOM by target element (Map, not WeakMap — we iterate it in sync)
    overlayByTarget: new Map(),
    // Persistent cache: translation data survives element removal
    translationCacheByKey: new Map(),
    layer: null,
    probe: null,
    ballWrap: null,
    episodeKey: location.pathname
  };

  // --- Debug logging ------------------------------------------------

  function debugLog(...args) {
    console.log('[MT-Mobile]', ...args);
  }

  // --- Geometry helpers ---------------------------------------------

  function nearViewport(rect) {
    const margin = preloadMarginPx();
    return rect.bottom >= -margin && rect.top <= window.innerHeight + margin;
  }

  function visible(r) {
    return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  }

  function visibleArea(r) {
    const l = Math.max(0, r.left), t = Math.max(0, r.top),
          rr = Math.min(window.innerWidth, r.right), b = Math.min(window.innerHeight, r.bottom);
    return Math.max(0, rr - l) * Math.max(0, b - t);
  }

  // --- Image key ----------------------------------------------------

  function normalizeImageSrc(src) {
    if (!src) return '';
    return src.split('?')[0]; // strip query params for stable key
  }

  function computeTargetKey(target) {
    if (target instanceof HTMLCanvasElement) {
      const episode = state.episodeKey || location.pathname;
      return `${episode}|canvas|${target.width}x${target.height}|${Math.round(target.getBoundingClientRect().width)}x${Math.round(target.getBoundingClientRect().height)}`;
    }
    const src = normalizeImageSrc(target.currentSrc || target.src || '');
    const w = target.naturalWidth || target.width || Math.round(target.getBoundingClientRect().width);
    const h = target.naturalHeight || target.height || Math.round(target.getBoundingClientRect().height);
    const episode = state.episodeKey || location.pathname;
    return `${episode}|${src}|${w}x${h}`;
  }

  // --- Init ---------------------------------------------------------

  init().catch((e) => console.error('[MT-Mobile] init failed:', e));

  async function init() {
    await loadSettings();
    installStyle();
    ensureLayer();
    createBall();
    registerMenus();
    bindSync();
    bindSpaNavigation();
    startObservers();
    scan(document.documentElement || document.body);
    toast('Mobile translator ready');
  }

  // --- Styles -------------------------------------------------------

  function installStyle() {
    GM_addStyle(`
      .mtm-layer{position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;pointer-events:none}
      .mtm-root{position:fixed;pointer-events:none}
      .mtm-loading{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:6px 10px;border-radius:999px;background:rgba(255,255,255,.9);border:1px solid rgba(15,23,42,.2);font-size:12px;color:#0f172a;animation:mtmPulse 1s ease-in-out infinite}
      .mtm-bubble{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;text-align:center;white-space:pre-wrap;word-break:break-word;line-height:1.2;font:600 12px/1.2 "Noto Sans SC","Microsoft YaHei",sans-serif;border-radius:.36em;padding:.12em .34em;max-width:100%;max-height:100%;pointer-events:auto;cursor:pointer;--mtm-base:translate(-50%,-50%);transform:var(--mtm-base)}
      .mtm-bubble.mtm-jp{writing-mode:vertical-rl;text-orientation:upright;line-height:1.34;padding:.34em .12em;font-family:"Noto Serif JP","Yu Mincho","Noto Sans SC",sans-serif}
      .mtm-solid{color:#111827;background:rgba(255,255,255,.94);border:1px solid rgba(15,23,42,.26)}
      .mtm-transparent{color:#111827;background:rgba(255,255,255,.45);border:1px solid rgba(15,23,42,.3);text-shadow:0 1px 0 rgba(255,255,255,.5),0 0 2px rgba(255,255,255,.72)}
      .mtm-none{color:#fff;background:transparent;border:1px solid transparent;text-shadow:-1px -1px 0 rgba(0,0,0,.88),1px -1px 0 rgba(0,0,0,.88),-1px 1px 0 rgba(0,0,0,.88),1px 1px 0 rgba(0,0,0,.88),0 0 3px rgba(0,0,0,.92)}
      .mtm-enter{opacity:0;transform:var(--mtm-base) translateY(3px) scale(.985);animation:mtmIn .24s ease forwards;animation-delay:var(--mtm-delay,0ms)}
      .mtm-ball-wrap{position:fixed;right:16px;bottom:88px;z-index:2147483600}
      .mtm-ball{width:50px;height:50px;border:0;border-radius:999px;background:linear-gradient(135deg,#ef4444 0%,#f97316 100%);color:#fff;font-weight:700;font-size:18px}
      @keyframes mtmPulse{0%{opacity:.58}50%{opacity:.98}100%{opacity:.58}}
      @keyframes mtmIn{from{opacity:0;transform:var(--mtm-base) translateY(3px) scale(.985)}to{opacity:1;transform:var(--mtm-base) translateY(0) scale(1)}}
    `);
  }

  // --- Observers ----------------------------------------------------

  function startObservers() {
    state.io = new IntersectionObserver(onIntersect, {
      root: null,
      rootMargin: `${preloadMarginPx()}px 0px`,
      threshold: 0.08
    });
    state.mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList') m.addedNodes.forEach((n) => scan(n));
        if (m.type === 'attributes') scan(m.target);
      }
    });
    if (document.body) {
      state.mo.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset', 'data-src', 'style', 'class', 'width', 'height']
      });
    }
  }

  function onIntersect(entries) {
    if (!state.settings.enabled || !state.settings.auto) return;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      if (!passesFilter(e.target, false)) continue;
      queueTranslate(e.target, 'auto');
    }
  }

  // --- Scanning & registration --------------------------------------

  function scan(node) {
    if (!node) return;
    if (node instanceof HTMLImageElement || node instanceof HTMLCanvasElement) {
      register(node);
      return;
    }
    if (!(node instanceof Element)) return;
    node.querySelectorAll(TARGET_SELECTOR).forEach((el) => register(el));
  }

  function register(target) {
    if (!(target instanceof HTMLImageElement || target instanceof HTMLCanvasElement)) return;
    if (target instanceof HTMLImageElement && !target.complete) {
      target.addEventListener('load', () => register(target), { once: true });
      return;
    }
    if (!passesFilter(target, false)) return;

    const firstTime = !state.observed.has(target);
    if (firstTime) {
      state.observed.add(target);
      state.io.observe(target);
      debugLog('register key=' + computeTargetKey(target));
    }

    // Try to rebuild overlay from cache
    attachCachedOverlay(target);

    // Queue translation if near viewport and not already cached+inflight
    const rect = target.getBoundingClientRect();
    if (firstTime && nearViewport(rect)) {
      queueTranslate(target, 'auto');
    } else if (nearViewport(rect)) {
      // already observed, but still try queue (will be no-op if cached/inflight)
      queueTranslate(target, 'auto');
    } else if (firstTime) {
      debugLog('skip far target key=' + computeTargetKey(target));
    }
  }

  // --- Queue --------------------------------------------------------

  function queueTranslate(target, reason) {
    if (!passesFilter(target, reason === 'manual')) return;

    const key = computeTargetKey(target);

    // Cache hit — no need to queue
    if (state.translationCacheByKey.has(key)) {
      attachCachedOverlay(target);
      return;
    }

    // Deduplicate
    if (state.inflight.has(target) || state.queued.has(target)) return;

    // Auto mode: only process near-viewport targets
    if (reason === 'auto') {
      const rect = target.getBoundingClientRect();
      if (!nearViewport(rect)) {
        debugLog('skip far target key=' + key);
        return;
      }
    }

    debugLog('queued key=' + key);
    state.queue.push({ target, key, reason });
    state.queued.add(target);
    pumpQueue();
  }

  function pumpQueue() {
    while (state.running < MAX_PARALLEL && state.queue.length > 0) {
      const item = state.queue.shift();
      state.queued.delete(item.target);
      state.inflight.set(item.target, true);
      state.running += 1;
      translateTarget(item.target, item.key, item.reason)
        .catch((e) => toast(getErr(e)))
        .finally(() => {
          state.inflight.delete(item.target);
          state.running -= 1;
          pumpQueue();
        });
    }
  }

  async function translateVisibleManual() {
    const targets = Array.from(document.querySelectorAll(TARGET_SELECTOR))
      .filter((t) => passesFilter(t, true))
      .filter((t) => visible(t.getBoundingClientRect()))
      .map((t) => ({ target: t, area: visibleArea(t.getBoundingClientRect()) }))
      .sort((a, b) => b.area - a.area)
      .slice(0, MAX_MANUAL)
      .map((x) => x.target);
    if (targets.length === 0) {
      toast('当前视口没有可翻译目标');
      return;
    }
    for (const t of targets) queueTranslate(t, 'manual');
  }

  // --- Translation engine -------------------------------------------

  async function translateTarget(target, key, reason) {
    if (!state.settings.enabled) return;
    if (!passesFilter(target, reason === 'manual')) return;

    // Target was removed from DOM while waiting in queue
    if (!target.isConnected) {
      debugLog('target disconnected, skip translate key=' + key);
      return;
    }

    // Double-check cache (might have been filled by another parallel request)
    const cached = state.translationCacheByKey.get(key);
    if (cached) {
      attachCachedOverlay(target);
      return;
    }

    renderLoading(target, key, 'OCR + 翻译中...');
    const payload = await extractPayload(target);
    updateLoading(target, key, '模型翻译中...');
    const result = await requestTranslate(payload.dataUrl, payload.imageUrl);

    // Store in persistent cache (survives element removal)
    state.translationCacheByKey.set(key, { ts: Date.now(), value: result });
    if (state.translationCacheByKey.size > CACHE_MAX_ENTRIES) {
      const first = state.translationCacheByKey.keys().next().value;
      if (first) state.translationCacheByKey.delete(first);
    }

    if (result.bubbles.length === 0) {
      removeOverlay(target);
      return;
    }

    // Re-check target still exists
    if (!target.isConnected) {
      debugLog('target disconnected after translate, cache kept key=' + key);
      return;
    }

    debugLog('cache miss key=' + key);
    attachCachedOverlay(target);
  }

  // --- Cache & Overlay attachment -----------------------------------

  function attachCachedOverlay(target) {
    const key = computeTargetKey(target);
    const cached = state.translationCacheByKey.get(key);
    if (!cached) return;

    // Already has an active overlay DOM
    const existing = state.overlayByTarget.get(target);
    if (existing && existing.isConnected) return;

    // Expired cache
    if (Date.now() - cached.ts > CACHE_TTL_MS) {
      state.translationCacheByKey.delete(key);
      return;
    }

    debugLog('attach overlay key=' + key);

    const root = ensureRoot(target, key);
    root.innerHTML = '';

    const bubbles = Array.isArray(cached.value && cached.value.bubbles) ? cached.value.bubbles : [];
    bubbles.forEach((bubble, i) => {
      const node = createBubbleNode(bubble);
      if (!node) return;
      node.classList.add('mtm-enter');
      node.style.setProperty('--mtm-delay', `${Math.min(i * 34, 320)}ms`);
      root.appendChild(node);
    });

    syncRoot(target, root);
  }

  // --- Overlay DOM management ---------------------------------------

  function ensureRoot(target, key) {
    let root = state.overlayByTarget.get(target);
    if (!root || !root.isConnected) {
      root = document.createElement('div');
      root.className = 'mtm-root';
      ensureLayer().appendChild(root);
      state.overlayByTarget.set(target, root);
    }
    root.dataset.mtmKey = key;
    root.dataset.mtmTargetId = target.dataset.mtmId || '';
    return root;
  }

  function syncRoot(target, root) {
    if (!root || !root.isConnected) return;

    // Target element gone — remove overlay but keep cache
    if (!target || !target.isConnected) {
      const key = root.dataset.mtmKey;
      debugLog('target disconnected, remove overlay but keep cache key=' + key);
      root.remove();
      if (target) state.overlayByTarget.delete(target);
      return;
    }

    const r = target.getBoundingClientRect();

    // Too far off-screen — remove overlay to avoid ghost layers
    if (!nearViewport(r)) {
      const key = root.dataset.mtmKey;
      debugLog('remove offscreen overlay key=' + key);
      root.remove();
      state.overlayByTarget.delete(target);
      return;
    }

    // Position overlay
    root.style.display = 'block';
    root.style.left = `${Math.round(r.left)}px`;
    root.style.top = `${Math.round(r.top)}px`;
    root.style.width = `${Math.round(r.width)}px`;
    root.style.height = `${Math.round(r.height)}px`;
  }

  // --- Scroll / resize sync (throttled) -----------------------------

  function bindSync() {
    let ticking = false;
    const sync = () => {
      // Position-sync existing overlays; removes far-off ones
      for (const [target, root] of state.overlayByTarget.entries()) {
        syncRoot(target, root);
      }
      // Catch newly-appeared near-viewport images
      scanNearViewport();
    };
    const throttledSync = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        ticking = false;
        sync();
      });
    };
    window.addEventListener('scroll', throttledSync, { passive: true });
    window.addEventListener('resize', throttledSync, { passive: true });
  }

  function scanNearViewport() {
    const targets = document.querySelectorAll(TARGET_SELECTOR);
    for (const target of targets) {
      if (!(target instanceof HTMLImageElement || target instanceof HTMLCanvasElement)) continue;
      if (target instanceof HTMLImageElement && !target.complete) continue;
      const rect = target.getBoundingClientRect();
      if (!nearViewport(rect)) continue;
      if (!state.observed.has(target)) {
        register(target);
      } else {
        // Already observed: try cached overlay or queue if needed
        attachCachedOverlay(target);
        if (passesFilter(target, false)) {
          queueTranslate(target, 'auto');
        }
      }
    }
  }

  // --- SPA navigation detection -------------------------------------

  function bindSpaNavigation() {
    let lastPath = location.pathname;
    window.setInterval(() => {
      const current = location.pathname;
      if (current === lastPath) return;
      lastPath = current;
      state.episodeKey = current;
      debugLog('SPA navigation detected, clearing overlays');

      // Remove all overlay DOM
      for (const [target, root] of state.overlayByTarget) {
        if (root.isConnected) root.remove();
      }
      state.overlayByTarget = new Map();

      // Clear runtime state
      state.observed = new WeakSet();
      state.queue = [];
      state.queued = new WeakSet();
      state.inflight = new WeakMap();
      state.running = 0;

      // Rebuild IntersectionObserver for new page
      if (state.io) state.io.disconnect();
      state.io = new IntersectionObserver(onIntersect, {
        root: null,
        rootMargin: `${preloadMarginPx()}px 0px`,
        threshold: 0.08
      });

      // Note: translationCacheByKey is NOT cleared — allows back-nav cache hits
      // Re-scan new page
      scan(document.documentElement || document.body);
    }, SPA_POLL_MS);
  }

  // --- Remove overlay -----------------------------------------------

  function removeOverlay(target) {
    const root = state.overlayByTarget.get(target);
    if (root && root.isConnected) root.remove();
    state.overlayByTarget.delete(target);
  }

  // --- Bubble / loading rendering -----------------------------------

  function renderLoading(target, key, text) {
    const root = ensureRoot(target, key);
    root.innerHTML = `<div class="mtm-loading">${escapeHtml(text || 'OCR + 翻译中...')}</div>`;
    syncRoot(target, root);
  }

  function updateLoading(target, key, text) {
    const root = state.overlayByTarget.get(target);
    if (!root || root.dataset.mtmKey !== key) return;
    const node = root.querySelector('.mtm-loading');
    if (node) node.textContent = text || 'OCR + 翻译中...';
  }

  function renderBubbles(target, key, result, stream) {
    const root = ensureRoot(target, key);
    root.innerHTML = '';
    const bubbles = Array.isArray(result && result.bubbles) ? result.bubbles : [];
    bubbles.forEach((bubble, i) => {
      const node = createBubbleNode(bubble);
      if (!node) return;
      if (stream) {
        node.classList.add('mtm-enter');
        node.style.setProperty('--mtm-delay', `${Math.min(i * 34, 320)}ms`);
      }
      root.appendChild(node);
    });
    syncRoot(target, root);
  }

  function createBubbleNode(b) {
    const x = clamp(toNum(b.x), 0, 100), y = clamp(toNum(b.y), 0, 100),
          w = clamp(toNum(b.w), 0, 100), h = clamp(toNum(b.h), 0, 100);
    if (w <= 0 || h <= 0) return null;
    const original = String(b.original_text || '').trim();
    const translated = String(b.translated_text || '').trim() || original;

    const node = document.createElement('div');
    node.className = `mtm-bubble mtm-${normalizeBg(b.bg_type)}`;
    node.dataset.original = original;
    node.dataset.translated = translated;
    node.dataset.mode = 'translated';
    node.dataset.w = String(w);
    node.dataset.h = String(h);
    node.style.left = `${clamp(x + w / 2, 0, 100)}%`;
    node.style.top = `${clamp(y + h / 2, 0, 100)}%`;
    node.style.maxWidth = `${w}%`;
    node.style.maxHeight = `${h}%`;
    node.style.width = 'fit-content';
    node.style.height = 'fit-content';
    node.textContent = translated;
    node.title = original || translated;
    applyLayout(node, translated);
    fitFont(node);

    node.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const mode = node.dataset.mode === 'translated' ? 'original' : 'translated';
      node.dataset.mode = mode;
      const text = mode === 'translated' ? translated : original || translated;
      node.textContent = text;
      node.title = mode === 'translated' ? original || translated : translated || original;
      applyLayout(node, text);
      fitFont(node);
    });
    return node;
  }

  // --- Layout helpers -----------------------------------------------

  function applyLayout(node, text) {
    const ratio = toNum(node.dataset.h) / Math.max(toNum(node.dataset.w), 0.1);
    const jp = /[぀-ヿㇰ-ㇿｦ-ﾟ]/.test(String(text || ''));
    node.classList.toggle('mtm-jp', jp && ratio >= 0.82);
  }

  function fitFont(node) {
    const root = node.parentElement || document.documentElement;
    const rect = root.getBoundingClientRect();
    const w = Math.max(8, Math.round((rect.width * toNum(node.dataset.w)) / 100));
    const h = Math.max(8, Math.round((rect.height * toNum(node.dataset.h)) / 100));
    const text = String(node.textContent || '').trim();
    if (!text) return;
    const probe = ensureProbe();
    probe.className = node.className;
    probe.style.width = `${w}px`;
    probe.style.height = `${h}px`;
    probe.textContent = text;
    let low = FONT_MIN, high = Math.min(18, clamp(h * FONT_BASE, FONT_MIN, FONT_MAX)), best = FONT_MIN;
    for (let i = 0; i < 9; i += 1) {
      const mid = (low + high) / 2;
      probe.style.fontSize = `${mid}px`;
      const overflow = probe.scrollHeight > probe.clientHeight + 0.5 || probe.scrollWidth > probe.clientWidth + 0.5;
      if (overflow) high = mid; else { best = mid; low = mid; }
    }
    const safe = node.classList.contains('mtm-jp') ? best * 0.85 : best * 0.88;
    node.style.fontSize = `${Math.round(clamp(safe, FONT_MIN, FONT_MAX) * 10) / 10}px`;
  }

  function ensureProbe() {
    if (state.probe && state.probe.isConnected) return state.probe;
    const p = document.createElement('div');
    p.style.cssText = 'position:fixed;left:-200vw;top:-200vh;visibility:hidden;opacity:0;pointer-events:none;';
    document.documentElement.appendChild(p);
    state.probe = p;
    return p;
  }

  // --- Layer --------------------------------------------------------

  function ensureLayer() {
    if (state.layer && state.layer.isConnected) return state.layer;
    const layer = document.createElement('div');
    layer.className = 'mtm-layer';
    document.documentElement.appendChild(layer);
    state.layer = layer;
    return layer;
  }

  // --- Image payload extraction -------------------------------------

  async function extractPayload(target) {
    if (target instanceof HTMLCanvasElement) {
      return { dataUrl: target.toDataURL('image/jpeg', IMAGE_QUALITY), imageUrl: '' };
    }

    const src = resolveImageUrl(target);
    if (/^data:/i.test(src)) return { dataUrl: src, imageUrl: src.slice(0, 120) };

    if (/^https?:\/\//i.test(src)) {
      const dataUrl = await gmFetchDataUrl(src);
      if (dataUrl) return { dataUrl, imageUrl: src };
    }

    return { dataUrl: imageToDataUrl(target), imageUrl: src };
  }

  function imageToDataUrl(img) {
    const sw = img.naturalWidth || img.width || img.clientWidth;
    const sh = img.naturalHeight || img.height || img.clientHeight;
    const scale = Math.max(sw, sh) > IMAGE_MAX_SIDE ? IMAGE_MAX_SIDE / Math.max(sw, sh) : 1;
    const tw = Math.max(1, Math.round(sw * scale));
    const th = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context unavailable');
    ctx.drawImage(img, 0, 0, tw, th);
    try { return canvas.toDataURL('image/jpeg', IMAGE_QUALITY); } catch { return canvas.toDataURL('image/png'); }
  }

  function gmFetchDataUrl(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        timeout: 18000,
        onload: async (resp) => {
          try {
            if (!resp || resp.status < 200 || resp.status >= 300 || !resp.response) return resolve('');
            resolve(await blobToDataUrl(resp.response));
          } catch { resolve(''); }
        },
        onerror: () => resolve(''),
        ontimeout: () => resolve('')
      });
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(new Error('blob->dataurl failed'));
      r.readAsDataURL(blob);
    });
  }

  // --- API ----------------------------------------------------------

  async function requestTranslate(dataUrl) {
    if (!state.settings.apiKey) throw new Error('请先在 Userscript 菜单里配置 API');
    const prompt = buildPrompt(state.settings.ignoreSimplifiedChinese === true);
    const raw = state.settings.provider === 'openai_compatible'
      ? await requestOpenAICompatible(dataUrl, prompt)
      : await requestAnthropic(dataUrl, prompt);
    return normalizeResult(parseModelJson(raw));
  }

  async function requestAnthropic(dataUrl, prompt) {
    const parsed = parseDataUrl(dataUrl);
    const body = {
      model: state.settings.model || 'claude-3-5-sonnet-20241022',
      max_tokens: 2200,
      temperature: 0,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: parsed.mediaType, data: parsed.base64Data } },
        { type: 'text', text: prompt }
      ] }]
    };
    const json = await gmJson({
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': state.settings.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });
    const text = (Array.isArray(json.content) ? json.content : []).filter((x) => x && x.type === 'text').map((x) => String(x.text || '')).join('\n').trim();
    if (!text) throw new Error('Anthropic empty response');
    return text;
  }

  async function requestOpenAICompatible(dataUrl, prompt) {
    const endpoint = normalizeBaseUrl(state.settings.baseUrl) + '/chat/completions';
    const body = {
      model: state.settings.model || 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a manga OCR + translation engine. Return JSON only.' },
        { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }
      ]
    };
    const json = await gmJson({
      method: 'POST',
      url: endpoint,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.settings.apiKey}` },
      body: JSON.stringify(body)
    });
    const msg = json && json.choices && json.choices[0] && json.choices[0].message;
    const text = extractOAContent(msg ? msg.content : '').trim();
    if (!text) throw new Error('OpenAI-compatible empty response');
    return text;
  }

  function gmJson({ method, url, headers, body }) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url, headers, data: body, timeout: 45000,
        onload: (resp) => {
          try {
            const raw = String(resp.responseText || '');
            const json = raw ? JSON.parse(raw) : {};
            if (!resp || resp.status < 200 || resp.status >= 300) {
              const msg = (json && json.error && json.error.message) || (json && json.message) || `${resp.status} ${resp.statusText}`;
              return reject(new Error(msg));
            }
            resolve(json);
          } catch (e) { reject(new Error(`JSON parse failed: ${e && e.message ? e.message : String(e)}`)); }
        },
        onerror: () => reject(new Error('Network request failed')),
        ontimeout: () => reject(new Error('Network request timeout'))
      });
    });
  }

  // --- Filter -------------------------------------------------------

  function passesFilter(target, manual) {
    if (!(target instanceof HTMLImageElement || target instanceof HTMLCanvasElement)) return false;
    if (!target.isConnected) return false;
    if (target instanceof HTMLImageElement && !target.complete) return false;
    const r = target.getBoundingClientRect();
    const mw = manual ? MANUAL_MIN_W : AUTO_MIN_W;
    const mh = manual ? MANUAL_MIN_H : AUTO_MIN_H;
    if (r.width < mw || r.height < mh) return false;
    const ratio = r.height / Math.max(r.width, 1);
    return ratio >= 0.18 && ratio <= 10;
  }

  // --- Result parsing -----------------------------------------------

  function resolveImageUrl(img) {
    const raw = [img.currentSrc, img.getAttribute('src'), img.getAttribute('data-src'), img.getAttribute('data-original')].filter(Boolean).map((x) => String(x).trim()).find(Boolean);
    if (!raw) return '';
    if (/^(data:|blob:)/i.test(raw)) return raw;
    try { return new URL(raw, location.href).href; } catch { return raw; }
  }

  function parseModelJson(raw) {
    const text = String(raw || '').trim();
    if (!text) throw new Error('Model output empty');
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Model output not valid JSON');
    return JSON.parse(candidate.slice(start, end + 1));
  }

  function normalizeResult(payload) {
    const raw = Array.isArray(payload && payload.bubbles) ? payload.bubbles : [];
    const items = raw.map((b) => ({
      x: toNum(b.x), y: toNum(b.y), w: toNum(b.w), h: toNum(b.h),
      bg_type: normalizeBg(b.bg_type),
      original_text: String(b.original_text || '').trim(),
      translated_text: String(b.translated_text || '').trim()
    })).filter((b) => b.w > 0 && b.h > 0);
    const unit = items.length > 0 && items.every((b) => [b.x, b.y, b.w, b.h].every((n) => n >= 0 && n <= 1.2));
    const scale = unit ? 100 : 1;
    return { bubbles: items.map((b) => ({ ...b, x: clamp(b.x * scale, 0, 100), y: clamp(b.y * scale, 0, 100), w: clamp(b.w * scale, 0, 100), h: clamp(b.h * scale, 0, 100) })).slice(0, 300) };
  }

  function parseDataUrl(dataUrl) {
    const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/i);
    if (!m) throw new Error('Invalid data URL');
    return { mediaType: String(m[1]).toLowerCase(), base64Data: m[2] };
  }

  function normalizeBaseUrl(url) {
    let v = String(url || '').trim().replace(/\/+$/, '');
    v = v.replace(/\/chat\/completions$/i, '');
    v = v.replace(/\/responses$/i, '');
    if (!v) throw new Error('openai_compatible 需要 baseUrl');
    return v;
  }

  function extractOAContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((x) => typeof x === 'string' ? x : (x && typeof x.text === 'string' ? x.text : '')).join('\n');
  }

  // --- Floating action ball -----------------------------------------

  function createBall() {
    const wrap = document.createElement('div');
    wrap.className = 'mtm-ball-wrap';
    wrap.style.display = state.settings.showBall ? 'block' : 'none';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mtm-ball';
    btn.textContent = '译';
    btn.addEventListener('click', () => translateVisibleManual().catch((e) => toast(getErr(e))));
    wrap.appendChild(btn);
    document.documentElement.appendChild(wrap);
    state.ballWrap = wrap;
  }

  // --- Menu ---------------------------------------------------------

  function registerMenus() {
    GM_registerMenuCommand('配置 API', async () => {
      const provider = prompt('provider (anthropic/openai_compatible):', state.settings.provider);
      if (!provider) return;
      const model = prompt('model:', state.settings.model || '');
      if (!model) return;
      const apiKey = prompt('apiKey:', state.settings.apiKey || '');
      if (!apiKey) return;
      const baseUrl = provider.trim().toLowerCase() === 'openai_compatible' ? prompt('baseUrl:', state.settings.baseUrl || '') : '';
      state.settings.provider = provider.trim().toLowerCase();
      state.settings.model = model.trim();
      state.settings.apiKey = apiKey.trim();
      state.settings.baseUrl = String(baseUrl || '').trim();
      await saveSettings();
      toast('API 已保存');
    });

    GM_registerMenuCommand('手动翻译当前视口', () => translateVisibleManual().catch((e) => toast(getErr(e))));
    GM_registerMenuCommand('开关自动翻译', async () => { state.settings.auto = !state.settings.auto; await saveSettings(); toast(`自动翻译: ${state.settings.auto ? '开' : '关'}`); });
    GM_registerMenuCommand('开关悬浮球', async () => { state.settings.showBall = !state.settings.showBall; if (state.ballWrap) state.ballWrap.style.display = state.settings.showBall ? 'block' : 'none'; await saveSettings(); toast(`悬浮球: ${state.settings.showBall ? '开' : '关'}`); });
  }

  // --- Settings -----------------------------------------------------

  async function loadSettings() {
    try {
      const raw = await GM_getValue(SETTINGS_KEY, '');
      if (!raw) { state.settings = { ...DEFAULTS }; return; }
      state.settings = { ...DEFAULTS, ...(JSON.parse(String(raw)) || {}) };
    } catch { state.settings = { ...DEFAULTS }; }
  }

  async function saveSettings() { await GM_setValue(SETTINGS_KEY, JSON.stringify(state.settings)); }

  // --- Prompt -------------------------------------------------------

  function buildPrompt(ignoreSimplifiedChinese) {
    const lines = [
      'You are a manga OCR + translation engine.',
      'Do OCR, translation, and speech bubble localization on this manga image.',
      'Translate all detected text into Simplified Chinese.',
      'Ignore decorative symbols, musical notes, standalone punctuation marks and meaningless alphabetic noise.',
      'Return JSON only. No markdown, no explanation.',
      'Output schema: {"bubbles":[{"x":0-100,"y":0-100,"w":0-100,"h":0-100,"bg_type":"solid|transparent|none","original_text":"...","translated_text":"..."}]}',
      'Coordinates should be percentages. If no text: {"bubbles":[]}'
    ];
    if (ignoreSimplifiedChinese) lines.push('Important: Ignore already Simplified Chinese text.');
    return lines.join('\n');
  }

  // --- Utilities ----------------------------------------------------

  function normalizeBg(v) { const s = String(v || '').toLowerCase(); return s === 'transparent' || s === 'none' ? s : 'solid'; }
  function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function clamp(v, min, max) { const n = Number(v); const s = Number.isFinite(n) ? n : min; return Math.min(max, Math.max(min, s)); }
  function getErr(e) { return e && e.message ? e.message : String(e || 'Unknown error'); }
  function escapeHtml(text) { return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // --- Toast --------------------------------------------------------

  function toast(message) {
    const t = String(message || '').trim(); if (!t) return;
    const el = document.createElement('div');
    el.textContent = t;
    el.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483601;padding:8px 12px;border-radius:999px;background:rgba(15,23,42,.88);color:#fff;font-size:12px;max-width:78vw;text-align:center;pointer-events:none;';
    document.documentElement.appendChild(el);
    window.setTimeout(() => el.remove(), 1800);
  }
})();
