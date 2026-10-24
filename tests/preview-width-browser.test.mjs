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
const output=process.env.QUIET_CAMERA_PREVIEW_TEST_OUTPUT||path.resolve(root,'test-results/preview');
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
 const version=await command('Browser.getVersion');const {browserContextId}=await command('Target.createBrowserContext');for(const name of ['camera','microphone'])await command('Browser.setPermission',{permission:{name},setting:'denied',browserContextId});const {targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});({sessionId}=await command('Target.attachToTarget',{targetId,flatten:true}));await cdp('Page.enable');await cdp('Runtime.enable');await metrics(393,800);
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`window.__audit={mediaCalls:0};Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{__audit.mediaCalls++;throw new Error('Media forbidden')},enumerateDevices:async()=>[],getSupportedConstraints:()=>({}),addEventListener(){}}});Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});Object.defineProperty(document,'fullscreenEnabled',{value:false});`});await cdp('Page.navigate',{url});await until('document.readyState==="complete" && !!window.QuietCameraEnhancements');
 await evaluate('saveSettings=()=>{};elements.permissionPanel.hidden=true;document.querySelector(".camera-top-controls").inert=false;state.ratio="4:3";state.videoRatio="16:9";window.__sourceSettings=JSON.stringify(collectSettings())');
 const measure=()=>evaluate(`(()=>{const r=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom,right:b.right}},v=elements.video,s=elements.cameraStage,sh=elements.shutterButton;return {stage:r(s),video:r(v),source:[v.videoWidth,v.videoHeight],fit:getComputedStyle(v).objectFit,shutter:{...r(sh),hit:document.elementFromPoint(sh.getBoundingClientRect().x+sh.getBoundingClientRect().width/2,sh.getBoundingClientRect().y+sh.getBoundingClientRect().height/2)?.closest('#shutterButton')===sh},bar:r(document.querySelector('.bottom-controls'))}})()`);
 // The real HTMLVideoElement decodes synthetic MP4 frames; no camera track or
 // MediaRecorder is created and no permission placeholder is used as evidence.
 await evaluate('elements.video.src="/__fixture/portrait.mp4";elements.video.loop=true;elements.video.muted=true;elements.video.play()');await until('elements.video.videoWidth===180 && elements.video.currentTime>0.1');
 for(const[w,h]of[[320,600],[360,641],[393,800]]){
  await metrics(w,h);await evaluate('scrollTo(0,0);state.mode="photo";updateModeUi()');await sleep(120);const photo=await measure();
  await evaluate('state.mode="video";updateModeUi()');await sleep(140);const video=await measure();
  check('photo/video common available width '+w,Math.abs(photo.stage.width-video.stage.width)<1,true);check('video stays centered '+w,Math.abs(video.stage.x+video.stage.width/2-w/2)<1,true);check('portrait video preserves 9:16 stage '+w,Math.abs(video.stage.width/video.stage.height-9/16)<.005,true);
  check('video uses available height within viewport '+w,video.stage.height>photo.stage.height+50&&video.stage.y>=-.5&&video.stage.bottom<=h+.5,true);check('synthetic video uses natural containment '+w,[video.fit,video.source],['contain',[180,320]]);
  check('shutter remains visible and tappable '+w,video.shutter.y>=0&&video.shutter.bottom<=h+.5&&video.shutter.hit,true);
  await shot('01-portrait-video-wide-'+w+'.png');
  await evaluate('window.scrollTo(0,Math.max(0,elements.cameraStage.getBoundingClientRect().bottom+scrollY-innerHeight+120))');await sleep(80);const scrolled=await measure();check('controls remain reachable after scrolling '+w,scrolled.shutter.y>=0&&scrolled.shutter.bottom<=h+.5&&scrolled.shutter.hit,true);
 }
 await metrics(393,800);await evaluate('scrollTo(0,0);elements.video.src="/__fixture/landscape.mp4";elements.video.play()');await until('elements.video.videoWidth===320 && elements.video.currentTime>0.6');check('synthetic source has a decoded visible frame',await evaluate('(()=>{const c=document.createElement("canvas");c.width=64;c.height=36;const x=c.getContext("2d");x.drawImage(elements.video,0,0,64,36);const d=x.getImageData(0,0,64,36).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i]+d[i+1]+d[i+2]>150)n++;return n/(64*36)>.3})()'),true);check('mismatched source remains contained without crop',await evaluate('getComputedStyle(elements.video).objectFit'), 'contain');await shot('02-landscape-source-in-portrait.png');
 await metrics(800,393);await evaluate('scrollTo(0,0)');await sleep(100);const landscape=await measure();check('landscape source dimensions unchanged',landscape.source,[320,180]);check('landscape shutter remains visible',landscape.shutter.y>=0&&landscape.shutter.bottom<=393.5&&landscape.shutter.hit,true);await shot('03-landscape-video.png');
 await metrics(393,800);await evaluate('elements.video.src="/__fixture/portrait.mp4";elements.video.play()');await until('elements.video.videoWidth===180');await evaluate('document.querySelector("#fullscreenButton").click()');await sleep(120);check('fullscreen keeps the entire natural frame visible',await evaluate('(()=>{const r=elements.cameraStage.getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth+.5&&r.bottom<=innerHeight+.5&&Math.abs(r.width/r.height-9/16)<.002})()'),true);await evaluate('document.querySelector("#fullscreenButton").click();elements.video.pause();state.mode="photo";updateModeUi()');
 check('recording ratio and all settings remain unchanged',await evaluate('JSON.stringify(collectSettings())===__sourceSettings'),true);audit=await evaluate('__audit');check('no camera or microphone requests',audit.mediaCalls,0);check('no uncaught exceptions',exceptions.length,0);
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:true,engine:version.product,version:await evaluate('elements.versionBadge.textContent'),checks:results,audit,exceptions,source:'Existing synthetic portrait180x320 and landscape320x180 MP4; decoded and played by camera preview video element',recordingUsed:false,tradeoff:'Selected frame is contained within the safe visual viewport; width is limited by height when necessary. Transparent controls overlay the full source, without page scrolling, stretching or live-source cropping.'},null,2));console.log(JSON.stringify({passed:true,checks:results.length,engine:version.product,audit,output}));
}catch(error){await shot('failure.png').catch(()=>{});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:error.stack,checks:results,exceptions},null,2));console.error(error);process.exitCode=1;}
finally{await command('Browser.close').catch(()=>chrome.kill());socket.close();server.close();}
