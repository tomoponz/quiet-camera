function createFileName(media = state.lastMedia) {
  if (!media) return "quiet-camera";
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    "quiet-camera",
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  ].join("_") + `.${media.extension}`;
}

function downloadMedia() {
  if (!state.lastMedia || !state.lastObjectUrl) return;
  const anchor = document.createElement("a");
  anchor.href = state.lastObjectUrl;
  anchor.download = createFileName();
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  showToast("保存を開始しました");
}

async function shareMedia() {
  if (!state.lastMedia) return;
  const file = new File([state.lastMedia.blob], createFileName(), { type: state.lastMedia.mimeType });
  const shareData = { files: [file], title: "Quiet Camera" };

  if (!navigator.share || (navigator.canShare && !navigator.canShare(shareData))) {
    downloadMedia();
    showToast("共有に非対応のため保存を開始しました");
    return;
  }

  try {
    await navigator.share(shareData);
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.error(error);
      showToast("共有できませんでした");
    }
  }
}

function openLastMedia() {
  if (elements.previewButton.dataset.recordingCancel === "true") {
    stopRecording({ cancel: true });
    return;
  }
  if (state.lastMedia) elements.reviewDialog.showModal();
}

function deleteLastMedia() {
  closeDialog(elements.reviewDialog);
  clearLastMedia();
  showToast("撮影結果を削除しました");
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

function handleDialogBackdrop(event) {
  if (event.target === event.currentTarget) event.currentTarget.close();
}

function updateMediaStatus() {
  if (state.mode === "photo") {
    const type = elements.photoFormatSelect.value;
    elements.mediaStatus.textContent = type === "image/jpeg" ? "JPEG" : type === "image/png" ? "PNG" : type === "image/webp" ? "WebP" : "PDF";
    return;
  }
  const mimeType = pickRecorderMimeType();
  elements.mediaStatus.textContent = mimeType.includes("mp4") ? "MP4" : mimeType.includes("webm") ? "WebM" : "動画";
}

function showFocusRing(clientX, clientY, failed = false) {
  const rect = elements.cameraStage.getBoundingClientRect();
  elements.focusRing.style.left = `${clientX - rect.left}px`;
  elements.focusRing.style.top = `${clientY - rect.top}px`;
  elements.focusRing.classList.remove("visible", "failed");
  void elements.focusRing.offsetWidth;
  elements.focusRing.classList.toggle("failed", failed);
  elements.focusRing.classList.add("visible");
}

async function focusAt(clientX, clientY) {
  if (!state.videoTrack || state.recorder?.state === "recording") return;
  const rect = elements.video.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;

  let x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (state.isFrontCamera) x = 1 - x;
  x = Math.min(1, Math.max(0, x));
  const normalizedY = Math.min(1, Math.max(0, y));

  const focusModes = Array.isArray(state.capabilities.focusMode) ? state.capabilities.focusMode : [];
  const advanced = {};
  if (focusModes.includes("single-shot")) advanced.focusMode = "single-shot";
  else if (focusModes.includes("continuous")) advanced.focusMode = "continuous";
  if ("pointsOfInterest" in state.capabilities) advanced.pointsOfInterest = [{ x, y: normalizedY }];

  if (!Object.keys(advanced).length) {
    showFocusRing(clientX, clientY, true);
    showToast("この端末ではタップフォーカスを制御できません");
    return;
  }

  try {
    await state.videoTrack.applyConstraints({ advanced: [advanced] });
    showFocusRing(clientX, clientY, false);
  } catch (error) {
    console.warn("Tap focus is not supported by this implementation.", error);
    showFocusRing(clientX, clientY, true);
    showToast("この端末ではタップフォーカスを制御できません");
  }
}

function pointerDistance() {
  const points = [...state.pinchPointers.values()];
  if (points.length !== 2) return 0;
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

function handlePointerDown(event) {
  if (event.target.closest("button, input, select") || state.recorder?.state === "recording") return;
  state.pinchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (state.pinchPointers.size === 2 && state.capabilities.zoom) {
    state.pinchGestureActive = true;
    state.pinchStartDistance = pointerDistance();
    state.pinchStartZoom = state.currentZoom;
  }
}

function handlePointerMove(event) {
  if (!state.pinchPointers.has(event.pointerId)) return;
  state.pinchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (state.pinchPointers.size === 2 && state.capabilities.zoom && state.pinchStartDistance > 0) {
    const ratio = pointerDistance() / state.pinchStartDistance;
    const nextZoom = state.pinchStartZoom * ratio;
    applyZoom(nextZoom);
  }
}

function handlePointerUp(event) {
  if (!state.pinchPointers.has(event.pointerId)) return;
  const wasPinching = state.pinchGestureActive;
  state.pinchPointers.delete(event.pointerId);
  if (!wasPinching && event.type === "pointerup") focusAt(event.clientX, event.clientY);
  if (state.pinchPointers.size < 2) state.pinchStartDistance = 0;
  if (state.pinchPointers.size === 0) state.pinchGestureActive = false;
}

async function installApp() {
  if (!state.deferredInstallPrompt) return;
  state.deferredInstallPrompt.prompt();
  try {
    await state.deferredInstallPrompt.userChoice;
  } finally {
    state.deferredInstallPrompt = null;
    elements.installButton.hidden = true;
  }
}

elements.startButton.addEventListener("click", startCamera);
elements.photoModeButton.addEventListener("click", () => setMode("photo"));
elements.videoModeButton.addEventListener("click", () => setMode("video"));
elements.switchButton.addEventListener("click", switchCamera);
elements.timerButton.addEventListener("click", cycleTimer);
elements.ratioButton.addEventListener("click", cycleRatio);
elements.torchButton.addEventListener("click", toggleTorch);
elements.gridButton.addEventListener("click", toggleGrid);
elements.zoomRange.addEventListener("input", (event) => applyZoom(event.target.value));
elements.shutterButton.addEventListener("click", handleShutter);
elements.previewButton.addEventListener("click", openLastMedia);
elements.closeReviewButton.addEventListener("click", () => closeDialog(elements.reviewDialog));
elements.closePrivacyButton.addEventListener("click", () => closeDialog(elements.privacyDialog));
elements.deleteButton.addEventListener("click", deleteLastMedia);
elements.downloadButton.addEventListener("click", downloadMedia);
elements.shareButton.addEventListener("click", shareMedia);
elements.privacyButton.addEventListener("click", () => elements.privacyDialog.showModal());
elements.installButton.addEventListener("click", installApp);
elements.reviewDialog.addEventListener("click", handleDialogBackdrop);
elements.privacyDialog.addEventListener("click", handleDialogBackdrop);
elements.photoFormatSelect.addEventListener("change", updateMediaStatus);
elements.microphoneSelect.addEventListener("change", () => { if (state.stream) startCamera(); });
elements.videoResolutionSelect.addEventListener("change", () => { if (state.stream) startCamera(); });
elements.videoFrameRateSelect.addEventListener("change", () => { if (state.stream) startCamera(); });
elements.cameraStage.addEventListener("pointerdown", handlePointerDown);
elements.cameraStage.addEventListener("pointermove", handlePointerMove);
elements.cameraStage.addEventListener("pointerup", handlePointerUp);
elements.cameraStage.addEventListener("pointercancel", handlePointerUp);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.deferredInstallPrompt = event;
  elements.installButton.hidden = false;
});

window.addEventListener("appinstalled", () => {
  state.deferredInstallPrompt = null;
  elements.installButton.hidden = true;
  showToast("Quiet Cameraをインストールしました");
});

window.addEventListener("beforeunload", (event) => {
  if (state.recorder?.state === "recording") {
    event.preventDefault();
    event.returnValue = "";
  }
});

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && state.stream) await requestWakeLock();
});

window.addEventListener("pagehide", () => {
  if (state.recorder?.state === "recording") stopRecording({ cancel: true });
  stopCamera();
  clearLastMedia();
});

if (!mediaRecorderSupported()) {
  elements.videoModeButton.disabled = true;
  elements.videoModeButton.title = "このブラウザは動画録画に対応していません";
}

applyStageRatio();
updateMediaStatus();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.error("Service worker registration failed:", error);
    });
  });
}
