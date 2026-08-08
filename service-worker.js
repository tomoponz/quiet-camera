"use strict";

const CACHE_PREFIX = "quiet-camera-";
const CACHE_NAME = "quiet-camera-shell-v9";
const APP_SHELL = [
  "./",
  "./index.html",
  "./privacy.html",
  "./styles.css",
  "./fullscreen.css",
  "./camera-enhancements.css",
  "./storage.js",
  "./core.js",
  "./photo.js",
  "./video.js",
  "./ui.js",
  "./fullscreen.js",
  "./camera-enhancements-core.js",
  "./camera-devices.js",
  "./camera-controls.js",
  "./camera-capture.js",
  "./camera-enhancements.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
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

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === "basic") {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  // Network-first keeps deployed JS/CSS fresh even when the cache name is unchanged.
  // Cached files remain available when the device is offline.
  event.respondWith(networkFirst(event.request));
});
