"use strict";

const PHOTO_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("画像を生成できませんでした")), type, quality);
  });
}

async function drawPhotoSourceToCanvas() {
  const canvas = elements.captureCanvas;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("画像処理を開始できませんでした");

  let source = elements.cameraVideo;
  let sourceWidth = elements.cameraVideo.videoWidth;
  let sourceHeight = elements.cameraVideo.videoHeight;
  let bitmap = null;

  if (elements.highResolutionSelect.value === "on" && state.imageCapture?.takePhoto) {
    try {
      const blob = await state.imageCapture.takePhoto();
      bitmap = await createImageBitmap(blob);
      source = bitmap;
      sourceWidth = bitmap.width;
      sourceHeight = bitmap.height;
    } catch (error) {
      console.warn("High-resolution photo capture failed; using video frame", error);
    }
  }

  if (!sourceWidth || !sourceHeight) throw new Error("カメラ映像を取得できませんでした");
  const crop = QuietUtils.calculateCrop(sourceWidth, sourceHeight, getTargetRatio());
  canvas.width = crop.sw;
  canvas.height = crop.sh;
  context.save();
  const mirror = state.isFrontCamera && elements.mirrorSelect.value === "mirror";
  if (mirror) {
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
  context.restore();
  bitmap?.close?.();
  return { width: canvas.width, height: canvas.height };
}

async function capturePhoto() {
  if (state.busy || !state.stream || elements.cameraVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  state.busy = true;
  elements.shutterButton.disabled = true;
  setControlsDisabled(true);

  try {
    if (state.timerSeconds > 0) await runCountdown(state.timerSeconds);
    const dimensions = await drawPhotoSourceToCanvas();
    const requestedType = elements.photoFormatSelect.value;
    const quality = Number(elements.photoQualitySelect.value);
    let blob;
    let previewBlob;
    let typeLabel;

    if (requestedType === "application/pdf") {
      previewBlob = await canvasToBlob(elements.captureCanvas, "image/jpeg", quality);
      blob = await QuietUtils.buildMultiPagePdf([{ blob: previewBlob, ...dimensions }]);
      typeLabel = "PDF";
    } else {
      blob = await canvasToBlob(elements.captureCanvas, requestedType, quality);
      previewBlob = blob;
      typeLabel = blob.type === "image/png" ? "PNG" : blob.type === "image/webp" ? "WebP" : "JPEG";
    }

    const media = {
      id: QuietUtils.randomId(),
      kind: "photo",
      blob,
      previewBlob,
      extension: PHOTO_EXTENSIONS[blob.type] || PHOTO_EXTENSIONS[requestedType] || "jpg",
      mimeType: blob.type || requestedType,
      createdAt: Date.now(),
      width: dimensions.width,
      height: dimensions.height,
      durationMs: 0,
      meta: `${typeLabel} · ${dimensions.width}×${dimensions.height} · ${QuietUtils.formatBytes(blob.size)}`,
    };

    await QuietStorage.saveMedia(media);
    await addMediaToGallery(media, { prepend: true });
    flash();
    await presentCapturedMedia(media);
  } catch (error) {
    console.error(error);
    showToast(error?.message || "撮影に失敗しました");
  } finally {
    state.busy = false;
    elements.shutterButton.disabled = !state.stream;
    setControlsDisabled(false);
    elements.countdown.textContent = "";
  }
}
