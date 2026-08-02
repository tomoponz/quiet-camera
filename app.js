"use strict";

const elements = {
  video: document.querySelector("#cameraVideo"),
  canvas: document.querySelector("#captureCanvas"),
  cameraStage: document.querySelector("#cameraStage"),
  permissionPanel: document.querySelector("#permissionPanel"),
  startButton: document.querySelector("#startButton"),
  switchButton: document.querySelector("#switchButton"),
  timerButton: document.querySelector("#timerButton"),
  ratioButton: document.querySelector("#ratioButton"),
  gridButton: document.querySelector("#gridButton"),
  gridOverlay: document.querySelector("#gridOverlay"),
  shutterButton: document.querySelector("#shutterButton"),
  cameraStatus: document.querySelector("#cameraStatus"),
  countdown: document.querySelector("#countdown"),
  flashOverlay: document.querySelector("#flashOverlay"),
  previewButton: document.querySelector("#previewButton"),
  previewThumbnail: document.querySelector("#previewThumbnail"),
  previewPlaceholder: document.querySelector("#previewPlaceholder"),
  reviewDialog: document.querySelector("#reviewDialog"),
  reviewImage: document.querySelector("#reviewImage"),
  closeReviewButton: document.querySelector("#closeReviewButton"),
  downloadButton: document.querySelector("#downloadButton"),
  shareButton: document.querySelector("#shareButton"),
  privacyButton: document.querySelector("#privacyButton"),
  privacyDialog: document.querySelector("#privacyDialog"),
  closePrivacyButton: document.querySelector("#closePrivacyButton"),
  installButton: document.querySelector("#installButton"),
  toast: document.querySelector("#toast"),
};

const state = {
  stream: null,
  facingMode: "environment",
  isFrontCamera: false,
  timerSeconds: 0,
  ratio: "4:3",
  lastBlob: null,
  lastObjectUrl: null,
  busy: false,
  deferredInstallPrompt: null,
  wakeLock: null,
};

const ratioSequence = ["4:3", "1:1", "16:9"];
const timerSequence = [0, 3, 10];

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    elements.toast.classList.remove("visible");
  }, 2600);
}

function stopCamera() {
  if (!state.stream) return;
  state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  elements.video.srcObject = null;
  elements.shutterButton.disabled = true;
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;

  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    state.wakeLock = null;
  }
}

async function startCamera() {
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

  stopCamera();
  elements.cameraStatus.textContent = "起動中…";
  elements.startButton.disabled = true;

  const preferredConstraints = {
    audio: false,
    video: {
      facingMode: { ideal: state.facingMode },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
    },
  };

  try {
    try {
      state.stream = await navigator.mediaDevices.getUserMedia(preferredConstraints);
    } catch {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    }

    elements.video.srcObject = state.stream;
    await elements.video.play();

    const [track] = state.stream.getVideoTracks();
    const settings = track?.getSettings?.() ?? {};
    const facingMode = settings.facingMode || state.facingMode;
    state.isFrontCamera = facingMode === "user";
    elements.video.classList.toggle("mirrored", state.isFrontCamera);

    const resolution = settings.width && settings.height
      ? `${settings.width}×${settings.height}`
      : state.isFrontCamera ? "前面カメラ" : "背面カメラ";

    elements.cameraStatus.textContent = resolution;
    elements.permissionPanel.hidden = true;
    elements.shutterButton.disabled = false;
    elements.startButton.disabled = false;
    await requestWakeLock();
  } catch (error) {
    console.error(error);
    elements.cameraStatus.textContent = "許可が必要";
    elements.startButton.disabled = false;
    elements.permissionPanel.hidden = false;

    if (error?.name === "NotAllowedError") {
      showToast("ブラウザの設定からカメラを許可してください");
    } else if (error?.name === "NotFoundError") {
      showToast("利用できるカメラが見つかりません");
    } else {
      showToast("カメラを起動できませんでした");
    }
  }
}

async function switchCamera() {
  if (state.busy) return;
  state.facingMode = state.facingMode === "environment" ? "user" : "environment";
  await startCamera();
}

function cycleTimer() {
  const currentIndex = timerSequence.indexOf(state.timerSeconds);
  state.timerSeconds = timerSequence[(currentIndex + 1) % timerSequence.length];
  elements.timerButton.textContent = state.timerSeconds === 0 ? "OFF" : `${state.timerSeconds}s`;
  showToast(state.timerSeconds === 0 ? "タイマーを解除しました" : `${state.timerSeconds}秒タイマー`);
}

function cycleRatio() {
  const currentIndex = ratioSequence.indexOf(state.ratio);
  state.ratio = ratioSequence[(currentIndex + 1) % ratioSequence.length];
  elements.ratioButton.textContent = state.ratio;

  elements.cameraStage.classList.remove("ratio-4-3", "ratio-1-1", "ratio-16-9");
  elements.cameraStage.classList.add(`ratio-${state.ratio.replace(":", "-")}`);
}

function toggleGrid() {
  const nextState = elements.gridOverlay.hidden;
  elements.gridOverlay.hidden = !nextState;
  elements.gridButton.setAttribute("aria-pressed", String(nextState));
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function runCountdown(seconds) {
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    elements.countdown.textContent = String(remaining);
    await wait(1000);
  }
  elements.countdown.textContent = "";
}

function getTargetRatio() {
  switch (state.ratio) {
    case "1:1": return 1;
    case "16:9": return 16 / 9;
    case "4:3":
    default: return 4 / 3;
  }
}

function calculateCrop(sourceWidth, sourceHeight, targetRatio) {
  const sourceRatio = sourceWidth / sourceHeight;

  if (sourceRatio > targetRatio) {
    const width = Math.round(sourceHeight * targetRatio);
    return {
      sx: Math.round((sourceWidth - width) / 2),
      sy: 0,
      sw: width,
      sh: sourceHeight,
    };
  }

  const height = Math.round(sourceWidth / targetRatio);
  return {
    sx: 0,
    sy: Math.round((sourceHeight - height) / 2),
    sw: sourceWidth,
    sh: height,
  };
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("画像を生成できませんでした")),
      "image/jpeg",
      0.95,
    );
  });
}

function flash() {
  elements.flashOverlay.classList.remove("active");
  void elements.flashOverlay.offsetWidth;
  elements.flashOverlay.classList.add("active");
}

function replaceLastImage(blob) {
  if (state.lastObjectUrl) URL.revokeObjectURL(state.lastObjectUrl);

  state.lastBlob = blob;
  state.lastObjectUrl = URL.createObjectURL(blob);
  elements.reviewImage.src = state.lastObjectUrl;
  elements.previewThumbnail.src = state.lastObjectUrl;
  elements.previewThumbnail.hidden = false;
  elements.previewPlaceholder.hidden = true;
  elements.previewButton.disabled = false;
}

async function capturePhoto() {
  if (state.busy || !state.stream || elements.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

  state.busy = true;
  elements.shutterButton.disabled = true;
  elements.switchButton.disabled = true;

  try {
    if (state.timerSeconds > 0) await runCountdown(state.timerSeconds);

    const sourceWidth = elements.video.videoWidth;
    const sourceHeight = elements.video.videoHeight;
    if (!sourceWidth || !sourceHeight) throw new Error("カメラ映像を取得できませんでした");

    const crop = calculateCrop(sourceWidth, sourceHeight, getTargetRatio());
    elements.canvas.width = crop.sw;
    elements.canvas.height = crop.sh;

    const context = elements.canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("画像処理を開始できませんでした");

    context.save();
    if (state.isFrontCamera) {
      context.translate(elements.canvas.width, 0);
      context.scale(-1, 1);
    }

    context.drawImage(
      elements.video,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      0,
      0,
      elements.canvas.width,
      elements.canvas.height,
    );
    context.restore();

    const blob = await canvasToBlob(elements.canvas);
    replaceLastImage(blob);
    flash();
    elements.reviewDialog.showModal();
  } catch (error) {
    console.error(error);
    showToast(error?.message || "撮影に失敗しました");
  } finally {
    state.busy = false;
    elements.shutterButton.disabled = !state.stream;
    elements.switchButton.disabled = false;
    elements.countdown.textContent = "";
  }
}

function createFileName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    "quiet-camera",
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  ].join("_") + ".jpg";
}

function downloadPhoto() {
  if (!state.lastBlob || !state.lastObjectUrl) return;

  const anchor = document.createElement("a");
  anchor.href = state.lastObjectUrl;
  anchor.download = createFileName();
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  showToast("保存を開始しました");
}

async function sharePhoto() {
  if (!state.lastBlob) return;

  const file = new File([state.lastBlob], createFileName(), { type: "image/jpeg" });
  const shareData = { files: [file], title: "Quiet Camera" };

  if (!navigator.share || (navigator.canShare && !navigator.canShare(shareData))) {
    downloadPhoto();
    showToast("共有に非対応のため保存を開始しました");
    return;
  }

  try {
    await navigator.share(shareData);
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.error(error);
      showToast("共有できませんでした");
    }
  }
}

function openLastPhoto() {
  if (state.lastBlob) elements.reviewDialog.showModal();
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

function handleDialogBackdrop(event) {
  if (event.target === event.currentTarget) event.currentTarget.close();
}

async function installApp() {
  if (!state.deferredInstallPrompt) return;
  state.deferredInstallPrompt.prompt();

  try {
    await state.deferredInstallPrompt.userChoice;
  } finally {
    state.deferredInstallPrompt = null;
    elements.installButton.hidden = true;
  }
}

elements.startButton.addEventListener("click", startCamera);
elements.switchButton.addEventListener("click", switchCamera);
elements.timerButton.addEventListener("click", cycleTimer);
elements.ratioButton.addEventListener("click", cycleRatio);
elements.gridButton.addEventListener("click", toggleGrid);
elements.shutterButton.addEventListener("click", capturePhoto);
elements.previewButton.addEventListener("click", openLastPhoto);
elements.closeReviewButton.addEventListener("click", () => closeDialog(elements.reviewDialog));
elements.closePrivacyButton.addEventListener("click", () => closeDialog(elements.privacyDialog));
elements.downloadButton.addEventListener("click", downloadPhoto);
elements.shareButton.addEventListener("click", sharePhoto);
elements.privacyButton.addEventListener("click", () => elements.privacyDialog.showModal());
elements.installButton.addEventListener("click", installApp);
elements.reviewDialog.addEventListener("click", handleDialogBackdrop);
elements.privacyDialog.addEventListener("click", handleDialogBackdrop);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.deferredInstallPrompt = event;
  elements.installButton.hidden = false;
});

window.addEventListener("appinstalled", () => {
  state.deferredInstallPrompt = null;
  elements.installButton.hidden = true;
  showToast("Quiet Cameraをインストールしました");
});

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && state.stream) await requestWakeLock();
});

window.addEventListener("pagehide", () => {
  stopCamera();
  if (state.lastObjectUrl) URL.revokeObjectURL(state.lastObjectUrl);
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.error("Service worker registration failed:", error);
    });
  });
}
