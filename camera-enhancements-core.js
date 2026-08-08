"use strict";

(() => {
  const Q = {};
  window.QuietCameraEnhancements = Q;

  Q.APP_VERSION = "2026.08.08.1";
  Q.DEVICE_STORAGE_KEY = "quiet-camera-selected-device";
  Q.MOBILE_QUERY = window.matchMedia("(max-width: 700px)");
  Q.originalStartCamera = startCamera;
  Q.originalSwitchCamera = switchCamera;
  Q.originalUpdateCapabilities = updateCapabilities;
  Q.originalToggleTorch = toggleTorch;
  Q.originalOpenGallery = openGallery;

  Object.assign(elements, {
    cameraSourceField: document.querySelector("#cameraSourceField"),
    cameraSourceSelect: document.querySelector("#cameraSourceSelect"),
    settingsDock: document.querySelector("#settingsDock"),
    settingsPanel: document.querySelector("#settingsPanel"),
    settingsButton: document.querySelector("#settingsButton"),
    settingsDialog: document.querySelector("#settingsDialog"),
    settingsSheetBody: document.querySelector("#settingsSheetBody"),
    closeSettingsButton: document.querySelector("#closeSettingsButton"),
    manualFocusField: document.querySelector("#manualFocusField"),
    manualFocusRange: document.querySelector("#manualFocusRange"),
    manualFocusValue: document.querySelector("#manualFocusValue"),
    focusResetButton: document.querySelector("#focusResetButton"),
    exposureSettingField: document.querySelector("#exposureSettingField"),
    exposureIndexRange: document.querySelector("#exposureIndexRange"),
    exposureIndexValue: document.querySelector("#exposureIndexValue"),
    exposureResetButton: document.querySelector("#exposureResetButton"),
  });

  elements.focusResetButton.textContent = "AF再調整";

  const statusBar = elements.cameraStage.querySelector(".status-bar");
  elements.versionBadge = document.createElement("span");
  elements.versionBadge.id = "versionBadge";
  elements.versionBadge.textContent = `v${Q.APP_VERSION}`;
  elements.versionBadge.setAttribute("aria-label", `アプリバージョン ${Q.APP_VERSION}`);
  Object.assign(elements.versionBadge.style, {
    padding: "2px 6px",
    border: "1px solid rgba(255,255,255,.16)",
    borderRadius: "999px",
    color: "rgba(255,255,255,.78)",
    background: "rgba(0,0,0,.38)",
    fontSize: ".62rem",
    fontWeight: "800",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  });

  elements.focusSupportBadge = document.createElement("span");
  elements.focusSupportBadge.id = "focusSupportBadge";
  elements.focusSupportBadge.textContent = "AF: 待機中";
  elements.focusSupportBadge.title = "ブラウザが公開しているピント機能";
  Object.assign(elements.focusSupportBadge.style, {
    padding: "2px 6px",
    borderRadius: "999px",
    background: "rgba(0,0,0,.42)",
    fontSize: ".66rem",
    fontWeight: "800",
    whiteSpace: "nowrap",
  });
  statusBar?.insertBefore(elements.versionBadge, elements.cameraStatus);
  statusBar?.insertBefore(elements.focusSupportBadge, elements.mediaStatus);

  const manualFocusAnchor = document.createComment("manual-focus-control");
  const exposureAnchor = document.createComment("exposure-control");
  elements.manualFocusField.before(manualFocusAnchor);
  elements.exposureSettingField.before(exposureAnchor);

  try { state.selectedDeviceId = localStorage.getItem(Q.DEVICE_STORAGE_KEY) || ""; }
  catch { state.selectedDeviceId = ""; }
  state.availableCameras = [];
  state.currentDeviceId = "";
  state.focusCapability = null;
  state.exposureCapability = null;
  state.deviceRefreshTimer = null;
  state.focusRestoreTimer = null;
  state.manualFocusApplyTimer = null;
  state.exposureApplyTimer = null;
  state.cameraControlTrack = null;
  state.cameraControlGeneration = 0;
  state.cameraControlQueue = Promise.resolve();
  state.cameraDesiredControls = {};
  state.cameraControlState = "IDLE";
  state.galleryPageSize = 60;
  state.galleryLoadedCount = 0;
  state.galleryTotalCount = 0;

  Q.clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  Q.normalizeStep = (rawStep, fallback) => {
    const numeric = Number(rawStep);
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return Number(numeric.toPrecision(6));
  };
  Q.roundToCapabilityStep = (value, capability, fallbackStep = 0.1) => {
    const min = Number(capability.min);
    const max = Number(capability.max);
    const step = Q.normalizeStep(capability.step, fallbackStep);
    const clamped = Q.clamp(Number(value), min, max);
    const rounded = min + Math.round((clamped - min) / step) * step;
    return Number(Q.clamp(rounded, min, max).toFixed(6));
  };
  Q.formatEv = (value) => {
    const normalized = Math.abs(Number(value)) < 1e-6 ? 0 : Number(value);
    return `${normalized > 0 ? "+" : ""}${normalized.toFixed(1)}EV`;
  };
  Q.cameraLabel = (device, index) => device.label?.trim() || `カメラ ${index + 1}`;
  Q.currentVideoSettings = () => state.videoTrack?.getSettings?.() ?? {};
  Q.removeStoredDevice = () => {
    state.selectedDeviceId = "";
    try { localStorage.removeItem(Q.DEVICE_STORAGE_KEY); } catch {}
  };
  Q.storeSelectedDevice = (deviceId) => {
    state.selectedDeviceId = deviceId || "";
    try {
      if (state.selectedDeviceId) localStorage.setItem(Q.DEVICE_STORAGE_KEY, state.selectedDeviceId);
      else localStorage.removeItem(Q.DEVICE_STORAGE_KEY);
    } catch {}
  };

  Q.updateFocusSupportBadge = (statusText = "") => {
    if (!elements.focusSupportBadge) return;
    if (!state.videoTrack) {
      elements.focusSupportBadge.textContent = "AF: 待機中";
      return;
    }
    if (statusText) {
      elements.focusSupportBadge.textContent = statusText;
      return;
    }

    const settings = Q.currentVideoSettings();
    const modes = Array.isArray(state.capabilities.focusMode) ? state.capabilities.focusMode : [];
    const manualAvailable = !elements.manualFocusField.hidden;
    if (settings.focusMode === "manual") elements.focusSupportBadge.textContent = "AF: 手動";
    else if (modes.includes("continuous") && manualAvailable) elements.focusSupportBadge.textContent = "AF: 連続＋手動";
    else if (manualAvailable) elements.focusSupportBadge.textContent = "AF: 手動対応";
    else if (modes.includes("continuous")) elements.focusSupportBadge.textContent = "AF: 連続";
    else if (modes.includes("single-shot")) elements.focusSupportBadge.textContent = "AF: 中央単発";
    else elements.focusSupportBadge.textContent = "AF: 端末任せ";
  };

  Q.syncLiveControlVisibility = () => Q.updateFocusSupportBadge();

  Q.placeLiveCameraControls = () => {
    if (elements.manualFocusField.parentElement !== elements.settingsPanel) manualFocusAnchor.after(elements.manualFocusField);
    if (elements.exposureSettingField.parentElement !== elements.settingsPanel) exposureAnchor.after(elements.exposureSettingField);
    Q.syncLiveControlVisibility();
  };
})();
