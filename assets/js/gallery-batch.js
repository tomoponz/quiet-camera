"use strict";

// ZIP stored entries, CRC32 and UTF-8 names (PKWARE APPNOTE 6.3.10).
// Blob streams bound the CRC working buffer; media bytes are never re-encoded.
const QuietCameraGalleryBatch = (() => {
  const table = Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  async function crc32(blob, signal) {
    let crc = 0xffffffff;
    const reader = blob.stream().getReader();
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        for (const b of value) crc = table[(crc ^ b) & 255] ^ (crc >>> 8);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function header(size, signature) {
    const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    view.setUint32(0, signature, true);
    return { bytes, u16: (at, n) => view.setUint16(at, n, true), u32: (at, n) => view.setUint32(at, n, true) };
  }
  async function zip(files, { signal } = {}) {
    if (!files.length) throw new Error("保存するファイルを選択してください");
    if (files.length >= 65535) throw new Error("一度に保存するファイル数が多すぎます");
    const encoder = new TextEncoder(), parts = [], directory = [];
    let offset = 0, directorySize = 0;
    for (const [index, file] of files.entries()) {
      signal?.throwIfAborted();
      const name = encoder.encode(`${String(index + 1).padStart(3, "0")}_${file.name.replace(/[\\/\x00-\x1f]/g, "_")}`);
      if (name.length > 65535 || file.size >= 0xffffffff || offset + file.size + 30 + name.length >= 0xffffffff) throw new Error("4GB以上の一括保存には対応していません。選択を分けてください");
      const crc = await crc32(file, signal);
      const local = header(30, 0x04034b50);
      local.u16(4, 20); local.u16(6, 0x800); local.u16(12, 33); // 1980-01-01, no private clock metadata
      local.u32(14, crc); local.u32(18, file.size); local.u32(22, file.size); local.u16(26, name.length);
      const central = header(46, 0x02014b50);
      central.u16(4, 20); central.u16(6, 20); central.u16(8, 0x800); central.u16(14, 33);
      central.u32(16, crc); central.u32(20, file.size); central.u32(24, file.size); central.u16(28, name.length); central.u32(42, offset);
      parts.push(local.bytes, name, file); directory.push(central.bytes, name);
      offset += 30 + name.length + file.size; directorySize += 46 + name.length;
    }
    if (offset + directorySize + 22 >= 0xffffffff) throw new Error("4GB以上の一括保存には対応していません。選択を分けてください");
    const end = header(22, 0x06054b50);
    end.u16(8, files.length); end.u16(10, files.length); end.u32(12, directorySize); end.u32(16, offset);
    return new Blob([...parts, ...directory, end.bytes], { type: "application/zip" });
  }
  return { zip, crc32 };
})();
if (typeof module !== "undefined" && module.exports) module.exports = QuietCameraGalleryBatch;
if (typeof window !== "undefined") window.QuietCameraGalleryBatch = QuietCameraGalleryBatch;

async function deleteStoredMediaBatch(ids) {
  await deleteStoredMediaRecords(ids,{requireAll:true});
}
