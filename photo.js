async function jpegBlobToPdf(jpegBlob, width, height) {
  const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const scale = Math.min(pageWidth / width, pageHeight / height);
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  const x = (pageWidth - drawWidth) / 2;
  const y = (pageHeight - drawHeight) / 2;
  const content = `q\n${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im0 Do\nQ\n`;
  const encoder = new TextEncoder();
  const objects = [
    encoder.encode("<< /Type /Catalog /Pages 2 0 R >>"),
    encoder.encode("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    encoder.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`),
    encoder.encode(`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`),
    null,
  ];

  const imageHeader = encoder.encode(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  const imageFooter = encoder.encode("\nendstream");
  const imageObject = new Uint8Array(imageHeader.length + jpegBytes.length + imageFooter.length);
  imageObject.set(imageHeader, 0);
  imageObject.set(jpegBytes, imageHeader.length);
  imageObject.set(imageFooter, imageHeader.length + jpegBytes.length);
  objects[4] = imageObject;

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
  for (let index = 1; index <= objects.length; index += 1) {
    xref += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF`;
  chunks.push(encoder.encode(xref));
  return new Blob(chunks, { type: "application/pdf" });
}

function replaceLastMedia(media) {
  clearLastMedia();
  state.lastMedia = media;
  state.lastObjectUrl = URL.createObjectURL(media.blob);

  if (media.kind === "photo") {
    state.lastPreviewUrl = media.previewBlob === media.blob
      ? state.lastObjectUrl
      : URL.createObjectURL(media.previewBlob);
    elements.reviewImage.src = state.lastPreviewUrl;
    elements.reviewImage.hidden = false;
    elements.reviewVideo.hidden = true;
    elements.reviewVideo.removeAttribute("src");
    elements.previewThumbnail.src = state.lastPreviewUrl;
    elements.previewThumbnail.hidden = false;
    elements.videoThumbnailMark.hidden = true;
    elements.reviewTitle.textContent = "写真";
  } else {
    elements.reviewVideo.src = state.lastObjectUrl;
    elements.reviewVideo.hidden = false;
    elements.reviewImage.hidden = true;
    elements.reviewImage.removeAttribute("src");
    elements.previewThumbnail.hidden = true;
    elements.videoThumbnailMark.hidden = false;
    elements.reviewTitle.textContent = "動画";
  }

  elements.previewPlaceholder.hidden = true;
  elements.previewButton.disabled = false;
  elements.reviewMeta.textContent = media.meta;
}

function clearLastMedia() {
  if (state.lastObjectUrl) URL.revokeObjectURL(state.lastObjectUrl);
  if (state.lastPreviewUrl && state.lastPreviewUrl !== state.lastObjectUrl) URL.revokeObjectURL(state.lastPreviewUrl);
  state.lastMedia = null;
  state.lastObjectUrl = null;
  state.lastPreviewUrl = null;
  elements.reviewImage.removeAttribute("src");
  elements.reviewVideo.pause();
  elements.reviewVideo.removeAttribute("src");
  elements.previewThumbnail.removeAttribute("src");
  elements.previewThumbnail.hidden = true;
  elements.videoThumbnailMark.hidden = true;
  elements.previewPlaceholder.hidden = false;
  elements.previewButton.disabled = true;
}

async function capturePhoto() {
  if (state.busy || !state.stream || elements.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  state.busy = true;
  elements.shutterButton.disabled = true;
  setControlsDisabled(true);

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
    context.drawImage(elements.video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, elements.canvas.width, elements.canvas.height);
    context.restore();

    const requestedType = elements.photoFormatSelect.value;
    const quality = Number(elements.photoQualitySelect.value);
    let exportBlob;
    let previewBlob;
    let typeLabel;

    if (requestedType === "application/pdf") {
      previewBlob = await canvasToBlob(elements.canvas, "image/jpeg", quality);
      exportBlob = await jpegBlobToPdf(previewBlob, elements.canvas.width, elements.canvas.height);
      typeLabel = "PDF";
    } else {
      exportBlob = await canvasToBlob(elements.canvas, requestedType, quality);
      previewBlob = exportBlob;
      typeLabel = exportBlob.type === "image/png" ? "PNG" : exportBlob.type === "image/webp" ? "WebP" : "JPEG";
    }

    replaceLastMedia({
      kind: "photo",
      blob: exportBlob,
      previewBlob,
      extension: PHOTO_EXTENSIONS[exportBlob.type] || PHOTO_EXTENSIONS[requestedType] || "jpg",
      mimeType: exportBlob.type,
      meta: `${typeLabel} · ${elements.canvas.width}×${elements.canvas.height} · ${formatBytes(exportBlob.size)}`,
    });
    flash();
    elements.reviewDialog.showModal();
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
