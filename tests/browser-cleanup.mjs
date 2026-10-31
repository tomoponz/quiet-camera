import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';

const owned = new Map();
const marker = '.quiet-camera-test-owner';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createOwnedScratch(prefix) {
  if (!/^quiet-camera-[a-z0-9-]+-$/.test(prefix)) throw Error('Invalid test scratch prefix');
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, prefix));
  const resolved = fs.realpathSync(directory), token = randomUUID(), stat = fs.statSync(resolved);
  fs.writeFileSync(path.join(resolved, marker), token, {flag: 'wx'});
  owned.set(resolved, {parent, token, dev: stat.dev, ino: stat.ino});
  return resolved;
}

// Validate the exact directory created in this process, never a supplied prefix
// or a similarly named old run. In particular, reject roots and symlink swaps.
export function validateOwnedScratch(directory) {
  const resolved = path.resolve(directory), record = owned.get(resolved);
  if (!record || path.dirname(resolved) !== record.parent) throw Error('Scratch is not owned by this test process');
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved
      || stat.dev !== record.dev || stat.ino !== record.ino
      || fs.readFileSync(path.join(resolved, marker), 'utf8') !== record.token) {
    throw Error('Scratch ownership or resolved path changed');
  }
  return resolved;
}

function processExists(pid) {
  if (process.platform === 'linux') {
    try { if (/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false; }
    catch (error) { if (error.code === 'ENOENT') return false; }
  }
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function bounded(promise, timeout, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), timeout); })]); }
  finally { clearTimeout(timer); }
}

// Call only with this fixture's spawned child, socket and server. Evidence stays
// outside scratch. A cleanup failure makes the suite fail and retains scratch.
export async function cleanupBrowserTest({scratch, chrome, socket, command, server, output, pending}) {
  const report = {passed: false, scratch: path.resolve(scratch), browserExited: !chrome, observedBrowserProcesses: [], temporaryServerClosed: !server, scratchRemoved: false};
  const errors = [];
  let observed = [];
  let exited;
  if (chrome) {
    // 'close' also waits for inherited stdio handles. On Windows those handles
    // may outlive this process; 'exit' plus the owned process inventory proves
    // termination independently of pipe EOF.
    exited = chrome.exitCode !== null || chrome.signalCode !== null || !chrome.pid
      ? Promise.resolve() : new Promise(resolve => chrome.once('exit', resolve));
    if (socket?.readyState === WebSocket.OPEN && command) {
      try {
        const inventory = await bounded(command('SystemInfo.getProcessInfo', {}, null, 3000), 3500, 'Browser process inventory timed out');
        observed = inventory.processInfo.map(item => Number(item.id)).filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
        report.observedBrowserProcesses = observed;
      } catch (error) { report.processInventoryUnavailable = error.message; }
      await bounded(command('Browser.close', {}, null, 3000), 3500, 'Browser.close timed out').catch(error => { report.closeResponse = error.message; });
    }
    try {
      try { await bounded(exited, 5000, 'Owned browser did not exit after close'); }
      catch {
        // Kill only the ChildProcess returned by this test's spawn, never a name,
        // existing profile, discovered process, shell command or unrelated PID.
        if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill();
        await bounded(exited, 10000, 'Owned browser did not exit after termination');
      }
      const deadline = Date.now() + 10000;
      while (observed.some(processExists) && Date.now() < deadline) await sleep(50);
      const remaining = observed.filter(processExists);
      if (remaining.length) throw Error('Observed browser processes are still running: ' + remaining.join(', '));
      report.browserExit = {pid:chrome.pid,exitCode:chrome.exitCode,signalCode:chrome.signalCode};
      report.browserExited = true;
      // Only this ChildProcess's pipes; never another browser or server.
      chrome.stdin?.destroy();chrome.stdout?.destroy();chrome.stderr?.destroy();
    } catch (error) { errors.push(error.message); }
  }
  socket?.close();
  for (const request of pending?.values() || []) clearTimeout(request.timer);
  if (server) {
    try {
      server.closeAllConnections?.();
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      report.temporaryServerClosed = true;
    } catch (error) { errors.push(error.message); }
  }
  try {
    if (errors.length) throw Error('Scratch retained because resource cleanup failed');
    if (!report.browserExited) throw Error('Scratch retained because browser exit was not confirmed');
    const target = validateOwnedScratch(scratch), evidence = path.resolve(output);
    if (evidence === target || evidence.startsWith(target + path.sep)) throw Error('Evidence must remain outside scratch');
    fs.rmSync(target, {recursive: true, force: false, maxRetries: 10, retryDelay: 100});
    owned.delete(target);
    report.scratchRemoved = !fs.existsSync(target);
  } catch (error) { errors.push(error.message); }
  report.passed = errors.length === 0 && report.browserExited && report.temporaryServerClosed && report.scratchRemoved;
  report.errors = errors;
  fs.mkdirSync(output, {recursive: true});
  fs.writeFileSync(path.join(output, 'cleanup.json'), JSON.stringify(report, null, 2));
  if (!report.passed) { process.exitCode = 1; console.error('Owned browser cleanup failed: ' + errors.join('; ')); }
  return report;
}
