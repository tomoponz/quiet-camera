"use strict";

(() => {
  const dialog = elements.galleryDialog, grid = elements.galleryGrid;
  const entry = document.querySelector("#gallerySelectionButton"), actions = document.querySelector("#gallerySelectionActions");
  const count = document.querySelector("#gallerySelectionCount"), notice = document.querySelector("#gallerySelectionNotice");
  const share = document.querySelector("#shareGalleryButton"), save = document.querySelector("#saveGalleryButton");
  const records = new Map();
  let selecting = false, press = null, suppress = null, operation = null;
  function message(text = "") { notice.textContent = text; notice.title = text; notice.hidden = !text; count.hidden = Boolean(text); }
  // Selected items that newer items pushed out of the loaded list stay selected
  // (and are included in batch actions), so the UI must say so.
  function offListCount() { const loaded = new Set(state.gallery.map(item => item.id)); return [...state.selectedGalleryIds].filter(id => !loaded.has(id)).length; }
  function update() {
    for (const item of state.gallery) records.set(item.id, item);
    const loaded = new Set(state.gallery.map(item => item.id));
    for (const id of records.keys()) if (!loaded.has(id) && !state.selectedGalleryIds.has(id)) records.delete(id);
    if (state.selectedGalleryIds.size) selecting = true;
    dialog.classList.toggle("is-selecting", selecting); actions.hidden = !selecting;
    entry.textContent = selecting ? "完了" : "選択"; entry.setAttribute("aria-label", selecting ? "選択を終了" : "選択モードを開始"); entry.setAttribute("aria-pressed", String(selecting));
    const offList = offListCount();
    entry.disabled = Boolean(operation); count.textContent = `${state.selectedGalleryIds.size}件選択${offList ? `（うち未表示${offList}件）` : ""}`;
    for (const card of grid.children) {
      const selected = state.selectedGalleryIds.has(card.dataset.id), checkbox = card.querySelector("input"), button = card.querySelector(".gallery-open");
      card.dataset.selected = String(selected); if (checkbox) checkbox.checked = selected;
      if (checkbox) checkbox.disabled = Boolean(operation);
      if (selecting) button.setAttribute("aria-pressed", String(selected)); else button.removeAttribute("aria-pressed");
    }
    const chosen = [...state.selectedGalleryIds].map(id => records.get(id));
    const empty = !chosen.length, mixed = chosen.some(item => item?.kind !== "photo" || !item.previewBlob || item.mimeType === "application/pdf");
    share.disabled = save.disabled = elements.deleteSelectedButton.disabled = empty || Boolean(operation);
    elements.selectAllButton.disabled = !selecting || !state.gallery.length || Boolean(operation);
    elements.selectAllButton.setAttribute("aria-hidden", String(!selecting));
    elements.exportPdfButton.disabled = empty || mixed || chosen.length > PDF_MAX_PAGES || Boolean(operation);
    elements.exportPdfButton.title = mixed ? "PDFは画像の写真のみ選択してください（動画・既存PDFは含められません）" : `写真を${PDF_MAX_PAGES}枚までPDFにできます`;
    if (!operation) message(mixed ? "PDFは写真のみ" : chosen.length > PDF_MAX_PAGES ? `PDFは一度に${PDF_MAX_PAGES}枚までです。` : "");
    elements.selectAllButton.setAttribute("aria-label", state.gallery.length && state.gallery.every(item => state.selectedGalleryIds.has(item.id)) ? "表示中の選択を解除" : "表示中をすべて選択");
    elements.selectAllButton.textContent = state.gallery.length && state.gallery.every(item => state.selectedGalleryIds.has(item.id)) ? "表示中を解除" : "表示中を選択";
    elements.selectAllButton.title = "一覧に読み込み済みの項目" + (state.gallery.length && state.gallery.every(item => state.selectedGalleryIds.has(item.id)) ? "の選択を解除" : "をすべて選択");
  }
  function exit() { selecting = false; state.selectedGalleryIds.clear(); records.clear(); message(); update(); }
  function toggle(id) {
    if (operation) return;
    if (state.selectedGalleryIds.has(id)) state.selectedGalleryIds.delete(id); else state.selectedGalleryIds.add(id);
    updateGallerySelectionUi();
  }
  entry.addEventListener("click", () => { if (selecting) exit(); else { selecting = true; update(); } });
  function cancelPress() { if (press) clearTimeout(press.timer); press = null; }
  grid.addEventListener("pointerdown", event => {
    suppress = null;
    cancelPress();
    if (!event.isPrimary || event.button !== 0 || operation || selecting) return;
    const card = event.target.closest(".gallery-card");
    if (!card || !event.target.closest(".gallery-open")) return;
    const start = { id: event.pointerId, x: event.clientX, y: event.clientY, card };
    start.timer = setTimeout(() => {
      if (press !== start || !dialog.open || !card.isConnected) return;
      selecting = true; state.selectedGalleryIds.add(card.dataset.id);
      suppress = { id: card.dataset.id };
      cancelPress(); updateGallerySelectionUi();
    }, 450);
    press = start;
  });
  grid.addEventListener("pointermove", event => { if (press && (event.pointerId !== press.id || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10)) cancelPress(); }, { passive: true });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) grid.addEventListener(name, cancelPress);
  document.addEventListener("pointerdown", event => { if (press && event.pointerId !== press.id) cancelPress(); }, { capture: true, passive: true });
  document.querySelector("#gallerySheetBody").addEventListener("scroll", cancelPress, { passive: true });
  for (const name of ["resize", "orientationchange", "blur"]) window.addEventListener(name, cancelPress);
  // A new deliberate gesture must work immediately, even if the preceding
  // long press produced a context menu without a compatibility click.
  dialog.addEventListener("pointerdown", () => { suppress = null; }, { capture: true, passive: true });
  dialog.addEventListener("keydown", () => { suppress = null; }, { capture: true });
  grid.addEventListener("focusin", event => {
    const button = event.target.closest(".gallery-open");
    if (!button?.matches(":focus-visible")) return;
    requestAnimationFrame(() => {
      if (!dialog.open || document.activeElement !== button) return;
      const body = document.querySelector("#gallerySheetBody"), view = body.getBoundingClientRect();
      const top = view.top + 4, bottom = Math.min(view.bottom, selecting ? actions.getBoundingClientRect().top : view.bottom) - 4;
      // At large text sizes a complete card may be taller than the viewport.
      // Keep its metadata visible rather than centering only the photograph.
      const target = button.getBoundingClientRect().height > bottom - top
        ? button.querySelector(".gallery-info")?.lastElementChild || button : button;
      const box = target.getBoundingClientRect();
      if (box.bottom > bottom) body.scrollTop += box.bottom - bottom;
      else if (box.top < top) body.scrollTop += box.top - top;
    });
  });
  dialog.addEventListener("contextmenu", event => { if (event.target.closest(".gallery-open")) event.preventDefault(); });
  // Protect against a compatibility click being retargeted under
  // the still-held finger. Suppress that gesture's compatibility click across
  // the entire dialog, including a newly exposed destructive/action button.
  dialog.addEventListener("click", event => {
    if (suppress) {
      suppress = null; event.preventDefault(); event.stopImmediatePropagation();
    }
  }, { capture: true });
  grid.addEventListener("click", event => {
    const card = event.target.closest(".gallery-card"), button = event.target.closest(".gallery-open");
    if (!card) return;
    suppress = null;
    if (!button) return;
    if (selecting || operation) { event.preventDefault(); event.stopImmediatePropagation(); toggle(card.dataset.id); }
  }, { capture: true });
  // Escape / Android Back first leaves selection mode; the next one closes history.
  // An uncancelable cancel (no user activation since the last one) still closes.
  dialog.addEventListener("cancel", event => {
    if (!selecting || operation || !event.cancelable) return;
    event.preventDefault();
    cancelPress(); suppress = null; exit();
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    cancelPress(); suppress = null; operation?.abort(); operation = null; exit();
  });
  async function selectedRecords(signal) {
    // Never act on items that are not in the list (defensive; refresh keeps the loaded window).
    const listed = new Set(state.gallery.map(item => item.id)), offList = [...state.selectedGalleryIds].filter(id => !listed.has(id));
    if (offList.length) {
      offList.forEach(id => { state.selectedGalleryIds.delete(id); records.delete(id); }); update();
      throw new Error(`一覧に表示されていない${offList.length}件の選択を解除しました。選択内容を確認して、もう一度操作してください`);
    }
    const ids = [...state.selectedGalleryIds], result = await Promise.all(ids.map(getStoredMedia));
    signal?.throwIfAborted();
    // A serialized refresh can finish while IndexedDB reads are pending. Check
    // the current visible selection again immediately before external actions.
    const currentListed = new Set(state.gallery.map(item => item.id));
    const changed = ids.filter(id => !currentListed.has(id) || !state.selectedGalleryIds.has(id));
    if (changed.length) {
      changed.forEach(id => { state.selectedGalleryIds.delete(id); records.delete(id); });
      update();
      throw new Error("一覧または選択内容が変わりました。選択を確認して、もう一度操作してください");
    }
    const missing = ids.filter((_, i) => !result[i]);
    if (missing.length) {
      missing.forEach(id => { state.selectedGalleryIds.delete(id); records.delete(id); });
      await refreshGallery(); update();
      throw new Error("選択した項目が履歴から削除されています。選択内容を確認して、もう一度操作してください");
    }
    return result.sort((a,b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
  }
  async function run(task) {
    if (operation || !state.selectedGalleryIds.size) return;
    // Action buttons are disabled while the operation runs, which drops a keyboard user's focus to <body>.
    const trigger = document.activeElement;
    const controller = new AbortController(); operation = controller; update(); message("処理中…");
    try { await task(await selectedRecords(controller.signal), controller.signal); }
    catch (error) { if (error?.name !== "AbortError" && operation === controller) { console.error(error); const text = error?.name === "QuotaExceededError" ? "空き容量が不足しているため保存できませんでした。選択内容は残っています" : error.message || "処理できませんでした"; message(text); showToast(text); } }
    finally { if (operation === controller) { operation = null; const text = notice.textContent; update(); if (text && text !== "処理中…") message(text);
      if (dialog.open && !dialog.contains(document.activeElement)) (trigger && dialog.contains(trigger) && !trigger.disabled && !trigger.closest("[hidden]") ? trigger : entry).focus({ preventScroll: true }); } }
  }
  function files(items) { return items.map(item => new File([item.blob], createFileName(item), { type: item.mimeType || item.blob.type })); }
  share.addEventListener("click", () => run(async (items, signal) => {
    const data = { files: files(items), title: "Quiet Camera" };
    if (!navigator.share || !navigator.canShare?.(data)) throw new Error("このブラウザは選択ファイルの共有に対応していません。「端末に保存」を使用してください");
    if (navigator.userActivation && !navigator.userActivation.isActive) throw new Error("共有の準備ができました。もう一度「共有」を押してください");
    try { await navigator.share(data); if (!signal.aborted) message("共有シートへ渡しました"); }
    catch (error) { if (error?.name === "AbortError") { if (!signal.aborted) message("共有をキャンセルしました"); } else throw new Error("共有できませんでした。選択内容は残っています"); }
  }));
  save.addEventListener("click", () => run(async (items, signal) => {
    const output = files(items);
    const blob = output.length === 1 ? output[0] : await QuietCameraGalleryBatch.zip(output, { signal });
    signal.throwIfAborted();
    triggerDownload(blob, output.length === 1 ? output[0].name : "quiet-camera-selected.zip");
    message(output.length === 1 ? "保存を開始しました。端末のダウンロードを確認してください" : `${items.length}件をZIPにまとめて保存を開始しました。端末のダウンロードを確認してください`);
  }));
  async function deleteSelected() {
    const offList = offListCount();
    if (operation || !state.selectedGalleryIds.size) return;
    if (offList) return run(async () => {}); // validation explains the changed selection before confirmation
    if (!confirm(`${state.selectedGalleryIds.size}件の撮影結果を端末内の履歴から削除しますか？`)) return;
    return run(async (items, signal) => {
      await deleteStoredMediaBatch(items.map(item => item.id));
      if (signal.aborted) return; // A committed delete cannot be canceled; do not alter a newly reopened selection.
      state.selectedGalleryIds.clear(); await refreshGallery(); // renders the open list once, keeping its position
      message(`${items.length}件を削除しました`); showToast(`${items.length}件を削除しました`);
    });
  }
  async function exportPdf() {
    return run(async (items, signal) => {
      if (items.some(item => item.kind !== "photo" || !item.previewBlob || item.mimeType === "application/pdf")) throw new Error("PDFは画像の写真のみ選択してください（動画・既存PDFは含められません）");
      if (items.length > PDF_MAX_PAGES) throw new Error(`PDFは一度に${PDF_MAX_PAGES}枚までです`);
      const pages = [];
      for (const photo of items) { pages.push(await blobToJpegPage(photo.previewBlob)); signal.throwIfAborted(); }
      const blob = await jpegPagesToPdf(pages); signal.throwIfAborted();
      await addMedia({ kind: "photo", origin: "pdf-export", blob, previewBlob: items[0].previewBlob, thumbnailBlob: items[0].thumbnailBlob || null, extension: "pdf", mimeType: "application/pdf", width: pages[0].width, height: pages[0].height, meta: `PDF · ${items.length}ページ · ${formatBytes(blob.size)}` }, { showReview: false });
      if (signal.aborted) return;
      state.selectedGalleryIds.clear(); update(); // addMedia already refreshed and rendered the open list
      message(`${items.length}ページのPDFを履歴に作成しました`); showToast(`${items.length}ページのPDFを作成しました`);
    });
  }
  function announce(text) { if (!operation) message(text); showToast(text); }
  window.QuietCameraGallery = { update, deleteSelected, exportPdf, notice: announce };
  update();
})();
