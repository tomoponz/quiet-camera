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
// Light dismiss only when the press both starts and ends on the ::backdrop.
// Padding and gaps of the dialog itself also target <dialog>, so hit-test its border box.
let dialogBackdropPress = null;
function isOutsideDialogBox(dialog, event) {
  const box = dialog.getBoundingClientRect();
  return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
}
function trackDialogBackdropPress(event) {
  const dialog = event.currentTarget;
  dialogBackdropPress = event.isPrimary && event.button === 0 && event.target === dialog && isOutsideDialogBox(dialog, event) ? { dialog, pointerId: event.pointerId } : null;
}
// A cancelled press (scroll, palm rejection) must not arm a later click.
document.addEventListener("pointercancel", event => { if (dialogBackdropPress?.pointerId === event.pointerId) dialogBackdropPress = null; }, { capture: true, passive: true });
function handleDialogBackdrop(event) {
  const dialog = event.currentTarget, press = dialogBackdropPress;
  // Chromium clicks carry the pointerId of their press; other engines' MouseEvent clicks have none.
  const pressed = press?.dialog === dialog && (event.pointerId === undefined || event.pointerId === press.pointerId);
  dialogBackdropPress = null;
  if (pressed && event.target === dialog && isOutsideDialogBox(dialog, event)) dialog.close();
}

let reviewOperation = null;
function updateReviewActions() {
  const media = state.selectedMedia, busy = Boolean(reviewOperation);
  const pdf = document.querySelector("#reviewPdfButton");
  for (const button of [elements.shareButton, elements.downloadButton, elements.deleteButton]) button.disabled = !media || busy;
  const canPdf = media?.kind === "photo" && Boolean(media.previewBlob || media.blob) && media.mimeType !== "application/pdf" && media.extension !== "pdf";
  pdf.disabled = !canPdf || busy;
  pdf.title = canPdf ? "表示中の写真を1ページのPDFとして履歴に保存" : "PDF化は画像の写真のみ";
  document.querySelector("#reviewActionBar").setAttribute("aria-busy", String(busy));
}

async function exportCurrentPhotoToPdf() {
  const media = state.selectedMedia;
  if (reviewOperation || media?.kind !== "photo" || media.mimeType === "application/pdf" || media.extension === "pdf") return;
  cancelBriefReview();
  const controller = new AbortController(); reviewOperation = controller; updateReviewActions();
  try {
    const current = await getStoredMedia(media.id); controller.signal.throwIfAborted();
    if (!current) throw new Error("表示中の写真は削除されています");
    const page = await blobToJpegPage(current.previewBlob || current.blob); controller.signal.throwIfAborted();
    const blob = await jpegPagesToPdf([page]); controller.signal.throwIfAborted();
    await addMedia({ kind: "photo", origin: "pdf-export", blob, previewBlob: current.previewBlob || current.blob, thumbnailBlob: current.thumbnailBlob || null, extension: "pdf", mimeType: "application/pdf", width: page.width, height: page.height, meta: "PDF · 1ページ · " + formatBytes(blob.size) }, { showReview: false });
    // Stored: report it even if the review was closed while the write finished.
    showToast("表示中の写真をPDFとして履歴に保存しました");
  } catch (error) {
    if (error?.name === "AbortError") showToast("表示を閉じたためPDF化を中止しました");
    else { console.error(error); showToast(error?.name === "QuotaExceededError" ? "空き容量が足りないためPDFを保存できませんでした" : error.message || "PDFを作成できませんでした"); }
  } finally { if (reviewOperation === controller) { reviewOperation = null; updateReviewActions(); } }
}

async function deleteSelectedMedia() {
  const media = state.selectedMedia;
  cancelBriefReview();
  if (reviewOperation || !media || !window.confirm("この撮影結果を端末内の履歴から削除しますか？")) return;
  const controller = new AbortController(); reviewOperation = controller; updateReviewActions();
  let committed = false;
  try {
    await deleteStoredMedia(media.id);
    committed = true;
    // A committed delete cannot be canceled: reconcile the UI even if the review closed meanwhile.
    state.selectedGalleryIds.delete(media.id);
    if (state.selectedMedia?.id === media.id) { closeDialog(elements.reviewDialog); clearSelectedMedia(); }
    showToast("撮影結果を削除しました");
    await refreshGallery();
  } catch (error) {
    console.error(error);
    if (!committed && !controller.signal.aborted) showToast("削除できませんでした。写真は引き続き確認できます");
  } finally { if (reviewOperation === controller) { reviewOperation = null; updateReviewActions(); } }
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

function releaseGalleryDialogResources() {
  window.QuietCameraVideoPreview?.clearGallery();
  for (const url of state.galleryObjectUrls.values()) URL.revokeObjectURL(url);
  state.galleryObjectUrls.clear();
  elements.galleryGrid.replaceChildren();
}

function revokeGalleryUrls() {
  releaseGalleryDialogResources();
  if (state.latestPreviewUrl) URL.revokeObjectURL(state.latestPreviewUrl);
  state.latestPreviewUrl = null;
}

function getGalleryTotalCount() {
  return Math.max(state.gallery.length, Number(state.galleryTotalCount) || 0);
}

function updateGallerySummary() {
  const total = getGalleryTotalCount();
  const loaded = state.gallery.length;
  const loadedText = total > loaded ? `${total}件中 ${loaded}件を表示` : `${total}件`;
  elements.gallerySummary.textContent = loadedText;
}

function updateGalleryButton() {
  const latest = state.gallery[0];
  const total = getGalleryTotalCount();
  elements.galleryCount.textContent = String(total);
  elements.galleryCount.hidden = total === 0;
  elements.galleryPlaceholder.hidden = Boolean(latest);
  elements.previewThumbnail.hidden = true;
  elements.videoThumbnailMark.hidden = true;
  if (!latest) return;
  if (latest.kind === "photo") {
    const previewBlob = latest.thumbnailBlob || latest.previewBlob || latest.blob;
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
  elements.selectAllButton.setAttribute("aria-label", selected > 0 && selected === state.gallery.length ? "表示中の選択を解除" : "表示中をすべて選択");
  elements.selectAllButton.title = elements.selectAllButton.getAttribute("aria-label");
  updateGallerySummary();
  window.QuietCameraGallery?.update();
}

// appendFrom: index of the first state.gallery item not yet in the grid. Load-more
// appends only those cards, keeping existing cards, object URLs and scroll position.
function renderGallery({ appendFrom = null } = {}) {
  const append = appendFrom !== null && elements.galleryGrid.children.length === appendFrom;
  if (!append) releaseGalleryDialogResources();
  elements.galleryEmpty.hidden = state.gallery.length > 0;
  updateGallerySummary();

  for (const media of append ? state.gallery.slice(appendFrom) : state.gallery) {
    const card = document.createElement("article");
    card.className = "gallery-card";
    card.dataset.id = media.id;
    const selectLabel = document.createElement("label");
    selectLabel.className = "gallery-select";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedGalleryIds.has(media.id);
    const mediaLabel = `${media.kind === "video" ? "動画" : media.extension.toUpperCase()} ${formatMediaDate(media.createdAt)}`;
    checkbox.setAttribute("aria-label", `${mediaLabel}を選択`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedGalleryIds.add(media.id);
      else state.selectedGalleryIds.delete(media.id);
      updateGallerySelectionUi();
    });
    selectLabel.append(checkbox);
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "gallery-open";
    openButton.setAttribute("aria-label", `${mediaLabel}を開く`);
    openButton.addEventListener("click", () => {
      selectMedia(media);
      state.reviewReturnFocus = elements.galleryButton;
      elements.galleryDialog.close();
      elements.reviewDialog.showModal();
    });
    const visual = document.createElement("div");
    visual.className = "gallery-visual";
    if (media.kind === "photo") {
      const url = URL.createObjectURL(media.thumbnailBlob || media.previewBlob || media.blob);
      state.galleryObjectUrls.set(media.id, url);
      const image = document.createElement("img");
      image.src = url;
      image.alt = "撮影した写真";
      image.loading = "lazy";
      image.decoding = "async";
      visual.append(image);
    } else {
      window.QuietCameraVideoPreview.mountGallery(media, visual);
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
  await refreshRecoveryNotice().catch((error) => console.warn("Recovery status could not be loaded.", error));
  if (elements.galleryDialog.open) renderGallery();
}

async function refreshRecoveryNotice() {
  const {sessions,busy,unavailable} = await listIdleRecordingSessions();
  state.recoveryBusySessions = busy;
  state.pendingRecoverySessions = sessions;
  const count = state.pendingRecoverySessions.length;
  const legacyCount = state.pendingRecoverySessions.filter(session => session.lockProtocol !== RECORDING_LOCK_PROTOCOL).length;
  const bytes = state.pendingRecoverySessions.reduce((sum, session) => sum + (Number(session.bytes) || 0), 0);
  elements.recoveryNotice.hidden = count === 0 && !unavailable;
  elements.recoverySummary.textContent = count
    ? `復元待ちの録画一時データが${count}件あります${bytes > 0 ? `（${formatBytes(bytes)}）` : ""}。${legacyCount ? "旧版のタブをすべて閉じてから再試行してください。" : "再試行するか、不要なら削除できます。"}`
    : unavailable ? "安全なタブ間ロックを確認できないため、録画一時データを保持しています。対応ブラウザで再試行してください。" : "復元待ちの録画はありません。";
  elements.retryRecoveryButton.disabled = count === 0;
  elements.discardRecoveryButton.disabled = count === 0;
  document.querySelector("#downloadRecoveryButton").disabled = count === 0;
  return state.pendingRecoverySessions;
}

async function retryPendingRecordings() {
  if (!state.pendingRecoverySessions.length) return;
  elements.retryRecoveryButton.disabled = true;
  elements.discardRecoveryButton.disabled = true;
  try {
    const {sessions} = await listIdleRecordingSessions();
    const legacy = sessions.some(session => session.lockProtocol !== RECORDING_LOCK_PROTOCOL);
    if (legacy && !window.confirm("旧版のタブで録画中の場合、復元すると録画が壊れる可能性があります。旧版のQuietCameraタブをすべて閉じ、録画が停止していることを確認しましたか？")) return;
    await recoverInterruptedRecordings({ force: true, legacyTabsClosed: legacy });
    await refreshGallery();
  } catch (error) {
    console.error(error);
    showToast("録画の復元を再試行できませんでした");
  } finally {
    await refreshRecoveryNotice().catch(() => {});
  }
}

async function discardPendingRecordings() {
  const {sessions} = await listIdleRecordingSessions();
  if (!sessions.length) return;
  const legacyWarning = sessions.some(session => session.lockProtocol !== RECORDING_LOCK_PROTOCOL)
    ? "旧版の録画一時データを含みます。旧版のQuietCameraタブをすべて閉じ、録画が停止していることを確認してください。\n" : "";
  if (!window.confirm(`${legacyWarning}${sessions.length}件の録画一時データを完全に削除しますか？`)) return;
  elements.retryRecoveryButton.disabled = true;
  elements.discardRecoveryButton.disabled = true;
  try {
    let removed=0, skipped=0;
    for (const session of sessions) {
      const result=await withIdleRecordingSession(session, async latest => { await cleanupRecordingSession(latest.id); return "removed"; });
      if (result === "removed") removed += 1;
      else if (result === RECORDING_SESSION_BUSY) skipped += 1;
    }
    showToast(`${removed}件の録画一時データを削除しました${skipped?`（${skipped}件は使用中またはロックを確認できないため保持）`:""}`);
  } catch (error) {
    console.error(error);
    showToast("録画一時データをすべて削除できませんでした");
  } finally {
    await refreshRecoveryNotice().catch(() => {});
  }
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

async function deleteSelectedGalleryMedia() { return window.QuietCameraGallery?.deleteSelected(); }

function toggleSelectAll() {
  if (state.gallery.length && state.gallery.every(item => state.selectedGalleryIds.has(item.id))) state.gallery.forEach(item => state.selectedGalleryIds.delete(item.id));
  else state.gallery.forEach((item) => state.selectedGalleryIds.add(item.id));
  updateGallerySelectionUi();
}

async function exportSelectedPhotosToPdf() { return window.QuietCameraGallery?.exportPdf(); }

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
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // A first install may claim this page. Reload only after the user accepted an update.
    if (!state.serviceWorkerUpdateRequested) return;
    state.serviceWorkerUpdateRequested = false;
    window.location.reload();
  });
}

function requestServiceWorkerUpdate() {
  const recordingActive = Boolean(state.recorder && state.recorder.state !== "inactive") || state.recordingFinalizing;
  if (recordingActive || state.busy) {
    state.serviceWorkerReloadPending = true;
    showToast("撮影データの保存後にアプリを更新します");
    return false;
  }
  if (!state.waitingServiceWorker) return false;
  state.serviceWorkerReloadPending = false;
  state.serviceWorkerUpdateRequested = true;
  state.waitingServiceWorker.postMessage({ type: "SKIP_WAITING" });
  return true;
}

async function initializeApp() {
  applySavedSettings();
  updateModeUi();
  await recoverInterruptedRecordings();
  await refreshGallery();
  if (!mediaRecorderSupported()) {
    elements.videoModeButton.disabled = true;
    elements.videoModeButton.title = "このブラウザは動画録画に対応していません";
    elements.videoSupportStatus.textContent = "このブラウザは動画録画に対応していません。写真モードを利用できます。";
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
elements.closeCameraPermissionButton.addEventListener("click", () => closeDialog(elements.cameraPermissionDialog));
elements.closeCameraPermissionIconButton.addEventListener("click", () => closeDialog(elements.cameraPermissionDialog));
elements.cameraPermissionHelpButton.addEventListener("click", () => {
  setCameraPermissionHelpExpanded(elements.cameraPermissionHelpButton.getAttribute("aria-expanded") !== "true");
});
elements.retryCameraPermissionButton.addEventListener("click", async () => {
  closeDialog(elements.cameraPermissionDialog);
  await startCamera();
});
elements.deleteButton.addEventListener("click", deleteSelectedMedia);
elements.downloadButton.addEventListener("click", downloadMedia);
elements.shareButton.addEventListener("click", shareMedia);
document.querySelector("#reviewPdfButton").addEventListener("click", exportCurrentPhotoToPdf);
document.addEventListener("quietcamera:reviewchange", updateReviewActions);
elements.reviewDialog.addEventListener("close", () => { if (!elements.reviewDialog.open) { reviewOperation?.abort(); reviewOperation = null; updateReviewActions(); } });
// "2秒表示": contact pauses, release (all pointers up) restarts 2 s; keyboard input and actions keep it open.
const briefPointers = new Set();
// A second finger (pinch) or a long press (image context menu) means the user is inspecting: keep it open.
elements.reviewDialog.addEventListener("pointerdown", event => { briefPointers.add(event.pointerId); if (briefPointers.size > 1) cancelBriefReview(); else pauseBriefReview(); }, { capture: true, passive: true });
elements.reviewDialog.addEventListener("contextmenu", cancelBriefReview, { capture: true });
for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, event => { if (briefPointers.delete(event.pointerId) && !briefPointers.size) resumeBriefReview(); }, { capture: true, passive: true });
elements.reviewDialog.addEventListener("keydown", cancelBriefReview, { capture: true });
elements.reviewDialog.addEventListener("click", event => { if (event.target.closest?.("button, a, input, select, video")) cancelBriefReview(); }, { capture: true });
elements.reviewDialog.addEventListener("close", () => { if (!elements.reviewDialog.open) briefPointers.clear(); });
updateReviewActions();
elements.selectAllButton.addEventListener("click", toggleSelectAll);
elements.deleteSelectedButton.addEventListener("click", deleteSelectedGalleryMedia);
elements.exportPdfButton.addEventListener("click", exportSelectedPhotosToPdf);
elements.retryRecoveryButton.addEventListener("click", retryPendingRecordings);
elements.discardRecoveryButton.addEventListener("click", discardPendingRecordings);
document.querySelector("#downloadRecoveryButton").addEventListener("click",()=>downloadPendingRecordingData().catch(error=>showToast(error.message||"一時データの保存を開始できませんでした。データは保持しています")));
elements.privacyButton.addEventListener("click", () => elements.privacyDialog.showModal());
elements.installButton.addEventListener("click", installApp);
elements.updateButton.addEventListener("click", requestServiceWorkerUpdate);
for (const dialog of [elements.reviewDialog, elements.galleryDialog, elements.privacyDialog, elements.cameraPermissionDialog]) {
  dialog.addEventListener("pointerdown", trackDialogBackdropPress, { capture: true, passive: true });
  dialog.addEventListener("click", handleDialogBackdrop);
}
elements.cameraPermissionDialog.addEventListener("close", () => setCameraPermissionHelpExpanded(false));
elements.reviewDialog.addEventListener("close", () => {
  // close is queued: a rapid reopen must not clear the newly selected media.
  if (elements.reviewDialog.open) return;
  cancelBriefReview();
  clearSelectedMedia();
  const returnFocus = state.reviewReturnFocus;
  state.reviewReturnFocus = null;
  if (returnFocus?.isConnected) window.setTimeout(() => {
    const target = !returnFocus.disabled ? returnFocus : elements.galleryButton;
    if (!target.disabled) target.focus({ preventScroll: true });
  }, 0);
});
elements.galleryDialog.addEventListener("close", () => { if (!elements.galleryDialog.open) releaseGalleryDialogResources(); });

bindSetting(elements.photoFormatSelect, { updateStatus: true });
bindSetting(elements.photoQualitySelect);
bindSetting(elements.autoReviewSelect);
bindSetting(elements.selfieMirrorSelect);
bindSetting(elements.microphoneSelect, { restartCamera: true });
elements.microphoneSelect.addEventListener("change", syncMicrophoneStatus);
bindSetting(elements.videoResolutionSelect, { restartCamera: true });
bindSetting(elements.videoFrameRateSelect, { restartCamera: true });
bindSetting(elements.videoQualitySelect);
bindSetting(elements.recordingLimitSelect);

elements.cameraStage.addEventListener("pointerdown", handlePointerDown);
elements.cameraStage.addEventListener("pointermove", handlePointerMove);
elements.cameraStage.addEventListener("pointerup", handlePointerUp);
elements.cameraStage.addEventListener("pointercancel", handlePointerUp);
elements.cameraStage.addEventListener("keydown", (event) => {
  if (event.target !== elements.cameraStage || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  const rect = elements.video.getBoundingClientRect();
  focusAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
});

window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); state.deferredInstallPrompt = event; elements.installButton.hidden = false; });
window.addEventListener("appinstalled", () => { state.deferredInstallPrompt = null; elements.installButton.hidden = true; showToast("Quiet Cameraをインストールしました"); });
window.addEventListener("beforeunload", (event) => { if ((state.recorder && state.recorder.state !== "inactive") || state.recordingFinalizing) { event.preventDefault(); event.returnValue = ""; } });
document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible" && state.stream) await requestWakeLock(); });
window.addEventListener("pagehide", () => {
  if (state.recorder && state.recorder.state !== "inactive") {
    try { state.recorder.requestData?.(); } catch {}
    try { state.recorder.stop(); } catch {}
  }
  stopCamera();
  releaseSelectedMediaUrls();
  revokeGalleryUrls();
});

registerServiceWorker();
initializeApp().catch((error) => { console.error(error); showToast("保存済みデータの読み込みに失敗しました"); });
