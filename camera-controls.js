"use strict";

(() => {
  const Q = window.QuietCameraEnhancements;
  const CONTROL_DEBOUNCE_MS = 90;

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

  function clearFocusTimers() {
    window.clearTimeout(state.focusRestoreTimer);
    state.focusRestoreTimer = null;
    for (const timerId of state.focusRetryTimers) window.clearTimeout(timerId);
    state.focusRetryTimers.length = 0;
  }

  async function tryConstraintPatch(patch) {
    if (!state.videoTrack) return { accepted: false, error: new Error("Camera track is unavailable") };
    const attempts = [patch, { advanced: [patch] }];
    let finalError = null;
    for (const constraints of attempts) {
      try {
        await state.videoTrack.applyConstraints(constraints);
        return { accepted: true, constraints };
      } catch (error) {
        finalError = error;
      }
    }
    return { accepted: false, error: finalError || new Error("Constraint was rejected") };
  }

  async function readAppliedSetting(key, expected, tolerance = 0.001) {
    const delays = [0, 80, 180, 360];
    let lastValue;
    for (const delay of delays) {
      if (delay) await wait(delay);
      const value = Q.currentVideoSettings()[key];
      if (value !== undefined) lastValue = value;
      if (typeof expected === "boolean" && value === expected) return { verified: true, value };
      if (typeof expected === "string" && value === expected) return { verified: true, value };
      if (typeof expected === "number" && Number.isFinite(Number(value))
        && Math.abs(Number(value) - expected) <= tolerance) {
        return { verified: true, value: Number(value) };
      }
    }
    return { verified: false, value: lastValue };
  }

  async function applyNumericConstraint(key, value, { tolerance = 0.001, extra = {} } = {}) {
    const result = await tryConstraintPatch({ ...extra, [key]: value });
    if (!result.accepted) return result;
    const applied = await readAppliedSetting(key, value, tolerance);
    return { ...result, ...applied };
  }

  async function applyFocusPatch(patch) {
    const result = await tryConstraintPatch(patch);
    if (!result.accepted) {
      console.warn("Focus constraint was rejected.", patch, result.error);
      return false;
    }
    await wait(140);
    return true;
  }

  Q.applyContinuousFocus = async ({ silent = true, pulse = false, preserveTimers = false } = {}) => {
    if (!state.videoTrack || !getFocusModes().includes("continuous")) return false;
    if (!preserveTimers) clearFocusTimers();

    if (pulse && getFocusModes().includes("manual") && state.capabilities.focusDistance) {
      const currentDistance = Number(Q.currentVideoSettings().focusDistance);
      if (Number.isFinite(currentDistance)) {
        await applyFocusPatch({ focusMode: "manual", focusDistance: currentDistance });
        await wait(80);
      }
    }

    const accepted = await applyFocusPatch({ focusMode: "continuous" });
    if (!accepted) {
      if (!silent) showToast("オートフォーカスを開始できませんでした");
      return false;
    }

    const appliedMode = Q.currentVideoSettings().focusMode;
    if (appliedMode !== undefined && appliedMode !== "continuous") {
      console.info("Continuous focus request was accepted but not reported by getSettings().", { appliedMode });
    }
    Q.enhancedUpdateCapabilities();
    return true;
  };

  Q.initializeAutofocus = async () => {
    clearFocusTimers();
    const modes = getFocusModes();

    if (modes.includes("continuous")) {
      const accepted = await Q.applyContinuousFocus({ silent: true, preserveTimers: true });
      for (const delay of [350, 1300]) {
        const timerId = window.setTimeout(() => {
          Q.applyContinuousFocus({ silent: true, preserveTimers: true })
            .catch((error) => console.warn("Autofocus retry failed.", error));
        }, delay);
        state.focusRetryTimers.push(timerId);
      }
      return accepted;
    }

    if (modes.includes("single-shot")) return applyFocusPatch({ focusMode: "single-shot" });
    return false;
  };

  function restoreContinuousFocusSoon(delay = 900) {
    clearFocusTimers();
    if (!getFocusModes().includes("continuous")) return;
    state.focusRestoreTimer = window.setTimeout(() => {
      Q.applyContinuousFocus({ silent: true })
        .catch((error) => console.warn("Continuous focus restore failed.", error));
    }, delay);
  }

  Q.enhancedApplyZoom = async (rawValue) => {
    const capability = state.capabilities.zoom;
    if (!state.videoTrack || !capability) return;
    const value = Q.roundToCapabilityStep(rawValue, capability, 0.1);
    const tolerance = Q.normalizeStep(capability.step, 0.1) / 2 + 1e-4;
    const result = await applyNumericConstraint("zoom", value, { tolerance });
    if (!result.accepted) {
      console.error(result.error);
      showToast("ズームを適用できませんでした");
      return;
    }

    state.currentZoom = result.verified ? Number(result.value) : value;
    elements.zoomRange.value = String(state.currentZoom);
    elements.zoomValue.value = `${state.currentZoom.toFixed(1)}×`;
    if (!result.verified) {
      console.info("Zoom changed, but getSettings() did not confirm the new value.", { requested: value, reported: result.value });
    }
  };

  Q.applyExposureIndex = async (rawIndex) => {
    window.clearTimeout(state.exposureApplyTimer);
    state.exposureApplyTimer = null;
    const capability = state.exposureCapability;
    if (!state.videoTrack || !capability) return;
    const index = Q.clamp(Math.round(Number(rawIndex)), capability.minIndex, capability.maxIndex);
    const value = Number((index * capability.step).toFixed(6));
    const result = await applyNumericConstraint("exposureCompensation", value, {
      tolerance: capability.step / 2 + 1e-4,
    });
    if (!result.accepted) {
      console.error(result.error);
      showToast("明るさを適用できませんでした");
      return;
    }

    state.currentExposure = result.verified ? Number(result.value) : value;
    elements.exposureIndexRange.value = String(Math.round(state.currentExposure / capability.step));
    elements.exposureIndexValue.value = Q.formatEv(state.currentExposure);
    if (!result.verified) {
      console.info("Exposure changed, but getSettings() did not confirm the new value.", { requested: value, reported: result.value });
    }
  };

  Q.scheduleExposureIndex = (rawIndex) => {
    const capability = state.exposureCapability;
    if (!capability) return;
    const index = Q.clamp(Math.round(Number(rawIndex)), capability.minIndex, capability.maxIndex);
    const value = Number((index * capability.step).toFixed(6));
    elements.exposureIndexValue.value = Q.formatEv(value);
    window.clearTimeout(state.exposureApplyTimer);
    state.exposureApplyTimer = window.setTimeout(() => Q.applyExposureIndex(index), CONTROL_DEBOUNCE_MS);
  };

  Q.applyManualFocus = async (rawIndex) => {
    window.clearTimeout(state.manualFocusApplyTimer);
    state.manualFocusApplyTimer = null;
    const capability = state.focusCapability;
    if (!state.videoTrack || !capability) return;
    clearFocusTimers();
    const index = Q.clamp(Math.round(Number(rawIndex)), 0, capability.count);
    const value = Q.roundToCapabilityStep(Number(capability.min) + index * capability.step, capability, 0.01);
    const result = await applyNumericConstraint("focusDistance", value, {
      tolerance: capability.step / 2 + 1e-4,
      extra: { focusMode: "manual" },
    });
    if (!result.accepted) {
      console.error(result.error);
      showToast("手動ピントを適用できませんでした");
      return;
    }

    const actual = result.verified ? Number(result.value) : value;
    elements.manualFocusRange.value = String(Math.round((actual - Number(capability.min)) / capability.step));
    elements.manualFocusValue.value = focusValueLabel(actual, capability);
    Q.updateFocusSupportBadge();
    if (!result.verified) {
      console.info("Manual focus changed, but getSettings() did not confirm the new value.", { requested: value, reported: result.value });
    }
  };

  Q.scheduleManualFocus = (rawIndex) => {
    const capability = state.focusCapability;
    if (!capability) return;
    const index = Q.clamp(Math.round(Number(rawIndex)), 0, capability.count);
    const value = Q.roundToCapabilityStep(Number(capability.min) + index * capability.step, capability, 0.01);
    elements.manualFocusValue.value = focusValueLabel(value, capability);
    window.clearTimeout(state.manualFocusApplyTimer);
    state.manualFocusApplyTimer = window.setTimeout(() => Q.applyManualFocus(index), CONTROL_DEBOUNCE_MS);
  };

  Q.resetFocus = async () => {
    if (!state.stream) return;
    window.clearTimeout(state.manualFocusApplyTimer);
    state.manualFocusApplyTimer = null;
    elements.focusResetButton.disabled = true;
    try {
      const restored = await Q.applyContinuousFocus({ silent: true, pulse: true });
      if (!restored) {
        const singleShot = getFocusModes().includes("single-shot")
          && await applyFocusPatch({ focusMode: "single-shot" });
        if (!singleShot) await Q.enhancedStartCamera();
      }
      Q.enhancedUpdateCapabilities();
      showToast("オートフォーカスを再調整しました");
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

    clearFocusTimers();
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
        if (await applyFocusPatch(attempt)) {
          showFocusRing(clientX, clientY, "success");
          if (attempt.focusMode === "single-shot") restoreContinuousFocusSoon();
          Q.enhancedUpdateCapabilities();
          return;
        }
      }
    }

    if (focusModes.includes("single-shot")) {
      if (await applyFocusPatch({ focusMode: "single-shot" })) {
        showCenterFallbackNotice("位置指定AFは非対応のため、画面中央で再調整しました");
        restoreContinuousFocusSoon();
        Q.enhancedUpdateCapabilities();
        return;
      }
    }

    if (focusModes.includes("continuous")) {
      if (await Q.applyContinuousFocus({ silent: true, pulse: true })) {
        showCenterFallbackNotice("位置指定AFは非対応のため、中央のAFを再起動しました");
        return;
      }
    }

    if (state.focusCapability) {
      if (!Q.enhancedFocusAt.manualNoticeShown) {
        showToast("位置指定AFは非対応です。設定を開いてピントを調整できます");
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
