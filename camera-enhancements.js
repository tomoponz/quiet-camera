"use strict";

(() => {
  const Q = window.QuietCameraEnhancements;

  function placeSettingsPanel() {
    if (Q.MOBILE_QUERY.matches) {
      if (elements.settingsPanel.parentElement !== elements.settingsSheetBody) elements.settingsSheetBody.append(elements.settingsPanel);
    } else if (elements.settingsPanel.parentElement !== elements.settingsDock) {
      elements.settingsDock.append(elements.settingsPanel);
      if (elements.settingsDialog.open) elements.settingsDialog.close();
    }
  }

  function openSettings() {
    placeSettingsPanel();
    if (Q.MOBILE_QUERY.matches) elements.settingsDialog.showModal();
    else elements.settingsPanel.scrollIntoView({ behavior: "smooth", block: "center" });
  }

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
  elements.closeSettingsButton.addEventListener("click", () => elements.settingsDialog.close());
  elements.settingsDialog.addEventListener("click", (event) => {
    if (event.target === elements.settingsDialog) elements.settingsDialog.close();
  });
  elements.privacyButton.addEventListener("click", () => {
    if (elements.settingsDialog.open) elements.settingsDialog.close();
  }, { capture: true });
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

  function installDeviceCameraStyles() {
    if (document.getElementById("deviceCameraStyles")) return;
    const style = document.createElement("style");
    style.id = "deviceCameraStyles";
    style.textContent = `
      .device-camera-field { grid-column: 1 / -1; align-items: start; }
      .device-camera-field > span { padding-top: 8px; }
      .device-camera-actions { min-width: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
      .device-camera-action { min-height: 40px; padding: 7px 9px; border: 1px solid var(--border); border-radius: 10px; background: #252830; color: #fff; font-size: .75rem; font-weight: 800; }
      .device-camera-note { grid-column: 1 / -1; margin: 0; color: var(--muted); font-size: .68rem; line-height: 1.45; }
      .device-camera-quick { width: min(100%, 280px); margin-top: 10px; }
      html.immersive-mode .device-camera-quick { display: inline-flex; align-items: center; justify-content: center; }
      @media (max-width: 420px) {
        .device-camera-actions { grid-template-columns: 1fr; }
        .device-camera-note { grid-column: 1; }
      }
    `;
    document.head.append(style);
  }

  function inferExtension(file, kind) {
    const nameMatch = String(file.name || "").toLowerCase().match(/\.([a-z0-9]{2,6})$/);
    if (nameMatch) return nameMatch[1] === "jpeg" ? "jpg" : nameMatch[1];
    const type = String(file.type || "").toLowerCase();
    const mimeExtensions = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/heic": "heic",
      "image/heif": "heif",
      "image/avif": "avif",
      "video/mp4": "mp4",
      "video/quicktime": "mov",
      "video/webm": "webm",
    };
    return mimeExtensions[type] || (kind === "video" ? "mp4" : "jpg");
  }

  function inferKind(file) {
    const type = String(file.type || "").toLowerCase();
    if (type.startsWith("image/")) return "photo";
    if (type.startsWith("video/")) return "video";
    const extension = inferExtension(file, "photo");
    if (["jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "gif"].includes(extension)) return "photo";
    if (["mp4", "mov", "m4v", "webm", "3gp"].includes(extension)) return "video";
    return null;
  }

  async function decodeImageFile(file) {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          dispose: () => bitmap.close?.(),
        };
      } catch (error) {
        console.warn("createImageBitmap could not decode the device-camera image.", error);
      }
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.decoding = "async";
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("この画像形式をブラウザで読み込めません"));
        element.src = objectUrl;
      });
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        dispose: () => URL.revokeObjectURL(objectUrl),
      };
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  async function createDevicePhotoPreview(file) {
    const decoded = await decodeImageFile(file);
    try {
      if (!decoded.width || !decoded.height) throw new Error("画像サイズを取得できませんでした");
      const maxDimension = 1600;
      const scale = Math.min(1, maxDimension / Math.max(decoded.width, decoded.height));
      const width = Math.max(1, Math.round(decoded.width * scale));
      const height = Math.max(1, Math.round(decoded.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("画像のプレビューを作成できませんでした");
      context.fillStyle = "#000";
      context.fillRect(0, 0, width, height);
      context.drawImage(decoded.source, 0, 0, width, height);
      const previewBlob = await canvasToBlob(canvas, "image/jpeg", 0.88);
      return { previewBlob, width: decoded.width, height: decoded.height };
    } finally {
      decoded.dispose?.();
    }
  }

  function readVideoMetadata(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const video = document.createElement("video");
      const timeoutId = window.setTimeout(() => finish(new Error("動画情報の読み込みがタイムアウトしました")), 15000);
      let settled = false;

      function finish(error, result) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(objectUrl);
        if (error) reject(error);
        else resolve(result);
      }

      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.onloadedmetadata = () => finish(null, {
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0,
      });
      video.onerror = () => finish(new Error("この動画形式をブラウザで読み込めません"));
      video.src = objectUrl;
    });
  }

  async function importDeviceCameraFile(file) {
    if (!file || file.size <= 0) throw new Error("撮影ファイルを取得できませんでした");
    const kind = inferKind(file);
    if (!kind) throw new Error("写真または動画のファイルを選択してください");

    if (kind === "photo") {
      const preview = await createDevicePhotoPreview(file);
      const extension = inferExtension(file, kind);
      const typeLabel = extension.toUpperCase();
      await addMedia({
        kind: "photo",
        blob: file,
        previewBlob: preview.previewBlob,
        extension,
        mimeType: file.type || "application/octet-stream",
        width: preview.width,
        height: preview.height,
        meta: `${typeLabel} · ${preview.width}×${preview.height} · ${formatBytes(file.size)} · 端末カメラから取り込み`,
      });
      showToast("端末カメラの写真を履歴へ追加しました");
      return;
    }

    const metadata = await readVideoMetadata(file);
    const extension = inferExtension(file, kind);
    const dimensions = metadata.width && metadata.height ? `${metadata.width}×${metadata.height} · ` : "";
    const duration = metadata.durationMs > 0 ? `${formatDuration(metadata.durationMs)} · ` : "";
    await addMedia({
      kind: "video",
      blob: file,
      extension,
      mimeType: file.type || "application/octet-stream",
      width: metadata.width,
      height: metadata.height,
      durationMs: metadata.durationMs,
      meta: `${extension.toUpperCase()} · ${dimensions}${duration}${formatBytes(file.size)} · 端末カメラから取り込み`,
    });
    showToast("端末カメラの動画を履歴へ追加しました");
  }

  let captureSession = null;
  let captureProcessing = false;
  const deviceCameraInput = document.createElement("input");
  deviceCameraInput.id = "deviceCameraInput";
  deviceCameraInput.type = "file";
  deviceCameraInput.hidden = true;
  document.body.append(deviceCameraInput);

  async function resumeWebCamera(session) {
    if (!session?.resumeWebCamera || state.stream || captureProcessing) return;
    try { await Q.enhancedStartCamera(); }
    catch (error) { console.warn("Web camera could not be resumed after device capture.", error); }
  }

  function scheduleCancelledCaptureResume() {
    const session = captureSession;
    if (!session || session.fileReceived || captureProcessing) return;
    window.setTimeout(async () => {
      if (captureSession !== session || session.fileReceived || captureProcessing || document.visibilityState !== "visible") return;
      captureSession = null;
      await resumeWebCamera(session);
    }, 1000);
  }

  function launchDeviceCamera(facing = "environment") {
    if (state.recorder?.state === "recording" || state.busy || captureProcessing) {
      showToast("録画または処理中は端末カメラを開けません");
      return;
    }

    const mode = state.mode === "video" ? "video" : "photo";
    const resumeWebCameraAfterCapture = Boolean(state.stream);
    if (resumeWebCameraAfterCapture) stopCamera();
    if (elements.settingsDialog.open) elements.settingsDialog.close();

    captureSession = { resumeWebCamera: resumeWebCameraAfterCapture, fileReceived: false };
    deviceCameraInput.value = "";
    deviceCameraInput.accept = mode === "video" ? "video/*" : "image/*";
    deviceCameraInput.setAttribute("capture", facing === "user" ? "user" : "environment");
    deviceCameraInput.click();
  }

  deviceCameraInput.addEventListener("change", async () => {
    const session = captureSession || { resumeWebCamera: false, fileReceived: true };
    session.fileReceived = true;
    const file = deviceCameraInput.files?.[0];
    deviceCameraInput.value = "";
    if (!file) {
      captureSession = null;
      await resumeWebCamera(session);
      return;
    }

    captureProcessing = true;
    state.busy = true;
    setControlsDisabled(true);
    try {
      await importDeviceCameraFile(file);
    } catch (error) {
      console.error(error);
      showToast(error?.message || "端末カメラの撮影結果を読み込めませんでした");
    } finally {
      state.busy = false;
      captureProcessing = false;
      setControlsDisabled(false);
      captureSession = null;
      await resumeWebCamera(session);
    }
  });

  function updateDeviceCameraLabels() {
    const videoMode = state.mode === "video";
    rearDeviceCameraButton.textContent = videoMode ? "背面で録画" : "背面で撮影";
    frontDeviceCameraButton.textContent = videoMode ? "前面で録画" : "前面で撮影";
    quickDeviceCameraButton.textContent = videoMode ? "端末カメラで録画" : "端末カメラで撮影";
  }

  installDeviceCameraStyles();
  const deviceCameraField = document.createElement("div");
  deviceCameraField.id = "deviceCameraField";
  deviceCameraField.className = "setting-field device-camera-field";
  const deviceCameraLabel = document.createElement("span");
  deviceCameraLabel.textContent = "端末カメラ";
  const deviceCameraActions = document.createElement("div");
  deviceCameraActions.className = "device-camera-actions";
  const rearDeviceCameraButton = document.createElement("button");
  rearDeviceCameraButton.id = "rearDeviceCameraButton";
  rearDeviceCameraButton.className = "device-camera-action";
  rearDeviceCameraButton.type = "button";
  const frontDeviceCameraButton = document.createElement("button");
  frontDeviceCameraButton.id = "frontDeviceCameraButton";
  frontDeviceCameraButton.className = "device-camera-action";
  frontDeviceCameraButton.type = "button";
  const deviceCameraNote = document.createElement("p");
  deviceCameraNote.className = "device-camera-note";
  deviceCameraNote.textContent = "標準カメラを開きます。対応端末では、その画面でタップフォーカスを利用できます。撮影結果だけをQuiet Cameraへ戻します。";
  deviceCameraActions.append(rearDeviceCameraButton, frontDeviceCameraButton, deviceCameraNote);
  deviceCameraField.append(deviceCameraLabel, deviceCameraActions);
  elements.settingsPanel.insertBefore(deviceCameraField, elements.privacyButton);

  const quickDeviceCameraButton = document.createElement("button");
  quickDeviceCameraButton.id = "quickDeviceCameraButton";
  quickDeviceCameraButton.className = "secondary-button device-camera-quick";
  quickDeviceCameraButton.type = "button";
  elements.permissionPanel.append(quickDeviceCameraButton);

  rearDeviceCameraButton.addEventListener("click", () => launchDeviceCamera("environment"));
  frontDeviceCameraButton.addEventListener("click", () => launchDeviceCamera("user"));
  quickDeviceCameraButton.addEventListener("click", () => launchDeviceCamera("environment"));
  elements.photoModeButton.addEventListener("click", () => window.setTimeout(updateDeviceCameraLabels));
  elements.videoModeButton.addEventListener("click", () => window.setTimeout(updateDeviceCameraLabels));
  window.addEventListener("focus", scheduleCancelledCaptureResume);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleCancelledCaptureResume();
  });

  Q.launchDeviceCamera = launchDeviceCamera;
  Q.importDeviceCameraFile = importDeviceCameraFile;
  updateDeviceCameraLabels();
  placeSettingsPanel();
})();
