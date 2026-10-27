"use strict";

(() => {
  const Q = window.QuietCameraEnhancements;
  const root = document.documentElement;
  const SHORT_VIEW_QUERY = window.matchMedia("(max-height: 700px)");
  const TOUCH_TABLET_QUERY = window.matchMedia("(max-width: 1024px) and (pointer: coarse)");
  const REDUCED_MOTION_QUERY = window.matchMedia("(prefers-reduced-motion: reduce)");

  function shouldUseSettingsSheet() {
    return Q.MOBILE_QUERY.matches
      || root.classList.contains("overlay-camera-layout")
      || SHORT_VIEW_QUERY.matches
      || TOUCH_TABLET_QUERY.matches
      || root.classList.contains("immersive-mode");
  }

  function observeMediaQuery(query) {
    if (typeof query.addEventListener === "function") query.addEventListener("change", placeSettingsPanel);
    else query.addListener?.(placeSettingsPanel);
  }

  function syncSettingsButtonSemantics(sheetMode = shouldUseSettingsSheet()) {
    elements.settingsButton.setAttribute("aria-controls", sheetMode ? "settingsDialog" : "settingsPanel");
    if (sheetMode) {
      elements.settingsButton.setAttribute("aria-expanded", String(elements.settingsDialog.open));
      elements.settingsButton.setAttribute("aria-haspopup", "dialog");
    } else {
      elements.settingsButton.removeAttribute("aria-expanded");
      elements.settingsButton.removeAttribute("aria-haspopup");
    }
  }

  function closeSettings({ restoreFocus = true } = {}) {
    const wasOpen = elements.settingsDialog.open;
    if (wasOpen) elements.settingsDialog.close();
    elements.settingsButton.setAttribute("aria-expanded", "false");
    if (wasOpen && restoreFocus) elements.settingsButton.focus({ preventScroll: true });
  }

  function placeSettingsPanel() {
    const sheetMode = shouldUseSettingsSheet();
    root.classList.toggle("settings-sheet-layout", sheetMode);
    if (sheetMode) {
      if (elements.settingsPanel.parentElement !== elements.settingsSheetBody) elements.settingsSheetBody.append(elements.settingsPanel);
    } else {
      const restoreFocus = elements.settingsDialog.contains(document.activeElement);
      closeSettings({ restoreFocus });
      if (elements.settingsPanel.parentElement !== elements.settingsDock) elements.settingsDock.append(elements.settingsPanel);
    }
    syncSettingsButtonSemantics(sheetMode);
    Q.placeLiveCameraControls();
  }

  // Android Back / platform close request. index.html sets closedby="closerequest";
  // browsers with CloseWatcher but without dialog closedby get an equivalent watcher.
  let settingsCloseWatcher = null;
  function watchSettingsCloseRequest() {
    if ("closedBy" in HTMLDialogElement.prototype || typeof window.CloseWatcher !== "function") return;
    settingsCloseWatcher?.destroy();
    try {
      const watcher = new window.CloseWatcher();
      watcher.addEventListener("close", () => { if (settingsCloseWatcher === watcher) { settingsCloseWatcher = null; closeSettings(); } });
      settingsCloseWatcher = watcher;
    } catch { settingsCloseWatcher = null; }
  }

  function openSettings() {
    placeSettingsPanel();
    if (shouldUseSettingsSheet()) {
      if (elements.settingsDialog.open) {
        if (elements.settingsDialog.dataset.sheetState === "closing") closeSettings({ restoreFocus: false });
        else { closeSettings(); return; }
      }
      elements.settingsDialog.show();
      watchSettingsCloseRequest();
      elements.settingsButton.setAttribute("aria-expanded", "true");
      elements.closeSettingsButton.focus({ preventScroll: true });
    } else {
      elements.settingsPanel.scrollIntoView({ behavior: REDUCED_MOTION_QUERY.matches ? "auto" : "smooth", block: "center" });
    }
  }

  // Replace direct listeners that captured the legacy functions before this enhancement layer loaded.
  elements.startButton.removeEventListener("click", Q.originalStartCamera);
  elements.switchButton.removeEventListener("click", Q.originalSwitchCamera);
  elements.torchButton.removeEventListener("click", Q.originalToggleTorch);
  elements.galleryButton.removeEventListener("click", Q.originalOpenGallery);

  startCamera = Q.enhancedStartCamera;
  switchCamera = Q.enhancedSwitchCamera;
  updateCapabilities = Q.enhancedUpdateCapabilities;
  applyZoom = Q.enhancedApplyZoom;
  focusAt = Q.enhancedFocusAt;
  capturePhoto = Q.enhancedCapturePhoto;
  toggleTorch = Q.enhancedToggleTorch;
  applyExposure = () => {};

  elements.startButton.addEventListener("click", Q.enhancedStartCamera);
  elements.switchButton.addEventListener("click", Q.enhancedSwitchCamera);
  elements.torchButton.addEventListener("click", Q.enhancedToggleTorch);

  elements.cameraSourceSelect.addEventListener("change", async () => {
    Q.storeSelectedDevice(elements.cameraSourceSelect.value);
    await Q.enhancedStartCamera();
  });
  elements.manualFocusRange.addEventListener("input", (event) => Q.scheduleManualFocus(event.target.value));
  elements.manualFocusRange.addEventListener("change", (event) => Q.applyManualFocus(event.target.value));
  elements.focusResetButton.addEventListener("click", Q.resetFocus);
  elements.exposureIndexRange.addEventListener("input", (event) => Q.scheduleExposureIndex(event.target.value));
  elements.exposureIndexRange.addEventListener("change", (event) => Q.applyExposureIndex(event.target.value));
  elements.exposureResetButton.addEventListener("click", () => Q.applyExposureIndex(0));
  elements.settingsButton.addEventListener("click", openSettings);
  elements.microphoneStatusButton.addEventListener("click", () => {
    if (!shouldUseSettingsSheet() || !elements.settingsDialog.open) openSettings();
    window.setTimeout(() => {
      elements.microphoneSelect.scrollIntoView({ behavior: "auto", block: "center" });
      elements.microphoneSelect.focus({ preventScroll: true });
    }, 0);
  });
  elements.closeSettingsButton.addEventListener("click", closeSettings);
  elements.settingsDialog.addEventListener("close", () => {
    if (!elements.settingsDialog.open) {
      const watcher = settingsCloseWatcher; settingsCloseWatcher = null; watcher?.destroy();
      // Back / closedby closes natively without closeSettings(): never leave focus on <body>.
      const active = document.activeElement;
      if ((!active || active === document.body || elements.settingsDialog.contains(active)) && shouldUseSettingsSheet() && !modalDialogAboveSettings()) elements.settingsButton.focus({ preventScroll: true });
    }
    syncSettingsButtonSemantics();
  });
  // A modal opened above the non-modal sheet owns Escape (its native cancel);
  // the sheet closes on the next Escape, matching the visual stack.
  function modalDialogAboveSettings() {
    return [...document.querySelectorAll("dialog[open]")].some(dialog => {
      if (dialog === elements.settingsDialog) return false;
      try { return dialog.matches(":modal"); } catch { return true; }
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !elements.settingsDialog.open) return;
    if (modalDialogAboveSettings()) return;
    event.preventDefault();
    closeSettings();
  });
  elements.privacyButton.addEventListener("click", closeSettings, { capture: true });
  observeMediaQuery(Q.MOBILE_QUERY);
  observeMediaQuery(SHORT_VIEW_QUERY);
  observeMediaQuery(TOUCH_TABLET_QUERY);
  window.addEventListener("quietcamera:immersivechange", placeSettingsPanel);
  window.addEventListener("resize", placeSettingsPanel, { passive: true });

  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    window.clearTimeout(state.deviceRefreshTimer);
    state.deviceRefreshTimer = window.setTimeout(async () => {
      try {
        await Q.refreshCameraList();
        if (state.videoTrack?.readyState === "ended") await Q.enhancedStartCamera();
      } catch (error) {
        console.warn("Camera list refresh failed.", error);
      }
    }, 250);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !state.videoTrack) return;
    Q.applyContinuousFocus({ silent: true })
      .catch((error) => console.warn("Autofocus resume failed.", error));
  });

  // Paged gallery: avoid bringing every photo/video Blob into memory at startup.
  const loadMoreButton = document.createElement("button");
  loadMoreButton.id = "galleryLoadMoreButton";
  loadMoreButton.type = "button";
  loadMoreButton.className = "secondary-button compact-button";
  loadMoreButton.textContent = "さらに読み込む";
  loadMoreButton.hidden = true;
  elements.galleryGrid.after(loadMoreButton);

  function updatePagedGalleryUi() {
    const total = Number(state.galleryTotalCount || 0);
    const loaded = Number(state.galleryLoadedCount || 0);
    elements.galleryCount.textContent = String(total);
    elements.galleryCount.hidden = total === 0;
    updateGallerySummary();
    loadMoreButton.hidden = loaded >= total;
  }

  const galleryBody = document.querySelector("#gallerySheetBody");

  // Remember the first visible cards (and a few after them) by id, so a
  // re-render after delete/PDF/capture keeps the same item under the reader.
  function captureGalleryAnchor() {
    if (!elements.galleryDialog.open) return null;
    const top = galleryBody.getBoundingClientRect().top, visible = [];
    for (const card of elements.galleryGrid.children) {
      const box = card.getBoundingClientRect();
      if (box.bottom <= top + 1) continue;
      visible.push({ id: card.dataset.id, offset: box.top - top });
      if (visible.length >= 8) break;
    }
    const focusedCard = document.activeElement?.closest?.(".gallery-card");
    const focus = focusedCard && elements.galleryGrid.contains(focusedCard)
      ? { id: focusedCard.dataset.id, checkbox: document.activeElement.matches("input") } : null;
    return { scrollTop: galleryBody.scrollTop, visible, focus };
  }

  function restoreGalleryAnchor(anchor) {
    if (!anchor) return;
    const top = galleryBody.getBoundingClientRect().top;
    const cards = new Map([...elements.galleryGrid.children].map((card) => [card.dataset.id, card]));
    const match = anchor.visible.find(({ id }) => cards.has(id));
    if (match) galleryBody.scrollTop += cards.get(match.id).getBoundingClientRect().top - top - match.offset;
    else galleryBody.scrollTop = anchor.scrollTop;
    // A keyboard/AT user keeps the focused card (or the card now in its place).
    if (anchor.focus) {
      const card = cards.get(anchor.focus.id) || (match && cards.get(match.id));
      card?.querySelector(anchor.focus.checkbox && cards.has(anchor.focus.id) ? "input" : ".gallery-open")?.focus({ preventScroll: true });
    }
  }

  async function loadPagedGallery({ append = false } = {}) {
    // Read everything first; the open grid is replaced only after the data arrived.
    const open = elements.galleryDialog.open;
    const loaded = Number(state.galleryLoadedCount || 0);
    const offset = append ? loaded : 0;
    // While the history is open, a refresh re-reads every item down to the oldest one
    // already loaded, so newer items never push loaded (or selected) items out.
    const floor = !append && open && state.gallery.length ? state.gallery[state.gallery.length - 1].createdAt : null;
    let page = floor === null ? await listStoredMediaPage({ offset, limit: state.galleryPageSize }) : await listStoredMediaSince(floor);
    if (floor !== null && page.length < state.galleryPageSize) page = await listStoredMediaPage({ offset: 0, limit: state.galleryPageSize });
    const total = await countStoredMedia();
    for (const id of state.selectedGalleryIds) if (!await getStoredMedia(id)) state.selectedGalleryIds.delete(id);
    await refreshRecoveryNotice().catch((error) => console.warn("Recovery status could not be loaded.", error));

    const anchor = append ? null : captureGalleryAnchor();
    const previousLength = state.gallery.length;
    if (append) {
      const known = new Set(state.gallery.map((item) => item.id));
      for (const item of page) if (!known.has(item.id)) state.gallery.push(item);
    } else {
      state.gallery = page;
    }
    state.galleryLoadedCount = append ? offset + page.length : page.length;
    // Selection only acts on items the user can see: drop any that left the list.
    const listed = new Set(state.gallery.map((item) => item.id));
    let dropped = 0;
    for (const id of [...state.selectedGalleryIds]) if (!listed.has(id)) { state.selectedGalleryIds.delete(id); dropped += 1; }
    state.galleryTotalCount = total;
    if (state.latestPreviewUrl) URL.revokeObjectURL(state.latestPreviewUrl);
    state.latestPreviewUrl = null;
    updateGalleryButton();
    updatePagedGalleryUi();
    if (elements.galleryDialog.open) {
      if (append) renderGallery({ appendFrom: previousLength });
      else { renderGallery(); restoreGalleryAnchor(anchor); }
      if (dropped) window.QuietCameraGallery?.notice?.(`一覧から外れた${dropped}件の選択を解除しました`);
    }
    return state.gallery;
  }

  // Serialize refreshes so a load-more and a refresh never interleave their writes.
  let galleryRefreshChain = Promise.resolve();
  Q.refreshPagedGallery = (options) => {
    const run = galleryRefreshChain.catch(() => {}).then(() => loadPagedGallery(options));
    galleryRefreshChain = run;
    return run;
  };

  let galleryOpenRequest = null;
  Q.enhancedOpenGallery = async () => {
    if (elements.galleryButton.dataset.recordingCancel === "true") {
      if (window.confirm("現在の録画を破棄しますか？")) stopRecording({ cancel: true });
      return;
    }
    // A self-timer countdown or capture owns the screen; its review must not stack on history.
    if (state.busy) return;
    if (elements.galleryDialog.open || galleryOpenRequest) return galleryOpenRequest;
    galleryOpenRequest = (async () => {
      await Q.refreshPagedGallery({ append: false });
      if (state.busy) return;
      renderGallery();
      updatePagedGalleryUi();
      elements.galleryDialog.showModal();
    })();
    try { await galleryOpenRequest; } finally { galleryOpenRequest = null; }
  };

  refreshGallery = Q.refreshPagedGallery;
  openGallery = Q.enhancedOpenGallery;
  elements.galleryButton.addEventListener("click", Q.enhancedOpenGallery);
  // aria-disabled instead of disabled: a disabled focused button drops keyboard focus to <body>.
  let loadingMore = false;
  loadMoreButton.addEventListener("click", async () => {
    if (loadingMore) return;
    loadingMore = true;
    loadMoreButton.setAttribute("aria-disabled", "true");
    const hadFocus = document.activeElement === loadMoreButton, before = elements.galleryGrid.children.length;
    try {
      await Q.refreshPagedGallery({ append: true });
    } finally {
      loadingMore = false;
      loadMoreButton.removeAttribute("aria-disabled");
      if (hadFocus && loadMoreButton.hidden) elements.galleryGrid.children[before]?.querySelector(".gallery-open")?.focus({ preventScroll: true });
    }
  });

  // Request protection from automatic storage eviction when the browser supports it.
  Promise.resolve()
    .then(() => requestPersistentStorage())
    .then((persistent) => console.info(`[Quiet Camera] persistent storage: ${persistent ? "granted" : "best-effort"}`))
    .catch((error) => console.warn("Persistent storage initialization failed.", error));

  // Shrink any gallery array populated by the base initializer before this layer was installed.
  window.setTimeout(() => {
    Q.refreshPagedGallery({ append: false }).catch((error) => console.warn("Paged gallery initialization failed.", error));
  }, 0);

  placeSettingsPanel();
})();

// Responsive preview controls and a resizable, non-modal settings sheet.
(() => {
  const root = document.documentElement;
  const stage = document.querySelector("#cameraStage");
  const toolbar = document.querySelector(".camera-top-controls");
  const dialog = document.querySelector("#settingsDialog");
  const body = document.querySelector("#settingsSheetBody");
  const handle = document.querySelector("#settingsResizeHandle");
  const sizing = document.querySelector(".settings-sheet-sizing");
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
    const firstRow = [...body.querySelectorAll(".setting-field")].find(element => element.getBoundingClientRect().height > 0);
    const rowHeight = Math.max(44, firstRow?.getBoundingClientRect().height || 0);
    const min = Math.min(available, Math.ceil(Math.max(160, chromeHeight + rowHeight)));
    // Bottom safe-area spacing is inside the panel background. Each opening
    // starts at the maximum visible height; the handle can still collapse it.
    const max = available;
    return { min, max, available, safeBottom, ...view };
  }

  function updateSheetHeight() {
    if (!dialog.open || !root.classList.contains("settings-sheet-layout")) return;
    const bounds = sheetBounds();
    const height = Math.min(bounds.max, Math.max(bounds.min, Math.round(preferredFraction * bounds.available)));
    dialog.style.setProperty("--settings-sheet-bottom", `${Math.max(0, window.innerHeight - bounds.top - bounds.height)}px`);
    dialog.style.setProperty("--settings-sheet-max-height", `${bounds.max}px`);
    dialog.style.setProperty("--settings-sheet-height", `${height}px`);
    handle.setAttribute("aria-valuemin", String(Math.ceil(bounds.min)));
    handle.setAttribute("aria-valuemax", String(Math.floor(bounds.max)));
    handle.setAttribute("aria-valuenow", String(Math.round(height)));
    handle.setAttribute("aria-valuetext", `${Math.round(height)}ピクセル、画面の${Math.round(height / bounds.height * 100)}パーセント`);
  }

  function updatePreviewControls() {
    if (root.classList.contains("overlay-camera-layout")) {
      window.QuietCameraOverlay?.schedule();
      return;
    }
    const stageBox = stage.getBoundingClientRect();
    const toolbarBox = toolbar.getBoundingClientRect();
    const overlapsPreview = toolbarBox.right > stageBox.left && toolbarBox.left < stageBox.right;
    stage.style.setProperty("--camera-recording-top", `${overlapsPreview ? toolbarBox.bottom - stageBox.top + 8 : 12}px`);
    if (root.classList.contains("immersive-mode")) {
      root.style.setProperty("--immersive-mic-top", `${toolbarBox.bottom + 8}px`);
      const badgeLeft = parseFloat(getComputedStyle(document.querySelector("#recordingBadge")).left) || 0;
      root.style.setProperty("--immersive-recording-width", `${Math.max(0, toolbarBox.left - badgeLeft - 8)}px`);
    } else {
      root.style.removeProperty("--immersive-mic-top");
      root.style.removeProperty("--immersive-recording-width");
    }
  }

  function updateLayout() {
    layoutFrame = 0;
    updatePreviewControls();
    updateSheetHeight();
  }

  function scheduleLayout() {
    if (!layoutFrame) layoutFrame = requestAnimationFrame(updateLayout);
  }

  function setOffset(offset) {
    sheetOffset = offset;
    dialog.style.setProperty("--settings-sheet-offset", `${offset}px`);
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
      if (closing && dialog.open) elements.closeSettingsButton.click();
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
    if (closing && dialog.open) elements.closeSettingsButton.click();
    setOffset(0);
    updateSheetHeight();
  });
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(scheduleLayout);
    [stage, toolbar, header, sizing].forEach(element => observer.observe(element));
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
