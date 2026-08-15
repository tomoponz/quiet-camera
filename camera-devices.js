"use strict";

(() => {
  const Q = window.QuietCameraEnhancements;
  const stageControls = elements.cameraStage.querySelector(".camera-top-controls");

  function recordingLocksCamera() {
    return Boolean(state.recorder && state.recorder.state !== "inactive") || Boolean(state.recordingFinalizing);
  }

  function setCameraInteractionReady(ready) {
    stageControls.inert = !ready;
    elements.cameraStage.tabIndex = ready ? 0 : -1;
    elements.cameraStage.setAttribute("aria-busy", String(!ready));
  }

  function stopStreamTracks(stream) {
    stream?.getTracks?.().forEach((track) => {
      try { track.stop(); } catch {}
    });
  }

  function cameraStartIsCurrent(generation) {
    return generation === state.cameraStartGeneration;
  }

  function buildVideoConstraints({ useSelectedDevice = true, relaxed = false } = {}) {
    const resolution = elements.videoResolutionSelect.value;
    const frameRate = elements.videoFrameRateSelect.value;
    const supported = navigator.mediaDevices?.getSupportedConstraints?.() ?? {};
    const video = {};

    if (useSelectedDevice && state.selectedDeviceId) video.deviceId = { exact: state.selectedDeviceId };
    else video.facingMode = { ideal: state.facingMode };

    // This is only an initial preference. The controller re-applies focus after capabilities are known.
    if (supported.focusMode) video.focusMode = { ideal: "continuous" };

    if (!relaxed) {
      if (resolution === "720") {
        video.width = { ideal: 1280 };
        video.height = { ideal: 720 };
      } else if (resolution === "1080") {
        video.width = { ideal: 1920 };
        video.height = { ideal: 1080 };
      } else if (state.mode === "video") {
        video.width = { ideal: 1920 };
        video.height = { ideal: 1080 };
      } else {
        video.width = { ideal: 2560 };
        video.height = { ideal: 1440 };
      }
      if (frameRate !== "auto") video.frameRate = { ideal: Number(frameRate) };
    }
    return video;
  }

  function buildAudioConstraints() {
    return microphoneEnabled()
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : false;
  }

  async function openCameraStream() {
    const candidates = [
      { audio: buildAudioConstraints(), video: buildVideoConstraints() },
      { audio: buildAudioConstraints(), video: buildVideoConstraints({ relaxed: true }) },
    ];
    if (state.selectedDeviceId) {
      candidates.push({ audio: buildAudioConstraints(), video: buildVideoConstraints({ useSelectedDevice: false }) });
    }

    let finalError = null;
    for (const constraints of candidates) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (error) {
        finalError = error;
        if (state.selectedDeviceId && ["NotFoundError", "OverconstrainedError"].includes(error?.name)) {
          Q.removeStoredDevice();
        }
      }
    }
    throw finalError || new Error("カメラを起動できませんでした");
  }

  Q.refreshCameraList = async ({ generation = state.cameraStartGeneration } = {}) => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (!cameraStartIsCurrent(generation)) return;
    const cameras = devices.filter((device) => device.kind === "videoinput");
    state.availableCameras = cameras;

    const currentId = Q.currentVideoSettings().deviceId || state.currentDeviceId;
    const existingIds = new Set(cameras.map((camera) => camera.deviceId));
    if (state.selectedDeviceId && !existingIds.has(state.selectedDeviceId)) Q.removeStoredDevice();

    elements.cameraSourceSelect.replaceChildren();
    const automatic = document.createElement("option");
    automatic.value = "";
    const currentCamera = cameras.find((camera) => camera.deviceId === currentId);
    automatic.textContent = currentCamera
      ? `自動選択（${Q.cameraLabel(currentCamera, cameras.indexOf(currentCamera))}）`
      : "自動選択";
    elements.cameraSourceSelect.append(automatic);

    cameras.forEach((camera, index) => {
      const option = document.createElement("option");
      option.value = camera.deviceId;
      option.textContent = Q.cameraLabel(camera, index);
      elements.cameraSourceSelect.append(option);
    });

    elements.cameraSourceField.hidden = cameras.length <= 1;
    elements.cameraSourceSelect.value = state.selectedDeviceId || "";
    elements.switchButton.hidden = cameras.length <= 1;
  };

  function describeCameraError(error) {
    switch (error?.name) {
      case "NotAllowedError": return microphoneEnabled() ? "カメラとマイクを許可してください" : "カメラを許可してください";
      case "NotFoundError": return "利用できるカメラが見つかりません";
      case "NotReadableError": return "カメラが他のアプリで使用中か、接続に失敗しました";
      case "OverconstrainedError": return "選択したカメラは指定した画質に対応していません";
      case "AbortError": return "カメラの起動が中断されました";
      default: return "カメラを起動できませんでした";
    }
  }

  function clearCameraControlTimers() {
    window.clearTimeout(state.cameraRestartTimer);
    window.clearTimeout(state.focusRestoreTimer);
    window.clearTimeout(state.manualFocusApplyTimer);
    window.clearTimeout(state.exposureApplyTimer);
    state.cameraRestartTimer = null;
    state.focusRestoreTimer = null;
    state.manualFocusApplyTimer = null;
    state.exposureApplyTimer = null;
  }

  function hideAdvancedCameraControls() {
    elements.manualFocusField.hidden = true;
    elements.exposureSettingField.hidden = true;
    Q.syncLiveControlVisibility();
  }

  function logCameraDiagnostics() {
    console.info("[Quiet Camera] camera diagnostics", {
      version: Q.APP_VERSION,
      controlState: state.cameraControlState,
      desiredControls: { ...state.cameraDesiredControls },
      supportedConstraints: navigator.mediaDevices?.getSupportedConstraints?.() ?? {},
      capabilities: state.capabilities,
      settings: Q.currentVideoSettings(),
      constraints: state.videoTrack?.getConstraints?.() ?? {},
    });
  }

  Q.enhancedStartCamera = async () => {
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
    if (recordingLocksCamera()) return;
    const moveFocusToShutter = document.activeElement === elements.startButton;

    const generation = state.cameraStartGeneration + 1;
    state.cameraStartGeneration = generation;

    clearCameraControlTimers();
    Q.invalidateCameraController();
    stopCamera();
    hideAdvancedCameraControls();
    elements.cameraStatus.textContent = "起動中…";
    elements.startButton.disabled = true;
    setCameraInteractionReady(false);

    let openedStream = null;
    try {
      openedStream = await openCameraStream();
      // getUserMedia has no abort signal; an obsolete result must be stopped explicitly.
      if (!cameraStartIsCurrent(generation)) {
        stopStreamTracks(openedStream);
        return;
      }

      state.stream = openedStream;
      elements.video.srcObject = openedStream;
      await elements.video.play();
      if (!cameraStartIsCurrent(generation) || state.stream !== openedStream) {
        stopStreamTracks(openedStream);
        if (elements.video.srcObject === openedStream) elements.video.srcObject = null;
        return;
      }

      [state.videoTrack] = openedStream.getVideoTracks();
      if (!state.videoTrack) throw new Error("映像トラックを取得できませんでした");

      const settings = Q.currentVideoSettings();
      state.currentDeviceId = settings.deviceId || "";
      if (["user", "environment"].includes(settings.facingMode)) state.facingMode = settings.facingMode;
      state.isFrontCamera = (settings.facingMode || state.facingMode) === "user";
      elements.video.classList.toggle("mirrored", state.isFrontCamera);
      const resolution = settings.width && settings.height
        ? `${settings.width}×${settings.height}`
        : state.isFrontCamera ? "前面カメラ" : "カメラ";
      const fps = settings.frameRate ? ` ${Math.round(settings.frameRate)}fps` : "";
      elements.cameraStatus.textContent = `${resolution}${fps}`;
      elements.permissionPanel.hidden = true;
      elements.shutterButton.disabled = false;
      elements.startButton.disabled = false;
      setCameraInteractionReady(true);
      if (moveFocusToShutter) elements.shutterButton.focus({ preventScroll: true });

      const activeTrack = state.videoTrack;
      activeTrack.addEventListener("unmute", () => {
        if (activeTrack === state.videoTrack) {
          Q.applyContinuousFocus({ silent: true }).catch((error) => console.warn("AF after track unmute failed.", error));
        }
      });
      activeTrack.addEventListener("ended", () => {
        if (activeTrack !== state.videoTrack) return;
        state.cameraStartGeneration += 1;
        window.clearTimeout(state.cameraRestartTimer);
        elements.cameraStatus.textContent = "カメラ切断";
        elements.shutterButton.disabled = true;
        elements.startButton.disabled = false;
        elements.permissionPanel.hidden = false;
        setCameraInteractionReady(false);
        Q.invalidateCameraController();
        stopCamera();
        hideAdvancedCameraControls();
        state.cameraRestartTimer = window.setTimeout(() => {
          state.cameraRestartTimer = null;
          if (document.visibilityState !== "visible" || state.stream || recordingLocksCamera()) return;
          Q.enhancedStartCamera().catch((error) => console.warn("Camera restart after disconnect failed.", error));
        }, 500);
      });

      updateCapabilities();
      Q.initializeCameraController();
      await Q.initializeAutofocus();
      if (!cameraStartIsCurrent(generation) || state.videoTrack !== activeTrack || activeTrack.readyState === "ended") return;
      updateCapabilities();
      updateMediaStatus();
      try {
        await Q.refreshCameraList({ generation });
      } catch (error) {
        console.warn("Camera list refresh failed after camera start.", error);
      }
      if (!cameraStartIsCurrent(generation) || state.stream !== openedStream) return;
      await requestWakeLock();

      logCameraDiagnostics();
    } catch (error) {
      stopStreamTracks(openedStream);
      if (!cameraStartIsCurrent(generation)) return;
      console.error(error);
      if (state.stream === openedStream) stopCamera();
      else if (elements.video.srcObject === openedStream) elements.video.srcObject = null;
      Q.invalidateCameraController();
      elements.cameraStatus.textContent = error?.name === "NotAllowedError" ? "許可が必要" : "起動失敗";
      elements.startButton.disabled = false;
      elements.shutterButton.disabled = true;
      elements.permissionPanel.hidden = false;
      setCameraInteractionReady(false);
      hideAdvancedCameraControls();
      showToast(describeCameraError(error));
    }
  };

  Q.enhancedSwitchCamera = async () => {
    if (state.busy || recordingLocksCamera()) return;
    Q.removeStoredDevice();
    state.facingMode = state.facingMode === "environment" ? "user" : "environment";
    await Q.enhancedStartCamera();
  };

  window.addEventListener("pagehide", () => {
    state.cameraStartGeneration += 1;
    window.clearTimeout(state.cameraRestartTimer);
    state.cameraRestartTimer = null;
  });

  setCameraInteractionReady(Boolean(state.stream));
})();
