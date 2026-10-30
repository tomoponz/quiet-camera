"use strict";

(() => {
  const dialog = elements.reviewDialog;
  const viewer = document.querySelector("#reviewViewer");
  const navigation = document.querySelector("#reviewPhotoNavigation");
  const newerButton = document.querySelector("#reviewNewerPhoto");
  const olderButton = document.querySelector("#reviewOlderPhoto");
  const status = document.querySelector("#reviewPhotoStatus");
  const pointers = new Set();
  let gesture = null;
  let epoch = 0;
  let frame = 0;
  let navigating = false;

  const photoOpen = () => dialog.open && state.selectedMedia?.kind === "photo";
  const zoomed = () => (window.visualViewport?.scale || 1) > 1.01;

  function cancelGesture() {
    const previous = gesture;
    gesture = null;
    if (previous && viewer.hasPointerCapture(previous.id)) viewer.releasePointerCapture(previous.id);
  }

  async function refreshNavigation() {
    frame = 0;
    navigation.hidden = !photoOpen();
    if (!photoOpen() || navigating) return;
    const current = state.selectedMedia;
    const token = epoch;
    newerButton.disabled = olderButton.disabled = true;
    navigation.setAttribute("aria-busy", "true");
    try {
      const [newer, older] = await Promise.all([findAdjacentPhoto(current, "newer"), findAdjacentPhoto(current, "older")]);
      if (token !== epoch || !photoOpen() || state.selectedMedia.id !== current.id) return;
      newerButton.disabled = !newer;
      olderButton.disabled = !older;
      const edge = !newer && !older ? "写真はこの1枚です。" : !newer ? "最新の写真です。" : !older ? "最も古い写真です。" : "";
      status.textContent = `${formatMediaDate(current.createdAt)}。${edge}左へスワイプで古い写真、右へで新しい写真。`;
    } catch (error) {
      if (token === epoch && photoOpen()) status.textContent = "前後の写真を読み込めませんでした。閉じてもう一度開いてください。";
      console.warn("Photo navigation unavailable.", error);
    } finally {
      if (token === epoch) navigation.removeAttribute("aria-busy");
    }
  }

  function scheduleRefresh() {
    if (!frame) frame = requestAnimationFrame(refreshNavigation);
  }

  function selectionChanged() {
    epoch += 1;
    navigating = false;
    cancelGesture();
    pointers.clear();
    navigation.hidden = !photoOpen();
    newerButton.disabled = olderButton.disabled = true;
    navigation.removeAttribute("aria-busy");
    status.textContent = "";
    scheduleRefresh();
  }

  async function navigate(direction) {
    if (!photoOpen() || navigating) return;
    const current = state.selectedMedia;
    const token = ++epoch;
    navigating = true;
    cancelGesture();
    newerButton.disabled = olderButton.disabled = true;
    try {
      const adjacent = await findAdjacentPhoto(current, direction);
      const media = adjacent ? await getStoredMedia(adjacent.id) : null;
      if (token !== epoch || !photoOpen() || state.selectedMedia.id !== current.id) return;
      if (media?.kind === "photo") selectMedia(media);
    } catch (error) {
      if (token === epoch && photoOpen()) showToast("写真を読み込めませんでした");
      console.warn("Photo navigation failed.", error);
    } finally {
      if (token === epoch) { navigating = false; scheduleRefresh(); }
    }
  }

  newerButton.addEventListener("click", () => navigate("newer"));
  olderButton.addEventListener("click", () => navigate("older"));
  document.addEventListener("quietcamera:reviewchange", selectionChanged);
  dialog.addEventListener("close", selectionChanged);
  new MutationObserver(selectionChanged).observe(dialog, { attributes: true, attributeFilter: ["open"] });

  // Track all contacts, including a second finger outside the image. A pinch
  // invalidates the entire gesture; lifting one finger never becomes a swipe.
  document.addEventListener("pointerdown", event => {
    if (!dialog.open || event.pointerType !== "touch") return;
    pointers.add(event.pointerId);
    if (pointers.size > 1) cancelGesture();
  }, { capture: true, passive: true });
  viewer.addEventListener("pointerdown", event => {
    if (!photoOpen() || navigating || zoomed() || event.pointerType !== "touch" || !event.isPrimary || pointers.size !== 1) return;
    if (event.target.closest("button, a, input, select, textarea, video, [contenteditable]")) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now(), mediaId: state.selectedMedia.id };
    viewer.setPointerCapture(event.pointerId);
  });
  document.addEventListener("pointermove", event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = Math.abs(event.clientX - gesture.x), dy = Math.abs(event.clientY - gesture.y);
    if (zoomed() || (dy > 14 && dy > dx)) cancelGesture();
  }, { capture: true, passive: true });
  document.addEventListener("pointerup", event => {
    pointers.delete(event.pointerId);
    if (!gesture || gesture.id !== event.pointerId) return;
    const previous = gesture;
    cancelGesture();
    const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
    if (!photoOpen() || zoomed() || pointers.size || state.selectedMedia.id !== previous.mediaId) return;
    if (performance.now() - previous.time > 900 || Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    navigate(dx < 0 ? "older" : "newer");
  }, { capture: true, passive: true });
  document.addEventListener("pointercancel", event => {
    pointers.delete(event.pointerId);
    if (gesture?.id === event.pointerId) cancelGesture();
  }, { capture: true, passive: true });
  viewer.addEventListener("lostpointercapture", event => { if (gesture?.id === event.pointerId) cancelGesture(); });
  viewer.addEventListener("contextmenu", cancelGesture);
  dialog.addEventListener("keydown", event => {
    if (!photoOpen() || zoomed() || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target.closest("input, textarea, select, video, [contenteditable]")) return;
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    navigate(event.key === "ArrowRight" ? "older" : "newer");
  });
  function viewportChanged() {
    cancelGesture();
    pointers.clear();
    viewer.classList.toggle("is-page-zoomed", zoomed());
  }
  window.addEventListener("resize", viewportChanged, { passive: true });
  window.visualViewport?.addEventListener("resize", viewportChanged, { passive: true });
  viewportChanged();
})();
