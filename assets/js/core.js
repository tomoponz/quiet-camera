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
  microphoneStatusCurrent: document.querySelector(".microphone-status-current"),
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
  cameraPermissionDialog: document.querySelector("#cameraPermissionDialog"),
  cameraPermissionTitle: document.querySelector("#cameraPermissionTitle"),
  cameraPermissionMessage: document.querySelector("#cameraPermissionMessage"),
  cameraPermissionInstructions: document.querySelector("#cameraPermissionInstructions"),
  cameraPermissionHelpButton: document.querySelector("#cameraPermissionHelpButton"),
  retryCameraPermissionButton: document.querySelector("#retryCameraPermissionButton"),
  closeCameraPermissionButton: document.querySelector("#closeCameraPermissionButton"),
  closeCameraPermissionIconButton: document.querySelector("#closeCameraPermissionIconButton"),
  installButton: document.querySelector("#installButton"),
  updateButton: document.querySelector("#updateButton"),
  toast: document.querySelector("#toast"),
};

const DEFAULT_SETTINGS = {
  mode: "photo",
  timer: 0,
  ratio: "16:9",
  videoRatio: "16:9",
  grid: false,
  photoFormat: "image/jpeg",
  photoQuality: "0.92",
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
  // Older versions always saved microphone: "off", even without a user choice.
  microphonePreference: savedSettings.microphonePreference === "off" ? "off" : "auto",
  microphoneDecision: "unresolved",
  microphoneChoiceRevision: 0,
  timerSeconds: Number(savedSettings.timer) || 0,
  ratio: ["4:3", "1:1", "16:9"].includes(savedSettings.ratio) ? savedSettings.ratio : "16:9",
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
  cameraStartPending: false,
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
  recordingFinalizeLimitBytes: null,
  recordingStopBytes: null,
  recordingLargestChunkBytes: 0,
  recordingStopObservedBytes: 0,
  recordingStopRequested: false,
  recordingLockRelease: null,
  recordingKeyFrameIntervalRequestedMs: 0,
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

function prepareVideoMicrophone(mode = state.mode) {
  if (mode !== "video" || state.microphoneDecision !== "unresolved") return;
  state.microphoneDecision = state.microphonePreference === "off" ? "off" : "on";
  elements.microphoneSelect.value = state.microphoneDecision;
}

function rememberMicrophoneChoice() {
  state.microphoneChoiceRevision += 1;
  const enabled = elements.microphoneSelect.value === "on";
  state.microphonePreference = enabled ? "auto" : "off";
  state.microphoneDecision = enabled ? "on" : "off";
  syncMicrophoneStatus();
}

function syncMicrophoneStatus() {
  const videoMode = state.mode === "video";
  const enabled = elements.microphoneSelect.value === "on";
  elements.microphoneStatusButton.hidden = !videoMode;
  elements.microphoneStatusButton.classList.toggle("microphone-on", enabled);
  elements.microphoneStatusButton.classList.toggle("microphone-off", !enabled);
  elements.microphoneStatusText.textContent = enabled ? "ON" : "OFF";
  elements.microphoneStatusCurrent.textContent = enabled ? (state.cameraStartPending ? "準備中" : "現在") : "音声なし";
  const detail = enabled
    ? "現在、マイクはONです。音声を録音します。押すとマイク設定を開きます。"
    : state.microphoneDecision === "denied"
      ? "マイクを利用できなかったため、音声なしで録画します。再試行するにはマイク設定でONを選んでください。"
      : "現在、マイクはOFFです。音声は録音されません。押すとマイク設定を開きます。";
  elements.microphoneStatusDetail.textContent = detail;
  elements.microphoneStatusButton.setAttribute("aria-label", detail);
}

function setCameraPermissionHelpExpanded(expanded) {
  elements.cameraPermissionInstructions.hidden = !expanded;
  elements.cameraPermissionHelpButton.setAttribute("aria-expanded", String(expanded));
  elements.cameraPermissionHelpButton.textContent = expanded ? "設定方法を閉じる" : "設定方法を見る";
}

function showCameraPermissionDialog() {
  const needsMicrophone = microphoneEnabled();
  const devices = needsMicrophone ? "カメラとマイク" : "カメラ";
  elements.cameraPermissionTitle.textContent = `${devices}を利用できません`;
  elements.cameraPermissionMessage.textContent = `端末またはブラウザの設定で、このサイトの${devices}使用を許可してください。設定を変更したら、「もう一度試す」を押してください。`;
  setCameraPermissionHelpExpanded(false);
  if (!elements.cameraPermissionDialog.open) elements.cameraPermissionDialog.showModal();
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
    selfieMirror: elements.selfieMirrorSelect.value,
    microphone: "off",
    ...(state.microphonePreference === "off" ? { microphonePreference: "off" } : {}),
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

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  state.videoTrack = null;
  state.capabilities = {};
  state.torchEnabled = false;
  elements.video.srcObject = null;
  elements.shutterButton.disabled = true;
  elements.torchButton.hidden = false;
  elements.torchButton.disabled = true;
  elements.torchButton.title = "ライト: カメラ接続後に対応を確認します";
  elements.zoomControl.hidden = true;
  elements.exposureControl.hidden = true;
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try { state.wakeLock = await navigator.wakeLock.request("screen"); }
  catch { state.wakeLock = null; }
}

// This base UI update is shared by the active camera controller.
function updateBasicCameraCapabilities() {
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
  elements.torchButton.hidden = false;
  elements.torchButton.disabled = !torchSupported || state.busy || Boolean(state.cameraTransitioning) || Boolean(state.recorder && state.recorder.state !== "inactive") || Boolean(state.recordingFinalizing);
  elements.torchButton.title = torchSupported ? "ライト" : "ライト: このカメラ／ブラウザでは利用できません";
  if (!torchSupported) {
    state.torchEnabled = false;
    elements.torchButton.setAttribute("aria-pressed", "false");
  }
}

// Stable entry points call the active controller from their first use.
// Event handlers keep these functions; no implementation is replaced later.
function updateCapabilities() {
  return window.QuietCameraEnhancements.enhancedUpdateCapabilities();
}

function startCamera() {
  return window.QuietCameraEnhancements.enhancedStartCamera();
}

function setControlsDisabled(disabled) {
  const controls = [elements.photoModeButton, elements.videoModeButton, elements.microphoneStatusButton, elements.switchButton, elements.timerButton, elements.ratioButton, elements.photoFormatSelect, elements.photoQualitySelect, elements.selfieMirrorSelect, elements.microphoneSelect, elements.videoResolutionSelect, elements.videoFrameRateSelect, elements.videoQualitySelect, elements.recordingLimitSelect, elements.updateButton, elements.cameraSourceSelect, elements.manualFocusRange, elements.focusResetButton, elements.exposureIndexRange, elements.exposureResetButton].filter(Boolean);
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
  if (!elements.torchButton.hidden) elements.torchButton.disabled = disabled || !state.capabilities.torch || Boolean(state.cameraTransitioning);
}

function switchCamera() {
  return window.QuietCameraEnhancements.enhancedSwitchCamera();
}

function updateModeUi() {
  const photoMode = state.mode === "photo";
  elements.photoModeButton.closest(".mode-switcher").dataset.mode = photoMode ? "photo" : "video";
  elements.cameraStage.dataset.captureMode = photoMode ? "photo" : "video";
  elements.photoModeButton.classList.toggle("active", photoMode);
  elements.videoModeButton.classList.toggle("active", !photoMode);
  elements.photoModeButton.setAttribute("aria-pressed", String(photoMode));
  elements.videoModeButton.setAttribute("aria-pressed", String(!photoMode));
  [elements.photoFormatField, elements.photoQualityField, elements.selfieMirrorField].forEach((item) => { item.hidden = !photoMode; });
  [elements.microphoneField, elements.videoResolutionField, elements.videoFrameRateField, elements.videoQualityField, elements.recordingLimitField].forEach((item) => { item.hidden = photoMode; });
  elements.ratioButton.hidden = false;
  elements.shutterButton.classList.toggle("video", !photoMode);
  elements.shutterButton.setAttribute("aria-label", photoMode ? "写真を撮る" : "録画を開始する");
  elements.permissionCopy.textContent = photoMode ? "写真を運営者へ自動送信しません。マイクと位置情報は使用しません。" : "動画を運営者へ自動送信しません。動画へ切り替えるとマイクの使用許可を求めます。手動でOFFにした設定は維持します。";
  syncMicrophoneStatus();
  syncRatioButton();
  applyStageRatio();
  updateMediaStatus();
}

async function setMode(mode) {
  if (state.busy || state.recordingFinalizing || (state.recorder && state.recorder.state !== "inactive") || state.mode === mode) return;
  prepareVideoMicrophone(mode);
  const active = Boolean(state.stream) || state.cameraStartPending || Boolean(state.cameraTransitioning);
  const reuse = !state.cameraStartPending && window.QuietCameraEnhancements?.canReuseStreamForMode?.(mode) === true;
  if (active && !reuse) window.QuietCameraEnhancements?.beginPreviewTransition();
  state.mode = mode;
  updateModeUi();
  persistCurrentSettings();
  if (!reuse && (active || mode === "video")) await startCamera();
}

function cycleTimer() {
  if (state.busy || state.recordingFinalizing || state.recorder?.state === "recording") return;
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
  if (state.mode === "video" && (state.stream || state.cameraStartPending || state.cameraTransitioning)) await startCamera();
}

function toggleGrid() {
  const nextState = elements.gridOverlay.hidden;
  elements.gridOverlay.hidden = !nextState;
  elements.gridButton.setAttribute("aria-pressed", String(nextState));
  persistCurrentSettings();
}

function toggleTorch() {
  return window.QuietCameraEnhancements.enhancedToggleTorch();
}

function applyZoom(value) {
  return window.QuietCameraEnhancements.enhancedApplyZoom(value);
}

// The hidden floating exposure control is inactive. Settings use applyExposureIndex.
function applyExposure() {}

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
