// 主世界路由桥（MV3 外部文件方式注入，见 route-observer.js）。
// 包装 history.pushState/replaceState，通过 CustomEvent 通知 isolated content script。
// 只做路由通知，不包含任何翻译逻辑。
(function () {
  try { document.documentElement.dataset.mtBridgeExec = "yes"; } catch (e) {}
  if (window.__mtRouteBridgeInstalled) return;
  window.__mtRouteBridgeInstalled = true;
  var METHODS = ["pushState", "replaceState"];
  for (var i = 0; i < METHODS.length; i += 1) {
    var method = METHODS[i];
    var original = history[method];
    if (typeof original !== "function") continue;
    history[method] = function () {
      var result = original.apply(this, arguments);
      try {
        window.dispatchEvent(new CustomEvent("mt-route-change"));
      } catch (e) {}
      return result;
    };
  }
})();
