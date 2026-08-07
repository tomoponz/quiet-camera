"use strict";

(() => {
  const Q = {};
  window.QuietCameraEnhancements = Q;

  Q.APP_VERSION = "2026.08.07.2";
  Q.DEVICE_STORAGE_KEY = "quiet-camera-selected-device";
  Q.MOBILE_QUERY = window.matchMedia("(max-width: 700px)");
  Q.originalStartCamera = startCamera;
  Q.originalSwitchCamera = switchCamera;
  Q.originalUpdateCapabilities = updateCapabilities;

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

  const headerActions = document.querySelector(".header-actions");
  elements.versionBadge = document.createElement("span");
  elements.versionBadge.id = "versionBadge";
  elements.versionBadge.textContent = `v${Q.APP_VERSION}`;
  elements.versionBadge.setAttribute("aria-label", `アプリバージョン ${Q.APP_VERSION}`);
  Object.assign(elements.versionBadge.style, {
    alignSelf: "center",
    padding: "4px 7px",
    border: "1px solid rgba(255,255,255,.18)",
    borderRadius: "999px",
    color: "rgba(255,255,255,.82)",
    background: "rgba(255,255,255,.06)",
    fontSize: ".68rem",
    fontWeight: "800",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  });
  headerActions?.prepend(elements.versionBadge);

  const statusBar = elements.cameraStage.querySelector(".status-bar");
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
  statusBar?.insertBefore(elements.focusSupportBadge, elements.mediaStatus);

  const manualFocusAnchor = document.createComment("manual-focus-control");
  const exposureAnchor = document.createComment("exposure-control");
  elements.manualFocusField.before(manualFocusAnchor);
  elements.exposureSettingField.before(exposureAnchor);

  elements.liveCameraControls = document.createElement("div");
  elements.liveCameraControls.id = "liveCameraControls";
  elements.liveCameraControls.className = "live-camera-controls";
  elements.liveCameraControls.setAttribute("aria-label", "映像を見ながら調整するカメラ操作");
  elements.liveCameraControls.hidden = true;
  elements.cameraStage.append(elements.liveCameraControls);

  try { state.selectedDeviceId = localStorage.getItem(Q.DEVICE_STORAGE_KEY) || ""; }
  catch { state.selectedDeviceId = ""; }
  state.availableCameras = [];
  state.currentDeviceId = "";
  state.focusCapability = null;
  state.exposureCapability = null;
  state.deviceRefreshTimer = null;
  state.focusRestoreTimer = null;

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

  Q.updateFocusSupportBadge = () => {
    if (!elements.focusSupportBadge) return;
    if (!state.videoTrack) {
      elements.focusSupportBadge.textContent = "AF: 待機中";
      return;
    }

    const modes = Array.isArray(state.capabilities.focusMode) ? state.capabilities.focusMode : [];
    const manualAvailable = !elements.manualFocusField.hidden;
    if (modes.includes("continuous") && manualAvailable) elements.focusSupportBadge.textContent = "AF: 連続＋手動";
    else if (manualAvailable) elements.focusSupportBadge.textContent = "AF: 手動対応";
    else if (modes.includes("continuous")) elements.focusSupportBadge.textContent = "AF: 連続";
    else if (modes.includes("single-shot")) elements.focusSupportBadge.textContent = "AF: 中央単発";
    else elements.focusSupportBadge.textContent = "AF: 端末任せ";
  };

  Q.syncLiveControlVisibility = () => {
    const shouldShow = Q.MOBILE_QUERY.matches
      && (!elements.manualFocusField.hidden || !elements.exposureSettingField.hidden);
    elements.liveCameraControls.hidden = !shouldShow;
    Q.updateFocusSupportBadge();
  };

  Q.placeLiveCameraControls = () => {
    if (Q.MOBILE_QUERY.matches) {
      if (elements.manualFocusField.parentElement !== elements.liveCameraControls) {
        elements.liveCameraControls.append(elements.manualFocusField, elements.exposureSettingField);
      }
    } else {
      manualFocusAnchor.after(elements.manualFocusField);
      exposureAnchor.after(elements.exposureSettingField);
    }
    Q.syncLiveControlVisibility();
  };
})();
