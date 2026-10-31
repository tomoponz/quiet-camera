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
const root=process.env.QUIET_CAMERA_ZOOM_ROOT||path.resolve(import.meta.dirname,'..');
const output=process.env.QUIET_CAMERA_ZOOM_TEST_OUTPUT||path.resolve(root,'test-results/zoom-status');
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
const assertions=[];const verify=(name,passed,detail)=>assertions.push({name,passed:!!passed,detail});let audit;
try{
 const {browserContextId}=await command('Target.createBrowserContext');for(const name of ['camera','microphone'])await command('Browser.setPermission',{permission:{name},setting:'denied',browserContextId});const{targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});({sessionId}=await command('Target.attachToTarget',{targetId,flatten:true}));await cdp('Page.enable');await cdp('Runtime.enable');
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`window.__audit={mediaCalls:0};Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{__audit.mediaCalls++;throw new Error('Device media forbidden')},getSupportedConstraints:()=>({zoom:true}),enumerateDevices:async()=>[],addEventListener(){}}});Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});Object.defineProperty(document,'fullscreenEnabled',{value:false});`});
 const orientation=async(w,h,q)=>{await cdp('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:true,screenWidth:w,screenHeight:h,screenOrientation:{type:q===1?'landscapePrimary':q===3?'landscapeSecondary':'portraitPrimary',angle:q*90}});await cdp('Emulation.setTouchEmulationEnabled',{enabled:true});await sleep(90);};
 await orientation(393,800,0);await cdp('Page.navigate',{url});await until('document.readyState==="complete"&&!!window.QuietCameraOverlay');
 await evaluate(`window.__zoomCalls=[];window.__zoomInputs=[];window.__zoomPointer=[];window.__fakeTimers=[];window.__activeConstraints=0;window.__maxConstraints=0;window.__reportedZoom=1;window.__settingsDelay=180;
 window.__installFake=()=>{for(const t of __fakeTimers)clearTimeout(t);__fakeTimers=[];__zoomCalls=[];__zoomInputs=[];__zoomPointer=[];__reportedZoom=1;__activeConstraints=0;__maxConstraints=0;const settings={width:1440,height:2560,frameRate:30,deviceId:'synthetic-track'};const track={readyState:'live',getSettings:()=>({...settings,zoom:__reportedZoom}),getCapabilities:()=>({zoom:{min:1,max:8,step:.1}}),getConstraints:()=>({deviceId:{exact:'synthetic-track'},width:{ideal:1440},height:{ideal:2560},frameRate:{ideal:30}}),applyConstraints:async c=>{const zoom=c.zoom??c.advanced?.at(-1)?.zoom;__activeConstraints++;__maxConstraints=Math.max(__maxConstraints,__activeConstraints);__zoomCalls.push({zoom,time:performance.now()});await new Promise(r=>setTimeout(r,35));__fakeTimers.push(setTimeout(()=>{__reportedZoom=zoom},__settingsDelay));__activeConstraints--}};state.videoTrack=track;state.recorder=null;state.recordingFinalizing=false;state.busy=false;updateCapabilities();QuietCameraEnhancements.initializeCameraController();elements.permissionPanel.hidden=true;document.querySelector('.camera-top-controls').inert=false;elements.zoomRange.disabled=false;state.mode='photo';updateModeUi();elements.cameraStatus.textContent='1440×2560 30fps';};
 elements.zoomRange.addEventListener('input',()=>__zoomInputs.push({value:Number(elements.zoomRange.value),output:parseFloat(elements.zoomValue.value),time:performance.now()}));for(const name of ['pointerdown','pointerup','pointercancel','gotpointercapture','lostpointercapture'])elements.zoomRange.addEventListener(name,e=>__zoomPointer.push({type:name,time:performance.now()}));__installFake();`);
 const drag=async(q)=>{
  const b=await evaluate('(()=>{const r=elements.zoomRange.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}})()');
  const p=f=>q===1?{x:b.x+b.width/2,y:b.bottom-b.height*f}:q===3?{x:b.x+b.width/2,y:b.y+b.height*f}:{x:b.x+b.width*f,y:b.y+b.height/2};const point=f=>({...p(f),id:1,radiusX:4,radiusY:4,force:1});
  await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(.1)]});for(let i=1;i<=24;i++){await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point(.1+.75*i/24)]});await sleep(30);}const releaseTime=await evaluate('performance.now()');await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(1200);
  return await evaluate(`({range:Number(elements.zoomRange.value),output:parseFloat(elements.zoomValue.value),current:state.currentZoom,reported:__reportedZoom,calls:__zoomCalls,inputs:__zoomInputs,pointers:__zoomPointer,maxConcurrency:__maxConstraints,releaseTime:${releaseTime}})`);
 };
 const zoomCases=[];
 for(const q of [0,1,3]){
  await orientation(q?800:393,q?393:800,q);await evaluate('__installFake()');await sleep(100);const size=await evaluate('(()=>{const r=elements.zoomRange.getBoundingClientRect();return{width:r.width,height:r.height}})()');verify('zoom hit cross-axis at least44px '+q,(q?size.width:size.height)>=43.9,size);
  const run=await drag(q);zoomCases.push({q,...run});verify('no pointer cancellation during normal drag '+q,!run.pointers.some(p=>p.type==='pointercancel'),run.pointers);
  verify('rotated touch reaches expected high zoom '+q,run.range>=6.5&&Math.abs(run.range-run.reported)<.11,{range:run.range,reported:run.reported});
  verify('input values are monotonic '+q,run.inputs.every((v,i)=>!i||v.value>=run.inputs[i-1].value-.1),run.inputs.map(v=>v.value));verify('readout follows requested input without hardware wait '+q,run.inputs.every(v=>Math.abs(v.value-v.output)<.06),run.inputs.slice(0,5));
  verify('only one constraint call in flight '+q,run.maxConcurrency===1,run.maxConcurrency);const during=run.calls.filter(c=>c.time<run.releaseTime);verify('superseded readback does not stall new zoom requests '+q,during.length>=6,{callsDuringDrag:during.length,allCalls:run.calls.length});await shot('zoom-'+q*90+'.png');
 }
 for(const q of [0,1,3]){await orientation(q?800:393,q?393:800,q);await evaluate('__installFake()');await sleep(100);const b=await evaluate('(()=>{const r=elements.zoomRange.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}})()');const p=f=>q===1?{x:b.x+b.width/2,y:b.bottom-b.height*f}:q===3?{x:b.x+b.width/2,y:b.y+b.height*f}:{x:b.x+b.width*f,y:b.y+b.height/2};await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p(.1)});for(let i=1;i<=12;i++){await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...p(.1+.75*i/12)});await sleep(30)}await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p(.85)});await sleep(1000);verify('mouse drag follows rotated track '+q,await evaluate('Number(elements.zoomRange.value)>6.5&&Math.abs(Number(elements.zoomRange.value)-state.currentZoom)<.11'));await evaluate('elements.zoomRange.focus({preventScroll:true})');for(const key of ['Home','End']){await cdp('Input.dispatchKeyEvent',{type:'keyDown',key,code:key});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key,code:key});await sleep(700);verify('native keyboard '+key+' works '+q,await evaluate('Math.abs(state.currentZoom-'+(key==='Home'?1:8)+')<.11'))}}
 const collisions=[],statusCases=[];
 for(const[w,h,q,font]of[[393,800,0,16],[800,393,1,16],[800,393,3,16],[320,480,0,16],[641,274,1,16],[641,274,3,16],[320,480,0,32],[641,274,1,32],[641,274,3,32]])for(const immersive of[false,true]){
  await orientation(w,h,q);await evaluate(`document.documentElement.style.fontSize='${font}px';if(document.documentElement.classList.contains('immersive-mode')!==${immersive})document.querySelector('#fullscreenButton').click();elements.photoFormatSelect.value='image/webp';state.mode='photo';updateModeUi();elements.cameraStatus.textContent='4032×3024 30fps';elements.zoomControl.hidden=false`);await sleep(130);
  const measured=await evaluate(`(()=>{const box=e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height}};const text=e=>{const walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);const rects=[];while(walker.nextNode()){const r=document.createRange();r.selectNodeContents(walker.currentNode);rects.push(...r.getClientRects())}return rects.filter(r=>r.width>0&&r.height>0).map(r=>({x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}))};const labels=['cameraStatus','mediaStatus'].map(id=>({id,text:document.getElementById(id).textContent,rects:text(document.getElementById(id))}));const controls=[...document.querySelectorAll('.camera-top-controls>button,.bottom-controls>button'),elements.zoomControl].filter(e=>!e.hidden&&getComputedStyle(e).display!=='none').map(e=>({id:e.id||'zoomControl',...box(e)}));const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1;return{labels,controls,collisions:labels.flatMap(l=>controls.filter(c=>l.rects.some(r=>overlap(r,c))).map(c=>({label:l.id,control:c.id}))),labelOverlap:labels[0].rects.some(a=>labels[1].rects.some(b=>overlap(a,b)))}})()`);
  const key=[w,h,q,font,immersive].join('-');verify('status glyphs do not overlap controls '+key,measured.collisions.length===0,measured.collisions);verify('status fields remain separate '+key,!measured.labelOverlap);verify('complete status text remains visible '+key,measured.labels.every(l=>l.rects.every(r=>r.x>=-.5&&r.y>=-.5&&r.right<=w+.5&&r.bottom<=h+.5))&&measured.labels[0].text==='4032×3024 30fps'&&measured.labels[1].text==='WebP',measured.labels);statusCases.push({key,...measured});if(measured.collisions.length)collisions.push({key,pairs:measured.collisions});if(font===16&&!immersive&&[393,800].includes(w))await shot('status-'+q*90+'.png');
 }
 audit=await evaluate('__audit');verify('no device media acquired',audit.mediaCalls===0,audit);verify('no uncaught exceptions',exceptions.length===0,exceptions);
 const record={passed:assertions.every(x=>x.passed),checks:assertions,zoomCases,statusCases,collisions,audit,exceptions,version:await evaluate('elements.versionBadge.textContent'),limits:['Synthetic track with35ms apply and180ms settings lag; no physical camera smoothness claim','Synthetic Chromium touch events, not phone browser inspection']};fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(record,null,2));console.log(JSON.stringify({passed:record.passed,checks:assertions.length,failures:assertions.filter(x=>!x.passed).map(x=>({name:x.name,detail:x.detail})),collisions:collisions.slice(0,4),output}));if(!record.passed)process.exitCode=1;
}catch(error){await shot('failure.png').catch(()=>{});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:error.stack,checks:assertions,exceptions},null,2));console.error(error);process.exitCode=1;}
} catch(error) {
 fs.writeFileSync(path.join(output,'harness-failure.json'),JSON.stringify({passed:false,error:error.stack},null,2));console.error(error);process.exitCode=1;
} finally {
 await cleanupBrowserTest({scratch,chrome,socket,command:cleanupCommand,server,output,pending});
}
