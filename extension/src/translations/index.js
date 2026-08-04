import { installTranslationLibrary } from "./library.js";

const embedded = new URLSearchParams(location.search).get("embedded") === "1";
if (!embedded) {
  location.replace(chrome.runtime.getURL("settings.html#translations"));
} else {
  document.documentElement.classList.add("embedded");
  installTranslationLibrary();
}
