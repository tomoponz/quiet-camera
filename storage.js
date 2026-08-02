"use strict";

const DB_NAME = "quiet-camera-db";
const DB_VERSION = 1;
const MEDIA_STORE = "media";
const CHUNK_STORE = "recordingChunks";
const SESSION_STORE = "recordingSessions";
const SETTINGS_KEY = "quiet-camera-settings-v3";

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

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MEDIA_STORE)) {
        const store = database.createObjectStore(MEDIA_STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        const store = database.createObjectStore(CHUNK_STORE, { keyPath: ["sessionId", "index"] });
        store.createIndex("sessionId", "sessionId");
      }
      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        database.createObjectStore(SESSION_STORE, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("IndexedDB could not be opened")), { once: true });
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

async function listStoredMedia() {
  const database = await openDatabase();
  const transaction = database.transaction(MEDIA_STORE, "readonly");
  const done = transactionDone(transaction);
  const items = await requestToPromise(transaction.objectStore(MEDIA_STORE).getAll());
  await done;
  return items.sort((a, b) => b.createdAt - a.createdAt);
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
  transaction.objectStore(CHUNK_STORE).put({ sessionId, index, blob });
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
  const readTransaction = database.transaction(CHUNK_STORE, "readonly");
  const readDone = transactionDone(readTransaction);
  const index = readTransaction.objectStore(CHUNK_STORE).index("sessionId");
  const keys = await requestToPromise(index.getAllKeys(IDBKeyRange.only(sessionId)));
  await readDone;
  if (!keys.length) return;

  const writeTransaction = database.transaction(CHUNK_STORE, "readwrite");
  const writeDone = transactionDone(writeTransaction);
  const store = writeTransaction.objectStore(CHUNK_STORE);
  keys.forEach((key) => store.delete(key));
  await writeDone;
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
