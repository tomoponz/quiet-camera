import fs from 'node:fs';
import path from 'node:path';

function filesBelow(root, directory, pattern) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, {withFileTypes: true}).flatMap(entry => {
    const relative = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(root, relative, pattern)
      : entry.isFile() && pattern.test(entry.name) ? [relative] : [];
  }).sort();
}

export function applicationScripts(root) {
  const rootScripts = fs.readdirSync(root, {withFileTypes: true})
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => entry.name);
  return [...rootScripts, ...filesBelow(root, 'assets/js', /\.js$/)].sort();
}

export function syntaxFiles(root) {
  return [...applicationScripts(root), ...filesBelow(root, 'tests', /\.(?:cjs|mjs|js)$/)];
}
