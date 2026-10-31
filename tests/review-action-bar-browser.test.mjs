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
const output=process.env.QUIET_CAMERA_DETAIL_TEST_OUTPUT||path.resolve(root,'test-results/detail-actions');
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
 // Selection clears aria-busy before the next animation frame starts the lookup.
 // Wait for its rendered status, not just the absence of aria-busy.
 await until('!document.querySelector("#reviewPhotoNavigation").hidden && !document.querySelector("#reviewPhotoNavigation").hasAttribute("aria-busy") && !!document.querySelector("#reviewPhotoStatus").textContent');
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
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`window.__audit={mediaCalls:0,shares:[],downloads:[]};Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{__audit.mediaCalls++;throw new Error('Camera forbidden')},enumerateDevices:async()=>[],getSupportedConstraints:()=>({}),addEventListener(){}}});Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});Object.defineProperty(navigator,'share',{configurable:true,value:async d=>{__audit.shares.push(d.files);if(window.__shareError)throw new DOMException('Synthetic cancellation',__shareError)}});Object.defineProperty(navigator,'canShare',{value:()=>!window.__unsupported});window.confirm=()=>window.__confirm!==false;`});
 await cdp('Page.navigate',{url});await until('typeof putMedia==="function"&&typeof exportCurrentPhotoToPdf==="function"');
 await evaluate(`(async()=>{triggerDownload=(blob,name)=>__audit.downloads.push({blob,name});for(let i=0;i<4;i++){const c=document.createElement('canvas');c.width=320;c.height=240;const x=c.getContext('2d');x.fillStyle=['red','green','blue','purple'][i];x.fillRect(0,0,320,240);x.fillStyle='white';x.font='25px sans-serif';x.fillText('SAMPLE '+i,20,120);const blob=await canvasToBlob(c,'image/png',1);await putMedia({id:'p'+i,kind:'photo',createdAt:1700000000000+i*1000,blob,previewBlob:blob,extension:'png',mimeType:'image/png',meta:'SAMPLE '+i})}const blob=await fetch('/__fixture/portrait.mp4').then(r=>r.blob());await putMedia({id:'v1',kind:'video',createdAt:1700000010000,blob,previewBlob:blob,extension:'mp4',mimeType:'video/mp4',meta:'SYNTHETIC VIDEO'});const p=await getStoredMedia('p0');await putMedia({...p,id:'existing-pdf',createdAt:1700000011000,blob:new Blob(['%PDF-synthetic'],{type:'application/pdf'}),extension:'pdf',mimeType:'application/pdf'});await refreshGallery();state.selectedGalleryIds.add('p0');state.selectedGalleryIds.add('p1')})()`);
 const busyDone=()=>until('document.querySelector("#reviewActionBar").getAttribute("aria-busy")==="false"');
 const pdfCount=()=>evaluate('(async()=>(await listStoredMedia()).filter(x=>x.extension==="pdf").length)()');
 const matchBlob=(expr,id)=>evaluate(`(async()=>{const a=new Uint8Array(await (${expr}).arrayBuffer()),b=new Uint8Array(await (await getStoredMedia('${id}')).blob.arrayBuffer());return a.length===b.length&&a.every((v,i)=>v===b[i])})()`);
 await open('p3');
 check('single consolidated action set',await evaluate('(()=>{const a=document.querySelector("#reviewActionBar");return a.querySelectorAll("button").length===4&&!document.querySelector(".review-sidebar .review-actions")&&["shareButton","downloadButton","deleteButton","reviewPdfButton"].every(id=>document.querySelectorAll("#"+id).length===1&&a.contains(document.getElementById(id)))})()'),true);
 check('single item has visible PDF label',await evaluate('document.querySelector("#reviewPdfButton svg text").textContent'),'PDF');
 await evaluate('elements.shareButton.click()');await until('__audit.shares.length===1');check('share uses only current photo',await evaluate('__audit.shares.at(-1).length'),1);check('share file is p3',await matchBlob('__audit.shares.at(-1)[0]','p3'),true);
 await evaluate('elements.downloadButton.click()');check('download is current photo',await matchBlob('__audit.downloads.at(-1).blob','p3'),true);
 await evaluate('window.__shareError="AbortError";elements.shareButton.click()');await sleep(60);check('share cancel retains viewer and gallery selections',await evaluate('[state.selectedMedia.id,elements.reviewDialog.open,[...state.selectedGalleryIds].sort()]'),['p3',true,['p0','p1']]);await evaluate('window.__shareError=null');
 await swipe(-120);await until('state.selectedMedia.id==="p2"');await evaluate('elements.shareButton.click();elements.downloadButton.click()');await sleep(40);check('share follows swipe to current photo',await matchBlob('__audit.shares.at(-1)[0]','p2'),true);check('download follows swipe to current photo',await matchBlob('__audit.downloads.at(-1).blob','p2'),true);
 const before=await pdfCount();await evaluate('document.querySelector("#reviewPdfButton").click()');await busyDone();check('single photo produces exactly one PDF',await pdfCount(),before+1);check('PDF is one page of current photo, never gallery selection',await evaluate('(async()=>{const p=(await listStoredMedia()).filter(x=>x.extension==="pdf"&&x.id!=="existing-pdf")[0],a=new Uint8Array(await p.previewBlob.arrayBuffer()),b=new Uint8Array(await (await getStoredMedia("p2")).blob.arrayBuffer());return p.meta.includes("1ページ")&&a.length===b.length&&a.every((v,i)=>v===b[i])&&new TextDecoder().decode((await p.blob.arrayBuffer()).slice(0,8)).startsWith("%PDF-")&&state.selectedMedia.id==="p2"})()'),true);check('PDF keeps multi selection untouched',await evaluate('[...state.selectedGalleryIds].sort()'),['p0','p1']);
 await evaluate('window.__originalJpeg=blobToJpegPage;blobToJpegPage=async()=>{throw new Error("Synthetic decode failure")};document.querySelector("#reviewPdfButton").click()');await busyDone();check('failed PDF produces no partial item',await pdfCount(),before+1);await evaluate('blobToJpegPage=__originalJpeg');
 await evaluate('window.__originalAdd=addMedia;addMedia=async()=>{throw new DOMException("Synthetic quota","QuotaExceededError")};document.querySelector("#reviewPdfButton").click()');await busyDone();check('quota failure preserves current photo',await selected(),'p2');check('quota failure leaves PDF count',await pdfCount(),before+1);await evaluate('addMedia=__originalAdd');
 await evaluate('blobToJpegPage=async b=>{await new Promise(r=>setTimeout(r,160));return __originalJpeg(b)};document.querySelector("#reviewPdfButton").click();document.querySelector("#reviewOlderPhoto").click()');await until('state.selectedMedia.id==="p1"');await busyDone();check('navigation during PDF retains captured item target',await evaluate('(async()=>{const p=(await listStoredMedia()).filter(x=>x.extension==="pdf"&&x.id!=="existing-pdf").sort((a,b)=>b.createdAt-a.createdAt)[0];const a=new Uint8Array(await p.previewBlob.arrayBuffer()),b=new Uint8Array(await (await getStoredMedia("p2")).blob.arrayBuffer());return a.length===b.length&&a.every((v,i)=>v===b[i])&&state.selectedMedia.id==="p1"})()'),true);
 const beforeCancel=await pdfCount();await evaluate('document.querySelector("#reviewPdfButton").click()');await sleep(20);await close();await sleep(220);check('closing during PDF decode cancels unwritten output',await pdfCount(),beforeCancel);await evaluate('blobToJpegPage=__originalJpeg');
 await open('v1');check('video PDF is visibly disabled',await evaluate('document.querySelector("#reviewPdfButton").disabled'),true);await evaluate('document.querySelector("#reviewPdfButton").click();elements.downloadButton.click()');await sleep(40);check('video cannot invoke PDF conversion',await pdfCount(),beforeCancel);check('video download remains original type',await evaluate('__audit.downloads.at(-1).blob.type'),'video/mp4');
 await open('existing-pdf');check('existing PDF cannot be converted as photo',await evaluate('document.querySelector("#reviewPdfButton").disabled'),true);
 await open('p2');await evaluate('window.__confirm=false;elements.deleteButton.click()');await sleep(40);check('delete cancel preserves current and other photos',await evaluate('(async()=>[!!await getStoredMedia("p2"),!!await getStoredMedia("p0"),state.selectedMedia.id,elements.reviewDialog.open])()'),[true,true,'p2',true]);
 await evaluate('window.__confirm=true;window.__originalDelete=deleteStoredMedia;deleteStoredMedia=async()=>{throw new Error("Synthetic delete failure")};elements.deleteButton.click()');await busyDone();check('delete failure retains open current item',await selected(),'p2');await evaluate('deleteStoredMedia=__originalDelete;elements.deleteButton.click()');await until('!elements.reviewDialog.open');await busyDone();check('delete removes only current, not multi selection',await evaluate('(async()=>[!!await getStoredMedia("p2"),!!await getStoredMedia("p0"),!!await getStoredMedia("p1"),[...state.selectedGalleryIds].sort()])()'),[false,true,true,['p0','p1']]);
 // Navigation wins: hold deletion until the next selection is actually displayed.
 await open('p3');
 await evaluate('(async()=>{window.__p3ForRace=await getStoredMedia("p3");deleteStoredMedia=async id=>{await new Promise(r=>window.__releaseDelete=r);return __originalDelete(id)};elements.deleteButton.click()})()');
 await until('typeof window.__releaseDelete === "function"');
 await until('!document.querySelector("#reviewOlderPhoto").disabled');
 await evaluate('document.querySelector("#reviewOlderPhoto").click()');
 await until('state.selectedMedia?.id === "p1"');
 await evaluate('__releaseDelete();true');await busyDone();
 check('navigation during delete preserves new current photo',await evaluate('(async()=>[!!await getStoredMedia("p3"),!!await getStoredMedia("p1"),state.selectedMedia?.id,elements.reviewDialog.open])()'),[false,true,'p1',true]);
 await evaluate('deleteStoredMedia=__originalDelete');
 // Deletion wins: a slow neighboring read must never reopen a closed viewer.
 await close();await evaluate('putMedia(__p3ForRace)');await open('p3');
 await evaluate('window.__originalGet=getStoredMedia;window.__navigationReadReturned=false;getStoredMedia=async id=>{if(id==="p1"){await new Promise(r=>window.__releaseNavigationRead=r);const m=await __originalGet(id);window.__navigationReadReturned=true;return m}return __originalGet(id)};document.querySelector("#reviewOlderPhoto").click()');
 await until('typeof window.__releaseNavigationRead === "function"');
 await evaluate('elements.deleteButton.click()');
 await until('!elements.reviewDialog.open && !state.selectedMedia');await busyDone();
 await evaluate('__releaseNavigationRead();true');await until('window.__navigationReadReturned');
 check('delete before pending navigation cannot reopen viewer',await evaluate('[elements.reviewDialog.open,state.selectedMedia]'),[false,null]);
 await evaluate('getStoredMedia=__originalGet');
 check('both delete orders preserve neighboring photo',await evaluate('(async()=>[!!await getStoredMedia("p3"),!!await getStoredMedia("p1")])()'),[false,true]);
 await open('p1');
 for(const [w,h,q,font]of[[393,800,0,16],[320,480,0,16],[800,393,1,16],[800,393,3,16],[641,274,1,32],[641,274,3,32],[393,800,0,32]]){
  await cdp('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:true,screenWidth:w,screenHeight:h,screenOrientation:{type:q===3?'landscapeSecondary':q===1?'landscapePrimary':'portraitPrimary',angle:q*90}});await evaluate(`document.documentElement.style.fontSize='${font}px';document.querySelector('.review-layout').scrollTop=0`);await sleep(80);
  const key=[w,h,q,font].join('-');const getBar=()=>evaluate('(()=>{const a=document.querySelector("#reviewActionBar"),r=a.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}})()');const bar=await getBar();
  check('current-item bar and targets fit visible viewport '+key,await evaluate(`(()=>{const a=document.querySelector('#reviewActionBar'),r=a.getBoundingClientRect(),b=[...a.querySelectorAll('button')].map(e=>({r:e.getBoundingClientRect(),label:e.getAttribute('aria-label')}));return r.top>=0&&r.bottom<=innerHeight+.5&&b.every(({r,label})=>r.width>=44&&r.height>=44&&label&&r.right<=innerWidth)&&b.every((v,i)=>!i||b[i-1].r.right<=v.r.left)&&document.body.style.position==='fixed'})()`),true);
  await evaluate('document.querySelector(".review-layout").scrollTop=1e9');check('content scroll leaves action bar fixed '+key,await getBar(),bar);check('image keeps aspect fit '+key,await evaluate('getComputedStyle(elements.reviewImage).objectFit'),'contain');if(w===393||q===1&&font===32)await shot('review-actions-'+key+'.png');
 }
 await close();await metrics(393,800);await evaluate('document.documentElement.style.fontSize="16px";QuietCameraEnhancements.enhancedOpenGallery()');await until('elements.galleryDialog.open&&!elements.galleryDialog.classList.contains("is-settling")');check('returning to history reflects single deletions',await evaluate('!document.querySelector("[data-id=p2]")&&!document.querySelector("[data-id=p3]")&&!!document.querySelector("[data-id=p0]")&&!!document.querySelector("[data-id=p1]")'),true);await evaluate('elements.closeGalleryButton.click()');await sleep(60);check('final close restores body state',await evaluate('document.body.style.position'),'');
 audit=await evaluate('({mediaCalls:__audit.mediaCalls,shareCalls:__audit.shares.length,downloadCalls:__audit.downloads.length})');check('no real camera or microphone request',audit.mediaCalls,0);check('no unhandled exception',exceptions.length,0);
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:true,checks:results,audit,version:await evaluate('elements.versionBadge.textContent'),limits:['Fresh generated-data database, native share/download/confirm stubbed; no S25 browser/camera/private history used']},null,2));console.log(JSON.stringify({passed:true,checks:results.length,output}));
}catch(error){await shot('failure.png').catch(()=>{});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:error.stack,checks:results,exceptions},null,2));console.error(error);process.exitCode=1;}
} catch(error) {
 fs.writeFileSync(path.join(output,'harness-failure.json'),JSON.stringify({passed:false,error:error.stack},null,2));console.error(error);process.exitCode=1;
} finally {
 await cleanupBrowserTest({scratch,chrome,socket,command:cleanupCommand,server,output,pending});
}
