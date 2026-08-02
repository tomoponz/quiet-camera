"use strict";

async function jpegPagesToPdf(pages) {
  if (!pages.length) throw new Error("PDFにする写真がありません");
  const encoder = new TextEncoder();
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const objects = [encoder.encode("<< /Type /Catalog /Pages 2 0 R >>"), null];
  const pageRefs = [];

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const jpegBytes = new Uint8Array(await page.blob.arrayBuffer());
    const scale = Math.min(pageWidth / page.width, pageHeight / page.height);
    const drawWidth = page.width * scale;
    const drawHeight = page.height * scale;
    const x = (pageWidth - drawWidth) / 2;
    const y = (pageHeight - drawHeight) / 2;
    const content = `q\n${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im${index} Do\nQ\n`;
    const pageObjectNumber = objects.length + 1;
    const contentObjectNumber = pageObjectNumber + 1;
    const imageObjectNumber = pageObjectNumber + 2;
    pageRefs.push(`${pageObjectNumber} 0 R`);
    objects.push(encoder.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] /Resources << /XObject << /Im${index} ${imageObjectNumber} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`));
    objects.push(encoder.encode(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`));
    const imageHeader = encoder.encode(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
    const imageFooter = encoder.encode("\nendstream");
    const imageObject = new Uint8Array(imageHeader.length + jpegBytes.length + imageFooter.length);
    imageObject.set(imageHeader, 0);
    imageObject.set(jpegBytes, imageHeader.length);
    imageObject.set(imageFooter, imageHeader.length + jpegBytes.length);
    objects.push(imageObject);
  }

  objects[1] = encoder.encode(`<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pageRefs.length} >>`);
  const header = encoder.encode("%PDF-1.4\n%Quiet Camera\n");
  const chunks = [header];
  const offsets = [0];
  let position = header.length;
  objects.forEach((objectBytes, index) => {
    offsets.push(position);
    const prefix = encoder.encode(`${index + 1} 0 obj\n`);
    const suffix = encoder.encode("\nendobj\n");
    chunks.push(prefix, objectBytes, suffix);
    position += prefix.length + objectBytes.length + suffix.length;
  });
  const xrefPosition = position;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) xref += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF`;
  chunks.push(encoder.encode(xref));
  return new Blob(chunks, { type: "application/pdf" });
}

async function blobToJpegPage(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { alpha: false });
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const jpeg = await canvasToBlob(canvas, "image/jpeg", 0.92);
  return { blob: jpeg, width: canvas.width, height: canvas.height };
}

function releaseSelectedMediaUrls() {
  if (state.selectedObjectUrl) URL.revokeObjectURL(state.selectedObjectUrl);
  if (state.selectedPreviewUrl && state.selectedPreviewUrl !== state.selectedObjectUrl) URL.revokeObjectURL(state.selectedPreviewUrl);
  state.selectedObjectUrl = null;
  state.selectedPreviewUrl = null;
}

function selectMedia(media) {
  releaseSelectedMediaUrls();
  state.selectedMedia = media;
  state.selectedObjectUrl = URL.createObjectURL(media.blob);
  if (media.kind === "photo") {
    const previewBlob = media.previewBlob || media.blob;
    state.selectedPreviewUrl = previewBlob === media.blob ? state.selectedObjectUrl : URL.createObjectURL(previewBlob);
    elements.reviewImage.src = state.selectedPreviewUrl;
    elements.reviewImage.hidden = false;
    elements.reviewVideo.pause();
    elements.reviewVideo.hidden = true;
    elements.reviewVideo.removeAttribute("src");
    elements.reviewTitle.textContent = "写真";
  } else {
    elements.reviewVideo.src = state.selectedObjectUrl;
    elements.reviewVideo.hidden = false;
    elements.reviewImage.hidden = true;
    elements.reviewImage.removeAttribute("src");
    elements.reviewTitle.textContent = "動画";
  }
  elements.reviewMeta.textContent = media.meta;
}

function clearSelectedMedia() {
  releaseSelectedMediaUrls();
  state.selectedMedia = null;
  elements.reviewImage.removeAttribute("src");
  elements.reviewVideo.pause();
  elements.reviewVideo.removeAttribute("src");
}

async function addMedia(media, { showReview = true } = {}) {
  const stored = { ...media, id: media.id || makeId(media.kind), createdAt: media.createdAt || Date.now() };
  await putMedia(stored);
  await refreshGallery();
  selectMedia(stored);
  if (!showReview) return stored;
  const behavior = elements.autoReviewSelect.value;
  if (behavior === "never") return stored;
  elements.reviewDialog.showModal();
  if (behavior === "brief") {
    window.clearTimeout(state.briefReviewTimer);
    state.briefReviewTimer = window.setTimeout(() => {
      if (elements.reviewDialog.open) elements.reviewDialog.close();
    }, 2000);
  }
  return stored;
}

async function getHighQualityPhotoSource() {
  if (typeof ImageCapture !== "undefined" && state.videoTrack) {
    try {
      const imageCapture = new ImageCapture(state.videoTrack);
      const blob = await imageCapture.takePhoto();
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close?.(), highQuality: true };
    } catch (error) {
      console.warn("ImageCapture.takePhoto failed; using preview frame.", error);
    }
  }
  return { source: elements.video, width: elements.video.videoWidth, height: elements.video.videoHeight, dispose: () => {}, highQuality: false };
}

async function capturePhoto() {
  if (state.busy || !state.stream || elements.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  state.busy = true;
  elements.shutterButton.disabled = true;
  setControlsDisabled(true);
  let photoSource = null;
  try {
    if (state.timerSeconds > 0) await runCountdown(state.timerSeconds);
    photoSource = await getHighQualityPhotoSource();
    if (!photoSource.width || !photoSource.height) throw new Error("カメラ映像を取得できませんでした");
    const crop = calculateCrop(photoSource.width, photoSource.height, getTargetRatio());
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
      meta: `${typeLabel} · ${elements.canvas.width}×${elements.canvas.height} · ${formatBytes(exportBlob.size)}${photoSource.highQuality ? " · 高解像度撮影" : ""}`,
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
}
