import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const scripts = ["storage.js", "core.js", "photo.js", "video.js", "ui.js"];
const missingFiles = scripts.filter((file) => !fs.existsSync(path.join(root, file)));
if (missingFiles.length) throw new Error(`Missing scripts: ${missingFiles.join(", ")}`);

const combined = scripts.map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
const selectors = [...combined.matchAll(/querySelector\("#([^"]+)"\)/g)].map((match) => match[1]);
const missingIds = [...new Set(selectors.filter((id) => !ids.has(id)))];
if (missingIds.length) throw new Error(`Missing DOM IDs: ${missingIds.join(", ")}`);

const serviceWorker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
for (const file of ["index.html", "privacy.html", "styles.css", ...scripts, "manifest.webmanifest", "icons/icon.svg"]) {
  if (!serviceWorker.includes(`./${file}`)) throw new Error(`Service worker does not cache ${file}`);
}

const htmlScripts = [...html.matchAll(/<script src="\.\/([^"]+)"/g)].map((match) => match[1]);
if (JSON.stringify(htmlScripts) !== JSON.stringify(scripts)) {
  throw new Error(`Unexpected script order: ${htmlScripts.join(", ")}`);
}

console.log(`Validated ${ids.size} DOM IDs, ${selectors.length} selector references, and ${scripts.length} scripts.`);
