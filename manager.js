const STORAGE_SCOPE = chrome.extension?.inIncognitoContext ? "private" : "normal";
const VIEW_MODE_KEY = "tabwallViewMode";
const TABS_PER_ROW_KEY = "tabwallTabsPerRowPreference";
const MIN_TABS_PER_ROW = 10;
const MAX_TABS_PER_ROW_SETTING = 60;
const DEFAULT_TABS_PER_ROW = 60;
const AGE_FADE_DAYS = 45;
const MIN_CARD_OPACITY = 0.58;
const FALLBACK_MESSAGES = {
  appName: "TabWall",
  actionTitle: "Save tabs to TabWall",
  contextMenuSavePage: "Save current page to TabWall",
  originalView: "Original",
  byWebsite: "By website",
  originalViewHint: "Show tabs in original order",
  byWebsiteHint: "Group tabs by website",
  restoreAll: "Restore all",
  clearAll: "Clear all",
  batchActionsTitle: "Show restore and clear actions",
  batchActionsAria: "Show restore and clear actions",
  tabsPerRowHint: "Choose how many tabs appear in each row",
  tabViewAria: "Tab view",
  emptyTitle: "TabWall is empty",
  emptyDescription: "Click the TabWall toolbar icon while web pages are open to save them here.",
  restoreAllTitle: "Restore all saved tabs to the browser",
  restoreAllAria: "Restore all saved tabs to the browser",
  clearAllTitle: "Clear all saved tabs",
  clearAllAria: "Clear all saved tabs",
  loading: "Loading…",
  clearAllConfirm: "Clear all saved tabs from TabWall?",
  noSavedTabs: "No saved tabs",
  restoreTabAria: "Restore $1",
  dragHint: "Drag to reorder; drag out to open in a browser tab",
  deleteTab: "Delete tab",
  tabsGroupCountOne: "1 tab",
  tabsGroupCountMany: "$1 tabs",
  restoring: "Restoring…",
  restoreSummary: "$1 restored; $2 already open; $3 failed",
  storageError: "TabWall could not load your saved tabs. Try again.",
  backgroundUnavailable: "Please reload the TabWall extension, then try again.",
  retry: "Retry",
  timeUnavailable: "Time unavailable",
  lastVisit: "Last visit: $1",
  lastVisitUnavailableSaved: "Last visit unavailable; saved: $1",
  lastVisitUnavailableSession: "Last visit unavailable; session saved: $1",
  lastVisitTimeUnavailable: "Last visit time unavailable",
  lazyTabReady: "This tab is ready and will load when selected."
};

const tabWall = document.querySelector("#tab-wall");
const emptyState = document.querySelector("#empty-state");
const statusMessage = document.querySelector("#status-message");
const retryStorageButton = document.querySelector("#retry-storage");
const sessionMeta = document.querySelector("#session-meta");
const restoreAllButton = document.querySelector("#restore-all");
const clearSessionButton = document.querySelector("#clear-session");
const batchActionsButton = document.querySelector("#batch-actions-button");
const batchActionsMenu = document.querySelector("#batch-actions-menu");
const viewButtons = document.querySelectorAll("[data-view]");
const tabsPerRowInput = document.querySelector("#tabs-per-row");
const tabsPerRowValue = document.querySelector("#tabs-per-row-value");
let viewMode = localStorage.getItem(VIEW_MODE_KEY) === "domain" ? "domain" : "original";
let tabsPerRow = DEFAULT_TABS_PER_ROW;
let resizeTimer;
let draggedCard = null;
let ignoreNextCardClick = false;
let lastRenderedTabs = [];

applyTranslations();
syncTabsPerRowControl();

document.addEventListener("DOMContentLoaded", initializeManager);
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(renderSession, 100);
});
window.addEventListener("focus", () => {
  void renderSession();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void renderSession();
  }
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "storage-updated" && message.scope === STORAGE_SCOPE) {
    void renderSession();
  }
});
viewButtons.forEach((button) => {
  button.addEventListener("click", () => {
    viewMode = button.dataset.view === "domain" ? "domain" : "original";
    localStorage.setItem(VIEW_MODE_KEY, viewMode);
    updateViewButtons();
    renderSession();
  });
});
restoreAllButton.addEventListener("click", restoreAll);
clearSessionButton.addEventListener("click", clearSession);
batchActionsButton.addEventListener("click", toggleBatchActions);
document.addEventListener("click", (event) => {
  if (!batchActionsMenu.contains(event.target) && !batchActionsButton.contains(event.target)) {
    closeBatchActions();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeBatchActions();
  }
});
retryStorageButton.addEventListener("click", () => {
  void renderSession();
});
tabsPerRowInput.addEventListener("input", async () => {
  tabsPerRow = clampTabsPerRow(tabsPerRowInput.value);
  syncTabsPerRowControl();
  await chrome.storage.local.set({
    [TABS_PER_ROW_KEY]: tabsPerRow
  });
  await renderSession();
});

async function sendStorageCommand(command, payload = {}) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "storage-command",
      scope: STORAGE_SCOPE,
      command,
      ...payload
    });
  } catch (error) {
    const message = error?.message || "";
    const code = /receiving end|message port|could not establish connection/i.test(message)
      ? "BACKGROUND_UNAVAILABLE"
      : "STORAGE_UNAVAILABLE";
    throw createManagerError(code, message || translate("storageError"));
  }

  if (!response?.ok) {
    throw createManagerError(response?.code || "STORAGE_ERROR", response?.message || translate("storageError"));
  }
  return response;
}

function createManagerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function initializeManager() {
  tabsPerRow = await readTabsPerRow();
  syncTabsPerRowControl();
  await renderSession();
}

function translate(key, substitutions = []) {
  const localizedMessage = chrome.i18n?.getMessage?.(key, substitutions);
  if (localizedMessage) {
    return localizedMessage;
  }

  const fallbackMessage = FALLBACK_MESSAGES[key] || key;
  return substitutions.reduce(
    (message, value, index) => message.replaceAll(`$${index + 1}`, String(value)),
    fallbackMessage
  );
}

function applyTranslations() {
  const uiLanguage = chrome.i18n?.getUILanguage?.() || "en";
  if (document.documentElement) {
    document.documentElement.lang = uiLanguage.replace("_", "-");
  }

  document.title = translate("appName");
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = translate(element.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    element.title = translate(element.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", translate(element.dataset.i18nAriaLabel));
  });
}

async function renderSession() {
  sessionMeta.textContent = translate("loading");
  try {
    const response = await sendStorageCommand("list");
    const tabs = Array.isArray(response.data) ? [...response.data] : [];
    tabs.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    lastRenderedTabs = tabs;
    tabWall.replaceChildren();
    updateViewButtons();
    statusMessage.hidden = true;
    retryStorageButton.hidden = true;

    if (tabs.length === 0) {
      emptyState.hidden = false;
      restoreAllButton.disabled = true;
      clearSessionButton.disabled = true;
      sessionMeta.textContent = formatCollectedCount(0);
      return;
    }

    emptyState.hidden = true;
    restoreAllButton.disabled = false;
    clearSessionButton.disabled = false;
    sessionMeta.textContent = formatCollectedCount(tabs.length);

    const sessionSavedAt = tabs[0]?.savedAt;
    if (viewMode === "domain") {
      renderDomainView(tabs, sessionSavedAt);
      return;
    }

    renderTabRows(tabs, tabWall, sessionSavedAt, true);
  } catch (error) {
    console.error("TabWall could not load saved tabs.", error);
    showStorageError(error);
  }
}

function showStorageError(error) {
  statusMessage.textContent = error?.code === "BACKGROUND_UNAVAILABLE"
    ? translate("backgroundUnavailable")
    : translate("storageError");
  statusMessage.hidden = false;
  retryStorageButton.hidden = false;
  emptyState.hidden = true;
  restoreAllButton.disabled = true;
  clearSessionButton.disabled = true;
  sessionMeta.textContent = lastRenderedTabs.length > 0
    ? formatCollectedCount(lastRenderedTabs.length)
    : "";
}

function renderTabRows(tabs, container, sessionSavedAt, allowDrag = false) {
  const tabsPerRow = getTabsPerRow();
  for (let start = 0; start < tabs.length; start += tabsPerRow) {
    const row = document.createElement("div");
    row.className = "tab-row";
    const rowTabs = tabs.slice(start, start + tabsPerRow);

    rowTabs.forEach((tab) => {
      row.append(createTabCard(tab, sessionSavedAt, allowDrag));
    });

    container.append(row);
  }
}

function groupTabsByDomain(tabs) {
  const groups = new Map();

  tabs.forEach((tab) => {
    const domain = getDomain(tab.url);
    if (!groups.has(domain)) {
      groups.set(domain, []);
    }
    groups.get(domain).push(tab);
  });

  return groups;
}

function renderDomainView(tabs, sessionSavedAt) {
  const singleTabGroups = [];
  const multiTabGroups = [];

  groupTabsByDomain(tabs).forEach((groupTabs, domain) => {
    if (groupTabs.length === 1) {
      singleTabGroups.push(groupTabs[0]);
      return;
    }

    multiTabGroups.push({ groupTabs, domain });
  });

  renderSingleTabGroups(singleTabGroups, sessionSavedAt);
  multiTabGroups.forEach(({ groupTabs, domain }) => {
    renderDomainGroup(groupTabs, domain, sessionSavedAt);
  });
}

function renderSingleTabGroups(tabs, sessionSavedAt) {
  if (tabs.length > 0) {
    renderTabRows(tabs, tabWall, sessionSavedAt, false);
  }
}

function renderDomainGroup(groupTabs, domain, sessionSavedAt) {
  const group = document.createElement("section");
  group.className = "tab-group";

  const heading = document.createElement("h2");
  heading.className = "tab-group-heading";
  heading.textContent = domain;

  const count = document.createElement("span");
  count.className = "tab-group-count";
  count.textContent = groupTabs.length === 1
    ? translate("tabsGroupCountOne")
    : translate("tabsGroupCountMany", [String(groupTabs.length)]);
  heading.append(count);

  group.append(heading);
  renderTabRows(groupTabs, group, sessionSavedAt, false);
  tabWall.append(group);
}

function getDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return getRegistrableDomain(hostname) || "Other";
  } catch {
    return "Other";
  }
}

function getRegistrableDomain(hostname) {
  if (!hostname || hostname === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return hostname;
  }

  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) {
    return parts.join(".");
  }

  const suffix = parts.slice(-2).join(".");
  const multiLevelSuffixes = new Set([
    "ac.uk",
    "co.in",
    "co.jp",
    "co.kr",
    "co.nz",
    "co.uk",
    "com.au",
    "com.cn",
    "com.hk",
    "com.sg",
    "com.tw",
    "net.cn",
    "org.cn",
    "org.uk"
  ]);

  return multiLevelSuffixes.has(suffix)
    ? parts.slice(-3).join(".")
    : parts.slice(-2).join(".");
}

function updateViewButtons() {
  viewButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === viewMode);
  });
}

function getTabsPerRow() {
  return tabsPerRow;
}

function formatCollectedCount(count) {
  return `${count} pages`;
}

async function readTabsPerRow() {
  const stored = await chrome.storage.local.get(TABS_PER_ROW_KEY);
  return clampTabsPerRow(stored[TABS_PER_ROW_KEY] ?? DEFAULT_TABS_PER_ROW);
}

function syncTabsPerRowControl() {
  tabsPerRowInput.value = String(tabsPerRow);
  tabsPerRowValue.textContent = String(tabsPerRow);
}

function clampTabsPerRow(value) {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) {
    return DEFAULT_TABS_PER_ROW;
  }

  return Math.min(
    MAX_TABS_PER_ROW_SETTING,
    Math.max(MIN_TABS_PER_ROW, Math.round(parsedValue))
  );
}

function createTabCard(tab, sessionSavedAt, allowDrag) {
  const card = document.createElement("article");
  card.className = "tab-card";
  card.title = `${tab.title || tab.url}\n${tab.url}`;
  card.dataset.tabKey = getTabKey(tab);
  card.style.opacity = getTabOpacity(tab, sessionSavedAt);
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", translate("restoreTabAria", [tab.title || tab.url]));
  card.addEventListener("click", () => {
    if (ignoreNextCardClick) {
      ignoreNextCardClick = false;
      return;
    }

    restoreTab(tab);
  });
  card.addEventListener("keydown", (event) => {
    if (event.target !== card) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      restoreTab(tab);
    }
  });

  if (allowDrag) {
    card.draggable = true;
    card.classList.add("is-draggable");
    card.title += `\n${translate("dragHint")}`;
    card.addEventListener("dragstart", (event) => {
      draggedCard = card;
      ignoreNextCardClick = true;
      event.dataTransfer.effectAllowed = "copyMove";
      event.dataTransfer.setData("text/uri-list", tab.url);
      event.dataTransfer.setData("text/plain", tab.url);
      card.classList.add("is-dragging");
    });
    card.addEventListener("dragover", (event) => {
      if (!draggedCard || draggedCard === card) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const shouldInsertBefore = event.clientX < card.getBoundingClientRect().left + card.offsetWidth / 2;
      const parent = card.parentElement;

      if (shouldInsertBefore) {
        parent.insertBefore(draggedCard, card);
      } else {
        parent.insertBefore(draggedCard, card.nextSibling);
      }
    });
    card.addEventListener("drop", (event) => {
      if (!draggedCard) {
        return;
      }

      event.preventDefault();
      void persistRenderedOrder();
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("is-dragging");
      draggedCard = null;
      window.setTimeout(() => {
        ignoreNextCardClick = false;
      }, 0);
    });
  }

  const top = document.createElement("div");
  top.className = "tab-card-top";

  const favicon = document.createElement("div");
  favicon.className = "favicon favicon-fallback";
  favicon.textContent = getInitial(tab.title || tab.url);

  if (tab.favIconUrl) {
    const image = document.createElement("img");
    image.className = "favicon";
    image.alt = "";
    image.src = tab.favIconUrl;
    image.addEventListener("load", () => favicon.replaceWith(image), { once: true });
  }

  const title = document.createElement("h2");
  title.className = "tab-title";
  title.textContent = tab.title || tab.url;

  top.append(favicon, title);

  const footer = document.createElement("div");
  footer.className = "tab-card-footer";

  const lastVisited = document.createElement("span");
  lastVisited.className = "last-visited";
  lastVisited.textContent = formatTabTime(tab, sessionSavedAt);
  lastVisited.title = getTabTimeTooltip(tab, sessionSavedAt);

  const deleteButton = document.createElement("button");
  deleteButton.className = "delete-button";
  deleteButton.type = "button";
  deleteButton.textContent = "×";
  deleteButton.title = translate("deleteTab");
  deleteButton.setAttribute("aria-label", translate("deleteTab"));
  deleteButton.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteTab(tab);
  });

  footer.append(lastVisited, deleteButton);
  card.append(top, footer);
  return card;
}

async function persistRenderedOrder() {
  const renderedCards = [...tabWall.querySelectorAll(".tab-card")];
  const orderedIds = renderedCards.map((card) => card.dataset.tabKey).filter(Boolean);
  try {
    await sendStorageCommand("reorder", { ids: orderedIds });
    await renderSession();
  } catch (error) {
    console.error("TabWall could not save the new tab order.", error);
    showStorageError(error);
  }
}

function getTabKey(tab) {
  return tab.id || `${tab.url || ""}\u0000${tab.title || ""}`;
}

function getTabOpacity(tab, sessionSavedAt) {
  const timestamp = Number.isFinite(tab.lastAccessed)
    ? tab.lastAccessed
    : Number.isFinite(tab.capturedAt)
      ? tab.capturedAt
      : sessionSavedAt;

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "1";
  }

  const ageDays = Math.max(0, (Date.now() - date.getTime()) / 86400000);
  const fadeRatio = Math.min(1, ageDays / AGE_FADE_DAYS);
  const opacity = 1 - fadeRatio * (1 - MIN_CARD_OPACITY);
  return opacity.toFixed(2);
}

async function restoreAll() {
  if (lastRenderedTabs.length === 0) {
    return;
  }

  closeBatchActions();
  restoreAllButton.disabled = true;
  restoreAllButton.textContent = translate("restoring");

  try {
    const currentTab = await chrome.tabs.getCurrent();
    const response = await chrome.runtime.sendMessage({
      type: "restore-tabs",
      scope: STORAGE_SCOPE,
      ids: lastRenderedTabs.map((tab) => tab.id),
      windowId: currentTab?.windowId
    });

    if (!response?.ok) {
      throw createManagerError(response?.code || "RESTORE_ERROR", response?.message || translate("storageError"));
    }
    statusMessage.textContent = translate("restoreSummary", [response.created, response.reused, response.failed]);
    statusMessage.hidden = false;
  } catch (error) {
    console.error("TabWall could not restore all tabs.", error);
    statusMessage.textContent = error?.message || translate("storageError");
    statusMessage.hidden = false;
  } finally {
    restoreAllButton.textContent = translate("restoreAll");
    restoreAllButton.disabled = lastRenderedTabs.length === 0;
  }
}

async function restoreTab(tabToRestore) {
  if (!tabToRestore?.id) {
    return;
  }

  try {
    const currentTab = await chrome.tabs.getCurrent();
    const response = await chrome.runtime.sendMessage({
      type: "restore-tabs",
      scope: STORAGE_SCOPE,
      ids: [tabToRestore.id],
      windowId: currentTab?.windowId
    });
    if (!response?.ok) {
      throw createManagerError(response?.code || "RESTORE_ERROR", response?.message || translate("storageError"));
    }
  } catch (error) {
    console.error("TabWall could not restore a tab.", error);
    statusMessage.textContent = error?.message || translate("storageError");
    statusMessage.hidden = false;
  }
}

async function deleteTab(tabToDelete) {
  if (!tabToDelete?.id) {
    return;
  }
  try {
    await sendStorageCommand("trash", { ids: [tabToDelete.id] });
    await renderSession();
  } catch (error) {
    console.error("TabWall could not move a tab to Trash.", error);
    showStorageError(error);
  }
}

async function clearSession() {
  closeBatchActions();
  if (!window.confirm(translate("clearAllConfirm"))) {
    return;
  }

  try {
    await sendStorageCommand("clear");
    await renderSession();
  } catch (error) {
    console.error("TabWall could not clear saved tabs.", error);
    showStorageError(error);
  }
}

function toggleBatchActions() {
  if (batchActionsMenu.hidden) {
    batchActionsMenu.hidden = false;
    batchActionsButton.setAttribute("aria-expanded", "true");
    return;
  }

  closeBatchActions();
}

function closeBatchActions() {
  batchActionsMenu.hidden = true;
  batchActionsButton.setAttribute("aria-expanded", "false");
}

function getInitial(value) {
  return (value || "?").trim().charAt(0).toUpperCase() || "?";
}

function formatTabTime(tab, sessionSavedAt) {
  if (Number.isFinite(tab.lastAccessed)) {
    return formatDateOnly(tab.lastAccessed);
  }

  if (Number.isFinite(tab.capturedAt)) {
    return formatDateOnly(tab.capturedAt);
  }

  if (sessionSavedAt) {
    return formatDateOnly(sessionSavedAt);
  }

  return translate("timeUnavailable");
}

function formatDateOnly(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return translate("timeUnavailable");
  }

  return `${String(date.getFullYear()).slice(-2)}/${date.getMonth() + 1}/${date.getDate()}`;
}

function getTabTimeTooltip(tab, sessionSavedAt) {
  if (Number.isFinite(tab.lastAccessed)) {
    return translate("lastVisit", [formatDateTime(tab.lastAccessed)]);
  }

  if (Number.isFinite(tab.capturedAt)) {
    return translate("lastVisitUnavailableSaved", [formatDateTime(tab.capturedAt)]);
  }

  if (sessionSavedAt) {
    return translate("lastVisitUnavailableSession", [formatDateTime(sessionSavedAt)]);
  }

  return translate("lastVisitTimeUnavailable");
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return translate("timeUnavailable");
  }

  return date.toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
