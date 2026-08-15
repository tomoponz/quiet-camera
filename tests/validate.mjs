import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("index.html");
const privacyHtml = read("privacy.html");
const manifest = JSON.parse(read("manifest.webmanifest"));
const idValues = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const ids = new Set(idValues);
const duplicateIds = [...new Set(idValues.filter((id, index) => idValues.indexOf(id) !== index))];
if (duplicateIds.length) throw new Error(`Duplicate DOM IDs: ${duplicateIds.join(", ")}`);
const scripts = [
  "storage.js",
  "camera-ratio-model.js",
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
for (const file of ["index.html", "privacy.html", ...styles, ...scripts, "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"]) {
  if (!serviceWorker.includes(`./${file}`)) throw new Error(`Service worker does not cache ${file}`);
}
if (!serviceWorker.includes('const CACHE_PREFIX = "quiet-camera-"')) throw new Error("Cache cleanup must be scoped to Quiet Camera");
if (!serviceWorker.includes("key.startsWith(CACHE_PREFIX)")) throw new Error("Service worker may delete caches belonging to other apps");
if (!serviceWorker.includes("networkFirst(event.request)")) throw new Error("Static app assets must use network-first refresh behavior");
const assetVersion = "20260815.3";
for (const file of [...styles, ...scripts, "manifest.webmanifest"]) {
  if (!html.includes(`./${file}?v=${assetVersion}`)) throw new Error(`HTML asset version is stale: ${file}`);
  if (!serviceWorker.includes(`./${file}?v=${assetVersion}`)) throw new Error(`Service worker asset version is stale: ${file}`);
}
if (!serviceWorker.includes('const CACHE_NAME = "quiet-camera-shell-v17"')) throw new Error("Service worker cache version is stale");
if (!privacyHtml.includes(`./styles.css?v=${assetVersion}`)) throw new Error("Privacy page asset version is stale");

const htmlScripts = [...html.matchAll(/<script src="\.\/([^"]+)"/g)].map((match) => match[1].split("?")[0]);
if (JSON.stringify(htmlScripts) !== JSON.stringify(scripts)) {
  throw new Error(`Unexpected script order: ${htmlScripts.join(", ")}`);
}

const htmlStyles = [...html.matchAll(/<link rel="stylesheet" href="\.\/([^"]+)"/g)].map((match) => match[1].split("?")[0]);
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
  "microphoneStatusButton",
  "microphoneStatusText",
  "microphoneStatusDetail",
  "recoveryNotice",
  "retryRecoveryButton",
  "discardRecoveryButton",
]) {
  if (!ids.has(requiredId)) throw new Error(`Missing required control: ${requiredId}`);
}

const fullscreenCss = read("fullscreen.css");
if (!fullscreenCss.includes("immersive-mode")) throw new Error("Missing immersive fullscreen styles");
const baseCss = read("styles.css");
for (const rule of [
  ".camera-stage.ratio-4-3 { width:min(100%,50.25dvh); }",
  ".camera-stage.ratio-1-1 { width:min(100%,67dvh); }",
  ".camera-stage.ratio-16-9 { width:min(100%,37.6875dvh); }",
]) {
  if (!baseCss.includes(rule)) throw new Error(`Short portrait viewport must preserve capture ratio: ${rule}`);
}
if (!html.includes("現在 MIC") || !html.includes("音声は録音されません")
  || !read("core.js").includes("syncMicrophoneStatus")
  || !read("camera-enhancements.js").includes("microphoneStatusButton")) {
  throw new Error("Video mode must expose a persistent microphone state and direct settings shortcut");
}

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
for (const feature of ["manualFocusAvailability", "exposureAvailability", "この端末では利用できません"]) {
  if (!(html + controlJs).includes(feature)) throw new Error(`Unsupported camera controls need a visible explanation: ${feature}`);
}

const deviceJs = read("camera-devices.js");
for (const feature of ["enumerateDevices", "devicechange", "selectedDeviceId", "NotReadableError", "initializeCameraController"]) {
  if (!(deviceJs + read("camera-enhancements.js")).includes(feature)) throw new Error(`Missing camera-device feature: ${feature}`);
}
if (!deviceJs.includes('focusMode = { ideal: "continuous" }')) throw new Error("Initial continuous AF preference is missing");
if (!deviceJs.includes("supported.aspectRatio") || !deviceJs.includes("getVideoTrackTargetAspectRatio")
  || !deviceJs.includes("syncVideoRatioWithTrack(settings)")) {
  throw new Error("Video ratios must constrain and verify the actual camera track");
}
if (!deviceJs.includes('video.aspectRatio = { exact: getVideoTrackTargetAspectRatio() }')
  || !deviceJs.includes('video.resizeMode = { ideal: "crop-and-scale" }')
  || !deviceJs.includes("enforceVideoRatio: false")) {
  throw new Error("Video ratios must use exact crop constraints with a camera-start fallback");
}

const ratioModel = read("camera-ratio-model.js");
for (const feature of ["targetTrackAspectRatio", "normalizedTrackAspectRatio", "approximatelyMatches", "closestRatioLabel"]) {
  if (!ratioModel.includes(feature)) throw new Error(`Missing camera ratio model feature: ${feature}`);
}
const coreJs = read("core.js");
if (!coreJs.includes('videoRatio: "16:9"') || !coreJs.includes('const stateKey = state.mode === "video" ? "videoRatio" : "ratio"')
  || !coreJs.includes("if (state.mode === \"video\" && state.stream) await startCamera()")) {
  throw new Error("Photo and video ratios must remain independent and restart video capture when changed");
}

const photoJs = read("photo.js");
if (!photoJs.includes("ImageCapture") || !photoJs.includes("takePhoto")) throw new Error("High-resolution photo capture is missing");
if (!photoJs.includes("calculateCrop(photoSource.width, photoSource.height, getVisiblePhotoRatio())")) {
  throw new Error("High-resolution stills must be cropped to the visible preview ratio");
}
if (!photoJs.includes("elements.cameraStage.getBoundingClientRect()")) {
  throw new Error("Capture ratio must use the stage box rather than the border-inset video box");
}
if (photoJs.includes("Math.abs(sourceRatio - previewRatio)")) throw new Error("High-resolution stills must not be discarded only because their sensor ratio differs");
if (!photoJs.includes("thumbnailBlob") || !photoJs.includes("PDF_MAX_PAGES = 20") || !photoJs.includes("PDF_PAGE_MAX_DIMENSION = 2048")) {
  throw new Error("Photo history thumbnails and bounded PDF export are required");
}
const captureAdapter = read("camera-capture.js");
if (!captureAdapter.includes("Q.enhancedCapturePhoto = capturePhoto")) throw new Error("Capture adapter must use the canonical photo implementation");
if (captureAdapter.includes("context.drawImage")) throw new Error("Duplicate photo capture implementation returned");

const videoJs = read("video.js");
if (!videoJs.includes("VIDEO_BITRATE_BASE_1080P30")) throw new Error("Video quality presets are not independently defined");
if (!videoJs.includes("512 * 1024 * 1024")) throw new Error("Recording finalization safety cap must remain 512 MB");
if (!videoJs.includes("validateVideoBlob")) throw new Error("Recorded and recovered video must be validated before success");
if (!videoJs.includes("calculateRecordingByteBudget") || !videoJs.includes("recordingFinalizing")
  || !videoJs.includes("recordingEmittedBytes") || !videoJs.includes("resetRecordingUiAfterStop")) {
  throw new Error("Recording finalization concurrency and storage reserve guards are missing");
}

const storageJs = read("storage.js");
for (const feature of ["DB_VERSION = 2", "listStoredMediaPage", "countStoredMedia", "requestPersistentStorage", "versionchange", "blocked"]) {
  if (!storageJs.includes(feature)) throw new Error(`Missing storage reliability feature: ${feature}`);
}
if (!storageJs.includes("DEFAULT_MEDIA_PAGE_SIZE = 60")) throw new Error("Gallery startup must remain paged");

const enhancementJs = read("camera-enhancements.js");
if (!enhancementJs.includes("elements.settingsDialog.show();")) {
  throw new Error("Mobile settings must remain non-modal so the camera preview stays usable");
}
if (!enhancementJs.includes('(max-width: 1024px) and (pointer: coarse)')) {
  throw new Error("Touch tablets must use the visible settings sheet");
}
if (!enhancementJs.includes("refreshPagedGallery")) throw new Error("Paged gallery wiring is missing");
if (!enhancementJs.includes("requestPersistentStorage")) throw new Error("Persistent storage is not requested");
if (!enhancementJs.includes("galleryLoadedCount")) throw new Error("Paged gallery must track cursor progress independently from deduplicated item count");
if (!enhancementJs.includes('removeEventListener("click", Q.originalToggleTorch)')) {
  throw new Error("Legacy torch handler must be replaced by unified camera controls");
}

const enhancementCss = read("camera-enhancements.css");
if (!enhancementCss.includes("#settingsSheetBody .settings-panel")) throw new Error("Mobile settings sheet does not expose the settings panel");
if (!enhancementCss.includes("#exposureControl") || !enhancementCss.includes("display: none !important")) {
  throw new Error("Legacy floating exposure control must stay hidden");
}
for (const rule of [
  "grid-template-columns: 104px minmax(0, 1fr) 76px",
  "grid-column: 3",
  "grid-row: 1 / 3",
  "html:not(.immersive-mode) .camera-stage",
  "left: -114px",
]) {
  if (!enhancementCss.includes(rule)) throw new Error(`Short landscape layout is incomplete: ${rule}`);
}

for (const dialogId of ["reviewDialog", "galleryDialog", "settingsDialog", "privacyDialog"]) {
  const dialog = html.match(new RegExp(`<dialog[^>]*id="${dialogId}"[^>]*>`))?.[0] || "";
  if (!/aria-labelledby="[^"]+"/.test(dialog)) throw new Error(`${dialogId} must have an accessible name`);
}
for (const rangeId of ["manualFocusRange", "exposureIndexRange"]) {
  if (!html.includes(`for="${rangeId}"`)) throw new Error(`${rangeId} must have a visible label`);
}
if (/id="recordingBadge"[^>]*aria-live/.test(html)) throw new Error("Frequently updated recording metrics must not be a live region");
if (/id="galleryGrid"[^>]*aria-live/.test(html)) throw new Error("Gallery cards must not be announced as one large live region");
if (!html.includes("Content-Security-Policy")) throw new Error("The static deployment needs a restrictive CSP");
if (!html.includes('rel="apple-touch-icon"') || !manifest.icons?.some((icon) => icon.sizes === "192x192")
  || !manifest.icons?.some((icon) => icon.sizes === "512x512" && icon.purpose.includes("maskable"))) {
  throw new Error("Installable PNG and Apple touch icons are required");
}
if (enhancementCss.includes(".live-camera-controls .range-setting")) {
  throw new Error("Manual camera controls must not cover the live preview");
}

const workflow = read(".github/workflows/validate.yml");
for (const file of scripts) {
  if (!workflow.includes(file)) throw new Error(`CI syntax check does not cover ${file}`);
}
if (!workflow.includes("tests/camera-controls.test.cjs") || !workflow.includes("tests/video-bitrate.test.cjs") || !workflow.includes("tests/service-worker.test.cjs") || !workflow.includes("tests/storage.test.cjs")) {
  throw new Error("Regression tests are not wired into CI");
}

console.log(`Validated ${ids.size} DOM IDs, ${selectors.length} selector references, ${scripts.length} scripts, storage paging, unified controls, capture quality, video safety, and PWA cache isolation.`);
