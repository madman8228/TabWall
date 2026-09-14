const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { indexedDB, IDBDatabase } = require("fake-indexeddb");

test("toolbar capture opens TabWall in the window where the action was clicked", async () => {
  await deleteDatabase();
  const state = {
    tabs: [
      { id: 1, windowId: 1, incognito: false, url: "https://example.com/one", title: "One", index: 0 },
      { id: 2, windowId: 2, incognito: false, url: "extension://test-extension/manager.html", title: "TabWall", index: 0 }
    ],
    nextTabId: 3,
    actionListener: null,
    contextMenuListener: null,
    commandListener: null,
    messageListener: null
  };
  const chrome = {
    runtime: {
      id: "test-extension",
      getURL(file) {
        return `extension://test-extension/${file}`;
      },
      onMessage: {
        addListener(listener) {
          state.messageListener = listener;
        }
      },
      onInstalled: { addListener() {} }
    },
    i18n: { getMessage() { return ""; } },
    storage: {
      local: {
        async get() { return {}; }
      }
    },
    contextMenus: {
      remove() { return Promise.resolve(); },
      create() {},
      onClicked: {
        addListener(listener) {
          state.contextMenuListener = listener;
        }
      }
    },
    commands: {
      onCommand: {
        addListener(listener) {
          state.commandListener = listener;
        }
      }
    },
    action: {
      onClicked: {
        addListener(listener) {
          state.actionListener = listener;
        }
      }
    },
    tabs: {
      onActivated: { addListener() {} },
      async query(query) {
        return state.tabs.filter((tab) => (
          query?.windowId === undefined || tab.windowId === query.windowId
        ));
      },
      async create(options) {
        const tab = {
          id: state.nextTabId++,
          windowId: options.windowId ?? 99,
          incognito: false,
          url: options.url,
          active: Boolean(options.active)
        };
        state.tabs.push(tab);
        return tab;
      },
      async update(id, changes) {
        const tab = state.tabs.find((candidate) => candidate.id === id);
        assert.ok(tab);
        Object.assign(tab, changes);
        return tab;
      },
      async reload() {},
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
    crypto: { randomUUID: () => "toolbar-action-id" },
    console,
    URL,
    URLSearchParams,
    fetch: async () => ({ ok: false })
  });
  vm.runInContext(fs.readFileSync("storage-db.js", "utf8"), context);
  context.importScripts = () => {};
  vm.runInContext(fs.readFileSync("background.js", "utf8"), context);

  assert.equal(typeof state.actionListener, "function");
  await state.actionListener(state.tabs[0]);

  const currentWindowTabs = state.tabs.filter((tab) => tab.windowId === 1);
  assert.equal(
    currentWindowTabs.some((tab) => tab.url === "extension://test-extension/manager.html"),
    true,
    "the manager must be opened in the clicked window"
  );

  state.tabs = state.tabs.filter((tab) => tab.url !== "extension://test-extension/manager.html");
  await state.contextMenuListener(
    { menuItemId: "tabwall-open-manager" },
    { windowId: 1, incognito: false }
  );
  assert.equal(
    state.tabs.some((tab) => tab.windowId === 1 && tab.url === "extension://test-extension/manager.html"),
    true,
    "the context-menu command must recreate TabWall in the current window"
  );

  state.tabs = [{ id: 10, windowId: 3, incognito: false, url: "https://example.com/shortcut" }];
  await state.commandListener("open-tabwall");
  assert.equal(
    state.tabs.some((tab) => tab.windowId === 3 && tab.url === "extension://test-extension/manager.html"),
    true,
    "the keyboard shortcut must open TabWall in the focused window"
  );
});

async function deleteDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("tabwall");
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("test database deletion was blocked"));
  });
}
