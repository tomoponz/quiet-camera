"use strict";

const CACHE_PREFIX = "quiet-camera-";
const CACHE_NAME = "quiet-camera-shell-v17";
const APP_SHELL = [
  "./",
  "./index.html",
  "./privacy.html",
  "./styles.css?v=20260815.3",
  "./fullscreen.css?v=20260815.3",
  "./camera-enhancements.css?v=20260815.3",
  "./storage.js?v=20260815.3",
  "./camera-ratio-model.js?v=20260815.3",
  "./core.js?v=20260815.3",
  "./photo.js?v=20260815.3",
  "./video.js?v=20260815.3",
  "./ui.js?v=20260815.3",
  "./fullscreen.js?v=20260815.3",
  "./camera-enhancements-core.js?v=20260815.3",
  "./camera-devices.js?v=20260815.3",
  "./camera-controls.js?v=20260815.3",
  "./camera-capture.js?v=20260815.3",
  "./camera-enhancements.js?v=20260815.3",
  "./manifest.webmanifest?v=20260815.3",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

async function cacheNetworkResponse(request, networkResponsePromise) {
  let response;
  try {
    response = await networkResponsePromise;
  } catch {
    return;
  }

  if (!response || response.status !== 200 || response.type !== "basic") return;

  try {
    const responseForCache = response.clone();
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, responseForCache);
  } catch (error) {
    // Cache Storage is best-effort. A quota/private-mode failure must never
    // turn a successful network response into an application failure.
    console.warn("Quiet Camera could not update its offline cache.", error);
  }
}

async function offlineFallback(request, networkError) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
  } catch (cacheError) {
    // Preserve the real network error; cache availability is optional.
    console.warn("Quiet Camera could not read its offline cache.", cacheError);
  }
  throw networkError;
}

function networkFirst(request) {
  const networkResponse = fetch(request);
  const cacheUpdate = cacheNetworkResponse(request, networkResponse);
  const response = networkResponse.catch((error) => offlineFallback(request, error));
  return {
    response,
    cacheUpdate,
  };
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  // Network-first keeps deployed JS/CSS fresh even when the cache name is unchanged.
  // Cached files remain available when the device is offline.
  const operation = networkFirst(event.request);
  event.respondWith(operation.response);
  event.waitUntil(operation.cacheUpdate);
});
