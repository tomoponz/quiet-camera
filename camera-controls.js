"use strict";

(() => {
  const Q = window.QuietCameraEnhancements;

  function getFocusModes() {
    return Array.isArray(state.capabilities.focusMode) ? state.capabilities.focusMode : [];
  }

  function configureExposureControl(settings) {
    const capability = state.capabilities.exposureCompensation;
    if (!capability || !Number.isFinite(capability.min) || !Number.isFinite(capability.max)) {
      state.exposureCapability = null;
      elements.exposureSettingField.hidden = true;
      return;
    }

    const step = Q.normalizeStep(capability.step, 0.1);
    const minIndex = Math.ceil(Number(capability.min) / step - 1e-6);
    const maxIndex = Math.floor(Number(capability.max) / step + 1e-6);
    const current = Number(settings.exposureCompensation ?? 0);
    const currentIndex = Q.clamp(Math.round(current / step), minIndex, maxIndex);
    state.exposureCapability = { ...capability, step, minIndex, maxIndex };
    state.currentExposure = currentIndex * step;
    elements.exposureIndexRange.min = String(minIndex);
    elements.exposureIndexRange.max = String(maxIndex);
    elements.exposureIndexRange.step = "1";
    elements.exposureIndexRange.value = String(currentIndex);
    elements.exposureIndexValue.value = Q.formatEv(state.currentExposure);
    elements.exposureSettingField.hidden = false;
  }

  function focusValueLabel(value, capability) {
    const min = Number(capability.min);
    const max = Number(capability.max);
    if (Math.abs(value - min) < 1e-6) return `${value.toFixed(2)}・遠景`;
    if (Math.abs(value - max) < 1e-6) return `${value.toFixed(2)}・近景`;
    return value.toFixed(2);
  }

  function configureFocusControl(settings) {
    const capability = state.capabilities.focusDistance;
    const focusModes = getFocusModes();
    if (!capability || !focusModes.includes("manual") || !Number.isFinite(capability.min) || !Number.isFinite(capability.max)) {
      state.focusCapability = null;
      elements.manualFocusField.hidden = true;
      return;
    }

    const step = Q.normalizeStep(capability.step, 0.01);
    const count = Math.max(1, Math.round((Number(capability.max) - Number(capability.min)) / step));
    const current = Q.clamp(Number(settings.focusDistance ?? capability.min), Number(capability.min), Number(capability.max));
    const currentIndex = Q.clamp(Math.round((current - Number(capability.min)) / step), 0, count);
    state.focusCapability = { ...capability, step, count };
    elements.manualFocusRange.min = "0";
    elements.manualFocusRange.max = String(count);
    elements.manualFocusRange.step = "1";
    elements.manualFocusRange.value = String(currentIndex);
    elements.manualFocusValue.value = settings.focusMode === "manual" ? focusValueLabel(current, state.focusCapability) : "自動";
    elements.manualFocusField.hidden = false;
  }

  Q.enhancedUpdateCapabilities = () => {
    Q.originalUpdateCapabilities();
    const settings = Q.currentVideoSettings();
    elements.exposureControl.hidden = true;
    configureExposureControl(settings);
    configureFocusControl(settings);
    Q.syncLiveControlVisibility();
  };

  function currentAdvancedState(patch = {}) {
    const settings = Q.currentVideoSettings();
    const advanced = {};
    for (const key of ["zoom", "exposureCompensation", "torch"]) {
      if (key in state.capabilities && settings[key] !== undefined) advanced[key] = settings[key];
    }
    const useManualFocus = patch.focusMode === "manual"
      || (!Object.prototype.hasOwnProperty.call(patch, "focusMode") && settings.focusMode === "manual");
    if (useManualFocus && "focusDistance" in state.capabilities && settings.focusDistance !== undefined) {
      advanced.focusDistance = settings.focusDistance;
    }
    return { ...advanced, ...patch };
  }

  async function applyAndVerify(key, value, { tolerance = 0.001, extra = {} } = {}) {
    if (!state.videoTrack) return false;
    await state.videoTrack.applyConstraints({ advanced: [currentAdvancedState({ ...extra, [key]: value })] });
    await wait(80);
    const applied = Q.currentVideoSettings()[key];
    if (typeof value === "boolean") return applied === value;
    return Number.isFinite(Number(applied)) && Math.abs(Number(applied) - Number(value)) <= tolerance;
  }

  function clearFocusRestoreTimer() {
    window.clearTimeout(state.focusRestoreTimer);
    state.focusRestoreTimer = null;
  }

  async function applyFocusRequest(patch) {
    if (!state.videoTrack) return false;
    const advanced = currentAdvancedState(patch);
    if (patch.focusMode !== "manual") delete advanced.focusDistance;
    try {
      await state.videoTrack.applyConstraints({ advanced: [advanced] });
      await wait(120);
      return true;
    } catch (error) {
      console.warn("Focus constraint was rejected.", patch, error);
      return false;
    }
  }

  Q.applyContinuousFocus = async ({ silent = true } = {}) => {
    if (!state.videoTrack || !getFocusModes().includes("continuous")) return false;
    clearFocusRestoreTimer();
    const accepted = await applyFocusRequest({ focusMode: "continuous" });
    if (!accepted) {
      if (!silent) showToast("連続オートフォーカスを開始できませんでした");
      return false;
    }

    const appliedMode = Q.currentVideoSettings().focusMode;
    const success = appliedMode === undefined || appliedMode === "continuous";
    if (!success && !silent) showToast("連続オートフォーカスが端末に反映されませんでした");
    if (success) Q.enhancedUpdateCapabilities();
    return success;
  };

  Q.initializeAutofocus = async () => {
    clearFocusRestoreTimer();
    if (!getFocusModes().includes("continuous")) return false;
    return Q.applyContinuousFocus({ silent: true });
  };

  function restoreContinuousFocusSoon(delay = 900) {
    clearFocusRestoreTimer();
    if (!getFocusModes().includes("continuous")) return;
    state.focusRestoreTimer = window.setTimeout(() => {
      Q.applyContinuousFocus({ silent: true }).catch((error) => console.warn("Continuous focus restore failed.", error));
    }, delay);
  }

  Q.enhancedApplyZoom = async (rawValue) => {
    const capability = state.capabilities.zoom;
    if (!state.videoTrack || !capability) return;
    const value = Q.roundToCapabilityStep(rawValue, capability, 0.1);
    try {
      const success = await applyAndVerify("zoom", value, { tolerance: Q.normalizeStep(capability.step, 0.1) / 2 + 1e-4 });
      if (!success) throw new Error("Zoom setting was ignored");
      state.currentZoom = Number(Q.currentVideoSettings().zoom ?? value);
      elements.zoomRange.value = String(state.currentZoom);
      elements.zoomValue.value = `${state.currentZoom.toFixed(1)}×`;
      Q.enhancedUpdateCapabilities();
    } catch (error) {
      console.error(error);
      showToast("このカメラではズームを変更できませんでした");
    }
  };

  Q.applyExposureIndex = async (rawIndex) => {
    const capability = state.exposureCapability;
    if (!state.videoTrack || !capability) return;
    const index = Q.clamp(Math.round(Number(rawIndex)), capability.minIndex, capability.maxIndex);
    const value = Number((index * capability.step).toFixed(6));
    try {
      const success = await applyAndVerify("exposureCompensation", value, { tolerance: capability.step / 2 + 1e-4 });
      if (!success) throw new Error("Exposure setting was ignored");
      state.currentExposure = Number(Q.currentVideoSettings().exposureCompensation ?? value);
      elements.exposureIndexRange.value = String(Math.round(state.currentExposure / capability.step));
      elements.exposureIndexValue.value = Q.formatEv(state.currentExposure);
    } catch (error) {
      console.error(error);
      showToast("このカメラでは明るさを変更できませんでした");
    }
  };

  Q.applyManualFocus = async (rawIndex) => {
    const capability = state.focusCapability;
    if (!state.videoTrack || !capability) return;
    clearFocusRestoreTimer();
    const index = Q.clamp(Math.round(Number(rawIndex)), 0, capability.count);
    const value = Q.roundToCapabilityStep(Number(capability.min) + index * capability.step, capability, 0.01);
    try {
      const success = await applyAndVerify("focusDistance", value, {
        tolerance: capability.step / 2 + 1e-4,
        extra: { focusMode: "manual" },
      });
      if (!success) throw new Error("Focus setting was ignored");
      const actual = Number(Q.currentVideoSettings().focusDistance ?? value);
      elements.manualFocusRange.value = String(Math.round((actual - Number(capability.min)) / capability.step));
      elements.manualFocusValue.value = focusValueLabel(actual, capability);
    } catch (error) {
      console.error(error);
      showToast("このカメラでは手動ピントを変更できませんでした");
    }
  };

  Q.resetFocus = async () => {
    if (!state.stream) return;
    elements.focusResetButton.disabled = true;
    try {
      const restored = await Q.applyContinuousFocus({ silent: true });
      if (!restored) await Q.enhancedStartCamera();
      else showToast("連続オートフォーカスへ戻しました");
    } finally {
      elements.focusResetButton.disabled = false;
    }
  };

  function showCenterFocusRing(mode = "success") {
    const rect = elements.video.getBoundingClientRect();
    showFocusRing(rect.left + rect.width / 2, rect.top + rect.height / 2, mode);
  }

  function showCenterFallbackNotice(message) {
    showCenterFocusRing("fallback");
    if (!Q.enhancedFocusAt.centerFallbackNoticeShown) {
      showToast(message);
      Q.enhancedFocusAt.centerFallbackNoticeShown = true;
    }
  }

  Q.enhancedFocusAt = async (clientX, clientY) => {
    if (!state.videoTrack || state.recorder?.state === "recording") return;
    const rect = elements.video.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;

    clearFocusRestoreTimer();
    showFocusRing(clientX, clientY, "fallback");

    const focusModes = getFocusModes();
    const hasPointFocus = Object.prototype.hasOwnProperty.call(state.capabilities, "pointsOfInterest");
    if (hasPointFocus) {
      const point = mapDisplayPointToSensor(clientX, clientY);
      const pointAttempts = [];
      if (focusModes.includes("single-shot")) pointAttempts.push({ focusMode: "single-shot", pointsOfInterest: [point] });
      if (focusModes.includes("continuous")) pointAttempts.push({ focusMode: "continuous", pointsOfInterest: [point] });
      pointAttempts.push({ pointsOfInterest: [point] });

      for (const attempt of pointAttempts) {
        if (await applyFocusRequest(attempt)) {
          showFocusRing(clientX, clientY, "success");
          if (attempt.focusMode === "single-shot") restoreContinuousFocusSoon();
          Q.enhancedUpdateCapabilities();
          return;
        }
      }
    }

    if (focusModes.includes("single-shot")) {
      if (await applyFocusRequest({ focusMode: "single-shot" })) {
        showCenterFallbackNotice("位置指定AFは非対応のため、画面中央でピントを合わせました");
        restoreContinuousFocusSoon();
        Q.enhancedUpdateCapabilities();
        return;
      }
    }

    if (focusModes.includes("continuous")) {
      if (await Q.applyContinuousFocus({ silent: true })) {
        showCenterFallbackNotice("位置指定AFは非対応のため、中央の連続AFを再開しました");
        return;
      }
    }

    if (state.focusCapability) {
      if (!Q.enhancedFocusAt.manualNoticeShown) {
        showToast("位置指定AFは非対応です。映像上のピントスライダーで調整できます");
        Q.enhancedFocusAt.manualNoticeShown = true;
      }
      return;
    }

    if (!Q.enhancedFocusAt.unsupportedNoticeShown) {
      showToast("このカメラのピントは端末側の自動調整を使用します");
      Q.enhancedFocusAt.unsupportedNoticeShown = true;
    }
  };
})();
