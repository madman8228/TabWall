(function exposeTabWallStore(global) {
  "use strict";

  const DB_NAME = "tabwall";
  const DB_VERSION = 1;
  const META_STORE = "meta";
  const TABS_STORE = "tabs";
  const SNAPSHOTS_STORE = "snapshots";
  const MAX_SNAPSHOTS = 5;
  const SCOPES = new Set(["normal", "private"]);
  const initializationPromises = new Map();
  let databasePromise;

  const store = {
    DB_NAME,
    DB_VERSION,
    async initialize(scope, legacyStorage) {
      assertScope(scope);
      if (initializationPromises.has(scope)) {
        return initializationPromises.get(scope);
      }

      const promise = migrateIfNeeded(scope, legacyStorage);
      initializationPromises.set(scope, promise);
      try {
        return await promise;
      } catch (error) {
        initializationPromises.delete(scope);
        throw error;
      }
    },
    async list(scope, options = {}) {
      assertScope(scope);
      const includeDeleted = Boolean(options.includeDeleted);
      const database = await openDatabase();
      const records = await readAll(database, TABS_STORE);
      return records
        .filter((record) => record.scope === scope && (includeDeleted || !record.deletedAt))
        .sort(compareRecords);
    },
    async listTrash(scope) {
      assertScope(scope);
      const database = await openDatabase();
      const records = await readAll(database, TABS_STORE);
      return records
        .filter((record) => record.scope === scope && Boolean(record.deletedAt))
        .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
    },
    async capture(scope, incomingTabs) {
      assertScope(scope);
      const candidates = normalizeIncomingTabs(scope, incomingTabs);
      const result = await runTransaction([META_STORE, TABS_STORE], "readwrite", async (transaction) => {
        const tabsStore = transaction.objectStore(TABS_STORE);
        const metaStore = transaction.objectStore(META_STORE);
        const allTabs = await request(tabsStore.getAll());
        const activeTabs = allTabs.filter((tab) => tab.scope === scope && !tab.deletedAt);
        const byIdentity = new Map(activeTabs.map((tab) => [identityOf(tab), tab]));
        let nextPosition = activeTabs.reduce((max, tab) => Math.max(max, Number(tab.position) || 0), -1) + 1;
        let nextOriginalOrder = allTabs.reduce((max, tab) => Math.max(max, Number(tab.originalOrder) || 0), -1) + 1;
        let changed = 0;

        for (const candidate of candidates) {
          const existing = byIdentity.get(identityOf(candidate));
          if (existing) {
            existing.lastAccessed = candidate.lastAccessed;
            existing.favIconUrl = candidate.favIconUrl || existing.favIconUrl;
            existing.title = candidate.title || existing.title;
            tabsStore.put(existing);
            changed += 1;
            continue;
          }

          const created = {
            ...candidate,
            id: createId(),
            originalOrder: nextOriginalOrder,
            position: nextPosition,
            deletedAt: null
          };
          nextOriginalOrder += 1;
          nextPosition += 1;
          byIdentity.set(identityOf(created), created);
          tabsStore.put(created);
          changed += 1;
        }

        const revision = await bumpRevision(metaStore, scope, changed > 0);
        return { revision, changed };
      });
      return { ...result, data: await store.list(scope) };
    },
    async reorder(scope, ids) {
      assertScope(scope);
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length) {
        throw createError("INVALID_ORDER", "The tab order contains duplicate IDs.");
      }
      const result = await runTransaction([META_STORE, TABS_STORE], "readwrite", async (transaction) => {
        const tabsStore = transaction.objectStore(TABS_STORE);
        const metaStore = transaction.objectStore(META_STORE);
        const allTabs = await request(tabsStore.getAll());
        const activeTabs = allTabs.filter((tab) => tab.scope === scope && !tab.deletedAt);
        const byId = new Map(activeTabs.map((tab) => [tab.id, tab]));
        const ordered = [];
        for (const id of ids) {
          const tab = byId.get(id);
          if (tab) {
            ordered.push(tab);
            byId.delete(id);
          }
        }
        ordered.push(...byId.values());
        ordered.forEach((tab, position) => {
          tab.position = position;
          tabsStore.put(tab);
        });
        const revision = await bumpRevision(metaStore, scope, ordered.length > 0);
        return { revision };
      });
      return { ...result, data: await store.list(scope) };
    },
    async trash(scope, ids = null) {
      assertScope(scope);
      return mutateDeleted(scope, ids, true);
    },
    async clear(scope) {
      assertScope(scope);
      const result = await runTransaction([META_STORE, TABS_STORE, SNAPSHOTS_STORE], "readwrite", async (transaction) => {
        const tabsStore = transaction.objectStore(TABS_STORE);
        const metaStore = transaction.objectStore(META_STORE);
        const snapshotsStore = transaction.objectStore(SNAPSHOTS_STORE);
        const allTabs = await request(tabsStore.getAll());
        const activeTabs = allTabs.filter((tab) => tab.scope === scope && !tab.deletedAt);
        await createSnapshot(snapshotsStore, scope, "clear", activeTabs, await readRevision(metaStore, scope));
        activeTabs.forEach((tab) => tabsStore.delete(tab.id));
        const revision = await bumpRevision(metaStore, scope, activeTabs.length > 0);
        await pruneSnapshots(snapshotsStore, scope);
        return { revision, changed: activeTabs.length };
      });
      return { ...result, data: await store.list(scope) };
    },
    async restoreTrash(scope, ids) {
      assertScope(scope);
      if (!Array.isArray(ids)) {
        throw createError("INVALID_IDS", "Trash restore requires an ID list.");
      }
      const result = await runTransaction([META_STORE, TABS_STORE], "readwrite", async (transaction) => {
        const tabsStore = transaction.objectStore(TABS_STORE);
        const metaStore = transaction.objectStore(META_STORE);
        const allTabs = await request(tabsStore.getAll());
        const selected = new Set(ids);
        const activeTabs = allTabs.filter((tab) => tab.scope === scope && !tab.deletedAt);
        let nextPosition = activeTabs.reduce((max, tab) => Math.max(max, Number(tab.position) || 0), -1) + 1;
        let changed = 0;
        allTabs.forEach((tab) => {
          if (tab.scope === scope && selected.has(tab.id) && tab.deletedAt) {
            tab.deletedAt = null;
            tab.position = nextPosition;
            nextPosition += 1;
            tabsStore.put(tab);
            changed += 1;
          }
        });
        const revision = await bumpRevision(metaStore, scope, changed > 0);
        return { revision, changed };
      });
      return { ...result, data: await store.list(scope) };
    },
    async import(scope, document) {
      assertScope(scope);
      const candidates = normalizeImportTabs(scope, document);
      const result = await runTransaction([META_STORE, TABS_STORE, SNAPSHOTS_STORE], "readwrite", async (transaction) => {
        const tabsStore = transaction.objectStore(TABS_STORE);
        const metaStore = transaction.objectStore(META_STORE);
        const snapshotsStore = transaction.objectStore(SNAPSHOTS_STORE);
        const allTabs = await request(tabsStore.getAll());
        const activeTabs = allTabs.filter((tab) => tab.scope === scope && !tab.deletedAt);
        await createSnapshot(snapshotsStore, scope, "import", activeTabs, await readRevision(metaStore, scope));
        const byIdentity = new Map(activeTabs.map((tab) => [identityOf(tab), tab]));
        let nextPosition = activeTabs.reduce((max, tab) => Math.max(max, Number(tab.position) || 0), -1) + 1;
        let nextOriginalOrder = allTabs.reduce((max, tab) => Math.max(max, Number(tab.originalOrder) || 0), -1) + 1;
        let imported = 0;
        let duplicates = 0;
        candidates.forEach((candidate) => {
          const existing = byIdentity.get(identityOf(candidate));
          if (existing) {
            duplicates += 1;
            return;
          }
          const created = {
            ...candidate,
            id: createId(),
            originalOrder: nextOriginalOrder,
            position: nextPosition,
            deletedAt: null
          };
          nextOriginalOrder += 1;
          nextPosition += 1;
          byIdentity.set(identityOf(created), created);
          tabsStore.put(created);
          imported += 1;
        });
        const revision = await bumpRevision(metaStore, scope, imported > 0);
        await pruneSnapshots(snapshotsStore, scope);
        return { revision, imported, duplicates };
      });
      return { ...result, data: await store.list(scope) };
    },
    async export(scope) {
      assertScope(scope);
      const database = await openDatabase();
      const meta = await readMeta(database, scope);
      return {
        schemaVersion: DB_VERSION,
        scope,
        exportedAt: new Date().toISOString(),
        revision: meta?.revision || 0,
        tabs: await store.list(scope)
      };
    },
    async revision(scope) {
      assertScope(scope);
      const database = await openDatabase();
      return readRevision(database, scope);
    }
  };

  global.TabWallStore = store;

  function assertScope(scope) {
    if (!SCOPES.has(scope)) {
      throw createError("INVALID_SCOPE", "Unknown TabWall storage scope.");
    }
  }

  async function migrateIfNeeded(scope, legacyStorage) {
    const database = await openDatabase();
    const meta = await readMeta(database, scope);
    if (meta?.migrationCompleted) {
      return { migrated: false, revision: meta.revision || 0 };
    }
    if (!legacyStorage || typeof legacyStorage.get !== "function") {
      throw createError("LEGACY_STORAGE_UNAVAILABLE", "Legacy storage is unavailable for migration.");
    }

    let legacyValue;
    try {
      const legacyKey = scope === "private" ? "tabwallSessionPrivate" : "tabwallSession";
      const legacyResult = await legacyStorage.get(legacyKey);
      legacyValue = legacyResult?.[legacyKey];
    } catch (error) {
      throw createError("LEGACY_READ_FAILED", error?.message || "Legacy storage could not be read.");
    }

    const tabs = normalizeLegacyTabs(scope, legacyValue);
    const result = await runTransaction([META_STORE, TABS_STORE], "readwrite", async (transaction) => {
      const metaStore = transaction.objectStore(META_STORE);
      const tabsStore = transaction.objectStore(TABS_STORE);
      const currentMeta = await request(metaStore.get(metaKey(scope)));
      if (currentMeta?.migrationCompleted) {
        return { migrated: false, revision: currentMeta.revision || 0 };
      }

      tabs.forEach((tab) => tabsStore.put(tab));
      const nextMeta = {
        key: metaKey(scope),
        scope,
        schemaVersion: DB_VERSION,
        revision: tabs.length > 0 ? 1 : 0,
        migrationCompleted: true,
        migratedAt: new Date().toISOString()
      };
      metaStore.put(nextMeta);
      return { migrated: tabs.length > 0, revision: nextMeta.revision };
    });
    return result;
  }

  function normalizeLegacyTabs(scope, legacySession) {
    if (legacySession === undefined || legacySession === null) {
      return [];
    }
    if (!legacySession || !Array.isArray(legacySession.tabs)) {
      throw createError("LEGACY_DATA_INVALID", "Legacy TabWall data is not a valid session.");
    }

    const savedAt = validDate(legacySession.savedAt) || new Date().toISOString();
    return legacySession.tabs.map((tab, index) => ({
      ...normalizeTab(scope, tab, index, savedAt),
      id: createId()
    }));
  }

  function normalizeImportTabs(scope, document) {
    if (!document || !Array.isArray(document.tabs)) {
      throw createError("IMPORT_INVALID", "The import file must contain a tabs array.");
    }
    return document.tabs.map((tab, index) => normalizeTab(scope, tab, index, new Date().toISOString()));
  }

  function normalizeIncomingTabs(scope, incomingTabs) {
    if (!Array.isArray(incomingTabs)) {
      return [];
    }
    return incomingTabs
      .filter((tab) => isWebUrl(tab?.url))
      .map((tab, index) => normalizeTab(scope, tab, index, new Date().toISOString()));
  }

  function normalizeTab(scope, tab, index, fallbackSavedAt) {
    if (!tab || !isWebUrl(tab.url)) {
      throw createError("INVALID_TAB", "A TabWall record contains an invalid web URL.");
    }
    return {
      scope,
      url: tab.url,
      title: typeof tab.title === "string" && tab.title ? tab.title : tab.url,
      favIconUrl: typeof tab.favIconUrl === "string" ? tab.favIconUrl : "",
      originalOrder: Number.isInteger(tab.originalOrder) ? tab.originalOrder : (Number.isInteger(tab.index) ? tab.index : index),
      position: Number.isInteger(tab.position) ? tab.position : (Number.isInteger(tab.index) ? tab.index : index),
      savedAt: validDate(tab.savedAt) || validDate(tab.capturedAt) || fallbackSavedAt,
      lastAccessed: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : null,
      deletedAt: null
    };
  }

  async function mutateDeleted(scope, ids, deleted) {
    const result = await runTransaction([META_STORE, TABS_STORE, SNAPSHOTS_STORE], "readwrite", async (transaction) => {
      const tabsStore = transaction.objectStore(TABS_STORE);
      const metaStore = transaction.objectStore(META_STORE);
      const snapshotsStore = transaction.objectStore(SNAPSHOTS_STORE);
      const allTabs = await request(tabsStore.getAll());
      const activeTabs = allTabs.filter((tab) => tab.scope === scope && !tab.deletedAt);
      await createSnapshot(snapshotsStore, scope, deleted ? "trash" : "restore", activeTabs, await readRevision(metaStore, scope));
      const selected = ids === null ? null : new Set(Array.isArray(ids) ? ids : []);
      let changed = 0;
      allTabs.forEach((tab) => {
        if (tab.scope !== scope || Boolean(tab.deletedAt) || (selected && !selected.has(tab.id))) {
          return;
        }
        tab.deletedAt = deleted ? new Date().toISOString() : null;
        tabsStore.put(tab);
        changed += 1;
      });
      const revision = await bumpRevision(metaStore, scope, changed > 0);
      await pruneSnapshots(snapshotsStore, scope);
      return { revision, changed };
    });
    return { ...result, data: await store.list(scope) };
  }

  async function createSnapshot(snapshotsStore, scope, reason, tabs, revision) {
    if (!tabs.length) {
      return;
    }
    snapshotsStore.put({
      id: createId(),
      scope,
      createdAt: new Date().toISOString(),
      reason,
      revision,
      tabs: tabs.map((tab) => ({ ...tab }))
    });
  }

  async function pruneSnapshots(snapshotsStore, scope) {
    const snapshots = await request(snapshotsStore.getAll());
    snapshots
      .filter((snapshot) => snapshot.scope === scope)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(MAX_SNAPSHOTS)
      .forEach((snapshot) => snapshotsStore.delete(snapshot.id));
  }

  async function bumpRevision(metaStore, scope, changed) {
    const key = metaKey(scope);
    const current = await request(metaStore.get(key));
    const revision = Number(current?.revision) || 0;
    if (!changed) {
      return revision;
    }
    const next = {
      ...(current || {}),
      key,
      scope,
      schemaVersion: DB_VERSION,
      revision: revision + 1,
      migrationCompleted: true
    };
    metaStore.put(next);
    return next.revision;
  }

  function metaKey(scope) {
    return "scope:" + scope;
  }

  async function readRevision(source, scope) {
    const meta = source && typeof source.transaction === "function"
      ? await readMeta(source, scope)
      : await request(source.get(metaKey(scope)));
    return Number(meta?.revision) || 0;
  }

  async function readMeta(database, scope) {
    const transaction = database.transaction(META_STORE, "readonly");
    const result = await request(transaction.objectStore(META_STORE).get(metaKey(scope)));
    await transactionDone(transaction);
    return result;
  }

  async function readAll(database, storeName) {
    const transaction = database.transaction(storeName, "readonly");
    const result = await request(transaction.objectStore(storeName).getAll());
    await transactionDone(transaction);
    return result;
  }

  async function runTransaction(storeNames, mode, worker) {
    const database = await openDatabase();
    const transaction = database.transaction(storeNames, mode);
    const done = transactionDone(transaction);
    try {
      const result = await worker(transaction);
      await done;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have failed or completed.
      }
      throw error;
    }
  }

  function openDatabase() {
    if (databasePromise) {
      return databasePromise;
    }
    if (typeof indexedDB === "undefined") {
      return Promise.reject(createError("INDEXEDDB_UNAVAILABLE", "IndexedDB is unavailable."));
    }

    databasePromise = new Promise((resolve, reject) => {
      const requestObject = indexedDB.open(DB_NAME, DB_VERSION);
      requestObject.onupgradeneeded = () => {
        const database = requestObject.result;
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(TABS_STORE)) {
          const tabsStore = database.createObjectStore(TABS_STORE, { keyPath: "id" });
          tabsStore.createIndex("byScope", "scope", { unique: false });
          tabsStore.createIndex("byScopePosition", ["scope", "position"], { unique: false });
          tabsStore.createIndex("byScopeDeleted", ["scope", "deletedAt"], { unique: false });
        }
        if (!database.objectStoreNames.contains(SNAPSHOTS_STORE)) {
          const snapshotsStore = database.createObjectStore(SNAPSHOTS_STORE, { keyPath: "id" });
          snapshotsStore.createIndex("byScopeCreatedAt", ["scope", "createdAt"], { unique: false });
        }
      };
      requestObject.onsuccess = () => {
        const database = requestObject.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      requestObject.onerror = () => {
        databasePromise = null;
        reject(createError("INDEXEDDB_OPEN_FAILED", requestObject.error?.message || "IndexedDB could not be opened."));
      };
      requestObject.onblocked = () => {
        databasePromise = null;
        reject(createError("INDEXEDDB_BLOCKED", "IndexedDB is blocked by another open version."));
      };
    });
    return databasePromise;
  }

  function request(requestObject) {
    return new Promise((resolve, reject) => {
      requestObject.onsuccess = () => resolve(requestObject.result);
      requestObject.onerror = () => reject(requestObject.error || new Error("IndexedDB request failed."));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."));
    });
  }

  function compareRecords(a, b) {
    return (Number(a.position) || 0) - (Number(b.position) || 0);
  }

  function identityOf(tab) {
    return tab.url + "\u0000" + tab.title;
  }

  function isWebUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url);
  }

  function validDate(value) {
    if (typeof value !== "string" && typeof value !== "number") {
      return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function createId() {
    if (global.crypto?.randomUUID) {
      return global.crypto.randomUUID();
    }
    return "tab-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function createError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
})(globalThis);
