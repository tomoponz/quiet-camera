"use strict";

(() => {
  const Q = window.QuietCameraEnhancements;
  const video = elements.video;
  let hold = null, timer = null;
  Q.canReuseStreamForMode = mode => {
    if (state.mode !== "photo" || mode !== "video" || state.cameraTransitioning || elements.microphoneSelect.value !== "off") return false;
    const stream = state.stream, track = state.videoTrack, settings = track?.getSettings?.() || {};
    if (!stream || video.srcObject !== stream || video.readyState < 2 || track?.readyState !== "live" || track.muted || stream.getAudioTracks().some(t => t.readyState === "live")) return false;
    if (state.selectedDeviceId && settings.deviceId !== state.selectedDeviceId) return false;
    if (settings.facingMode && settings.facingMode !== state.facingMode) return false;
    if (!ratiosApproximatelyMatch(normalizedVideoTrackAspectRatio(settings), ratioValue(state.videoRatio))) return false;
    // Match the existing video acquisition preference exactly; do not change
    // negotiated recording resolution merely to make switching seem faster.
    const width = Math.max(Number(settings.width), Number(settings.height));
    const height = Math.min(Number(settings.width), Number(settings.height));
    const resolution = elements.videoResolutionSelect.value;
    const expected = resolution === "720" ? [1280,720] : [1920,1080];
    if (width !== expected[0] || height !== expected[1]) return false;
    const fps = elements.videoFrameRateSelect.value;
    return fps === "auto" || Math.abs(Number(settings.frameRate) - Number(fps)) < 0.5;
  };
  function releasePixels() {
    clearTimeout(timer); timer = null;
    if (hold) { hold.width = hold.height = 0; hold.remove(); hold = null; }
  }
  Q.beginPreviewTransition = () => {
    if (!hold && video.readyState >= 2 && video.videoWidth && video.videoHeight) {
      const canvas = document.createElement("canvas");
      canvas.className = "camera-transition-frame"; canvas.setAttribute("aria-hidden", "true");
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      try {
        canvas.getContext("2d").drawImage(video, 0, 0);
        canvas.classList.toggle("mirrored", video.classList.contains("mirrored"));
        elements.cameraStage.append(canvas); hold = canvas;
      } catch { canvas.width = canvas.height = 0; }
    }
    state.cameraTransitioning = true;
    elements.shutterButton.disabled = true;
    elements.cameraStage.dataset.transitioning = "true";
    clearTimeout(timer);
    // Permission/device stalls must not leave an apparently live frozen frame.
    timer = setTimeout(() => {
      releasePixels();
      if (state.cameraTransitioning) elements.cameraStatus.textContent = "カメラ接続待ち…";
    }, 3000);
  };
  Q.endPreviewTransition = () => {
    releasePixels(); state.cameraTransitioning = false;
    delete elements.cameraStage.dataset.transitioning;
  };
  Q.waitForFirstVideoFrame = isCurrent => new Promise((resolve,reject) => {
    let callback, finished = false;
    const finish = error => {
      if (finished) return; finished = true;
      clearInterval(poll); clearTimeout(timeout);
      if (callback !== undefined) video.cancelVideoFrameCallback?.(callback);
      error ? reject(error) : resolve(isCurrent());
    };
    const timeout = setTimeout(() => finish(new Error("新しいカメラ映像を確認できませんでした")), 5000);
    const poll = setInterval(() => {
      if (!isCurrent()) finish();
      else if (!video.requestVideoFrameCallback && video.readyState >= 2 && video.videoWidth && video.videoHeight) finish();
    }, 25);
    if (video.requestVideoFrameCallback) callback = video.requestVideoFrameCallback(() => finish());
  });
  window.addEventListener("pagehide", Q.endPreviewTransition);
})();
