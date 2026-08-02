"use strict";

function createFileName(media = state.selectedMedia) {
  if (!media) return "quiet-camera";
  const date = new Date(media.createdAt || Date.now());
  const pad = (value) => String(value).padStart(2, "0");
  return ["quiet-camera", `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`, `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`].join("_") + `.${media.extension}`;
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function downloadMedia() {
  if (!state.selectedMedia) return;
  triggerDownload(state.selectedMedia.blob, createFileName());
  showToast("保存を開始しました");
}

async function shareMedia() {
  if (!state.selectedMedia) return;
  const file = new File([state.selectedMedia.blob], createFileName(), { type: state.selectedMedia.mimeType });
  const shareData = { files: [file], title: "Quiet Camera" };
  if (!navigator.share || (navigator.canShare && !navigator.canShare(shareData))) {
    downloadMedia();
    showToast("共有に非対応のため保存を開始しました");
    return;
  }
  try { await navigator.share(shareData); }
  catch (error) {
    if (error?.name !== "AbortError") {
      console.error(error);
      showToast("共有できませんでした");
    }
  }
}

function closeDialog(dialog) { if (dialog.open) dialog.close(); }
function handleDialogBackdrop(event) { if (event.target === event.currentTarget) event.currentTarget.close(); }

async function deleteSelectedMedia() {
  if (!state.selectedMedia) return;
  if (!window.confirm("この撮影結果を端末内の履歴から削除しますか？")) return;
  const id = state.selectedMedia.id;
  closeDialog(elements.reviewDialog);
  clearSelectedMedia();
  await deleteStoredMedia(id);
  state.selectedGalleryIds.delete(id);
  await refreshGallery();
  showToast("撮影結果を削除しました");
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

function revokeGalleryUrls() {
  for (const url of state.galleryObjectUrls.values()) URL.revokeObjectURL(url);
  state.galleryObjectUrls.clear();
  if (state.latestPreviewUrl) URL.revokeObjectURL(state.latestPreviewUrl);
  state.latestPreviewUrl = null;
}

function updateGalleryButton() {
  const latest = state.gallery[0];
  elements.galleryCount.textContent = String(state.gallery.length);
  elements.galleryCount.hidden = state.gallery.length === 0;
  elements.galleryPlaceholder.hidden = Boolean(latest);
  elements.previewThumbnail.hidden = true;
  elements.videoThumbnailMark.hidden = true;
  if (!latest) return;
  if (latest.kind === "photo") {
    const previewBlob = latest.previewBlob || latest.blob;
    state.latestPreviewUrl = URL.createObjectURL(previewBlob);
    elements.previewThumbnail.src = state.latestPreviewUrl;
    elements.previewThumbnail.hidden = false;
  } else elements.videoThumbnailMark.hidden = false;
}

function formatMediaDate(timestamp) {
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function updateGallerySelectionUi() {
  const selected = state.selectedGalleryIds.size;
  const selectedItems = state.gallery.filter((item) => state.selectedGalleryIds.has(item.id));
  const selectedPhotos = selectedItems.filter((item) => item.kind === "photo" && item.previewBlob);
  elements.deleteSelectedButton.disabled = selected === 0;
  elements.exportPdfButton.disabled = selectedPhotos.length === 0;
  elements.selectAllButton.textContent = selected > 0 && selected === state.gallery.length ? "選択解除" : "すべて選択";
}

function renderGallery() {
  for (const url of state.galleryObjectUrls.values()) URL.revokeObjectURL(url);
  state.galleryObjectUrls.clear();
  elements.galleryGrid.replaceChildren();
  elements.galleryEmpty.hidden = state.gallery.length > 0;
  elements.gallerySummary.textContent = `${state.gallery.length}件 · 選択${state.selectedGalleryIds.size}件`;

  for (const media of state.gallery) {
    const card = document.createElement("article");
    card.className = "gallery-card";
    card.dataset.id = media.id;
    const selectLabel = document.createElement("label");
    selectLabel.className = "gallery-select";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedGalleryIds.has(media.id);
    checkbox.setAttribute("aria-label", "選択");
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedGalleryIds.add(media.id);
      else state.selectedGalleryIds.delete(media.id);
      renderGallery();
    });
    selectLabel.append(checkbox);
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "gallery-open";
    openButton.addEventListener("click", () => {
      selectMedia(media);
      elements.galleryDialog.close();
      elements.reviewDialog.showModal();
    });
    const visual = document.createElement("div");
    visual.className = "gallery-visual";
    if (media.kind === "photo") {
      const url = URL.createObjectURL(media.previewBlob || media.blob);
      state.galleryObjectUrls.set(media.id, url);
      const image = document.createElement("img");
      image.src = url;
      image.alt = "撮影した写真";
      visual.append(image);
    } else {
      visual.classList.add("video-placeholder");
      visual.innerHTML = "<span>▶</span><small>VIDEO</small>";
    }
    const info = document.createElement("div");
    info.className = "gallery-info";
    const kind = media.kind === "video" ? "動画" : media.extension.toUpperCase();
    info.innerHTML = `<strong>${kind}</strong><span>${formatMediaDate(media.createdAt)}</span><small>${formatBytes(media.blob.size)}</small>`;
    openButton.append(visual, info);
    card.append(selectLabel, openButton);
    elements.galleryGrid.append(card);
  }
  updateGallerySelectionUi();
}

async function refreshGallery() {
  revokeGalleryUrls();
  state.gallery = await listStoredMedia();
  const validIds = new Set(state.gallery.map((item) => item.id));
  for (const id of state.selectedGalleryIds) if (!validIds.has(id)) state.selectedGalleryIds.delete(id);
  updateGalleryButton();
  if (elements.galleryDialog.open) renderGallery();
}

async function openGallery() {
  if (elements.galleryButton.dataset.recordingCancel === "true") {
    if (window.confirm("現在の録画を破棄しますか？")) stopRecording({ cancel: true });
    return;
  }
  await refreshGallery();
  renderGallery();
  elements.galleryDialog.showModal();
}

async function deleteSelectedGalleryMedia() {
  const ids = [...state.selectedGalleryIds];
  if (!ids.length) return;
  if (!window.confirm(`${ids.length}件の撮影結果を削除しますか？`)) return;
  await Promise.all(ids.map((id) => deleteStoredMedia(id)));
  state.selectedGalleryIds.clear();
  await refreshGallery();
  renderGallery();
  showToast(`${ids.length}件を削除しました`);
}

function toggleSelectAll() {
  if (state.selectedGalleryIds.size === state.gallery.length) state.selectedGalleryIds.clear();
  else state.gallery.forEach((item) => state.selectedGalleryIds.add(item.id));
  renderGallery();
}

async function exportSelectedPhotosToPdf() {
  const photos = state.gallery.filter((item) => state.selectedGalleryIds.has(item.id) && item.kind === "photo" && item.previewBlob).sort((a, b) => a.createdAt - b.createdAt);
  if (!photos.length) return;
  elements.exportPdfButton.disabled = true;
  try {
    const pages = [];
    for (const photo of photos) pages.push(await blobToJpegPage(photo.previewBlob));
    const pdfBlob = await jpegPagesToPdf(pages);
    await addMedia({ kind: "photo", blob: pdfBlob, previewBlob: photos[0].previewBlob, extension: "pdf", mimeType: "application/pdf", width: pages[0].width, height: pages[0].height, meta: `PDF · ${photos.length}ページ · ${formatBytes(pdfBlob.size)}` }, { showReview: false });
    state.selectedGalleryIds.clear();
    await refreshGallery();
    renderGallery();
    showToast(`${photos.length}ページのPDFを作成しました`);
  } catch (error) {
    console.error(error);
    showToast("PDFの作成に失敗しました");
  }
}

function showFocusRing(clientX, clientY, mode = "success") {
  const rect = elements.cameraStage.getBoundingClientRect();
  elements.focusRing.style.left = `${clientX - rect.left}px`;
  elements.focusRing.style.top = `${clientY - rect.top}px`;
  elements.focusRing.classList.remove("visible", "failed", "fallback");
  void elements.focusRing.offsetWidth;
  if (mode === "failed") elements.focusRing.classList.add("failed");
  if (mode === "fallback") elements.focusRing.classList.add("fallback");
  elements.focusRing.classList.add("visible");
}

function mapDisplayPointToSensor(clientX, clientY) {
  const rect = elements.video.getBoundingClientRect();
  const sourceWidth = elements.video.videoWidth || rect.width;
  const sourceHeight = elements.video.videoHeight || rect.height;
  const scale = Math.max(rect.width / sourceWidth, rect.height / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  const croppedX = (renderedWidth - rect.width) / 2;
  const croppedY = (renderedHeight - rect.height) / 2;
  let x = (clientX - rect.left + croppedX) / renderedWidth;
  let y = (clientY - rect.top + croppedY) / renderedHeight;
  if (state.isFrontCamera) x = 1 - x;
  x = Math.min(1, Math.max(0, x));
  y = Math.min(1, Math.max(0, y));
  return { x, y };
}

async function tryFocusConstraint(advanced) {
  try {
    await state.videoTrack.applyConstraints({ advanced: [advanced] });
    return true;
  } catch { return false; }
}

async function focusAt(clientX, clientY) {
  if (!state.videoTrack || state.recorder?.state === "recording") return;
  const rect = elements.video.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;
  const point = mapDisplayPointToSensor(clientX, clientY);
  const focusModes = Array.isArray(state.capabilities.focusMode) ? state.capabilities.focusMode : [];
  const attempts = [];
  if (focusModes.includes("single-shot")) attempts.push({ focusMode: "single-shot", pointsOfInterest: [point] });
  attempts.push({ pointsOfInterest: [point] });
  if (focusModes.includes("single-shot")) attempts.push({ focusMode: "single-shot" });
  if (focusModes.includes("continuous")) attempts.push({ focusMode: "continuous" });
  attempts.push({ focusMode: "single-shot" }, { focusMode: "continuous" });
  for (const attempt of attempts) {
    if (await tryFocusConstraint(attempt)) {
      showFocusRing(clientX, clientY, "success");
      return;
    }
  }
  showFocusRing(clientX, clientY, "fallback");
  if (!focusAt.fallbackNoticeShown) {
    showToast("このブラウザでは位置指定AFが非公開のため、端末の自動フォーカスを使用します");
    focusAt.fallbackNoticeShown = true;
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
  if (state.pinchPointers.size === 2 && state.capabilities.zoom && state.pinchStartDistance > 0) applyZoom(state.pinchStartZoom * (pointerDistance() / state.pinchStartDistance));
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
  try { await state.deferredInstallPrompt.userChoice; }
  finally { state.deferredInstallPrompt = null; elements.installButton.hidden = true; }
}

function bindSetting(control, { restartCamera = false, updateStatus = false } = {}) {
  control.addEventListener("change", async () => {
    persistCurrentSettings();
    if (updateStatus) updateMediaStatus();
    if (restartCamera && state.stream) await startCamera();
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./service-worker.js");
      if (registration.waiting) {
        state.waitingServiceWorker = registration.waiting;
        elements.updateButton.hidden = false;
      }
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            state.waitingServiceWorker = registration.waiting || worker;
            elements.updateButton.hidden = false;
            showToast("アプリの更新があります");
          }
        });
      });
    } catch (error) { console.error("Service worker registration failed:", error); }
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload());
}

async function initializeApp() {
  applySavedSettings();
  updateModeUi();
  await recoverInterruptedRecordings();
  await refreshGallery();
  if (!mediaRecorderSupported()) {
    elements.videoModeButton.disabled = true;
    elements.videoModeButton.title = "このブラウザは動画録画に対応していません";
    if (state.mode === "video") { state.mode = "photo"; updateModeUi(); }
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
elements.exposureRange.addEventListener("input", (event) => applyExposure(event.target.value));
elements.shutterButton.addEventListener("click", handleShutter);
elements.galleryButton.addEventListener("click", openGallery);
elements.closeReviewButton.addEventListener("click", () => closeDialog(elements.reviewDialog));
elements.closeGalleryButton.addEventListener("click", () => closeDialog(elements.galleryDialog));
elements.closePrivacyButton.addEventListener("click", () => closeDialog(elements.privacyDialog));
elements.deleteButton.addEventListener("click", deleteSelectedMedia);
elements.downloadButton.addEventListener("click", downloadMedia);
elements.shareButton.addEventListener("click", shareMedia);
elements.selectAllButton.addEventListener("click", toggleSelectAll);
elements.deleteSelectedButton.addEventListener("click", deleteSelectedGalleryMedia);
elements.exportPdfButton.addEventListener("click", exportSelectedPhotosToPdf);
elements.privacyButton.addEventListener("click", () => elements.privacyDialog.showModal());
elements.installButton.addEventListener("click", installApp);
elements.updateButton.addEventListener("click", () => state.waitingServiceWorker?.postMessage({ type: "SKIP_WAITING" }));
elements.reviewDialog.addEventListener("click", handleDialogBackdrop);
elements.galleryDialog.addEventListener("click", handleDialogBackdrop);
elements.privacyDialog.addEventListener("click", handleDialogBackdrop);
elements.reviewDialog.addEventListener("close", () => elements.reviewVideo.pause());

bindSetting(elements.photoFormatSelect, { updateStatus: true });
bindSetting(elements.photoQualitySelect);
bindSetting(elements.autoReviewSelect);
bindSetting(elements.selfieMirrorSelect);
bindSetting(elements.microphoneSelect, { restartCamera: true });
bindSetting(elements.videoResolutionSelect, { restartCamera: true });
bindSetting(elements.videoFrameRateSelect, { restartCamera: true });
bindSetting(elements.videoQualitySelect);
bindSetting(elements.recordingLimitSelect);

elements.cameraStage.addEventListener("pointerdown", handlePointerDown);
elements.cameraStage.addEventListener("pointermove", handlePointerMove);
elements.cameraStage.addEventListener("pointerup", handlePointerUp);
elements.cameraStage.addEventListener("pointercancel", handlePointerUp);

window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); state.deferredInstallPrompt = event; elements.installButton.hidden = false; });
window.addEventListener("appinstalled", () => { state.deferredInstallPrompt = null; elements.installButton.hidden = true; showToast("Quiet Cameraをインストールしました"); });
window.addEventListener("beforeunload", (event) => { if (state.recorder?.state === "recording") { event.preventDefault(); event.returnValue = ""; } });
document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible" && state.stream) await requestWakeLock(); });
window.addEventListener("pagehide", () => {
  if (state.recorder?.state === "recording") {
    try { state.recorder.requestData?.(); } catch {}
    try { state.recorder.stop(); } catch {}
  }
  stopCamera();
  releaseSelectedMediaUrls();
  revokeGalleryUrls();
});

registerServiceWorker();
initializeApp().catch((error) => { console.error(error); showToast("保存済みデータの読み込みに失敗しました"); });
