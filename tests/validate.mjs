import fs from "node:fs";
import path from "node:path";
import {applicationScripts} from "./application-files.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("index.html");
const privacyHtml = read("privacy.html");
const manifest = JSON.parse(read("manifest.webmanifest"));
const sitemap = read("sitemap.xml");
const idValues = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const ids = new Set(idValues);
const duplicateIds = [...new Set(idValues.filter((id, index) => idValues.indexOf(id) !== index))];
if (duplicateIds.length) throw new Error(`Duplicate DOM IDs: ${duplicateIds.join(", ")}`);
const scripts = [
  "assets/js/storage.js",
  "assets/js/camera-ratio-model.js",
  "assets/js/core.js",
  "assets/js/photo.js",
  "assets/js/video-preview.js",
  "assets/js/video.js",
  "assets/js/ui.js",
  "assets/js/media-dialog-scroll.js",
  "assets/js/photo-review.js",
  "assets/js/fullscreen.js",
  "assets/js/camera-enhancements-core.js",
  "assets/js/camera-transition.js",
  "assets/js/camera-devices.js",
  "assets/js/camera-controls.js",
  "assets/js/camera-capture.js",
  "assets/js/settings-sheet-motion.js",
  "assets/js/settings-sheet.js",
  "assets/js/gallery-loader.js",
  "assets/js/camera-enhancements.js",
  "assets/js/gallery-batch.js",
  "assets/js/gallery-selection.js",
  "assets/js/history-sheet.js",
  "assets/js/device-layout-model.js",
  "assets/js/camera-overlay.js",
  "assets/js/bootstrap.js",
];
const styles = ["assets/css/styles.css", "assets/css/fullscreen.css", "assets/css/camera-enhancements.css", "assets/css/camera-overlay.css"];
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
const assetVersion = "20261031.3";
for (const file of [...styles, ...scripts, "manifest.webmanifest"]) {
  if (!html.includes(`./${file}?v=${assetVersion}`)) throw new Error(`HTML asset version is stale: ${file}`);
  if (!serviceWorker.includes(`./${file}?v=${assetVersion}`)) throw new Error(`Service worker asset version is stale: ${file}`);
}
if (!serviceWorker.includes('const CACHE_NAME = "quiet-camera-shell-v43"')) throw new Error("Service worker cache version is stale");
if (!privacyHtml.includes(`./assets/css/styles.css?v=${assetVersion}`)) throw new Error("Privacy page asset version is stale");
for (const asset of ["sitemap.xml", "images/quiet-camera-og.png"]) {
  if (!fs.existsSync(path.join(root, asset))) throw new Error(`Missing SEO asset: ${asset}`);
}

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
  "cameraPermissionDialog",
  "cameraPermissionHelpButton",
  "cameraPermissionInstructions",
  "retryCameraPermissionButton",
  "closeCameraPermissionButton",
]) {
  if (!ids.has(requiredId)) throw new Error(`Missing required control: ${requiredId}`);
}

const fullscreenCss = read("assets/css/fullscreen.css");
if (!fullscreenCss.includes("immersive-mode")) throw new Error("Missing immersive fullscreen styles");
const baseCss = read("assets/css/styles.css");
for (const rule of [
  ".camera-stage.ratio-4-3 { width:100%; }",
  ".camera-stage.ratio-1-1 { width:100%; }",
  ".camera-stage.ratio-16-9 { width:100%; }",
]) {
  if (!baseCss.includes(rule)) throw new Error(`Short portrait viewport must preserve capture ratio: ${rule}`);
}
if (!html.includes("microphone-state-line") || !html.includes("音声は録音されません")
  || !read("assets/js/core.js").includes("syncMicrophoneStatus")
  || !read("assets/js/settings-sheet.js").includes("microphoneStatusButton")) {
  throw new Error("Video mode must expose a persistent microphone state and direct settings shortcut");
}

const controlJs = read("assets/js/camera-controls.js");
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

const deviceJs = read("assets/js/camera-devices.js");
for (const feature of ["enumerateDevices", "devicechange", "selectedDeviceId", "NotReadableError", "initializeCameraController"]) {
  if (!(deviceJs + read("assets/js/camera-enhancements.js")).includes(feature)) throw new Error(`Missing camera-device feature: ${feature}`);
}
if (!deviceJs.includes('focusMode = { ideal: "continuous" }')) throw new Error("Initial continuous AF preference is missing");
if (!deviceJs.includes("supported.aspectRatio") || !deviceJs.includes("getVideoTrackTargetAspectRatio")
  || (!deviceJs.includes("syncVideoRatioWithTrack(") || !deviceJs.includes("elements.video.videoWidth/elements.video.videoHeight"))) {
  throw new Error("Video ratios must constrain and verify the actual camera track");
}
if (!deviceJs.includes('video.aspectRatio = { exact: getVideoTrackTargetAspectRatio() }')
  || !deviceJs.includes('video.resizeMode = { ideal: "crop-and-scale" }')
  || !deviceJs.includes("enforceVideoRatio: false")) {
  throw new Error("Video ratios must use exact crop constraints with a camera-start fallback");
}

const ratioModel = read("assets/js/camera-ratio-model.js");
for (const feature of ["targetTrackAspectRatio", "normalizedTrackAspectRatio", "approximatelyMatches", "closestRatioLabel"]) {
  if (!ratioModel.includes(feature)) throw new Error(`Missing camera ratio model feature: ${feature}`);
}
const coreJs = read("assets/js/core.js");
if (!coreJs.includes('videoRatio: "16:9"') || !coreJs.includes('const stateKey = state.mode === "video" ? "videoRatio" : "ratio"')
  || !coreJs.includes("if (state.mode === \"video\" && (state.stream || state.cameraStartPending || state.cameraTransitioning)) await startCamera()")) {
  throw new Error("Photo and video ratios must remain independent and restart video capture when changed");
}

const photoJs = read("assets/js/photo.js");
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
const captureAdapter = read("assets/js/camera-capture.js");
if (!captureAdapter.includes("Q.enhancedCapturePhoto = capturePhoto")) throw new Error("Capture adapter must use the canonical photo implementation");
if (captureAdapter.includes("context.drawImage")) throw new Error("Duplicate photo capture implementation returned");

const videoJs = read("assets/js/video.js");
if (!videoJs.includes("VIDEO_BITRATE_BASE_1080P30")) throw new Error("Video quality presets are not independently defined");
if (!videoJs.includes("512 * 1024 * 1024")) throw new Error("Recording finalization safety cap must remain 512 MB");
if (!videoJs.includes("validateVideoBlob")) throw new Error("Recorded and recovered video must be validated before success");
if (!videoJs.includes("calculateRecordingByteBudget") || !videoJs.includes("recordingFinalizing")
  || !videoJs.includes("recordingEmittedBytes") || !videoJs.includes("resetRecordingUiAfterStop")) {
  throw new Error("Recording finalization concurrency and storage reserve guards are missing");
}

const storageJs = read("assets/js/storage.js");
for (const feature of ["DB_VERSION = 2", "listStoredMediaPage", "countStoredMedia", "requestPersistentStorage", "versionchange", "blocked"]) {
  if (!storageJs.includes(feature)) throw new Error(`Missing storage reliability feature: ${feature}`);
}
if (!storageJs.includes("DEFAULT_MEDIA_PAGE_SIZE = 60")) throw new Error("Gallery startup must remain paged");

const enhancementJs = read("assets/js/camera-enhancements.js");
const settingsSheetJs = read("assets/js/settings-sheet.js");
const galleryLoaderJs = read("assets/js/gallery-loader.js");
if (!settingsSheetJs.includes("elements.settingsDialog.show();")) {
  throw new Error("Mobile settings must remain non-modal so the camera preview stays usable");
}
if (!settingsSheetJs.includes('(max-width: 1024px) and (pointer: coarse)')) {
  throw new Error("Touch tablets must use the visible settings sheet");
}
if (!galleryLoaderJs.includes("refreshPagedGallery") || !enhancementJs.includes("Q.initializeGalleryLoader()")) throw new Error("Paged gallery wiring is missing");
if (!enhancementJs.includes("requestPersistentStorage")) throw new Error("Persistent storage is not requested");
if (!galleryLoaderJs.includes("galleryLoadedCount")) throw new Error("Paged gallery must track cursor progress independently from deduplicated item count");
if (!enhancementJs.includes("Q.initializeSettingsSheet()")) throw new Error("Settings sheet must be installed before startup");
for (const [button, handler] of [["startButton", "startCamera"], ["switchButton", "switchCamera"], ["torchButton", "toggleTorch"], ["shutterButton", "handleShutter"]]) {
  const registrations = combined.match(new RegExp(`elements\\.${button}\\.addEventListener\\("click",`, "g")) || [];
  if (registrations.length !== 1 || !combined.includes(`elements.${button}.addEventListener("click", ${handler})`)) {
    throw new Error(`The canonical ${button} action must be registered exactly once`);
  }
}
for (const [handler, implementation] of [["startCamera", "enhancedStartCamera"], ["switchCamera", "enhancedSwitchCamera"], ["toggleTorch", "enhancedToggleTorch"]]) {
  if (!coreJs.includes(`function ${handler}() {\n  return window.QuietCameraEnhancements.${implementation}();`)) {
    throw new Error(`The ${handler} action must dispatch to the unified controller`);
  }
}
const bootstrapJs = read("assets/js/bootstrap.js");
if (!bootstrapJs.includes("registerServiceWorker();") || !bootstrapJs.includes("initializeApp().catch(")) {
  throw new Error("Final bootstrap must register the worker and initialize the application");
}
if ((combined.match(/initializeApp\(\)\.catch\(/g) || []).length !== 1) {
  throw new Error("Application startup must run once, after every controller is installed");
}

const enhancementCss = read("assets/css/camera-enhancements.css");
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

for (const dialogId of ["reviewDialog", "galleryDialog", "settingsDialog", "cameraPermissionDialog", "privacyDialog"]) {
  const dialog = html.match(new RegExp(`<dialog[^>]*id="${dialogId}"[^>]*>`))?.[0] || "";
  if (!/aria-labelledby="[^"]+"/.test(dialog)) throw new Error(`${dialogId} must have an accessible name`);
}
if (!html.includes("端末またはブラウザの設定で、このサイトのカメラ使用を許可してください")
  || !coreJs.includes("showCameraPermissionDialog")
  || !deviceJs.includes('["NotAllowedError", "SecurityError", "PermissionDeniedError"].includes(error?.name)')
  || !deviceJs.includes('if (permissionDenied(error) && !requestedMicrophone && !error.fromPendingMicrophone && !silentPermissionFailure) showCameraPermissionDialog()')
  || !read("assets/js/ui.js").includes("await startCamera()")) {
  throw new Error("Denied camera access must show browser-neutral guidance with a retry action");
}
for (const rangeId of ["manualFocusRange", "exposureIndexRange"]) {
  if (!html.includes(`for="${rangeId}"`)) throw new Error(`${rangeId} must have a visible label`);
}
if (/id="recordingBadge"[^>]*aria-live/.test(html)) throw new Error("Frequently updated recording metrics must not be a live region");
if (/id="galleryGrid"[^>]*aria-live/.test(html)) throw new Error("Gallery cards must not be announced as one large live region");
if (!html.includes("Content-Security-Policy")) throw new Error("The static deployment needs a restrictive CSP");
for (const marker of [
  'rel="canonical" href="https://tomoponz.github.io/quiet-camera/"',
  'name="robots" content="index,follow,max-image-preview:large"',
  'property="og:image" content="https://tomoponz.github.io/quiet-camera/images/quiet-camera-og.png"',
  'name="twitter:card" content="summary_large_image"',
  'itemtype="https://schema.org/SoftwareApplication"',
  'itemprop="price" content="0"',
]) {
  if (!html.includes(marker)) throw new Error(`Missing SEO metadata: ${marker}`);
}
for (const url of ["https://tomoponz.github.io/quiet-camera/", "https://tomoponz.github.io/quiet-camera/privacy.html"]) {
  if (!sitemap.includes(`<loc>${url}</loc>`)) throw new Error(`Sitemap is missing canonical URL: ${url}`);
}
if (!manifest.description.includes("広告・ログイン不要") || !html.includes("広告やログインなしで使えるブラウザカメラ")) {
  throw new Error("The app needs visible, user-first search copy that matches its metadata");
}
if (!html.includes('rel="apple-touch-icon"') || !manifest.icons?.some((icon) => icon.sizes === "192x192")
  || !manifest.icons?.some((icon) => icon.sizes === "512x512" && icon.purpose.includes("maskable"))) {
  throw new Error("Installable PNG and Apple touch icons are required");
}
if (enhancementCss.includes(".live-camera-controls .range-setting")) {
  throw new Error("Manual camera controls must not cover the live preview");
}

const workflow = read(".github/workflows/validate.yml");
const runAll = read("tests/run-all.mjs");
if (!/^\s+run: node tests\/run-all\.mjs\s*$/m.test(workflow)
  || !runAll.includes("await run(['tests/check-syntax.mjs'])")) throw new Error("The CI source job must run the recursive syntax check through the aggregate entry");
if (JSON.stringify(applicationScripts(root)) !== JSON.stringify([...scripts, "service-worker.js"].sort())) {
  throw new Error("Every application script must be loaded in the checked order or be the root Service Worker");
}
if (!runAll.includes("f==='validate.mjs'||f.endsWith('.test.cjs')")) throw new Error("The CI source entry must discover every unit suite");
for (const file of ["camera-controls.test.cjs", "video-bitrate.test.cjs", "service-worker.test.cjs", "storage.test.cjs", "recording-budget-matrix.test.cjs", "recording-safety.test.cjs", "media-audit.test.cjs", "browser-cleanup.test.cjs"]) {
  if (!fs.existsSync(path.join(root,"tests",file))) throw new Error(`Missing required CI regression suite: ${file}`);
}

console.log(`Validated ${ids.size} DOM IDs, ${selectors.length} selector references, ${scripts.length} scripts, storage paging, unified controls, capture quality, video safety, and PWA cache isolation.`);
