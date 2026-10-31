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
const root=process.env.QUIET_CAMERA_OVERLAY_ROOT||path.resolve(import.meta.dirname,'..');
const output=process.env.QUIET_CAMERA_DEVICE_TEST_OUTPUT||path.resolve(root,'test-results/device');
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
try{
 const version=await command('Browser.getVersion');const {browserContextId}=await command('Target.createBrowserContext');for(const name of ['camera','microphone'])await command('Browser.setPermission',{permission:{name},setting:'denied',browserContextId});const {targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});({sessionId}=await command('Target.attachToTarget',{targetId,flatten:true}));await cdp('Page.enable');await cdp('Runtime.enable');
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`window.__audit={mediaCalls:0};Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{__audit.mediaCalls++;throw new Error('Device media forbidden')},enumerateDevices:async()=>[],getSupportedConstraints:()=>({}),addEventListener(){}}});Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});Object.defineProperty(document,'fullscreenEnabled',{value:false});`});
 const orientation=async(w,h,q=0)=>{await cdp('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:true,screenWidth:w,screenHeight:h,screenOrientation:{type:['portraitPrimary','landscapePrimary','portraitSecondary','landscapeSecondary'][q],angle:q*90}});await cdp('Emulation.setTouchEmulationEnabled',{enabled:true});await sleep(50);if(await evaluate('!!window.QuietCameraOverlay'))await until(`document.querySelector('#cameraSurface').dataset.deviceRotation==='${q*90}'&&Math.abs(visualViewport.width-${w})<1&&Math.abs(document.querySelector('#cameraSurface').getBoundingClientRect().width-${w})<1`);await sleep(70);};
 await orientation(393,800);await cdp('Page.navigate',{url});await until('document.readyState==="complete"&&!!window.QuietCameraOverlay');await sleep(100);
 check('camera controls stay inert before camera readiness',await evaluate('document.querySelector(".camera-top-controls").inert'),true);
 await evaluate('elements.permissionPanel.hidden=true;document.querySelector(".camera-top-controls").inert=false;elements.shutterButton.disabled=false;state.mode="video";updateModeUi()');
 const fixture=async(name)=>{await evaluate(`elements.video.src='/__fixture/${name}.mp4';elements.video.muted=true;elements.video.play()`);await until('elements.video.currentTime>.65&&elements.video.readyState>=2');await evaluate('elements.video.pause()');await sleep(80);};
 const geometry=()=>evaluate(`(()=>{const r=e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom,cx:b.x+b.width/2,cy:b.y+b.height/2}};return{stage:r(elements.cameraStage),selector:r(document.querySelector('.mode-switcher')),mic:r(elements.microphoneStatusButton),quarter:Number(document.querySelector('#cameraSurface').dataset.deviceRotation)/90,buttons:Object.fromEntries([...document.querySelectorAll('.mode-switcher>button,.camera-top-controls>button,.bottom-controls>button'),elements.microphoneStatusButton].filter(e=>!e.hidden&&getComputedStyle(e).display!=='none').map(e=>[e.id,{...r(e),hit:e.contains(document.elementFromPoint(r(e).cx,r(e).cy))}])),pageY:scrollY,pageX:scrollX,source:[elements.video.videoWidth,elements.video.videoHeight],fit:getComputedStyle(elements.video).objectFit}})()`);
 const cases=[],base={};
 for(const ratio of ['16:9','4:3','1:1']){
  await orientation(393,800);await evaluate(`state.ratio='${ratio}';state.videoRatio='${ratio}';state.mode='video';updateModeUi();elements.torchButton.hidden=false`);await fixture('portrait');base[ratio]=await geometry();
  for(const q of [0,1,3,2,0,3,1,0]){
   const w=q%2?800:393,h=q%2?393:800;await orientation(w,h,q);await fixture(q%2?'landscape':'portrait');const g=await geometry(),b=base[ratio];
   const map=(x,y)=>q===1?[y,393-x]:q===3?[800-y,x]:q===2?[393-x,800-y]:[x,y];
   for(const id of Object.keys(g.buttons)){const old=b.buttons[id],p=map(old.cx,old.cy),now=g.buttons[id];check('physical anchor '+ratio+' '+q+' '+id,Math.abs(now.cx-p[0])<1&&Math.abs(now.cy-p[1])<1,true);}
   check('preview is complete and fits viewport '+ratio+' '+q,g.stage.x>=-.5&&g.stage.y>=-.5&&g.stage.right<=w+.5&&g.stage.bottom<=h+.5&&g.fit==='contain',true);
   const[a,bv]=ratio.split(':').map(Number);check('preview aspect preserved '+ratio+' '+q,Math.abs(g.stage.width/g.stage.height-(q%2?g.source[0]/g.source[1]:bv/a))<.003,true);
   check('preview avoids fixed button hit areas '+ratio+' '+q,q%2?Object.values(g.buttons).every(b=>Math.min(b.right,g.stage.right)-Math.max(b.x,g.stage.x)<=.5||Math.min(b.bottom,g.stage.bottom)-Math.max(b.y,g.stage.y)<=.5):q===2?Math.abs(g.stage.bottom-h)<1:Math.abs(g.stage.y)<1,true);
   check('controls remain tappable and in viewport '+ratio+' '+q,Object.values(g.buttons).every(b=>b.width>=43.9&&b.height>=43.9&&b.x>=-.5&&b.y>=-.5&&b.right<=w+.5&&b.bottom<=h+.5&&b.hit),true);
   check('no shared shutter-history-settings enclosure '+q,await evaluate('(()=>{const e=document.querySelector(".bottom-controls"),s=getComputedStyle(e);return s.backgroundColor==="rgba(0, 0, 0, 0)"&&s.boxShadow==="none"&&s.borderTopWidth==="0px"&&["::before","::after"].every(p=>getComputedStyle(e,p).content==="none")})()'),true);
   check('MIC OFF uses exact visible two lines '+ratio+' '+q,await evaluate('(()=>{const a=document.querySelector(".microphone-status-current"),b=document.querySelector(".microphone-state-line"),ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return !elements.microphoneStatusButton.hidden&&a.textContent==="現在"&&b.textContent.replace(/\\s/g,"")==="MICOFF"&&ar.bottom<=br.y+1&&ar.width>0&&br.width>0})()'),true);
   const saved=[g.selector.x,g.selector.y,g.selector.width,g.selector.height];await evaluate('elements.microphoneSelect.value="on";syncMicrophoneStatus()');await sleep(80);let changed=await geometry();check('MIC ON keeps selector fixed '+q,[changed.selector.x,changed.selector.y,changed.selector.width,changed.selector.height],saved);check('MIC ON exact visible text '+q,await evaluate('document.querySelector(".microphone-state-line").textContent.replace(/\\s/g,"")'), 'MICON');
   await evaluate('elements.photoModeButton.click()');await sleep(100);changed=await geometry();check('photo mode hides MIC without moving selector '+q,[changed.selector.x,changed.selector.y,changed.selector.width,changed.selector.height,await evaluate('elements.microphoneStatusButton.hidden')],[...saved,true]);await evaluate('elements.microphoneSelect.value="off";elements.videoModeButton.click();syncMicrophoneStatus()');await sleep(100);
   check('camera page never scrolls '+q,await evaluate('scrollTo(0,400);scrollY===0&&scrollX===0&&document.scrollingElement.scrollHeight<=document.documentElement.clientHeight+1'),true);
   if(ratio==='16:9'&&[0,1,3].includes(q)){await shot('video-'+q*90+'-degrees.png');}
   cases.push({ratio,q,width:w,height:h,...g});
  }
 }
 // Narrow display, larger text, and both sides' safe insets.
 for(const[w,h,q,font]of[[320,600,0,16],[600,320,1,16],[600,320,3,16],[320,600,0,32],[600,320,1,32],[600,320,3,32]]){
  await orientation(w,h,q);await evaluate(`document.documentElement.style.fontSize='${font}px';state.videoRatio='16:9';updateModeUi()`);await sleep(120);const g=await geometry();check('narrow and large-text targets '+q+' '+font,Object.values(g.buttons).every(b=>b.width>=43.9&&b.height>=43.9&&b.x>=-.5&&b.y>=-.5&&b.right<=w+.5&&b.bottom<=h+.5&&b.hit),true);check('narrow MIC exact two lines '+q+' '+font,await evaluate('(()=>{const a=document.querySelector(".microphone-status-current").getBoundingClientRect(),b=document.querySelector(".microphone-state-line").getBoundingClientRect();return a.bottom<=b.top+1&&a.x>=0&&b.x>=0&&a.right<=innerWidth&&b.right<=innerWidth})()'),true);
 }
 await evaluate('document.documentElement.style.fontSize="16px"');
 for(const q of [0,1,3]){
  const w=q?800:393,h=q?393:800;await orientation(w,h,q);await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{top:28,right:24,bottom:20,left:12}});await evaluate('document.querySelector("#fullscreenButton").click()');await sleep(120);const g=await geometry();check('fullscreen MIC safe and explicit '+q,await evaluate('(()=>{const a=document.querySelector(".microphone-status-current"),b=document.querySelector(".microphone-state-line"),r=elements.microphoneStatusButton.getBoundingClientRect();return !elements.microphoneStatusButton.hidden&&a.textContent==="現在"&&b.textContent.replace(/\\s/g,"")==="MICOFF"&&a.getBoundingClientRect().bottom<=b.getBoundingClientRect().top+1&&r.x>=12&&r.y>=28&&r.right<=innerWidth-24+.5&&r.bottom<=innerHeight-20+.5})()'),true);await shot('fullscreen-mic-'+q*90+'.png');await evaluate('elements.microphoneSelect.value="on";syncMicrophoneStatus()');await sleep(70);check('fullscreen MIC ON is also two lines '+q,await evaluate('(()=>{const a=document.querySelector(".microphone-status-current"),b=document.querySelector(".microphone-state-line");return a.textContent==="現在"&&b.textContent.replace(/\\s/g,"")==="MICON"&&a.getBoundingClientRect().bottom<=b.getBoundingClientRect().top+1})()'),true);const on=await geometry();check('fullscreen ON does not move selector '+q,[on.selector.x,on.selector.y,on.selector.width,on.selector.height],[g.selector.x,g.selector.y,g.selector.width,g.selector.height]);if(q===1)await shot('fullscreen-mic-on-90.png');await evaluate('elements.microphoneSelect.value="off";syncMicrophoneStatus()');await evaluate('document.querySelector("#fullscreenButton").click()');await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,right:0,bottom:0,left:0}});
 }
 await orientation(393,800);await evaluate('Object.defineProperty(visualViewport,"height",{configurable:true,value:300});Object.defineProperty(visualViewport,"offsetTop",{configurable:true,value:32});visualViewport.dispatchEvent(new Event("resize"))');await sleep(140);let g=await geometry();check('browser-height reduction does not fake a phone rotation',g.quarter,0);check('reduced viewport fits entire preview',g.stage.y>=32&&g.stage.bottom<=332.5,true);check('all controls remain in reduced visible viewport',Object.values(g.buttons).every(b=>b.y>=32&&b.bottom<=332.5),true);await shot('reduced-visual-viewport.png');await evaluate('delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event("resize"))');await sleep(100);
 for(const q of [0,1,3,0]){await orientation(q%2?800:393,q%2?393:800,q);await evaluate('elements.settingsButton.click()');await sleep(100);check('settings sheet still opens '+q,await evaluate('elements.settingsDialog.open&&!elements.settingsDialog.matches(":modal")'),true);await evaluate('elements.closeSettingsButton.click()');await sleep(80);check('settings close restores focus without body lock '+q,await evaluate('document.activeElement===elements.settingsButton&&document.body.style.position!=="fixed"'),true);await evaluate('elements.galleryButton.click()');await until('elements.galleryDialog.open');check('empty test history locks background '+q,await evaluate('document.body.style.position'), 'fixed');await evaluate('elements.closeGalleryButton.click()');await sleep(100);check('history close restores background '+q,await evaluate('!elements.galleryDialog.open&&document.body.style.position!=="fixed"&&scrollY===0'),true);}
 await evaluate('state.recorder={state:"recording"};setControlsDisabled(true);setMode("photo")');check('recording continues guarding mode changes',await evaluate('state.mode'),'video');await evaluate('state.recorder=null;setControlsDisabled(false)');
 check('about content remains intact and reachable',await evaluate('!!document.querySelector("#privacyDialog .about-app")&&!!document.querySelector("#privacyDialog h1")'),true);
 audit=await evaluate('__audit');check('no device media requested',audit.mediaCalls,0);check('no uncaught exceptions',exceptions.length,0);
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:true,version:await evaluate('elements.versionBadge.textContent'),engine:version.product,checks:results,cases,audit,exceptions,physicalReference:'Portrait top -> left and portrait bottom -> right on counterclockwise90; opposite on clockwise270',limits:['Synthetic PC Chromium only; no physical S25, camera, microphone, capture or private gallery','Visual viewport reduction simulated; no real browser chrome or IME operation']},null,2));console.log(JSON.stringify({passed:true,checks:results.length,cases:cases.length,output}));
}catch(error){await shot('failure.png').catch(()=>{});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:error.stack,checks:results,exceptions},null,2));console.error(error);process.exitCode=1;}
} catch(error) {
 fs.writeFileSync(path.join(output,'harness-failure.json'),JSON.stringify({passed:false,error:error.stack},null,2));console.error(error);process.exitCode=1;
} finally {
 await cleanupBrowserTest({scratch,chrome,socket,command:cleanupCommand,server,output,pending});
}
