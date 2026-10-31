// A real Service Worker and IndexedDB upgrade at the Pages project subpath.
// All media is generated or the existing synthetic fixture. This owns its
// loopback server, Chrome profile, browser context, and temporary baseline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';

const BASE = 'd1d3387cc2a9d09584f44dcabcdd8e56f61ae231';
const root = path.resolve(import.meta.dirname, '..');
const output = process.env.QC_STRUCTURE_UPGRADE_OUTPUT || path.join(root, 'test-results/structure-upgrade');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-camera-structure-upgrade-'));
const baseline = path.join(scratch, 'baseline');
const profile = path.join(scratch, 'profile');
fs.mkdirSync(output, {recursive: true});
fs.mkdirSync(baseline, {recursive: true});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', args, {cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024});
const checks = [], details = {baselineCommit: BASE}, exceptions = [], mediaAudits = [], requests = [];
let server, chrome, socket, sessionId, sequence = 0, online = true, servedRoot = baseline;
const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(name, actual, expected = true) { assert.deepEqual(actual, expected, name); checks.push({name, passed: true}); }
function command(method, params = {}, session = sessionId, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timeout')); }, timeout);
    pending.set(id, {resolve, reject, timer});
    socket.send(JSON.stringify({id, method, params, ...(session ? {sessionId: session} : {})}));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture: true});
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await evaluate(expression); if (value) return value; } catch (error) { if (!/context|Cannot find|not defined/i.test(error.message)) throw error; } await sleep(50); }
  throw Error('Timed out: ' + expression);
}
async function auditCurrentDocument() { mediaAudits.push(await evaluate('window.__structureAudit.nativeMediaCalls')); }
async function ready() {
  await until('document.readyState === "complete" && typeof state !== "undefined" && !!window.QuietCameraEnhancements?.refreshPagedGallery && typeof getStoredMedia === "function"');
  await evaluate('refreshGallery()');
}
async function screenshot(name) {
  const result = await command('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
  fs.writeFileSync(path.join(output, name), Buffer.from(result.data, 'base64'));
}
const snapshotExpression = `(async () => {
  const db = await openDatabase();
  const stores = Array.from(db.objectStoreNames).sort();
  const tx = db.transaction(stores, 'readonly');
  const completed = transactionDone(tx);
  const schema = stores.map(name => { const s = tx.objectStore(name); return {name, keyPath:s.keyPath, autoIncrement:s.autoIncrement, indexes:Array.from(s.indexNames).sort().map(n => { const x=s.index(n); return {name:n,keyPath:x.keyPath,unique:x.unique,multiEntry:x.multiEntry}; })}; });
  const data = await Promise.all(stores.map(async name => [name, await requestToPromise(tx.objectStore(name).getAll())]));
  await completed;
  const digest = async blob => ({size:blob.size,type:blob.type,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))).map(x=>x.toString(16).padStart(2,'0')).join('')});
  const normalize = async value => {
    if (value instanceof Blob) return {blob:await digest(value)};
    if (Array.isArray(value)) return Promise.all(value.map(normalize));
    if (value && typeof value === 'object') { const result={}; for(const k of Object.keys(value).sort())result[k]=await normalize(value[k]); return result; }
    return value;
  };
  const rows={}; for(const [name,records] of data)rows[name]=await normalize(records);
  const hydrated=await Promise.all((await listStoredMedia()).sort((a,b)=>a.id.localeCompare(b.id)).map(async media=>({id:media.id,blob:await digest(media.blob)})));
  return {name:db.name,version:db.version,schema,rows,hydrated,settings:JSON.parse(localStorage.getItem('quiet-camera-settings-v3')),selectedDevice:localStorage.getItem('quiet-camera-selected-device')};
})()`;

try {
  check('fixed pre-refactor commit is available', git(['rev-parse', BASE + '^{commit}']).toString().trim(), BASE);
  // Export only ordinary tracked application resources. No checkout/ref/index changes.
  for (const entry of git(['ls-tree', '-rz', BASE]).toString().split('\0').filter(Boolean)) {
    const match = entry.match(/^(\d+) blob ([0-9a-f]+)\t(.+)$/s);
    if (!match || /^(?:tests|docs|\.github)\//.test(match[3])) continue;
    const [, mode, , name] = match;
    assert.equal(mode, '100644', 'baseline resources must be regular files');
    const destination = path.resolve(baseline, name);
    assert(destination.startsWith(baseline + path.sep), 'baseline export must stay in owned scratch directory');
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.writeFileSync(destination, git(['show', BASE + ':' + name]));
  }
  details.bytePreserved = {};
  for (const name of ['storage.js', 'styles.css', 'fullscreen.css', 'camera-enhancements.css', 'camera-overlay.css']) {
    const destination = path.join(root, name.endsWith('.css') ? 'assets/css' : 'assets/js', name);
    const before = hash(fs.readFileSync(path.join(baseline, name))), after = hash(fs.readFileSync(destination));
    check('unchanged storage/CSS bytes: ' + name, after, before);
    details.bytePreserved[name] = before;
  }
  server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    requests.push({pathname, online, candidate: servedRoot === root});
    if (!online) { request.socket.destroy(); return; }
    if (!pathname.startsWith('/quiet-camera/')) { response.writeHead(404).end(); return; }
    const relative = pathname.slice('/quiet-camera/'.length) || 'index.html';
    const file = relative === '__fixture/landscape.mp4'
      ? path.join(root, 'tests/fixtures/landscape.mp4') : path.resolve(servedRoot, relative);
    if (relative !== '__fixture/landscape.mp4' && !file.startsWith(servedRoot + path.sep)) { response.writeHead(403).end(); return; }
    try {
      const bytes = fs.readFileSync(file);
      response.writeHead(200, {'Content-Type': ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.mp4':'video/mp4','.xml':'application/xml'})[path.extname(file)] || 'application/octet-stream', 'Content-Length':bytes.length, 'Cache-Control':'no-store', 'Permissions-Policy':'camera=(), microphone=()'});
      response.end(bytes);
    } catch { requests.at(-1).missing = true; response.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  details.origin = `http://127.0.0.1:${server.address().port}`;
  details.url = details.origin + '/quiet-camera/';
  chrome = spawn(process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome'), ['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required','--mute-audio','about:blank'], {windowsHide:true,stdio:['ignore','ignore','pipe']});
  let stderr = '';
  const endpoint = await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(Error('Owned Chrome startup timeout: ' + stderr)), 20000);
    chrome.stderr.on('data', data => { stderr += data; const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/); if(match){clearTimeout(timer);resolve(match[1]);} });
    chrome.on('error', error => {clearTimeout(timer);reject(error);});
  });
  socket = new WebSocket(endpoint); await once(socket, 'open');
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if(message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    if(!pending.has(message.id))return;
    const request=pending.get(message.id);pending.delete(message.id);clearTimeout(request.timer);
    message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result);
  });
  details.browser = await command('Browser.getVersion', {}, undefined);
  const {browserContextId} = await command('Target.createBrowserContext', {}, undefined);
  for(const name of ['camera','microphone'])await command('Browser.setPermission',{permission:{name},setting:'denied',browserContextId},undefined);
  const {targetId} = await command('Target.createTarget',{url:'about:blank',browserContextId},undefined);
  ({sessionId} = await command('Target.attachToTarget',{targetId,flatten:true},undefined));
  await command('Page.enable'); await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride',{width:393,height:850,deviceScaleFactor:1,mobile:true});
  await command('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__structureAudit={nativeMediaCalls:0,registrationsCompleted:0};
    Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{__structureAudit.nativeMediaCalls++;throw Error('Physical media is prohibited in structure upgrade test');},enumerateDevices:async()=>[],getSupportedConstraints:()=>({}),addEventListener(){}}});
    const register=navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register=(...args)=>register(...args).then(registration=>{__structureAudit.registrationsCompleted++;return registration;});
    sessionStorage.setItem('__structureTestNavigations',String(Number(sessionStorage.getItem('__structureTestNavigations')||0)+1));
  `});
  await command('Page.navigate',{url:details.url}); await ready();
  await until('!!navigator.serviceWorker.controller');
  check('first worker activation does not reload without consent',await evaluate('Number(sessionStorage.getItem("__structureTestNavigations"))'),1);
  check('old worker scope is the Pages project path',await evaluate('(async()=>(await navigator.serviceWorker.getRegistration()).scope)()'),details.url);
  await evaluate(`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;const ctx=canvas.getContext('2d');ctx.fillStyle='#167b91';ctx.fillRect(0,0,96,64);ctx.fillStyle='#facb39';ctx.fillRect(7,9,39,23);
    const image=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    await putMedia({id:'compat-photo',kind:'photo',createdAt:1001,blob:image,previewBlob:image,thumbnailBlob:image,mimeType:image.type,extension:'png',width:96,height:64});
    const pdf=await jpegPagesToPdf([await blobToJpegPage(image)]);
    await putMedia({id:'compat-pdf',kind:'photo',derivedDocument:true,createdAt:1002,blob:pdf,previewBlob:image,mimeType:'application/pdf',extension:'pdf',width:96,height:64});
    const video=await fetch('./__fixture/landscape.mp4').then(r=>r.blob());
    await putMedia({id:'compat-legacy-video',kind:'video',createdAt:1003,blob:video,previewBlob:video,mimeType:'video/mp4',extension:'mp4',width:320,height:180});
    const size=Math.floor(video.size/3);for(let i=0;i<3;i++)await putRecordingChunk('compat-backed-session',i,video.slice(i*size,i===2?video.size:(i+1)*size));
    await putRecordingSession({id:'compat-backed-session',lockProtocol:1,bytes:video.size});
    await commitRecordingMedia({id:'compat-backed-video',kind:'video',createdAt:1004,blob:video,previewBlob:video,mimeType:'video/mp4',extension:'mp4',width:320,height:180},'compat-backed-session');
    await putRecordingChunk('compat-legacy-pending',0,video);
    await putRecordingSession({id:'compat-legacy-pending',createdAt:1000,bytes:video.size,mimeType:'video/mp4',status:'recording'});
    localStorage.setItem('quiet-camera-settings-v3',JSON.stringify({...collectSettings(),mode:'photo',ratio:'1:1',videoRatio:'4:3',photoFormat:'image/png',photoQuality:'0.98',recordingLimit:'20',microphone:'on'}));
    localStorage.setItem('quiet-camera-selected-device','synthetic-device-id');
    await (await caches.open('unrelated-application-test')).put('./unrelated-test',new Response('untouched'));
  })()`);
  const navigationBeforeSeedReload=await evaluate('Number(sessionStorage.getItem("__structureTestNavigations"))');
  await auditCurrentDocument(); await command('Page.reload');
  await until('Number(sessionStorage.getItem("__structureTestNavigations")) > '+navigationBeforeSeedReload);
  await ready();
  check('normal reload retains the old worker controller',await evaluate('!!navigator.serviceWorker.controller'));
  details.before = await evaluate(snapshotExpression);
  check('old fixture has four persisted media records',details.before.rows.media.length,4);
  check('old fixture includes chunk-backed completion',details.before.rows.media.some(item=>item.backingRecordingId==='compat-backed-session'));
  check('old legacy recovery row remains pending',details.before.rows.recordingSessions.map(item=>item.id),['compat-legacy-pending']);
  check('old settings restore microphone OFF',await evaluate('elements.microphoneSelect.value'),'off');
  await until('__structureAudit.registrationsCompleted === 1');
  const navigationBeforeUpdate = await evaluate('Number(sessionStorage.getItem("__structureTestNavigations"))');
  servedRoot = root;
  await evaluate('(async()=>{const registration=await navigator.serviceWorker.getRegistration();await registration.update();})()');
  await until('!!state.waitingServiceWorker && !elements.updateButton.hidden');
  check('updated worker waits for consent',await evaluate('Number(sessionStorage.getItem("__structureTestNavigations"))'),navigationBeforeUpdate);
  await evaluate('state.recordingFinalizing=true;elements.updateButton.click()');
  check('update is deferred during finalization',await evaluate('state.serviceWorkerReloadPending && !state.serviceWorkerUpdateRequested'));
  check('deferred worker has not reloaded',await evaluate('Number(sessionStorage.getItem("__structureTestNavigations"))'),navigationBeforeUpdate);
  await auditCurrentDocument();
  await evaluate('state.recordingFinalizing=false;elements.updateButton.click()');
  await until('Number(sessionStorage.getItem("__structureTestNavigations")) > ' + navigationBeforeUpdate);
  await ready();
  check('candidate loads scripts beneath the project path',await evaluate('Array.from(document.scripts).every(s=>s.src.startsWith(location.origin+"/quiet-camera/assets/js/"))'));
  check('candidate loads styles beneath the project path',await evaluate('Array.from(document.querySelectorAll("link[rel=stylesheet]")).every(s=>s.href.startsWith(location.origin+"/quiet-camera/assets/css/"))'));
  check('candidate retains the worker scope',await evaluate('(async()=>(await navigator.serviceWorker.getRegistration()).scope)()'),details.url);
  await until('(async()=>(await caches.keys()).includes("quiet-camera-shell-v41"))()');
  const cachesAfter=await evaluate('caches.keys()');
  check('old shell cache is retired after activation',cachesAfter.includes('quiet-camera-shell-v40'),false);
  check('unrelated cache is preserved',cachesAfter.includes('unrelated-application-test'));
  details.after = await evaluate(snapshotExpression);
  check('all stored bytes, schema, settings, and pending legacy data survive the upgrade',details.after,details.before);
  check('candidate schema name/version preserved',[details.after.name,details.after.version],['quiet-camera-db',2]);
  check('candidate settings are restored without microphone ON',await evaluate('[elements.photoFormatSelect.value,elements.recordingLimitSelect.value,state.ratio,state.videoRatio,elements.microphoneSelect.value,state.selectedDeviceId]'),['image/png','20','1:1','4:3','off','synthetic-device-id']);
  check('paged loader is installed once',await evaluate('document.querySelectorAll("#galleryLoadMoreButton").length'),1);

  // Exercise registrations through DOM clicks, rather than calling handlers directly.
  const clicks=await evaluate(`(async()=>{const Q=QuietCameraEnhancements,names=['enhancedStartCamera','enhancedSwitchCamera','enhancedToggleTorch'],originals=names.map(n=>Q[n]),calls=[0,0,0];try{names.forEach((n,i)=>Q[n]=async()=>{calls[i]++});[elements.startButton,elements.switchButton,elements.torchButton].forEach(b=>{b.disabled=false;b.click()});await Promise.resolve();return calls;}finally{names.forEach((n,i)=>Q[n]=originals[i]);}})()`);
  check('start, switch, and torch each dispatch exactly once',clicks,[1,1,1]);
  await evaluate(`(async()=>{const c=document.createElement('canvas');c.width=320;c.height=240;const x=c.getContext('2d');x.fillStyle='#275c7c';x.fillRect(0,0,320,240);state.stream=c.captureStream(5);state.videoTrack=state.stream.getVideoTracks()[0];elements.video.srcObject=state.stream;await elements.video.play();state.mode='photo';state.timerSeconds=0;state.busy=false;elements.permissionPanel.hidden=true;updateModeUi();elements.shutterButton.disabled=false;})()`);
  await until('elements.video.readyState >= 2');
  await evaluate('elements.shutterButton.click()');
  await until('(async()=>!state.busy && await countStoredMedia()===5)()');
  check('one shutter click saves one photo and keeps live view',await evaluate('!elements.reviewDialog.open && !elements.galleryDialog.open && !!state.stream'));
  const actions=await evaluate(`(async()=>{selectMedia(await getStoredMedia('compat-photo'));window.__actionCounts={download:0,share:0,confirm:0};triggerDownload=()=>{__actionCounts.download++};Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{__actionCounts.share++}});window.confirm=()=>{__actionCounts.confirm++;return false};for(const button of [elements.downloadButton,elements.shareButton,elements.deleteButton]){button.disabled=false;button.click();await new Promise(resolve=>setTimeout(resolve,20));}return __actionCounts;})()`);
  check('save, share, and cancelled deletion each dispatch exactly once',actions,{download:1,share:1,confirm:1});
  check('cancelled deletion preserves the photo',await evaluate('(async()=>!!await getStoredMedia("compat-photo"))()'));
  await screenshot('candidate-synthetic.png');
  details.beforeOffline = await evaluate(snapshotExpression);
  const navigationBeforeOffline=await evaluate('Number(sessionStorage.getItem("__structureTestNavigations"))');
  await auditCurrentDocument(); online=false;
  await command('Page.reload');
  await until('Number(sessionStorage.getItem("__structureTestNavigations")) > '+navigationBeforeOffline);
  await ready();
  check('offline page remains controlled by its worker',await evaluate('!!navigator.serviceWorker.controller'));
  check('offline navigation encountered a real network failure',requests.some(request=>!request.online&&request.pathname==='/quiet-camera/'));
  check('offline reload uses the candidate application',await evaluate('document.scripts[document.scripts.length-1].src.includes("assets/js/bootstrap.js")'));
  check('offline reload preserves all stored bytes',await evaluate(snapshotExpression),details.beforeOffline);
  check('offline controls and history are available',await evaluate('document.querySelectorAll("#galleryLoadMoreButton").length===1 && state.gallery.length===5'));
  check('offline microphone is OFF',await evaluate('elements.microphoneSelect.value'),'off');
  await evaluate('elements.galleryButton.click()');
  await until('elements.galleryDialog.open && elements.galleryGrid.children.length === 5');
  check('offline history opens all five generated records',await evaluate('elements.galleryGrid.children.length'),5);
  await screenshot('offline-history.png');
  await auditCurrentDocument();
  check('no physical media acquisition occurred',mediaAudits.every(value=>value===0));
  check('all online application resources existed',requests.filter(request=>request.online&&request.missing).map(request=>request.pathname),[]);
  check('no uncaught browser exceptions',exceptions,[]);
  details.requests=requests;
  const result={passed:true,checks,details,audit:{nativeMediaCalls:mediaAudits.reduce((sum,value)=>sum+value,0)},limits:['Generated media and a fresh Chrome context only; physical devices and OS share/save destinations remain untested.','The fixed old commit is exported using read-only Git object access; no existing profile, trial server, USB device, or camera/microphone is used.']};
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:true,checks:checks.length,output,audit:result.audit}));
} catch(error) {
  if(sessionId)details.workerState=await evaluate('(async()=>{const r=await navigator.serviceWorker.getRegistration();return {audit:window.__structureAudit,waiting:r?.waiting?.state,installing:r?.installing?.state,active:r?.active?.state,waitingInApp:state.waitingServiceWorker?.state,buttonHidden:elements.updateButton.hidden,caches:await caches.keys()};})()').catch(()=>null);
  if(sessionId)await screenshot('failure.png').catch(()=>{});
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:error.stack,checks,details,exceptions,requests,audit:{nativeMediaCalls:mediaAudits.length?mediaAudits.reduce((sum,value)=>sum+value,0):null}},null,2));
  console.error(error);process.exitCode=1;
} finally {
  if(socket?.readyState===WebSocket.OPEN)await command('Browser.close',{},null,3000).catch(()=>{});
  socket?.close();
  if(chrome&&!chrome.killed)chrome.kill();
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  for(const request of pending.values())clearTimeout(request.timer);
}
