(function initializeLazyTab() {
  const params = new URLSearchParams(location.search);
  const title = params.get("title");
  const uiLanguage = chrome.i18n.getUILanguage();
  document.documentElement.lang = uiLanguage.replace("_", "-");
  document.querySelector("#lazy-message").textContent = chrome.i18n.getMessage("lazyTabReady") || "This tab is ready and will load when selected.";
  if (title) {
    document.title = title;
  }
  if (params.get("id")) {
    void chrome.runtime.sendMessage({ type: "activate-lazy-tab" }).catch(() => {});
  }
})();
