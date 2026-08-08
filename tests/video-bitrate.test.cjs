const assert = require("node:assert/strict");
const { calculateVideoBitsPerSecondFor, HARD_RECORDING_LIMIT_BYTES } = require("../video.js");

const economy1080 = calculateVideoBitsPerSecondFor(1920, 1080, 30, "economy");
const standard1080 = calculateVideoBitsPerSecondFor(1920, 1080, 30, "standard");
const high1080 = calculateVideoBitsPerSecondFor(1920, 1080, 30, "high");

assert.ok(economy1080 < standard1080 && standard1080 < high1080, "1080p quality presets must produce distinct bitrates");
assert.ok(economy1080 >= 1_500_000, "economy bitrate should remain usable");
assert.ok(high1080 <= 28_000_000, "high bitrate must respect recorder safety cap");

const standard720 = calculateVideoBitsPerSecondFor(1280, 720, 30, "standard");
const standard1080_60 = calculateVideoBitsPerSecondFor(1920, 1080, 60, "standard");
assert.ok(standard720 < standard1080, "720p should use less bitrate than 1080p");
assert.ok(standard1080_60 > standard1080, "60fps should use more bitrate than 30fps");
assert.equal(HARD_RECORDING_LIMIT_BYTES, 512 * 1024 * 1024);

console.log("video bitrate tests passed");
