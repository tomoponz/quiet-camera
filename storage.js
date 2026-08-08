"use strict";

const DB_NAME = "quiet-camera-db";
const DB_VERSION = 2;
const MEDIA_STORE = "media";
const CHUNK_STORE = "recordingChunks";
const SESSION_STORE = "recordingSessions";
const SETTINGS_KEY = "quiet-camera-settings-v3";
const DEFAULT_MEDIA_PAGE_SIZE = 60;

let databasePromise = null;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("IndexedDB request failed")), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error || new Error("IndexedDB transaction aborted")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error || new Error("IndexedDB transaction failed")), { once: true });
  });
}

function resetDatabasePromise() {
  databasePromise = null;
}

function openDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      let mediaStore;
      if (!database.objectStoreNames.contains(MEDIA_STORE)) {
        mediaStore = database.createObjectStore(MEDIA_STORE, { keyPath: "id" });
      } else {
        mediaStore = request.transaction.objectStore(MEDIA_STORE);
      }
      if (!mediaStore.indexNames.contains("createdAt")) mediaStore.createIndex("createdAt", "createdAt");

      let chunkStore;
      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        chunkStore = database.createObjectStore(CHUNK_STORE, { keyPath: ["sessionId", "index"] });
      } else {
        chunkStore = request.transaction.objectStore(CHUNK_STORE);
      }
      if (!chunkStore.indexNames.contains("sessionId")) chunkStore.createIndex("sessionId", "sessionId");

      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        database.createObjectStore(SESSION_STORE, { keyPath: "id" });
      }
    });

    request.addEventListener("success", () => {
      const database = request.result;
      database.addEventListener("versionchange", () => {
        database.close();
        resetDatabasePromise();
      });
      database.addEventListener("close", resetDatabasePromise);
      resolve(database);
    }, { once: true });

    request.addEventListener("blocked", () => {
      resetDatabasePromise();
      reject(new Error("別のQuiet Cameraタブが保存領域を使用中です。ほかのタブを閉じて再試行してください"));
    }, { once: true });

    request.addEventListener("error", () => {
      resetDatabasePromise();
      reject(request.error || new Error("IndexedDB could not be opened"));
    }, { once: true });
  }).catch((error) => {
    resetDatabasePromise();
    throw error;
  });

  return databasePromise;
}

async function putMedia(media) {
  const database = await openDatabase();
  const transaction = database.transaction(MEDIA_STORE, "readwrite");
  transaction.objectStore(MEDIA_STORE).put(media);
  await transactionDone(transaction);
  return media;
}

async function listStoredMediaPage({ offset = 0, limit = DEFAULT_MEDIA_PAGE_SIZE } = {}) {
  const database = await openDatabase();
  const transaction = database.transaction(MEDIA_STORE, "readonly");
  const done = transactionDone(transaction);
  const index = transaction.objectStore(MEDIA_STORE).index("createdAt");
  const normalizedOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const normalizedLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || DEFAULT_MEDIA_PAGE_SIZE)));

  const items = await new Promise((resolve, reject) => {
    const results = [];
    const request = index.openCursor(null, "prev");
    let skipped = 0;
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor || results.length >= normalizedLimit) {
        resolve(results);
        return;
      }
      if (skipped < normalizedOffset) {
        skipped += 1;
        cursor.continue();
        return;
      }
      results.push(cursor.value);
      cursor.continue();
    });
    request.addEventListener("error", () => reject(request.error || new Error("撮影履歴を読み込めませんでした")), { once: true });
  });

  await done;
  return items;
}

async function listStoredMedia() {
  return listStoredMediaPage({ offset: 0, limit: DEFAULT_MEDIA_PAGE_SIZE });
}

async function countStoredMedia() {
  const database = await openDatabase();
  const transaction = database.transaction(MEDIA_STORE, "readonly");
  const done = transactionDone(transaction);
  const count = await requestToPromise(transaction.objectStore(MEDIA_STORE).count());
  await done;
  return Number(count) || 0;
}

async function getStoredMedia(id) {
  const database = await openDatabase();
  const transaction = database.transaction(MEDIA_STORE, "readonly");
  const done = transactionDone(transaction);
  const item = await requestToPromise(transaction.objectStore(MEDIA_STORE).get(id));
  await done;
  return item || null;
}

async function deleteStoredMedia(id) {
  const database = await openDatabase();
  const transaction = database.transaction(MEDIA_STORE, "readwrite");
  transaction.objectStore(MEDIA_STORE).delete(id);
  await transactionDone(transaction);
}

async function putRecordingSession(session) {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readwrite");
  transaction.objectStore(SESSION_STORE).put(session);
  await transactionDone(transaction);
}

async function listRecordingSessions() {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readonly");
  const done = transactionDone(transaction);
  const items = await requestToPromise(transaction.objectStore(SESSION_STORE).getAll());
  await done;
  return items;
}

async function deleteRecordingSession(sessionId) {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readwrite");
  transaction.objectStore(SESSION_STORE).delete(sessionId);
  await transactionDone(transaction);
}

async function putRecordingChunk(sessionId, index, blob) {
  const database = await openDatabase();
  const transaction = database.transaction(CHUNK_STORE, "readwrite");
  transaction.objectStore(CHUNK_STORE).put({ sessionId, index, blob, size: blob.size });
  await transactionDone(transaction);
}

async function getRecordingChunks(sessionId) {
  const database = await openDatabase();
  const transaction = database.transaction(CHUNK_STORE, "readonly");
  const done = transactionDone(transaction);
  const index = transaction.objectStore(CHUNK_STORE).index("sessionId");
  const items = await requestToPromise(index.getAll(IDBKeyRange.only(sessionId)));
  await done;
  return items.sort((a, b) => a.index - b.index).map((item) => item.blob);
}

async function deleteRecordingChunks(sessionId) {
  const database = await openDatabase();
  const transaction = database.transaction(CHUNK_STORE, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(CHUNK_STORE);
  const index = store.index("sessionId");

  await new Promise((resolve, reject) => {
    const request = index.openKeyCursor(IDBKeyRange.only(sessionId));
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      cursor.continue();
    });
    request.addEventListener("error", () => reject(request.error || new Error("録画チャンクを削除できませんでした")), { once: true });
  });

  await done;
}

function loadSavedSettings(defaults) {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return { ...defaults, ...saved, microphone: "off" };
  } catch {
    return { ...defaults, microphone: "off" };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, microphone: "off" }));
  } catch (error) {
    console.warn("Settings could not be saved.", error);
  }
}

async function getStorageBudget() {
  if (!navigator.storage?.estimate) return { quota: null, usage: null, available: null };
  try {
    const estimate = await navigator.storage.estimate();
    const quota = Number(estimate.quota) || null;
    const usage = Number(estimate.usage) || 0;
    return { quota, usage, available: quota ? Math.max(0, quota - usage) : null };
  } catch {
    return { quota: null, usage: null, available: null };
  }
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try {
    if (navigator.storage.persisted && await navigator.storage.persisted()) return true;
    return Boolean(await navigator.storage.persist());
  } catch (error) {
    console.warn("Persistent storage request failed.", error);
    return false;
  }
}
