"use strict";

(() => {
  const Q = window.QuietCameraEnhancements;

  function closeSettings() {
    if (elements.settingsDialog.open) elements.settingsDialog.close();
    elements.settingsButton.setAttribute("aria-expanded", "false");
  }

  function placeSettingsPanel() {
    if (Q.MOBILE_QUERY.matches) {
      if (elements.settingsPanel.parentElement !== elements.settingsSheetBody) elements.settingsSheetBody.append(elements.settingsPanel);
    } else {
      if (elements.settingsPanel.parentElement !== elements.settingsDock) elements.settingsDock.append(elements.settingsPanel);
      closeSettings();
    }
    Q.placeLiveCameraControls();
  }

  function openSettings() {
    placeSettingsPanel();
    if (Q.MOBILE_QUERY.matches) {
      if (elements.settingsDialog.open) {
        closeSettings();
        return;
      }
      elements.settingsDialog.show();
      elements.settingsButton.setAttribute("aria-expanded", "true");
      elements.closeSettingsButton.focus({ preventScroll: true });
    } else {
      elements.settingsPanel.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  elements.settingsButton.setAttribute("aria-controls", "settingsDialog");
  elements.settingsButton.setAttribute("aria-expanded", "false");

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
  elements.closeSettingsButton.addEventListener("click", closeSettings);
  elements.settingsDialog.addEventListener("close", () => {
    elements.settingsButton.setAttribute("aria-expanded", "false");
  });
  elements.privacyButton.addEventListener("click", closeSettings, { capture: true });
  Q.MOBILE_QUERY.addEventListener?.("change", placeSettingsPanel);
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
    const loaded = state.gallery.length;
    elements.galleryCount.textContent = String(total);
    elements.galleryCount.hidden = total === 0;
    elements.gallerySummary.textContent = total > loaded ? `${total}件中 ${loaded}件を表示` : `${total}件`;
    loadMoreButton.hidden = loaded >= total;
  }

  Q.refreshPagedGallery = async ({ append = false } = {}) => {
    revokeGalleryUrls();
    const offset = append ? state.gallery.length : 0;
    const page = await listStoredMediaPage({ offset, limit: state.galleryPageSize });
    if (append) {
      const known = new Set(state.gallery.map((item) => item.id));
      for (const item of page) if (!known.has(item.id)) state.gallery.push(item);
    } else {
      state.gallery = page;
    }
    state.galleryLoadedCount = state.gallery.length;
    state.galleryTotalCount = await countStoredMedia();

    const validIds = new Set(state.gallery.map((item) => item.id));
    for (const id of state.selectedGalleryIds) if (!validIds.has(id)) state.selectedGalleryIds.delete(id);
    updateGalleryButton();
    updatePagedGalleryUi();
    if (elements.galleryDialog.open) renderGallery();
    return state.gallery;
  };

  Q.enhancedOpenGallery = async () => {
    if (elements.galleryButton.dataset.recordingCancel === "true") {
      if (window.confirm("現在の録画を破棄しますか？")) stopRecording({ cancel: true });
      return;
    }
    await Q.refreshPagedGallery({ append: false });
    renderGallery();
    updatePagedGalleryUi();
    elements.galleryDialog.showModal();
  };

  refreshGallery = Q.refreshPagedGallery;
  openGallery = Q.enhancedOpenGallery;
  elements.galleryButton.addEventListener("click", Q.enhancedOpenGallery);
  loadMoreButton.addEventListener("click", async () => {
    loadMoreButton.disabled = true;
    try {
      await Q.refreshPagedGallery({ append: true });
      renderGallery();
      updatePagedGalleryUi();
    } finally {
      loadMoreButton.disabled = false;
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
