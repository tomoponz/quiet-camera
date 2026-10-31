import path from 'node:path';
import {spawn} from 'node:child_process';
import {syntaxFiles} from './application-files.mjs';

const root = path.resolve(import.meta.dirname, '..');
const files = syntaxFiles(root);
const results = await Promise.all(files.map(file => new Promise(resolve => {
  const child = spawn(process.execPath, ['--check', file], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let error = '';
  child.stdout.on('data', data => { error += data; });
  child.stderr.on('data', data => { error += data; });
  child.on('error', failure => resolve({file, passed: false, error: String(failure)}));
  child.on('close', code => resolve({file, passed: code === 0, ...(code === 0 ? {} : {error})}));
})));
for (const result of results.filter(result => !result.passed)) console.error(result.file + ': ' + result.error);
const passed = results.every(result => result.passed);
console.log(JSON.stringify({passed, syntaxChecks: files.length, files}));
if (!passed) process.exitCode = 1;
