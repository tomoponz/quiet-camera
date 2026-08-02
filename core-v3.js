"use strict";

const APP_VERSION = "0.3.0";
const SETTINGS_KEY = "quiet-camera-settings-v3";
const DEFAULT_SETTINGS = {
  mode: "photo",
  timerSeconds: 0,
  ratio: "4:3",
  grid: false,
  photoFormat: "image/jpeg",
  photoQuality: "0.9",
  highResolution: "on",
  mirrorFront: "mirror",
  reviewBehavior: "always",
  videoResolution: "1080",
  videoFrameRate: "30",
  videoQuality: "standard",
  recordingLimit: "15",
  cameraDeviceId: "",
};

const elements = Object.fromEntries([
  "cameraVideo", "captureCanvas", "cameraStage", "permissionPanel", "permissionCopy", "startButton",
  "photoModeButton", "videoModeButton", "switchButton", "timerButton", "ratioButton", "torchButton",
  "gridButton", "gridOverlay", "focusRing", "zoomControl", "zoomRange", "zoomValue",
  "exposureControl", "exposureRange", "exposureValue", "shutterButton", "pauseButton", "cameraStatus",
  "focusStatus", "mediaStatus", "countdown", "flashOverlay", "recordingBadge", "recordingTime",
  "recordingSize", "recordingAudioState", "cameraField", "cameraSelect", "photoFormatField",
  "photoFormatSelect", "photoQualityField", "photoQualitySelect", "highResolutionField", "highResolutionSelect",
  "mirrorField", "mirrorSelect", "reviewBehaviorField", "reviewBehaviorSelect", "microphoneField",
  "microphoneSelect", "videoResolutionField", "videoResolutionSelect", "videoFrameRateField",
  "videoFrameRateSelect", "videoQualityField", "videoQualitySelect", "recordingLimitField",
  "recordingLimitSelect", "previewButton", "previewThumbnail", "previewPlaceholder", "videoThumbnailMark",
  "reviewDialog", "reviewTitle", "reviewMeta", "reviewImage", "reviewVideo", "closeReviewButton", "deleteButton",
  "downloadButton", "shareButton", "galleryButton", "galleryCount", "galleryDialog", "closeGalleryButton",
  "galleryStorageText", "galleryGrid", "galleryEmpty", "selectAllButton", "exportPdfButton",
  "deleteSelectedButton", "clearGalleryButton", "privacyButton", "privacyDialog", "closePrivacyButton",
  "installButton", "toast", "versionLabel",
].map((id) => [id, document.getElementById(id)]));

const state = {
  stream: null,
  videoTrack: null,
  audioTrack: null,
  imageCapture: null,
  capabilities: {},
  supportedConstraints: navigator.mediaDevices?.getSupportedConstraints?.() || {},
  facingMode: "environment",
  isFrontCamera: false,
  selectedDeviceId: "",
  devices: [],
  mode: "photo",
  timerSeconds: 0,
  ratio: "4:3",
  torchEnabled: false,
  currentZoom: 1,
  currentExposure: 0,
  busy: false,
  recorder: null,
  recordingId: null,
  recordingChunkIndex: 0,
  recordingBytes: 0,
  recordingWriteChain: Promise.resolve(),
  recordingStartedAt: 0,
  recordingElapsedMs: 0,
  recordingSegmentStartedAt: 0,
  recordingTimerId: null,
  recordingPaused: false,
  cancelRecording: false,
  deferredInstallPrompt: null,
  wakeLock: null,
  pinchPointers: new Map(),
  pinchStartDistance: 0,
  pinchStartZoom: 1,
  pinchGestureActive: false,
  gallery: [],
  activeMediaId: null,
  objectUrls: new Map(),
  selectedGalleryIds: new Set(),
  focusFallbackNoticeShown: false,
  settings: { ...DEFAULT_SETTINGS },
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    state.settings = { ...DEFAULT_SETTINGS, ...saved, microphone: "off" };
  } catch {
    state.settings = { ...DEFAULT_SETTINGS };
  }
  state.mode = state.settings.mode;
  state.timerSeconds = Number(state.settings.timerSeconds || 0);
  state.ratio = state.settings.ratio;
  state.selectedDeviceId = state.settings.cameraDeviceId || "";
}

function saveSettings() {
  state.settings = {
    ...state.settings,
    mode: state.mode,
    timerSeconds: state.timerSeconds,
    ratio: state.ratio,
    grid: !elements.gridOverlay.hidden,
    photoFormat: elements.photoFormatSelect.value,
    photoQuality: elements.photoQualitySelect.value,
    highResolution: elements.highResolutionSelect.value,
    mirrorFront: elements.mirrorSelect.value,
    reviewBehavior: elements.reviewBehaviorSelect.value,
    videoResolution: elements.videoResolutionSelect.value,
    videoFrameRate: elements.videoFrameRateSelect.value,
    videoQuality: elements.videoQualitySelect.value,
    recordingLimit: elements.recordingLimitSelect.value,
    cameraDeviceId: elements.cameraSelect.value,
  };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* Storage can be blocked in private/embedded contexts. */ }
}

function showToast(message, duration = 2800) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => elements.toast.classList.remove("visible"), duration);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runCountdown(seconds) {
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    elements.countdown.textContent = String(remaining);
    await wait(1000);
  }
  elements.countdown.textContent = "";
}

function flash() {
  elements.flashOverlay.classList.remove("active");
  void elements.flashOverlay.offsetWidth;
  elements.flashOverlay.classList.add("active");
}

function mediaRecorderSupported() {
  return typeof MediaRecorder !== "undefined";
}

function microphoneEnabled() {
  return state.mode === "video" && elements.microphoneSelect.value === "on";
}

function getTargetRatio() {
  if (state.ratio === "1:1") return 1;
  if (state.ratio === "16:9") return 16 / 9;
  return 4 / 3;
}

function getVideoConstraints() {
  const video = {};
  if (state.selectedDeviceId) video.deviceId = { exact: state.selectedDeviceId };
  else video.facingMode = { ideal: state.facingMode };

  const resolution = elements.videoResolutionSelect.value;
  if (state.mode === "photo") {
    video.width = { ideal: 3840 };
    video.height = { ideal: 2160 };
  } else if (resolution === "720") {
    video.width = { ideal: 1280 };
    video.height = { ideal: 720 };
  } else if (resolution === "1080") {
    video.width = { ideal: 1920 };
    video.height = { ideal: 1080 };
  } else {
    video.width = { ideal: 3840 };
    video.height = { ideal: 2160 };
  }
  const fps = elements.videoFrameRateSelect.value;
  if (state.mode === "video" && fps !== "auto") video.frameRate = { ideal: Number(fps) };
  return video;
}

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  state.videoTrack = null;
  state.audioTrack = null;
  state.imageCapture = null;
  state.capabilities = {};
  state.torchEnabled = false;
  elements.cameraVideo.srcObject = null;
  elements.shutterButton.disabled = true;
  elements.torchButton.hidden = true;
  elements.zoomControl.hidden = true;
  elements.exposureControl.hidden = true;
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch { state.wakeLock = null; }
}

async function enumerateCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
    state.devices = devices;
    const previous = elements.cameraSelect.value || state.selectedDeviceId;
    elements.cameraSelect.replaceChildren(new Option("自動", ""));
    devices.forEach((device, index) => {
      const label = device.label || `カメラ ${index + 1}`;
      elements.cameraSelect.add(new Option(label, device.deviceId));
    });
    if ([...elements.cameraSelect.options].some((option) => option.value === previous)) elements.cameraSelect.value = previous;
    state.selectedDeviceId = elements.cameraSelect.value;
    elements.cameraField.hidden = devices.length <= 1;
  } catch (error) {
    console.warn("Camera enumeration failed", error);
  }
}

function updateCapabilities() {
  state.capabilities = state.videoTrack?.getCapabilities?.() || {};
  const settings = state.videoTrack?.getSettings?.() || {};
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

  elements.torchButton.hidden = !state.capabilities.torch;
  if (!state.capabilities.torch) elements.torchButton.setAttribute("aria-pressed", "false");

  const focusModes = Array.isArray(state.capabilities.focusMode) ? state.capabilities.focusMode : [];
  elements.focusStatus.textContent = focusModes.length ? `AF ${focusModes.includes("continuous") ? "連続" : "対応"}` : "自動AF";
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
  if (state.recorder && state.recorder.state !== "inactive") return;

  stopCamera();
  elements.cameraStatus.textContent = "起動中…";
  elements.startButton.disabled = true;
  const preferred = {
    audio: microphoneEnabled() ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    video: getVideoConstraints(),
  };

  try {
    try {
      state.stream = await navigator.mediaDevices.getUserMedia(preferred);
    } catch (preferredError) {
      console.warn("Preferred constraints failed", preferredError);
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneEnabled(), video: true });
    }
    elements.cameraVideo.srcObject = state.stream;
    await elements.cameraVideo.play();
    [state.videoTrack] = state.stream.getVideoTracks();
    [state.audioTrack] = state.stream.getAudioTracks();
    const settings = state.videoTrack?.getSettings?.() || {};
    state.isFrontCamera = (settings.facingMode || state.facingMode) === "user";
    elements.cameraVideo.classList.toggle("mirrored", state.isFrontCamera);
    if (typeof ImageCapture !== "undefined" && state.videoTrack) {
      try { state.imageCapture = new ImageCapture(state.videoTrack); } catch { state.imageCapture = null; }
    }
    const resolution = settings.width && settings.height ? `${settings.width}×${settings.height}` : (state.isFrontCamera ? "前面" : "背面");
    const fps = settings.frameRate ? ` ${Math.round(settings.frameRate)}fps` : "";
    elements.cameraStatus.textContent = `${resolution}${fps}`;
    elements.permissionPanel.hidden = true;
    elements.shutterButton.disabled = false;
    elements.startButton.disabled = false;
    updateCapabilities();
    await enumerateCameras();
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

async function switchCamera() {
  if (state.busy || (state.recorder && state.recorder.state !== "inactive")) return;
  state.selectedDeviceId = "";
  elements.cameraSelect.value = "";
  state.facingMode = state.facingMode === "environment" ? "user" : "environment";
  saveSettings();
  await startCamera();
}

async function applyZoom(value) {
  if (!state.videoTrack || !state.capabilities.zoom) return;
  const zoom = QuietUtils.clamp(value, state.capabilities.zoom.min, state.capabilities.zoom.max);
  try {
    await state.videoTrack.applyConstraints({ advanced: [{ zoom }] });
    state.currentZoom = zoom;
    elements.zoomRange.value = String(zoom);
    elements.zoomValue.value = `${zoom.toFixed(1)}×`;
  } catch (error) { console.warn(error); }
}

async function applyExposure(value) {
  if (!state.videoTrack || !state.capabilities.exposureCompensation) return;
  const exposureCompensation = QuietUtils.clamp(value, state.capabilities.exposureCompensation.min, state.capabilities.exposureCompensation.max);
  try {
    await state.videoTrack.applyConstraints({ advanced: [{ exposureCompensation }] });
    state.currentExposure = exposureCompensation;
    elements.exposureRange.value = String(exposureCompensation);
    elements.exposureValue.value = exposureCompensation.toFixed(1);
  } catch (error) { console.warn(error); }
}

async function toggleTorch() {
  if (!state.videoTrack || !state.capabilities.torch) return;
  const next = !state.torchEnabled;
  try {
    await state.videoTrack.applyConstraints({ advanced: [{ torch: next }] });
    state.torchEnabled = next;
    elements.torchButton.setAttribute("aria-pressed", String(next));
  } catch { showToast("この端末ではライトを変更できません"); }
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

function focusModeCandidates() {
  const modes = Array.isArray(state.capabilities.focusMode) ? state.capabilities.focusMode : [];
  return ["single-shot", "continuous"].filter((mode) => modes.includes(mode));
}

async function tryFocusConstraint(advanced) {
  try {
    await state.videoTrack.applyConstraints({ advanced: [advanced] });
    return true;
  } catch {
    return false;
  }
}

async function focusAt(clientX, clientY) {
  if (!state.videoTrack || (state.recorder && state.recorder.state === "recording")) return;
  const rect = elements.cameraVideo.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;
  const mapped = QuietUtils.mapCoverPoint({
    clientX,
    clientY,
    rect,
    sourceWidth: elements.cameraVideo.videoWidth,
    sourceHeight: elements.cameraVideo.videoHeight,
    mirrored: state.isFrontCamera,
  });
  if (!mapped) return;

  const modes = focusModeCandidates();
  const mode = modes[0];
  const base = {};
  if (mode) base.focusMode = mode;
  const exposureModes = Array.isArray(state.capabilities.exposureMode) ? state.capabilities.exposureMode : [];
  if (exposureModes.includes("continuous")) base.exposureMode = "continuous";
  const whiteModes = Array.isArray(state.capabilities.whiteBalanceMode) ? state.capabilities.whiteBalanceMode : [];
  if (whiteModes.includes("continuous")) base.whiteBalanceMode = "continuous";

  const shouldTryPoint = state.supportedConstraints.pointsOfInterest || "pointsOfInterest" in state.capabilities;
  const attempts = [];
  if (shouldTryPoint || mode) {
    attempts.push({ ...base, pointsOfInterest: [mapped.pixel] });
    attempts.push({ ...base, pointsOfInterest: mapped.pixel });
    attempts.push({ ...base, pointsOfInterest: [mapped.normalized] });
    attempts.push({ ...base, pointsOfInterest: mapped.normalized });
  }
  if (Object.keys(base).length) attempts.push(base);

  for (const advanced of attempts) {
    if (await tryFocusConstraint(advanced)) {
      showFocusRing(clientX, clientY, "success");
      elements.focusStatus.textContent = "AF実行";
      setTimeout(() => updateCapabilities(), 900);
      return;
    }
  }

  const fallbackModes = ["continuous", "single-shot"].filter((candidate) => modes.includes(candidate));
  for (const focusMode of fallbackModes) {
    if (await tryFocusConstraint({ focusMode })) {
      showFocusRing(clientX, clientY, "fallback");
      elements.focusStatus.textContent = "自動AF再実行";
      return;
    }
  }

  showFocusRing(clientX, clientY, "fallback");
  elements.focusStatus.textContent = "端末の自動AF";
  if (!state.focusFallbackNoticeShown) {
    state.focusFallbackNoticeShown = true;
    showToast("位置指定AFはブラウザ非対応のため、端末の自動AFを使用します", 4200);
  }
}

function pointerDistance() {
  const points = [...state.pinchPointers.values()];
  return points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
}

function handlePointerDown(event) {
  if (event.target.closest("button,input,select")) return;
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
    applyZoom(state.pinchStartZoom * (pointerDistance() / state.pinchStartDistance));
  }
}

function handlePointerUp(event) {
  if (!state.pinchPointers.has(event.pointerId)) return;
  const pinching = state.pinchGestureActive;
  state.pinchPointers.delete(event.pointerId);
  if (!pinching && event.type === "pointerup") focusAt(event.clientX, event.clientY);
  if (state.pinchPointers.size < 2) state.pinchStartDistance = 0;
  if (state.pinchPointers.size === 0) state.pinchGestureActive = false;
}

function setControlsDisabled(disabled) {
  [elements.photoModeButton, elements.videoModeButton, elements.switchButton, elements.timerButton,
    elements.ratioButton, elements.cameraSelect, elements.photoFormatSelect, elements.photoQualitySelect,
    elements.highResolutionSelect, elements.mirrorSelect, elements.reviewBehaviorSelect,
    elements.microphoneSelect, elements.videoResolutionSelect, elements.videoFrameRateSelect,
    elements.videoQualitySelect, elements.recordingLimitSelect].forEach((control) => { control.disabled = disabled; });
}

function applyStageRatio() {
  const ratio = state.mode === "video" ? "16:9" : state.ratio;
  elements.cameraStage.classList.remove("ratio-4-3", "ratio-1-1", "ratio-16-9");
  elements.cameraStage.classList.add(`ratio-${ratio.replace(":", "-")}`);
}
