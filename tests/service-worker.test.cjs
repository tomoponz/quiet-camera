const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "..", "service-worker.js"), "utf8");

function createHarness({ fetchImpl, cachesImpl }) {
  const listeners = new Map();
  const warnings = [];
  const context = {
    URL,
    caches: cachesImpl,
    fetch: fetchImpl,
    console: {
      warn: (...args) => warnings.push(args),
    },
    self: {
      location: { origin: "https://example.test" },
      clients: { claim: async () => {} },
      skipWaiting: async () => {},
      addEventListener: (type, listener) => listeners.set(type, listener),
    },
  };

  vm.runInNewContext(source, context, { filename: "service-worker.js" });
  return { listeners, warnings };
}

function dispatchFetch(harness, request) {
  let responsePromise;
  let lifetimePromise;
  harness.listeners.get("fetch")({
    request,
    respondWith: (promise) => { responsePromise = Promise.resolve(promise); },
    waitUntil: (promise) => { lifetimePromise = Promise.resolve(promise); },
  });
  assert.ok(responsePromise, "same-origin GET must provide a response");
  assert.ok(lifetimePromise, "cache update must extend the fetch event lifetime");
  return { responsePromise, lifetimePromise };
}

function makeNetworkResponse() {
  const cachedCopy = { source: "network-clone" };
  return {
    response: {
      status: 200,
      type: "basic",
      source: "network",
      clone: () => cachedCopy,
    },
    cachedCopy,
  };
}

async function testCacheOpenFailureDoesNotReplaceNetworkResponse() {
  const { response } = makeNetworkResponse();
  const cacheError = new Error("CacheStorage unavailable");
  const harness = createHarness({
    fetchImpl: async () => response,
    cachesImpl: {
      open: async () => { throw cacheError; },
      keys: async () => [],
    },
  });
  const request = { method: "GET", mode: "cors", url: "https://example.test/quiet-camera/app.js" };
  const operation = dispatchFetch(harness, request);

  assert.equal(await operation.responsePromise, response, "successful network response must win");
  await operation.lifetimePromise;
  assert.equal(harness.warnings.length, 1, "cache failure should be reported without rejecting the fetch");
}

async function testQuotaFailureDoesNotReplaceNetworkResponse() {
  const { response, cachedCopy } = makeNetworkResponse();
  const quotaError = Object.assign(new Error("quota exceeded"), { name: "QuotaExceededError" });
  let putRequest = null;
  let putResponse = null;
  const harness = createHarness({
    fetchImpl: async () => response,
    cachesImpl: {
      open: async () => ({
        match: async () => null,
        put: async (request, value) => {
          putRequest = request;
          putResponse = value;
          throw quotaError;
        },
      }),
      keys: async () => [],
    },
  });
  const request = { method: "GET", mode: "cors", url: "https://example.test/quiet-camera/styles.css" };
  const operation = dispatchFetch(harness, request);

  assert.equal(await operation.responsePromise, response, "cache quota must not make an online request stale or fail");
  await operation.lifetimePromise;
  assert.equal(putRequest, request);
  assert.equal(putResponse, cachedCopy);
  assert.equal(harness.warnings.length, 1);
}

async function testOfflineRequestUsesCache() {
  const networkError = new Error("offline");
  const cachedResponse = { source: "cache" };
  const request = { method: "GET", mode: "cors", url: "https://example.test/quiet-camera/app.js" };
  const harness = createHarness({
    fetchImpl: async () => { throw networkError; },
    cachesImpl: {
      open: async () => ({
        match: async (candidate) => candidate === request ? cachedResponse : null,
        put: async () => {},
      }),
      keys: async () => [],
    },
  });
  const operation = dispatchFetch(harness, request);

  assert.equal(await operation.responsePromise, cachedResponse);
  await operation.lifetimePromise;
  assert.equal(harness.warnings.length, 0);
}

(async () => {
  await testCacheOpenFailureDoesNotReplaceNetworkResponse();
  await testQuotaFailureDoesNotReplaceNetworkResponse();
  await testOfflineRequestUsesCache();
  console.log("service worker resilience tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
