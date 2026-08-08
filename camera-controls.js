"use strict";

const QuietCameraControlModel = (() => {
  const MANAGED_KEYS = ["focusMode", "focusDistance", "zoom", "exposureCompensation", "torch"];
  const TRANSIENT_KEYS = ["pointsOfInterest"];
  const CAMERA_KEYS = new Set([...MANAGED_KEYS, ...TRANSIENT_KEYS]);

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function clamp(value, min, max) {
    return Math.min(Number(max), Math.max(Number(min), Number(value)));
  }

  function mergeDesired(current, updates = {}) {
    const next = { ...(current || {}) };
    for (const [key, value] of Object.entries(updates)) {
      if (!MANAGED_KEYS.includes(key)) continue;
      if (value === null || value === undefined) delete next[key];
      else next[key] = value;
    }
    if (next.focusMode !== "manual") delete next.focusDistance;
    return next;
  }

  function buildManagedConstraintPatch(desired = {}, capabilities = {}, ephemeral = {}) {
    const patch = {};
    const focusModes = Array.isArray(capabilities.focusMode) ? capabilities.focusMode : [];

    if (desired.focusMode && focusModes.includes(desired.focusMode)) patch.focusMode = desired.focusMode;

    if (patch.focusMode === "manual" && capabilities.focusDistance
      && Number.isFinite(Number(capabilities.focusDistance.min))
      && Number.isFinite(Number(capabilities.focusDistance.max))
      && Number.isFinite(Number(desired.focusDistance))) {
      patch.focusDistance = clamp(desired.focusDistance, capabilities.focusDistance.min, capabilities.focusDistance.max);
    }

    for (const key of ["zoom", "exposureCompensation"]) {
      const capability = capabilities[key];
      if (!capability || !Number.isFinite(Number(capability.min)) || !Number.isFinite(Number(capability.max))) continue;
      if (!Number.isFinite(Number(desired[key]))) continue;
      patch[key] = clamp(desired[key], capability.min, capability.max);
    }

    if (capabilities.torch === true && typeof desired.torch === "boolean") patch.torch = desired.torch;

    if (hasOwn(capabilities, "pointsOfInterest") && Array.isArray(ephemeral.pointsOfInterest)
      && ephemeral.pointsOfInterest.length) {
      patch.pointsOfInterest = ephemeral.pointsOfInterest;
    }

    return patch;
  }

  function stripCameraKeys(constraints = {}) {
    const result = {};
    for (const [key, value] of Object.entries(constraints || {})) {
      if (key === "advanced" || CAMERA_KEYS.has(key)) continue;
      result[key] = value;
    }
    return result;
  }

  function buildConstraintAttempts(existingConstraints = {}, managedPatch = {}) {
    const basicBase = stripCameraKeys(existingConstraints);
    const basic = { ...basicBase, ...managedPatch };
    const preservedAdvanced = Array.isArray(existingConstraints.advanced)
      ? existingConstraints.advanced
        .map((entry) => stripCameraKeys(entry))
        .filter((entry) => Object.keys(entry).length)
      : [];
    const advanced = {
      ...basicBase,
      advanced: [...preservedAdvanced, managedPatch],
    };
    return [basic, advanced];
  }

  return {
    MANAGED_KEYS,
    hasOwn,
    mergeDesired,
    buildManagedConstraintPatch,
    stripCameraKeys,
    buildConstraintAttempts,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = QuietCameraControlModel;

if (typeof window !== "undefined") (() => {
  const Q = window.QuietCameraEnhancements;
  const Model = QuietCameraControlModel;
  const CONTROL_DEBOUNCE_MS = 110;

  function getFocusModes() {
    return Array.isArray(state.capabilities.focusMode) ? state.capabilities.focusMode : [];
  }

  function configureExposureControl(settings) {
    const capability = state.capabilities.exposureCompensation;
    if (!capability || !Number.isFinite(Number(capability.min)) || !Number.isFinite(Number(capability.max))
      || Number(capability.max) <= Number(capability.min)) {
      state.exposureCapability = null;
      elements.exposureSettingField.hidden = true;
      return;
    }

    const step = Q.normalizeStep(capability.step, 0.1);
    const minIndex = Math.ceil(Number(capability.min) / step - 1e-6);
    const maxIndex = Math.floor(Number(capability.max) / step + 1e-6);
    const current = Number(settings.exposureCompensation ?? state.cameraDesiredControls.exposureCompensation ?? 0);
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
    if (!capability || !focusModes.includes("manual")
      || !Number.isFinite(Number(capability.min)) || !Number.isFinite(Number(capability.max))
      || Number(capability.max) <= Number(capability.min)) {
      state.focusCapability = null;
      elements.manualFocusField.hidden = true;
      return;
    }

    const step = Q.normalizeStep(capability.step, 0.01);
    const count = Math.max(1, Math.round((Number(capability.max) - Number(capability.min)) / step));
    const current = Q.clamp(
      Number(settings.focusDistance ?? state.cameraDesiredControls.focusDistance ?? capability.min),
      Number(capability.min),
      Number(capability.max),
    );
    const currentIndex = Q.clamp(Math.round((current - Number(capability.min)) / step), 0, count);
    state.focusCapability = { ...capability, step, count };
    elements.manualFocusRange.min = "0";
    elements.manualFocusRange.max = String(count);
    elements.manualFocusRange.step = "1";
    elements.manualFocusRange.value = String(currentIndex);
    elements.manualFocusValue.value = (settings.focusMode === "manual" || state.cameraDesiredControls.focusMode === "manual")
      ? focusValueLabel(current, state.focusCapability)
      : "自動";
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

  function clearFocusTimer() {
    window.clearTimeout(state.focusRestoreTimer);
    state.focusRestoreTimer = null;
  }

  function desiredFromCurrentSettings() {
    const settings = Q.currentVideoSettings();
    const desired = {};
    const modes = getFocusModes();
    if (settings.focusMode && modes.includes(settings.focusMode)) desired.focusMode = settings.focusMode;
    if (settings.focusMode === "manual" && Number.isFinite(Number(settings.focusDistance))) {
      desired.focusDistance = Number(settings.focusDistance);
    }
    if (state.capabilities.zoom && Number.isFinite(Number(settings.zoom))) desired.zoom = Number(settings.zoom);
    if (state.capabilities.exposureCompensation && Number.isFinite(Number(settings.exposureCompensation))) {
      desired.exposureCompensation = Number(settings.exposureCompensation);
    }
    if (state.capabilities.torch === true && typeof settings.torch === "boolean") desired.torch = settings.torch;
    else if (state.capabilities.torch === true) desired.torch = Boolean(state.torchEnabled);
    return desired;
  }

  Q.invalidateCameraController = () => {
    clearFocusTimer();
    state.cameraControlGeneration += 1;
    state.cameraControlTrack = null;
    state.cameraControlQueue = Promise.resolve();
    state.cameraDesiredControls = {};
    state.cameraControlState = "IDLE";
  };

  Q.initializeCameraController = () => {
    clearFocusTimer();
    state.cameraControlGeneration += 1;
    state.cameraControlTrack = state.videoTrack || null;
    state.cameraControlQueue = Promise.resolve();
    state.cameraDesiredControls = desiredFromCurrentSettings();
    state.cameraControlState = state.videoTrack ? "READY" : "IDLE";
  };

  function enqueueControlOperation(operation) {
    const generation = state.cameraControlGeneration;
    const track = state.videoTrack;
    state.cameraControlQueue = state.cameraControlQueue
      .catch(() => undefined)
      .then(async () => {
        if (!track || track !== state.videoTrack || generation !== state.cameraControlGeneration || track.readyState === "ended") {
          return { accepted: false, stale: true };
        }
        return operation(track, generation);
      });
    return state.cameraControlQueue;
  }

  async function applyConstraintSet(track, patch) {
    if (!Object.keys(patch).length) return { accepted: false, error: new Error("No supported camera constraints") };
    const existingConstraints = track.getConstraints?.() ?? {};
    const attempts = Model.buildConstraintAttempts(existingConstraints, patch);
    let finalError = null;
    for (const constraints of attempts) {
      try {
        await track.applyConstraints(constraints);
        return { accepted: true, constraints };
      } catch (error) {
        finalError = error;
      }
    }
    return { accepted: false, error: finalError || new Error("Constraint was rejected") };
  }

  async function readAppliedSetting(track, key, expected, tolerance = 0.001) {
    const delays = [0, 90, 220, 420];
    let lastValue;
    for (const delay of delays) {
      if (delay) await wait(delay);
      if (track !== state.videoTrack || track.readyState === "ended") return { verified: false, stale: true, value: lastValue };
      const value = track.getSettings?.()?.[key];
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

  Q.applyManagedCameraControls = (updates = {}, {
    ephemeral = {}, verifyKey = null, expectedValue = undefined, tolerance = 0.001,
  } = {}) => enqueueControlOperation(async (track) => {
    const nextDesired = Model.mergeDesired(state.cameraDesiredControls, updates);
    const patch = Model.buildManagedConstraintPatch(nextDesired, state.capabilities, ephemeral);
    state.cameraControlState = "APPLYING";
    const result = await applyConstraintSet(track, patch);
    if (!result.accepted) {
      state.cameraControlState = "ERROR";
      return result;
    }

    state.cameraDesiredControls = nextDesired;
    state.cameraControlState = "READY";
    let verification = { verified: null, value: undefined };
    if (verifyKey) {
      const expected = expectedValue === undefined ? nextDesired[verifyKey] : expectedValue;
      verification = await readAppliedSetting(track, verifyKey, expected, tolerance);
    }
    return { ...result, ...verification, patch };
  });

  Q.applyContinuousFocus = async ({ silent = true } = {}) => {
    if (!state.videoTrack || !getFocusModes().includes("continuous")) return false;
    clearFocusTimer();
    const result = await Q.applyManagedCameraControls({ focusMode: "continuous", focusDistance: null }, {
      verifyKey: "focusMode",
      expectedValue: "continuous",
    });
    if (!result.accepted) {
      if (!silent) showToast("オートフォーカス要求を送れませんでした");
      return false;
    }
    if (result.verified === false && result.value !== undefined) {
      console.info("Continuous AF was accepted but not confirmed by getSettings().", result);
    }
    Q.updateFocusSupportBadge("AF: 連続要求");
    window.setTimeout(() => Q.updateFocusSupportBadge(), 900);
    return true;
  };

  function restoreContinuousFocusSoon(delay = 900) {
    clearFocusTimer();
    if (!getFocusModes().includes("continuous")) return;
    state.focusRestoreTimer = window.setTimeout(() => {
      Q.applyContinuousFocus({ silent: true })
        .catch((error) => console.warn("Continuous focus restore failed.", error));
    }, delay);
  }

  Q.initializeAutofocus = async () => {
    const modes = getFocusModes();
    if (modes.includes("continuous")) {
      const accepted = await Q.applyContinuousFocus({ silent: true });
      if (accepted) {
        state.focusRestoreTimer = window.setTimeout(() => {
          Q.applyContinuousFocus({ silent: true }).catch((error) => console.warn("Initial AF reassert failed.", error));
        }, 800);
      }
      return accepted;
    }
    if (modes.includes("single-shot")) {
      const result = await Q.applyManagedCameraControls({ focusMode: "single-shot" }, {
        verifyKey: "focusMode",
        expectedValue: "single-shot",
      });
      return Boolean(result.accepted);
    }
    return false;
  };

  Q.enhancedApplyZoom = async (rawValue) => {
    const capability = state.capabilities.zoom;
    if (!state.videoTrack || !capability) return;
    const value = Q.roundToCapabilityStep(rawValue, capability, 0.1);
    const tolerance = Q.normalizeStep(capability.step, 0.1) / 2 + 1e-4;
    const result = await Q.applyManagedCameraControls({ zoom: value }, {
      verifyKey: "zoom", expectedValue: value, tolerance,
    });
    if (!result.accepted) {
      console.error(result.error);
      showToast("ズームを適用できませんでした");
      return;
    }
    state.currentZoom = result.verified ? Number(result.value) : value;
    elements.zoomRange.value = String(state.currentZoom);
    elements.zoomValue.value = `${state.currentZoom.toFixed(1)}×`;
  };

  Q.applyExposureIndex = async (rawIndex) => {
    window.clearTimeout(state.exposureApplyTimer);
    state.exposureApplyTimer = null;
    const capability = state.exposureCapability;
    if (!state.videoTrack || !capability) return;
    const index = Q.clamp(Math.round(Number(rawIndex)), capability.minIndex, capability.maxIndex);
    const value = Number((index * capability.step).toFixed(6));
    const result = await Q.applyManagedCameraControls({ exposureCompensation: value }, {
      verifyKey: "exposureCompensation", expectedValue: value, tolerance: capability.step / 2 + 1e-4,
    });
    if (!result.accepted) {
      console.error(result.error);
      showToast("明るさを適用できませんでした");
      return;
    }
    state.currentExposure = result.verified ? Number(result.value) : value;
    elements.exposureIndexRange.value = String(Math.round(state.currentExposure / capability.step));
    elements.exposureIndexValue.value = Q.formatEv(state.currentExposure);
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
    clearFocusTimer();
    const capability = state.focusCapability;
    if (!state.videoTrack || !capability) return;
    const index = Q.clamp(Math.round(Number(rawIndex)), 0, capability.count);
    const value = Q.roundToCapabilityStep(Number(capability.min) + index * capability.step, capability, 0.01);
    const result = await Q.applyManagedCameraControls({ focusMode: "manual", focusDistance: value }, {
      verifyKey: "focusDistance", expectedValue: value, tolerance: capability.step / 2 + 1e-4,
    });
    if (!result.accepted) {
      console.error(result.error);
      showToast("手動ピントを適用できませんでした");
      return;
    }
    const actual = result.verified ? Number(result.value) : value;
    elements.manualFocusRange.value = String(Math.round((actual - Number(capability.min)) / capability.step));
    elements.manualFocusValue.value = focusValueLabel(actual, capability);
    Q.updateFocusSupportBadge("AF: 手動");
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
    clearFocusTimer();
    elements.focusResetButton.disabled = true;
    try {
      const modes = getFocusModes();
      let accepted = false;
      if (modes.includes("single-shot")) {
        const result = await Q.applyManagedCameraControls({ focusMode: "single-shot", focusDistance: null }, {
          verifyKey: "focusMode", expectedValue: "single-shot",
        });
        accepted = Boolean(result.accepted);
        if (accepted) restoreContinuousFocusSoon(850);
      } else if (modes.includes("continuous")) {
        accepted = await Q.applyContinuousFocus({ silent: true });
      }
      if (!accepted) await Q.enhancedStartCamera();
      Q.enhancedUpdateCapabilities();
      showToast("AFを再要求しました");
    } finally {
      elements.focusResetButton.disabled = false;
    }
  };

  Q.enhancedToggleTorch = async () => {
    if (!state.videoTrack || state.capabilities.torch !== true || state.recorder?.state === "recording") return;
    const next = !Boolean(state.cameraDesiredControls.torch ?? state.torchEnabled);
    const result = await Q.applyManagedCameraControls({ torch: next }, {
      verifyKey: "torch", expectedValue: next,
    });
    if (!result.accepted) {
      console.error(result.error);
      showToast("ライトを適用できませんでした");
      return;
    }
    state.torchEnabled = result.verified === null || result.verified ? next : Boolean(result.value);
    elements.torchButton.setAttribute("aria-pressed", String(state.torchEnabled));
  };

  function showCenterFocusRing(mode = "fallback") {
    const rect = elements.video.getBoundingClientRect();
    showFocusRing(rect.left + rect.width / 2, rect.top + rect.height / 2, mode);
  }

  Q.enhancedFocusAt = async (clientX, clientY) => {
    if (!state.videoTrack || state.recorder?.state === "recording") return;
    const rect = elements.video.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;

    clearFocusTimer();
    const modes = getFocusModes();
    const hasPointFocus = Model.hasOwn(state.capabilities, "pointsOfInterest");
    const pointMode = modes.includes("single-shot") ? "single-shot" : modes.includes("continuous") ? "continuous" : null;

    if (hasPointFocus && pointMode) {
      const point = mapDisplayPointToSensor(clientX, clientY);
      const result = await Q.applyManagedCameraControls({ focusMode: pointMode, focusDistance: null }, {
        ephemeral: { pointsOfInterest: [point] },
        verifyKey: "focusMode",
        expectedValue: pointMode,
      });
      if (result.accepted) {
        // pointsOfInterest may be used for AF, AE, or AWB. Do not claim physical focus success.
        showFocusRing(clientX, clientY, "fallback");
        Q.updateFocusSupportBadge("AF: 位置要求");
        if (pointMode === "single-shot") restoreContinuousFocusSoon();
        window.setTimeout(() => Q.updateFocusSupportBadge(), 1000);
        return;
      }
    }

    if (modes.includes("single-shot")) {
      const result = await Q.applyManagedCameraControls({ focusMode: "single-shot", focusDistance: null }, {
        verifyKey: "focusMode", expectedValue: "single-shot",
      });
      if (result.accepted) {
        showCenterFocusRing();
        Q.updateFocusSupportBadge("AF: 中央要求");
        restoreContinuousFocusSoon();
        if (!Q.enhancedFocusAt.centerNoticeShown) {
          showToast("位置指定AFが使えないため、中央AFを要求しました");
          Q.enhancedFocusAt.centerNoticeShown = true;
        }
        return;
      }
    }

    if (modes.includes("continuous")) {
      if (await Q.applyContinuousFocus({ silent: true })) {
        showCenterFocusRing();
        if (!Q.enhancedFocusAt.continuousNoticeShown) {
          showToast("位置指定AFが使えないため、連続AFを再要求しました");
          Q.enhancedFocusAt.continuousNoticeShown = true;
        }
        return;
      }
    }

    if (state.focusCapability) {
      if (!Q.enhancedFocusAt.manualNoticeShown) {
        showToast("位置指定AFは非対応です。設定から手動ピントを調整できます");
        Q.enhancedFocusAt.manualNoticeShown = true;
      }
      return;
    }

    showFocusRing(clientX, clientY, "fallback");
    if (!Q.enhancedFocusAt.unsupportedNoticeShown) {
      showToast("このカメラのピントは端末側の自動調整を使用します");
      Q.enhancedFocusAt.unsupportedNoticeShown = true;
    }
  };
})();
