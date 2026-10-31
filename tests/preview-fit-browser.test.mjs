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
const root=process.env.QUIET_CAMERA_FIT_ROOT||path.resolve(import.meta.dirname,'..');
const output=process.env.QUIET_CAMERA_FIT_OUTPUT||path.resolve(root,'test-results/zoom-status');
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
chrome=spawn(process.env.CHROME_PATH||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'google-chrome'),['--headless=new','--remote-debugging-port=0',`--user-data-dir=${scratch}`,'--disable-background-networking','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check','--mute-audio','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
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
const baseline=process.env.QUIET_CAMERA_FIT_BASELINE==='1';let audit;const cases=[];let encoderWarmup=null;
try{
 const{browserContextId}=await command('Target.createBrowserContext');for(const name of['camera','microphone'])await command('Browser.setPermission',{permission:{name},setting:'denied',browserContextId});const{targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});({sessionId}=await command('Target.attachToTarget',{targetId,flatten:true}));await cdp('Page.enable');await cdp('Runtime.enable');
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`window.__audit={nativeMediaCalls:0,requests:[]};window.__supportedAspect=true;Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:o=>window.__synthetic(o),enumerateDevices:async()=>[{kind:'videoinput',deviceId:'pattern',label:'Synthetic pattern'},{kind:'videoinput',deviceId:'other',label:'Other synthetic'}],getSupportedConstraints:()=>({aspectRatio:__supportedAspect,resizeMode:true,zoom:true}),addEventListener(){}}});Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});window.ImageCapture=undefined;`});
 const orientation=async(w,h,q)=>{await cdp('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:true,screenWidth:w,screenHeight:h,screenOrientation:{type:q===1?'landscapePrimary':q===3?'landscapeSecondary':'portraitPrimary',angle:q*90}});await cdp('Emulation.setTouchEmulationEnabled',{enabled:true});await sleep(110)};
 await orientation(393,800,0);await cdp('Page.navigate',{url});await until('typeof elements!=="undefined"&&!!window.QuietCameraOverlay');
 await evaluate(`window.__portrait=true;window.__nativeRatio=16/9;window.__rejectRatio=false;window.__lieRatio=false;window.__synthetic=async options=>{__audit.requests.push(options);if(__rejectRatio&&options.video.aspectRatio?.exact)throw new DOMException('Synthetic rejected ratio','OverconstrainedError');const ratio=__lieRatio?__nativeRatio:options.video.aspectRatio?.exact||__nativeRatio,c=document.createElement('canvas');c.width=__portrait?Math.round(320/ratio):320;c.height=__portrait?320:Math.round(320/ratio);const x=c.getContext('2d');x.fillStyle='#207050';x.fillRect(0,0,c.width,c.height);x.fillStyle='#ed3020';x.fillRect(0,0,c.width*.25,c.height);x.fillStyle='#2030ed';x.fillRect(c.width*.75,0,c.width*.25,c.height);x.fillStyle='#fff';x.fillRect(c.width*.375,c.height*.375,c.width*.25,c.height*.25);window.__pattern=c;const stream=c.captureStream(30),track=stream.getVideoTracks()[0],settings=track.getSettings.bind(track);let zoom=1;track.getSettings=()=>({...settings(),deviceId:'pattern',facingMode:'environment',zoom,torch:false,...(__lieRatio?{aspectRatio:options.video.aspectRatio?.exact||ratio}:{})});let tick=0;const timer=setInterval(()=>{if(track.readyState==="ended"){clearInterval(timer);return}x.fillStyle="rgb("+(tick++%255)+",0,0)";x.fillRect(0,0,1,1)},33);track.getCapabilities=()=>({zoom:{min:1,max:8,step:.1},torch:true});track.applyConstraints=async p=>{zoom=p.zoom??p.advanced?.at(-1)?.zoom??zoom;c.getContext('2d').fillRect(0,0,1,1)};return stream};state.microphonePreference='off';state.microphoneDecision='off';state.selectedDeviceId='pattern';state.facingMode='environment';elements.microphoneSelect.value='off';elements.videoResolutionSelect.value='1080';elements.videoFrameRateSelect.value='30';window.__exports=[];addMedia=async m=>__exports.push(m);getHighQualityPhotoSource=async()=>({source:__pattern,width:__pattern.width,height:__pattern.height,dispose(){},highQuality:false});elements.photoFormatSelect.value='image/png';state.timerSeconds=0;`);
 const measure=()=>evaluate(`(()=>{const box=e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom}};const s=box(elements.cameraStage),surface=box(document.querySelector('#cameraSurface')),zoom=box(elements.zoomControl);const buttons=[...document.querySelector('#cameraControls').querySelectorAll('button')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({id:e.id,bottomGroup:!!e.closest('.bottom-controls'),...box(e)}));const fit=getComputedStyle(elements.video).objectFit;const sw=elements.video.videoWidth,sh=elements.video.videoHeight,scale=(fit==='cover'?Math.max:Math.min)(s.width/sw,s.height/sh);return{stage:s,surface,zoom,buttons,fit,source:{width:sw,height:sh},sourceDisplay:{width:sw*scale,height:sh*scale},label:elements.cameraStage.getAttribute("aria-label"),noticeHidden:document.querySelector("#previewFrameLabel").hidden,caption:document.querySelector('#previewFrameLabel')?box(document.querySelector('#previewFrameLabel')):null,ratio:state.mode==='photo'?state.ratio:state.videoRatio,mode:state.mode,quarter:Number(document.querySelector('#cameraSurface').dataset.deviceRotation)/90,page:[scrollX,scrollY]}})()`);
 const photoOutputs=[],videoOutputs=[];
 for(const[w,h,q]of[[393,800,0],[800,393,1],[800,393,3],[320,480,0],[641,274,1],[641,274,3]]){
  await orientation(w,h,q);await evaluate(`__portrait=${!q};state.mode='photo';state.ratio='16:9';updateModeUi();QuietCameraEnhancements.enhancedStartCamera()`);await sleep(100);
  const reference=(await measure()).buttons;
  for(const mode of['photo','video'])for(const ratio of['16:9','4:3','1:1']){
   await evaluate(`state.mode='${mode}';state.${mode==='photo'?'ratio':'videoRatio'}='${ratio}';updateModeUi();${mode==='video'?'QuietCameraEnhancements.enhancedStartCamera()':'undefined'}`);await sleep(110);const m=await measure(),key=[w,h,q,mode,ratio].join('-');
   if(!baseline){
    const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.x,b.x)>.6&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>.6;
    check('preview avoids every button and zoom hit area '+key,q===0||(!m.buttons.some(b=>overlap(m.stage,b))&&!overlap(m.stage,m.zoom)),true);
    check('preview notice stays visible outside button targets '+key,mode==='photo'?m.noticeHidden:m.caption.width>0&&m.caption.y>=m.stage.y-.5&&m.caption.bottom<=m.stage.bottom+.5&&!m.buttons.some(b=>overlap(m.caption,b)),true);
    check('complete frame remains inside viewport '+key,m.stage.x>=-.5&&m.stage.y>=-.5&&m.stage.right<=w+.5&&m.stage.bottom<=h+.5&&m.page.every(x=>x===0),true);
    check('fixed button positions do not follow preview ratio '+key,m.buttons.every(b=>{const p=reference.find(p=>p.id===b.id);return !p||Math.abs(p.x-b.x)<.5&&Math.abs(p.y-b.y)<.5&&Math.abs(p.width-b.width)<.5&&Math.abs(p.height-b.height)<.5}),true);
    const top=m.buttons.filter(b=>!b.bottomGroup),gap=4;let region;
    if(q===0){region={x:0,y:0,width:w,height:h};check('portrait keeps v3 physical-top frame '+key,Math.abs(m.stage.y)<.1,true)}
    else if(q===1){const a=Math.max(...top.map(b=>b.right))+gap,b=m.zoom.x-gap;region={x:a,y:0,width:b-a,height:h};check('preview right edge ends before zoom '+key,Math.abs(m.zoom.x-m.stage.right-gap)<.6,true)}
    else{const a=m.zoom.right+gap,b=Math.min(...top.map(b=>b.x))-gap;region={x:a,y:0,width:b-a,height:h};check('preview left edge ends before zoom '+key,Math.abs(m.stage.x-m.zoom.right-gap)<.6,true)}
    const raw=ratio==='1:1'?1:ratio==='4:3'?4/3:16/9,aspect=q===0?1/raw:mode==='photo'?raw:m.source.width/m.source.height;
    const expectedWidth=Math.min(region.width,region.height*aspect);check('maximum aspect-preserving preview '+key,Math.abs(m.stage.width-expectedWidth)<1&&Math.abs(m.stage.height-m.stage.width/aspect)<1,true);
    check('photo crop is announced and video is contained '+key,m.fit===(mode==='photo'?'cover':'contain')&&m.label.includes(mode==='photo'?'写真の保存範囲':'映像全体'),true);
   }
   cases.push({key,...m});if(w===393||w===800)await shot((baseline?'before-':'after-')+q+'-'+mode+'-'+ratio.replace(':','-')+'.png');
   if(!baseline&&(w===393||w===800)&&q!==3){
    if(mode==='photo'){
     const result=await evaluate(`(async()=>{await capturePhoto();const m=__exports.at(-1),bitmap=await createImageBitmap(m.blob),crop=calculateCrop(__pattern.width,__pattern.height,getVisiblePhotoRatio()),out=document.createElement('canvas');out.width=bitmap.width;out.height=bitmap.height;const x=out.getContext('2d');x.drawImage(bitmap,0,0);bitmap.close();const source=__pattern.getContext('2d');const pixels=[[.1,.1],[.5,.5],[.9,.9]].map(([a,b])=>{const px=Math.floor(a*out.width),py=Math.floor(b*out.height),actual=[...x.getImageData(px,py,1,1).data],expected=[...source.getImageData(crop.sx+px,crop.sy+py,1,1).data];return actual.every((v,i)=>Math.abs(v-expected[i])<=1)});return{width:m.width,height:m.height,crop,pixels}})()`);photoOutputs.push({key,...result});check('synthetic saved PNG matches announced visible crop '+key,result.width===result.crop.sw&&result.height===result.crop.sh&&result.pixels.every(Boolean),true);
    }else{
     if(!encoderWarmup)encoderWarmup=await evaluate(`(async()=>{const t0=performance.now(),r=new MediaRecorder(state.stream,{mimeType:'video/webm;codecs=vp8'});let bytes=0,first=null;const enough=new Promise(resolve=>{r.addEventListener('dataavailable',e=>{if(e.data.size&&first===null)first=Math.round(performance.now()-t0);bytes+=e.data.size;if(bytes>1024)resolve(true)});setTimeout(()=>resolve(false),10000)});const stopped=new Promise(resolve=>r.addEventListener('stop',resolve,{once:true}));r.start(250);const warmed=await enough;r.stop();await stopped;return{warmed,bytes,firstDataMs:first,totalMs:Math.round(performance.now()-t0)}})()`);
     check('encoder warmup actually produced payload',encoderWarmup.warmed&&encoderWarmup.bytes>1024,true);
     const result=await evaluate(`(async()=>{const track=state.stream.getVideoTracks()[0],input={readyState:track.readyState,active:state.stream.active,settings:track.getSettings(),samePreview:elements.video.srcObject===state.stream};if(input.readyState!=="live"||!input.active||!input.samePreview)throw new Error('Synthetic input is not live and attached '+JSON.stringify(input));const decodedBeforeRecord=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('No decoded synthetic frame before recording '+JSON.stringify(input))),3000);elements.video.requestVideoFrameCallback((_,meta)=>{clearTimeout(timer);resolve({width:meta.width,height:meta.height,mediaTime:meta.mediaTime})});track.requestFrame?.()});const parts=[],r=new MediaRecorder(state.stream,{mimeType:'video/webm;codecs=vp8'});r.addEventListener('dataavailable',e=>{if(e.data.size)parts.push(e.data)});const stopped=new Promise(resolve=>r.addEventListener('stop',resolve,{once:true}));r.start();for(let frame=0;frame<8;frame++){const ctx=__pattern.getContext('2d');ctx.fillStyle='rgb('+(frame*29)+',90,160)';ctx.fillRect(0,0,__pattern.width/2,__pattern.height/2);state.stream.getVideoTracks()[0].requestFrame?.();await new Promise(resolve=>setTimeout(resolve,120))}r.stop();await stopped;const blob=new Blob(parts,{type:r.mimeType}),v=document.createElement('video'),url=URL.createObjectURL(blob);try{const ready=new Promise((resolve,reject)=>{v.onloadedmetadata=resolve;v.onerror=()=>reject(new Error('Synthetic WebM metadata error code'+v.error?.code+' bytes'+blob.size))});v.src=url;await ready;return{width:v.videoWidth,height:v.videoHeight,bytes:blob.size,input,decodedBeforeRecord}}finally{v.removeAttribute('src');v.load();URL.revokeObjectURL(url)}})()`);videoOutputs.push({key,...result});check('synthetic recording keeps actual stream dimensions '+key,result.width===m.source.width&&result.height===m.source.height&&result.bytes>0,true);
    }
   }
  }
 }
 if(!baseline){
  await orientation(393,800,0);await evaluate(`__portrait=true;__supportedAspect=false;state.mode='video';state.videoRatio='1:1';updateModeUi();QuietCameraEnhancements.enhancedStartCamera()`);check('unsupported video ratio returns label to actual stream',await evaluate('[state.videoRatio,__audit.requests.at(-1).video.aspectRatio??null]'),['16:9',null]);
  await evaluate(`__supportedAspect=true;__rejectRatio=true;state.videoRatio='1:1';updateModeUi();QuietCameraEnhancements.enhancedStartCamera()`);check('rejected ratio fallback reports actual16:9',await evaluate('[state.videoRatio,__audit.requests.at(-1).video.aspectRatio??null]'),['16:9',null]);
  await evaluate(`__rejectRatio=false;__lieRatio=true;state.videoRatio='1:1';updateModeUi();QuietCameraEnhancements.enhancedStartCamera()`);check('decoded pixels override misleading track aspectRatio',await evaluate('[state.videoRatio,state.videoTrack.getSettings().aspectRatio,elements.video.videoWidth/elements.video.videoHeight]'),['16:9',1,9/16]);await shot('actual-video-ratio-fallback.png');
 }
 audit=await evaluate('__audit');check('no native camera microphone accessed',audit.nativeMediaCalls,0);check('no unhandled exceptions',exceptions.length,0);
 const result={passed:true,baseline,version:await evaluate('elements.versionBadge.textContent'),checks:results,cases,photoOutputs,videoOutputs,encoderWarmup,audit,limits:['Generated canvas streams, PNG exports and short synthetic video recordings only; no physical camera/mic or private gallery','Actual S25 ratio support and screenshot pixels not verified in this executor']};fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,baseline,encoderWarmup,checks:results.length,cases:cases.length,photoOutputs:photoOutputs.length,videoOutputs:videoOutputs.length,output}));
}catch(error){await shot('failure.png').catch(()=>{});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:error.stack,checks:results,cases,encoderWarmup,exceptions},null,2));console.error(error);process.exitCode=1;}
} catch(error) {
 fs.writeFileSync(path.join(output,'harness-failure.json'),JSON.stringify({passed:false,error:error.stack},null,2));console.error(error);process.exitCode=1;
} finally {
 await cleanupBrowserTest({scratch,chrome,socket,command:cleanupCommand,server,output,pending});
}
