const assert = require("node:assert/strict");
const model = require("../camera-controls.js");

const capabilities = {
  focusMode: ["continuous", "single-shot", "manual"],
  focusDistance: { min: 0, max: 10, step: 0.1 },
  zoom: { min: 1, max: 8, step: 0.1 },
  exposureCompensation: { min: -2, max: 2, step: 0.1 },
  torch: true,
};

const initial = {
  focusMode: "continuous",
  zoom: 2,
  exposureCompensation: 0,
  torch: false,
};

const exposureChange = model.mergeDesired(initial, { exposureCompensation: 1.2 });
const exposurePatch = model.buildManagedConstraintPatch(exposureChange, capabilities);
assert.equal(exposurePatch.focusMode, "continuous", "changing exposure must preserve AF mode");
assert.equal(exposurePatch.zoom, 2, "changing exposure must preserve zoom");
assert.equal(exposurePatch.exposureCompensation, 1.2);
assert.equal(exposurePatch.torch, false, "changing exposure must preserve torch state");

const zoomChange = model.mergeDesired(exposureChange, { zoom: 4.4 });
const zoomPatch = model.buildManagedConstraintPatch(zoomChange, capabilities);
assert.equal(zoomPatch.focusMode, "continuous", "changing zoom must preserve AF mode");
assert.equal(zoomPatch.exposureCompensation, 1.2, "changing zoom must preserve exposure");
assert.equal(zoomPatch.zoom, 4.4);

const manual = model.mergeDesired(zoomChange, { focusMode: "manual", focusDistance: 6.5 });
const manualPatch = model.buildManagedConstraintPatch(manual, capabilities);
assert.equal(manualPatch.focusMode, "manual");
assert.equal(manualPatch.focusDistance, 6.5);

const backToAuto = model.mergeDesired(manual, { focusMode: "continuous" });
assert.equal("focusDistance" in backToAuto, false, "leaving manual focus must remove stale focusDistance");

const pointPatch = model.buildManagedConstraintPatch(backToAuto, capabilities, {
  pointsOfInterest: [{ x: 0.25, y: 0.75 }],
}, { pointsOfInterest: true });
assert.deepEqual(pointPatch.pointsOfInterest, [{ x: 0.25, y: 0.75 }]);

const noPointPatch = model.buildManagedConstraintPatch(backToAuto, capabilities, {
  pointsOfInterest: [{ x: 0.25, y: 0.75 }],
});
assert.equal("pointsOfInterest" in noPointPatch, false, "point focus must be gated by getSupportedConstraints");

const misleadingCapabilityPatch = model.buildManagedConstraintPatch(backToAuto, {
  ...capabilities,
  pointsOfInterest: true,
}, {
  pointsOfInterest: [{ x: 0.25, y: 0.75 }],
}, { pointsOfInterest: false });
assert.equal("pointsOfInterest" in misleadingCapabilityPatch, false, "capabilities must not be used as the POI support signal");

const noTorchCapabilities = { ...capabilities, torch: false };
const noTorchPatch = model.buildManagedConstraintPatch(initial, noTorchCapabilities);
assert.equal("torch" in noTorchPatch, false, "unsupported torch capability must not be sent");

const clamped = model.buildManagedConstraintPatch({ ...initial, zoom: 100, exposureCompensation: -100 }, capabilities);
assert.equal(clamped.zoom, 8);
assert.equal(clamped.exposureCompensation, -2);

const baseConstraints = {
  deviceId: { exact: "rear-main" },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30 },
  focusMode: { ideal: "continuous" },
  advanced: [
    { zoom: 1.5, exposureCompensation: 0 },
    { aspectRatio: 16 / 9 },
  ],
};
const [basicAttempt, advancedAttempt] = model.buildConstraintAttempts(baseConstraints, exposurePatch);
assert.deepEqual(basicAttempt.deviceId, { exact: "rear-main" }, "deviceId must survive camera-control updates");
assert.deepEqual(basicAttempt.width, { ideal: 1920 }, "resolution constraints must survive camera-control updates");
assert.deepEqual(basicAttempt.height, { ideal: 1080 });
assert.deepEqual(basicAttempt.frameRate, { ideal: 30 }, "frame-rate constraint must survive camera-control updates");
assert.equal(basicAttempt.focusMode, "continuous", "managed focus must replace stale base focus constraints");
assert.equal(basicAttempt.exposureCompensation, 1.2);
assert.equal(advancedAttempt.advanced.at(-1).focusMode, "continuous");
assert.equal(advancedAttempt.advanced.at(-1).exposureCompensation, 1.2);
assert.equal(advancedAttempt.advanced[0].aspectRatio, 16 / 9, "unrelated advanced stream constraints must be preserved");
assert.equal("zoom" in advancedAttempt.advanced[0], false, "stale managed controls must be stripped from preserved advanced constraints");

const offsetRange = model.createIndexedCapabilityRange({ min: -1.3, max: 1.7, step: 0.5 });
assert.deepEqual(
  { minIndex: offsetRange.minIndex, maxIndex: offsetRange.maxIndex, zeroOffset: offsetRange.zeroOffset },
  { minIndex: -3, maxIndex: 3, zeroOffset: 3 },
  "exposure indices must be anchored to capability.min instead of zero",
);
assert.equal(model.capabilityValueForIndex(offsetRange, offsetRange.minIndex), -1.3);
assert.equal(model.capabilityValueForIndex(offsetRange, 0), 0.2, "reset index should select the closest supported value to zero");
assert.equal(model.capabilityValueForIndex(offsetRange, offsetRange.maxIndex), 1.7);
assert.equal(model.capabilityIndexForValue(offsetRange, -1.3), offsetRange.minIndex);
assert.equal(model.capabilityIndexForValue(offsetRange, 1.7), offsetRange.maxIndex);

const liveTrack = { readyState: "live" };
assert.equal(model.isControlContextCurrent(liveTrack, 3, liveTrack, 3), true);
assert.equal(model.isControlContextCurrent(liveTrack, 2, liveTrack, 3), false, "old generations must be stale");
assert.equal(model.isControlContextCurrent(liveTrack, 3, { readyState: "live" }, 3), false, "old tracks must be stale");
liveTrack.readyState = "ended";
assert.equal(model.isControlContextCurrent(liveTrack, 3, liveTrack, 3), false, "ended tracks must be stale");

async function testLatestTaskRunner() {
  const calls = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const runner = model.createLatestTaskRunner(async (value) => {
    calls.push(value);
    if (value === 1) await firstBlocked;
  });

  const completion = runner.submit(1);
  runner.submit(2);
  runner.submit(3);
  releaseFirst();
  await completion;
  assert.deepEqual(calls, [1, 3], "rapid controls must retain only the latest pending value");

  const clearedCalls = [];
  let releaseClearTest;
  const clearBlock = new Promise((resolve) => { releaseClearTest = resolve; });
  const clearableRunner = model.createLatestTaskRunner(async (value) => {
    clearedCalls.push(value);
    if (value === "active") await clearBlock;
  });
  const clearCompletion = clearableRunner.submit("active");
  clearableRunner.submit("stale");
  clearableRunner.clear();
  releaseClearTest();
  await clearCompletion;
  assert.deepEqual(clearedCalls, ["active"], "controller invalidation must drop queued control values");
}

testLatestTaskRunner()
  .then(() => console.log("camera control model tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
