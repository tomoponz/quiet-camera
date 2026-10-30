"use strict";

const DB_NAME = "quiet-camera-db";
const DB_VERSION = 2;
const MEDIA_STORE = "media";
const CHUNK_STORE = "recordingChunks";
const SESSION_STORE = "recordingSessions";
const SETTINGS_KEY = "quiet-camera-settings-v3";
const DEFAULT_MEDIA_PAGE_SIZE = 60;
const DATABASE_BLOCKED_MESSAGE = "保存領域の更新を待っています。ほかのQuiet Cameraタブを閉じてください";

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

function reportDatabaseBlocked() {
  console.warn(DATABASE_BLOCKED_MESSAGE);
  if (typeof showToast === "function") showToast(DATABASE_BLOCKED_MESSAGE);
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
      // `blocked` is progress, not a terminal open failure. Keep this request
      // and shared promise pending so retries cannot queue extra open requests;
      // it will continue automatically after older tabs close their database.
      reportDatabaseBlocked();
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

// Completed recordings can own their existing chunks, avoiding a duplicate
// large IDB Blob allocation. The public storage API always returns full Blobs.
async function hydrateStoredMedia(media) {
  if(!media?.backingRecordingId)return media;
  const chunks=await getRecordingChunks(media.backingRecordingId);
  const bytes=chunks.reduce((sum,b)=>sum+b.size,0);
  if(bytes!==media.backingSizeBytes || chunks.length!==media.backingChunkCount)throw new Error("保存動画のチャンクを読み取れません。データは削除していません");
  const blob=new Blob(chunks,{type:media.mimeType||"video/webm"});
  return {...media,blob,previewBlob:blob};
}

async function deleteStoredMediaRecords(ids,{requireAll=false}={}) {
  if(!ids.length)return;
  const database=await openDatabase(),targets=new Set(ids);
  const transaction=database.transaction([MEDIA_STORE,CHUNK_STORE],"readwrite");
  const done=transactionDone(transaction);done.catch(()=>{});
  let failure=null;
  const store=transaction.objectStore(MEDIA_STORE),request=store.getAll();
  request.addEventListener("success",()=>{
    try {
      const records=request.result,selected=records.filter(m=>targets.has(m.id));
      if(requireAll && selected.length!==targets.size)throw new Error("選択した項目が履歴から削除されています。選び直してください");
      const liveReferences=new Set(records.filter(m=>!targets.has(m.id)).map(m=>m.backingRecordingId).filter(Boolean));
      const releaseIds=new Set(selected.map(m=>m.backingRecordingId).filter(id=>id&&!liveReferences.has(id)));
      for(const id of releaseIds){
        const chunks=transaction.objectStore(CHUNK_STORE),cursor=chunks.index("sessionId").openKeyCursor(IDBKeyRange.only(id));
        cursor.addEventListener("success",()=>{const c=cursor.result;if(c){chunks.delete(c.primaryKey);c.continue();}});
      }
      for(const id of targets)store.delete(id);
    }catch(error){failure=error;try{transaction.abort();}catch{}}
  });
  try{await done;}catch(error){throw failure||error;}
}

async function putMedia(media) {
  const database = await openDatabase();
  const transaction = database.transaction(MEDIA_STORE, "readwrite");
  const stored=media.backingRecordingId?{...media,blob:undefined,previewBlob:undefined}:media;
  transaction.objectStore(MEDIA_STORE).put(stored);
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
  return Promise.all(items.map(hydrateStoredMedia));
}

// Every record at or newer than minCreatedAt, newest first, read in one transaction.
// The open history uses it to re-read exactly the window the user has loaded.
async function listStoredMediaSince(minCreatedAt) {
  const database = await openDatabase();
  const transaction = database.transaction(MEDIA_STORE, "readonly");
  const done = transactionDone(transaction);
  const index = transaction.objectStore(MEDIA_STORE).index("createdAt");
  const items = await new Promise((resolve, reject) => {
    const results = [];
    const request = index.openCursor(IDBKeyRange.lowerBound(Number(minCreatedAt) || 0), "prev");
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor) { resolve(results); return; }
      results.push(cursor.value);
      cursor.continue();
    });
    request.addEventListener("error", () => reject(request.error || new Error("撮影履歴を読み込めませんでした")), { once: true });
  });
  await done;
  return Promise.all(items.map(hydrateStoredMedia));
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
  return item ? hydrateStoredMedia(item) : null;
}

// Match the gallery's createdAt/primary-key order without loading every Blob.
// The inclusive bound also handles media with identical capture timestamps.
// PDFs made from existing photos (review "PDF" / history multi-page) are documents, not shots.
// Older records have no origin field: their meta is "PDF · Nページ · ..." (captured PDFs: "PDF · W×H · ...").
function isDerivedPdf(media) {
  if (media?.mimeType !== "application/pdf" && media?.extension !== "pdf") return false;
  return media.origin === "pdf-export" || /^PDF · \d+ページ/.test(media.meta || "");
}

async function findAdjacentMedia(reference, direction) {
  if (!reference || !Number.isFinite(reference.createdAt) || reference.id == null) return null;
  if (!["older", "newer"].includes(direction)) throw new TypeError("Unknown media direction");
  const database = await openDatabase();
  const transaction = database.transaction(MEDIA_STORE, "readonly");
  const done = transactionDone(transaction);
  const older = direction === "older";
  // Preserve transaction errors while avoiding a second unhandled rejection if
  // the cursor request fails before the transaction's completion is awaited.
  done.catch(() => {});
  const range = older ? IDBKeyRange.upperBound(reference.createdAt) : IDBKeyRange.lowerBound(reference.createdAt);
  const result = await new Promise((resolve, reject) => {
    const request = transaction.objectStore(MEDIA_STORE).index("createdAt").openCursor(range, older ? "prev" : "next");
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor) { resolve(null); return; }
      const order = cursor.key === reference.createdAt ? indexedDB.cmp(cursor.primaryKey, reference.id)
        : cursor.key < reference.createdAt ? -1 : 1;
      const media = cursor.value;
      if ((older ? order < 0 : order > 0) && ["photo", "video"].includes(media.kind) && !isDerivedPdf(media)) {
        resolve({ id: cursor.primaryKey, createdAt: cursor.key });
      } else cursor.continue();
    });
    request.addEventListener("error", () => reject(request.error || new Error("前後の撮影結果を読み込めませんでした")), { once: true });
  });
  await done;
  return result;
}

async function deleteStoredMedia(id) {
  await deleteStoredMediaRecords([id]);
}

async function putRecordingSession(session) {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readwrite");
  transaction.objectStore(SESSION_STORE).put(session);
  await transactionDone(transaction);
}

async function getRecordingSession(sessionId) {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE,"readonly");
  const done = transactionDone(transaction);
  const result = await requestToPromise(transaction.objectStore(SESSION_STORE).get(sessionId));
  await done;
  return result || null;
}

// One transaction prevents an interrupted cleanup from leaving half a session.
async function deleteRecordingSessionData(sessionId) {
  const database = await openDatabase();
  const transaction = database.transaction([CHUNK_STORE,SESSION_STORE],"readwrite");
  const done = transactionDone(transaction);
  done.catch(() => {});
  const store = transaction.objectStore(CHUNK_STORE);
  const request = store.index("sessionId").openKeyCursor(IDBKeyRange.only(sessionId));
  request.addEventListener("success", () => {
    const cursor=request.result;
    if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); }
    else transaction.objectStore(SESSION_STORE).delete(sessionId);
  });
  request.addEventListener("error", () => { try { transaction.abort(); } catch {} });
  await done;
}

// Atomic promotion transfers ownership of existing chunks to completed media.
// If any request fails, the transaction preserves the session and all chunks.
async function commitRecordingMedia(media, sessionId) {
  const database=await openDatabase();
  const transaction=database.transaction([MEDIA_STORE,CHUNK_STORE,SESSION_STORE],"readwrite");
  const done=transactionDone(transaction);done.catch(()=>{});
  const request=transaction.objectStore(CHUNK_STORE).index("sessionId").getAll(IDBKeyRange.only(sessionId));
  let failure=null;
  request.addEventListener("success",()=>{
    try {
      const chunks=request.result;
      const bytes=chunks.reduce((sum,c)=>sum+c.blob.size,0);
      if(bytes!==media.blob.size || !chunks.length)throw new Error("録画チャンクの整合性を確認できないため保持します");
      const stored={...media,blob:undefined,previewBlob:undefined,backingRecordingId:sessionId,backingSizeBytes:bytes,backingChunkCount:chunks.length};
      transaction.objectStore(MEDIA_STORE).put(stored);
      transaction.objectStore(SESSION_STORE).delete(sessionId);
    }catch(error){failure=error;try{transaction.abort();}catch{}}
  });
  try{await done;}catch(error){throw failure||error;}
  return media;
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
