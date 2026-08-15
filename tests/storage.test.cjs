const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "..", "storage.js"), "utf8");

class FakeRequest {
  constructor() {
    this.listeners = new Map();
    this.result = null;
    this.error = null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) listener({ type, target: this });
  }
}

async function testBlockedOpenRemainsSharedUntilSuccess() {
  const requests = [];
  const warnings = [];
  const toasts = [];
  const databaseListeners = new Map();
  let databaseCloseCalls = 0;
  const database = {
    addEventListener: (type, listener) => databaseListeners.set(type, listener),
    close: () => { databaseCloseCalls += 1; },
  };
  const context = {
    console: {
      warn: (...args) => warnings.push(args),
    },
    indexedDB: {
      open: () => {
        const request = new FakeRequest();
        requests.push(request);
        return request;
      },
    },
    showToast: (message) => toasts.push(message),
  };

  vm.runInNewContext(source, context, { filename: "storage.js" });

  const firstOpen = context.openDatabase();
  const retryWhileBlocked = context.openDatabase();
  assert.equal(requests.length, 1, "concurrent opens must share one IndexedDB request");
  assert.equal(firstOpen, retryWhileBlocked, "concurrent opens must share one promise");

  let settled = false;
  firstOpen.finally(() => { settled = true; });
  requests[0].dispatch("blocked");
  await Promise.resolve();
  assert.equal(settled, false, "blocked is progress and must not reject the live open request");
  assert.equal(warnings.length, 1);
  assert.equal(toasts.length, 1);
  assert.equal(context.openDatabase(), firstOpen, "retry after blocked must not queue another request");
  assert.equal(requests.length, 1);

  requests[0].result = database;
  requests[0].dispatch("success");
  assert.equal(await firstOpen, database);
  assert.equal(await retryWhileBlocked, database);

  databaseListeners.get("versionchange")();
  assert.equal(databaseCloseCalls, 1, "versionchange must close the old connection");
  context.openDatabase();
  assert.equal(requests.length, 2, "a closed/version-changed connection must be reopened cleanly");
}

testBlockedOpenRemainsSharedUntilSuccess()
  .then(() => console.log("storage blocked-open tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
