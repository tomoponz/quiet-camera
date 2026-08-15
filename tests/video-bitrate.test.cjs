const assert = require("node:assert/strict");
const {
  calculateVideoBitsPerSecondFor,
  calculateRecordingByteBudget,
  chooseRecordedMimeType,
  recordingStartAllowed,
  getObservedRecordingBytes,
  recordingByteLimitReached,
  resetRecordingUiAfterStop,
  shouldRestartCameraAfterRecording,
  HARD_RECORDING_LIMIT_BYTES,
} = require("../video.js");

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

const webmChunk = new Blob(["webm"], { type: "video/webm;codecs=vp9" });
assert.equal(
  chooseRecordedMimeType([webmChunk], "", "video/mp4"),
  "video/webm;codecs=vp9",
  "actual BlobEvent type must override a rejected/requested MIME type",
);
assert.equal(chooseRecordedMimeType([], "video/mp4", "video/webm"), "video/mp4");
assert.equal(chooseRecordedMimeType([], "", ""), "video/webm");

assert.equal(recordingStartAllowed({ hasStream: true, busy: false, recorderState: null, finalizing: false }), true);
assert.equal(recordingStartAllowed({ hasStream: true, busy: false, recorderState: null, finalizing: true }), false, "finalization must block a new recording");
assert.equal(recordingStartAllowed({ hasStream: true, busy: false, recorderState: "recording", finalizing: false }), false);
assert.equal(recordingStartAllowed({ hasStream: true, busy: false, recorderState: "inactive", finalizing: false }), true);

const mebibyte = 1024 * 1024;
assert.throws(() => calculateRecordingByteBudget(44 * mebibyte), /保存容量/, "small free space must not promise an unfinalizable 20 MB recording");
assert.equal(calculateRecordingByteBudget(80 * mebibyte), 24 * mebibyte, "budget must reserve space for the final media copy");
assert.equal(calculateRecordingByteBudget(null), HARD_RECORDING_LIMIT_BYTES, "unknown quota keeps the hard safety cap");
assert.equal(calculateRecordingByteBudget(4 * 1024 * mebibyte), HARD_RECORDING_LIMIT_BYTES, "large quotas must still respect the hard safety cap");

assert.equal(getObservedRecordingBytes(8 * mebibyte, 25 * mebibyte), 25 * mebibyte, "queued BlobEvents must count before IndexedDB catches up");
assert.equal(recordingByteLimitReached(8 * mebibyte, 25 * mebibyte, 20 * mebibyte), true, "pending chunks must trigger the capacity stop");
assert.equal(recordingByteLimitReached(19 * mebibyte, 19 * mebibyte, 20 * mebibyte), false);
assert.equal(shouldRestartCameraAfterRecording({ hasStream: false, visibilityState: "visible" }), true);
assert.equal(shouldRestartCameraAfterRecording({ hasStream: true, visibilityState: "visible" }), false);
assert.equal(shouldRestartCameraAfterRecording({ hasStream: false, visibilityState: "hidden" }), false);

let removedRecordingClass = false;
let clearedTimer = null;
let shutterLabel = "";
global.state = { recordingTimerId: 41, recordingStartedAt: 0, recordingDurationMs: 0 };
global.window = { clearInterval: (timer) => { clearedTimer = timer; } };
global.elements = {
  recordingBadge: { hidden: false },
  shutterButton: {
    disabled: false,
    classList: { remove: (name) => { removedRecordingClass = name === "recording"; } },
    setAttribute: (name, value) => { if (name === "aria-label") shutterLabel = value; },
  },
};
resetRecordingUiAfterStop();
assert.equal(clearedTimer, 41, "external recorder stop must clear the recording clock");
assert.equal(global.elements.recordingBadge.hidden, true);
assert.equal(removedRecordingClass, true);
assert.equal(global.elements.shutterButton.disabled, true);
assert.match(shutterLabel, /録画/);
delete global.state;
delete global.window;
delete global.elements;

console.log("video bitrate tests passed");
