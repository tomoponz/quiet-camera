"use strict";

const elements = {
  video: document.querySelector("#cameraVideo"),
  canvas: document.querySelector("#captureCanvas"),
  cameraStage: document.querySelector("#cameraStage"),
  permissionPanel: document.querySelector("#permissionPanel"),
  permissionCopy: document.querySelector("#permissionCopy"),
  startButton: document.querySelector("#startButton"),
  photoModeButton: document.querySelector("#photoModeButton"),
  videoModeButton: document.querySelector("#videoModeButton"),
  videoSupportStatus: document.querySelector("#videoSupportStatus"),
  microphoneStatusButton: document.querySelector("#microphoneStatusButton"),
  microphoneStatusText: document.querySelector("#microphoneStatusText"),
  microphoneStatusDetail: document.querySelector("#microphoneStatusDetail"),
  switchButton: document.querySelector("#switchButton"),
  timerButton: document.querySelector("#timerButton"),
  ratioButton: document.querySelector("#ratioButton"),
  torchButton: document.querySelector("#torchButton"),
  gridButton: document.querySelector("#gridButton"),
  gridOverlay: document.querySelector("#gridOverlay"),
  focusRing: document.querySelector("#focusRing"),
  zoomControl: document.querySelector("#zoomControl"),
  zoomRange: document.querySelector("#zoomRange"),
  zoomValue: document.querySelector("#zoomValue"),
  exposureControl: document.querySelector("#exposureControl"),
  exposureRange: document.querySelector("#exposureRange"),
  exposureValue: document.querySelector("#exposureValue"),
  shutterButton: document.querySelector("#shutterButton"),
  cameraStatus: document.querySelector("#cameraStatus"),
  mediaStatus: document.querySelector("#mediaStatus"),
  countdown: document.querySelector("#countdown"),
  flashOverlay: document.querySelector("#flashOverlay"),
  recordingBadge: document.querySelector("#recordingBadge"),
  recordingTime: document.querySelector("#recordingTime"),
  recordingSize: document.querySelector("#recordingSize"),
  recordingAudioState: document.querySelector("#recordingAudioState"),
  photoFormatField: document.querySelector("#photoFormatField"),
  photoFormatSelect: document.querySelector("#photoFormatSelect"),
  photoQualityField: document.querySelector("#photoQualityField"),
  photoQualitySelect: document.querySelector("#photoQualitySelect"),
  autoReviewField: document.querySelector("#autoReviewField"),
  autoReviewSelect: document.querySelector("#autoReviewSelect"),
  selfieMirrorField: document.querySelector("#selfieMirrorField"),
  selfieMirrorSelect: document.querySelector("#selfieMirrorSelect"),
  microphoneField: document.querySelector("#microphoneField"),
  microphoneSelect: document.querySelector("#microphoneSelect"),
  videoResolutionField: document.querySelector("#videoResolutionField"),
  videoResolutionSelect: document.querySelector("#videoResolutionSelect"),
  videoFrameRateField: document.querySelector("#videoFrameRateField"),
  videoFrameRateSelect: document.querySelector("#videoFrameRateSelect"),
  videoQualityField: document.querySelector("#videoQualityField"),
  videoQualitySelect: document.querySelector("#videoQualitySelect"),
  recordingLimitField: document.querySelector("#recordingLimitField"),
  recordingLimitSelect: document.querySelector("#recordingLimitSelect"),
  galleryButton: document.querySelector("#galleryButton"),
  galleryPlaceholder: document.querySelector("#galleryPlaceholder"),
  previewThumbnail: document.querySelector("#previewThumbnail"),
  videoThumbnailMark: document.querySelector("#videoThumbnailMark"),
  galleryCount: document.querySelector("#galleryCount"),
  reviewDialog: document.querySelector("#reviewDialog"),
  reviewTitle: document.querySelector("#reviewTitle"),
  reviewMeta: document.querySelector("#reviewMeta"),
  reviewImage: document.querySelector("#reviewImage"),
  reviewVideo: document.querySelector("#reviewVideo"),
  closeReviewButton: document.querySelector("#closeReviewButton"),
  deleteButton: document.querySelector("#deleteButton"),
  downloadButton: document.querySelector("#downloadButton"),
  shareButton: document.querySelector("#shareButton"),
  galleryDialog: document.querySelector("#galleryDialog"),
  closeGalleryButton: document.querySelector("#closeGalleryButton"),
  gallerySummary: document.querySelector("#gallerySummary"),
  galleryGrid: document.querySelector("#galleryGrid"),
  galleryEmpty: document.querySelector("#galleryEmpty"),
  recoveryNotice: document.querySelector("#recoveryNotice"),
  recoverySummary: document.querySelector("#recoverySummary"),
  retryRecoveryButton: document.querySelector("#retryRecoveryButton"),
  discardRecoveryButton: document.querySelector("#discardRecoveryButton"),
  selectAllButton: document.querySelector("#selectAllButton"),
  exportPdfButton: document.querySelector("#exportPdfButton"),
  deleteSelectedButton: document.querySelector("#deleteSelectedButton"),
  privacyButton: document.querySelector("#privacyButton"),
  privacyDialog: document.querySelector("#privacyDialog"),
  closePrivacyButton: document.querySelector("#closePrivacyButton"),
  installButton: document.querySelector("#installButton"),
  updateButton: document.querySelector("#updateButton"),
  toast: document.querySelector("#toast"),
};

const DEFAULT_SETTINGS = {
  mode: "photo",
  timer: 0,
  ratio: "4:3",
  videoRatio: "16:9",
  grid: false,
  photoFormat: "image/jpeg",
  photoQuality: "0.92",
  autoReview: "always",
  selfieMirror: "mirrored",
  microphone: "off",
  videoResolution: "auto",
  videoFrameRate: "auto",
  videoQuality: "standard",
  recordingLimit: "10",
};

const savedSettings = loadSavedSettings(DEFAULT_SETTINGS);
const state = {
  stream: null,
  videoTrack: null,
  capabilities: {},
  facingMode: "environment",
  isFrontCamera: false,
  mode: savedSettings.mode === "video" ? "video" : "photo",
  timerSeconds: Number(savedSettings.timer) || 0,
  ratio: ["4:3", "1:1", "16:9"].includes(savedSettings.ratio) ? savedSettings.ratio : "4:3",
  videoRatio: ["4:3", "1:1", "16:9"].includes(savedSettings.videoRatio) ? savedSettings.videoRatio : "16:9",
  torchEnabled: false,
  currentZoom: 1,
  currentExposure: 0,
  selectedMedia: null,
  selectedObjectUrl: null,
  selectedPreviewUrl: null,
  gallery: [],
  selectedGalleryIds: new Set(),
  galleryObjectUrls: new Map(),
  busy: false,
  recorder: null,
  recordingSessionId: null,
  recordingChunkIndex: 0,
  recordingWriteQueue: Promise.resolve(),
  recordingWriteError: null,
  recordingRuntimeError: null,
  recordingChunkMimeType: "",
  recordingBytes: 0,
  recordingEmittedBytes: 0,
  recordingMaxBytes: null,
  recordingStartedAt: 0,
  recordingDurationMs: 0,
  recordingTimerId: null,
  cancelRecording: false,
  recordingFinalizing: false,
  deferredInstallPrompt: null,
  waitingServiceWorker: null,
  serviceWorkerUpdateRequested: false,
  serviceWorkerReloadPending: false,
  wakeLock: null,
  pinchPointers: new Map(),
  pinchStartDistance: 0,
  pinchStartZoom: 1,
  pinchGestureActive: false,
  briefReviewTimer: null,
  reviewReturnFocus: null,
  pendingRecoverySessions: [],
};

const ratioModel = window.QuietCameraRatioModel;
const ratioSequence = [...ratioModel.RATIO_SEQUENCE];
const timerSequence = [0, 3, 10];
const PHOTO_EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

function makeId(prefix = "media") {
  return `${prefix}-${Date.now()}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => elements.toast.classList.remove("visible"), 3000);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value.toFixed(index === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function mediaRecorderSupported() { return typeof MediaRecorder !== "undefined"; }
function microphoneEnabled() { return state.mode === "video" && elements.microphoneSelect.value === "on"; }

function syncMicrophoneStatus() {
  const videoMode = state.mode === "video";
  const enabled = elements.microphoneSelect.value === "on";
  elements.microphoneStatusButton.hidden = !videoMode;
  elements.microphoneStatusButton.classList.toggle("microphone-on", enabled);
  elements.microphoneStatusButton.classList.toggle("microphone-off", !enabled);
  elements.microphoneStatusText.textContent = enabled ? "ON" : "OFF";
  const detail = enabled
    ? "現在、マイクはONです。音声を録音します。押すとマイク設定を開きます。"
    : "現在、マイクはOFFです。音声は録音されません。押すとマイク設定を開きます。";
  elements.microphoneStatusDetail.textContent = detail;
  elements.microphoneStatusButton.setAttribute("aria-label", detail);
}

function collectSettings() {
  return {
    mode: state.mode,
    timer: state.timerSeconds,
    ratio: state.ratio,
    videoRatio: state.videoRatio,
    grid: !elements.gridOverlay.hidden,
    photoFormat: elements.photoFormatSelect.value,
    photoQuality: elements.photoQualitySelect.value,
    autoReview: elements.autoReviewSelect.value,
    selfieMirror: elements.selfieMirrorSelect.value,
    microphone: "off",
    videoResolution: elements.videoResolutionSelect.value,
    videoFrameRate: elements.videoFrameRateSelect.value,
    videoQuality: elements.videoQualitySelect.value,
    recordingLimit: elements.recordingLimitSelect.value,
  };
}

function persistCurrentSettings() { saveSettings(collectSettings()); }

function syncTimerButton() {
  const label = state.timerSeconds === 0 ? "OFF" : `${state.timerSeconds}s`;
  elements.timerButton.textContent = label;
  elements.timerButton.setAttribute("aria-label", state.timerSeconds === 0 ? "セルフタイマー: オフ" : `セルフタイマー: ${state.timerSeconds}秒`);
}

function syncRatioButton() {
  const ratio = state.mode === "video" ? state.videoRatio : state.ratio;
  const mediaKind = state.mode === "video" ? "動画" : "写真";
  elements.ratioButton.textContent = ratio;
  elements.ratioButton.setAttribute("aria-label", `${mediaKind}比率: ${ratio.replace(":", "対")}`);
}

function ratioValue(ratio) {
  return ratioModel.ratioValue(ratio);
}

function getVideoTrackTargetAspectRatio() {
  return ratioModel.targetTrackAspectRatio(state.videoRatio);
}

function normalizedVideoTrackAspectRatio(settings = {}) {
  return ratioModel.normalizedTrackAspectRatio(settings);
}

function ratiosApproximatelyMatch(first, second, tolerance = 0.035) {
  return ratioModel.approximatelyMatches(first, second, tolerance);
}

function syncVideoRatioWithTrack(settings, { announce = true } = {}) {
  if (state.mode !== "video") return true;
  const actualRatio = normalizedVideoTrackAspectRatio(settings);
  const requestedRatio = ratioValue(state.videoRatio);
  if (!actualRatio || ratiosApproximatelyMatch(actualRatio, requestedRatio)) return true;

  const actualLabel = ratioModel.closestRatioLabel(actualRatio);
  const requestedLabel = state.videoRatio;
  if (!actualLabel || requestedLabel === actualLabel) return false;
  state.videoRatio = actualLabel;
  syncRatioButton();
  applyStageRatio();
  persistCurrentSettings();
  if (announce) {
    showToast(`このカメラは${requestedLabel}動画に対応しないため、実映像に近い${actualLabel}へ戻しました`);
  }
  return false;
}

function applySavedSettings() {
  elements.photoFormatSelect.value = savedSettings.photoFormat;
  elements.photoQualitySelect.value = savedSettings.photoQuality;
  elements.autoReviewSelect.value = savedSettings.autoReview;
  elements.selfieMirrorSelect.value = savedSettings.selfieMirror;
  elements.microphoneSelect.value = "off";
  elements.videoResolutionSelect.value = savedSettings.videoResolution;
  elements.videoFrameRateSelect.value = savedSettings.videoFrameRate;
  elements.videoQualitySelect.value = savedSettings.videoQuality;
  elements.recordingLimitSelect.value = savedSettings.recordingLimit;
  syncTimerButton();
  syncRatioButton();
  elements.gridOverlay.hidden = !savedSettings.grid;
  elements.gridButton.setAttribute("aria-pressed", String(Boolean(savedSettings.grid)));
}

function getVideoPreset() {
  const resolution = elements.videoResolutionSelect.value;
  const frameRate = elements.videoFrameRateSelect.value;
  const video = { facingMode: { ideal: state.facingMode } };
  if (resolution === "720") { video.width = { ideal: 1280 }; video.height = { ideal: 720 }; }
  else if (resolution === "1080") { video.width = { ideal: 1920 }; video.height = { ideal: 1080 }; }
  else { video.width = { ideal: 3840 }; video.height = { ideal: 2160 }; }
  if (frameRate !== "auto") video.frameRate = { ideal: Number(frameRate) };
  return video;
}

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  state.videoTrack = null;
  state.capabilities = {};
  state.torchEnabled = false;
  elements.video.srcObject = null;
  elements.shutterButton.disabled = true;
  elements.torchButton.hidden = true;
  elements.zoomControl.hidden = true;
  elements.exposureControl.hidden = true;
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try { state.wakeLock = await navigator.wakeLock.request("screen"); }
  catch { state.wakeLock = null; }
}

function updateCapabilities() {
  state.capabilities = state.videoTrack?.getCapabilities?.() ?? {};
  const settings = state.videoTrack?.getSettings?.() ?? {};
  const zoom = state.capabilities.zoom;
  if (zoom && Number.isFinite(zoom.min) && Number.isFinite(zoom.max) && zoom.max > zoom.min) {
    state.currentZoom = Number(settings.zoom ?? zoom.min);
    elements.zoomRange.min = String(zoom.min);
    elements.zoomRange.max = String(zoom.max);
    elements.zoomRange.step = String(zoom.step || 0.1);
    elements.zoomRange.value = String(state.currentZoom);
    elements.zoomValue.value = `${state.currentZoom.toFixed(1)}×`;
    elements.zoomControl.hidden = false;
  } else elements.zoomControl.hidden = true;

  const exposure = state.capabilities.exposureCompensation;
  if (exposure && Number.isFinite(exposure.min) && Number.isFinite(exposure.max) && exposure.max > exposure.min) {
    state.currentExposure = Number(settings.exposureCompensation ?? 0);
    elements.exposureRange.min = String(exposure.min);
    elements.exposureRange.max = String(exposure.max);
    elements.exposureRange.step = String(exposure.step || 0.1);
    elements.exposureRange.value = String(state.currentExposure);
    elements.exposureValue.value = state.currentExposure.toFixed(1);
    elements.exposureControl.hidden = false;
  } else elements.exposureControl.hidden = true;

  const torchSupported = Boolean(state.capabilities.torch);
  elements.torchButton.hidden = !torchSupported;
  if (!torchSupported) {
    state.torchEnabled = false;
    elements.torchButton.setAttribute("aria-pressed", "false");
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    elements.cameraStatus.textContent = "非対応";
    showToast("このブラウザではカメラを利用できません");
    return;
  }
  if (!window.isSecureContext) {
    elements.cameraStatus.textContent = "HTTPSが必要";
    showToast("HTTPSで開いてください");
    return;
  }
  if (state.recorder?.state === "recording") return;
  stopCamera();
  elements.cameraStatus.textContent = "起動中…";
  elements.startButton.disabled = true;
  const preferredConstraints = { audio: microphoneEnabled() ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false, video: getVideoPreset() };
  try {
    try { state.stream = await navigator.mediaDevices.getUserMedia(preferredConstraints); }
    catch (preferredError) {
      console.warn("Preferred constraints failed; using fallback.", preferredError);
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneEnabled(), video: { facingMode: { ideal: state.facingMode } } });
    }
    elements.video.srcObject = state.stream;
    await elements.video.play();
    [state.videoTrack] = state.stream.getVideoTracks();
    const settings = state.videoTrack?.getSettings?.() ?? {};
    state.isFrontCamera = (settings.facingMode || state.facingMode) === "user";
    elements.video.classList.toggle("mirrored", state.isFrontCamera);
    const resolution = settings.width && settings.height ? `${settings.width}×${settings.height}` : state.isFrontCamera ? "前面カメラ" : "背面カメラ";
    const fps = settings.frameRate ? ` ${Math.round(settings.frameRate)}fps` : "";
    elements.cameraStatus.textContent = `${resolution}${fps}`;
    elements.permissionPanel.hidden = true;
    elements.shutterButton.disabled = false;
    elements.startButton.disabled = false;
    updateCapabilities();
    updateMediaStatus();
    await requestWakeLock();
  } catch (error) {
    console.error(error);
    elements.cameraStatus.textContent = "許可が必要";
    elements.startButton.disabled = false;
    elements.permissionPanel.hidden = false;
    if (error?.name === "NotAllowedError") showToast(microphoneEnabled() ? "カメラとマイクを許可してください" : "カメラを許可してください");
    else if (error?.name === "NotFoundError") showToast("利用できるカメラが見つかりません");
    else showToast("カメラを起動できませんでした");
  }
}

function setControlsDisabled(disabled) {
  const controls = [elements.photoModeButton, elements.videoModeButton, elements.microphoneStatusButton, elements.switchButton, elements.timerButton, elements.ratioButton, elements.photoFormatSelect, elements.photoQualitySelect, elements.autoReviewSelect, elements.selfieMirrorSelect, elements.microphoneSelect, elements.videoResolutionSelect, elements.videoFrameRateSelect, elements.videoQualitySelect, elements.recordingLimitSelect, elements.updateButton, elements.cameraSourceSelect, elements.manualFocusRange, elements.focusResetButton, elements.exposureIndexRange, elements.exposureResetButton].filter(Boolean);
  controls.forEach((control) => {
    const unsupportedManualFocus = [elements.manualFocusRange, elements.focusResetButton].includes(control) && !state.focusCapability;
    const unsupportedExposure = [elements.exposureIndexRange, elements.exposureResetButton].includes(control) && !state.exposureCapability;
    control.disabled = disabled
      || (control === elements.videoModeButton && !mediaRecorderSupported())
      || unsupportedManualFocus
      || unsupportedExposure;
  });
  if (!elements.zoomControl.hidden) elements.zoomRange.disabled = disabled;
  if (!elements.exposureControl.hidden) elements.exposureRange.disabled = disabled;
  if (!elements.torchButton.hidden) elements.torchButton.disabled = disabled;
}

async function switchCamera() {
  if (state.busy || state.recorder?.state === "recording") return;
  state.facingMode = state.facingMode === "environment" ? "user" : "environment";
  await startCamera();
}

function updateModeUi() {
  const photoMode = state.mode === "photo";
  elements.photoModeButton.classList.toggle("active", photoMode);
  elements.videoModeButton.classList.toggle("active", !photoMode);
  elements.photoModeButton.setAttribute("aria-pressed", String(photoMode));
  elements.videoModeButton.setAttribute("aria-pressed", String(!photoMode));
  [elements.photoFormatField, elements.photoQualityField, elements.autoReviewField, elements.selfieMirrorField].forEach((item) => { item.hidden = !photoMode; });
  [elements.microphoneField, elements.videoResolutionField, elements.videoFrameRateField, elements.videoQualityField, elements.recordingLimitField].forEach((item) => { item.hidden = photoMode; });
  elements.ratioButton.hidden = false;
  elements.shutterButton.classList.toggle("video", !photoMode);
  elements.shutterButton.setAttribute("aria-label", photoMode ? "写真を撮る" : "録画を開始する");
  elements.permissionCopy.textContent = photoMode ? "写真はサーバーへ送信しません。マイクと位置情報は使用しません。" : "動画はサーバーへ送信しません。マイクはONにした場合だけ使用します。";
  syncMicrophoneStatus();
  syncRatioButton();
  applyStageRatio();
  updateMediaStatus();
}

async function setMode(mode) {
  if (state.busy || state.recordingFinalizing || (state.recorder && state.recorder.state !== "inactive") || state.mode === mode) return;
  state.mode = mode;
  updateModeUi();
  persistCurrentSettings();
  if (state.stream) await startCamera();
}

function cycleTimer() {
  if (state.recorder?.state === "recording") return;
  const currentIndex = timerSequence.indexOf(state.timerSeconds);
  state.timerSeconds = timerSequence[(currentIndex + 1) % timerSequence.length];
  syncTimerButton();
  persistCurrentSettings();
  showToast(state.timerSeconds === 0 ? "タイマーを解除しました" : `${state.timerSeconds}秒タイマー`);
}

function applyStageRatio() {
  const ratio = state.mode === "video" ? state.videoRatio : state.ratio;
  elements.cameraStage.classList.remove("ratio-4-3", "ratio-1-1", "ratio-16-9");
  elements.cameraStage.classList.add(`ratio-${ratio.replace(":", "-")}`);
}

async function cycleRatio() {
  if (state.busy || state.recordingFinalizing || (state.recorder && state.recorder.state !== "inactive")) return;
  const stateKey = state.mode === "video" ? "videoRatio" : "ratio";
  const currentIndex = ratioSequence.indexOf(state[stateKey]);
  state[stateKey] = ratioSequence[(currentIndex + 1) % ratioSequence.length];
  syncRatioButton();
  applyStageRatio();
  persistCurrentSettings();
  if (state.mode === "video" && state.stream) await startCamera();
}

function toggleGrid() {
  const nextState = elements.gridOverlay.hidden;
  elements.gridOverlay.hidden = !nextState;
  elements.gridButton.setAttribute("aria-pressed", String(nextState));
  persistCurrentSettings();
}

async function toggleTorch() {
  if (!state.videoTrack || !state.capabilities.torch || state.recorder?.state === "recording") return;
  const nextState = !state.torchEnabled;
  try {
    await state.videoTrack.applyConstraints({ advanced: [{ torch: nextState }] });
    state.torchEnabled = nextState;
    elements.torchButton.setAttribute("aria-pressed", String(nextState));
  } catch (error) {
    console.error(error);
    showToast("この端末ではライトを変更できません");
  }
}

async function applyZoom(value) {
  if (!state.videoTrack || !state.capabilities.zoom) return;
  const zoom = Math.min(state.capabilities.zoom.max, Math.max(state.capabilities.zoom.min, Number(value)));
  try {
    await state.videoTrack.applyConstraints({ advanced: [{ zoom }] });
    state.currentZoom = zoom;
    elements.zoomRange.value = String(zoom);
    elements.zoomValue.value = `${zoom.toFixed(1)}×`;
  } catch (error) {
    console.error(error);
    showToast("ズームを変更できませんでした");
  }
}

async function applyExposure(value) {
  if (!state.videoTrack || !state.capabilities.exposureCompensation) return;
  const capability = state.capabilities.exposureCompensation;
  const exposure = Math.min(capability.max, Math.max(capability.min, Number(value)));
  try {
    await state.videoTrack.applyConstraints({ advanced: [{ exposureCompensation: exposure }] });
    state.currentExposure = exposure;
    elements.exposureRange.value = String(exposure);
    elements.exposureValue.value = exposure.toFixed(1);
  } catch (error) {
    console.error(error);
    showToast("明るさを変更できませんでした");
  }
}

function wait(milliseconds) { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }
async function runCountdown(seconds) {
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    elements.countdown.textContent = String(remaining);
    await wait(1000);
  }
  elements.countdown.textContent = "";
}
function getTargetRatio() { return ratioValue(state.ratio); }
function calculateCrop(sourceWidth, sourceHeight, targetRatio) {
  const sourceRatio = sourceWidth / sourceHeight;
  if (sourceRatio > targetRatio) {
    const width = Math.round(sourceHeight * targetRatio);
    return { sx: Math.round((sourceWidth - width) / 2), sy: 0, sw: width, sh: sourceHeight };
  }
  const height = Math.round(sourceWidth / targetRatio);
  return { sx: 0, sy: Math.round((sourceHeight - height) / 2), sw: sourceWidth, sh: height };
}
function canvasToBlob(canvas, type, quality) { return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("画像を生成できませんでした")), type, quality)); }
function flash() { elements.flashOverlay.classList.remove("active"); void elements.flashOverlay.offsetWidth; elements.flashOverlay.classList.add("active"); }
