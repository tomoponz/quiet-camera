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
const root=path.resolve(import.meta.dirname,'..');
const output=process.env.QUIET_CAMERA_REVIEW_TEST_OUTPUT||path.resolve(root,'test-results/media');
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
 const p=await evaluate(`(()=>{const v=state.selectedMedia?.kind==="video",r=(v?elements.reviewVideo:document.querySelector("#reviewViewer")).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height*(v ? 0.2 : 0.5)}})()`);
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
 const {browserContextId}=await command('Target.createBrowserContext');
 for(const name of ['camera','microphone'])await command('Browser.setPermission',{permission:{name},setting:'denied',browserContextId});
 const {targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});
 ({sessionId}=await command('Target.attachToTarget',{targetId,flatten:true}));
 await cdp('Page.enable');await cdp('Runtime.enable');await metrics(360,780);
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
  window.__audit={mediaCalls:0,mediaStacks:[],shares:[],downloads:[],urls:new Set(),created:0,revoked:0};
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{__audit.mediaCalls++;__audit.mediaStacks.push(new Error('Device media forbidden').stack);throw new Error('Device media forbidden');},enumerateDevices:async()=>[],getSupportedConstraints:()=>({}),addEventListener(){}}});
  Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});
  Object.defineProperty(navigator,'share',{value:async d=>{__audit.shares.push(d.files.map(f=>({name:f.name,size:f.size,type:f.type})))}});
  Object.defineProperty(navigator,'canShare',{value:()=>true,configurable:true});
  const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
  URL.createObjectURL=b=>{const u=create(b);__audit.urls.add(u);__audit.created++;return u};
  URL.revokeObjectURL=u=>{if(__audit.urls.delete(u))__audit.revoked++;revoke(u)};
  window.confirm=()=>true;
 `});
 await cdp('Page.navigate',{url});
 await until('document.querySelector("#versionBadge")?.textContent === "v2026.10.31.2" && typeof findAdjacentMedia === "function"');
 await evaluate(`(async()=>{
  triggerDownload=(blob,name)=>__audit.downloads.push({name,size:blob.size,type:blob.type});
  const base=1700000000000;window.__base=base;
  for(let i=0;i<72;i++){
   const c=document.createElement('canvas');c.width=i%3===0?300:600;c.height=400;const x=c.getContext('2d');x.fillStyle='hsl('+i*17+' 70% 35%)';x.fillRect(0,0,c.width,c.height);x.fillStyle='white';x.font='bold 36px sans-serif';x.fillText('PHOTO '+i,20,200);
   const blob=await canvasToBlob(c,'image/png',1);await putMedia({id:'p'+String(i).padStart(3,'0'),kind:'photo',createdAt:base+i*1000,blob,previewBlob:blob,extension:'png',mimeType:'image/png',meta:'テスト写真 '+i+' · '+c.width+'×400'});
  }
  const tie=await getStoredMedia('p070');await putMedia({...tie,id:'p070a'});await putMedia({...tie,id:'p070b'});
  for(const [id,file,offset] of [['v-landscape','landscape.mp4',70500],['v-portrait','portrait.mp4',69500],['v-stream','stream.webm',67500]]){
   const blob=await fetch('/__fixture/'+file).then(r=>r.blob());await putMedia({id,kind:'video',createdAt:base+offset,blob,previewBlob:blob,extension:file.split('.').at(-1),mimeType:blob.type,duration:2000,meta:'テスト動画 '+id});
  }
  const broken=new Blob(['not a video'],{type:'video/mp4'});await putMedia({id:'v-broken',kind:'video',createdAt:base+68500,blob:broken,previewBlob:broken,extension:'mp4',mimeType:'video/mp4',meta:'破損動画テスト'});
  await refreshGallery();
 })()`);
 check('gallery remains paged',await evaluate('state.gallery.length'),60);
 check('mixed order preserves timestamp ties',await evaluate('(async()=>[await findAdjacentMedia(await getStoredMedia("p071"),"older"),await findAdjacentMedia(await getStoredMedia("p070b"),"older"),await findAdjacentMedia(await getStoredMedia("p070"),"older")].map(x=>x?.id))()'),['v-landscape','p070a','v-portrait']);
 await open('p071');await shot('01-photo-navigation.png');
 await swipe(-100);await until('state.selectedMedia?.id === "v-landscape"');check('left swipe includes older video',await selected(),'v-landscape');
 await swipe(100);await until('state.selectedMedia?.id === "p071"');check('right swipe shows newer photo',await selected(),'p071');
 await swipe(100);check('newest boundary does not wrap',await selected(),'p071');
 await open('p000');await swipe(-100);check('oldest boundary does not wrap',await selected(),'p000');
 await open('p050');await swipe(5,80);check('vertical scroll does not navigate',await selected(),'p050');
 await swipe(100,0,{multi:true});check('pinch does not navigate',await selected(),'p050');
 await swipe(100,0,{cancel:true});check('cancel does not navigate',await selected(),'p050');
 await cdp('Emulation.setPageScaleFactor',{pageScaleFactor:2});await sleep(60);await swipe(-80);check('zoomed image pan does not navigate',await selected(),'p050');
 await cdp('Emulation.setPageScaleFactor',{pageScaleFactor:1});await sleep(60);
 await evaluate('elements.closeReviewButton.focus()');await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight'});await until('state.selectedMedia?.id === "p049"');check('ArrowRight shows older photo',await selected(),'p049');
 await until('!document.querySelector("#reviewNewerPhoto").disabled');await evaluate('document.querySelector("#reviewNewerPhoto").click()');await until('state.selectedMedia?.id === "p050"');check('newer button works',await selected(),'p050');
 const lastLoaded=await evaluate('state.gallery.filter(x=>x.kind === "photo").at(-1).id');await open(lastLoaded);
 const outside=await evaluate('(async()=>{const n=await findAdjacentMedia(state.selectedMedia,"older");return {id:n.id,loaded:state.gallery.some(x=>x.id===n.id)}})()');check('next photo lies outside loaded page',outside.loaded,false);
 await swipe(-100);await until(`state.selectedMedia?.id === ${JSON.stringify(outside.id)}`);check('swipe crosses gallery page boundary',await selected(),outside.id);
 await metrics(780,360);check('rotation preserves selection',await selected(),outside.id);await shot('02-photo-landscape.png');await metrics(360,780);
 await evaluate('elements.shareButton.click();elements.downloadButton.click()');check('share/download target current photo',await evaluate('[__audit.shares.at(-1)[0].size,__audit.downloads.at(-1).size]'),await evaluate('[state.selectedMedia.blob.size,state.selectedMedia.blob.size]'));
 const deleteId=await selected();await evaluate('elements.deleteButton.click()');await until('!elements.reviewDialog.open && !state.selectedMedia');check('delete preserves existing close behavior',await evaluate(`(async()=>await getStoredMedia(${JSON.stringify(deleteId)})===null)()`),true);
 await open('p049');await close();await open('p049');check('reopen selects requested photo',await selected(),'p049');
 await evaluate('elements.closeReviewButton.focus()');await cdp('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await until('!elements.reviewDialog.open && !state.selectedMedia');check('Escape closes review',await selected(),null);
 // Existing videos gain previews in memory; no migration or history rewrite.
 await evaluate('(async()=>{renderGallery();elements.galleryDialog.showModal()})()');
 await until('document.querySelectorAll(".video-thumbnail img").length >= 2');
 await evaluate('document.querySelector(".gallery-card[data-id=v-stream]").scrollIntoView({block:"center"})');
 await until('document.querySelectorAll(".video-thumbnail img").length >= 3');await until('[...document.querySelectorAll(".video-thumbnail img")].every(x=>x.complete&&x.naturalWidth>0)');await shot('03-video-gallery.png');
 check('legacy videos get identifiable thumbnail frames',await evaluate('document.querySelectorAll(".video-thumbnail img").length'),3);
 await evaluate('elements.galleryDialog.close()');await sleep(60);
 for(const[id,width,height]of[['v-landscape',320,180],['v-portrait',180,320],['v-stream',160,90]]){
  await open(id);await until('!!elements.reviewVideo.poster && elements.reviewVideo.videoWidth>0');
  check(id+' metadata dimensions',await evaluate('[elements.reviewVideo.videoWidth,elements.reviewVideo.videoHeight]'),[width,height]);
  check(id+' preview has nonzero layout',await evaluate('(()=>{const r=elements.reviewVideo.getBoundingClientRect();return r.width>20&&r.height>20})()'),true);
  check(id+' mixed navigation visible',await evaluate('document.querySelector("#reviewPhotoNavigation").hidden'),false);
  // Mixed video swipes are covered by the dedicated interaction suite.

  await until('elements.reviewVideo.readyState >= 2');await sleep(120);
  await shot(id==='v-landscape'?'04-video-landscape.png':id==='v-portrait'?'05-video-portrait.png':'07-video-webm.png');
  await evaluate('elements.reviewVideo.play()');await until('elements.reviewVideo.currentTime > 0.1');await evaluate('elements.reviewVideo.pause()');
  check(id+' playback works',await evaluate('elements.reviewVideo.currentTime>0.1'),true);
  const mime=id==='v-stream'?'video/webm':'video/mp4';await evaluate('elements.shareButton.click();elements.downloadButton.click()');check(id+' share/download MIME',await evaluate('[__audit.shares.at(-1)[0].type,__audit.downloads.at(-1).type]'),[mime,mime]);
  await close();await open(id);await until('!!elements.reviewVideo.poster');await close();
 }
 check('old thumbnail is not written back to storage',await evaluate('(async()=>!(await getStoredMedia("v-landscape")).thumbnailBlob)()'),true);
 await evaluate(`window.__finalizeSynthetic=async(id,failPoster)=>{
  const m=await getStoredMedia('v-landscape'),session='test-session-'+id;
  await putRecordingSession({id:session,mediaId:id,createdAt:__base+80000});await putRecordingChunk(session,0,m.blob);
  Object.assign(state,{recorder:{mimeType:'video/mp4'},recordingSessionId:session,recordingMediaId:id,recordingCreatedAt:__base+80000,recordingDurationMs:2000,recordingStartTime:performance.now()-2000,recordingAudioEnabled:false,recordingResolution:'320×180',recordingMimeType:'video/mp4',recordingWriteQueue:Promise.resolve(),recordingWriteError:null,recordingRuntimeError:null,recordingFinalizing:false,cancelRecording:false});
  const original=QuietCameraVideoPreview.createPoster;
  const previousStream=state.stream;
  // A normal recording finalizes while its camera stream still exists. Supply
  // only that structural precondition; no MediaStream or device is acquired.
  state.stream={getTracks:()=>[],getVideoTracks:()=>[],getAudioTracks:()=>[]};
  if(failPoster)QuietCameraVideoPreview.createPoster=async()=>{throw new Error('Synthetic poster failure')};
  try{await finalizeRecording()}finally{QuietCameraVideoPreview.createPoster=original;state.stream=previousStream;elements.shutterButton.disabled=!previousStream}
  const stored=await getStoredMedia(id);return stored&&{size:stored.blob.size,type:stored.thumbnailBlob?.type,width:stored.width,height:stored.height,sourceSize:m.blob.size};
 }`);
 const finalized=await evaluate('__finalizeSynthetic("v-finalized",false)');
 check('finalization saves a JPEG preview and actual dimensions',[finalized.type,finalized.width,finalized.height,finalized.size===finalized.sourceSize],['image/jpeg',320,180,true]);await close();
 const noPoster=await evaluate('__finalizeSynthetic("v-no-poster",true)');
 check('poster failure still preserves the video',[noPoster.type||null,noPoster.size===noPoster.sourceSize],[null,true]);await close();
 const posterTest=await evaluate(`(async()=>{const m=await getStoredMedia('v-landscape'),p=await QuietCameraVideoPreview.createPoster(m.blob);const b=await createImageBitmap(p.blob),c=document.createElement('canvas');c.width=b.width;c.height=b.height;const x=c.getContext('2d');x.drawImage(b,0,0);const data=x.getImageData(0,0,c.width,c.height).data;let bright=0;for(let i=0;i<data.length;i+=4)if(data[i]+data[i+1]+data[i+2]>150)bright++;b.close();return {time:p.time,bright:bright/(data.length/4)}})()`);
 check('representative frame skips black opening',posterTest.time>=0.25&&posterTest.bright>0.15,true);
 await open('v-broken');await until('!document.querySelector("#reviewVideoStatus").hidden && /読み込めません|取得できません/.test(document.querySelector("#reviewVideoStatus").textContent)');await shot('06-video-error.png');check('decode failure has visible fallback',await evaluate('!elements.downloadButton.disabled'),true);await close();
 const activeBefore=await evaluate('__audit.urls.size');
 for(let i=0;i<6;i++){await open(i%2?'p040':'v-landscape');if(!(i%2))await until('!!elements.reviewVideo.poster');await close();}
 await sleep(120);check('reopen revokes review object URLs',await evaluate('__audit.urls.size'),activeBefore);
 await open('v-landscape');await close();await open('p030');await sleep(100);check('late video task cannot overwrite photo',await evaluate('[state.selectedMedia.id,elements.reviewVideo.hasAttribute("poster")]'),['p030',false]);await close();
 await evaluate('(async()=>{for(const x of await listStoredMediaPage({limit:200}))if(x.id!=="p000")await deleteStoredMedia(x.id);await refreshGallery()})()');
 await open('p000');await until('document.querySelector("#reviewOlderPhoto").disabled && document.querySelector("#reviewNewerPhoto").disabled');await swipe(-100);check('single photo is stable',await selected(),'p000');await close();
  await evaluate('(async()=>{await deleteStoredMedia("p000");await refreshGallery()})()');check('zero photos clears selection and hides navigation',await evaluate('[state.gallery.length,state.selectedMedia,document.querySelector("#reviewPhotoNavigation").hidden]'),[0,null,true]);
 audit=await evaluate('({mediaCalls:__audit.mediaCalls,mediaStacks:__audit.mediaStacks,createdUrls:__audit.created,revokedUrls:__audit.revoked,activeUrls:__audit.urls.size,sharesStubbed:__audit.shares.length,downloadsStubbed:__audit.downloads.length})');
 check('no camera or microphone requests',audit.mediaCalls,0);check('all URLs released with empty gallery',audit.activeUrls,0);check('no uncaught browser exceptions',exceptions.length,0);
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:true,engine:version.product,url,isolatedProfile:scratch,fixtureOnly:true,realDeviceUsed:false,manualServerTouched:false,results,audit,posterTest,exceptions},null,2));
 console.log(JSON.stringify({passed:true,checks:results.length,engine:version.product,audit,posterTest,output}));
}catch(error){
 await shot('failure.png').catch(()=>{});
 const stateAtFailure=await evaluate('({selectedId:state.selectedMedia?.id,dialogOpen:elements.reviewDialog.open,videoStatus:document.querySelector("#reviewVideoStatus").textContent,videoReady:elements.reviewVideo.readyState,videoError:elements.reviewVideo.error?.message,poster:!!elements.reviewVideo.poster,thumbnailCount:document.querySelectorAll(".video-thumbnail img").length})').catch(()=>null);
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:String(error.stack),results,exceptions,stateAtFailure,audit:await evaluate('({mediaCalls:__audit.mediaCalls,mediaStacks:__audit.mediaStacks})').catch(()=>null)},null,2));
 throw error;
}
} catch(error) {
 fs.writeFileSync(path.join(output,'harness-failure.json'),JSON.stringify({passed:false,error:error.stack},null,2));console.error(error);process.exitCode=1;
} finally {
 await cleanupBrowserTest({scratch,chrome,socket,command:cleanupCommand,server,output,pending});
}
