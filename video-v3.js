"use strict";

const HARD_RECORDING_LIMIT_BYTES = 512 * 1024 * 1024;

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

function getVideoBitsPerSecond() {
  const settings = state.videoTrack?.getSettings?.() || {};
  const width = Number(settings.width || (elements.videoResolutionSelect.value === "720" ? 1280 : 1920));
  const height = Number(settings.height || (elements.videoResolutionSelect.value === "720" ? 720 : 1080));
  const fps = Number(settings.frameRate || (elements.videoFrameRateSelect.value === "60" ? 60 : 30));
  const factor = elements.videoQualitySelect.value === "high" ? 0.20 : elements.videoQualitySelect.value === "economy" ? 0.065 : 0.115;
  return Math.round(Math.min(28_000_000, Math.max(1_500_000, width * height * fps * factor)));
}

function currentRecordingElapsed() {
  if (!state.recordingStartedAt) return 0;
  if (state.recordingPaused) return state.recordingElapsedMs;
  return state.recordingElapsedMs + (performance.now() - state.recordingSegmentStartedAt);
}

function startRecordingClock() {
  clearInterval(state.recordingTimerId);
  state.recordingTimerId = setInterval(() => {
    const elapsed = currentRecordingElapsed();
    elements.recordingTime.textContent = QuietUtils.formatDuration(elapsed);
    elements.recordingSize.textContent = QuietUtils.formatBytes(state.recordingBytes);
    const limitMs = Number(elements.recordingLimitSelect.value) * 60_000;
    if (elapsed >= limitMs && state.recorder?.state !== "inactive") {
      showToast("設定した録画時間の上限に達しました");
      stopRecording();
    }
  }, 250);
}

function stopRecordingClock() {
  clearInterval(state.recordingTimerId);
  state.recordingTimerId = null;
  if (!state.recordingPaused && state.recordingSegmentStartedAt) {
    state.recordingElapsedMs += performance.now() - state.recordingSegmentStartedAt;
  }
  state.recordingSegmentStartedAt = 0;
}

async function ensureRecordingCapacity() {
  const estimate = await QuietStorage.estimate();
  if (!estimate) return;
  elements.galleryStorageText.textContent = `使用中 ${QuietUtils.formatBytes(estimate.usage)} / ${QuietUtils.formatBytes(estimate.quota)}`;
  if (estimate.available < 100 * 1024 * 1024) throw new Error("空き容量が少ないため録画を開始できません");
}

async function startRecording() {
  if (!mediaRecorderSupported()) {
    showToast("このブラウザは動画録画に対応していません");
    return;
  }
  if (!state.stream || state.busy || (state.recorder && state.recorder.state !== "inactive")) return;
  state.busy = true;

  try {
    await ensureRecordingCapacity();
    if (state.timerSeconds > 0) await runCountdown(state.timerSeconds);
    const mimeType = pickRecorderMimeType();
    const options = {
      videoBitsPerSecond: getVideoBitsPerSecond(),
      audioBitsPerSecond: microphoneEnabled() ? 128_000 : undefined,
    };
    if (mimeType) options.mimeType = mimeType;

    try { state.recorder = new MediaRecorder(state.stream, options); }
    catch (error) {
      console.warn("Preferred recorder options failed", error);
      state.recorder = new MediaRecorder(state.stream);
    }

    state.recordingId = QuietUtils.randomId();
    state.recordingChunkIndex = 0;
    state.recordingBytes = 0;
    state.recordingWriteChain = Promise.resolve();
    state.recordingStartedAt = Date.now();
    state.recordingElapsedMs = 0;
    state.recordingSegmentStartedAt = performance.now();
    state.recordingPaused = false;
    state.cancelRecording = false;

    const settings = state.videoTrack?.getSettings?.() || {};
    await QuietStorage.saveRecordingSession({
      id: state.recordingId,
      startedAt: state.recordingStartedAt,
      mimeType: state.recorder.mimeType || mimeType || "video/webm",
      width: settings.width || 0,
      height: settings.height || 0,
      audio: microphoneEnabled(),
      status: "recording",
    });

    state.recorder.addEventListener("dataavailable", (event) => {
      if (!event.data?.size || !state.recordingId) return;
      const recordingId = state.recordingId;
      const index = state.recordingChunkIndex++;
      state.recordingBytes += event.data.size;
      state.recordingWriteChain = state.recordingWriteChain
        .then(() => QuietStorage.saveRecordingChunk(recordingId, index, event.data))
        .catch((error) => {
          console.error("Recording chunk save failed", error);
          showToast("録画データの保存に失敗しました");
          stopRecording();
        });
      if (state.recordingBytes >= HARD_RECORDING_LIMIT_BYTES && state.recorder?.state !== "inactive") {
        showToast("安全のため録画容量の上限で停止しました");
        stopRecording();
      }
    });
    state.recorder.addEventListener("error", (event) => {
      console.error(event.error || event);
      showToast("録画中にエラーが発生しました");
    });
    state.recorder.addEventListener("stop", () => finalizeRecording(), { once: true });
    state.recorder.start(1000);

    startRecordingClock();
    elements.recordingAudioState.textContent = microphoneEnabled() ? "音声あり" : "音声なし";
    elements.recordingBadge.hidden = false;
    elements.pauseButton.hidden = false;
    elements.pauseButton.textContent = "一時停止";
    elements.previewButton.dataset.recordingCancel = "true";
    elements.previewButton.disabled = false;
    elements.previewThumbnail.hidden = true;
    elements.videoThumbnailMark.hidden = true;
    elements.previewPlaceholder.hidden = false;
    elements.previewPlaceholder.textContent = "取消";
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

function pauseOrResumeRecording() {
  if (!state.recorder) return;
  if (state.recorder.state === "recording") {
    state.recorder.pause();
    state.recordingElapsedMs += performance.now() - state.recordingSegmentStartedAt;
    state.recordingPaused = true;
    elements.pauseButton.textContent = "再開";
    elements.recordingAudioState.textContent = "一時停止中";
  } else if (state.recorder.state === "paused") {
    state.recorder.resume();
    state.recordingSegmentStartedAt = performance.now();
    state.recordingPaused = false;
    elements.pauseButton.textContent = "一時停止";
    elements.recordingAudioState.textContent = microphoneEnabled() ? "音声あり" : "音声なし";
  }
}

function stopRecording({ cancel = false } = {}) {
  if (!state.recorder || state.recorder.state === "inactive") return;
  state.cancelRecording = cancel;
  if (state.recorder.state === "paused") state.recorder.resume();
  state.recorder.stop();
  stopRecordingClock();
  elements.recordingBadge.hidden = true;
  elements.pauseButton.hidden = true;
  elements.shutterButton.classList.remove("recording");
  elements.shutterButton.setAttribute("aria-label", "録画を開始する");
  elements.shutterButton.disabled = true;
}

async function finalizeRecording() {
  const recorder = state.recorder;
  const recordingId = state.recordingId;
  const durationMs = state.recordingElapsedMs;
  state.recorder = null;
  state.recordingId = null;
  await state.recordingWriteChain.catch(() => {});

  setControlsDisabled(false);
  elements.gridButton.disabled = false;
  elements.shutterButton.disabled = !state.stream;
  delete elements.previewButton.dataset.recordingCancel;
  elements.previewPlaceholder.textContent = "履歴";

  if (!recordingId) return;
  if (state.cancelRecording) {
    await QuietStorage.deleteRecordingChunks(recordingId);
    await QuietStorage.deleteRecordingSession(recordingId);
    showToast("録画を破棄しました");
    updateLatestPreview();
    return;
  }

  try {
    const chunks = await QuietStorage.listRecordingChunks(recordingId);
    if (!chunks.length) throw new Error("録画データを生成できませんでした");
    const type = recorder?.mimeType || chunks[0].blob.type || "video/webm";
    const blob = new Blob(chunks.map((chunk) => chunk.blob), { type });
    const settings = state.videoTrack?.getSettings?.() || {};
    const extension = type.includes("mp4") ? "mp4" : "webm";
    const resolution = settings.width && settings.height ? `${settings.width}×${settings.height}` : "解像度不明";
    const media = {
      id: QuietUtils.randomId(),
      kind: "video",
      blob,
      previewBlob: null,
      extension,
      mimeType: type,
      createdAt: Date.now(),
      width: settings.width || 0,
      height: settings.height || 0,
      durationMs,
      audio: microphoneEnabled(),
      meta: `${extension.toUpperCase()} · ${QuietUtils.formatDuration(durationMs)} · ${resolution} · ${QuietUtils.formatBytes(blob.size)} · ${microphoneEnabled() ? "音声あり" : "音声なし"}`,
    };
    await QuietStorage.saveMedia(media);
    await QuietStorage.deleteRecordingChunks(recordingId);
    await QuietStorage.deleteRecordingSession(recordingId);
    await addMediaToGallery(media, { prepend: true });
    await presentCapturedMedia(media);
  } catch (error) {
    console.error(error);
    showToast(error?.message || "録画の保存に失敗しました");
  }
}

async function recoverInterruptedRecordings() {
  const sessions = await QuietStorage.listRecordingSessions();
  for (const session of sessions) {
    const chunks = await QuietStorage.listRecordingChunks(session.id);
    if (!chunks.length) {
      await QuietStorage.deleteRecordingSession(session.id);
      continue;
    }
    const type = session.mimeType || chunks[0].blob.type || "video/webm";
    const blob = new Blob(chunks.map((chunk) => chunk.blob), { type });
    const extension = type.includes("mp4") ? "mp4" : "webm";
    const media = {
      id: QuietUtils.randomId(),
      kind: "video",
      blob,
      previewBlob: null,
      extension,
      mimeType: type,
      createdAt: Date.now(),
      width: session.width || 0,
      height: session.height || 0,
      durationMs: 0,
      audio: Boolean(session.audio),
      recovered: true,
      meta: `復元 ${extension.toUpperCase()} · ${QuietUtils.formatBytes(blob.size)} · ${session.audio ? "音声あり" : "音声なし"}`,
    };
    await QuietStorage.saveMedia(media);
    await QuietStorage.deleteRecordingChunks(session.id);
    await QuietStorage.deleteRecordingSession(session.id);
    await addMediaToGallery(media, { prepend: true });
    showToast("中断された録画を履歴へ復元しました", 4200);
  }
}

async function handleShutter() {
  if (state.mode === "photo") return capturePhoto();
  if (state.recorder && state.recorder.state !== "inactive") return stopRecording();
  return startRecording();
}
