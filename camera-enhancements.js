"use strict";

(() => {
  const Q = window.QuietCameraEnhancements;

  function closeSettings() {
    if (elements.settingsDialog.open) elements.settingsDialog.close();
    elements.settingsButton.setAttribute("aria-expanded", "false");
  }

  function placeSettingsPanel() {
    if (Q.MOBILE_QUERY.matches) {
      if (elements.settingsPanel.parentElement !== elements.settingsSheetBody) elements.settingsSheetBody.append(elements.settingsPanel);
    } else {
      if (elements.settingsPanel.parentElement !== elements.settingsDock) elements.settingsDock.append(elements.settingsPanel);
      closeSettings();
    }
    Q.placeLiveCameraControls();
  }

  function openSettings() {
    placeSettingsPanel();
    if (Q.MOBILE_QUERY.matches) {
      if (elements.settingsDialog.open) {
        closeSettings();
        return;
      }
      elements.settingsDialog.show();
      elements.settingsButton.setAttribute("aria-expanded", "true");
      elements.closeSettingsButton.focus({ preventScroll: true });
    } else {
      elements.settingsPanel.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  elements.settingsButton.setAttribute("aria-controls", "settingsDialog");
  elements.settingsButton.setAttribute("aria-expanded", "false");

  elements.startButton.removeEventListener("click", Q.originalStartCamera);
  elements.switchButton.removeEventListener("click", Q.originalSwitchCamera);
  startCamera = Q.enhancedStartCamera;
  switchCamera = Q.enhancedSwitchCamera;
  updateCapabilities = Q.enhancedUpdateCapabilities;
  applyZoom = Q.enhancedApplyZoom;
  focusAt = Q.enhancedFocusAt;
  capturePhoto = Q.enhancedCapturePhoto;
  applyExposure = () => {};

  elements.startButton.addEventListener("click", Q.enhancedStartCamera);
  elements.switchButton.addEventListener("click", Q.enhancedSwitchCamera);
  elements.cameraSourceSelect.addEventListener("change", async () => {
    Q.storeSelectedDevice(elements.cameraSourceSelect.value);
    await Q.enhancedStartCamera();
  });
  elements.manualFocusRange.addEventListener("input", (event) => Q.applyManualFocus(event.target.value));
  elements.focusResetButton.addEventListener("click", Q.resetFocus);
  elements.exposureIndexRange.addEventListener("input", (event) => Q.applyExposureIndex(event.target.value));
  elements.exposureResetButton.addEventListener("click", () => Q.applyExposureIndex(0));
  elements.settingsButton.addEventListener("click", openSettings);
  elements.closeSettingsButton.addEventListener("click", closeSettings);
  elements.settingsDialog.addEventListener("close", () => {
    elements.settingsButton.setAttribute("aria-expanded", "false");
  });
  elements.privacyButton.addEventListener("click", closeSettings, { capture: true });
  Q.MOBILE_QUERY.addEventListener?.("change", placeSettingsPanel);
  window.addEventListener("resize", placeSettingsPanel, { passive: true });

  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    window.clearTimeout(state.deviceRefreshTimer);
    state.deviceRefreshTimer = window.setTimeout(async () => {
      try {
        await Q.refreshCameraList();
        if (state.videoTrack?.readyState === "ended") await Q.enhancedStartCamera();
      } catch (error) {
        console.warn("Camera list refresh failed.", error);
      }
    }, 250);
  });

  placeSettingsPanel();
})();
