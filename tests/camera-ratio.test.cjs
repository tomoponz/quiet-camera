"use strict";

const assert = require("node:assert/strict");
const model = require("../camera-ratio-model.js");

assert.deepEqual([...model.RATIO_SEQUENCE], ["4:3", "1:1", "16:9"]);
assert.equal(model.ratioValue("4:3"), 4 / 3);
assert.equal(model.ratioValue("1:1"), 1);
assert.equal(model.ratioValue("16:9"), 16 / 9);

assert.equal(model.targetTrackAspectRatio("4:3"), 4 / 3);
assert.equal(model.targetTrackAspectRatio("1:1"), 1);
assert.equal(model.targetTrackAspectRatio("16:9"), 16 / 9);

assert.equal(model.normalizedTrackAspectRatio({ width: 1440, height: 2560 }), 16 / 9);
assert.equal(model.normalizedTrackAspectRatio({ aspectRatio: 0.75 }), 4 / 3);
assert.equal(model.normalizedTrackAspectRatio({ width: 1080, height: 1080 }), 1);
assert.equal(model.normalizedTrackAspectRatio({}), null);

assert.equal(model.approximatelyMatches(1.34, 4 / 3), true);
assert.equal(model.approximatelyMatches(16 / 9, 4 / 3), false);
assert.equal(model.closestRatioLabel(1.02), "1:1");
assert.equal(model.closestRatioLabel(1.32), "4:3");
assert.equal(model.closestRatioLabel(1.76), "16:9");
assert.equal(model.closestRatioLabel(null), null);

console.log("Camera ratio model tests passed.");
