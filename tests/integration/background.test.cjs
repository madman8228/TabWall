const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { indexedDB, IDBDatabase } = require("fake-indexeddb");

test("background message entrypoints share one durable store and restore by record ID", async () => {
  await deleteDatabase();
  const state = {
    tabs: [{ id: 1, windowId: 1, incognito: false, url: "extension://test-extension/manager.html" }],
    nextTabId: 2,
    storageNotifications: 0
  };
  const listeners = {
    message: null,
    activated: null
  };
  const chrome = {
    runtime: {
      id: "test-extension",
      getURL(file) {
        return `extension://test-extension/${file}`;
      },
      sendMessage(message) {
        if (message?.type === "storage-updated") {
          state.storageNotifications += 1;
        }
        return Promise.resolve({});
      },
      onMessage: {
        addListener(listener) {
          listeners.message = listener;
        }
      },
      onInstalled: { addListener() {} }
    },
    storage: {
      local: {
        async get(key) {
          if (key === "tabwallSession") {
            return {
              tabwallSession: {
                savedAt: "2026-09-12T10:00:00.000Z",
                tabs: [{ title: "Migrated", url: "https://example.com/migrated", index: 0 }]
              }
            };
          }
          return {};
        }
      }
    },
    contextMenus: {
      remove() { return Promise.resolve(); },
      create() {},
      onClicked: { addListener() {} }
    },
    action: { onClicked: { addListener() {} } },
    tabs: {
      onActivated: {
        addListener(listener) {
          listeners.activated = listener;
        }
      },
      async query(query) {
        return state.tabs.filter((tab) => (
          query?.windowId === undefined || tab.windowId === query.windowId
        ));
      },
      async create(options) {
        const tab = {
          id: state.nextTabId++,
          windowId: options.windowId,
          incognito: false,
          url: options.url,
          active: Boolean(options.active)
        };
        state.tabs.push(tab);
        return tab;
      },
      async update(id, changes) {
        const tab = state.tabs.find((candidate) => candidate.id === id);
        Object.assign(tab, changes);
        return tab;
      },
      async get(id) {
        return state.tabs.find((candidate) => candidate.id === id);
      },
      async remove(ids) {
        const removed = new Set(Array.isArray(ids) ? ids : [ids]);
        state.tabs = state.tabs.filter((tab) => !removed.has(tab.id));
      }
    }
  };
  const context = vm.createContext({
    chrome,
    indexedDB,
    IDBDatabase,
    crypto: { randomUUID: (() => {
      let counter = 0;
      return () => "integration-id-" + (++counter);
    })() },
    console,
    URL,
    URLSearchParams,
    fetch: async () => ({ ok: false })
  });
  vm.runInContext(fs.readFileSync("storage-db.js", "utf8"), context);
  context.importScripts = () => {};
  vm.runInContext(fs.readFileSync("background.js", "utf8"), context);

  const managerSender = {
    id: "test-extension",
    url: "extension://test-extension/manager.html",
    tab: { windowId: 1, incognito: false }
  };
  await dispatch({ type: "storage-command", scope: "normal", command: "list" }, managerSender, listeners);
  assert.equal(state.storageNotifications, 0, "read-only list must not trigger a refresh notification");
  await Promise.all([
    dispatch({
      type: "storage-command",
      scope: "normal",
      command: "capture",
      tabs: [{ title: "One", url: "https://example.com/one" }]
    }, managerSender, listeners),
    dispatch({
      type: "storage-command",
      scope: "normal",
      command: "capture",
      tabs: [
        { title: "Two", url: "https://example.com/two" },
        { title: "Bilibili video", url: "https://www.bilibili.com/video/BV1xx411c7mD" },
        { title: "YouTube video", url: "https://www.youtube.com/watch?v=test" }
      ]
    }, managerSender, listeners)
  ]);

  const listed = await dispatch({ type: "storage-command", scope: "normal", command: "list" }, managerSender, listeners);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.data.map((tab) => tab.title), ["Migrated", "One", "Two", "Bilibili video", "YouTube video"]);
  assert.ok(listed.data.every((tab) => tab.id));

  const restored = await dispatch({
    type: "restore-tabs",
    scope: "normal",
    ids: listed.data.map((tab) => tab.id),
    windowId: 1
  }, managerSender, listeners);
  assert.deepEqual(
    { created: restored.created, reused: restored.reused, failed: restored.failed },
    { created: 5, reused: 0, failed: 0 }
  );

  const lazyTab = state.tabs.find((tab) => tab.url.includes("lazy-tab.html"));
  assert.ok(lazyTab);
  const lazyActivation = await dispatch({ type: "activate-lazy-tab" }, {
    id: "test-extension",
    url: lazyTab.url,
    tab: { id: lazyTab.id, windowId: 1, incognito: false }
  }, listeners);
  assert.equal(lazyActivation.ok, true);
  await listeners.activated({ tabId: lazyTab.id });
  for (let attempt = 0; attempt < 20 && lazyTab.url.includes("lazy-tab.html"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(lazyTab.url, /^https:\/\/example\.com\//);

  const afterRestore = await dispatch({ type: "storage-command", scope: "normal", command: "list" }, managerSender, listeners);
  assert.equal(afterRestore.data.length, 5);
});

function dispatch(message, sender, listeners) {
  return new Promise((resolve) => {
    listeners.message(message, sender, resolve);
  });
}

async function deleteDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("tabwall");
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("test database deletion was blocked"));
  });
}
