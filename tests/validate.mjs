import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("index.html");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const scripts = [
  "storage.js",
  "core.js",
  "photo.js",
  "video.js",
  "ui.js",
  "fullscreen.js",
  "camera-enhancements-core.js",
  "camera-devices.js",
  "camera-controls.js",
  "camera-capture.js",
  "camera-enhancements.js",
];
const styles = ["styles.css", "fullscreen.css", "camera-enhancements.css"];
const missingFiles = [...scripts, ...styles].filter((file) => !fs.existsSync(path.join(root, file)));
if (missingFiles.length) throw new Error(`Missing assets: ${missingFiles.join(", ")}`);

const combined = scripts.map(read).join("\n");
const selectors = [...combined.matchAll(/querySelector\("#([^"]+)"\)/g)].map((match) => match[1]);
const missingIds = [...new Set(selectors.filter((id) => !ids.has(id)))];
if (missingIds.length) throw new Error(`Missing DOM IDs: ${missingIds.join(", ")}`);

const serviceWorker = read("service-worker.js");
for (const file of ["index.html", "privacy.html", ...styles, ...scripts, "manifest.webmanifest", "icons/icon.svg"]) {
  if (!serviceWorker.includes(`./${file}`)) throw new Error(`Service worker does not cache ${file}`);
}
if (!serviceWorker.includes('const CACHE_PREFIX = "quiet-camera-"')) throw new Error("Cache cleanup must be scoped to Quiet Camera");
if (!serviceWorker.includes("key.startsWith(CACHE_PREFIX)")) throw new Error("Service worker may delete caches belonging to other apps");
if (!serviceWorker.includes("networkFirst(event.request)")) throw new Error("Static app assets must use network-first refresh behavior");

const htmlScripts = [...html.matchAll(/<script src="\.\/([^"]+)"/g)].map((match) => match[1]);
if (JSON.stringify(htmlScripts) !== JSON.stringify(scripts)) {
  throw new Error(`Unexpected script order: ${htmlScripts.join(", ")}`);
}

const htmlStyles = [...html.matchAll(/<link rel="stylesheet" href="\.\/([^"]+)"/g)].map((match) => match[1]);
if (JSON.stringify(htmlStyles) !== JSON.stringify(styles)) {
  throw new Error(`Unexpected stylesheet order: ${htmlStyles.join(", ")}`);
}

for (const requiredId of [
  "fullscreenButton",
  "settingsButton",
  "settingsDialog",
  "cameraSourceSelect",
  "manualFocusRange",
  "focusResetButton",
  "exposureIndexRange",
  "exposureResetButton",
]) {
  if (!ids.has(requiredId)) throw new Error(`Missing required control: ${requiredId}`);
}

const fullscreenCss = read("fullscreen.css");
if (!fullscreenCss.includes("immersive-mode")) throw new Error("Missing immersive fullscreen styles");

const controlJs = read("camera-controls.js");
for (const feature of [
  "QuietCameraControlModel",
  "buildManagedConstraintPatch",
  "cameraControlQueue",
  "applyManagedCameraControls",
  "initializeCameraController",
  "initializeAutofocus",
  "scheduleManualFocus",
  "scheduleExposureIndex",
  "enhancedToggleTorch",
  "pointsOfInterest",
]) {
  if (!controlJs.includes(feature)) throw new Error(`Missing unified camera-control feature: ${feature}`);
}
if (controlJs.includes("focusRetryTimers")) throw new Error("Blind autofocus retry timers must not return");
if (controlJs.includes("pulse =")) throw new Error("Manual-focus pulse workaround must not return");
if (!controlJs.includes("Do not claim physical focus success")) throw new Error("Tap focus UI must not claim unverified physical focus success");

const deviceJs = read("camera-devices.js");
for (const feature of ["enumerateDevices", "devicechange", "selectedDeviceId", "NotReadableError", "initializeCameraController"]) {
  if (!(deviceJs + read("camera-enhancements.js")).includes(feature)) throw new Error(`Missing camera-device feature: ${feature}`);
}
if (!deviceJs.includes('focusMode = { ideal: "continuous" }')) throw new Error("Initial continuous AF preference is missing");

const photoJs = read("photo.js");
if (!photoJs.includes("ImageCapture") || !photoJs.includes("takePhoto")) throw new Error("High-resolution photo capture is missing");
if (!photoJs.includes("calculateCrop(photoSource.width, photoSource.height, getVisiblePhotoRatio())")) {
  throw new Error("High-resolution stills must be cropped to the visible preview ratio");
}
if (photoJs.includes("Math.abs(sourceRatio - previewRatio)")) throw new Error("High-resolution stills must not be discarded only because their sensor ratio differs");
const captureAdapter = read("camera-capture.js");
if (!captureAdapter.includes("Q.enhancedCapturePhoto = capturePhoto")) throw new Error("Capture adapter must use the canonical photo implementation");
if (captureAdapter.includes("context.drawImage")) throw new Error("Duplicate photo capture implementation returned");

const videoJs = read("video.js");
if (!videoJs.includes("VIDEO_BITRATE_BASE_1080P30")) throw new Error("Video quality presets are not independently defined");
if (!videoJs.includes("512 * 1024 * 1024")) throw new Error("Recording finalization safety cap must remain 512 MB");
if (!videoJs.includes("validateVideoBlob")) throw new Error("Recorded and recovered video must be validated before success");

const storageJs = read("storage.js");
for (const feature of ["DB_VERSION = 2", "listStoredMediaPage", "countStoredMedia", "requestPersistentStorage", "versionchange", "blocked"]) {
  if (!storageJs.includes(feature)) throw new Error(`Missing storage reliability feature: ${feature}`);
}
if (!storageJs.includes("DEFAULT_MEDIA_PAGE_SIZE = 60")) throw new Error("Gallery startup must remain paged");

const enhancementJs = read("camera-enhancements.js");
if (!enhancementJs.includes("elements.settingsDialog.show();")) {
  throw new Error("Mobile settings must remain non-modal so the camera preview stays usable");
}
if (!enhancementJs.includes("refreshPagedGallery")) throw new Error("Paged gallery wiring is missing");
if (!enhancementJs.includes("requestPersistentStorage")) throw new Error("Persistent storage is not requested");
if (!enhancementJs.includes('removeEventListener("click", Q.originalToggleTorch)')) {
  throw new Error("Legacy torch handler must be replaced by unified camera controls");
}

const enhancementCss = read("camera-enhancements.css");
if (!enhancementCss.includes("#settingsSheetBody .settings-panel")) throw new Error("Mobile settings sheet does not expose the settings panel");
if (!enhancementCss.includes("#exposureControl") || !enhancementCss.includes("display: none !important")) {
  throw new Error("Legacy floating exposure control must stay hidden");
}
if (enhancementCss.includes(".live-camera-controls .range-setting")) {
  throw new Error("Manual camera controls must not cover the live preview");
}

const workflow = read(".github/workflows/validate.yml");
for (const file of scripts) {
  if (!workflow.includes(file)) throw new Error(`CI syntax check does not cover ${file}`);
}
if (!workflow.includes("tests/camera-controls.test.cjs") || !workflow.includes("tests/video-bitrate.test.cjs")) {
  throw new Error("Regression tests are not wired into CI");
}

console.log(`Validated ${ids.size} DOM IDs, ${selectors.length} selector references, ${scripts.length} scripts, storage paging, unified controls, capture quality, video safety, and PWA cache isolation.`);
