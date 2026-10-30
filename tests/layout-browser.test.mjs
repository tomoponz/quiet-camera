// Hermetic UI regression test: real app scripts/CSS, empty read-only storage fixture,
// denied media permissions, and a fresh browser context/profile. No real camera,
// microphone, saved settings, gallery, or Service Worker is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = process.env.QC_LAYOUT_ROOT || path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-camera-layout-'));
const output = process.env.QUIET_CAMERA_TEST_OUTPUT || scratch;
fs.mkdirSync(output, { recursive: true });
const fixture = `
  function loadSavedSettings(defaults) { return {...defaults}; }
  function saveSettings() { window.__audit.settingSaves++; }
  async function listStoredMediaPage() { return []; }
  async function listStoredMedia() { return []; }
  async function countStoredMedia() { return 0; }
  async function listRecordingSessions() { return []; }
  async function requestPersistentStorage() { return false; }
  async function putMedia() { window.__audit.mediaWrites++; throw new Error('Media writes forbidden in layout test'); }
  async function deleteStoredMedia() { window.__audit.mediaWrites++; throw new Error('Media writes forbidden in layout test'); }
`;
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  const ext = path.extname(file);
  res.setHeader('Content-Type', ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'})[ext] || 'application/octet-stream');
  if (pathname === '/storage.js') { res.end(fixture); return; }
  try { res.end(fs.readFileSync(file)); } catch { res.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/`;
const executable = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome');
const chrome = spawn(executable, ['--headless=new','--remote-debugging-port=0',`--user-data-dir=${path.join(scratch,'profile')}`,'--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check','--mute-audio','about:blank'], { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
let stderr = '';
const endpoint = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Chrome startup timeout: ${stderr}`)), 15000);
  chrome.stderr.on('data', data => { stderr += data; const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/); if(match) {clearTimeout(timer);resolve(match[1]);} });
  chrome.on('error', reject);
  chrome.on('exit', code => {clearTimeout(timer);reject(new Error(`Chrome exited ${code}: ${stderr}`));});
});
const socket = new WebSocket(endpoint);
await once(socket,'open');
let seq = 1;
const pending = new Map();
const exceptions = [];
socket.addEventListener('message', event => {
  const data = JSON.parse(event.data);
  if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails);
  if (!pending.has(data.id)) return;
  const {resolve,reject,timer} = pending.get(data.id);
  clearTimeout(timer);pending.delete(data.id);
  data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result);
});
function command(method, params = {}, sessionId) {
  return new Promise((resolve,reject) => {
    const id = seq++;
    const timer = setTimeout(() => {pending.delete(id);reject(new Error(`${method} timed out`));},15000);
    pending.set(id,{resolve,reject,timer});
    socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  });
}
const cases = [];
const interactions = [];
let finalAudit;
try {
  const {browserContextId} = await command('Target.createBrowserContext');
  for (const name of ['camera','microphone']) await command('Browser.setPermission',{permission:{name},setting:'denied',browserContextId});
  const {targetId} = await command('Target.createTarget',{url:'about:blank',browserContextId});
  const {sessionId} = await command('Target.attachToTarget',{targetId,flatten:true});
  const cdp = (method,params={}) => command(method,params,sessionId);
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
  const metrics = async (width,height,touch=true) => {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:touch,screenWidth:width,screenHeight:height,screenOrientation:{type:width>height?'landscapePrimary':'portraitPrimary',angle:width>height?90:0}});
    await cdp('Emulation.setTouchEmulationEnabled',{enabled:touch});
    await settle();
  };
  await cdp('Page.enable');await cdp('Runtime.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__audit = {mediaCalls:0,mediaWrites:0,settingSaves:0};
    Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{__audit.mediaCalls++;throw new Error('Media forbidden in layout test');},enumerateDevices:async()=>[],getSupportedConstraints:()=>({}),addEventListener(){}}});
    Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});
    Object.defineProperty(document,'fullscreenEnabled',{value:false});
    Object.defineProperty(window,'localStorage',{value:{getItem(){return null},setItem(){throw new Error('Persistent settings forbidden in layout test')},removeItem(){throw new Error('Persistent settings forbidden in layout test')}}});
  `});
  await metrics(360,641);
  await cdp('Page.navigate',{url});
  for(let i=0;i<100;i++) {
    if(await evaluate(`document.readyState==='complete' && typeof state !== 'undefined' && !!window.QuietCameraEnhancements && document.querySelector('#settingsResizeHandle') !== null`)) break;
    await new Promise(resolve=>setTimeout(resolve,30));
  }
  await evaluate(`document.querySelector('#permissionPanel').hidden=true;document.querySelector('.camera-top-controls').inert=false;document.querySelector('#zoomControl').hidden=false;document.querySelector('#cameraVideo').poster='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#30424d"/><path d="M0 960H1080M540 0V1920" stroke="#8da1ad" stroke-width="4"/><text x="540" y="1030" text-anchor="middle" fill="white" font-size="48">MOCK PREVIEW</text></svg>');`);
  const measure = () => evaluate(`(() => {
    const q=s=>document.querySelector(s), rect=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom}};
    const stage=rect(q('#cameraStage')), toolbar=rect(q('.camera-top-controls'));
    const app=q('.app'),appBox=rect(app),appStyle=getComputedStyle(app),columns=appStyle.gridTemplateColumns.split(' ').map(parseFloat);
    const contentLeft=appBox.x+parseFloat(appStyle.paddingLeft);
    const previewCenterTarget=appStyle.display==='grid'?contentLeft+columns[0]+parseFloat(appStyle.columnGap)+columns[1]/2:contentLeft+(appBox.width-parseFloat(appStyle.paddingLeft)-parseFloat(appStyle.paddingRight))/2;
    const buttons=[...q('.camera-top-controls').children].filter(e=>getComputedStyle(e).display!=='none').map(e=>{const b=rect(e);const target=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return {id:e.id,...b,hit:target?.closest('button')===e,hitTarget:target?.id||target?.className}});
    const dialog=q('#settingsDialog'), sheetBody=q('#settingsSheetBody');
    return {viewport:{width:innerWidth,height:innerHeight},stage,toolbar,buttons,previewCenterTarget,badge:rect(q('#recordingBadge')),mic:rect(q('#microphoneStatusButton')),micHidden:q('#microphoneStatusButton').hidden,sheetMode:document.documentElement.classList.contains('settings-sheet-layout'),immersive:document.documentElement.classList.contains('immersive-mode'),sheet:{open:dialog.open,modal:dialog.matches(':modal'),...rect(dialog),body:rect(sheetBody),scrollHeight:sheetBody.scrollHeight,overflow:getComputedStyle(sheetBody).overflowY,min:Number(q('#settingsResizeHandle').getAttribute('aria-valuemin')),max:Number(q('#settingsResizeHandle').getAttribute('aria-valuemax')),now:Number(q('#settingsResizeHandle').getAttribute('aria-valuenow'))}};
  })()`);
  const overlap = (a,b) => a.x < b.right-.5 && a.right > b.x+.5 && a.y < b.bottom-.5 && a.bottom > b.y+.5;
  const screenshot = async name => {await evaluate(`document.querySelector('#toast').style.visibility='hidden'`);const {data}=await cdp('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(data,'base64'));};
  for(const [width,height,font,touch] of [[320,600,16,true],[360,641,16,true],[393,699,16,true],[393,700,16,true],[393,701,16,true],[420,800,16,true],[641,360,16,true],[800,393,16,true],[1280,800,16,false],[360,641,32,true],[641,360,32,true]]) {
    await metrics(width,height,touch);
    for(const mode of ['photo','video']) for(const ratio of ['4:3','1:1','16:9']) for(const torch of [false,true]) {
      await evaluate(`document.documentElement.style.fontSize='${font}px';if(document.documentElement.classList.contains('immersive-mode'))document.querySelector('#fullscreenButton').click();state.mode='${mode}';state.ratio='${ratio}';state.videoRatio='${ratio}';updateModeUi();elements.torchButton.hidden=${!torch};elements.recordingBadge.hidden=false;elements.cameraStatus.textContent='${mode==='video'?'1080×1920 60fps':'1440×2560 30fps'}';`);
      await settle();
      const m=await measure();
      const label=`${width}x${height}-${font}px-${mode}-${ratio}-${torch?'torch':'no-torch'}`;
      cases.push({label,...m});
      if(cases.length===1)await screenshot('00-first-case');
      // Physical portrait top maps to viewport left on this CCW90 emulation.
      assert(width>height?m.buttons.every(b=>!overlap(b,m.stage)):Math.abs(m.stage.y)<1,`${label}: orientation-specific preview geometry changed`);
      assert(m.stage.x>=-.5&&m.stage.y>=-.5&&m.stage.right<=width+.5&&m.stage.bottom<=height+.5,`${label}: complete preview outside viewport`);
      for(const b of m.buttons) {
        assert(b.width>=43.9 && b.height>=43.9,`${label}: ${b.id} smaller than 44px`);
        assert(b.x>=-.5 && b.right<=width+.5 && b.y>=-.5 && b.bottom<=height+.5,`${label}: ${b.id} outside viewport`);
        assert(b.hit,`${label}: ${b.id} center is not clickable`);
        if(width>height) assert(!overlap(b,m.stage),`${label}: landscape preview overlaps ${b.id}`);
        assert(!overlap(b,m.badge),`${label}: recording badge overlaps ${b.id}`);
      }
      if(width<700 && width<=height) {
        const expected=ratio==='4:3'?3/4:ratio==='16:9'?9/16:1;
        assert(Math.abs(m.stage.width/m.stage.height-expected)<.005,`${label}: preview ratio changed`);
      }
    }
  }
  await metrics(360,641);
  await evaluate(`document.documentElement.style.fontSize='16px';state.mode='video';state.videoRatio='16:9';updateModeUi();elements.torchButton.hidden=false;elements.recordingBadge.hidden=false;`);
  await settle();await screenshot('01-video-centered-wrapped-controls');
  // Real mode buttons, with no stream present, must not request media access.
  await evaluate(`elements.photoModeButton.click();elements.videoModeButton.click()`);await settle();
  assert.equal(await evaluate('state.mode'),'video');
  for(const [width,height,font] of [[360,641,16],[641,360,16],[360,641,32],[641,360,32]]) {
    await metrics(width,height);
    await evaluate(`document.documentElement.style.fontSize='${font}px';if(!document.documentElement.classList.contains('immersive-mode'))document.querySelector('#fullscreenButton').click();`);await settle();
    const m=await measure();
    assert(m.stage.y>=-.5 && m.stage.bottom<=height+.5,'Entire fullscreen frame must fit');
    assert(Math.abs(m.stage.width/m.stage.height-(width<height?9/16:16/9))<.002,'Fullscreen must preserve frame aspect');
    assert(!m.micHidden && m.mic.width>=44 && m.mic.height>=44,'MIC state must remain visible');
    assert(width>height?m.mic.x>=m.toolbar.right+7:m.mic.y>=m.toolbar.bottom+7,'MIC must stay inward from the physical top exit control');
    assert(!overlap(m.mic,m.toolbar),'MIC overlaps exit button');
    assert(!overlap(m.mic,m.badge),'MIC overlaps recording badge');
    assert(m.mic.right<=width+.5 && m.mic.bottom<=height+.5,'MIC outside fullscreen viewport');
    interactions.push({name:`fullscreen-${width}x${height}-${font}px`,...m});
    if(font===16)await screenshot(`02-fullscreen-${width}x${height}-mic`);
    await evaluate(`document.querySelector('#fullscreenButton').click()`);await settle();
    const normal=await measure();assert(!normal.immersive && normal.stage.y>=0 && normal.stage.bottom<=height+.5,'Fullscreen exit did not restore fitted layout');
  }
  // Use actual browser env(safe-area-inset-*) values, including a side cutout.
  const safeArea=await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,bottom:0,left:0,right:0}}).then(()=>true).catch(()=>false);
  if(safeArea)for(const [width,height,insets] of [[360,641,{top:28,bottom:20,left:0,right:64}],[641,360,{top:0,bottom:10,left:44,right:16}]])for(const font of [16,32]) {
    await metrics(width,height);await cdp('Emulation.setSafeAreaInsetsOverride',{insets});
    await evaluate(`document.documentElement.style.fontSize='${font}px';if(!document.documentElement.classList.contains('immersive-mode'))document.querySelector('#fullscreenButton').click()`);await settle();
    const m=await measure();
    assert(m.toolbar.y>=insets.top && m.toolbar.x>=insets.left && m.toolbar.right<=width-insets.right+.5,'Fullscreen controls ignored safe areas');
    assert((width>height?m.mic.x>=m.toolbar.right+7:m.mic.y>=m.toolbar.bottom+7)&&m.mic.right<=width-insets.right+.5,'MIC ignored physical orientation or safe areas');
    assert(!overlap(m.badge,m.toolbar) && !overlap(m.badge,m.mic),'Safe-area recording badge overlaps controls');
    interactions.push({name:`safe-area-${width}x${height}-${font}px`,...m});if(font===16)await screenshot(`03-fullscreen-safe-area-${width}x${height}`);
    await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,bottom:0,left:0,right:0}});
  }
  await metrics(360,641);await evaluate(`document.documentElement.style.fontSize='16px'`);
  await evaluate(`if(document.documentElement.classList.contains('immersive-mode'))document.querySelector('#fullscreenButton').click();elements.recordingBadge.hidden=true;elements.settingsButton.click()`);await settle();
  // Geometry assertions describe the settled sheet, not an arbitrary third animation frame.
  await evaluate(`(async()=>{const d=elements.settingsDialog,end=performance.now()+1500;while(d.dataset.sheetState==='opening'||d.classList.contains('is-settling')){if(performance.now()>end)throw Error('Settings opening did not finish');await new Promise(r=>requestAnimationFrame(r));}})()`);await settle();
  let m=await measure();assert(m.sheet.open && !m.sheet.modal,'Settings must remain non-modal');
  assert.equal(await evaluate(`document.querySelectorAll('[data-sheet-size],.settings-size-button').length`),0,'Height presets must be absent');
  const handle=await evaluate(`(()=>{const h=document.querySelector('#settingsResizeHandle'),r=h.getBoundingClientRect();return {role:h.getAttribute('role'),label:h.getAttribute('aria-label'),tabIndex:h.tabIndex,width:r.width,height:r.height}})()`);
  interactions.push({name:'settings-handle-before-assert',handle});await screenshot('04-settings-handle-measure');
  assert(handle.role==='separator' && handle.label.length>0 && handle.tabIndex===0 && handle.width>=44 && handle.height>=44,'Resize handle must remain labelled, focusable and touch sized: '+JSON.stringify(handle));
  interactions.push({name:'presets-absent-accessible-handle',handle});
  const resizeKey=async key=>{await evaluate(`document.querySelector('#settingsResizeHandle').focus({preventScroll:true})`);await cdp('Input.dispatchKeyEvent',{type:'keyDown',key,code:key});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key,code:key});await settle();};
  const heights=[];
  for(const key of ['Home','ArrowUp','PageUp']) {
    await resizeKey(key);m=await measure();heights.push(m.sheet.height);
    assert(m.sheet.y>=-.5 && m.sheet.bottom<=641.5,'Sheet outside viewport');
    assert(m.sheet.body.height>=43,'Sheet needs one visible settings row');
    assert(m.sheet.overflow==='auto','Settings body must scroll');
    assert(m.sheet.y>=8-.5,'Settings must stay below safe top margin');
    interactions.push({name:`settings-key-${key}`,...m});
  }
  assert(heights[0]<heights[1] && heights[1]<heights[2],'Arrow and Page keys should adjust height');
  await resizeKey('ArrowDown');assert(Math.abs((await measure()).sheet.height-(heights[2]-24))<2,'ArrowDown should lower height');
  await resizeKey('PageDown');assert(Math.abs((await measure()).sheet.height-heights[0])<2,'PageDown should lower height');
  interactions.push({name:'keyboard-down-and-page-down',...(await measure())});
  await resizeKey('Home');
  const point=await evaluate(`(()=>{const r=document.querySelector('#settingsResizeHandle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const start=(await measure()).sheet.height;
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
  await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y-100,button:'left',buttons:1});
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y-100,button:'left',clickCount:1});await settle();
  m=await measure();assert(m.sheet.height>start+90,'Mouse drag did not resize settings');interactions.push({name:'mouse-drag-up',...m});
  for(const cancel of [false,true]) {
    await resizeKey('Home');
    const p=await evaluate(`(()=>{const r=document.querySelector('#settingsResizeHandle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const before=(await measure()).sheet.height;
    await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1,radiusX:2,radiusY:2,force:1}]});
    await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x,y:p.y-80,id:1,radiusX:2,radiusY:2,force:1}]});await settle();
    assert((await measure()).sheet.height>before+70,'Touch drag did not resize settings');
    await cdp('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});await settle();
    if(cancel)for(let i=0;i<30&&await evaluate('elements.settingsDialog.classList.contains("is-settling")');i++)await new Promise(r=>setTimeout(r,15));m=await measure();if(cancel)assert(Math.abs(m.sheet.height-before)<2,'Touch cancellation did not restore prior size');
    assert.equal(await evaluate(`document.querySelector('#settingsDialog').classList.contains('is-resizing')`),false,'Drag state was not released');
    interactions.push({name:cancel?'touch-drag-cancel':'touch-drag-up',...m});
  }
  await resizeKey('PageUp');
  await evaluate(`elements.closeSettingsButton.click()`);await settle();await evaluate(`elements.settingsButton.click()`);await settle();
  assert(Math.abs((await measure()).sheet.height-633)<2,'Reopening should start at the full usable 641px viewport');
  interactions.push({name:'reopen-default-full-height',...(await measure())});await screenshot('04-settings-handle-only');
  await evaluate(`document.querySelector('#settingsResizeHandle').focus()`);
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home'});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home'});await settle();
  m=await measure();assert(Math.abs(m.sheet.height-m.sheet.min)<2,'Home did not clamp to minimum');
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End'});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End'});await settle();
  m=await measure();assert(Math.abs(m.sheet.height-m.sheet.max)<2,'End did not clamp to maximum');assert(m.sheet.now>=m.sheet.min && m.sheet.now<=m.sheet.max,'Accessible resize value is outside its bounds');const portraitPreferredHeight=m.sheet.height;
  await metrics(641,360);m=await measure();assert(m.sheet.y>=-.5 && m.sheet.bottom<=360.5 && m.sheet.body.height>=43,'Rotation did not reclamp sheet');interactions.push({name:'settings-rotation-clamp',...m});await screenshot('05-settings-landscape');
  await metrics(360,641);assert(Math.abs((await measure()).sheet.height-portraitPreferredHeight)<2,'Rotation back should recover the preferred height');interactions.push({name:'rotation-back-retains-height',...(await measure())});
  await evaluate(`document.documentElement.style.fontSize='32px'`);await settle();m=await measure();assert(m.sheet.body.height>=43 && m.sheet.bottom<=641.5,'Enlarged text broke settings sizing');interactions.push({name:'settings-200-percent-text',...m});await screenshot('06-settings-200-percent-text');
  await metrics(641,360);await settle();m=await measure();
  const firstRowHeight=await evaluate(`[...document.querySelectorAll('#settingsSheetBody .setting-field')].find(e=>e.getBoundingClientRect().height>0).getBoundingClientRect().height`);
  assert(m.sheet.body.height>=firstRowHeight-.5 && m.sheet.y>=0 && m.sheet.bottom<=360.5,'Enlarged landscape settings must show a complete usable row');interactions.push({name:'settings-landscape-200-percent-text',...m});await screenshot('07-settings-landscape-200-percent-text');
  await evaluate(`document.querySelector('#closeSettingsButton').click()`);await settle();
  assert.equal(await evaluate(`document.activeElement.id`),'settingsButton','Closing settings should restore focus');
  await metrics(360,641);await evaluate(`document.documentElement.style.fontSize='16px';document.querySelector('#fullscreenButton').click();elements.settingsButton.click()`);await settle();
  await resizeKey('Home');const immersiveMinimum=(await measure()).sheet.height;await resizeKey('PageUp');m=await measure();
  assert(m.sheet.open && !m.sheet.modal && m.sheet.height>immersiveMinimum+60 && m.sheet.bottom<=641.5,'Fullscreen handle must remain usable and bounded');interactions.push({name:'fullscreen-handle-resize',...m});await screenshot('08-fullscreen-settings-handle');
  await evaluate(`elements.closeSettingsButton.click();document.querySelector('#fullscreenButton').click()`);await settle();
  await metrics(1280,800,false);await evaluate(`document.documentElement.style.fontSize='16px'`);await settle();
  assert.equal(await evaluate(`document.querySelector('#settingsPanel').parentElement.id`),'settingsSheetBody','Overlay prototype keeps accessible settings sheet on desktop');
  finalAudit=await evaluate('window.__audit');assert.equal(finalAudit.mediaCalls,0);assert.equal(finalAudit.mediaWrites,0);assert.equal(exceptions.length,0,JSON.stringify(exceptions));
  fs.writeFileSync(path.join(output,'layout-test-results.json'),JSON.stringify({passed:true,cases,interactions,safeAreaSupported:safeArea,audit:finalAudit,exceptions},null,2));
  console.log(JSON.stringify({passed:true,layoutCases:cases.length,interactionChecks:interactions.length,safeAreaSupported:safeArea,audit:finalAudit,output}));
} catch(error) {
  fs.writeFileSync(path.join(output,'layout-test-results.json'),JSON.stringify({passed:false,error:String(error),cases,interactions,exceptions},null,2));
  throw error;
} finally {
  await command('Browser.close').catch(()=>chrome.kill());socket.close();server.close();server.closeAllConnections?.();chrome.kill();chrome.stderr?.destroy();chrome.unref();
}
