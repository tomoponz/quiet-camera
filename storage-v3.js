"use strict";

const QuietStorage = (() => {
  const DB_NAME = "quiet-camera";
  const DB_VERSION = 3;
  const MEDIA_STORE = "media";
  const CHUNK_STORE = "recordingChunks";
  const SESSION_STORE = "recordingSessions";
  let dbPromise = null;

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB操作に失敗しました"));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDBトランザクションが中断されました"));
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDBトランザクションに失敗しました"));
    });
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(MEDIA_STORE)) {
          const store = db.createObjectStore(MEDIA_STORE, { keyPath: "id" });
          store.createIndex("createdAt", "createdAt");
          store.createIndex("kind", "kind");
        }
        if (!db.objectStoreNames.contains(CHUNK_STORE)) {
          const store = db.createObjectStore(CHUNK_STORE, { keyPath: ["recordingId", "index"] });
          store.createIndex("recordingId", "recordingId");
        }
        if (!db.objectStoreNames.contains(SESSION_STORE)) {
          db.createObjectStore(SESSION_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("保存領域を開けませんでした"));
      request.onblocked = () => reject(new Error("別のタブが保存領域を使用中です"));
    });
    return dbPromise;
  }

  async function saveMedia(media) {
    const db = await open();
    const tx = db.transaction(MEDIA_STORE, "readwrite");
    tx.objectStore(MEDIA_STORE).put(media);
    await transactionDone(tx);
    return media;
  }

  async function getMedia(id) {
    const db = await open();
    const tx = db.transaction(MEDIA_STORE, "readonly");
    const result = await requestToPromise(tx.objectStore(MEDIA_STORE).get(id));
    await transactionDone(tx);
    return result || null;
  }

  async function listMedia() {
    const db = await open();
    const tx = db.transaction(MEDIA_STORE, "readonly");
    const result = await requestToPromise(tx.objectStore(MEDIA_STORE).getAll());
    await transactionDone(tx);
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  async function deleteMedia(id) {
    const db = await open();
    const tx = db.transaction(MEDIA_STORE, "readwrite");
    tx.objectStore(MEDIA_STORE).delete(id);
    await transactionDone(tx);
  }

  async function deleteMediaMany(ids) {
    const db = await open();
    const tx = db.transaction(MEDIA_STORE, "readwrite");
    const store = tx.objectStore(MEDIA_STORE);
    ids.forEach((id) => store.delete(id));
    await transactionDone(tx);
  }

  async function clearMedia() {
    const db = await open();
    const tx = db.transaction(MEDIA_STORE, "readwrite");
    tx.objectStore(MEDIA_STORE).clear();
    await transactionDone(tx);
  }

  async function saveRecordingSession(session) {
    const db = await open();
    const tx = db.transaction(SESSION_STORE, "readwrite");
    tx.objectStore(SESSION_STORE).put(session);
    await transactionDone(tx);
  }

  async function listRecordingSessions() {
    const db = await open();
    const tx = db.transaction(SESSION_STORE, "readonly");
    const result = await requestToPromise(tx.objectStore(SESSION_STORE).getAll());
    await transactionDone(tx);
    return result;
  }

  async function deleteRecordingSession(id) {
    const db = await open();
    const tx = db.transaction(SESSION_STORE, "readwrite");
    tx.objectStore(SESSION_STORE).delete(id);
    await transactionDone(tx);
  }

  async function saveRecordingChunk(recordingId, index, blob) {
    const db = await open();
    const tx = db.transaction(CHUNK_STORE, "readwrite");
    tx.objectStore(CHUNK_STORE).put({ recordingId, index, blob, size: blob.size });
    await transactionDone(tx);
  }

  async function listRecordingChunks(recordingId) {
    const db = await open();
    const tx = db.transaction(CHUNK_STORE, "readonly");
    const index = tx.objectStore(CHUNK_STORE).index("recordingId");
    const result = await requestToPromise(index.getAll(IDBKeyRange.only(recordingId)));
    await transactionDone(tx);
    return result.sort((a, b) => a.index - b.index);
  }

  async function deleteRecordingChunks(recordingId) {
    const db = await open();
    const tx = db.transaction(CHUNK_STORE, "readwrite");
    const store = tx.objectStore(CHUNK_STORE);
    const index = store.index("recordingId");
    await new Promise((resolve, reject) => {
      const request = index.openKeyCursor(IDBKeyRange.only(recordingId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error("録画チャンクを削除できませんでした"));
    });
    await transactionDone(tx);
  }

  async function estimate() {
    if (!navigator.storage?.estimate) return null;
    const result = await navigator.storage.estimate();
    return {
      usage: Number(result.usage || 0),
      quota: Number(result.quota || 0),
      available: Math.max(0, Number(result.quota || 0) - Number(result.usage || 0)),
    };
  }

  async function persist() {
    if (!navigator.storage?.persist) return false;
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }

  return {
    open,
    saveMedia,
    getMedia,
    listMedia,
    deleteMedia,
    deleteMediaMany,
    clearMedia,
    saveRecordingSession,
    listRecordingSessions,
    deleteRecordingSession,
    saveRecordingChunk,
    listRecordingChunks,
    deleteRecordingChunks,
    estimate,
    persist,
  };
})();
