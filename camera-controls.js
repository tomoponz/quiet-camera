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

  function createIndexedCapabilityRange(capability = {}, fallbackStep = 0.1) {
    const min = Number(capability.min);
    const max = Number(capability.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
    const span = max - min;
    const requestedStep = Number(capability.step);
    const fallback = Number(fallbackStep);
    const normalizedStep = Number.isFinite(requestedStep) && requestedStep > 0
      ? requestedStep
      : Number.isFinite(fallback) && fallback > 0 ? fallback : span;
    const step = Math.min(normalizedStep, span);
    const count = Math.max(1, Math.floor(span / step + 1e-6));
    // Keep index 0 as the closest supported reset value while anchoring every step at capability.min.
    const zeroTarget = clamp(0, min, max);
    const zeroOffset = clamp(Math.round((zeroTarget - min) / step), 0, count);
    return {
      min,
      max,
      step,
      count,
      zeroOffset,
      minIndex: -zeroOffset,
      maxIndex: count - zeroOffset,
    };
  }

  function capabilityValueForIndex(range, rawIndex) {
    if (!range) return null;
    const numericIndex = Number(rawIndex);
    const index = clamp(Number.isFinite(numericIndex) ? Math.round(numericIndex) : 0, range.minIndex, range.maxIndex);
    const value = range.min + (index + range.zeroOffset) * range.step;
    return Number(clamp(value, range.min, range.max).toFixed(6));
  }

  function capabilityIndexForValue(range, rawValue) {
    if (!range) return null;
    const numericValue = Number(rawValue);
    const value = clamp(Number.isFinite(numericValue) ? numericValue : 0, range.min, range.max);
    const stepIndex = clamp(Math.round((value - range.min) / range.step), 0, range.count);
    return stepIndex - range.zeroOffset;
  }

  function isControlContextCurrent(track, generation, currentTrack, currentGeneration) {
    return Boolean(track)
      && track === currentTrack
      && generation === currentGeneration
      && track.readyState !== "ended";
  }

  function createLatestTaskRunner(runTask) {
    if (typeof runTask !== "function") throw new TypeError("runTask must be a function");
    let hasPending = false;
    let latestTask;
    let activePromise = null;

    const start = () => {
      if (activePromise || !hasPending) return activePromise;
      activePromise = (async () => {
        while (hasPending) {
          hasPending = false;
          const task = latestTask;
          await runTask(task);
        }
      })().finally(() => {
        activePromise = null;
        if (hasPending) start();
      });
      return activePromise;
    };

    return {
      submit(task) {
        latestTask = task;
        hasPending = true;
        return start();
      },
      clear() {
        hasPending = false;
        latestTask = undefined;
      },
    };
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

  function buildManagedConstraintPatch(desired = {}, capabilities = {}, ephemeral = {}, supportedConstraints = {}) {
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

    if (supportedConstraints.pointsOfInterest === true && Array.isArray(ephemeral.pointsOfInterest)
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
    createIndexedCapabilityRange,
    capabilityValueForIndex,
    capabilityIndexForValue,
    isControlContextCurrent,
    createLatestTaskRunner,
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
  let zoomTaskRunner = null;
  let latestZoomRequestId = 0;

  function recordingLocksCameraControls() {
    return Boolean(state.recorder && state.recorder.state !== "inactive") || Boolean(state.recordingFinalizing);
  }

  function getSupportedConstraintFlags() {
    try { return navigator.mediaDevices?.getSupportedConstraints?.() ?? {}; }
    catch { return {}; }
  }

  function controlContextIsCurrent(track, generation) {
    return Model.isControlContextCurrent(
      track,
      generation,
      state.videoTrack,
      state.cameraControlGeneration,
    );
  }

  function getFocusModes() {
    return Array.isArray(state.capabilities.focusMode) ? state.capabilities.focusMode : [];
  }

  function configureExposureControl(settings) {
    const capability = state.capabilities.exposureCompensation;
    const indexedRange = Model.createIndexedCapabilityRange(capability, 0.1);
    if (!indexedRange) {
      state.exposureCapability = null;
      elements.exposureIndexRange.disabled = true;
      elements.exposureResetButton.disabled = true;
      elements.exposureIndexValue.value = "利用不可";
      elements.exposureIndexRange.setAttribute("aria-valuetext", "この端末では利用できません");
      elements.exposureAvailability.hidden = false;
      elements.exposureSettingField.hidden = false;
      return;
    }

    const rawCurrent = Number(settings.exposureCompensation ?? state.cameraDesiredControls.exposureCompensation ?? 0);
    const current = Number.isFinite(rawCurrent) ? rawCurrent : 0;
    const currentIndex = Model.capabilityIndexForValue(indexedRange, current);
    state.exposureCapability = { ...capability, ...indexedRange };
    state.currentExposure = Model.capabilityValueForIndex(indexedRange, currentIndex);
    elements.exposureIndexRange.min = String(indexedRange.minIndex);
    elements.exposureIndexRange.max = String(indexedRange.maxIndex);
    elements.exposureIndexRange.step = "1";
    elements.exposureIndexRange.value = String(currentIndex);
    elements.exposureIndexValue.value = Q.formatEv(state.currentExposure);
    elements.exposureIndexRange.setAttribute("aria-valuetext", Q.formatEv(state.currentExposure));
    elements.exposureIndexRange.disabled = false;
    elements.exposureResetButton.disabled = false;
    elements.exposureAvailability.hidden = true;
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
      elements.manualFocusRange.disabled = true;
      elements.focusResetButton.disabled = true;
      elements.manualFocusValue.value = "端末AF";
      elements.manualFocusRange.setAttribute("aria-valuetext", "端末のオートフォーカス");
      elements.manualFocusAvailability.hidden = false;
      elements.manualFocusField.hidden = false;
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
    elements.manualFocusRange.setAttribute("aria-valuetext", elements.manualFocusValue.value);
    elements.manualFocusRange.disabled = false;
    elements.focusResetButton.disabled = false;
    elements.manualFocusAvailability.hidden = true;
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
    latestZoomRequestId += 1;
    zoomTaskRunner?.clear();
    state.cameraControlGeneration += 1;
    state.cameraControlTrack = null;
    state.cameraControlQueue = Promise.resolve();
    state.cameraDesiredControls = {};
    state.cameraControlState = "IDLE";
  };

  Q.initializeCameraController = () => {
    clearFocusTimer();
    latestZoomRequestId += 1;
    zoomTaskRunner?.clear();
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
        if (!controlContextIsCurrent(track, generation)) {
          return { accepted: false, stale: true };
        }
        return operation(track, generation);
      });
    return state.cameraControlQueue;
  }

  async function applyConstraintSet(track, generation, patch) {
    if (!Object.keys(patch).length) return { accepted: false, error: new Error("No supported camera constraints") };
    const existingConstraints = track.getConstraints?.() ?? {};
    const attempts = Model.buildConstraintAttempts(existingConstraints, patch);
    let finalError = null;
    for (const constraints of attempts) {
      if (!controlContextIsCurrent(track, generation)) return { accepted: false, stale: true };
      try {
        await track.applyConstraints(constraints);
        if (!controlContextIsCurrent(track, generation)) return { accepted: false, stale: true };
        return { accepted: true, constraints };
      } catch (error) {
        if (!controlContextIsCurrent(track, generation)) return { accepted: false, stale: true };
        finalError = error;
      }
    }
    return { accepted: false, error: finalError || new Error("Constraint was rejected") };
  }

  async function readAppliedSetting(track, generation, key, expected, tolerance = 0.001) {
    const delays = [0, 90, 220, 420];
    let lastValue;
    for (const delay of delays) {
      if (delay) await wait(delay);
      if (!controlContextIsCurrent(track, generation)) return { verified: false, stale: true, value: lastValue };
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
  } = {}) => enqueueControlOperation(async (track, generation) => {
    const nextDesired = Model.mergeDesired(state.cameraDesiredControls, updates);
    const patch = Model.buildManagedConstraintPatch(
      nextDesired,
      state.capabilities,
      ephemeral,
      getSupportedConstraintFlags(),
    );
    state.cameraControlState = "APPLYING";
    const result = await applyConstraintSet(track, generation, patch);
    if (result.stale || !controlContextIsCurrent(track, generation)) {
      return { ...result, accepted: false, stale: true, patch };
    }
    if (!result.accepted) {
      state.cameraControlState = "ERROR";
      return result;
    }

    let verification = { verified: null, value: undefined };
    if (verifyKey) {
      const expected = expectedValue === undefined ? nextDesired[verifyKey] : expectedValue;
      verification = await readAppliedSetting(track, generation, verifyKey, expected, tolerance);
      if (verification.stale || !controlContextIsCurrent(track, generation)) {
        return { ...result, ...verification, accepted: false, stale: true, patch };
      }
    }
    // A resolved applyConstraints() only proves that the request was accepted.
    // Do not preserve an unconfirmed value in later combined control patches.
    if (verification.verified === false) {
      state.cameraControlState = "UNVERIFIED";
    } else {
      state.cameraDesiredControls = nextDesired;
      state.cameraControlState = "READY";
    }
    return { ...result, ...verification, patch };
  });

  Q.applyContinuousFocus = async ({ silent = true } = {}) => {
    if (!state.videoTrack || recordingLocksCameraControls() || !getFocusModes().includes("continuous")) return false;
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

  // Pointer/range input can outpace hardware. Keep one operation in flight and only the latest pending value.
  zoomTaskRunner = Model.createLatestTaskRunner(async ({ id, track, generation, value, tolerance }) => {
    if (!controlContextIsCurrent(track, generation) || recordingLocksCameraControls()) return;
    let result;
    try {
      result = await Q.applyManagedCameraControls({ zoom: value }, {
        verifyKey: "zoom", expectedValue: value, tolerance,
      });
    } catch (error) {
      if (id === latestZoomRequestId) {
        console.error(error);
        showToast("ズームを適用できませんでした");
      }
      return;
    }
    if (id !== latestZoomRequestId || result.stale) return;
    if (!result.accepted) {
      console.error(result.error);
      showToast("ズームを適用できませんでした");
      return;
    }
    const observed = Number(result.value);
    if (result.verified === false) {
      if (Number.isFinite(observed)) state.currentZoom = observed;
      elements.zoomRange.value = String(state.currentZoom);
      elements.zoomValue.value = `${state.currentZoom.toFixed(1)}×`;
      showToast("ズームの反映を確認できませんでした");
      return;
    }
    state.currentZoom = Number.isFinite(observed) ? observed : value;
    elements.zoomRange.value = String(state.currentZoom);
    elements.zoomValue.value = `${state.currentZoom.toFixed(1)}×`;
  });

  Q.enhancedApplyZoom = (rawValue) => {
    const capability = state.capabilities.zoom;
    if (!state.videoTrack || !capability || recordingLocksCameraControls()) return Promise.resolve();
    const value = Q.roundToCapabilityStep(rawValue, capability, 0.1);
    const tolerance = Q.normalizeStep(capability.step, 0.1) / 2 + 1e-4;
    latestZoomRequestId += 1;
    return zoomTaskRunner.submit({
      id: latestZoomRequestId,
      track: state.videoTrack,
      generation: state.cameraControlGeneration,
      value,
      tolerance,
    });
  };

  Q.applyExposureIndex = async (rawIndex) => {
    window.clearTimeout(state.exposureApplyTimer);
    state.exposureApplyTimer = null;
    const capability = state.exposureCapability;
    if (!state.videoTrack || !capability) return;
    const index = Q.clamp(Math.round(Number(rawIndex)), capability.minIndex, capability.maxIndex);
    const value = Model.capabilityValueForIndex(capability, index);
    const result = await Q.applyManagedCameraControls({ exposureCompensation: value }, {
      verifyKey: "exposureCompensation", expectedValue: value, tolerance: capability.step / 2 + 1e-4,
    });
    if (!result.accepted) {
      console.error(result.error);
      showToast("明るさを適用できませんでした");
      return;
    }
    const observed = Number(result.value);
    if (result.verified === false) {
      if (Number.isFinite(observed)) state.currentExposure = observed;
      elements.exposureIndexRange.value = String(Model.capabilityIndexForValue(capability, state.currentExposure));
      elements.exposureIndexValue.value = Q.formatEv(state.currentExposure);
      elements.exposureIndexRange.setAttribute("aria-valuetext", Q.formatEv(state.currentExposure));
      showToast("明るさの反映を確認できませんでした");
      return;
    }
    state.currentExposure = Number.isFinite(observed) ? observed : value;
    elements.exposureIndexRange.value = String(Model.capabilityIndexForValue(capability, state.currentExposure));
    elements.exposureIndexValue.value = Q.formatEv(state.currentExposure);
    elements.exposureIndexRange.setAttribute("aria-valuetext", Q.formatEv(state.currentExposure));
  };

  Q.scheduleExposureIndex = (rawIndex) => {
    const capability = state.exposureCapability;
    if (!capability) return;
    const index = Q.clamp(Math.round(Number(rawIndex)), capability.minIndex, capability.maxIndex);
    const value = Model.capabilityValueForIndex(capability, index);
    elements.exposureIndexValue.value = Q.formatEv(value);
    elements.exposureIndexRange.setAttribute("aria-valuetext", Q.formatEv(value));
    window.clearTimeout(state.exposureApplyTimer);
    state.exposureApplyTimer = window.setTimeout(() => Q.applyExposureIndex(index), CONTROL_DEBOUNCE_MS);
  };

  Q.applyManualFocus = async (rawIndex) => {
    window.clearTimeout(state.manualFocusApplyTimer);
    state.manualFocusApplyTimer = null;
    clearFocusTimer();
    const capability = state.focusCapability;
    if (!state.videoTrack || !capability || recordingLocksCameraControls()) return;
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
    const observed = Number(result.value);
    if (result.verified === false) {
      if (Number.isFinite(observed)) {
        elements.manualFocusRange.value = String(Math.round((observed - Number(capability.min)) / capability.step));
        elements.manualFocusValue.value = focusValueLabel(observed, capability);
      } else {
        elements.manualFocusValue.value = "要求（反映未確認）";
      }
      elements.manualFocusRange.setAttribute("aria-valuetext", elements.manualFocusValue.value);
      Q.updateFocusSupportBadge("ピント: 手動要求（未確認）");
      showToast("手動ピントの反映を確認できませんでした");
      return;
    }
    const actual = Number.isFinite(observed) ? observed : value;
    elements.manualFocusRange.value = String(Math.round((actual - Number(capability.min)) / capability.step));
    elements.manualFocusValue.value = focusValueLabel(actual, capability);
    elements.manualFocusRange.setAttribute("aria-valuetext", elements.manualFocusValue.value);
    Q.updateFocusSupportBadge("ピント: 手動要求");
  };

  Q.scheduleManualFocus = (rawIndex) => {
    const capability = state.focusCapability;
    if (!capability || recordingLocksCameraControls()) return;
    const index = Q.clamp(Math.round(Number(rawIndex)), 0, capability.count);
    const value = Q.roundToCapabilityStep(Number(capability.min) + index * capability.step, capability, 0.01);
    elements.manualFocusValue.value = focusValueLabel(value, capability);
    elements.manualFocusRange.setAttribute("aria-valuetext", elements.manualFocusValue.value);
    window.clearTimeout(state.manualFocusApplyTimer);
    state.manualFocusApplyTimer = window.setTimeout(() => Q.applyManualFocus(index), CONTROL_DEBOUNCE_MS);
  };

  Q.resetFocus = async () => {
    if (!state.stream || recordingLocksCameraControls()) return;
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
    if (!state.videoTrack || state.capabilities.torch !== true || recordingLocksCameraControls()) return;
    const next = !Boolean(state.cameraDesiredControls.torch ?? state.torchEnabled);
    const result = await Q.applyManagedCameraControls({ torch: next }, {
      verifyKey: "torch", expectedValue: next,
    });
    if (!result.accepted) {
      console.error(result.error);
      showToast("ライトを適用できませんでした");
      return;
    }
    if (result.verified === false) {
      state.torchEnabled = Boolean(result.value);
      elements.torchButton.setAttribute("aria-pressed", String(state.torchEnabled));
      showToast("ライトの反映を確認できませんでした");
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
    if (!state.videoTrack || recordingLocksCameraControls()) return;
    const rect = elements.video.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;

    clearFocusTimer();
    const modes = getFocusModes();
    const hasPointFocus = getSupportedConstraintFlags().pointsOfInterest === true;
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
