// Synthetic media only, with a fresh browser profile and isolated storage.
// No real camera, microphone, phone, or user gallery is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const root=path.resolve(import.meta.dirname,'..');
const output=process.env.QUIET_CAMERA_MODE_TEST_OUTPUT||path.resolve(root,'test-results/mode');
const fixtures=process.env.QUIET_CAMERA_REVIEW_FIXTURES||path.resolve(root,'tests/fixtures');
fs.mkdirSync(output,{recursive:true});
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'quiet-camera-media-review-'));
const server=http.createServer((req,res)=>{
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
const metrics=async(w,h,touch=true)=>{await cdp('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:touch,screenWidth:w,screenHeight:h,screenOrientation:{type:w>h?'landscapePrimary':'portraitPrimary',angle:w>h?90:0}});await cdp('Emulation.setTouchEmulationEnabled',{enabled:touch});await sleep(40);if(await evaluate('!!window.QuietCameraOverlay'))await until(`Math.abs(visualViewport.width-${w})<1 && Math.abs(document.querySelector('#cameraSurface').getBoundingClientRect().width-${w})<1`);};
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
 const version=await command('Browser.getVersion');
 const {browserContextId}=await command('Target.createBrowserContext');for(const name of ['camera','microphone'])await command('Browser.setPermission',{permission:{name},setting:'denied',browserContextId});
 const {targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});({sessionId}=await command('Target.attachToTarget',{targetId,flatten:true}));await cdp('Page.enable');await cdp('Runtime.enable');await metrics(393,800);
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
 window.__audit={mediaCalls:0,settingsWrites:0};
 Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{__audit.mediaCalls++;throw new Error('Media forbidden');},enumerateDevices:async()=>[],getSupportedConstraints:()=>({}),addEventListener(){}}});
 Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});
 Object.defineProperty(document,'fullscreenEnabled',{value:false});
 `});await cdp('Page.navigate',{url});await until('document.readyState==="complete" && !!window.QuietCameraEnhancements');await evaluate('saveSettings=()=>__audit.settingsWrites++');
 const geometry=()=>evaluate(`(()=>{const n=document.querySelector('.mode-switcher'),r=e=>{const b=e.getBoundingClientRect();return [b.x,b.y,b.width,b.height].map(x=>Math.round(x*100)/100)};return {nav:r(n),labels:[r(elements.photoModeButton),r(elements.videoModeButton)],row:r(document.querySelector('.mode-control-row'))}})()`);
 for(const[w,h]of[[320,600],[393,800],[641,360],[1280,800]]){
  await metrics(w,h,w<1000);await evaluate('state.mode="photo";elements.microphoneSelect.value="off";updateModeUi()');await sleep(100);const photo=await geometry();
  await evaluate('elements.videoModeButton.click()');await sleep(250);check('video selector geometry unchanged '+w,await geometry(),photo);
  check('explicit MIC OFF visible '+w,await evaluate('!elements.microphoneStatusButton.hidden&&elements.microphoneStatusButton.textContent.replace(/\\s/g,"")==="現在MICOFF"'),true);
  check('MIC and selector do not overlap '+w,await evaluate('(()=>{const a=document.querySelector(".mode-switcher").getBoundingClientRect(),b=elements.microphoneStatusButton.getBoundingClientRect();return !(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)})()'),true);
  await evaluate('elements.microphoneSelect.value="on";syncMicrophoneStatus()');check('MIC ON does not move selector '+w,await geometry(),photo);check('ON state is visible and accessible '+w,await evaluate('elements.microphoneStatusText.textContent==="ON"&&elements.microphoneStatusButton.getAttribute("aria-label").includes("ON")'),true);
  await evaluate('elements.photoModeButton.click()');await sleep(220);check('photo hides MIC without shifting selector '+w,[await geometry(),await evaluate('elements.microphoneStatusButton.hidden')],[photo,true]);
 }
 await metrics(393,800);await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await evaluate('state.mode="photo";updateModeUi()');await sleep(250);
 const endpoint=await evaluate('parseFloat(getComputedStyle(document.querySelector(".mode-switcher"),"::before").width)');
 await evaluate('elements.videoModeButton.click()');await sleep(55);const mid=await evaluate('new DOMMatrix(getComputedStyle(document.querySelector(".mode-switcher"),"::before").transform).m41');check('single white pill interpolates smoothly',mid>0&&mid<endpoint,true);await sleep(210);
 check('white pill aligns with measured equal segment',await evaluate('Math.abs(new DOMMatrix(getComputedStyle(document.querySelector(".mode-switcher"),"::before").transform).m41-parseFloat(getComputedStyle(document.querySelector(".mode-switcher"),"::before").width))<0.6'),true);
 check('button backgrounds stay transparent',await evaluate('[elements.photoModeButton,elements.videoModeButton].every(x=>getComputedStyle(x).backgroundColor==="rgba(0, 0, 0, 0)")'),true);await shot('01-video-white-pill-mic-text.png');
 await evaluate('for(let i=0;i<25;i++)(i%2?elements.photoModeButton:elements.videoModeButton).click();elements.photoModeButton.click()');await sleep(250);check('rapid switching ends with consistent photo state',await evaluate('[state.mode,elements.photoModeButton.getAttribute("aria-pressed"),elements.videoModeButton.getAttribute("aria-pressed"),document.querySelector(".mode-switcher").dataset.mode]'),['photo','true','false','photo']);
 await evaluate('state.ratio="1:1";state.videoRatio="16:9";elements.photoQualitySelect.value="0.95";window.__modeSettings=[state.ratio,state.videoRatio,elements.photoQualitySelect.value,elements.videoResolutionSelect.value];elements.videoModeButton.click();elements.photoModeButton.click()');check('mode-specific ratios and quality stay intact',await evaluate('[state.ratio,state.videoRatio,elements.photoQualitySelect.value,elements.videoResolutionSelect.value]'),await evaluate('__modeSettings'));
 await evaluate('state.mode="video";updateModeUi();state.recorder={state:"recording"};setControlsDisabled(true);elements.photoModeButton.click()');await evaluate('setMode("photo")');check('recording disables and guards switching',await evaluate('[state.mode,elements.photoModeButton.disabled,elements.videoModeButton.disabled]'),['video',true,true]);
 await evaluate('state.recorder=null;state.recordingFinalizing=true;setMode("photo")');check('finalizing guards switching',await evaluate('state.mode'),'video');await evaluate('state.recordingFinalizing=false;state.busy=true;setMode("photo")');check('busy guards switching',await evaluate('state.mode'),'video');await evaluate('state.busy=false;setControlsDisabled(false);elements.photoModeButton.click()');check('switching resumes after restrictions',await evaluate('state.mode'),'photo');
 await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await evaluate('elements.videoModeButton.click()');await sleep(40);check('reduced motion removes pill transition',await evaluate('getComputedStyle(document.querySelector(".mode-switcher"),"::before").transitionDuration'),'0s');
 await evaluate('elements.photoModeButton.textContent="Photographie";elements.videoModeButton.textContent="Videoaufnahme";document.documentElement.style.fontSize="32px";state.mode="photo";updateModeUi()');await sleep(80);const localized=await geometry();await evaluate('elements.videoModeButton.click()');await sleep(60);check('long localized labels and larger text keep geometry',await geometry(),localized);check('localized labels do not overflow capsule',await evaluate('document.querySelector(".mode-switcher").scrollWidth<=document.querySelector(".mode-switcher").clientWidth'),true);await shot('02-long-labels-200-percent.png');
 await evaluate('document.documentElement.style.fontSize="16px";elements.photoModeButton.textContent="写真";elements.videoModeButton.textContent="動画";elements.microphoneSelect.value="off";syncMicrophoneStatus()');
 for(const[w,h]of[[393,800],[800,393]]){await metrics(w,h);await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{top:36,bottom:18,left:12,right:12}});await evaluate('document.querySelector("#fullscreenButton").click()');await sleep(100);check('fullscreen MIC text avoids top cutout '+w,await evaluate('(()=>{const r=elements.microphoneStatusButton.getBoundingClientRect();return r.top>=36&&r.left>=12&&r.right<=innerWidth-12&&r.bottom<=innerHeight-18&&!elements.microphoneStatusButton.hidden&&elements.microphoneStatusText.textContent==="OFF"})()'),true);await shot('03-fullscreen-mic-'+w+'.png');await evaluate('document.querySelector("#fullscreenButton").click()');}
 audit=await evaluate('__audit');check('no camera or microphone requests',audit.mediaCalls,0);check('no uncaught browser exceptions',exceptions.length,0);
 const record={passed:true,engine:version.product,version:await evaluate('elements.versionBadge.textContent'),fixtureOnly:true,phoneBrowserOperated:false,checks:results,audit,exceptions,animation:{midpoint:mid,endpoint},limits:['PC Chromium only','No swipe-to-switch feature; no camera/audio semantics changed']};
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(record,null,2));console.log(JSON.stringify({passed:true,checks:results.length,engine:version.product,audit,output}));
}catch(error){await shot('failure.png').catch(()=>{});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:error.stack,checks:results,exceptions},null,2));console.error(error);process.exitCode=1;}
finally{await command('Browser.close').catch(()=>chrome.kill());socket.close();server.close();}
