"use strict";

// One policy distinguishes nominal stop budget, delayed-output allowance and
// conservative storage reserve. Keyframe timing is never a safety assumption.
const RECORDING_LIMITS = Object.freeze({
  targetBytes: 512 * 1024 * 1024,
  minimumBytes: 20 * 1024 * 1024,
  finalizationReserveBytes: 32 * 1024 * 1024,
  delayedOutputAllowanceBytes: 64 * 1024 * 1024,
  emptyMp4CleanupBytes: 64 * 1024,
  mp4KeyFrameIntervalMs: 1000,
});
const RECORDING_LOCK_PROTOCOL = 1;
const RECORDING_LOCK_PREFIX = "quiet-camera-recording:";
const RECORDING_SESSION_BUSY = "recording-session-busy";
const RECORDING_SESSION_MISSING = "recording-session-missing";
const RECORDING_SESSION_UNAVAILABLE = "recording-session-unavailable";
const deferredRecordingVerifications = new Set();

function calculateRecordingStopBytes(maxBytes, bitsPerSecond, largestChunk = 0) {
  const limit = Math.max(0, Number(maxBytes) || 0);
  const bytesPerSecond = Math.max(0, Number(bitsPerSecond) || 0) / 8;
  const headroom = Math.max(6 * bytesPerSecond, 2 * Math.max(0, largestChunk) + bytesPerSecond);
  return Math.max(Math.floor(limit * 0.5), Math.floor(limit - headroom));
}

function recordingFinalizeLimit(session, policy = RECORDING_LIMITS) {
  // The per-device nominal recording budget is a stopping target, not a second
  // lower recovery cap. Atomic promotion needs no second permanent Blob copy.
  return policy.targetBytes + policy.delayedOutputAllowanceBytes;
}

function recordingFinalizeSizeAllowed(size, session, policy = RECORDING_LIMITS) {
  return size > 0 && size <= recordingFinalizeLimit(session, policy);
}

function recordingLocksSupported() {
  return typeof navigator !== "undefined" && typeof navigator.locks?.request === "function";
}

// Fail closed when Web Locks is unavailable or fails. A timed heartbeat cannot
// prove that a suspended tab is dead, so it is not used to authorize deletion.
function holdRecordingLock(sessionId) {
  if (!recordingLocksSupported()) return Promise.reject(new Error("このブラウザでは安全なタブ間録画ロックを利用できません"));
  return new Promise((resolve, reject) => {
    try {
      const operation = navigator.locks.request(RECORDING_LOCK_PREFIX + sessionId, { ifAvailable: true }, (lock) => {
        if (!lock) { reject(new Error("録画セッションは別のタブで使用中です")); return; }
        return new Promise((release) => resolve(async () => { release(); await operation; }));
      });
      operation.catch(reject);
    } catch (error) { reject(error); }
  });
}

async function releaseRecordingLock() {
  const release = state.recordingLockRelease;
  state.recordingLockRelease = null;
  await release?.();
}

async function withIdleRecordingSession(reference, task) {
  if (!recordingLocksSupported()) return RECORDING_SESSION_UNAVAILABLE;
  let entered = false;
  try {
    return await navigator.locks.request(RECORDING_LOCK_PREFIX + reference.id, { ifAvailable: true }, async (lock) => {
      if (!lock) return RECORDING_SESSION_BUSY;
      entered = true;
      // The supplied list is only a hint: decisions always use the latest row
      // read after the lock is acquired, and hold it through writes and cleanup.
      const latest = await getRecordingSession(reference.id);
      return latest ? task(latest) : RECORDING_SESSION_MISSING;
    });
  } catch (error) {
    if (entered) throw error;
    console.warn("Recording session left untouched because its lock failed.", error);
    return RECORDING_SESSION_UNAVAILABLE;
  }
}

async function listIdleRecordingSessions(sessions = null) {
  const idle = [];
  let busy = 0, unavailable = 0;
  for (const reference of sessions || await listRecordingSessions()) {
    if (reference.id === state.recordingSessionId) { busy += 1; continue; }
    const result = await withIdleRecordingSession(reference, session => session);
    if (result === RECORDING_SESSION_UNAVAILABLE) unavailable += 1;
    else if (result === RECORDING_SESSION_BUSY) busy += 1;
    else if (result !== RECORDING_SESSION_MISSING) idle.push(result);
  }
  return { sessions: idle, busy, unavailable };
}

function recordingSessionRecord() {
  return {
    id: state.recordingSessionId, mediaId: state.recordingMediaId,
    lockProtocol: RECORDING_LOCK_PROTOCOL,
    createdAt: state.recordingCreatedAt,
    mimeType: state.recordingChunkMimeType || state.recordingMimeType,
    extension: state.recordingExtension, audio: state.recordingAudioEnabled,
    resolution: state.recordingResolution, bytes: state.recordingBytes,
    chunkCount: state.recordingChunkIndex, duration: state.recordingDurationMs,
    stopBytes: state.recordingStopBytes, stopObservedBytes: state.recordingStopObservedBytes || 0,
    largestChunkBytes: state.recordingLargestChunkBytes,
    finalizeLimitBytes: state.recordingFinalizeLimitBytes,
    keyFrameIntervalRequestedMs: state.recordingKeyFrameIntervalRequestedMs || 0,
    status: "recording",
  };
}

// Conservative top-level ISO-BMFF scan. Truncation, unfamiliar structure or a
// limit hit is UNKNOWN, never evidence that recoverable data can be deleted.
async function inspectMp4MediaData(blob) {
  if (!blob?.size) return "unknown";
  let offset = 0, sawFtyp = false;
  const known = new Set(["ftyp", "moov", "moof", "mdat", "free", "skip", "wide", "sidx", "mfra", "styp"]);
  for (let count = 0; offset < blob.size && count < 4096; count += 1) {
    if (blob.size - offset < 8) return "unknown";
    const view = new DataView(await blob.slice(offset, offset + 16).arrayBuffer());
    const type = String.fromCharCode(...Array.from({length:4}, (_, i) => view.getUint8(4+i)));
    let size = view.getUint32(0), header = 8;
    if (size === 1) {
      if (view.byteLength < 16) return "unknown";
      const big = view.getBigUint64(8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return "unknown";
      size = Number(big); header = 16;
    } else if (size === 0) size = blob.size - offset;
    if (size < header || !known.has(type)) return "unknown";
    if (type === "mdat" && Math.min(size, blob.size-offset) > header) return "media";
    if (size > blob.size-offset) return "unknown";
    if (type === "ftyp") {
      if (size < header+8) return "unknown";
      sawFtyp = true;
    }
    offset += size;
  }
  return sawFtyp && offset === blob.size ? "no-media" : "unknown";
}

async function isDefinitelyEmptyRecording(chunks, session) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  if (Number(session?.bytes || 0) > size || Number(session?.chunkCount || 0) > chunks.length) return false;
  if (size === 0) return true;
  if (size > RECORDING_LIMITS.emptyMp4CleanupBytes) return false;
  const type = chooseRecordedMimeType(chunks, "", session?.mimeType);
  if (!type.includes("mp4")) return false;
  return await inspectMp4MediaData(new Blob(chunks, {type})).catch(() => "unknown") === "no-media";
}

const HARD_RECORDING_LIMIT_BYTES = RECORDING_LIMITS.targetBytes;
const RECORDING_WARNING_BYTES = 384 * 1024 * 1024;
const MIN_RECORDING_LIMIT_BYTES = RECORDING_LIMITS.minimumBytes;
const RECORDING_FINALIZATION_RESERVE_BYTES = RECORDING_LIMITS.finalizationReserveBytes;
const AUTO_RECOVERY_MAX_SESSIONS = 3;
const AUTO_RECOVERY_MAX_BYTES = 256 * 1024 * 1024;
const VIDEO_BITRATE_BASE_1080P30 = {
  economy: 3_500_000,
  standard: 7_000_000,
  high: 12_000_000,
};

function pickRecorderMimeType() {
  if (!mediaRecorderSupported()) return "";
  const candidates = [
    "video/mp4;codecs=h264,aac",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function chooseRecordedMimeType(chunks, recorderMimeType = "", requestedMimeType = "") {
  const chunkType = chunks.find((chunk) => chunk?.size > 0 && chunk.type)?.type || "";
  return chunkType || recorderMimeType || requestedMimeType || "video/webm";
}

function recordingStartAllowed({ hasStream, busy, recorderState, finalizing }) {
  return Boolean(hasStream) && !busy && !finalizing && (!recorderState || recorderState === "inactive");
}

function getObservedRecordingBytes(persistedBytes, emittedBytes) {
  return Math.max(0, Number(persistedBytes) || 0, Number(emittedBytes) || 0);
}

function recordingByteLimitReached(persistedBytes, emittedBytes, maxBytes) {
  const limit = Number(maxBytes);
  return Number.isFinite(limit) && limit > 0
    && getObservedRecordingBytes(persistedBytes, emittedBytes) >= limit;
}

function shouldRestartCameraAfterRecording({ hasStream, visibilityState }) {
  return !hasStream && visibilityState === "visible";
}

function calculateVideoBitsPerSecondFor(width, height, fps, quality = "standard") {
  const safeWidth = Math.max(320, Number(width) || 1280);
  const safeHeight = Math.max(240, Number(height) || 720);
  const safeFps = Math.max(15, Number(fps) || 30);
  const base = VIDEO_BITRATE_BASE_1080P30[quality] || VIDEO_BITRATE_BASE_1080P30.standard;
  const pixelScale = Math.min(4, Math.max(0.55, (safeWidth * safeHeight) / (1920 * 1080)));
  const frameScale = Math.min(2, Math.max(0.75, safeFps / 30));
  return Math.round(Math.min(28_000_000, Math.max(1_500_000, base * pixelScale * frameScale)));
}

function getVideoBitsPerSecond() {
  const settings = state.videoTrack?.getSettings?.() ?? {};
  const width = Number(settings.width || (elements.videoResolutionSelect.value === "720" ? 1280 : 1920));
  const height = Number(settings.height || (elements.videoResolutionSelect.value === "720" ? 720 : 1080));
  const fps = Number(settings.frameRate || (elements.videoFrameRateSelect.value === "auto" ? 30 : elements.videoFrameRateSelect.value));
  return calculateVideoBitsPerSecondFor(width, height, fps, elements.videoQualitySelect.value);
}

function getRecordingLimitMs() {
  return Number(elements.recordingLimitSelect.value || 10) * 60 * 1000;
}

function calculateRecordingByteBudget(availableBytes, policy = RECORDING_LIMITS) {
  if (availableBytes === null || availableBytes === undefined || !Number.isFinite(Number(availableBytes))) {
    return policy.targetBytes;
  }
  // Retain conservative headroom for delayed output and transient decoder/Blob
  // work. Completed videos now reference chunks rather than duplicating them.
  const available = Math.max(0, Math.floor(Number(availableBytes)));
  const safeBudget = Math.floor((available - policy.finalizationReserveBytes) / 2) - policy.delayedOutputAllowanceBytes;
  if (safeBudget < policy.minimumBytes) throw new Error("端末の保存容量が不足しています");
  return Math.min(safeBudget, policy.targetBytes);
}

async function prepareRecordingBudget() {
  const budget = await getStorageBudget();
  state.recordingMaxBytes = calculateRecordingByteBudget(budget.available);
  state.recordingFinalizeLimitBytes = recordingFinalizeLimit();
  state.recordingMemoryWarningShown = false;
}

function updateRecordingClock() {
  state.recordingDurationMs = performance.now() - state.recordingStartedAt;
  const observedBytes = getObservedRecordingBytes(state.recordingBytes, state.recordingEmittedBytes);
  elements.recordingTime.textContent = formatDuration(state.recordingDurationMs);
  elements.recordingSize.textContent = formatBytes(observedBytes);

  if (!state.recordingMemoryWarningShown && observedBytes >= Math.min(RECORDING_WARNING_BYTES, state.recordingMaxBytes * 0.8)) {
    state.recordingMemoryWarningShown = true;
    showToast("録画サイズが大きくなっています。確定時にメモリを使用するため、必要なら一度停止してください");
  }
  if (state.recordingDurationMs >= getRecordingLimitMs()) {
    showToast("設定した録画時間に達したため停止します");
    stopRecording();
    return;
  }
  if (recordingByteLimitReached(state.recordingBytes, state.recordingEmittedBytes, state.recordingStopBytes ?? state.recordingMaxBytes)) {
    showToast("安全な保存容量に達したため録画を停止します");
    stopRecording();
  }
}

function startRecordingClock() {
  window.clearInterval(state.recordingTimerId);
  state.recordingStartedAt = performance.now();
  state.recordingDurationMs = 0;
  elements.recordingTime.textContent = "00:00";
  elements.recordingSize.textContent = "0 KB";
  state.recordingTimerId = window.setInterval(updateRecordingClock, 250);
}

function stopRecordingClock() {
  const wasRunning = state.recordingTimerId !== null;
  window.clearInterval(state.recordingTimerId);
  state.recordingTimerId = null;
  if (wasRunning && state.recordingStartedAt) {
    state.recordingDurationMs = Math.max(state.recordingDurationMs, performance.now() - state.recordingStartedAt);
  }
}

function resetRecordingUiAfterStop() {
  stopRecordingClock();
  elements.recordingBadge.hidden = true;
  elements.shutterButton.classList.remove("recording");
  elements.shutterButton.setAttribute("aria-label", "録画を開始する");
  elements.shutterButton.disabled = true;
}

async function writeRecordingChunk(blob) {
  const sessionId = state.recordingSessionId;
  const index = state.recordingChunkIndex;
  await putRecordingChunk(sessionId, index, blob);
  state.recordingChunkIndex += 1;
  state.recordingBytes += blob.size;
  if (blob.type) {
    state.recordingChunkMimeType = state.recordingChunkMimeType || blob.type;
    state.recordingMimeType = state.recordingChunkMimeType;
    state.recordingExtension = state.recordingMimeType.includes("mp4") ? "mp4" : "webm";
  }
  await putRecordingSession(recordingSessionRecord());
}

async function validateVideoBlob(blob, timeoutMs = 8000) {
  if (blob?.size && blob.type.includes("mp4")) {
    const structure = await inspectMp4MediaData(blob).catch(() => "unknown");
    if (structure === "no-media") throw new Error("録画ファイルに映像データが含まれていません");
    if (structure === "unknown") throw new Error("MP4の構造を確認できないため復元用データを保持します");
  }
  return new Promise((resolve, reject) => {
    if (!blob?.size) {
      reject(new Error("動画データが空です"));
      return;
    }
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    let settled = false;
    const finish = (error, metadata) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(metadata);
    };
    const timer = window.setTimeout(() => {
      const error=new Error(document.visibilityState === "hidden" ? "動画の確認を前面復帰後に再試行します。一時データは保持しています" : "動画の読込・再生確認がタイムアウトしました。一時データは保持しています");
      if(document.visibilityState === "hidden") error.code="VERIFICATION_DEFERRED";
      finish(error);
    }, timeoutMs);
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.addEventListener("loadeddata", () => {
      const metadata = {
        width: Number(video.videoWidth) || 0,
        height: Number(video.videoHeight) || 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
      };
      if (!(metadata.width > 0 && metadata.height > 0)) {
        finish(new Error("映像を含む再生可能な動画として確認できませんでした"));
        return;
      }
      finish(null, metadata);
    }, { once: true });
    video.addEventListener("error", () => finish(new Error("録画ファイルを再生可能な動画として確認できませんでした")), { once: true });
    video.src = url;
    // A paused, detached video may not preload frames in a background tab.
    // Muted playback requests decode without a microphone or audible output.
    video.play().catch(()=>{});
  });
}

async function startRecording() {
  if (!mediaRecorderSupported()) {
    showToast("このブラウザは動画録画に対応していません");
    return;
  }
  if (!recordingStartAllowed({
    hasStream: Boolean(state.stream),
    busy: state.busy,
    recorderState: state.recorder?.state,
    finalizing: state.recordingFinalizing,
  })) {
    if (state.recordingFinalizing) showToast("前の動画を保存しています");
    return;
  }
  state.busy = true;
  elements.galleryButton.disabled = true; // countdown: history cannot open (B3)
  let sessionPrepared = false;

  try {
    if (state.timerSeconds > 0) await runCountdown(state.timerSeconds);
    await prepareRecordingBudget();
    const mimeType = pickRecorderMimeType();
    const settings = state.videoTrack?.getSettings?.() ?? {};
    const options = {
      videoBitsPerSecond: getVideoBitsPerSecond(),
      audioBitsPerSecond: microphoneEnabled() ? 128_000 : undefined,
    };
    if (mimeType) options.mimeType = mimeType;
    let usedPreferredOptions = true;
    state.recorder = null;
    state.recordingKeyFrameIntervalRequestedMs = 0;
    if (mimeType.includes("mp4")) {
      try {
        state.recorder = new MediaRecorder(state.stream, {...options, videoKeyFrameIntervalDuration: RECORDING_LIMITS.mp4KeyFrameIntervalMs});
        // This is a request; accepting the dictionary does not prove cadence.
        state.recordingKeyFrameIntervalRequestedMs = RECORDING_LIMITS.mp4KeyFrameIntervalMs;
      } catch (error) { console.warn("Keyframe request unsupported; retrying standard options.", error); }
    }
    try {
      if (!state.recorder) state.recorder = new MediaRecorder(state.stream, options);
    } catch (preferredError) {
      console.warn("Preferred recording options failed; using browser defaults.", preferredError);
      usedPreferredOptions = false;
      state.recorder = new MediaRecorder(state.stream);
    }

    state.recordingSessionId = makeId("recording-session");
    state.recordingLockRelease = await holdRecordingLock(state.recordingSessionId);
    state.recordingLargestChunkBytes = 0;
    state.recordingStopObservedBytes = 0;
    state.recordingStopRequested = false;
    state.recordingBitsPerSecond = options.videoBitsPerSecond + (options.audioBitsPerSecond || 0);
    state.recordingStopBytes = calculateRecordingStopBytes(state.recordingMaxBytes, state.recordingBitsPerSecond);
    state.recordingMediaId = makeId("video");
    state.recordingCreatedAt = Date.now();
    state.recordingChunkIndex = 0;
    state.recordingBytes = 0;
    state.recordingEmittedBytes = 0;
    state.recordingWriteQueue = Promise.resolve();
    state.recordingWriteError = null;
    state.recordingRuntimeError = null;
    state.recordingChunkMimeType = "";
    state.cancelRecording = false;
    state.recordingAudioEnabled = microphoneEnabled();
    state.recordingMimeType = state.recorder.mimeType || (usedPreferredOptions ? mimeType : "");
    state.recordingExtension = state.recordingMimeType.includes("mp4") ? "mp4" : "webm";
    state.recordingResolution = settings.width && settings.height ? `${settings.width}×${settings.height}` : "解像度不明";

    await putRecordingSession(recordingSessionRecord());
    sessionPrepared = true;

    state.recorder.addEventListener("dataavailable", (event) => {
      if (!event.data || event.data.size <= 0) return;
      state.recordingEmittedBytes += event.data.size;
      state.recordingLargestChunkBytes = Math.max(state.recordingLargestChunkBytes, event.data.size);
      state.recordingStopBytes = calculateRecordingStopBytes(state.recordingMaxBytes, state.recordingBitsPerSecond, state.recordingLargestChunkBytes);
      state.recordingWriteQueue = state.recordingWriteQueue.then(() => writeRecordingChunk(event.data));
      state.recordingWriteQueue.catch((error) => {
        if (state.recordingWriteError) return;
        state.recordingWriteError = error;
        console.error("Recording chunk could not be stored.", error);
        showToast("録画データの保存に失敗したため停止します");
        stopRecording();
      });
      if (state.recorder?.state !== "inactive"
        && recordingByteLimitReached(state.recordingBytes, state.recordingEmittedBytes, state.recordingStopBytes ?? state.recordingMaxBytes)) {
        showToast("安全な保存容量に達したため録画を停止します");
        stopRecording();
      }
    });
    state.recorder.addEventListener("error", (event) => {
      state.recordingRuntimeError = event.error || new Error("MediaRecorder error");
      console.error(state.recordingRuntimeError);
      showToast("録画中にエラーが発生しました");
    });
    state.recorder.addEventListener("stop", () => finalizeRecording(), { once: true });
    state.recorder.start(1000);
    startRecordingClock();
    elements.recordingAudioState.textContent = state.recordingAudioEnabled ? "音声あり" : "音声なし";
    elements.recordingBadge.hidden = false;
    elements.galleryButton.dataset.recordingCancel = "true";
    elements.galleryButton.disabled = false;
    elements.galleryPlaceholder.hidden = false;
    elements.galleryPlaceholder.textContent = "録画取消";
    elements.galleryButton.setAttribute("aria-label", "現在の録画を破棄する");
    elements.previewThumbnail.hidden = true;
    elements.videoThumbnailMark.hidden = true;
    elements.shutterButton.classList.add("recording");
    elements.shutterButton.setAttribute("aria-label", "録画を停止する");
    setControlsDisabled(true);
    elements.gridButton.disabled = true;
    elements.shutterButton.disabled = false;
    showToast(state.recordingAudioEnabled ? "音声ありで録画を開始しました" : "音声なしで録画を開始しました");
  } catch (error) {
    console.error(error);
    if (state.recorder && state.recorder.state !== "inactive") {
      stopRecording();
    } else {
      state.recorder = null;
      if (sessionPrepared) {
        try { await cleanupRecordingSession(state.recordingSessionId); }
        catch (cleanupError) { console.warn("Failed to clean up an unstarted recording session.", cleanupError); }
      }
      await releaseRecordingLock();
      state.recordingSessionId = null;
      setControlsDisabled(false);
      elements.gridButton.disabled = false;
      elements.shutterButton.disabled = !state.stream;
    }
    showToast(error?.message || "録画を開始できませんでした");
  } finally {
    state.busy = false;
    if (!state.recordingFinalizing) elements.galleryButton.disabled = false;
    elements.countdown.textContent = "";
  }
}

function stopRecording({ cancel = false } = {}) {
  if (!state.recorder || state.recorder.state === "inactive") return;
  if (cancel) state.cancelRecording = true;
  if (state.recordingStopRequested) return;
  state.recordingStopRequested = true;
  state.recordingStopObservedBytes = getObservedRecordingBytes(state.recordingBytes, state.recordingEmittedBytes);
  try { state.recorder.requestData?.(); } catch {}
  try { state.recorder.stop(); } catch (error) {
    state.recordingStopRequested = false;
    console.warn("MediaRecorder stop failed.", error);
  }
  resetRecordingUiAfterStop();
}

async function cleanupRecordingSession(sessionId) {
  if (!sessionId) return;
  await deleteRecordingSessionData(sessionId);
}

async function finalizeRecording() {
  if (state.recordingFinalizing) return;
  // MediaRecorder can stop because its source track ended, without passing
  // through stopRecording(). Keep the clock and visual state correct there too.
  resetRecordingUiAfterStop();
  const recorder = state.recorder;
  const sessionId = state.recordingSessionId;
  const recording = {
    mediaId: state.recordingMediaId,
    createdAt: state.recordingCreatedAt,
    durationMs: state.recordingDurationMs,
    audio: state.recordingAudioEnabled,
    resolution: state.recordingResolution,
    requestedMimeType: state.recordingMimeType,
    cancel: state.cancelRecording,
    writeQueue: state.recordingWriteQueue,
  };
  state.recordingFinalizing = true;
  state.recorder = null;
  setControlsDisabled(true);
  elements.gridButton.disabled = true;
  elements.shutterButton.disabled = true;
  elements.shutterButton.setAttribute("aria-label", "動画を保存中");
  delete elements.galleryButton.dataset.recordingCancel;
  elements.galleryPlaceholder.textContent = "保存中";
  elements.galleryButton.setAttribute("aria-label", "動画を保存中");
  elements.galleryButton.disabled = true;

  try {
    if (!state.recordingLockRelease) state.recordingLockRelease = await holdRecordingLock(sessionId);
    let writeFailure = null;
    try { await recording.writeQueue; }
    catch (error) { writeFailure = error; }

    if (recording.cancel) {
      await cleanupRecordingSession(sessionId);
      showToast("録画を破棄しました");
      return;
    }
    if (writeFailure || state.recordingWriteError) {
      throw new Error("録画チャンクをすべて保存できませんでした。復元用データを保持します", { cause: writeFailure || state.recordingWriteError });
    }
    const session = await getRecordingSession(sessionId);
    const chunks = await getRecordingChunks(sessionId);
    if (await isDefinitelyEmptyRecording(chunks, session)) {
      await cleanupRecordingSession(sessionId);
      showToast(recording.durationMs < 5000 ? "録画データがありません。録画が短すぎるか、録画の準備中でした" : "映像データのない録画一時データを整理しました");
      return;
    }
    if (state.recordingRuntimeError) {
      throw new Error("録画がブラウザ側で中断されました。復元用データを保持します", { cause: state.recordingRuntimeError });
    }

    const type = chooseRecordedMimeType(chunks, recorder?.mimeType, recording.requestedMimeType);
    const blob = new Blob(chunks, { type });
    if (!blob.size) throw new Error("録画データを生成できませんでした");
    if (!recordingFinalizeSizeAllowed(blob.size, session)) throw new Error("録画が確定サイズ上限を超えています。復元用データを保持します");
    if (session) await putRecordingSession({...session, status:"finalizing", stopBytes:state.recordingStopBytes, stopObservedBytes:state.recordingStopObservedBytes, bytes:blob.size});
    const metadata = await validateVideoBlob(blob);
    let poster = null;
    try { poster = await window.QuietCameraVideoPreview.createPoster(blob, { duration: recording.durationMs / 1000 }); }
    catch (error) { console.warn("Video saved without a preview frame.", error); }

    const extension = type.includes("mp4") ? "mp4" : "webm";
    const actualResolution = metadata.width && metadata.height
      ? `${metadata.width}×${metadata.height}`
      : recording.resolution;
    await addMedia({
      id: recording.mediaId,
      createdAt: recording.createdAt,
      kind: "video",
      blob,
      previewBlob: blob,
      thumbnailBlob: poster?.blob || null,
      thumbnailTime: poster?.time || 0,
      width: metadata.width,
      height: metadata.height,
      extension,
      mimeType: type,
      duration: recording.durationMs,
      audio: recording.audio,
      meta: `${extension.toUpperCase()} · ${formatDuration(recording.durationMs)} · ${actualResolution} · ${formatBytes(blob.size)} · ${recording.audio ? "音声あり" : "音声なし"}`,
    }, {recordingSessionId:sessionId});
    showToast("動画を保存しました");
  } catch (error) {
    if(error?.code === "VERIFICATION_DEFERRED"){
      try {const latest=await getRecordingSession(sessionId);if(latest)await putRecordingSession({...latest,status:"verification-pending",recoveryAttempts:0});}catch{}
      deferredRecordingVerifications.add(sessionId);
    }
    console.error(error);
    showToast(error?.message || "録画の確定に失敗しました。録画チャンクは次回復元用に保持します");
  } finally {
    state.recordingSessionId = null;
    state.recordingWriteQueue = Promise.resolve();
    state.recordingWriteError = null;
    state.recordingRuntimeError = null;
    state.recordingChunkMimeType = "";
    state.recordingEmittedBytes = 0;
    state.recordingFinalizing = false;
    setControlsDisabled(false);
    elements.gridButton.disabled = false;
    elements.shutterButton.disabled = !state.stream;
    elements.shutterButton.setAttribute("aria-label", "録画を開始する");
    elements.galleryButton.disabled = false;
    elements.galleryButton.setAttribute("aria-label", "撮影履歴を見る");
    elements.galleryPlaceholder.textContent = "履歴";
    await releaseRecordingLock();
    try { await refreshGallery(); }
    catch (error) { console.error("Gallery refresh after recording failed.", error); }
    if (document.visibilityState === "visible" && deferredRecordingVerifications.size) {
      window.setTimeout(() => retryDeferredRecordingVerification().catch(error => console.warn("Deferred recording data retained.", error)), 0);
    }
    if (state.serviceWorkerReloadPending && typeof requestServiceWorkerUpdate === "function") {
      requestServiceWorkerUpdate();
    }
    if (shouldRestartCameraAfterRecording({
      hasStream: Boolean(state.stream),
      visibilityState: document.visibilityState,
    })) {
      const expectedGeneration = state.cameraStartGeneration;
      window.setTimeout(() => {
        if (state.stream || state.recordingFinalizing || document.visibilityState !== "visible"
          || state.cameraStartGeneration !== expectedGeneration) return;
        const restart = window.QuietCameraEnhancements?.enhancedStartCamera;
        restart?.().catch((error) => console.warn("Camera restart after recording finalization failed.", error));
      }, 500);
    }
  }
}

async function recoverInterruptedRecordings({ force = false, sessionIds = null, legacyTabsClosed = false } = {}) {
  const sessions = (await listRecordingSessions()).sort((a,b) => Number(a.createdAt||0)-Number(b.createdAt||0));
  let recovered=0, retained=0, attempted=0, attemptedBytes=0, busy=0, cleaned=0, unavailable=0, legacy=0;
  for (const reference of sessions) {
    if (sessionIds && !sessionIds.has(reference.id)) continue;
    if (reference.id === state.recordingSessionId) { busy += 1; continue; }
    const outcome = await withIdleRecordingSession(reference, async session => {
      // Old writers never acquired this Web Lock. Absence of a lock cannot
      // distinguish their active recording from a crash, even for zero bytes.
      if (session.lockProtocol !== RECORDING_LOCK_PROTOCOL && !legacyTabsClosed) return "legacy";
      try {
        const chunks = await getRecordingChunks(session.id);
        const bytes = chunks.reduce((sum,chunk) => sum+chunk.size,0);
        // Empty rows do not consume the auto-recovery attempt/byte allowance.
        if (await isDefinitelyEmptyRecording(chunks, session)) {
          await cleanupRecordingSession(session.id); return "empty";
        }
        if (!force && ((session.status === "recovery-pending" && Number(session.recoveryAttempts||0)>=1)
          || attempted>=AUTO_RECOVERY_MAX_SESSIONS || bytes>AUTO_RECOVERY_MAX_BYTES
          || attemptedBytes+bytes>AUTO_RECOVERY_MAX_BYTES)) return "retained";
        attempted += 1; attemptedBytes += bytes;
        const type = chooseRecordedMimeType(chunks,"",session.mimeType);
        const blob = new Blob(chunks,{type});
        if (!recordingFinalizeSizeAllowed(blob.size,session)) throw new Error("復元候補が確定サイズ上限を超えているため保持します");
        const metadata = await validateVideoBlob(blob);
        const extension=type.includes("mp4")?"mp4":"webm";
        const resolution=metadata.width&&metadata.height?`${metadata.width}×${metadata.height}`:session.resolution||"解像度不明";
        await commitRecordingMedia({id:session.mediaId||makeId("recovered-video"),createdAt:session.createdAt||Date.now(),kind:"video",blob,previewBlob:blob,
          extension,mimeType:type,duration:session.duration||0,audio:Boolean(session.audio),
          meta:`${extension.toUpperCase()} · 復元された録画 · ${resolution} · ${formatBytes(blob.size)} · ${session.audio?"音声あり":"音声なし"}`},session.id);
        deferredRecordingVerifications.delete(session.id); return "recovered";
      } catch (error) {
        console.error("Interrupted recording retained.",error);
        try { await putRecordingSession({...session,status:"recovery-pending",recoveryAttempts:Number(session.recoveryAttempts||0)+1,recoveryFailedAt:Date.now(),recoveryError:String(error?.message||error)}); } catch {}
        return "retained";
      }
    });
    if (outcome === RECORDING_SESSION_UNAVAILABLE) unavailable += 1;
    else if (outcome === RECORDING_SESSION_BUSY) busy += 1;
    else if (outcome === "recovered") recovered += 1;
    else if (outcome === "retained") retained += 1;
    else if (outcome === "empty") cleaned += 1;
    else if (outcome === "legacy") legacy += 1;
  }
  state.lastRecoveryResult={recovered,retained,busy,cleaned,attempted,attemptedBytes,unavailable,legacy};
  if (legacy) showToast("旧版の録画一時データは保持しています。旧版のタブをすべて閉じてから、復元を再試行してください");
  if (recovered) showToast(`${recovered}件の中断録画を復元しました`);
  else if (retained) showToast(`${retained}件の中断録画は確認できないため、復元用データを保持しています`);
  return state.lastRecoveryResult;
}

async function retryDeferredRecordingVerification() {
  if(document.visibilityState!=="visible" || state.busy || state.recordingFinalizing || state.recorder?.state==="recording" || !deferredRecordingVerifications.size)return;
  const ids=new Set(deferredRecordingVerifications);
  await recoverInterruptedRecordings({force:true,sessionIds:ids});
  for(const id of ids)deferredRecordingVerifications.delete(id);
  await refreshGallery();
}
if(typeof document!=="undefined" && document.addEventListener)document.addEventListener("visibilitychange",()=>{retryDeferredRecordingVerification().catch(error=>console.warn("Deferred recording verification retained.",error))});

// A safety cap or unsupported decoder must not trap recoverable bytes in IDB.
// Export is user-triggered, labelled unverified, and never deletes the session.
async function downloadPendingRecordingData() {
  const {sessions}=await listIdleRecordingSessions();
  let requested=0;
  for(const reference of sessions){
    await withIdleRecordingSession(reference,async session=>{
      const chunks=await getRecordingChunks(session.id);
      if(!chunks.some(b=>b.size))return;
      const type=chooseRecordedMimeType(chunks,"",session.mimeType);
      const blob=new Blob(chunks,{type});
      const extension=type.includes("mp4")?"mp4":type.includes("webm")?"webm":"bin";
      triggerDownload(blob,`QuietCamera-unverified-${session.createdAt||Date.now()}.${extension}`);requested+=1;
    });
  }
  showToast(requested?`${requested}件の一時データの保存を要求しました。再生未確認です。ダウンロードを確認してください。一時データは削除していません`:"保存できる一時データはありません（使用中の場合は録画停止後に再試行してください）");
}

async function handleShutter() {
  if (state.mode === "photo") await capturePhoto();
  else if (state.recorder?.state === "recording") stopRecording();
  else await startRecording();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    calculateVideoBitsPerSecondFor,
    calculateRecordingByteBudget,
    chooseRecordedMimeType,
    recordingStartAllowed,
    getObservedRecordingBytes,
    recordingByteLimitReached,
    resetRecordingUiAfterStop,
    shouldRestartCameraAfterRecording,
    HARD_RECORDING_LIMIT_BYTES, RECORDING_LIMITS,
    calculateRecordingStopBytes, recordingFinalizeSizeAllowed, recordingFinalizeLimit,
    inspectMp4MediaData, isDefinitelyEmptyRecording,
    holdRecordingLock, withIdleRecordingSession, listIdleRecordingSessions,
    RECORDING_SESSION_BUSY, RECORDING_SESSION_MISSING, RECORDING_SESSION_UNAVAILABLE,
  };
}
