import {createOwnedScratch,cleanupBrowserTest} from './browser-cleanup.mjs';
// Synthetic media only, with a fresh browser profile and isolated storage.
// No real camera, microphone, phone, or user gallery is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const root=process.env.QUIET_CAMERA_GALLERY_ROOT||path.resolve(import.meta.dirname,'..');
const output=process.env.QUIET_CAMERA_ACTIONS_TEST_OUTPUT||path.resolve(root,'test-results/actions');
const fixtures=process.env.QUIET_CAMERA_REVIEW_FIXTURES||path.resolve(root,'tests/fixtures');
fs.mkdirSync(output,{recursive:true});
const scratch=createOwnedScratch('quiet-camera-media-review-');
let server,chrome,socket,cleanupCommand;const pending=new Map();
try {
server=http.createServer((req,res)=>{
 const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 let file;
 if(pathname.startsWith('/__fixture/')){
  const basename=pathname.slice('/__fixture/'.length);
  if(!['portrait.mp4','landscape.mp4','stream.webm'].includes(basename)){res.writeHead(404).end();return;}
  file=path.join(fixtures,basename);
 }else{
  file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 }
 try{
  const bytes=fs.readFileSync(file);
  res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.mp4':'video/mp4','.webm':'video/webm','.webmanifest':'application/manifest+json'})[path.extname(file)]||'application/octet-stream','Content-Length':bytes.length,'Permissions-Policy':'camera=(), microphone=()','Cache-Control':'no-store'});
  res.end(bytes);
 }catch{res.writeHead(404).end();}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const url=`http://127.0.0.1:${server.address().port}/`;
chrome=spawn(process.env.CHROME_PATH||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'google-chrome'),['--headless=new','--remote-debugging-port=0',`--user-data-dir=${scratch}`,'--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check','--mute-audio','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let stderr='';
const endpoint=await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error('Chrome startup timed out '+stderr)),15000);
 chrome.stderr.on('data',d=>{stderr+=d;const m=stderr.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1]);}});
 chrome.on('error',error=>{clearTimeout(timer);reject(error)});chrome.on('exit',code=>{clearTimeout(timer);reject(new Error('Chrome exited '+code));});
});
socket=new WebSocket(endpoint);await once(socket,'open');let seq=1;
const exceptions=[];let sessionId;
socket.addEventListener('message',event=>{
 const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);
 if(!pending.has(m.id))return;const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);
});
function command(method,params={},session){return new Promise((resolve,reject)=>{const id=seq++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out'));},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(session?{sessionId:session}:{})}));});}
cleanupCommand=command;
const cdp=(m,p={})=>command(m,p,sessionId);
const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(expression,timeout=8000)=>{const end=Date.now()+timeout;do{const value=await evaluate(expression);if(value)return value;await sleep(25);}while(Date.now()<end);throw new Error('Timed out: '+expression);};
const results=[];
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
try {
 const {browserContextId}=await command('Target.createBrowserContext');for(const name of ['camera','microphone'])await command('Browser.setPermission',{permission:{name},setting:'denied',browserContextId});const {targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});({sessionId}=await command('Target.attachToTarget',{targetId,flatten:true}));await cdp('Page.enable');await cdp('Runtime.enable');await metrics(393,800);
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`window.__audit={mediaCalls:0};Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{__audit.mediaCalls++;throw new Error('Camera forbidden')},enumerateDevices:async()=>[],getSupportedConstraints:()=>({}),addEventListener(){}}});Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});`});
 await cdp('Page.navigate',{url});await until('typeof putMedia==="function"&&!!window.QuietCameraGallery');
 await evaluate(`(async()=>{for(let i=0;i<32;i++){const c=document.createElement('canvas');c.width=320;c.height=240;const x=c.getContext('2d');x.fillStyle='hsl('+i*29+' 60% 30%)';x.fillRect(0,0,320,240);x.fillStyle='white';x.font='25px sans-serif';x.fillText('SAMPLE '+i,20,120);const blob=await canvasToBlob(c,'image/png',1);await putMedia({id:'p'+i,kind:'photo',createdAt:1700000000000+i*1000,blob,previewBlob:blob,extension:'png',mimeType:'image/png',meta:'SAMPLE '+i})}await refreshGallery()})()`);
 const settled=async id=>{await until(`document.querySelector('#${id}').open&&!document.querySelector('#${id}').classList.contains('is-settling')`);await sleep(30)};
 const openSheet=async kind=>{if(kind==='gallery')await evaluate('QuietCameraEnhancements.enhancedOpenGallery()');else await evaluate('elements.settingsButton.click()');await settled(kind+'Dialog')};
 const closeSheet=async kind=>{await evaluate(`elements.${kind==='gallery'?'closeGalleryButton':'closeSettingsButton'}.click()`);await until(`!elements.${kind}Dialog.open`);await sleep(40)};
 const bounds=kind=>evaluate(`(()=>{const d=elements.${kind}Dialog,b=d.getBoundingClientRect(),h=document.querySelector('#${kind}ResizeHandle');return{top:b.top,bottom:b.bottom,height:b.height,max:+h.getAttribute('aria-valuemax'),offset:getComputedStyle(d).transform,state:d.dataset.sheetState||null}})()`);
 const list=()=>evaluate(`(()=>{const b=document.querySelector('#gallerySheetBody'),c=document.querySelector('.gallery-card'),r=c.getBoundingClientRect();return{top:r.top,left:r.left,scroll:b.scrollTop,height:b.clientHeight,scrollHeight:b.scrollHeight,summary:elements.gallerySummary.textContent,headerHeight:elements.galleryDialog.querySelector(".gallery-header").getBoundingClientRect().height}})()`);
 const keyboard=async key=>{for(const type of [key==='Escape'?'rawKeyDown':'keyDown','keyUp'])await cdp('Input.dispatchKeyEvent',{type,key,code:key,...(key==='Escape'?{windowsVirtualKeyCode:27,nativeVirtualKeyCode:27}:{})})};
 for(const kind of ['gallery','settings']){
  await evaluate(kind==='gallery'?'QuietCameraEnhancements.enhancedOpenGallery()':'elements.settingsButton.click()');
  const animation=await evaluate(`(()=>{const d=elements.${kind}Dialog,a=d.getAnimations().find(a=>a.effect.target===d);if(!a)return null;a.pause();a.currentTime=0;window.__opening=a;return{state:d.dataset.sheetState,frames:a.effect.getKeyframes().map(f=>({height:f.height,transform:f.transform})),duration:a.effect.getTiming().duration}})()`);
  check(kind+' animates entire panel on open',!!animation&&animation.state==='opening'&&animation.frames.length===2,true);
  const start=await bounds(kind);check(kind+' starts below visible bottom',start.top>=799,true);
  await evaluate('__opening.currentTime=90');const middle=await bounds(kind);check(kind+' slides up along handle axis',middle.top<start.top&&middle.top>7,true);
  check(kind+' opening keeps full target height',Math.abs(start.height-start.max)<1&&Math.abs(middle.height-middle.max)<1,true);
  await evaluate('__opening.finish()');await settled(kind+'Dialog');let b=await bounds(kind);check(kind+' ends full height without residual offset',Math.abs(b.height-b.max)<1&&Math.abs(b.top-8)<1&&Math.abs(b.bottom-800)<1&&b.state===null,true);
  await evaluate(`document.querySelector('#${kind}ResizeHandle').focus()`);await keyboard('Home');b=await bounds(kind);check(kind+' handle can collapse after entering',b.height<b.max-50,true);
  await closeSheet(kind);await openSheet(kind);b=await bounds(kind);check(kind+' every reopen returns to maximum',Math.abs(b.height-b.max)<1,true);await closeSheet(kind);
 }
 for(const [w,h,q,font]of[[393,800,0,16],[320,480,0,16],[800,393,1,16],[800,393,3,16],[641,274,1,32],[641,274,3,32],[393,800,0,32],[320,480,0,32],[270,500,0,16]]){
  await cdp('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:2.75,mobile:true,screenWidth:w,screenHeight:h,screenOrientation:{type:q===3?'landscapeSecondary':q===1?'landscapePrimary':'portraitPrimary',angle:q*90}});await evaluate(`document.documentElement.style.fontSize='${font}px'`);await openSheet('gallery');
  const key=[w,h,q,font].join('-'),initial=await bounds('gallery');check('maximum viewport fit '+key,initial.top>=7.5&&initial.bottom<=h+.5,true);
  for(const position of [0,400,1e9]){
   await evaluate(`document.querySelector('#gallerySheetBody').scrollTop=${position}`);await sleep(30);const before=await list();
   await evaluate('document.querySelector("#gallerySelectionButton").click();document.querySelector(".gallery-open").click()');const selecting=await list();
   check('selection preserves exact list layout '+key+'-'+position,selecting,before);
   check('four independent accessible icon targets '+key+'-'+position,await evaluate(`(()=>{const a=document.querySelector('#gallerySelectionActions'),r=a.getBoundingClientRect(),b=[...a.querySelectorAll('button')];return getComputedStyle(a).position==='absolute'&&r.bottom<=elements.galleryDialog.getBoundingClientRect().bottom&&b.length===4&&b.every(e=>{const t=e.getBoundingClientRect();return t.width>=43.9&&t.height>=43.9&&e.getAttribute('aria-label')&&e.querySelector('svg')})&&new Set(b.map(e=>e.getBoundingClientRect().x+':'+e.getBoundingClientRect().y)).size===4})()`),true);
   check('top select all text is visible beside done '+key+'-'+position,await evaluate(`(()=>{const a=elements.selectAllButton,b=document.querySelector('#gallerySelectionButton'),ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return a.closest('.gallery-header')&&a.textContent==='表示中を選択'&&getComputedStyle(a).visibility==='visible'&&ar.width>=44&&ar.height>=44&&Math.abs(ar.top-br.top)<1&&ar.right<=br.left&&ar.right<=innerWidth})()`),true);
   await evaluate('elements.selectAllButton.click()');check('all selection preserves exact list layout '+key+'-'+position,await list(),before);check('selected label stays explicit '+key+'-'+position,await evaluate('elements.selectAllButton.textContent'),'表示中を解除');check('select all remains same screen '+key+'-'+position,await evaluate('state.selectedGalleryIds.size===state.gallery.length&&!elements.reviewDialog.open'),true);
   await evaluate('elements.selectAllButton.click()');check('all deselection preserves exact list layout '+key+'-'+position,await list(),before);
   await evaluate('document.querySelector("#gallerySelectionButton").click()');check('top select all is hidden but still reserves its geometry '+key+'-'+position,await evaluate('getComputedStyle(elements.selectAllButton).visibility==="hidden"&&elements.selectAllButton.disabled&&elements.selectAllButton.getBoundingClientRect().height>=44'),true);check('exiting preserves exact list layout '+key+'-'+position,await list(),before);
  }
  await evaluate('document.querySelector("#gallerySelectionButton").click();document.querySelector(".gallery-card:last-child .gallery-open").focus()');await sleep(100);
  check('last metadata remains above fixed dock '+key,await evaluate(`(()=>{const e=document.activeElement.querySelector('.gallery-info').lastElementChild,b=e.getBoundingClientRect(),view=document.querySelector('#gallerySheetBody').getBoundingClientRect(),dock=document.querySelector('#gallerySelectionActions').getBoundingClientRect();return b.bottom<=dock.top+1&&b.top>=view.top-.5})()`),true);
  if(w===393||q===1&&font===32){await evaluate('document.querySelector(".gallery-card:last-child .gallery-open").click()');await shot('gallery-selection-'+key+'.png');}await closeSheet('gallery');
 }
 // Rapid close/reopen must cancel the old opening animation, retain locks and resources.
 await metrics(393,800);await evaluate('document.documentElement.style.fontSize="16px"');
 await openSheet('gallery');await evaluate('document.querySelector("#gallerySheetBody").scrollTop=0');await sleep(30);
 const beforeHold=await list(),p=await evaluate('(()=>{const r=document.querySelector(".gallery-open").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
 await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});await sleep(520);check('real touch long press does not shift list before release',await list(),beforeHold);await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(40);check('long press release keeps item selected and list stationary',await evaluate('state.selectedGalleryIds.size===1&&!elements.reviewDialog.open'),true);check('long press compatibility click preserves layout',await list(),beforeHold);await closeSheet('gallery');
 for(const kind of ['gallery','settings']){
  await evaluate(kind==='gallery'?'QuietCameraEnhancements.enhancedOpenGallery()':'elements.settingsButton.click()');
  await evaluate(`window.__opening=elements.${kind}Dialog.getAnimations()[0];__opening.pause();__opening.currentTime=90`);
  const hp=await evaluate(`(()=>{const r=document.querySelector('#${kind}ResizeHandle').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`),startBox=await bounds(kind);
  await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...hp,id:1}]});const held=await bounds(kind);check(kind+' touch interruption retains visible position',Math.abs(held.top-startBox.top)<1,true);
  for(let i=1;i<=5;i++){await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:hp.x,y:hp.y+10*i,id:1}]});await sleep(25)}
  check(kind+' interrupted opening follows finger',Math.abs((await bounds(kind)).top-startBox.top-50)<2,true);
  await cdp('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await settled(kind+'Dialog');check(kind+' touchcancel restores usable maximum',Math.abs((await bounds(kind)).height-(await bounds(kind)).max)<1&&(await bounds(kind)).state===null,true);await closeSheet(kind);
  await evaluate(kind==='gallery'?'QuietCameraEnhancements.enhancedOpenGallery()':'elements.settingsButton.click()');await keyboard('Escape');await until(`!elements.${kind}Dialog.open`);await sleep(220);check(kind+' Escape during entry leaves no motion',await evaluate(`!elements.${kind}Dialog.classList.contains('is-settling')&&elements.${kind}Dialog.getAnimations().length===0`),true);
  for(let i=0;i<3;i++){
   await evaluate(kind==='gallery'?'QuietCameraEnhancements.enhancedOpenGallery()':'elements.settingsButton.click()');
   await evaluate(`elements.${kind==='gallery'?'closeGalleryButton':'closeSettingsButton'}.click();elements.${kind}Dialog.${kind==='gallery'?'showModal':'show'}()`);await settled(kind+'Dialog');
   check(kind+' rapid reopen cleans prior motion '+i,(await bounds(kind)).state===null&&Math.abs((await bounds(kind)).height-(await bounds(kind)).max)<1,true);await closeSheet(kind);
  }
  await evaluate(kind==='gallery'?'QuietCameraEnhancements.enhancedOpenGallery()':'elements.settingsButton.click()');await cdp('Emulation.setDeviceMetricsOverride',{width:800,height:393,deviceScaleFactor:1,mobile:true,screenWidth:800,screenHeight:393,screenOrientation:{type:'landscapePrimary',angle:90}});await settled(kind+'Dialog');let b=await bounds(kind);check(kind+' rotation during entry ends max',Math.abs(b.height-b.max)<1&&b.bottom<=393.5,true);await closeSheet(kind);await metrics(393,800);
  await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await openSheet(kind);check(kind+' reduced motion skips movement',await evaluate(`elements.${kind}Dialog.getAnimations().length===0&&Math.abs(new DOMMatrixReadOnly(getComputedStyle(elements.${kind}Dialog).transform).m42)<.1`),true);await closeSheet(kind);await cdp('Emulation.setEmulatedMedia',{features:[]});
  await evaluate(kind==='gallery'?'QuietCameraEnhancements.enhancedOpenGallery()':'elements.settingsButton.click()');await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await settled(kind+'Dialog');check(kind+' live reduced motion settles cleanly',(await bounds(kind)).state===null,true);await closeSheet(kind);await cdp('Emulation.setEmulatedMedia',{features:[]});
 }
 await openSheet('gallery');await evaluate(`Object.defineProperty(visualViewport,'height',{configurable:true,value:300.45});Object.defineProperty(visualViewport,'offsetTop',{configurable:true,value:59.75});visualViewport.dispatchEvent(new Event('resize'))`);await sleep(80);check('keyboard viewport retains covered panel bottom',await evaluate(`(()=>{const d=elements.galleryDialog.getBoundingClientRect();return Math.abs(d.bottom-360.2)<.1&&d.top>=59.75})()`),true);await evaluate('delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event("resize"))');await closeSheet('gallery');
 await openSheet('gallery');const beforeLongTitle=await list();await evaluate('document.querySelector("#galleryTitle").textContent="撮影履歴（長い見出しを含む合成データの確認）"');check('long title cannot paint above header actions',await evaluate('(()=>{const t=document.querySelector("#galleryTitle"),a=elements.selectAllButton,b=t.getBoundingClientRect(),c=a.getBoundingClientRect();return getComputedStyle(t).overflow==="hidden"&&b.right<=c.left&&t.scrollWidth>t.clientWidth})()'),true);check('long title keeps fixed list geometry',await list(),beforeLongTitle);await closeSheet('gallery');
 check('PDF icon has visible text',await evaluate('document.querySelector("#exportPdfButton svg text").textContent'), 'PDF');
 check('all dismissal paths restore background',await evaluate('[document.body.style.position,document.documentElement.style.overflow]'),['','']);
 check('photo saved-range prose is not visible',await evaluate('state.mode="photo";QuietCameraOverlay.schedule();new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(document.querySelector("#previewFrameLabel").hidden))))'),true);
 await openSheet('settings');await shot('settings-full-entry-complete.png');await closeSheet('settings');
 audit=await evaluate('__audit');check('no camera or microphone request',audit.mediaCalls,0);check('no uncaught exception',exceptions.length,0);
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:true,checks:results,audit,version:await evaluate('elements.versionBadge.textContent'),limits:['Synthetic local Chrome only; no real S25 UI or native OS share sheet']},null,2));console.log(JSON.stringify({passed:true,checks:results.length,output}));
}catch(error){await shot('failure.png').catch(()=>{});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:error.stack,checks:results,exceptions},null,2));console.error(error);process.exitCode=1;}
} catch(error) {
 fs.writeFileSync(path.join(output,'harness-failure.json'),JSON.stringify({passed:false,error:error.stack},null,2));console.error(error);process.exitCode=1;
} finally {
 await cleanupBrowserTest({scratch,chrome,socket,command:cleanupCommand,server,output,pending});
}
