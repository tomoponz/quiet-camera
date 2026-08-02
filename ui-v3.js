"use strict";

function getObjectUrl(key, blob) {
  if (!blob) return "";
  if (state.objectUrls.has(key)) return state.objectUrls.get(key);
  const url = URL.createObjectURL(blob);
  state.objectUrls.set(key, url);
  return url;
}

function revokeMediaUrls(id) {
  for (const key of [`${id}:blob`, `${id}:preview`]) {
    const url = state.objectUrls.get(key);
    if (url) URL.revokeObjectURL(url);
    state.objectUrls.delete(key);
  }
}

function mediaTitle(media) {
  if (media.kind === "video") return media.recovered ? "復元した動画" : "動画";
  if (media.mimeType === "application/pdf") return "PDF写真";
  return "写真";
}

function mediaDate(media) {
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(media.createdAt));
}

async function addMediaToGallery(media, { prepend = false } = {}) {
  const existingIndex = state.gallery.findIndex((item) => item.id === media.id);
  if (existingIndex >= 0) state.gallery.splice(existingIndex, 1);
  if (prepend) state.gallery.unshift(media);
  else state.gallery.push(media);
  renderGallery();
  updateLatestPreview();
  updateStorageDisplay();
}

function updateLatestPreview() {
  const latest = state.gallery[0];
  elements.galleryCount.textContent = String(state.gallery.length);
  if (!latest) {
    elements.previewButton.disabled = true;
    elements.previewThumbnail.hidden = true;
    elements.videoThumbnailMark.hidden = true;
    elements.previewPlaceholder.hidden = false;
    return;
  }
  elements.previewButton.disabled = false;
  elements.previewPlaceholder.hidden = true;
  if (latest.kind === "photo") {
    elements.previewThumbnail.src = getObjectUrl(`${latest.id}:preview`, latest.previewBlob || latest.blob);
    elements.previewThumbnail.hidden = false;
    elements.videoThumbnailMark.hidden = true;
  } else {
    elements.previewThumbnail.hidden = true;
    elements.videoThumbnailMark.hidden = false;
  }
}

function renderGallery() {
  elements.galleryGrid.replaceChildren();
  elements.galleryEmpty.hidden = state.gallery.length > 0;
  elements.galleryCount.textContent = String(state.gallery.length);

  state.gallery.forEach((media) => {
    const card = document.createElement("article");
    card.className = "gallery-card";
    card.dataset.id = media.id;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "gallery-select";
    checkbox.checked = state.selectedGalleryIds.has(media.id);
    checkbox.setAttribute("aria-label", `${mediaTitle(media)}を選択`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedGalleryIds.add(media.id);
      else state.selectedGalleryIds.delete(media.id);
    });

    const button = document.createElement("button");
    button.type = "button";
    button.className = "gallery-card-button";
    button.addEventListener("click", () => openMedia(media.id));

    const thumb = document.createElement("div");
    thumb.className = "gallery-thumb";
    if (media.kind === "photo") {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = "";
      img.src = getObjectUrl(`${media.id}:preview`, media.previewBlob || media.blob);
      thumb.append(img);
    } else {
      thumb.textContent = "▶";
    }

    const info = document.createElement("div");
    info.className = "gallery-card-info";
    const title = document.createElement("p");
    title.className = "gallery-card-title";
    title.textContent = mediaTitle(media);
    const meta = document.createElement("p");
    meta.className = "gallery-card-meta";
    meta.textContent = `${mediaDate(media)} · ${QuietUtils.formatBytes(media.blob.size)}`;
    info.append(title, meta);
    button.append(thumb, info);
    card.append(checkbox, button);
    elements.galleryGrid.append(card);
  });
}

async function updateStorageDisplay() {
  const estimate = await QuietStorage.estimate();
  if (!estimate) {
    elements.galleryStorageText.textContent = `${state.gallery.length}件を端末内に保存`;
    return;
  }
  elements.galleryStorageText.textContent = `${state.gallery.length}件 · 使用中 ${QuietUtils.formatBytes(estimate.usage)} / ${QuietUtils.formatBytes(estimate.quota)}`;
}

function activeMedia() {
  return state.gallery.find((media) => media.id === state.activeMediaId) || null;
}

function openMedia(id) {
  const media = state.gallery.find((item) => item.id === id);
  if (!media) return;
  state.activeMediaId = id;
  elements.reviewTitle.textContent = mediaTitle(media);
  elements.reviewMeta.textContent = `${mediaDate(media)} · ${media.meta}`;

  if (media.kind === "photo") {
    elements.reviewVideo.pause();
    elements.reviewVideo.removeAttribute("src");
    elements.reviewVideo.hidden = true;
    elements.reviewImage.src = getObjectUrl(`${media.id}:preview`, media.previewBlob || media.blob);
    elements.reviewImage.hidden = false;
  } else {
    elements.reviewImage.hidden = true;
    elements.reviewImage.removeAttribute("src");
    elements.reviewVideo.src = getObjectUrl(`${media.id}:blob`, media.blob);
    elements.reviewVideo.hidden = false;
    elements.reviewVideo.load();
  }
  if (!elements.reviewDialog.open) elements.reviewDialog.showModal();
}

async function presentCapturedMedia(media) {
  const behavior = elements.reviewBehaviorSelect.value;
  if (behavior === "never") return;
  openMedia(media.id);
  if (behavior === "brief") {
    setTimeout(() => {
      if (elements.reviewDialog.open && state.activeMediaId === media.id) elements.reviewDialog.close();
    }, 2000);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadMedia() {
  const media = activeMedia();
  if (!media) return;
  downloadBlob(media.blob, QuietUtils.createTimestampName("quiet-camera", media.extension));
  showToast("保存を開始しました");
}

async function shareMedia() {
  const media = activeMedia();
  if (!media) return;
  const file = new File([media.blob], QuietUtils.createTimestampName("quiet-camera", media.extension), { type: media.mimeType });
  const shareData = { files: [file], title: "Quiet Camera" };
  if (!navigator.share || (navigator.canShare && !navigator.canShare(shareData))) {
    downloadMedia();
    showToast("共有に非対応のため保存を開始しました");
    return;
  }
  try { await navigator.share(shareData); }
  catch (error) { if (error?.name !== "AbortError") showToast("共有できませんでした"); }
}

async function deleteMediaById(id) {
  await QuietStorage.deleteMedia(id);
  revokeMediaUrls(id);
  state.gallery = state.gallery.filter((media) => media.id !== id);
  state.selectedGalleryIds.delete(id);
  if (state.activeMediaId === id) {
    state.activeMediaId = null;
    if (elements.reviewDialog.open) elements.reviewDialog.close();
  }
  renderGallery();
  updateLatestPreview();
  updateStorageDisplay();
}

async function deleteActiveMedia() {
  const media = activeMedia();
  if (!media) return;
  await deleteMediaById(media.id);
  showToast("撮影結果を削除しました");
}

async function deleteSelectedMedia() {
  const ids = [...state.selectedGalleryIds];
  if (!ids.length) {
    showToast("削除する項目を選択してください");
    return;
  }
  await QuietStorage.deleteMediaMany(ids);
  ids.forEach(revokeMediaUrls);
  state.gallery = state.gallery.filter((media) => !state.selectedGalleryIds.has(media.id));
  state.selectedGalleryIds.clear();
  renderGallery();
  updateLatestPreview();
  updateStorageDisplay();
  showToast(`${ids.length}件を削除しました`);
}

async function clearGallery() {
  if (!state.gallery.length) return;
  await QuietStorage.clearMedia();
  state.gallery.forEach((media) => revokeMediaUrls(media.id));
  state.gallery = [];
  state.selectedGalleryIds.clear();
  renderGallery();
  updateLatestPreview();
  updateStorageDisplay();
  showToast("履歴をすべて削除しました");
}

function toggleSelectAll() {
  const select = state.selectedGalleryIds.size !== state.gallery.length;
  state.selectedGalleryIds.clear();
  if (select) state.gallery.forEach((media) => state.selectedGalleryIds.add(media.id));
  renderGallery();
}

async function exportSelectedPhotosToPdf() {
  const selected = state.gallery.filter((media) => state.selectedGalleryIds.has(media.id) && media.kind === "photo");
  if (!selected.length) {
    showToast("PDFにする写真を選択してください");
    return;
  }
  try {
    const pages = selected.reverse().map((media) => ({
      blob: media.previewBlob || media.blob,
      width: media.width,
      height: media.height,
    }));
    const pdf = await QuietUtils.buildMultiPagePdf(pages);
    downloadBlob(pdf, QuietUtils.createTimestampName("quiet-camera-document", "pdf"));
    showToast(`${selected.length}ページのPDFを作成しました`);
  } catch (error) {
    console.error(error);
    showToast("PDFを作成できませんでした");
  }
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
  } else {
    const mime = pickRecorderMimeType();
    elements.mediaStatus.textContent = mime.includes("mp4") ? "MP4" : mime.includes("webm") ? "WebM" : "動画";
  }
}

async function setMode(mode, { restart = true } = {}) {
  if (state.busy || (state.recorder && state.recorder.state !== "inactive")) return;
  state.mode = mode;
  const photo = mode === "photo";
  elements.photoModeButton.classList.toggle("active", photo);
  elements.videoModeButton.classList.toggle("active", !photo);
  elements.photoModeButton.setAttribute("aria-pressed", String(photo));
  elements.videoModeButton.setAttribute("aria-pressed", String(!photo));
  [elements.photoFormatField, elements.photoQualityField, elements.highResolutionField, elements.mirrorField, elements.reviewBehaviorField].forEach((field) => { field.hidden = !photo; });
  [elements.microphoneField, elements.videoResolutionField, elements.videoFrameRateField, elements.videoQualityField, elements.recordingLimitField].forEach((field) => { field.hidden = photo; });
  elements.ratioButton.hidden = !photo;
  elements.shutterButton.classList.toggle("video", !photo);
  elements.shutterButton.setAttribute("aria-label", photo ? "写真を撮る" : "録画を開始する");
  elements.permissionCopy.textContent = photo ? "写真はサーバーへ送信しません。マイクと位置情報は使用しません。" : "動画はサーバーへ送信しません。マイクはONにした場合だけ使用します。";
  applyStageRatio();
  updateMediaStatus();
  saveSettings();
  if (restart && state.stream) await startCamera();
}

function cycleTimer() {
  const sequence = [0, 3, 10];
  state.timerSeconds = sequence[(sequence.indexOf(state.timerSeconds) + 1) % sequence.length];
  elements.timerButton.textContent = state.timerSeconds ? `${state.timerSeconds}s` : "OFF";
  saveSettings();
}

function cycleRatio() {
  if (state.mode !== "photo") return;
  const sequence = ["4:3", "1:1", "16:9"];
  state.ratio = sequence[(sequence.indexOf(state.ratio) + 1) % sequence.length];
  elements.ratioButton.textContent = state.ratio;
  applyStageRatio();
  saveSettings();
}

function toggleGrid() {
  elements.gridOverlay.hidden = !elements.gridOverlay.hidden;
  elements.gridButton.setAttribute("aria-pressed", String(!elements.gridOverlay.hidden));
  saveSettings();
}

async function installApp() {
  if (!state.deferredInstallPrompt) return;
  state.deferredInstallPrompt.prompt();
  try { await state.deferredInstallPrompt.userChoice; }
  finally { state.deferredInstallPrompt = null; elements.installButton.hidden = true; }
}

function applySavedSettings() {
  elements.versionLabel.textContent = `v${APP_VERSION}`;
  elements.photoFormatSelect.value = state.settings.photoFormat;
  elements.photoQualitySelect.value = state.settings.photoQuality;
  elements.highResolutionSelect.value = state.settings.highResolution;
  elements.mirrorSelect.value = state.settings.mirrorFront;
  elements.reviewBehaviorSelect.value = state.settings.reviewBehavior;
  elements.videoResolutionSelect.value = state.settings.videoResolution;
  elements.videoFrameRateSelect.value = state.settings.videoFrameRate;
  elements.videoQualitySelect.value = state.settings.videoQuality;
  elements.recordingLimitSelect.value = state.settings.recordingLimit;
  elements.microphoneSelect.value = "off";
  elements.timerButton.textContent = state.timerSeconds ? `${state.timerSeconds}s` : "OFF";
  elements.ratioButton.textContent = state.ratio;
  elements.gridOverlay.hidden = !state.settings.grid;
  elements.gridButton.setAttribute("aria-pressed", String(state.settings.grid));
}

async function initializeGallery() {
  await QuietStorage.open();
  await QuietStorage.persist();
  state.gallery = await QuietStorage.listMedia();
  renderGallery();
  updateLatestPreview();
  await updateStorageDisplay();
  await recoverInterruptedRecordings();
}

function registerEvents() {
  elements.startButton.addEventListener("click", startCamera);
  elements.photoModeButton.addEventListener("click", () => setMode("photo"));
  elements.videoModeButton.addEventListener("click", () => setMode("video"));
  elements.switchButton.addEventListener("click", switchCamera);
  elements.timerButton.addEventListener("click", cycleTimer);
  elements.ratioButton.addEventListener("click", cycleRatio);
  elements.torchButton.addEventListener("click", toggleTorch);
  elements.gridButton.addEventListener("click", toggleGrid);
  elements.zoomRange.addEventListener("input", (event) => applyZoom(event.target.value));
  elements.exposureRange.addEventListener("input", (event) => applyExposure(event.target.value));
  elements.shutterButton.addEventListener("click", handleShutter);
  elements.pauseButton.addEventListener("click", pauseOrResumeRecording);
  elements.previewButton.addEventListener("click", () => {
    if (elements.previewButton.dataset.recordingCancel === "true") stopRecording({ cancel: true });
    else if (state.gallery[0]) openMedia(state.gallery[0].id);
  });
  elements.galleryButton.addEventListener("click", () => elements.galleryDialog.showModal());
  elements.closeGalleryButton.addEventListener("click", () => closeDialog(elements.galleryDialog));
  elements.closeReviewButton.addEventListener("click", () => closeDialog(elements.reviewDialog));
  elements.closePrivacyButton.addEventListener("click", () => closeDialog(elements.privacyDialog));
  elements.deleteButton.addEventListener("click", deleteActiveMedia);
  elements.downloadButton.addEventListener("click", downloadMedia);
  elements.shareButton.addEventListener("click", shareMedia);
  elements.selectAllButton.addEventListener("click", toggleSelectAll);
  elements.exportPdfButton.addEventListener("click", exportSelectedPhotosToPdf);
  elements.deleteSelectedButton.addEventListener("click", deleteSelectedMedia);
  elements.clearGalleryButton.addEventListener("click", clearGallery);
  elements.privacyButton.addEventListener("click", () => elements.privacyDialog.showModal());
  elements.installButton.addEventListener("click", installApp);
  [elements.reviewDialog, elements.galleryDialog, elements.privacyDialog].forEach((dialog) => dialog.addEventListener("click", handleDialogBackdrop));

  const restartFields = [elements.microphoneSelect, elements.videoResolutionSelect, elements.videoFrameRateSelect];
  restartFields.forEach((field) => field.addEventListener("change", async () => { saveSettings(); if (state.stream) await startCamera(); }));
  [elements.photoFormatSelect, elements.photoQualitySelect, elements.highResolutionSelect, elements.mirrorSelect,
    elements.reviewBehaviorSelect, elements.videoQualitySelect, elements.recordingLimitSelect].forEach((field) => field.addEventListener("change", () => { saveSettings(); updateMediaStatus(); }));
  elements.cameraSelect.addEventListener("change", async () => {
    state.selectedDeviceId = elements.cameraSelect.value;
    saveSettings();
    if (state.stream) await startCamera();
  });

  elements.cameraStage.addEventListener("pointerdown", handlePointerDown);
  elements.cameraStage.addEventListener("pointermove", handlePointerMove);
  elements.cameraStage.addEventListener("pointerup", handlePointerUp);
  elements.cameraStage.addEventListener("pointercancel", handlePointerUp);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    elements.installButton.hidden = false;
  });
  window.addEventListener("appinstalled", () => { state.deferredInstallPrompt = null; elements.installButton.hidden = true; showToast("Quiet Cameraをインストールしました"); });
  window.addEventListener("beforeunload", (event) => {
    if (state.recorder && state.recorder.state !== "inactive") { event.preventDefault(); event.returnValue = ""; }
  });
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && state.stream) await requestWakeLock();
  });
  window.addEventListener("pagehide", () => {
    if (state.recorder && state.recorder.state !== "inactive") {
      try { state.recorder.requestData(); } catch {}
      try { state.recorder.stop(); } catch {}
    }
    stopCamera();
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register("./service-worker.js");
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) showToast("アプリの更新があります。次回起動時に反映されます", 4200);
      });
    });
  } catch (error) { console.error("Service worker registration failed", error); }
}

async function initializeApp() {
  loadSettings();
  applySavedSettings();
  registerEvents();
  if (!mediaRecorderSupported()) {
    elements.videoModeButton.disabled = true;
    elements.videoModeButton.title = "このブラウザは動画録画に対応していません";
    state.mode = "photo";
  }
  await setMode(state.mode, { restart: false });
  await initializeGallery();
  await registerServiceWorker();
}

initializeApp().catch((error) => {
  console.error(error);
  showToast("アプリの初期化に失敗しました");
});
