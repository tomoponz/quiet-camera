"use strict";

const HARD_RECORDING_LIMIT_BYTES = 512 * 1024 * 1024;
const RECORDING_WARNING_BYTES = 384 * 1024 * 1024;
const MIN_RECORDING_LIMIT_BYTES = 20 * 1024 * 1024;
const RECORDING_FINALIZATION_RESERVE_BYTES = 32 * 1024 * 1024;
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

function calculateRecordingByteBudget(availableBytes) {
  if (availableBytes === null || availableBytes === undefined || !Number.isFinite(Number(availableBytes))) {
    return HARD_RECORDING_LIMIT_BYTES;
  }
  // Chunks and the finalized media Blob coexist briefly in IndexedDB. Keep a
  // fixed reserve and use at most half of the remainder so finalization has room.
  const available = Math.max(0, Math.floor(Number(availableBytes)));
  const safeBudget = Math.floor((available - RECORDING_FINALIZATION_RESERVE_BYTES) / 2);
  if (safeBudget < MIN_RECORDING_LIMIT_BYTES) throw new Error("端末の保存容量が不足しています");
  return Math.min(safeBudget, HARD_RECORDING_LIMIT_BYTES);
}

async function prepareRecordingBudget() {
  const budget = await getStorageBudget();
  state.recordingMaxBytes = calculateRecordingByteBudget(budget.available);
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
  if (recordingByteLimitReached(state.recordingBytes, state.recordingEmittedBytes, state.recordingMaxBytes)) {
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
  await putRecordingSession({
    id: sessionId,
    mediaId: state.recordingMediaId,
    createdAt: state.recordingCreatedAt,
    mimeType: state.recordingChunkMimeType || state.recordingMimeType,
    extension: state.recordingExtension,
    audio: state.recordingAudioEnabled,
    resolution: state.recordingResolution,
    bytes: state.recordingBytes,
    duration: state.recordingDurationMs,
    status: "recording",
  });
}

function validateVideoBlob(blob, timeoutMs = 8000) {
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
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(metadata);
    };
    const timer = window.setTimeout(() => finish(new Error("動画メタデータの確認がタイムアウトしました")), timeoutMs);
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.addEventListener("loadedmetadata", () => {
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
    try {
      state.recorder = new MediaRecorder(state.stream, options);
    } catch (preferredError) {
      console.warn("Preferred recording options failed; using browser defaults.", preferredError);
      usedPreferredOptions = false;
      state.recorder = new MediaRecorder(state.stream);
    }

    state.recordingSessionId = makeId("recording-session");
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

    await putRecordingSession({
      id: state.recordingSessionId,
      mediaId: state.recordingMediaId,
      createdAt: state.recordingCreatedAt,
      mimeType: state.recordingMimeType,
      extension: state.recordingExtension,
      audio: state.recordingAudioEnabled,
      resolution: state.recordingResolution,
      bytes: 0,
      duration: 0,
      status: "recording",
    });
    sessionPrepared = true;

    state.recorder.addEventListener("dataavailable", (event) => {
      if (!event.data || event.data.size <= 0) return;
      state.recordingEmittedBytes += event.data.size;
      state.recordingWriteQueue = state.recordingWriteQueue.then(() => writeRecordingChunk(event.data));
      state.recordingWriteQueue.catch((error) => {
        if (state.recordingWriteError) return;
        state.recordingWriteError = error;
        console.error("Recording chunk could not be stored.", error);
        showToast("録画データの保存に失敗したため停止します");
        stopRecording();
      });
      if (state.recorder?.state !== "inactive"
        && recordingByteLimitReached(state.recordingBytes, state.recordingEmittedBytes, state.recordingMaxBytes)) {
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
      state.recordingSessionId = null;
      setControlsDisabled(false);
      elements.gridButton.disabled = false;
      elements.shutterButton.disabled = !state.stream;
    }
    showToast(error?.message || "録画を開始できませんでした");
  } finally {
    state.busy = false;
    elements.countdown.textContent = "";
  }
}

function stopRecording({ cancel = false } = {}) {
  if (!state.recorder || state.recorder.state === "inactive") return;
  state.cancelRecording = cancel;
  try { state.recorder.requestData?.(); } catch {}
  try { state.recorder.stop(); } catch (error) { console.warn("MediaRecorder stop failed.", error); }
  resetRecordingUiAfterStop();
}

async function cleanupRecordingSession(sessionId) {
  if (!sessionId) return;
  await deleteRecordingChunks(sessionId);
  await deleteRecordingSession(sessionId);
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
    if (state.recordingRuntimeError) {
      throw new Error("録画がブラウザ側で中断されました。復元用データを保持します", { cause: state.recordingRuntimeError });
    }

    const chunks = await getRecordingChunks(sessionId);
    const type = chooseRecordedMimeType(chunks, recorder?.mimeType, recording.requestedMimeType);
    const blob = new Blob(chunks, { type });
    if (!blob.size) throw new Error("録画データを生成できませんでした");
    if (blob.size > HARD_RECORDING_LIMIT_BYTES) throw new Error("録画が安全な確定サイズを超えています");
    const metadata = await validateVideoBlob(blob);

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
      extension,
      mimeType: type,
      duration: recording.durationMs,
      audio: recording.audio,
      meta: `${extension.toUpperCase()} · ${formatDuration(recording.durationMs)} · ${actualResolution} · ${formatBytes(blob.size)} · ${recording.audio ? "音声あり" : "音声なし"}`,
    });
    await cleanupRecordingSession(sessionId);
  } catch (error) {
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
    try { await refreshGallery(); }
    catch (error) { console.error("Gallery refresh after recording failed.", error); }
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

async function recoverInterruptedRecordings({ force = false } = {}) {
  const sessions = (await listRecordingSessions()).sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  let recovered = 0;
  let retained = 0;
  let attempted = 0;
  let attemptedBytes = 0;

  for (const session of sessions) {
    if (!force && session.status === "recovery-pending" && Number(session.recoveryAttempts || 0) >= 1) {
      retained += 1;
      continue;
    }
    const estimatedBytes = Math.max(0, Number(session.bytes) || 0);
    if (!force && (attempted >= AUTO_RECOVERY_MAX_SESSIONS
      || estimatedBytes > AUTO_RECOVERY_MAX_BYTES
      || attemptedBytes + estimatedBytes > AUTO_RECOVERY_MAX_BYTES)) {
      retained += 1;
      continue;
    }
    attempted += 1;
    attemptedBytes += estimatedBytes;
    try {
      const chunks = await getRecordingChunks(session.id);
      const type = chooseRecordedMimeType(chunks, "", session.mimeType);
      const blob = new Blob(chunks, { type });
      if (!blob.size) {
        await cleanupRecordingSession(session.id);
        continue;
      }
      if (blob.size > HARD_RECORDING_LIMIT_BYTES) throw new Error("復元候補が安全なサイズ上限を超えています");
      const metadata = await validateVideoBlob(blob);

      const extension = blob.type.includes("mp4") ? "mp4" : "webm";
      const resolution = metadata.width && metadata.height
        ? `${metadata.width}×${metadata.height}`
        : session.resolution || "解像度不明";
      await putMedia({
        id: session.mediaId || makeId("recovered-video"),
        createdAt: session.createdAt || Date.now(),
        kind: "video",
        blob,
        previewBlob: blob,
        extension,
        mimeType: blob.type,
        duration: session.duration || 0,
        audio: Boolean(session.audio),
        meta: `${extension.toUpperCase()} · 復元された録画 · ${resolution} · ${formatBytes(blob.size)} · ${session.audio ? "音声あり" : "音声なし"}`,
      });
      await cleanupRecordingSession(session.id);
      recovered += 1;
    } catch (error) {
      retained += 1;
      console.error("Interrupted recording could not be validated.", error);
      try {
        await putRecordingSession({
          ...session,
          status: "recovery-pending",
          recoveryAttempts: Number(session.recoveryAttempts || 0) + 1,
          recoveryFailedAt: Date.now(),
          recoveryError: String(error?.message || error),
        });
      } catch {}
    }
  }

  if (recovered) showToast(`${recovered}件の中断録画を復元しました`);
  else if (retained) showToast(`${retained}件の中断録画は再生確認できないため、復元用データを保持しています`);
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
    HARD_RECORDING_LIMIT_BYTES,
  };
}
