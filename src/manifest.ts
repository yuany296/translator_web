export const extensionManifest = {
  manifest_version: 3,
  name: "Manga Image Translator",
  version: "0.1.0",
  description: "OCR and translate manga images with overlay or embedded rendering.",
  minimum_chrome_version: "114",
  permissions: ["storage", "activeTab", "scripting", "tabs"],
  host_permissions: [
    "<all_urls>",
    "https://aip.baidubce.com/*",
    "https://aip.baidubce.com/oauth/2.0/token",
    "http://127.0.0.1:*/*",
    "http://localhost:*/*"
  ],
  background: {
    service_worker: "background/index.js"
  },
  action: {
    default_title: "漫画图片翻译",
    default_popup: "popup/index.html"
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["content/index.js"],
      css: ["styles/overlay.css"],
      run_at: "document_idle",
      all_frames: true,
      match_about_blank: true
    }
  ]
} as const;
