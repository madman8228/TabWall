const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { indexedDB, IDBDatabase } = require("fake-indexeddb");

test("TabWall storage migrates safely and serializes concurrent changes", async () => {
  await deleteDatabase();
  const source = fs.readFileSync("storage-db.js", "utf8");
  const context = vm.createContext({
    indexedDB,
    IDBDatabase,
    crypto: { randomUUID: (() => {
      let counter = 0;
      return () => "test-id-" + (++counter);
    })() },
    console
  });
  vm.runInContext(source, context);
  const store = context.TabWallStore;
  const legacy = {
    tabwallSession: {
      savedAt: "2026-09-12T10:00:00.000Z",
      tabs: [
        { index: 0, title: "One", url: "https://example.com/one", favIconUrl: "" },
        { index: 1, title: "Two", url: "https://example.com/two", favIconUrl: "" }
      ]
    }
  };
  const legacyStorage = {
    async get(key) {
      return { [key]: legacy[key] };
    }
  };

  const migration = await store.initialize("normal", legacyStorage);
  assert.equal(migration.migrated, true);
  assert.deepEqual((await store.list("normal")).map((tab) => tab.title), ["One", "Two"]);

  await Promise.all([
    store.capture("normal", [{ title: "Three", url: "https://example.com/three" }]),
    store.capture("normal", [{ title: "Four", url: "https://example.com/four" }])
  ]);
  let tabs = await store.list("normal");
  assert.deepEqual(tabs.map((tab) => tab.title), ["One", "Two", "Three", "Four"]);

  await store.reorder("normal", [tabs[3].id, tabs[0].id]);
  tabs = await store.list("normal");
  assert.deepEqual(tabs.map((tab) => tab.title), ["Four", "One", "Two", "Three"]);

  const trashed = await store.trash("normal", [tabs[1].id]);
  assert.equal(trashed.changed, 1);
  assert.equal((await store.list("normal")).length, 3);
  assert.equal((await store.listTrash("normal")).length, 1);
  await store.restoreTrash("normal", [tabs[1].id]);
  assert.equal((await store.list("normal")).length, 4);

  const exported = await store.export("normal");
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.tabs.length, 4);

  const cleared = await store.clear("normal");
  assert.equal(cleared.changed, 4);
  assert.deepEqual(await store.list("normal"), []);
  assert.equal((await store.listTrash("normal")).length, 0);

  await store.initialize("private", {
    async get() {
      return {};
    }
  });
  assert.deepEqual(await store.list("private"), []);

  await assert.rejects(
    () => store.import("normal", { tabs: [{ title: "Bad", url: "file:///bad" }] }),
    (error) => error.code === "INVALID_TAB"
  );
  assert.equal((await store.list("normal")).length, 0);
});

test("TabWall data remains available when the extension runtime is reopened", async () => {
  await deleteDatabase();
  const firstStore = loadStore("restart-a");
  await firstStore.initialize("normal", {
    async get() {
      return {};
    }
  });
  await firstStore.capture("normal", [{ title: "Survives restart", url: "https://example.com/restart" }]);

  const secondStore = loadStore("restart-b");
  await secondStore.initialize("normal", {
    async get() {
      return {
        tabwallSession: {
          savedAt: "2099-01-01T00:00:00.000Z",
          tabs: [{ title: "Should not be imported again", url: "https://example.com/duplicate" }]
        }
      };
    }
  });

  assert.deepEqual((await secondStore.list("normal")).map((tab) => tab.title), ["Survives restart"]);
});

function loadStore(prefix) {
  const source = fs.readFileSync("storage-db.js", "utf8");
  const context = vm.createContext({
    indexedDB,
    IDBDatabase,
    crypto: { randomUUID: () => prefix + "-" + Date.now() + "-" + Math.random() },
    console
  });
  vm.runInContext(source, context);
  return context.TabWallStore;
}

async function deleteDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("tabwall");
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("test database deletion was blocked"));
  });
}
