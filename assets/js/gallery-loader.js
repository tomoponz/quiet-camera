"use strict";

// Paged history loading keeps refreshes serialized and preserves the visible anchor.
(() => {
  const Q = window.QuietCameraEnhancements;

  Q.initializeGalleryLoader = () => {
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
      for (const id of state.selectedGalleryIds) if (!await getStoredMedia(id, { allowUnavailable: true })) state.selectedGalleryIds.delete(id);
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
      try { await galleryOpenRequest; }
      catch (error) {
        console.warn("Gallery could not be opened; stored data is retained.", error);
        showToast("履歴を読み込めませんでした。データは保持しています。もう一度開いてください");
      } finally { galleryOpenRequest = null; }
    };

    // aria-disabled instead of disabled: a disabled focused button drops keyboard focus to <body>.
    let loadingMore = false;
    loadMoreButton.addEventListener("click", async () => {
      if (loadingMore) return;
      loadingMore = true;
      loadMoreButton.setAttribute("aria-disabled", "true");
      const hadFocus = document.activeElement === loadMoreButton, before = elements.galleryGrid.children.length;
      try {
        await Q.refreshPagedGallery({ append: true });
      } catch (error) {
        console.warn("More gallery records could not be loaded.", error);
        showToast("続きの履歴を読み込めませんでした。もう一度お試しください");
      } finally {
        loadingMore = false;
        loadMoreButton.removeAttribute("aria-disabled");
        if (hadFocus && loadMoreButton.hidden) elements.galleryGrid.children[before]?.querySelector(".gallery-open")?.focus({ preventScroll: true });
      }
    });
  };
})();
