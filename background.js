importScripts("storage-db.js");

const LAZY_TAB_FILE = "lazy-tab.html";
const CONTEXT_MENU_ID = "tabwall-save-current-page";
const restoreInFlight = new Map();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.contextMenus.remove(CONTEXT_MENU_ID).catch(() => {}).finally(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: chrome.i18n.getMessage("contextMenuSavePage") || "Save current page to TabWall",
      contexts: ["page"],
      documentUrlPatterns: ["http://*/*", "https://*/*"]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !isOrdinaryWebTab(tab)) {
    return;
  }

  try {
    const scope = getScopeForTab(tab);
    await TabWallStore.initialize(scope, chrome.storage.local);
    await TabWallStore.capture(scope, [createSavedTab(tab)]);
    const allTabs = await chrome.tabs.query({});
    const managerUrl = chrome.runtime.getURL("manager.html");
    const managerTabs = allTabs.filter((candidate) => (
      isManagerTab(candidate, managerUrl) && Boolean(candidate.incognito) === Boolean(tab.incognito)
    ));
    const existingManagerTab = managerTabs.find((candidate) => candidate.windowId === tab.windowId) || managerTabs[0];
    const duplicateManagerIds = managerTabs
      .filter((candidate) => candidate.id !== existingManagerTab?.id && Number.isInteger(candidate.id))
      .map((candidate) => candidate.id);

    await openOrFocusManager(existingManagerTab, managerUrl, duplicateManagerIds, tab.windowId);
  } catch (error) {
    console.error("TabWall could not save the page from the context menu.", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "storage-command") {
    handleStorageCommand(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, code: error.code || "STORAGE_ERROR", message: error.message }));
    return true;
  }

  if (message?.type === "restore-tabs") {
    handleRestoreTabs(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, code: error.code || "RESTORE_ERROR", message: error.message }));
    return true;
  }

  if (message?.type === "activate-lazy-tab") {
    if (!isTrustedLazySender(sender) || !Number.isInteger(sender.tab?.id)) {
      sendResponse({ ok: false, code: "UNTRUSTED_SENDER", message: "Only a TabWall lazy tab can activate a saved record." });
      return false;
    }
    activateDeferredTab(sender.tab.id)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, code: error.code || "RESTORE_ERROR", message: error.message }));
    return true;
  }

  if (message?.type === "restore-tabs-lazily") {
    if (!isTrustedManagerSender(sender)) {
      sendResponse({ created: 0, error: "Only the TabWall manager can restore saved tabs." });
      return false;
    }
    restoreLegacyTabsLazily(message.tabs, message.windowId ?? sender.tab?.windowId)
      .then(sendResponse)
      .catch((error) => sendResponse({ created: 0, error: error.message }));
    return true;
  }

  return undefined;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void activateDeferredTab(tabId);
});

chrome.action.onClicked.addListener(async (currentTab) => {
  try {
    const tabs = await chrome.tabs.query({ windowId: currentTab.windowId });
    const allTabs = await chrome.tabs.query({});
    const managerUrl = chrome.runtime.getURL("manager.html");
    const managerTabs = allTabs.filter((tab) => (
      isManagerTab(tab, managerUrl) && Boolean(tab.incognito) === Boolean(currentTab.incognito)
    ));
    const existingManagerTab = managerTabs.find((tab) => (
      tab.windowId === currentTab.windowId && isManagerTab(tab, managerUrl)
    ));
    const duplicateManagerIds = managerTabs
      .filter((tab) => tab.id !== existingManagerTab?.id && Number.isInteger(tab.id))
      .map((tab) => tab.id);
    const ordinaryTabs = tabs
      .filter((tab) => isOrdinaryWebTab(tab));
    const savedTabs = ordinaryTabs
      .sort((a, b) => a.index - b.index)
      .map(createSavedTab);

    if (savedTabs.length === 0) {
      await openOrFocusManager(existingManagerTab, managerUrl, duplicateManagerIds);
      return;
    }

    const scope = getScopeForTab(currentTab);
    await TabWallStore.initialize(scope, chrome.storage.local);
    await TabWallStore.capture(scope, savedTabs);

    const tabIds = ordinaryTabs
      .map((tab) => tab.id)
      .filter((tabId) => Number.isInteger(tabId));
    await openOrFocusManager(existingManagerTab, managerUrl, duplicateManagerIds, currentTab.windowId);

    if (tabIds.length > 0) {
      await chrome.tabs.remove(tabIds);
    }
  } catch (error) {
    console.error("TabWall could not save the current tabs.", error);
  }
});

async function openOrFocusManager(existingManagerTab, managerUrl, duplicateManagerIds, windowId) {
  if (Number.isInteger(existingManagerTab?.id)) {
    if (duplicateManagerIds.length > 0) {
      const confirmedDuplicateIds = [];
      for (const tabId of duplicateManagerIds) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (isManagerTab(tab, managerUrl)) {
            confirmedDuplicateIds.push(tabId);
          }
        } catch {
          // The duplicate may have been closed already.
        }
      }

      if (confirmedDuplicateIds.length > 0) {
        await chrome.tabs.remove(confirmedDuplicateIds);
      }
    }
    await chrome.tabs.update(existingManagerTab.id, { active: true });
    await chrome.tabs.reload(existingManagerTab.id);
    return;
  }

  const createOptions = { url: managerUrl, active: true };
  if (Number.isInteger(windowId)) {
    createOptions.windowId = windowId;
  }
  await chrome.tabs.create(createOptions);
}

function isManagerTab(tab, managerUrl) {
  if (typeof tab.url !== "string") {
    return false;
  }

  try {
    const currentUrl = new URL(tab.url);
    const expectedUrl = new URL(managerUrl);
    const supportedProtocols = new Set(["chrome-extension:", "extension:"]);

    return supportedProtocols.has(currentUrl.protocol) &&
      supportedProtocols.has(expectedUrl.protocol) &&
      currentUrl.hostname === expectedUrl.hostname &&
      currentUrl.pathname === expectedUrl.pathname;
  } catch {
    return false;
  }
}

function isOrdinaryWebTab(tab) {
  return typeof tab.url === "string" && /^https?:\/\//i.test(tab.url);
}

function createSavedTab(tab) {
  return {
    title: tab.title || tab.url,
    url: tab.url,
    favIconUrl: tab.favIconUrl || "",
    lastAccessed: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : null,
    capturedAt: Date.now(),
    index: tab.index
  };
}

async function handleStorageCommand(message, sender) {
  if (!isTrustedManagerSender(sender)) {
    throw createBackgroundError("UNTRUSTED_SENDER", "Only the TabWall manager can change saved data.");
  }

  const scope = resolveScope(message, sender);
  await TabWallStore.initialize(scope, chrome.storage.local);
  const command = message.command;
  const mutatingCommands = new Set(["capture", "reorder", "trash", "clear", "restore-trash", "import"]);
  let result;

  switch (command) {
    case "list":
      result = { data: await TabWallStore.list(scope) };
      break;
    case "list-trash":
      result = { data: await TabWallStore.listTrash(scope) };
      break;
    case "capture":
      result = await TabWallStore.capture(scope, message.tabs);
      break;
    case "reorder":
      result = await TabWallStore.reorder(scope, message.ids);
      break;
    case "trash":
      result = await TabWallStore.trash(scope, message.ids);
      break;
    case "clear":
      result = await TabWallStore.clear(scope);
      break;
    case "restore-trash":
      result = await TabWallStore.restoreTrash(scope, message.ids);
      break;
    case "import":
      result = await TabWallStore.import(scope, message.document);
      break;
    case "export":
      result = { data: await TabWallStore.export(scope) };
      break;
    default:
      throw createBackgroundError("UNKNOWN_COMMAND", "Unknown TabWall storage command.");
  }

  const revision = await TabWallStore.revision(scope);
  if (mutatingCommands.has(command)) {
    notifyStorageUpdated(scope, revision);
  }
  return { ok: true, revision, ...result };
}

async function handleRestoreTabs(message, sender) {
  if (!isTrustedManagerSender(sender)) {
    throw createBackgroundError("UNTRUSTED_SENDER", "Only the TabWall manager can restore saved tabs.");
  }

  const scope = resolveScope(message, sender);
  const windowId = Number.isInteger(message.windowId) ? message.windowId : sender.tab?.windowId;
  if (!Number.isInteger(windowId)) {
    throw createBackgroundError("WINDOW_UNAVAILABLE", "The TabWall window could not be identified.");
  }
  await TabWallStore.initialize(scope, chrome.storage.local);
  const key = scope + ":" + windowId;
  if (restoreInFlight.has(key)) {
    return restoreInFlight.get(key);
  }

  const promise = restoreStoredTabs(scope, message.ids, windowId)
    .finally(() => restoreInFlight.delete(key));
  restoreInFlight.set(key, promise);
  return promise;
}

async function restoreStoredTabs(scope, ids, windowId) {
  const records = await TabWallStore.list(scope);
  const selectedIds = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null;
  const requested = selectedIds ? records.filter((record) => selectedIds.has(record.id)) : records;
  const targetTabs = await chrome.tabs.query({ windowId });
  if (targetTabs.length > 0 && targetTabs.some((tab) => Boolean(tab.incognito) !== (scope === "private"))) {
    throw createBackgroundError("SCOPE_WINDOW_MISMATCH", "The selected browser window belongs to another session.");
  }

  const recordsById = new Map(records.map((record) => [record.id, record]));
  const existingByUrl = new Map();
  targetTabs.forEach((tab) => {
    const deferredId = getDeferredTabId(tab.url || tab.pendingUrl);
    const deferredRecord = deferredId ? recordsById.get(deferredId) : null;
    const url = deferredRecord?.url || (isOrdinaryWebTab(tab) ? tab.url : "");
    if (url) {
      if (!existingByUrl.has(url)) {
        existingByUrl.set(url, []);
      }
      existingByUrl.get(url).push(tab);
    }
  });

  let created = 0;
  let reused = 0;
  let failed = 0;
  let focused = false;
  const failures = [];

  for (const record of requested) {
    const available = existingByUrl.get(record.url) || [];
    const existing = available.shift();
    try {
      if (existing) {
        if (!focused) {
          await chrome.tabs.update(existing.id, { active: true });
          focused = true;
        }
        reused += 1;
        continue;
      }

      await chrome.tabs.create({
        url: createLazyTabUrl(record),
        windowId,
        active: !focused
      });
      focused = true;
      created += 1;
    } catch (error) {
      failed += 1;
      failures.push({ id: record.id, message: error?.message || "Unknown tab creation error" });
    }
  }

  return { ok: true, created, reused, failed, failures };
}

async function restoreLegacyTabsLazily(tabs, windowId) {
  const openTabs = await chrome.tabs.query({ windowId });
  const openUrls = new Set(openTabs.map((tab) => tab.url).filter(Boolean));
  let created = 0;
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!tab?.url || openUrls.has(tab.url)) {
      continue;
    }
    await chrome.tabs.create({ url: createLegacyLazyTabUrl(tab), windowId, active: created === 0 });
    openUrls.add(tab.url);
    created += 1;
  }
  return { created };
}

function createLazyTabUrl(tab) {
  const lazyTabUrl = new URL(chrome.runtime.getURL(LAZY_TAB_FILE));
  lazyTabUrl.searchParams.set("id", tab.id);
  lazyTabUrl.searchParams.set("title", tab.title || tab.url);
  return lazyTabUrl.toString();
}

function createLegacyLazyTabUrl(tab) {
  const lazyTabUrl = new URL(chrome.runtime.getURL(LAZY_TAB_FILE));
  lazyTabUrl.searchParams.set("url", tab.url);
  lazyTabUrl.searchParams.set("title", tab.title || tab.url);
  return lazyTabUrl.toString();
}

async function activateDeferredTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const deferredId = getDeferredTabId(tab?.url || tab?.pendingUrl);
    if (deferredId) {
      const scope = getScopeForTab(tab);
      await TabWallStore.initialize(scope, chrome.storage.local);
      const record = (await TabWallStore.list(scope)).find((candidate) => candidate.id === deferredId);
      if (record?.url) {
        await chrome.tabs.update(tabId, { url: record.url });
      }
      return;
    }

    // Keep already-created legacy lazy tabs usable after an update. New restores
    // always use a record ID, so an arbitrary URL can never become authoritative.
    const legacyTargetUrl = getDeferredTargetUrl(tab?.url);
    if (legacyTargetUrl) {
      await chrome.tabs.update(tabId, { url: legacyTargetUrl });
    }
  } catch (error) {
    console.error("TabWall could not activate a deferred tab.", error);
  }
}

function getScopeForTab(tab) {
  return tab?.incognito ? "private" : "normal";
}

function resolveScope(message, sender) {
  const requestedScope = message?.scope;
  const senderScope = sender?.tab ? getScopeForTab(sender.tab) : null;
  if (requestedScope && requestedScope !== "normal" && requestedScope !== "private") {
    throw createBackgroundError("INVALID_SCOPE", "Unknown TabWall storage scope.");
  }
  if (senderScope && requestedScope && senderScope !== requestedScope) {
    throw createBackgroundError("SCOPE_MISMATCH", "The requested storage scope does not match this window.");
  }
  return requestedScope || senderScope || "normal";
}

function isTrustedManagerSender(sender) {
  return isTrustedExtensionSender(sender, "manager.html");
}

function isTrustedLazySender(sender) {
  return isTrustedExtensionSender(sender, LAZY_TAB_FILE);
}

function isTrustedExtensionSender(sender, page) {
  if (!sender || sender.id !== chrome.runtime.id || typeof sender.url !== "string") {
    return false;
  }

  try {
    const senderUrl = new URL(sender.url);
    const expectedUrl = new URL(chrome.runtime.getURL(page));
    return senderUrl.origin === expectedUrl.origin && senderUrl.pathname === expectedUrl.pathname;
  } catch {
    return false;
  }
}

function createBackgroundError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function notifyStorageUpdated(scope, revision) {
  void chrome.runtime.sendMessage({
    type: "storage-updated",
    scope,
    revision
  }).catch(() => {});
}

function getDeferredTabId(tabUrl) {
  if (typeof tabUrl !== "string") {
    return "";
  }

  try {
    const currentUrl = new URL(tabUrl);
    const lazyTabUrl = new URL(chrome.runtime.getURL(LAZY_TAB_FILE));
    if (currentUrl.origin !== lazyTabUrl.origin || currentUrl.pathname !== lazyTabUrl.pathname) {
      return "";
    }
    return currentUrl.searchParams.get("id") || "";
  } catch {
    return "";
  }
}

function getDeferredTargetUrl(tabUrl) {
  if (typeof tabUrl !== "string") {
    return "";
  }

  try {
    const currentUrl = new URL(tabUrl);
    const lazyTabUrl = new URL(chrome.runtime.getURL(LAZY_TAB_FILE));
    if (currentUrl.origin !== lazyTabUrl.origin || currentUrl.pathname !== lazyTabUrl.pathname) {
      return "";
    }

    const targetUrl = currentUrl.searchParams.get("url");
    return /^https?:\/\//i.test(targetUrl || "") ? targetUrl : "";
  } catch {
    return "";
  }
}
