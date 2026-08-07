"use strict";

(() => {
  const Q = {};
  window.QuietCameraEnhancements = Q;

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

  Q.syncLiveControlVisibility = () => {
    const shouldShow = Q.MOBILE_QUERY.matches
      && (!elements.manualFocusField.hidden || !elements.exposureSettingField.hidden);
    elements.liveCameraControls.hidden = !shouldShow;
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
