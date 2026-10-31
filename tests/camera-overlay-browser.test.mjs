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
const output=process.env.QUIET_CAMERA_OVERLAY_OUTPUT||path.resolve(root,'test-results/overlay');
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
const baseline=process.env.QUIET_CAMERA_OVERLAY_BASELINE==='1';let audit;
try{
 const version=await command('Browser.getVersion');const {browserContextId}=await command('Target.createBrowserContext');for(const name of ['camera','microphone'])await command('Browser.setPermission',{permission:{name},setting:'denied',browserContextId});const {targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});({sessionId}=await command('Target.attachToTarget',{targetId,flatten:true}));await cdp('Page.enable');await cdp('Runtime.enable');await metrics(393,800);
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`window.__audit={mediaCalls:0};Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{__audit.mediaCalls++;throw new Error('Device media forbidden')},enumerateDevices:async()=>[],getSupportedConstraints:()=>({}),addEventListener(){}}});Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});Object.defineProperty(document,'fullscreenEnabled',{value:false});const mode=new URL(location.href).searchParams.get('settingsCase');if(mode==='saved')localStorage.setItem('quiet-camera-settings-v3',JSON.stringify({ratio:'4:3',videoRatio:'1:1'}));else if(mode==='partial')localStorage.setItem('quiet-camera-settings-v3',JSON.stringify({ratio:'1:1'}));else if(mode==='invalid')localStorage.setItem('quiet-camera-settings-v3',JSON.stringify({ratio:'invalid',videoRatio:'invalid'}));else localStorage.removeItem('quiet-camera-settings-v3');`});
 const loaded=async(name='fresh')=>{await cdp('Page.navigate',{url:url+'?settingsCase='+name});await until('document.readyState==="complete" && !!window.QuietCameraEnhancements');if(!baseline)await until('!!window.QuietCameraOverlay');await sleep(100);};
 await loaded();
 const geometry=()=>evaluate(`(()=>{const box=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};return {stage:box(elements.cameraStage),selector:box(document.querySelector('.mode-switcher')),mic:box(elements.microphoneStatusButton),toolbar:box(document.querySelector('.camera-top-controls')),capture:box(document.querySelector('.bottom-controls')),surface:document.querySelector('#cameraSurface')?box(document.querySelector('#cameraSurface')):null,buttons:[...document.querySelectorAll('.camera-top-controls>button,.bottom-controls>button,.mode-switcher>button'),elements.microphoneStatusButton].filter(e=>!e.hidden&&getComputedStyle(e).display!=='none').map(e=>({id:e.id,...box(e),hit:e.contains(document.elementFromPoint(e.getBoundingClientRect().x+e.getBoundingClientRect().width/2,e.getBoundingClientRect().y+e.getBoundingClientRect().height/2))})),ratio:getVisiblePhotoRatio(),fit:getComputedStyle(elements.video).objectFit,pageY:scrollY,pageX:scrollX}})()`);
 const video=async file=>{await evaluate(`elements.permissionPanel.hidden=true;document.querySelector('.camera-top-controls').inert=false;elements.video.src='/__fixture/${file}';elements.video.loop=true;elements.video.muted=true;elements.video.play()`);await until('elements.video.currentTime>.65 && elements.video.readyState>=2');await evaluate('elements.video.pause()');await sleep(100);};
 const comparisons=[];
 for(const[w,h,file]of[[393,800,'portrait.mp4'],[800,393,'landscape.mp4']]){
  await metrics(w,h);await evaluate('state.mode="video";state.videoRatio="16:9";updateModeUi()');await video(file);const m=await geometry();comparisons.push({width:w,height:h,...m});await shot((baseline?'before':'after')+'-video-'+(w<h?'portrait':'landscape')+'.png');
 }
 if(baseline){fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({baseline:true,engine:version.product,comparisons,audit:await evaluate('__audit')},null,2));console.log(JSON.stringify({baseline:true,output}));}
 else{
 await metrics(393,800);await loaded();check('fresh photo and video defaults align',await evaluate('[state.ratio,state.videoRatio]'),['16:9','16:9']);
 await loaded('saved');check('existing explicit ratios are kept',await evaluate('[state.ratio,state.videoRatio]'),['4:3','1:1']);await loaded('partial');check('missing video ratio uses default without replacing photo choice',await evaluate('[state.ratio,state.videoRatio]'),['1:1','16:9']);await loaded('invalid');check('invalid ratios fall back to aligned defaults',await evaluate('[state.ratio,state.videoRatio]'),['16:9','16:9']);await loaded();
 check('toolbar remains inert before camera readiness',await evaluate('document.querySelector(".camera-top-controls").inert'),true);
 await metrics(320,600);await sleep(100);check('layout changes do not enable unready camera controls',await evaluate('document.querySelector(".camera-top-controls").inert'),true);
 const cases=[];
 for(const[w,h,font]of[[320,600,16],[393,800,16],[641,360,16],[800,393,16],[1280,800,16],[320,600,32],[641,360,32]]){
  await metrics(w,h,w<1000);await evaluate(`document.documentElement.style.fontSize='${font}px';elements.permissionPanel.hidden=true;document.querySelector('.camera-top-controls').inert=false;elements.torchButton.hidden=false`);
  for(const ratio of ['4:3','1:1','16:9']){
   await evaluate(`state.mode='photo';state.ratio='${ratio}';state.videoRatio='${ratio}';updateModeUi()`);await sleep(120);const p=await geometry();
   await evaluate('elements.videoModeButton.click()');await sleep(220);const m=await geometry();
   check('selector stays centered and stable '+w+' '+font+' '+ratio,[m.selector.x,m.selector.y,m.selector.width,m.selector.height],[p.selector.x,p.selector.y,p.selector.width,p.selector.height]);
   check('MIC stays at physical right of selector without collision '+w+' '+ratio,(w<h?m.mic.x>=m.selector.right+5:m.mic.bottom<=m.selector.y-5)&&m.mic.right<=w-7,true);
   check('MIC uses two visible lines '+w+' '+ratio,await evaluate('document.querySelector(".microphone-status-current").textContent==="現在"&&document.querySelector(".microphone-state-line").textContent.replace(/\\s/g,"")==="MICOFF"&&getComputedStyle(document.querySelector(".microphone-status-current")).display==="block"'),true);
   check('whole preview fits without page scroll '+w+' '+ratio,m.stage.x>=-.5&&m.stage.y>=-.5&&m.stage.right<=w+.5&&m.stage.bottom<=h+.5&&m.pageX===0&&m.pageY===0,true);
   const [a,b]=ratio.split(':').map(Number),expected=w<h?b/a:a/b;
   check('selected frame ratio is preserved '+w+' '+ratio,Math.abs(m.stage.width/m.stage.height-expected)<.002,true);
   check('controls have accessible targets '+w+' '+font+' '+ratio,m.buttons.every(b=>b.width>=43.9&&b.height>=43.9&&b.x>=-.5&&b.y>=-.5&&b.right<=w+.5&&b.bottom<=h+.5&&b.hit),true);
   check('entire control bands are transparent '+w,await evaluate('[document.querySelector(".camera-top-controls"),document.querySelector(".bottom-controls")].every(e=>getComputedStyle(e).backgroundColor==="rgba(0, 0, 0, 0)")'),true);
   await evaluate('elements.microphoneSelect.value="on";syncMicrophoneStatus()');await sleep(80);const on=await geometry();check('MIC ON does not move selector '+w,[on.selector.x,on.selector.y,on.selector.width,on.selector.height],[m.selector.x,m.selector.y,m.selector.width,m.selector.height]);await evaluate('elements.microphoneSelect.value="off";syncMicrophoneStatus()');
   cases.push({width:w,height:h,font,ratio,...m});
  }
 }
 await metrics(393,800);await evaluate('document.documentElement.style.fontSize="16px";state.mode="photo";state.ratio="16:9";updateModeUi()');await video('portrait.mp4');check('photo preview shows the announced saved crop',await evaluate('getComputedStyle(elements.video).objectFit'),'cover');
 const syntheticPhoto=await evaluate(`(async()=>{const ratio=getVisiblePhotoRatio(),source=document.createElement('canvas');source.width=480;source.height=640;const x=source.getContext('2d');x.fillStyle='#246';x.fillRect(0,0,480,640);const crop=calculateCrop(480,640,ratio),target=document.createElement('canvas');target.width=crop.sw;target.height=crop.sh;target.getContext('2d').drawImage(source,crop.sx,crop.sy,crop.sw,crop.sh,0,0,crop.sw,crop.sh);const blob=await canvasToBlob(target,'image/jpeg',.9),bitmap=await createImageBitmap(blob);const result={ratio,crop,width:bitmap.width,height:bitmap.height};bitmap.close();return result})()`);
 check('synthetic still export has selected portrait 16:9 geometry',[syntheticPhoto.width,syntheticPhoto.height],[360,640]);
 await video('landscape.mp4');check('photo crop stays accessible without visible notice',await evaluate('document.querySelector("#photoFrameGuide").hidden&&document.querySelector("#previewFrameLabel").hidden&&elements.cameraStage.getAttribute("aria-label").includes("写真の保存範囲")'),true);await shot('photo-announced-saved-frame.png');
 await evaluate('state.mode="video";updateModeUi()');await sleep(80);check('video keeps full stream and has no photo crop guide',await evaluate('[document.querySelector("#photoFrameGuide").hidden,typeof getVideoTrackTargetAspectRatio==="function"?getVideoTrackTargetAspectRatio():null]'),[true,16/9]);
 await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{top:36,bottom:20,left:12,right:18}});await sleep(100);let safe=await geometry();check('safe viewport contains complete frame',safe.stage.x>=12&&safe.stage.right<=393-18+.5&&safe.stage.y>=36&&safe.stage.bottom<=800-20+.5,true);await evaluate('document.querySelector("#fullscreenButton").click()');await sleep(100);safe=await geometry();check('immersive center controls avoid upper cutout',safe.selector.y>=36+56&&safe.mic.y>=36+56,true);await shot('immersive-cutout-safe.png');await evaluate('document.querySelector("#fullscreenButton").click()');
 await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,bottom:0,left:0,right:0}});await evaluate('elements.settingsButton.click()');await sleep(100);check('settings remain non-modal and available',await evaluate('elements.settingsDialog.open&&!elements.settingsDialog.matches(":modal")'),true);await evaluate('elements.closeSettingsButton.click()');await sleep(80);check('camera document does not need scrolling',await evaluate('document.scrollingElement.scrollHeight<=document.documentElement.clientHeight+1'),true);check('close restores settings trigger focus',await evaluate('document.activeElement===elements.settingsButton'),true);
 await evaluate('elements.settingsButton.click()');await sleep(80);await evaluate('elements.privacyButton.click()');await sleep(80);check('relocated application information remains reachable',await evaluate('elements.privacyDialog.open&&!elements.settingsDialog.open&&elements.privacyDialog.querySelector("h1").getBoundingClientRect().height>0&&getComputedStyle(elements.privacyDialog.querySelector(".about-app")).display!=="none"'),true);await evaluate('elements.closePrivacyButton.click()');await sleep(80);check('information close does not trap focus in a closed sheet',await evaluate('!elements.privacyDialog.open&&!elements.settingsDialog.contains(document.activeElement)'),true);
 await metrics(800,393);await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{top:28,bottom:20,left:0,right:64}});await evaluate('elements.zoomControl.hidden=false;elements.recordingBadge.hidden=false');await sleep(120);check('zoom and recording badge respect asymmetric safe areas',await evaluate('(()=>{const rect=e=>e.getBoundingClientRect();return [elements.zoomControl,elements.recordingBadge].every(e=>{const r=rect(e);return r.x>=8&&r.right<=800-64+.5&&r.y>=28&&r.bottom<=393-20+.5})})()'),true);await shot('landscape-asymmetric-safe-area.png');await evaluate('elements.zoomControl.hidden=true;elements.recordingBadge.hidden=true');await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,bottom:0,left:0,right:0}});
 await metrics(393,800);await evaluate('Object.defineProperty(visualViewport,"height",{configurable:true,value:340});Object.defineProperty(visualViewport,"offsetTop",{configurable:true,value:28});visualViewport.dispatchEvent(new Event("resize"))');await sleep(120);const keyboard=await geometry();check('reduced visual viewport fits full preview and controls',keyboard.surface.y===28&&keyboard.surface.height===340&&keyboard.stage.y>=28&&keyboard.stage.bottom<=368.5&&keyboard.buttons.every(b=>b.y>=28&&b.bottom<=368.5),true);await evaluate('delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event("resize"))');await sleep(100);check('visual viewport restoration retains no-scroll camera layout',await evaluate('document.querySelector("#cameraSurface").getBoundingClientRect().height===800&&scrollY===0'),true);
 audit=await evaluate('__audit');check('no camera or microphone requests',audit.mediaCalls,0);check('no uncaught exceptions',exceptions.length,0);
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:true,engine:version.product,version:await evaluate('elements.versionBadge.textContent'),comparisons,cases,checks:results,syntheticPhotoOutput:syntheticPhoto,audit,exceptions,actualRecordingVerified:false,privateMediaUsed:false,limits:['Synthetic MP4/canvas only; no camera, microphone, capture or real recording','Photo crop geometry verified from synthetic JPEG; actual video ratio remains hardware/constraint dependent','No physical S25/browser or cutout check']},null,2));console.log(JSON.stringify({passed:true,checks:results.length,cases:cases.length,output}));
 }
}catch(error){await shot('failure.png').catch(()=>{});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:error.stack,checks:results,exceptions},null,2));console.error(error);process.exitCode=1;}
} catch(error) {
 fs.writeFileSync(path.join(output,'harness-failure.json'),JSON.stringify({passed:false,error:error.stack},null,2));console.error(error);process.exitCode=1;
} finally {
 await cleanupBrowserTest({scratch,chrome,socket,command:cleanupCommand,server,output,pending});
}
