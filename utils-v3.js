"use strict";

const QuietUtils = (() => {
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value)));
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** index);
    return `${value.toFixed(index === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`;
  }

  function formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function randomId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0,4).join("")}-${hex.slice(4,6).join("")}-${hex.slice(6,8).join("")}-${hex.slice(8,10).join("")}-${hex.slice(10).join("")}`;
  }

  function createTimestampName(prefix, extension, date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
      prefix,
      `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
      `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    ].join("_") + `.${extension}`;
  }

  function calculateCrop(sourceWidth, sourceHeight, targetRatio) {
    const sourceRatio = sourceWidth / sourceHeight;
    if (sourceRatio > targetRatio) {
      const width = Math.round(sourceHeight * targetRatio);
      return { sx: Math.round((sourceWidth - width) / 2), sy: 0, sw: width, sh: sourceHeight };
    }
    const height = Math.round(sourceWidth / targetRatio);
    return { sx: 0, sy: Math.round((sourceHeight - height) / 2), sw: sourceWidth, sh: height };
  }

  function mapCoverPoint({ clientX, clientY, rect, sourceWidth, sourceHeight, mirrored = false }) {
    if (!rect?.width || !rect?.height || !sourceWidth || !sourceHeight) return null;
    const localX = clamp(clientX - rect.left, 0, rect.width);
    const localY = clamp(clientY - rect.top, 0, rect.height);
    const scale = Math.max(rect.width / sourceWidth, rect.height / sourceHeight);
    const renderedWidth = sourceWidth * scale;
    const renderedHeight = sourceHeight * scale;
    const cropX = (renderedWidth - rect.width) / 2;
    const cropY = (renderedHeight - rect.height) / 2;
    let sourceX = (localX + cropX) / scale;
    const sourceY = (localY + cropY) / scale;
    if (mirrored) sourceX = sourceWidth - sourceX;
    return {
      pixel: {
        x: clamp(Math.round(sourceX), 0, Math.max(0, sourceWidth - 1)),
        y: clamp(Math.round(sourceY), 0, Math.max(0, sourceHeight - 1)),
      },
      normalized: {
        x: clamp(sourceX / sourceWidth, 0, 1),
        y: clamp(sourceY / sourceHeight, 0, 1),
      },
    };
  }

  function concatUint8Arrays(arrays) {
    const total = arrays.reduce((sum, array) => sum + array.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    arrays.forEach((array) => {
      result.set(array, offset);
      offset += array.length;
    });
    return result;
  }

  async function imageBlobToJpeg(blob, quality = 0.9) {
    if (blob.type === "image/jpeg") return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return new Promise((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error("JPEG変換に失敗しました")), "image/jpeg", quality);
    });
  }

  async function buildMultiPagePdf(pages) {
    if (!pages.length) throw new Error("PDFにする画像がありません");
    const encoder = new TextEncoder();
    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const normalized = [];

    for (const page of pages) {
      const jpegBlob = await imageBlobToJpeg(page.blob, 0.9);
      const bytes = new Uint8Array(await jpegBlob.arrayBuffer());
      normalized.push({ bytes, width: page.width, height: page.height });
    }

    const objects = [];
    const pageRefs = [];
    objects.push(null);
    objects.push(null);

    normalized.forEach((page) => {
      const pageObjectNumber = objects.length + 1;
      const contentObjectNumber = pageObjectNumber + 1;
      const imageObjectNumber = pageObjectNumber + 2;
      pageRefs.push(`${pageObjectNumber} 0 R`);

      const scale = Math.min(pageWidth / page.width, pageHeight / page.height);
      const drawWidth = page.width * scale;
      const drawHeight = page.height * scale;
      const x = (pageWidth - drawWidth) / 2;
      const y = (pageHeight - drawHeight) / 2;
      const content = `q\n${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im0 Do\nQ\n`;
      const contentBytes = encoder.encode(content);

      objects.push(encoder.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] /Resources << /XObject << /Im0 ${imageObjectNumber} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`));
      objects.push(concatUint8Arrays([
        encoder.encode(`<< /Length ${contentBytes.length} >>\nstream\n`),
        contentBytes,
        encoder.encode("endstream"),
      ]));
      objects.push(concatUint8Arrays([
        encoder.encode(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`),
        page.bytes,
        encoder.encode("\nendstream"),
      ]));
    });

    objects[0] = encoder.encode("<< /Type /Catalog /Pages 2 0 R >>");
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
    for (let index = 1; index <= objects.length; index += 1) {
      xref += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF`;
    chunks.push(encoder.encode(xref));
    return new Blob(chunks, { type: "application/pdf" });
  }

  return {
    clamp,
    formatBytes,
    formatDuration,
    randomId,
    createTimestampName,
    calculateCrop,
    mapCoverPoint,
    buildMultiPagePdf,
  };
})();

if (typeof module !== "undefined") module.exports = QuietUtils;
