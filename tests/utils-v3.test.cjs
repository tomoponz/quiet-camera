const assert = require("node:assert/strict");
const { calculateCrop, mapCoverPoint, formatDuration, createTimestampName, randomId } = require("../utils-v3.js");

assert.deepEqual(calculateCrop(1920, 1080, 1), { sx: 420, sy: 0, sw: 1080, sh: 1080 });
assert.deepEqual(calculateCrop(1080, 1920, 16 / 9), { sx: 0, sy: 656, sw: 1080, sh: 608 });

const center = mapCoverPoint({
  clientX: 150,
  clientY: 300,
  rect: { left: 0, top: 0, width: 300, height: 600 },
  sourceWidth: 1920,
  sourceHeight: 1080,
});
assert.equal(Math.round(center.normalized.x * 100), 50);
assert.equal(Math.round(center.normalized.y * 100), 50);

const mirrored = mapCoverPoint({
  clientX: 0,
  clientY: 300,
  rect: { left: 0, top: 0, width: 300, height: 600 },
  sourceWidth: 1920,
  sourceHeight: 1080,
  mirrored: true,
});
assert.ok(mirrored.pixel.x > 960);
assert.equal(formatDuration(65_000), "01:05");
assert.equal(createTimestampName("test", "jpg", new Date(2026, 7, 3, 1, 2, 3)), "test_20260803_010203.jpg");
assert.match(randomId(), /^[0-9a-f-]{36}$/);
console.log("utils-v3 tests passed");
