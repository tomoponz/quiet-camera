"use strict";

(() => {
  const posterCache = new Map();
  const queue = [];
  let decoding = false;
  let galleryController = new AbortController();
  let galleryObserver = null;
  let reviewController = null;
  let reviewPosterUrl = null;
  let removeReviewListeners = () => {};
  const video = elements.reviewVideo;
  const viewer = document.querySelector("#reviewViewer");
  const status = document.querySelector("#reviewVideoStatus");
  const abortError = () => new DOMException("Preview cancelled", "AbortError");

  function waitForVideo(target, event, ready, signal, timeout = 5000) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        target.removeEventListener(event, check);
        target.removeEventListener("error", failed);
        signal?.removeEventListener("abort", cancelled);
      };
      const check = () => { if (ready()) { cleanup(); resolve(); } };
      const failed = () => { cleanup(); reject(new Error("Video frame could not be decoded")); };
      const cancelled = () => { cleanup(); reject(abortError()); };
      target.addEventListener(event, check);
      target.addEventListener("error", failed, { once: true });
      signal?.addEventListener("abort", cancelled, { once: true });
      timer = setTimeout(() => { cleanup(); reject(new Error("Video preview timed out")); }, timeout);
    });
  }

  async function createPoster(blob, { signal, duration: durationHint } = {}) {
    if (signal?.aborted) throw abortError();
    const source = document.createElement("video");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, 7000);
    const url = URL.createObjectURL(blob);
    source.muted = true;
    source.playsInline = true;
    source.preload = "auto";
    source.setAttribute("aria-hidden", "true");
    source.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.append(source);
    try {
      source.src = url;
      source.load();
      await waitForVideo(source, "loadeddata", () => source.readyState >= 2 && source.videoWidth > 0 && source.videoHeight > 0, controller.signal);
      const width = source.videoWidth, height = source.videoHeight;
      const scale = Math.min(1, 480 / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Video preview canvas unavailable");
      const snapshot = async () => {
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        return canvasToBlob(canvas, "image/jpeg", 0.8);
      };
      let frame = await snapshot();
      let time = 0;
      // A short seek avoids the uninitialised/black first frame common in recordings.
      const duration = Number.isFinite(source.duration) && source.duration > 0 ? source.duration : durationHint;
      const target = Number.isFinite(duration) && duration > 0 ? Math.min(0.5, duration / 2) : 0.5;
      try {
        source.currentTime = target;
        await waitForVideo(source, "seeked", () => !source.seeking && source.readyState >= 2 && Math.abs(source.currentTime - target) < 0.15, controller.signal, 1800);
        frame = await snapshot();
        time = source.currentTime;
      } catch (error) {
        if (signal?.aborted || controller.signal.aborted) throw error;
        // Some otherwise playable formats cannot seek. Retain the decoded first frame.
      }
      if (signal?.aborted || controller.signal.aborted) throw abortError();
      return { blob: frame, width, height, time };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      source.pause();
      source.removeAttribute("src");
      source.load();
      source.remove();
      URL.revokeObjectURL(url);
    }
  }

  function pump() {
    if (decoding || !queue.length) return;
    const job = queue.shift();
    if (job.signal?.aborted) { job.reject(abortError()); pump(); return; }
    decoding = true;
    createPoster(job.media.blob, { signal: job.signal, duration: job.media.duration / 1000 }).then(job.resolve, job.reject).finally(() => { decoding = false; pump(); });
  }

  function requestPoster(media, signal, priority = false) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (media.thumbnailBlob?.type.startsWith("image/")) return Promise.resolve({ blob: media.thumbnailBlob, width: media.width, height: media.height, time: media.thumbnailTime || 0 });
    const key = `${media.id}:${media.createdAt}:${media.blob.size}:${media.blob.type}`;
    if (posterCache.has(key)) {
      const cached = posterCache.get(key);
      posterCache.delete(key); posterCache.set(key, cached);
      return Promise.resolve(cached);
    }
    return new Promise((resolve, reject) => {
      const job = { media, signal, resolve, reject };
      priority ? queue.unshift(job) : queue.push(job);
      pump();
    }).then(result => {
      if (signal?.aborted) throw abortError();
      posterCache.set(key, result);
      while (posterCache.size > 24) posterCache.delete(posterCache.keys().next().value);
      return result;
    });
  }

  function clearGallery() {
    galleryController.abort();
    galleryController = new AbortController();
    galleryObserver?.disconnect();
    galleryObserver = null;
  }

  function mountGallery(media, visual) {
    const signal = galleryController.signal;
    const placeholder = document.createElement("span");
    placeholder.className = "video-thumbnail-placeholder";
    placeholder.textContent = "動画プレビューを読込中…";
    const badge = document.createElement("span");
    badge.className = "video-thumbnail-badge";
    badge.textContent = "▶ VIDEO";
    visual.classList.add("video-thumbnail");
    visual.append(placeholder, badge);
    const load = async () => {
      try {
        const poster = await requestPoster(media, signal);
        if (signal.aborted || !visual.isConnected) return;
        const image = document.createElement("img");
        image.alt = "撮影した動画のプレビュー";
        image.decoding = "async";
        image.addEventListener("load", () => { if (!signal.aborted) placeholder.hidden = true; }, { once: true });
        image.addEventListener("error", () => { image.remove(); placeholder.hidden = false; placeholder.textContent = "動画を開いて確認"; }, { once: true });
        const url = URL.createObjectURL(poster.blob);
        state.galleryObjectUrls.set(media.id, url);
        image.src = url;
        visual.prepend(image);
      } catch (error) {
        if (!signal.aborted) placeholder.textContent = "プレビュー取得不可・動画を開いて確認";
      }
    };
    if (media.thumbnailBlob || typeof IntersectionObserver !== "function") load();
    else {
      galleryObserver ||= new IntersectionObserver(entries => {
        if (signal.aborted) return;
        for (const entry of entries) if (entry.isIntersecting) { galleryObserver?.unobserve(entry.target); entry.target.__loadVideoPoster?.(); delete entry.target.__loadVideoPoster; }
      }, { root: elements.galleryDialog, rootMargin: "160px" });
      visual.__loadVideoPoster = load;
      galleryObserver.observe(visual);
    }
  }

  function clearReview() {
    reviewController?.abort();
    reviewController = null;
    removeReviewListeners();
    removeReviewListeners = () => {};
    video.removeAttribute("poster");
    video.style.removeProperty("aspect-ratio");
    if (reviewPosterUrl) URL.revokeObjectURL(reviewPosterUrl);
    reviewPosterUrl = null;
    status.hidden = true;
    viewer.classList.remove("is-video-review");
  }

  function showReview(media) {
    clearReview();
    const controller = new AbortController();
    reviewController = controller;
    viewer.classList.add("is-video-review");
    video.style.aspectRatio = media.width && media.height ? `${media.width} / ${media.height}` : "16 / 9";
    status.textContent = "動画プレビューを読込中…";
    status.hidden = false;
    const metadata = () => { if (!controller.signal.aborted && video.videoWidth && video.videoHeight) video.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`; };
    const failed = () => { if (!controller.signal.aborted) { status.textContent = "動画を読み込めませんでした。端末に保存して確認できます。"; status.hidden = false; } };
    const playing = () => { if (!controller.signal.aborted) status.hidden = true; };
    video.addEventListener("loadedmetadata", metadata);
    video.addEventListener("error", failed);
    video.addEventListener("playing", playing);
    removeReviewListeners = () => { video.removeEventListener("loadedmetadata", metadata); video.removeEventListener("error", failed); video.removeEventListener("playing", playing); };
    requestPoster(media, controller.signal, true).then(poster => {
      if (controller.signal.aborted || state.selectedMedia?.id !== media.id) return;
      reviewPosterUrl = URL.createObjectURL(poster.blob);
      video.poster = reviewPosterUrl;
      if (poster.width && poster.height && !video.videoWidth) video.style.aspectRatio = `${poster.width} / ${poster.height}`;
      status.hidden = true;
      if (video.error) failed();
    }).catch(error => {
      if (!controller.signal.aborted) { status.textContent = "プレビューを取得できませんでした。再生ボタンで確認してください。"; status.hidden = false; if (video.error) failed(); }
    });
    video.load();
  }

  window.QuietCameraVideoPreview = { createPoster, mountGallery, clearGallery, showReview, clearReview };
})();
