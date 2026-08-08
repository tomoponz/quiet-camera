const assert = require("node:assert/strict");
const model = require("../camera-controls.js");

const capabilities = {
  focusMode: ["continuous", "single-shot", "manual"],
  focusDistance: { min: 0, max: 10, step: 0.1 },
  zoom: { min: 1, max: 8, step: 0.1 },
  exposureCompensation: { min: -2, max: 2, step: 0.1 },
  torch: true,
  pointsOfInterest: true,
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
});
assert.deepEqual(pointPatch.pointsOfInterest, [{ x: 0.25, y: 0.75 }]);

const noPointCapabilities = { ...capabilities };
delete noPointCapabilities.pointsOfInterest;
const noPointPatch = model.buildManagedConstraintPatch(backToAuto, noPointCapabilities, {
  pointsOfInterest: [{ x: 0.25, y: 0.75 }],
});
assert.equal("pointsOfInterest" in noPointPatch, false, "point focus must remain capability-gated");

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

console.log("camera control model tests passed");
