"use strict";

function pickRecorderMimeType() {
  if (!mediaRecorderSupported()) return "";
  const candidates = ["video/mp4;codecs=h264,aac", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function getVideoBitsPerSecond() {
  const settings = state.videoTrack?.getSettings?.() ?? {};
  const pixels = (settings.width || 1280) * (settings.height || 720);
  const fps = Number(settings.frameRate || (elements.videoFrameRateSelect.value === "auto" ? 30 : elements.videoFrameRateSelect.value));
  const multiplier = elements.videoQualitySelect.value === "high" ? 0.0075 : elements.videoQualitySelect.value === "economy" ? 0.0028 : 0.0048;
  return Math.round(Math.min(28_000_000, Math.max(1_200_000, pixels * fps * multiplier)));
}

function getRecordingLimitMs() {
  return Number(elements.recordingLimitSelect.value || 10) * 60 * 1000;
}

async function prepareRecordingBudget() {
  const budget = await getStorageBudget();
  if (budget.available !== null && budget.available < 20 * 1024 * 1024) throw new Error("端末の保存容量が不足しています");
  const safeAvailable = budget.available ? Math.floor(budget.available * 0.55) : 750 * 1024 * 1024;
  state.recordingMaxBytes = Math.max(5 * 1024 * 1024, Math.min(safeAvailable, 1.5 * 1024 * 1024 * 1024));
}

function updateRecordingClock() {
  state.recordingDurationMs = performance.now() - state.recordingStartedAt;
  elements.recordingTime.textContent = formatDuration(state.recordingDurationMs);
  elements.recordingSize.textContent = formatBytes(state.recordingBytes);
  if (state.recordingDurationMs >= getRecordingLimitMs()) {
    showToast("設定した録画時間に達したため停止します");
    stopRecording();
    return;
  }
  if (state.recordingMaxBytes && state.recordingBytes >= state.recordingMaxBytes) {
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
  window.clearInterval(state.recordingTimerId);
  state.recordingTimerId = null;
  if (state.recordingStartedAt) state.recordingDurationMs = Math.max(state.recordingDurationMs, performance.now() - state.recordingStartedAt);
}

async function writeRecordingChunk(blob) {
  const sessionId = state.recordingSessionId;
  const index = state.recordingChunkIndex;
  state.recordingChunkIndex += 1;
  state.recordingBytes += blob.size;
  await putRecordingChunk(sessionId, index, blob);
  await putRecordingSession({
    id: sessionId,
    mediaId: state.recordingMediaId,
    createdAt: state.recordingCreatedAt,
    mimeType: state.recordingMimeType,
    extension: state.recordingExtension,
    audio: state.recordingAudioEnabled,
    resolution: state.recordingResolution,
    bytes: state.recordingBytes,
    duration: state.recordingDurationMs,
  });
}

async function startRecording() {
  if (!mediaRecorderSupported()) {
    showToast("このブラウザは動画録画に対応していません");
    return;
  }
  if (!state.stream || state.busy || state.recorder?.state === "recording") return;
  state.busy = true;
  try {
    if (state.timerSeconds > 0) await runCountdown(state.timerSeconds);
    await prepareRecordingBudget();
    const mimeType = pickRecorderMimeType();
    const settings = state.videoTrack?.getSettings?.() ?? {};
    const options = { videoBitsPerSecond: getVideoBitsPerSecond(), audioBitsPerSecond: microphoneEnabled() ? 128_000 : undefined };
    if (mimeType) options.mimeType = mimeType;
    try {
      state.recorder = new MediaRecorder(state.stream, options);
    } catch (preferredError) {
      console.warn("Preferred recording options failed; using browser defaults.", preferredError);
      state.recorder = new MediaRecorder(state.stream);
    }

    state.recordingSessionId = makeId("recording-session");
    state.recordingMediaId = makeId("video");
    state.recordingCreatedAt = Date.now();
    state.recordingChunkIndex = 0;
    state.recordingBytes = 0;
    state.recordingWriteQueue = Promise.resolve();
    state.cancelRecording = false;
    state.recordingAudioEnabled = microphoneEnabled();
    state.recordingMimeType = state.recorder.mimeType || mimeType || "video/webm";
    state.recordingExtension = state.recordingMimeType.includes("mp4") ? "mp4" : "webm";
    state.recordingResolution = settings.width && settings.height ? `${settings.width}×${settings.height}` : "解像度不明";

    await putRecordingSession({ id: state.recordingSessionId, mediaId: state.recordingMediaId, createdAt: state.recordingCreatedAt, mimeType: state.recordingMimeType, extension: state.recordingExtension, audio: state.recordingAudioEnabled, resolution: state.recordingResolution, bytes: 0, duration: 0 });

    state.recorder.addEventListener("dataavailable", (event) => {
      if (!event.data || event.data.size <= 0) return;
      state.recordingWriteQueue = state.recordingWriteQueue.then(() => writeRecordingChunk(event.data)).catch((error) => {
        console.error("Recording chunk could not be stored.", error);
        showToast("録画データの保存に失敗したため停止します");
        stopRecording();
      });
    });
    state.recorder.addEventListener("error", (event) => {
      console.error(event.error || event);
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
    elements.galleryPlaceholder.textContent = "取消";
    elements.previewThumbnail.hidden = true;
    elements.videoThumbnailMark.hidden = true;
    elements.shutterButton.classList.add("recording");
    elements.shutterButton.setAttribute("aria-label", "録画を停止する");
    setControlsDisabled(true);
    elements.gridButton.disabled = true;
    elements.shutterButton.disabled = false;
  } catch (error) {
    console.error(error);
    showToast(error?.message || "録画を開始できませんでした");
  } finally {
    state.busy = false;
    elements.countdown.textContent = "";
  }
}

function stopRecording({ cancel = false } = {}) {
  if (!state.recorder || state.recorder.state !== "recording") return;
  state.cancelRecording = cancel;
  try { state.recorder.requestData?.(); } catch {}
  state.recorder.stop();
  stopRecordingClock();
  elements.recordingBadge.hidden = true;
  elements.shutterButton.classList.remove("recording");
  elements.shutterButton.setAttribute("aria-label", "録画を開始する");
  elements.shutterButton.disabled = true;
}

async function cleanupRecordingSession(sessionId) {
  if (!sessionId) return;
  await deleteRecordingChunks(sessionId);
  await deleteRecordingSession(sessionId);
}

async function finalizeRecording() {
  const recorder = state.recorder;
  const sessionId = state.recordingSessionId;
  state.recorder = null;
  setControlsDisabled(false);
  elements.gridButton.disabled = false;
  elements.shutterButton.disabled = !state.stream;
  delete elements.galleryButton.dataset.recordingCancel;
  elements.galleryPlaceholder.textContent = "履歴";
  try {
    await state.recordingWriteQueue;
    if (state.cancelRecording) {
      await cleanupRecordingSession(sessionId);
      showToast("録画を破棄しました");
      await refreshGallery();
      return;
    }
    const chunks = await getRecordingChunks(sessionId);
    const type = recorder?.mimeType || state.recordingMimeType || chunks[0]?.type || "video/webm";
    const blob = new Blob(chunks, { type });
    if (!blob.size) throw new Error("録画データを生成できませんでした");
    const extension = type.includes("mp4") ? "mp4" : "webm";
    await addMedia({
      id: state.recordingMediaId,
      createdAt: state.recordingCreatedAt,
      kind: "video",
      blob,
      previewBlob: blob,
      extension,
      mimeType: type,
      duration: state.recordingDurationMs,
      audio: state.recordingAudioEnabled,
      meta: `${extension.toUpperCase()} · ${formatDuration(state.recordingDurationMs)} · ${state.recordingResolution} · ${formatBytes(blob.size)} · ${state.recordingAudioEnabled ? "音声あり" : "音声なし"}`,
    });
    await cleanupRecordingSession(sessionId);
  } catch (error) {
    console.error(error);
    showToast(error?.message || "録画の確定に失敗しました。次回起動時に復元を試みます");
  } finally {
    state.recordingSessionId = null;
    state.recordingWriteQueue = Promise.resolve();
    await refreshGallery();
  }
}

async function recoverInterruptedRecordings() {
  const sessions = await listRecordingSessions();
  let recovered = 0;
  for (const session of sessions) {
    try {
      const chunks = await getRecordingChunks(session.id);
      const blob = new Blob(chunks, { type: session.mimeType || "video/webm" });
      if (!blob.size) {
        await cleanupRecordingSession(session.id);
        continue;
      }
      const extension = session.extension || (blob.type.includes("mp4") ? "mp4" : "webm");
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
        meta: `${extension.toUpperCase()} · 復元された録画 · ${session.resolution || "解像度不明"} · ${formatBytes(blob.size)} · ${session.audio ? "音声あり" : "音声なし"}`,
      });
      await cleanupRecordingSession(session.id);
      recovered += 1;
    } catch (error) {
      console.error("Interrupted recording could not be recovered.", error);
    }
  }
  if (recovered) showToast(`${recovered}件の中断録画を復元しました`);
}

async function handleShutter() {
  if (state.mode === "photo") await capturePhoto();
  else if (state.recorder?.state === "recording") stopRecording();
  else await startRecording();
}
