"use strict";

(() => {
  const Q = window.QuietCameraEnhancements;

  function getVisibleTargetRatio() {
    const rect = elements.video.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect.width / rect.height : getTargetRatio();
  }

  async function getWysiwygPhotoSource() {
    const previewWidth = elements.video.videoWidth;
    const previewHeight = elements.video.videoHeight;
    const previewRatio = previewWidth / previewHeight;

    if (typeof ImageCapture !== "undefined" && state.videoTrack) {
      try {
        const imageCapture = new ImageCapture(state.videoTrack);
        const blob = await imageCapture.takePhoto();
        const bitmap = await createImageBitmap(blob);
        const sourceRatio = bitmap.width / bitmap.height;
        if (Math.abs(sourceRatio - previewRatio) / previewRatio <= 0.025) {
          return { source: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close?.(), highQuality: true };
        }
        bitmap.close?.();
      } catch (error) {
        console.warn("High-resolution still did not match the preview; using the visible frame.", error);
      }
    }
    return { source: elements.video, width: previewWidth, height: previewHeight, dispose: () => {}, highQuality: false };
  }

  Q.enhancedCapturePhoto = async () => {
    if (state.busy || !state.stream || elements.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    state.busy = true;
    elements.shutterButton.disabled = true;
    setControlsDisabled(true);
    let photoSource = null;

    try {
      if (state.timerSeconds > 0) await runCountdown(state.timerSeconds);
      photoSource = await getWysiwygPhotoSource();
      if (!photoSource.width || !photoSource.height) throw new Error("カメラ映像を取得できませんでした");

      const crop = calculateCrop(photoSource.width, photoSource.height, getVisibleTargetRatio());
      elements.canvas.width = crop.sw;
      elements.canvas.height = crop.sh;
      const context = elements.canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("画像処理を開始できませんでした");

      const mirror = state.isFrontCamera && elements.selfieMirrorSelect.value === "mirrored";
      context.save();
      if (mirror) {
        context.translate(elements.canvas.width, 0);
        context.scale(-1, 1);
      }
      context.drawImage(photoSource.source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, elements.canvas.width, elements.canvas.height);
      context.restore();

      const requestedType = elements.photoFormatSelect.value;
      const quality = Number(elements.photoQualitySelect.value);
      let exportBlob;
      let previewBlob;
      let typeLabel;
      if (requestedType === "application/pdf") {
        previewBlob = await canvasToBlob(elements.canvas, "image/jpeg", quality);
        exportBlob = await jpegPagesToPdf([{ blob: previewBlob, width: elements.canvas.width, height: elements.canvas.height }]);
        typeLabel = "PDF";
      } else {
        exportBlob = await canvasToBlob(elements.canvas, requestedType, quality);
        previewBlob = exportBlob;
        typeLabel = exportBlob.type === "image/png" ? "PNG" : exportBlob.type === "image/webp" ? "WebP" : "JPEG";
      }

      await addMedia({
        kind: "photo",
        blob: exportBlob,
        previewBlob,
        extension: PHOTO_EXTENSIONS[exportBlob.type] || PHOTO_EXTENSIONS[requestedType] || "jpg",
        mimeType: exportBlob.type,
        width: elements.canvas.width,
        height: elements.canvas.height,
        meta: `${typeLabel} · ${elements.canvas.width}×${elements.canvas.height} · ${formatBytes(exportBlob.size)} · 画面表示に合わせて保存${photoSource.highQuality ? " · 高解像度" : ""}`,
      });
      flash();
    } catch (error) {
      console.error(error);
      showToast(error?.message || "撮影に失敗しました");
    } finally {
      photoSource?.dispose?.();
      state.busy = false;
      elements.shutterButton.disabled = !state.stream;
      setControlsDisabled(false);
      elements.countdown.textContent = "";
    }
  };
  Q.getVisibleTargetRatio = getVisibleTargetRatio;
})();
