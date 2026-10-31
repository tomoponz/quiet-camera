"use strict";

// Connect enhancement modules once, after their definitions and before app startup.
(() => {
  const Q = window.QuietCameraEnhancements;

  elements.cameraSourceSelect.addEventListener("change", async () => {
    if (elements.cameraSourceSelect.disabled || state.busy || state.recordingFinalizing
      || (state.recorder && state.recorder.state !== "inactive")) return;
    Q.storeSelectedDevice(elements.cameraSourceSelect.value);
    await Q.enhancedStartCamera();
  });
  elements.manualFocusRange.addEventListener("input", (event) => Q.scheduleManualFocus(event.target.value));
  elements.manualFocusRange.addEventListener("change", (event) => Q.applyManualFocus(event.target.value));
  elements.focusResetButton.addEventListener("click", Q.resetFocus);
  elements.exposureIndexRange.addEventListener("input", (event) => Q.scheduleExposureIndex(event.target.value));
  elements.exposureIndexRange.addEventListener("change", (event) => Q.applyExposureIndex(event.target.value));
  elements.exposureResetButton.addEventListener("click", () => Q.applyExposureIndex(0));

  const settingsSheet = Q.initializeSettingsSheet();

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

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !state.videoTrack) return;
    Q.applyContinuousFocus({ silent: true })
      .catch((error) => console.warn("Autofocus resume failed.", error));
  });

  Q.initializeGalleryLoader();

  // Request protection from automatic storage eviction when the browser supports it.
  Promise.resolve()
    .then(() => requestPersistentStorage())
    .then((persistent) => console.info(`[Quiet Camera] persistent storage: ${persistent ? "granted" : "best-effort"}`))
    .catch((error) => console.warn("Persistent storage initialization failed.", error));

  settingsSheet.place();
  settingsSheet.initializeMotion();
})();
