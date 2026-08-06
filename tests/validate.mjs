import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const scripts = ["storage.js", "core.js", "photo.js", "video.js", "ui.js", "fullscreen.js", "camera-enhancements-core.js", "camera-devices.js", "camera-controls.js", "camera-capture.js", "camera-enhancements.js"];
const styles = ["styles.css", "fullscreen.css", "camera-enhancements.css"];
const missingFiles = [...scripts, ...styles].filter((file) => !fs.existsSync(path.join(root, file)));
if (missingFiles.length) throw new Error(`Missing assets: ${missingFiles.join(", ")}`);

const combined = scripts.map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
const selectors = [...combined.matchAll(/querySelector\("#([^"]+)"\)/g)].map((match) => match[1]);
const missingIds = [...new Set(selectors.filter((id) => !ids.has(id)))];
if (missingIds.length) throw new Error(`Missing DOM IDs: ${missingIds.join(", ")}`);

const serviceWorker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
for (const file of ["index.html", "privacy.html", ...styles, ...scripts, "manifest.webmanifest", "icons/icon.svg"]) {
  if (!serviceWorker.includes(`./${file}`)) throw new Error(`Service worker does not cache ${file}`);
}

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

const fullscreenCss = fs.readFileSync(path.join(root, "fullscreen.css"), "utf8");
if (!fullscreenCss.includes("immersive-mode")) throw new Error("Missing immersive fullscreen styles");

const enhancementJs = ["camera-enhancements-core.js", "camera-devices.js", "camera-controls.js", "camera-capture.js", "camera-enhancements.js"]
  .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
  .join("\n");
for (const feature of [
  "enumerateDevices",
  "devicechange",
  "selectedDeviceId",
  "getSettings",
  "focusDistance",
  "exposureCompensation",
  "getVisibleTargetRatio",
  "NotReadableError",
  "deviceCameraInput",
  "importDeviceCameraFile",
  "setAttribute(\"capture\"",
  "端末カメラから取り込み",
]) {
  if (!enhancementJs.includes(feature)) throw new Error(`Missing camera enhancement: ${feature}`);
}
if (!enhancementJs.includes('hasOwnProperty.call(state.capabilities, "pointsOfInterest")')) {
  throw new Error("Point focus must be capability-gated");
}
if (!enhancementJs.includes('deviceCameraInput.accept = mode === "video" ? "video/*" : "image/*"')) {
  throw new Error("Device camera input must follow the selected photo/video mode");
}
if (!enhancementJs.includes("if (resumeWebCameraAfterCapture) stopCamera()")) {
  throw new Error("The web camera must be released before launching the device camera");
}
if (!enhancementJs.includes("previewBlob") || !enhancementJs.includes("readVideoMetadata")) {
  throw new Error("Device camera results must be integrated with the existing media history");
}

const enhancementCss = fs.readFileSync(path.join(root, "camera-enhancements.css"), "utf8");
if (!enhancementCss.includes("#settingsSheetBody .settings-panel")) {
  throw new Error("Mobile settings sheet does not expose the settings panel");
}
if (!enhancementCss.includes("#exposureControl") || !enhancementCss.includes("display: none !important")) {
  throw new Error("Legacy floating exposure control must be replaced");
}

console.log(`Validated ${ids.size} DOM IDs, ${selectors.length} selector references, ${scripts.length} scripts, and ${styles.length} stylesheets.`);
