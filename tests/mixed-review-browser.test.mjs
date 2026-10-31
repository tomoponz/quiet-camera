import {createOwnedScratch,cleanupBrowserTest} from './browser-cleanup.mjs';
// Synthetic media only, with a fresh browser profile and isolated storage.
// No real camera, microphone, phone, or user gallery is used.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const root=process.env.QC_MIXED_ROOT||path.resolve(import.meta.dirname,'..');
const output=process.env.QC_MIXED_OUTPUT||path.resolve(root,'test-results/mixed-review');
const fixtures=process.env.QUIET_CAMERA_REVIEW_FIXTURES||path.resolve(root,'tests/fixtures');
fs.mkdirSync(output,{recursive:true});
const toneMeta=JSON.parse(fs.readFileSync(path.join(fixtures,'synthetic-tone.json'),'utf8'));assert.equal(createHash('sha256').update(fs.readFileSync(path.join(fixtures,'synthetic-tone.webm'))).digest('hex'),toneMeta.sha256,'Synthetic fixture hash');
const scratch=createOwnedScratch('quiet-camera-mixed-review-');
let server,chrome,socket,cleanupCommand;const pending=new Map();
try {
server=http.createServer((req,res)=>{
 const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 let file;
 if(pathname.startsWith('/__fixture/')){
  const basename=pathname.slice('/__fixture/'.length);
  if(!['portrait.mp4','landscape.mp4','stream.webm','synthetic-tone.webm','synthetic-tone.json'].includes(basename)){res.writeHead(404).end();return;}
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
const reviewReady=async()=>{
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 await until('elements.reviewDialog.open&&!!state.selectedMedia&&!document.querySelector("#reviewPhotoNavigation").hasAttribute("aria-busy")');
 await until('state.selectedMedia.kind!=="video"||(elements.reviewVideo.readyState>=2&&!elements.reviewVideo.seeking)||!!elements.reviewVideo.error');
 const stable=await evaluate(`new Promise(resolve=>{let last='',matches=0,frames=0;const sample=()=>{const target=state.selectedMedia.kind==='video'?elements.reviewVideo:document.querySelector('#reviewViewer'),r=target.getBoundingClientRect(),key=JSON.stringify([r.x,r.y,r.width,r.height]);matches=key===last?matches+1:0;last=key;if(matches>=2)return resolve(true);if(++frames>=60)return resolve(false);requestAnimationFrame(sample)};requestAnimationFrame(sample)})`);
 assert(stable,'review media dimensions must settle before gesture input');
};
const selected=()=>evaluate('state.selectedMedia?.id || null');
const close=async()=>{await evaluate('if(elements.reviewDialog.open)elements.reviewDialog.close()');await until('!elements.reviewDialog.open && !state.selectedMedia');};
const open=async id=>{
 if(await evaluate('elements.reviewDialog.open'))await close();
 await evaluate(`(async()=>{selectMedia(await getStoredMedia(${JSON.stringify(id)}));elements.reviewDialog.showModal()})()`);
 await until('elements.reviewDialog.open && !!state.selectedMedia');
 if(await evaluate('state.selectedMedia.kind === "photo"'))await until('elements.reviewImage.complete && elements.reviewImage.naturalWidth > 0 && !document.querySelector("#reviewPhotoNavigation").hasAttribute("aria-busy")');
 await reviewReady();
};
const metrics=async(w,h,touch=true)=>{await cdp('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:touch,screenWidth:w,screenHeight:h,screenOrientation:{type:w>h?'landscapePrimary':'portraitPrimary',angle:w>h?90:0}});await cdp('Emulation.setTouchEmulationEnabled',{enabled:touch});await sleep(40);};
const swipe=async(dx,dy=0,{cancel=false,multi=false,area="content"}={})=>{
 await reviewReady();
 const p=await evaluate(`(()=>{const video=state.selectedMedia.kind==='video',r=(video?elements.reviewVideo:document.querySelector('#reviewViewer')).getBoundingClientRect();return{x:r.x+r.width/2,y:video?r.y+r.height*(${area==='controls'?0.94:0.2}):r.y+r.height/2,marker:performance.now(),scale:visualViewport?.scale||1,media:state.selectedMedia.id}})()`);
 const point=(x,y,id=1)=>({x,y,id,radiusX:3,radiusY:3,force:1});
 await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(p.x,p.y)]});
 if(multi)await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(p.x,p.y),point(p.x+30,p.y,2)]});
 for(let i=1;i<=5;i++){
  const points=[point(p.x+dx*i/5,p.y+dy*i/5)];if(multi)points.push(point(p.x+30+dx*i/5,p.y+dy*i/5,2));
  await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:points});await sleep(20);
 }
 // This viewer recognizes swipes only within 900 ms. Unlike the draggable
 // sheets, it does not use release velocity; an idle hold only consumes that
 // input budget and can turn a valid swipe into a long press under CPU load.
 await cdp('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});
 const timing=await evaluate(`(()=>{const events=__pointerLog.filter(event=>event.time>=${p.marker}),down=events.find(event=>event.type==='pointerdown'),up=events.find(event=>event.type==='pointerup'&&event.id===down?.id);const timing={media:${JSON.stringify(p.media)},elapsedMs:down&&up?up.time-down.time:null,scale:${p.scale},cancel:${cancel},multi:${multi},area:${JSON.stringify(area)}};__swipeTimings.push(timing);return timing})()`);
 if(timing.elapsedMs!==null&&!cancel&&!multi&&area==='content'&&p.scale<=1.01)assert(timing.elapsedMs<900,'CDP swipe delivery exceeded the 900 ms gesture window: '+timing.elapsedMs);
 await sleep(90);
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
  window.confirm=()=>true;window.__pointerLog=[];window.__swipeTimings=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture'])document.addEventListener(type,e=>{__pointerLog.push({type,id:e.pointerId,target:e.target.id,x:e.clientX,y:e.clientY,time:performance.now(),scale:visualViewport?.scale});if(__pointerLog.length>180)__pointerLog.shift()},true);
 `});
 await cdp('Page.navigate',{url});
 await until('typeof selectMedia === "function" && typeof refreshGallery === "function"');
 await evaluate(`(async()=>{
  triggerDownload=(b,n)=>__audit.downloads.push({size:b.size,name:n});window.__base=1700000000000;
  const c=document.createElement('canvas');c.width=360;c.height=240;const x=c.getContext('2d');x.fillStyle='#274944';x.fillRect(0,0,360,240);x.fillStyle='white';x.font='30px sans-serif';x.fillText('GENERATED PHOTO',12,110);const photo=await canvasToBlob(c,'image/png');
  for(const [id,t]of [['p-new',6000],['p-mid',4000],['p-old',1000]])await putMedia({id,createdAt:__base+t,kind:'photo',blob:photo,previewBlob:photo,extension:'png',mimeType:'image/png',meta:id});
  const tone=await fetch('/__fixture/synthetic-tone.webm').then(r=>r.blob());const meta=await fetch('/__fixture/synthetic-tone.json').then(r=>r.json());window.__toneFixture={bytes:tone.size,audioTracks:meta.streams.filter(s=>s.kind==='audio').length};
  await putMedia({id:'v-new',createdAt:__base+5000,kind:'video',blob:tone,previewBlob:tone,mimeType:tone.type,extension:'webm',duration:1400,audio:true,meta:'合成動画・合成音声'});
  const video=await fetch('/__fixture/portrait.mp4').then(r=>r.blob());await putMedia({id:'v-mid',createdAt:__base+3000,kind:'video',blob:video,previewBlob:video,mimeType:video.type,extension:'mp4',duration:2000,meta:'合成縦動画'});
  const pdf=await jpegPagesToPdf([await blobToJpegPage(photo)]);for(const[id,t,origin,meta]of [['derived',3500,'pdf-export','PDF · 1ページ'],['captured-pdf',2500,undefined,'PDF · 360×240']])await putMedia({id,createdAt:__base+t,origin,kind:'photo',blob:pdf,previewBlob:photo,mimeType:'application/pdf',extension:'pdf',meta});
  const bad=new Blob(['broken'],{type:'video/mp4'});await putMedia({id:'v-broken',createdAt:__base+2000,kind:'video',blob:bad,previewBlob:bad,mimeType:bad.type,extension:'mp4',meta:'合成読込失敗'});await refreshGallery();
 })()`);
 check('generated audio fixture contains recorded data',await evaluate('__toneFixture.bytes>1024&&__toneFixture.audioTracks===1'),true);
 await open('v-new');const beforeVideoNavigation=await evaluate('document.querySelector("#reviewPhotoNavigation").hidden');await close();
 await open('p-new');await swipe(-90);await until('!document.querySelector("#reviewPhotoNavigation").hasAttribute("aria-busy")');
 check('photo to video follows mixed history order',await selected(),'v-new');
 check('video also has accessible navigation',beforeVideoNavigation,false);
 check('video does not autoplay on arrival',await evaluate('elements.reviewVideo.paused'),true);
 await until('elements.reviewVideo.readyState>=2');await evaluate('elements.reviewVideo.play()');await until('elements.reviewVideo.currentTime>0.1');
 await swipe(-90);await until('state.selectedMedia.id==="p-mid"');check('playing video to photo is seamless',await selected(),'p-mid');
 check('leaving audio video stops playback and unloads source',await evaluate('elements.reviewVideo.paused&&!elements.reviewVideo.hasAttribute("src")'),true);
 await swipe(90);await until('state.selectedMedia.id==="v-new"');check('reverse swipe crosses kinds',await selected(),'v-new');check('returning video stays paused',await evaluate('elements.reviewVideo.paused'),true);
 await shot('01-mixed-video.png');
 await evaluate('elements.closeReviewButton.focus()');await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight'});await until('state.selectedMedia.id==="p-mid"');
 await until('!document.querySelector("#reviewOlderPhoto").disabled');await evaluate('document.querySelector("#reviewOlderPhoto").click()');await until('state.selectedMedia.id==="v-mid"');check('button crosses kinds and skips derived PDF',await selected(),'v-mid');
 check('navigation describes both media types',await evaluate('document.querySelector("#reviewPhotoNavigation").getAttribute("aria-label").includes("動画")'),true);
 check('navigation controls viewer rather than hidden image only',await evaluate('[...document.querySelectorAll("#reviewPhotoNavigation button")].every(b=>b.getAttribute("aria-controls")==="reviewViewer")'),true);
 await until('elements.reviewVideo.readyState>=2');
 for(const [name,dx,dy,options]of [['controls',70,0,{area:'controls'}],['vertical',0,80,{}],['pinch',60,0,{multi:true}],['cancel',70,0,{cancel:true}]]){await swipe(dx,dy,options);check(name+' does not navigate video',await selected(),'v-mid');}
 await cdp('Emulation.setPageScaleFactor',{pageScaleFactor:2});await sleep(80);await swipe(-60);check('zoomed video pan does not navigate',await selected(),'v-mid');await cdp('Emulation.setPageScaleFactor',{pageScaleFactor:1});await sleep(80);
 await evaluate('elements.reviewVideo.focus()');await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight'});check('video keyboard seeking does not navigate',await selected(),'v-mid');
 await metrics(780,360);await swipe(90);await until('state.selectedMedia.id==="p-mid"');check('landscape video to photo works',await selected(),'p-mid');await shot('02-mixed-landscape.png');await metrics(360,780);
 // Touch the actual Chromium native timeline, not a guessed empty video region.
 await metrics(1000,800);await open('v-new');await until('elements.reviewVideo.readyState>=2');
 await evaluate('elements.reviewVideo.pause();elements.reviewVideo.currentTime=0;window.__nativeSeeks=0;elements.reviewVideo.addEventListener("seeking",()=>__nativeSeeks++)');await until('!elements.reviewVideo.seeking');
 await cdp('DOM.enable');const tree=(await cdp('DOM.getDocument',{depth:-1,pierce:true})).root;
 const descendants=n=>[n,...(n.children||[]).flatMap(descendants),...(n.shadowRoots||[]).flatMap(descendants)];
 const videoNode=descendants(tree).find(n=>n.attributes?.some((v,i,a)=>v==='id'&&a[i+1]==='reviewVideo'));
 const nativeNodes=descendants(videoNode).filter(n=>n.attributes?.some(v=>v.includes('media-controls')));
 fs.writeFileSync(path.join(output,'native-controls.json'),JSON.stringify(nativeNodes.map(n=>({node:n.nodeName,attributes:n.attributes,backend:n.backendNodeId})),null,2));
 const timeline=nativeNodes.find(n=>n.nodeName==='INPUT'&&n.attributes.some(v=>v==='-webkit-media-controls-timeline'));
 check('native timeline is available for real control drag',!!timeline,true);
 const box=(await cdp('DOM.getBoxModel',{backendNodeId:timeline.backendNodeId})).model.border;
 const y=(box[1]+box[5])/2,start=box[0]+(box[2]-box[0])*.25,end=box[0]+(box[2]-box[0])*.7;
 await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:start,y,id:1}]});
 for(let i=1;i<=5;i++){await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start+(end-start)*i/5,y,id:1}]});await sleep(25)}
 await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(180);
 check('native seek control changes playback position',await evaluate('__nativeSeeks>0&&elements.reviewVideo.currentTime>0.2'),true);
 check('native seek drag never changes selected video',await selected(),'v-new');
 await close();await metrics(360,780);
 // Ties follow the same primary-key order across different media kinds.
 await evaluate('(async()=>{const m=await getStoredMedia("v-mid");await putMedia({...m,id:"p-mid-z",createdAt:__base+4000})})()');
 check('mixed timestamp tie follows IDB primary-key order',await evaluate('(async()=>{const ref=await getStoredMedia("v-new"),a=await findAdjacentMedia(ref,"older"),b=await findAdjacentMedia(a,"older");return[a.id,b.id]})()'),['p-mid-z','p-mid']);
 await evaluate('deleteStoredMedia("p-mid-z")');

 await open('v-new');
 await evaluate(`(async()=>{window.__get=getStoredMedia;window.__missingPhoto=await __get('p-mid');getStoredMedia=async id=>{if(id==='p-mid')await deleteStoredMedia(id);return __get(id)};document.querySelector('#reviewOlderPhoto').click()})()`);await sleep(180);
 check('neighbor deleted between lookup and read keeps current video',await selected(),'v-new');
 await evaluate('(async()=>{getStoredMedia=__get;await putMedia(__missingPhoto)})()');
 await until('!document.querySelector("#reviewOlderPhoto").disabled');await evaluate(`getStoredMedia=async()=>{throw new Error('Synthetic detail read failure')};document.querySelector('#reviewOlderPhoto').click()`);await sleep(100);
 check('failed neighbor read keeps viewer usable',await evaluate('elements.reviewDialog.open&&state.selectedMedia.id==="v-new"'),true);
 await evaluate('getStoredMedia=__get');await until('!document.querySelector("#reviewOlderPhoto").disabled');await evaluate('document.querySelector("#reviewOlderPhoto").click()');await until('state.selectedMedia.id==="p-mid"');
 const pdfBefore=await evaluate('(async()=>(await listStoredMediaPage({limit:100})).filter(m=>m.origin==="pdf-export").length)()');
 await evaluate(`window.__jpeg=blobToJpegPage;blobToJpegPage=async b=>{await new Promise(r=>setTimeout(r,180));return __jpeg(b)};document.querySelector('#reviewPdfButton').click();document.querySelector('#reviewOlderPhoto').click()`);
 await until('state.selectedMedia.id==="v-mid"&&document.querySelector("#reviewActionBar").getAttribute("aria-busy")==="false"');
 check('PDF action across photo/video keeps its original photo target',await evaluate(`(async()=>{const all=await listStoredMediaPage({limit:100}),pdfs=all.filter(m=>m.origin==='pdf-export');const result=pdfs.find(m=>m.id!=='derived');return pdfs.length===${pdfBefore+1}&&result?.previewBlob.size===__missingPhoto.blob.size&&document.querySelector('#reviewPdfButton').disabled})()`),true);
 await evaluate('blobToJpegPage=__jpeg');await close();

 await open('v-mid');await swipe(-90);await until('state.selectedMedia.id==="captured-pdf"');check('captured PDF remains in capture sequence',await selected(),'captured-pdf');await swipe(-90);await until('state.selectedMedia.id==="v-broken"');await until('!document.querySelector("#reviewVideoStatus").hidden');await swipe(-90);await until('state.selectedMedia.id==="p-old"');check('failed video remains navigable',await selected(),'p-old');
 await swipe(-90);check('oldest boundary never loops',await selected(),'p-old');await open('p-new');await swipe(90);check('newest boundary never loops',await selected(),'p-new');
 await evaluate(`window.__get=getStoredMedia;getStoredMedia=async id=>{await new Promise(r=>setTimeout(r,200));return __get(id)};document.querySelector('#reviewOlderPhoto').click();elements.reviewDialog.close()`);await sleep(300);check('closed pending navigation never reopens viewer',await evaluate('[elements.reviewDialog.open,state.selectedMedia]'),[false,null]);await evaluate('getStoredMedia=__get');
 await open('v-new');await evaluate(`(async()=>{getStoredMedia=async id=>{await new Promise(r=>setTimeout(r,200));return __get(id)};document.querySelector('#reviewOlderPhoto').click();selectMedia(await __get('p-old'))})()`);await sleep(300);check('stale video navigation cannot overwrite new selection',await selected(),'p-old');await evaluate('getStoredMedia=__get');await close();
 await open('v-new');await until('elements.reviewVideo.readyState>=2');await evaluate('elements.shareButton.click();elements.downloadButton.click()');check('video share and save target current item',await evaluate('[__audit.shares.at(-1)[0].size,__audit.downloads.at(-1).size]'),await evaluate('[state.selectedMedia.blob.size,state.selectedMedia.blob.size]'));check('video PDF action remains disabled',await evaluate('document.querySelector("#reviewPdfButton").disabled'),true);
 await evaluate('elements.deleteButton.click()');await until('!elements.reviewDialog.open&&!state.selectedMedia');check('video deletion preserves close behavior',await evaluate('(async()=>!await getStoredMedia("v-new"))()'),true);await open('p-new');await swipe(-90);await until('state.selectedMedia.id==="p-mid"');check('navigation refreshes after deleting video',await selected(),'p-mid');await close();
 const beforeUrls=await evaluate('__audit.urls.size');for(let i=0;i<5;i++){await open('v-mid');await until('!!elements.reviewVideo.poster');await swipe(90);await until('state.selectedMedia.id==="p-mid"');await close()}await sleep(100);check('mixed transitions release viewer URLs',await evaluate('__audit.urls.size'),beforeUrls);
 await evaluate('(async()=>{for(const m of await listStoredMediaPage({limit:100}))if(m.id!=="v-mid")await deleteStoredMedia(m.id);await refreshGallery()})()');await open('v-mid');await until('document.querySelector("#reviewNewerPhoto").disabled&&document.querySelector("#reviewOlderPhoto").disabled');await swipe(-80);check('single video is stable',await selected(),'v-mid');await close();await evaluate('(async()=>{await deleteStoredMedia("v-mid");await refreshGallery()})()');check('empty history hides navigation',await evaluate('[state.selectedMedia,document.querySelector("#reviewPhotoNavigation").hidden]'),[null,true]);
 audit=await evaluate('({mediaCalls:__audit.mediaCalls,created:__audit.created,revoked:__audit.revoked,active:__audit.urls.size})');check('no camera or microphone access',audit.mediaCalls,0);check('no leaked object URLs',audit.active,0);check('no uncaught errors',exceptions.length,0);
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:true,checks:results.length,results,audit,exceptions,swipeTimings:await evaluate('__swipeTimings'),profile:scratch,origin:url,syntheticAudioVideo:true,realDeviceUsed:false},null,2));console.log(JSON.stringify({passed:true,checks:results.length,audit,output}));

}catch(error){
 await shot('failure.png').catch(()=>{});
 const stateAtFailure=await evaluate('({selectedId:state.selectedMedia?.id,dialogOpen:elements.reviewDialog.open,videoStatus:document.querySelector("#reviewVideoStatus").textContent,trace:window.__pointerLog,swipeTimings:window.__swipeTimings,scale:visualViewport?.scale,seeking:elements.reviewVideo.seeking,videoReady:elements.reviewVideo.readyState,videoError:elements.reviewVideo.error?.message,poster:!!elements.reviewVideo.poster,thumbnailCount:document.querySelectorAll(".video-thumbnail img").length})').catch(()=>null);
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:String(error.stack),results,exceptions,stateAtFailure,audit:await evaluate('({mediaCalls:__audit.mediaCalls,mediaStacks:__audit.mediaStacks})').catch(()=>null)},null,2));
 throw error;
}
} catch(error) {
 fs.writeFileSync(path.join(output,'harness-failure.json'),JSON.stringify({passed:false,error:error.stack},null,2));console.error(error);process.exitCode=1;
} finally {
 await cleanupBrowserTest({scratch,chrome,socket,command:cleanupCommand,server,output,pending});
}
