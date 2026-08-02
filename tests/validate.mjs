import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const scripts = ["storage.js", "core.js", "photo.js", "video.js", "ui.js", "fullscreen.js"];
const styles = ["styles.css", "fullscreen.css"];
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

if (!ids.has("fullscreenButton")) throw new Error("Missing fullscreen control");
if (!fs.readFileSync(path.join(root, "fullscreen.css"), "utf8").includes("immersive-mode")) {
  throw new Error("Missing immersive fullscreen styles");
}

console.log(`Validated ${ids.size} DOM IDs, ${selectors.length} selector references, ${scripts.length} scripts, and ${styles.length} stylesheets.`);
