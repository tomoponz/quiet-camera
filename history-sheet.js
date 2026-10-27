"use strict";

// History uses the same tested handle kinetics as Settings, with its own extent.
(() => {
  const root = document.documentElement;
  const dialog = document.querySelector("#galleryDialog");
  const body = document.querySelector("#gallerySheetBody");
  const handle = document.querySelector("#galleryResizeHandle");
  const sizing = document.querySelector(".gallery-sheet-sizing");
  const header = dialog.querySelector(".dialog-header");
  let preferredFraction = 1;
  let drag = null;
  let layoutFrame = 0;
  let motion = null;
  let sheetOffset = 0;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const gestureModel = window.QuietCameraSheetMotion;

  function viewport() {
    return {
      top: window.visualViewport?.offsetTop || 0,
      height: window.visualViewport?.height || window.innerHeight,
    };
  }

  function sheetBounds() {
    const view = viewport();
    const rootStyle = getComputedStyle(root);
    const safeTop = Math.max(8, parseFloat(rootStyle.getPropertyValue("--layout-safe-top")) || 0);
    const safeBottom = Math.max(8, parseFloat(rootStyle.getPropertyValue("--layout-safe-bottom")) || 0);
    const available = Math.max(0, Math.floor(view.height - safeTop));
    const chromeHeight = dialog.getBoundingClientRect().height - body.getBoundingClientRect().height;
    // Keep the header, handle and at least one touch-sized settings row.
    const rowHeight = 44 + document.querySelector("#galleryActionClearance").getBoundingClientRect().height;
    const min = Math.min(available, Math.ceil(Math.max(160, chromeHeight + rowHeight)));
    // Cover bottom safe area with panel background and allow full expansion.
    const max = available;
    return { min, max, available, safeBottom, ...view };
  }

  function updateSheetHeight() {
    if (!dialog.open) return;
    const bounds = sheetBounds();
    const height = Math.min(bounds.max, Math.max(bounds.min, Math.round(preferredFraction * bounds.available)));
    dialog.style.setProperty("--gallery-sheet-bottom", `${Math.max(0, window.innerHeight - bounds.top - bounds.height)}px`);
    dialog.style.setProperty("--gallery-sheet-max-height", `${bounds.max}px`);
    dialog.style.setProperty("--gallery-sheet-height", `${height}px`);
    handle.setAttribute("aria-valuemin", String(Math.ceil(bounds.min)));
    handle.setAttribute("aria-valuemax", String(Math.floor(bounds.max)));
    handle.setAttribute("aria-valuenow", String(Math.round(height)));
    handle.setAttribute("aria-valuetext", `${Math.round(height)}ピクセル、画面の${Math.round(height / bounds.height * 100)}パーセント`);
  }

  function updateLayout() {
    layoutFrame = 0;
    updateSheetHeight();
  }

  function scheduleLayout() {
    if (!layoutFrame) layoutFrame = requestAnimationFrame(updateLayout);
  }

  function setOffset(offset) {
    sheetOffset = offset;
    dialog.style.setProperty("--gallery-sheet-offset", `${offset}px`);
  }

  function visualPosition() {
    const transform = getComputedStyle(dialog).transform;
    return {
      height: dialog.getBoundingClientRect().height,
      offset: transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42,
    };
  }

  function stopMotion() {
    const previous = motion;
    motion = null;
    previous?.cancel();
    dialog.classList.remove("is-settling");
    delete dialog.dataset.sheetState;
  }

  function settleTo(height, { closing = false, velocity = 0, animate = true } = {}) {
    const from = visualPosition();
    stopMotion();
    const bounds = sheetBounds();
    const targetHeight = Math.min(bounds.max, Math.max(bounds.min, height));
    const targetOffset = closing ? Math.max(from.height + 24, from.offset + 24) : 0;
    preferredFraction = targetHeight / Math.max(1, bounds.available);
    setOffset(targetOffset);
    updateSheetHeight();
    const distance = Math.max(Math.abs(from.height - targetHeight), Math.abs(from.offset - targetOffset));
    const finish = () => {
      if (closing && dialog.open) elements.closeGalleryButton.click();
      setOffset(0);
    };
    if (!animate || reducedMotion.matches || !dialog.open || typeof dialog.animate !== "function" || distance < 0.5) {
      finish();
      return;
    }
    const duration = velocity ? Math.min(240, Math.max(140, distance / Math.abs(velocity))) : 180;
    const animation = dialog.animate([
      { height: `${from.height}px`, transform: `translateY(${from.offset}px)` },
      { height: `${targetHeight}px`, transform: `translateY(${targetOffset}px)` },
    ], { duration, easing: "cubic-bezier(0.2,0.7,0.2,1)" });
    motion = animation;
    dialog.classList.add("is-settling");
    dialog.dataset.sheetState = closing ? "closing" : "settling";
    animation.finished.then(() => {
      if (motion !== animation) return;
      motion = null;
      dialog.classList.remove("is-settling");
      delete dialog.dataset.sheetState;
      finish();
    }).catch(() => {}); // cancellation is an intentional interruption
  }

  function samplePointer(event) {
    if (!drag) return;
    const points = event.getCoalescedEvents?.() || [];
    for (const point of [...points, event]) drag.samples.push({ time: point.timeStamp, x: point.clientX, y: point.clientY });
    if (drag.samples.length > 64) drag.samples.splice(0, drag.samples.length - 64);
  }

  function finishDrag({ cancel = false, release = null, animate = true } = {}) {
    if (!drag) return;
    if (release) samplePointer(release);
    const previous = drag;
    drag = null;
    dialog.classList.remove("is-resizing");
    if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
    if (cancel) {
      settleTo(previous.fraction * sheetBounds().available, { animate });
      return;
    }
    const intent = release ? gestureModel.releaseIntent(previous.samples, release.timeStamp) : { action: "resize", velocity: 0 };
    const height = intent.action === "expand" ? sheetBounds().max : dialog.getBoundingClientRect().height;
    settleTo(height, { closing: intent.action === "dismiss", velocity: intent.action === "resize" ? 0 : intent.velocity, animate });
  }

  handle.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0 || !dialog.open) return;
    event.preventDefault();
    const visual = visualPosition();
    stopMotion();
    const bounds = sheetBounds();
    preferredFraction = Math.min(bounds.max, Math.max(bounds.min, visual.height)) / Math.max(1, bounds.available);
    setOffset(visual.offset);
    updateSheetHeight();
    handle.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, height: visual.height, offset: visual.offset, fraction: preferredFraction, samples: [] };
    samplePointer(event);
    handle.setPointerCapture(event.pointerId);
    dialog.classList.add("is-resizing");
  });
  handle.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    const bounds = sheetBounds();
    const down = event.clientY - drag.y;
    const rawHeight = drag.height - drag.offset - down;
    const height = Math.min(bounds.max, Math.max(bounds.min, rawHeight));
    // Below the minimum, translate the panel down so its handle still follows
    // the finger 1:1. A slow release returns to the usable minimum, never closes.
    setOffset(Math.max(0, bounds.min - rawHeight));
    preferredFraction = height / Math.max(1, bounds.available);
    samplePointer(event);
    updateSheetHeight();
  });
  handle.addEventListener("pointerup", event => {
    if (drag?.id === event.pointerId) finishDrag({ release: event });
  });
  handle.addEventListener("pointercancel", event => {
    if (drag?.id === event.pointerId) finishDrag({ cancel: true });
  });
  handle.addEventListener("lostpointercapture", () => finishDrag({ cancel: true }));
  document.addEventListener("pointerdown", event => {
    if (drag && event.pointerId !== drag.id) finishDrag({ cancel: true });
  }, { capture: true, passive: true });
  handle.addEventListener("keydown", event => {
    if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    finishDrag({ cancel: true, animate: false });
    stopMotion();
    setOffset(0);
    const bounds = sheetBounds();
    const current = dialog.getBoundingClientRect().height;
    const step = event.key.startsWith("Page") ? 80 : 24;
    const next = event.key === "Home" ? bounds.min : event.key === "End" ? bounds.max
      : current + (["ArrowUp", "PageUp"].includes(event.key) ? step : -step);
    preferredFraction = Math.min(bounds.max, Math.max(bounds.min, next)) / Math.max(1, bounds.available);
    updateSheetHeight();
  });

  function viewportChanged() {
    const opening = dialog.dataset.sheetState === "opening";
    const visual = dialog.open && motion ? visualPosition() : null;
    finishDrag({ cancel: true, animate: false });
    stopMotion();
    if (opening) preferredFraction = 1;
    else if (visual) {
      const bounds = sheetBounds();
      preferredFraction = Math.min(bounds.max, Math.max(bounds.min, visual.height - visual.offset)) / Math.max(1, bounds.available);
    }
    setOffset(0);
    scheduleLayout();
  }

  dialog.addEventListener("close", () => { if (!dialog.open) { finishDrag({ cancel: true, animate: false }); stopMotion(); setOffset(0); } });
  window.addEventListener("blur", viewportChanged);
  document.addEventListener("visibilitychange", () => { if (document.hidden) viewportChanged(); });
  window.addEventListener("resize", viewportChanged, { passive: true });
  window.visualViewport?.addEventListener("resize", viewportChanged, { passive: true });
  window.visualViewport?.addEventListener("scroll", viewportChanged, { passive: true });
  window.addEventListener("quietcamera:immersivechange", viewportChanged);
  reducedMotion.addEventListener("change", () => {
    if (!reducedMotion.matches || !motion) return;
    const closing = dialog.dataset.sheetState === "closing";
    stopMotion();
    if (closing && dialog.open) elements.closeGalleryButton.click();
    setOffset(0);
    updateSheetHeight();
  });
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(scheduleLayout);
    [header, sizing, body, document.querySelector("#gallerySelectionActions")].forEach(element => observer.observe(element));
  }
  new MutationObserver(records => {
    if (dialog.open && records.some(record => record.oldValue === null)) {
      finishDrag({ cancel: true, animate: false });
      stopMotion();
      setOffset(0);
      // The whole sheet enters along the same axis as its handle gesture.
      preferredFraction = 1;
      updateSheetHeight();
      setOffset(sheetBounds().max + 24);
      settleTo(sheetBounds().max);
      if (motion) dialog.dataset.sheetState = "opening";
    }
    scheduleLayout();
  }).observe(dialog, { attributes: true, attributeOldValue: true, attributeFilter: ["open"] });
  new MutationObserver(scheduleLayout).observe(root, { attributes: true, attributeFilter: ["class"] });
  scheduleLayout();
})();
