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
  const settings = state.videoTrack?.getSettings?.() ?? {};
  const pixels = (settings.width || 1280) * (settings.height || 720);
  const multiplier = elements.videoQualitySelect.value === "high" ? 0.22 : elements.videoQualitySelect.value === "economy" ? 0.075 : 0.13;
  return Math.round(Math.min(18_000_000, Math.max(1_500_000, pixels * multiplier * 30)));
}

function startRecordingClock() {
  window.clearInterval(state.recordingTimerId);
  state.recordingStartedAt = performance.now();
  elements.recordingTime.textContent = "00:00";
  state.recordingTimerId = window.setInterval(() => {
    state.recordingDurationMs = performance.now() - state.recordingStartedAt;
    elements.recordingTime.textContent = formatDuration(state.recordingDurationMs);
  }, 250);
}

function stopRecordingClock() {
  window.clearInterval(state.recordingTimerId);
  state.recordingTimerId = null;
  state.recordingDurationMs = Math.max(state.recordingDurationMs, performance.now() - state.recordingStartedAt);
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
    const mimeType = pickRecorderMimeType();
    const options = { videoBitsPerSecond: getVideoBitsPerSecond() };
    if (mimeType) options.mimeType = mimeType;

    state.recordingChunks = [];
    state.cancelRecording = false;
    state.recordingDurationMs = 0;
    try {
      state.recorder = new MediaRecorder(state.stream, options);
    } catch (preferredError) {
      console.warn("Preferred recording options failed; using browser defaults.", preferredError);
      state.recorder = new MediaRecorder(state.stream);
    }

    state.recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) state.recordingChunks.push(event.data);
    });

    state.recorder.addEventListener("error", (event) => {
      console.error(event.error || event);
      showToast("録画中にエラーが発生しました");
    });

    state.recorder.addEventListener("stop", finalizeRecording, { once: true });
    state.recorder.start(1000);
    startRecordingClock();
    elements.recordingAudioState.textContent = microphoneEnabled() ? "音声あり" : "音声なし";
    elements.recordingBadge.hidden = false;
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

function stopRecording({ cancel = false } = {}) {
  if (!state.recorder || state.recorder.state !== "recording") return;
  state.cancelRecording = cancel;
  state.recorder.stop();
  stopRecordingClock();
  elements.recordingBadge.hidden = true;
  elements.shutterButton.classList.remove("recording");
  elements.shutterButton.setAttribute("aria-label", "録画を開始する");
  elements.shutterButton.disabled = true;
}

function finalizeRecording() {
  const recorder = state.recorder;
  state.recorder = null;
  setControlsDisabled(false);
  elements.gridButton.disabled = false;
  elements.shutterButton.disabled = !state.stream;
  delete elements.previewButton.dataset.recordingCancel;
  elements.previewPlaceholder.textContent = "履歴";
  if (state.lastMedia) {
    elements.previewButton.disabled = false;
    elements.previewPlaceholder.hidden = true;
    elements.previewThumbnail.hidden = state.lastMedia.kind !== "photo";
    elements.videoThumbnailMark.hidden = state.lastMedia.kind !== "video";
  } else {
    elements.previewButton.disabled = true;
    elements.previewPlaceholder.hidden = false;
    elements.previewThumbnail.hidden = true;
    elements.videoThumbnailMark.hidden = true;
  }

  if (state.cancelRecording) {
    state.recordingChunks = [];
    showToast("録画を破棄しました");
    return;
  }

  const type = recorder?.mimeType || state.recordingChunks[0]?.type || "video/webm";
  const blob = new Blob(state.recordingChunks, { type });
  state.recordingChunks = [];
  if (!blob.size) {
    showToast("録画データを生成できませんでした");
    return;
  }

  const settings = state.videoTrack?.getSettings?.() ?? {};
  const extension = type.includes("mp4") ? "mp4" : "webm";
  const typeLabel = extension.toUpperCase();
  const resolution = settings.width && settings.height ? `${settings.width}×${settings.height}` : "解像度不明";
  replaceLastMedia({
    kind: "video",
    blob,
    previewBlob: blob,
    extension,
    mimeType: type,
    meta: `${typeLabel} · ${formatDuration(state.recordingDurationMs)} · ${resolution} · ${formatBytes(blob.size)}${microphoneEnabled() ? " · 音声あり" : " · 音声なし"}`,
  });
  elements.reviewDialog.showModal();
}

async function handleShutter() {
  if (state.mode === "photo") {
    await capturePhoto();
    return;
  }
  if (state.recorder?.state === "recording") stopRecording();
  else await startRecording();
}
