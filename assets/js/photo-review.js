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
  let ignoredClick = null;
  let epoch = 0;
  let frame = 0;
  let navigating = false;

  const reviewOpen = () => dialog.open && ["photo", "video"].includes(state.selectedMedia?.kind);
  const zoomed = () => (window.visualViewport?.scale || 1) > 1.01;

  const video = elements.reviewVideo;
  const nativeVideoPresentation = () => document.fullscreenElement === video || document.pictureInPictureElement === video
    || video.webkitDisplayingFullscreen || (video.webkitPresentationMode && video.webkitPresentationMode !== "inline");
  function videoContentPress(event) {
    if (nativeVideoPresentation() || video.seeking) return false;
    const r = video.getBoundingClientRect();
    // Closed native-control shadow trees cannot be hit-tested consistently.
    // Preserve the bottom seek/volume rail and central play/pause touch target.
    const rail = Math.min(r.height, Math.max(56, Math.min(80, r.height * 0.3)));
    return event.clientY < r.bottom - rail
      && !(Math.abs(event.clientX - (r.left + r.width / 2)) < 32 && Math.abs(event.clientY - (r.top + r.height / 2)) < 32);
  }

  function cancelGesture() {
    const previous = gesture;
    gesture = null;
    if (previous && viewer.hasPointerCapture(previous.id)) viewer.releasePointerCapture(previous.id);
  }

  async function refreshNavigation() {
    frame = 0;
    navigation.hidden = !reviewOpen();
    if (!reviewOpen() || navigating) return;
    const current = state.selectedMedia;
    const token = epoch;
    newerButton.disabled = olderButton.disabled = true;
    navigation.setAttribute("aria-busy", "true");
    try {
      const [newer, older] = await Promise.all([findAdjacentMedia(current, "newer"), findAdjacentMedia(current, "older")]);
      if (token !== epoch || !reviewOpen() || state.selectedMedia.id !== current.id) return;
      newerButton.disabled = !newer;
      olderButton.disabled = !older;
      const edge = !newer && !older ? "撮影結果はこの1件です。" : !newer ? "最新の撮影結果です。" : !older ? "最も古い撮影結果です。" : "";
      status.textContent = `${formatMediaDate(current.createdAt)}。${edge}左へスワイプで古い撮影結果、右へで新しい撮影結果。`;
    } catch (error) {
      if (token === epoch && reviewOpen()) status.textContent = "前後の撮影結果を読み込めませんでした。閉じてもう一度開いてください。";
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
    navigation.hidden = !reviewOpen();
    newerButton.disabled = olderButton.disabled = true;
    navigation.removeAttribute("aria-busy");
    status.textContent = "";
    scheduleRefresh();
  }

  async function navigate(direction) {
    if (!reviewOpen() || navigating) return;
    const current = state.selectedMedia;
    const token = ++epoch;
    navigating = true;
    cancelGesture();
    newerButton.disabled = olderButton.disabled = true;
    try {
      const adjacent = await findAdjacentMedia(current, direction);
      const media = adjacent ? await getStoredMedia(adjacent.id) : null;
      if (token !== epoch || !reviewOpen() || state.selectedMedia.id !== current.id) return;
      if (media && ["photo", "video"].includes(media.kind)) selectMedia(media);
    } catch (error) {
      if (token === epoch && reviewOpen()) showToast("撮影結果を読み込めませんでした");
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
    ignoredClick = null;
    if (!dialog.open || event.pointerType !== "touch") return;
    pointers.add(event.pointerId);
    if (pointers.size > 1) cancelGesture();
  }, { capture: true, passive: true });
  viewer.addEventListener("pointerdown", event => {
    if (!reviewOpen() || navigating || zoomed() || event.defaultPrevented || event.pointerType !== "touch" || !event.isPrimary || pointers.size !== 1) return;
    if (event.composedPath().some(target => target instanceof Element && target.matches("button, a, input, select, textarea, [contenteditable]"))) return;
    const onVideo = event.target === video;
    if (onVideo && !videoContentPress(event)) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now(), mediaId: state.selectedMedia.id, onVideo };
    if (!onVideo) viewer.setPointerCapture(event.pointerId);
  });
  document.addEventListener("pointermove", event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = Math.abs(event.clientX - gesture.x), dy = Math.abs(event.clientY - gesture.y);
    if (zoomed() || event.defaultPrevented || (gesture.onVideo && nativeVideoPresentation()) || (dy > 14 && dy > dx)) { cancelGesture(); return; }
    // Leave native controls alone on press; claim only horizontal content motion.
    if (gesture.onVideo && dx > 14 && dx > dy * 1.5) {
      if (event.cancelable) event.preventDefault();
      try { viewer.setPointerCapture(event.pointerId); } catch { cancelGesture(); }
    }
  }, { capture: true, passive: false });
  document.addEventListener("pointerup", event => {
    pointers.delete(event.pointerId);
    if (!gesture || gesture.id !== event.pointerId) return;
    const previous = gesture;
    cancelGesture();
    const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
    if (!reviewOpen() || zoomed() || pointers.size || state.selectedMedia.id !== previous.mediaId) return;
    if (performance.now() - previous.time > 900 || Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    ignoredClick = { x: event.clientX, y: event.clientY, until: performance.now() + 400 };
    navigate(dx < 0 ? "older" : "newer");
  }, { capture: true, passive: true });
  // Suppress only the compatibility click belonging to this completed swipe.
  // The next pointerdown clears it; buttons outside the viewer are unaffected.
  viewer.addEventListener("click", event => {
    const previous = ignoredClick;
    ignoredClick = null;
    if (!previous || performance.now() > previous.until || event.detail === 0 || event.pointerType === "mouse"
      || Math.abs(event.clientX - previous.x) > 8 || Math.abs(event.clientY - previous.y) > 8) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
  document.addEventListener("pointercancel", event => {
    pointers.delete(event.pointerId);
    if (gesture?.id === event.pointerId) cancelGesture();
  }, { capture: true, passive: true });
  viewer.addEventListener("lostpointercapture", event => { if (event.target === viewer && gesture?.id === event.pointerId) cancelGesture(); });
  viewer.addEventListener("contextmenu", cancelGesture);
  for (const type of ["seeking", "volumechange", "ratechange"]) video.addEventListener(type, () => { if (gesture?.onVideo) cancelGesture(); });
  dialog.addEventListener("keydown", event => {
    if (!reviewOpen() || zoomed() || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
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
  document.addEventListener("fullscreenchange", viewportChanged);
  video.addEventListener("enterpictureinpicture", viewportChanged);
  video.addEventListener("leavepictureinpicture", viewportChanged);
  viewportChanged();
})();
