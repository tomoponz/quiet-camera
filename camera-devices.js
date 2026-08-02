"use strict";

(() => {
  const Q = window.QuietCameraEnhancements;

  function buildVideoConstraints({ useSelectedDevice = true, relaxed = false } = {}) {
    const resolution = elements.videoResolutionSelect.value;
    const frameRate = elements.videoFrameRateSelect.value;
    const video = {};
    if (useSelectedDevice && state.selectedDeviceId) video.deviceId = { exact: state.selectedDeviceId };
    else video.facingMode = { ideal: state.facingMode };

    if (!relaxed) {
      if (resolution === "720") {
        video.width = { ideal: 1280 }; video.height = { ideal: 720 };
      } else if (resolution === "1080") {
        video.width = { ideal: 1920 }; video.height = { ideal: 1080 };
      } else if (state.mode === "video") {
        video.width = { ideal: 1920 }; video.height = { ideal: 1080 };
      } else {
        video.width = { ideal: 2560 }; video.height = { ideal: 1440 };
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
      try { return await navigator.mediaDevices.getUserMedia(constraints); }
      catch (error) {
        finalError = error;
        if (state.selectedDeviceId && ["NotFoundError", "OverconstrainedError"].includes(error?.name)) {
          Q.removeStoredDevice();
        }
      }
    }
    throw finalError || new Error("カメラを起動できませんでした");
  }

  Q.refreshCameraList = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
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
    if (state.recorder?.state === "recording") return;

    stopCamera();
    elements.cameraStatus.textContent = "起動中…";
    elements.startButton.disabled = true;
    try {
      state.stream = await openCameraStream();
      elements.video.srcObject = state.stream;
      await elements.video.play();
      [state.videoTrack] = state.stream.getVideoTracks();
      const settings = Q.currentVideoSettings();
      state.currentDeviceId = settings.deviceId || "";
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
      updateCapabilities();
      updateMediaStatus();
      await Q.refreshCameraList();
      await requestWakeLock();
    } catch (error) {
      console.error(error);
      elements.cameraStatus.textContent = error?.name === "NotAllowedError" ? "許可が必要" : "起動失敗";
      elements.startButton.disabled = false;
      elements.permissionPanel.hidden = false;
      showToast(describeCameraError(error));
    }
  };

  Q.enhancedSwitchCamera = async () => {
    if (state.busy || state.recorder?.state === "recording") return;
    Q.removeStoredDevice();
    state.facingMode = state.facingMode === "environment" ? "user" : "environment";
    await Q.enhancedStartCamera();
  };
})();
