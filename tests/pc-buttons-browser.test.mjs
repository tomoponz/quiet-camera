// Synthetic media only, with a fresh browser profile and isolated storage.
// No real camera, microphone, phone, or user gallery is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
const root=process.env.QUIET_CAMERA_GALLERY_ROOT||path.resolve(import.meta.dirname,'..');
const output=process.env.QUIET_CAMERA_PC_BUTTONS_TEST_OUTPUT||path.resolve(root,'test-results/pc-buttons');
const fixtures=process.env.QUIET_CAMERA_REVIEW_FIXTURES||path.resolve(root,'tests/fixtures');
fs.mkdirSync(output,{recursive:true});
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'quiet-camera-media-review-'));
const baselineRoot=path.join(scratch,'fixed-pc-baseline');
const baselineFixture=path.join(root,'tests/fixtures/pc-controls-v20261025.3');
const baselineMetadata=JSON.parse(fs.readFileSync(baselineFixture+'.json','utf8'));
const baselineZip=fs.readFileSync(baselineFixture+'.zip');
const hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(hash(baselineZip),baselineMetadata.archiveSha256,'fixed baseline archive integrity');
let offset=0;const extracted=new Set();
while(baselineZip.readUInt32LE(offset)===0x04034b50){
 const method=baselineZip.readUInt16LE(offset+8),size=baselineZip.readUInt32LE(offset+18),nameSize=baselineZip.readUInt16LE(offset+26),extraSize=baselineZip.readUInt16LE(offset+28);
 assert.equal(method,0,'fixture uses stored ZIP entries');
 const name=baselineZip.subarray(offset+30,offset+30+nameSize).toString('utf8'),start=offset+30+nameSize+extraSize,dest=path.resolve(baselineRoot,name);
 assert(dest.startsWith(baselineRoot+path.sep),'baseline stays within owned scratch directory');
 const metadata=baselineMetadata.files.find(f=>f.path===name),bytes=baselineZip.subarray(start,start+size);assert(metadata,'only manifest entries');assert.equal(hash(bytes),metadata.sha256,'fixed baseline file integrity '+name);
 fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes);extracted.add(name);offset=start+size;
}
assert.equal(extracted.size,baselineMetadata.files.length,'all fixed baseline files extracted');
const server=http.createServer((req,res)=>{
 let pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const isBaseline=pathname.startsWith('/__baseline/');if(isBaseline)pathname=pathname.slice('/__baseline'.length);const servedRoot=isBaseline?baselineRoot:root;
 let file;
 if(pathname.startsWith('/__fixture/')){
  const basename=pathname.slice('/__fixture/'.length);
  if(!['portrait.mp4','landscape.mp4','stream.webm'].includes(basename)){res.writeHead(404).end();return;}
  file=path.join(fixtures,basename);
 }else{
  file=path.resolve(servedRoot,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(servedRoot+path.sep)){res.writeHead(403).end();return;}
 }
 try{
  const bytes=fs.readFileSync(file);
  res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.mp4':'video/mp4','.webm':'video/webm','.webmanifest':'application/manifest+json'})[path.extname(file)]||'application/octet-stream','Content-Length':bytes.length,'Permissions-Policy':'camera=(), microphone=()','Cache-Control':'no-store'});
  res.end(bytes);
 }catch{res.writeHead(404).end();}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const url=`http://127.0.0.1:${server.address().port}/`;
const chrome=spawn(process.env.CHROME_PATH||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'google-chrome'),['--headless=new','--remote-debugging-port=0',`--user-data-dir=${scratch}`,'--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check','--mute-audio','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let stderr='';
const endpoint=await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error('Chrome startup timed out '+stderr)),15000);
 chrome.stderr.on('data',d=>{stderr+=d;const m=stderr.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1]);}});
 chrome.on('error',reject);chrome.on('exit',code=>{clearTimeout(timer);reject(new Error('Chrome exited '+code));});
});
const socket=new WebSocket(endpoint);await once(socket,'open');let seq=1;
const pending=new Map(),exceptions=[];let sessionId;
socket.addEventListener('message',event=>{
 const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);
 if(!pending.has(m.id))return;const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);
});
function command(method,params={},session){return new Promise((resolve,reject)=>{const id=seq++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out'));},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(session?{sessionId:session}:{})}));});}
const cdp=(m,p={})=>command(m,p,sessionId);
const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(expression,timeout=8000)=>{const end=Date.now()+timeout;do{const value=await evaluate(expression);if(value)return value;await sleep(25);}while(Date.now()<end);throw new Error('Timed out: '+expression);};
const results=[];
// Fullscreen fixtures dispatch the same resize synchronization as the live UI.
const LABELS_OFF=process.env.QC_LABELS_OFF==='1'; // experiment knob only (critique)
const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);results.push({name,passed:true});};
const shot=async name=>{const r=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,name),Buffer.from(r.data,'base64'));};
const selected=()=>evaluate('state.selectedMedia?.id || null');
const close=async()=>{await evaluate('if(elements.reviewDialog.open)elements.reviewDialog.close()');await until('!elements.reviewDialog.open && !state.selectedMedia');};
const open=async id=>{
 if(await evaluate('elements.reviewDialog.open'))await close();
 await evaluate(`(async()=>{selectMedia(await getStoredMedia(${JSON.stringify(id)}));elements.reviewDialog.showModal()})()`);
 await until('elements.reviewDialog.open && !!state.selectedMedia');
 if(await evaluate('state.selectedMedia.kind === "photo"'))await until('elements.reviewImage.complete && elements.reviewImage.naturalWidth > 0 && !document.querySelector("#reviewPhotoNavigation").hasAttribute("aria-busy")');
};
const metrics=async(w,h,touch=true)=>{await cdp('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:touch,screenWidth:w,screenHeight:h,screenOrientation:{type:w>h?'landscapePrimary':'portraitPrimary',angle:w>h?90:0}});await cdp('Emulation.setTouchEmulationEnabled',{enabled:touch});await sleep(40);};
const swipe=async(dx,dy=0,{cancel=false,multi=false}={})=>{
 const p=await evaluate('(()=>{const r=document.querySelector("#reviewViewer").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
 const point=(x,y,id=1)=>({x,y,id,radiusX:3,radiusY:3,force:1});
 await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(p.x,p.y)]});
 if(multi)await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(p.x,p.y),point(p.x+30,p.y,2)]});
 for(let i=1;i<=5;i++){
  const points=[point(p.x+dx*i/5,p.y+dy*i/5)];if(multi)points.push(point(p.x+30+dx*i/5,p.y+dy*i/5,2));
  await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points});await sleep(20);
 }
 // End a drag without manufacturing a high-velocity fling in CDP's injector.
 await sleep(160);await cdp('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});await sleep(90);
};
let audit;
const baselineResults=[],candidateResults=[],comparisons=[];
try{
 const {browserContextId}=await command('Target.createBrowserContext');for(const name of ['camera','microphone'])await command('Browser.setPermission',{permission:{name},setting:'denied',browserContextId});const {targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});({sessionId}=await command('Target.attachToTarget',{targetId,flatten:true}));await cdp('Page.enable');await cdp('Runtime.enable');
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`window.__audit={mediaCalls:0,clicks:[]};Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{__audit.mediaCalls++;throw new Error('Real media forbidden')},enumerateDevices:async()=>[],getSupportedConstraints:()=>({}),addEventListener(){}}});Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});`});
 const configure=async({w,h,touch=false,angle=0,font=16})=>{await cdp('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:touch,screenWidth:w,screenHeight:h,screenOrientation:{type:w>h?'landscapePrimary':'portraitPrimary',angle}});await cdp('Emulation.setTouchEmulationEnabled',{enabled:touch});await evaluate(`if(typeof elements!=='undefined'){document.documentElement.style.fontSize='${font}px';QuietCameraOverlay?.schedule()}`);await sleep(70)};
 const load=async baseline=>{await cdp('Page.navigate',{url:url+(baseline?'__baseline/':'')});await until('typeof elements!=="undefined"&&!!window.QuietCameraOverlay&&typeof updateModeUi==="function"');await evaluate(`(async()=>{const c=document.createElement('canvas');c.width=1280;c.height=720;const x=c.getContext('2d');x.fillStyle='#16536d';x.fillRect(0,0,c.width,c.height);for(let i=0;i<8;i++){x.fillStyle=['#2e758c','#bf934a'][i%2];x.fillRect(i*160,0,160,c.height)}x.strokeStyle='white';x.lineWidth=8;x.strokeRect(8,8,1264,704);x.fillStyle='white';x.font='bold 48px sans-serif';x.fillText('SYNTHETIC PREVIEW - NO CAMERA',110,360);window.__synthetic=c.captureStream(5);elements.video.srcObject=__synthetic;await elements.video.play();elements.permissionPanel.hidden=true;QuietCameraOverlay.schedule()})()`);await until('elements.video.videoWidth===1280&&elements.video.videoHeight===720');await sleep(60)};
 const prepare=async(mode='video',ratio='16:9',immersive=false)=>{await evaluate(`document.documentElement.classList.toggle('immersive-mode',${immersive});window.dispatchEvent(new Event('resize'));state.mode='${mode}';state.ratio='${ratio}';state.videoRatio='${ratio}';updateModeUi();document.querySelector('.camera-top-controls').inert=false;document.querySelector('.mode-switcher').inert=false;for(const b of document.querySelectorAll('#cameraControls button'))b.disabled=false;elements.torchButton.hidden=false;QuietCameraOverlay.schedule()`);await sleep(90)};
 const measure=()=>evaluate(`(()=>{const box=e=>{const r=e.getBoundingClientRect();return{x:+r.x.toFixed(3),y:+r.y.toFixed(3),width:+r.width.toFixed(3),height:+r.height.toFixed(3),right:+r.right.toFixed(3),bottom:+r.bottom.toFixed(3)}};const ids=['galleryButton','shutterButton','settingsButton','switchButton','timerButton','ratioButton','torchButton','gridButton','fullscreenButton','photoModeButton','videoModeButton','microphoneStatusButton'];return{viewport:[innerWidth,innerHeight],pointer:matchMedia('(pointer:fine)').matches,hover:matchMedia('(hover:hover)').matches,enabled:getComputedStyle(document.querySelector('#cameraSurface')).getPropertyValue('--pc-controls-enabled').trim()==='1',quarter:document.querySelector('#cameraSurface').dataset.deviceRotation,stage:box(elements.cameraStage),selector:box(document.querySelector('.mode-switcher')),buttons:ids.map(id=>{const e=document.getElementById(id);return{id,...box(e),font:getComputedStyle(e).fontSize,svg:e.querySelector('svg')?box(e.querySelector('svg')):null,visible:getComputedStyle(e).display!=='none',label:e.getAttribute('aria-label')}}),page:[scrollX,scrollY],fullscreenPressed:document.getElementById('fullscreenButton').getAttribute('aria-pressed'),fullscreenBackground:getComputedStyle(document.getElementById('fullscreenButton')).backgroundColor}})()`);
 const layouts=[
  {w:1000,h:600},{w:1024,h:768},{w:1280,h:800},{w:1440,h:900},{w:1920,h:1080},{w:1280,h:800,font:32},{w:1024,h:1366},{w:1280,h:800,angle:90},
  {w:393,h:850,touch:true},{w:850,h:393,touch:true,angle:90},{w:850,h:393,touch:true,angle:270},{w:915,h:412,touch:true,angle:90},{w:1280,h:800,touch:true,angle:90},{w:393,h:800,touch:true,font:32},
  {w:915,h:412,angle:90},{w:999,h:800},{w:1280,h:599},{w:900,h:800},
 ];
 const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.x,b.x)>.6&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>.6;
 for(const baseline of [true,false]){
  await load(baseline);
  for(let i=0;i<layouts.length;i++){
   const spec=layouts[i];await configure(spec);
   const active=spec.w>=1000&&spec.h>=600&&!spec.touch;
   for(const [mode,ratio,immersive] of active?[['photo','16:9',false],['video','16:9',false],['video','16:9',true]]:[['photo','16:9',false],['video','16:9',false],['photo','4:3',false],['photo','1:1',false]]){
    await prepare(mode,ratio,immersive);const m=await measure(),key=[i,mode,ratio,immersive].join('-');check('fullscreen pressed state matches fixture '+key,await evaluate('document.getElementById("fullscreenButton").getAttribute("aria-pressed") === String(document.documentElement.classList.contains("immersive-mode"))'),true);(baseline?baselineResults:candidateResults).push({key,spec,...m});
    if(!baseline){
     const b=baselineResults.find(x=>x.key===key);check('desktop scope matches capability and space '+key,m.enabled,active);
     check('fullscreen toggle state matches immersive class '+key,m.fullscreenPressed,String(immersive));
     if(!active){check('phone and excluded layouts stay byte-for-byte in measured geometry '+key,{stage:m.stage,selector:m.selector,buttons:m.buttons,page:m.page},{stage:b.stage,selector:b.selector,buttons:b.buttons,page:b.page});}
     else{
      const visible=m.buttons.filter(e=>e.visible&&e.width>0&&e.height>0),all=m.buttons;check('all desktop controls fit viewport '+key,visible.every(e=>e.x>=-.5&&e.y>=-.5&&e.right<=spec.w+.5&&e.bottom<=spec.h+.5),true);
      check('desktop controls do not overlap each other '+key,!visible.some((e,i)=>visible.slice(i+1).some(f=>overlap(e,f))),true);
      if(m.quarter==='90'||m.quarter==='270')check('rotated desktop preview avoids every visible button '+key,visible.filter(e=>overlap(m.stage,e)).map(e=>e.id),[]);
      check('desktop preview remains full aspect-fit area inside viewport '+key,m.stage.width>0&&m.stage.height>0&&m.stage.x>=-.5&&m.stage.y>=-.5&&m.stage.right<=spec.w+.5&&m.stage.bottom<=spec.h+.5&&m.page.every(v=>v===0),true);
      if(!immersive){for(const id of ['galleryButton','settingsButton','shutterButton','switchButton','timerButton','ratioButton','gridButton','fullscreenButton']){const e=all.find(e=>e.id===id),before=b.buttons.find(e=>e.id===id);check('intended control is enlarged '+key+'-'+id,e.width>before.width+5&&e.height>before.height+5,true);}}
      check('utility icon scales with its target '+key,m.buttons.find(e=>e.id==='fullscreenButton').svg.width>=27.9,true);
      if(mode==='video')check('MIC remains explicit on two lines '+key,await evaluate('(()=>{const a=document.querySelector(".microphone-status-current"),b=document.querySelector(".microphone-state-line"),r=a.getBoundingClientRect(),s=b.getBoundingClientRect();return a.textContent.trim()==="現在"&&b.textContent.includes("MIC")&&s.top>=r.bottom-1})()'),true);
     }
    }
    if(spec.w===1280&&spec.h===800&&!spec.font&&!spec.angle&&mode==='video'&&!immersive)await shot((baseline?'before':'after')+'-pc-video.png');
   }
  }
  check((baseline?'baseline':'candidate')+' never requested real camera',await evaluate('__audit.mediaCalls'),0);
 }
 const labelCases=[];globalThis.__labelCases=labelCases;
 const labelProbe=()=>evaluate(`(()=>{const R=r=>({x:r.left,y:r.top,right:r.right,bottom:r.bottom});const inside=(a,b)=>a.x>=b.x-.6&&a.y>=b.y-.6&&a.right<=b.right+.6&&a.bottom<=b.bottom+.6;const ov=(a,b)=>Math.min(a.right,b.right)-Math.max(a.x,b.x)>.6&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>.6;
  const surf=document.querySelector('#cameraSurface'),stage=R(elements.cameraStage.getBoundingClientRect());const buttons=[...document.querySelectorAll('#cameraControls button')].filter(b=>getComputedStyle(b).display!=='none'&&b.getBoundingClientRect().width>0);
  const labels=buttons.filter(b=>b.querySelector(':scope>.device-upright')).map(b=>{const s=b.querySelector(':scope>.device-upright'),range=document.createRange();range.selectNodeContents(s);const ink=R(range.getBoundingClientRect()),sb=R(s.getBoundingClientRect()),bb=R(b.getBoundingClientRect());return{id:b.id,text:s.textContent.replace(/\s+/g,' ').trim(),sw:s.scrollWidth,cw:s.clientWidth,sh:s.scrollHeight,ch:s.clientHeight,clip:s.scrollWidth>s.clientWidth,inkInSpan:inside(ink,sb),inkInButton:inside(ink,bb),spanInButton:inside(sb,bb),ink,button:bb}});
  const vis=buttons.map(b=>({id:b.id,...R(b.getBoundingClientRect())}));
  return{q:surf.dataset.deviceRotation,pc:getComputedStyle(surf).getPropertyValue('--pc-controls-enabled').trim()==='1',labels,stageOverlaps:vis.filter(b=>ov(stage,b)).map(b=>b.id),fitViewport:vis.filter(b=>!(b.x>=-.5&&b.y>=-.5&&b.right<=innerWidth+.5&&b.bottom<=innerHeight+.5)).map(b=>b.id),controlOverlaps:vis.flatMap((a,i)=>vis.slice(i+1).filter(b=>ov(a,b)).map(b=>a.id+'/'+b.id)),stagePage:[scrollX,scrollY]}})()`);
 if(!LABELS_OFF){
  const pcLayouts=layouts.filter(l=>l.w>=1000&&l.h>=600&&!l.touch&&!l.font);
  for(const spec of pcLayouts)for(const font of [16,20,24,32])for(const [mode,gallery] of [['photo',null],['video',null],['video','録画取消'],['video','保存中']]){
   await configure({...spec,font});await prepare(mode);if(gallery)await evaluate(`elements.galleryPlaceholder.textContent=${JSON.stringify(gallery)};QuietCameraOverlay.schedule()`);await sleep(gallery?90:0);
   const r=await labelProbe(),key=[spec.w+'x'+spec.h+(spec.angle?'@'+spec.angle:''),font,mode,gallery||'-'].join('-');labelCases.push({key,...r});
   if(gallery){await evaluate('elements.galleryPlaceholder.textContent="履歴";QuietCameraOverlay.schedule()');await sleep(60);}
   check('desktop scope active for label case '+key,r.pc,true);
   check('desktop labels are not clipped '+key,r.labels.filter(l=>l.clip).map(l=>l.id+':'+l.sw+'/'+l.cw),[]);
   check('desktop label ink stays inside its button '+key,r.labels.filter(l=>!l.inkInButton).map(l=>l.id),[]);
   if(r.q==='90'||r.q==='270')check('rotated desktop preview avoids every visible button at font '+key,r.stageOverlaps,[]);
  }
 }
 // Normal functional mouse/keyboard interactions; dangerous camera actions are
 // intercepted before handlers, rather than invoking even a mocked capture.
 await configure({w:1280,h:800});await prepare('photo');
 const photoBox=(await measure()).selector;await evaluate('elements.videoModeButton.click()');await sleep(100);check('mode selector stays stationary during real mode click',(await measure()).selector,photoBox);await prepare('video');
 await evaluate(`window.__guard=e=>{const b=e.target.closest('#shutterButton,#switchButton,#torchButton,#microphoneStatusButton');if(b){e.preventDefault();e.stopImmediatePropagation();__audit.clicks.push(b.id)}};document.addEventListener('click',__guard,true)`);
 const click=async id=>{const p=await evaluate(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);await cdp('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});await sleep(40)};
 await click('shutterButton');check('mouse reaches enlarged primary target',await evaluate('__audit.clicks.at(-1)'),'shutterButton');
 await evaluate('elements.shutterButton.focus({preventScroll:true})');for(const type of ['keyDown','keyUp'])await cdp('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,...(type==='keyDown'?{text:'\r',unmodifiedText:'\r'}:{})});check('keyboard activates same primary target',await evaluate('__audit.clicks.at(-1)'),'shutterButton');check('primary remains visibly focused',await evaluate('elements.shutterButton.matches(":focus-visible")'),true);
 await click('settingsButton');await until('elements.settingsDialog.open&&!elements.settingsDialog.classList.contains("is-settling")');check('settings opens at maximum with unchanged panel buttons',await evaluate('Math.abs(elements.settingsDialog.getBoundingClientRect().height-Number(document.querySelector("#settingsResizeHandle").getAttribute("aria-valuemax")))<1&&elements.closeSettingsButton.getBoundingClientRect().width===44'),true);await evaluate('elements.closeSettingsButton.click()');await sleep(50);
 await click('galleryButton');await until('elements.galleryDialog.open&&!elements.galleryDialog.classList.contains("is-settling")');check('history opens at maximum without resized close button',await evaluate('Math.abs(elements.galleryDialog.getBoundingClientRect().height-Number(document.querySelector("#galleryResizeHandle").getAttribute("aria-valuemax")))<1&&elements.closeGalleryButton.getBoundingClientRect().width===44'),true);await evaluate('elements.closeGalleryButton.click()');await sleep(50);
 const g=await evaluate('elements.gridOverlay.hidden');await click('gridButton');check('mouse grid button keeps its original action',await evaluate('elements.gridOverlay.hidden'),!g);await click('gridButton');
 // Transition from desktop to short/phone viewport must remove PC sizing and
 // recompute geometry rather than keep a stale microphone/rail measurement.
 await configure({w:850,h:393,touch:true,angle:90});await prepare('video');const fallback=await measure(),expected=baselineResults.find(e=>e.key==='9-video-16:9-false');check('resizing desktop back to phone restores baseline',fallback.buttons,expected.buttons);
 for(const font of [16,32]){await configure({w:1280,h:800,font});await prepare('video');await evaluate('elements.zoomControl.hidden=false;elements.zoomRange.min="1";elements.zoomRange.max="8";elements.zoomRange.value="2";elements.zoomValue.textContent="2.0×";elements.cameraStatus.textContent="1920×1080 60fps";elements.mediaStatus.textContent="MP4";QuietCameraOverlay.schedule()');await sleep(100);
  check('zoom hit area stays separate from larger buttons font'+font,await evaluate(`(()=>{const z=elements.zoomControl.getBoundingClientRect(),overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>.6&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.6;return [...document.querySelectorAll('#cameraControls button')].filter(e=>getComputedStyle(e).display!=='none').every(e=>!overlap(z,e.getBoundingClientRect()))})()`),true);
  check('format and resolution remain separately readable font'+font,await evaluate(`(()=>{const a=elements.cameraStatus.getBoundingClientRect(),b=elements.mediaStatus.getBoundingClientRect();return a.left>=0&&b.left>=0&&a.right<=innerWidth&&b.right<=innerWidth&&(Math.min(a.right,b.right)-Math.max(a.left,b.left)<.6||Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)<.6)})()`),true);
  if(font===16)await shot('after-pc-video-with-zoom.png');
 }
 audit=await evaluate('__audit');check('no camera microphone capture in interactive QA',audit.mediaCalls,0);check('no unhandled exceptions',exceptions.length,0);
 for(const b of candidateResults){const a=baselineResults.find(a=>a.key===b.key);if(b.enabled)comparisons.push({key:b.key,spec:b.spec,buttons:b.buttons.map(e=>({id:e.id,before:a.buttons.find(a=>a.id===e.id),after:e}))});}
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:true,version:'2026.10.27.3',checks:results,labelCases:globalThis.__labelCases,baselineResults,candidateResults,comparisons,audit,limits:['Headless PC Chrome synthetic geometry and mouse/keyboard only; no real camera or S25 operation','Native capture/camera/torch/MIC actions intercepted, never invoked','PC UI enabled only for primary fine+hover and viewport>=1000x600']},null,2));console.log(JSON.stringify({passed:true,checks:results.length,measuredCases:candidateResults.length,output}));
}catch(error){await shot('failure.png').catch(()=>{});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:error.stack,checks:results,labelCases:globalThis.__labelCases,baselineResults,candidateResults,exceptions},null,2));console.error(error);process.exitCode=1;}
finally{await command('Browser.close').catch(()=>chrome.kill());socket.close();server.close();server.closeAllConnections?.();chrome.kill();chrome.stderr?.destroy();chrome.unref();}
