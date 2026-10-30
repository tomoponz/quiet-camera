// Actual MediaRecorder with canvas-only input, plus explicit fake-recorder
// fault injection. Fresh profile/origin/database; no existing browser/USB use.
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import http from 'node:http';import {spawn} from 'node:child_process';import {once} from 'node:events';
const root=process.env.QC_CONTINUOUS_CAPTURE_ROOT||path.resolve(import.meta.dirname,'..');
const output=process.env.QC_CONTINUOUS_CAPTURE_OUTPUT||path.join(root,'test-results/continuous-capture-browser');
fs.mkdirSync(output,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'quiet-camera-p1p5-isolated-'));
const results=[],details={},targets=[],contexts=[],pages=[],exceptions=[],mediaAuditSnapshots=[];let socket,chrome,server,seq=0;const pending=new Map();let checks=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function save(){fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({root,profile,origin:details.origin,checks,results,details,exceptions,audit:{nativeMediaCalls:mediaAuditSnapshots.reduce((s,n)=>s+n,0)},permissionChanges:0,existingTrialOrUsbChanges:false},null,2))}
function check(name,a,b=true){checks++;assert.deepEqual(a,b,name)}
async function test(name,fn){
 if(process.env.QC_CONTINUOUS_CAPTURE_FILTER&&!new RegExp(process.env.QC_CONTINUOUS_CAPTURE_FILTER).test(name))return;
 const started=Date.now(),contextStart=contexts.length,pageStart=pages.length;
 try{await fn();for(const p of pages.slice(pageStart))check('physical camera/microphone never requested',await p.eval('__recordingAudit.physicalMediaCalls'),0);results.push({name,status:'passed',ms:Date.now()-started})}
 catch(e){results.push({name,status:'failed',ms:Date.now()-started,error:e.stack});console.error(name+': '+e.message);for(const p of pages.slice(pageStart)){try{const d=await p.eval('(async()=>({sessions:await listRecordingSessions(),toasts:__toasts,chunks:await Promise.all((await listRecordingSessions()).map(async s=>({id:s.id,chunks:(await getRecordingChunks(s.id)).map(b=>({size:b.size,type:b.type})),structure:await inspectMp4MediaData(new Blob(await getRecordingChunks(s.id),{type:s.mimeType}))}))),visibility:document.visibilityState}))()');(details.failureDiagnostics??=[]).push({test:name,...d})}catch{}}}
 finally{for(const p of pages.slice(pageStart)){try{mediaAuditSnapshots.push(await p.eval('__recordingAudit.physicalMediaCalls'))}catch{}}for(const id of contexts.slice(contextStart))await command('Target.disposeBrowserContext',{browserContextId:id}).catch(()=>{});}
 save();console.log(JSON.stringify(results.at(-1)))
}
function command(method,params={},session,timeout=25000){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},timeout);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(session?{sessionId:session}:{})}))})}
function page(session){return {session,cdp:(m,p)=>command(m,p,session),eval:async(expression,timeout=25000)=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},session,timeout);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}}}
async function until(p,expression,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const v=await p.eval(expression);if(v)return v;await sleep(40)}throw Error('timeout: '+expression)}
const init=`
window.__recordingAudit={physicalMediaCalls:0};const legacy=new URL(location.href).searchParams.get('legacy');if(legacy)localStorage.setItem('quiet-camera-settings-v3',JSON.stringify({autoReview:legacy}));
Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{__recordingAudit.physicalMediaCalls++;throw Error('Physical media prohibited')},enumerateDevices:async()=>[],getSupportedConstraints:()=>({}),addEventListener(){}}});
Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});
window.__toasts=[];window.confirm=()=>true;window.__shares=[];Object.defineProperty(navigator,'share',{configurable:true,value:async d=>__shares.push(d.files.length)});Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});
`;
async function context(){const x=await command('Target.createBrowserContext');contexts.push(x.browserContextId);return x.browserContextId}
async function open(ctx,route='/'){
 const {targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId:ctx});targets.push(targetId);
 const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});const p=page(sessionId);p.target=targetId;pages.push(p);
 await p.cdp('Page.enable',{});await p.cdp('Runtime.enable',{});await p.cdp('Page.addScriptToEvaluateOnNewDocument',{source:init});
 await p.cdp('Page.navigate',{url:details.origin+route});await until(p,'typeof recoverInterruptedRecordings==="function" && typeof state!=="undefined" && typeof refreshGallery==="function"');await sleep(150);
 await p.eval(`window.__originalToast=showToast;showToast=m=>{__toasts.push(m);__originalToast(m)};window.__setupSynthetic=()=>{const c=document.createElement('canvas');c.width=640;c.height=360;const x=c.getContext('2d');let n=0;window.__syntheticTimer=setInterval(()=>{x.fillStyle='hsl('+(n++*7%360)+' 70% 30%)';x.fillRect(0,0,640,360);x.fillStyle='white';x.font='30px sans-serif';x.fillText('SYNTHETIC RECORDING '+n,30,180)},33);state.stream=c.captureStream(30);state.videoTrack=state.stream.getVideoTracks()[0];state.mode='video';state.timerSeconds=0;elements.videoQualitySelect.value='standard';};`);
 return p;
}
async function finish(p){await p.eval('stopRecording()');await until(p,'!state.recordingFinalizing && !state.recordingSessionId && (!state.recorder || state.recorder.state==="inactive")',30000)}

try{
 server=http.createServer((req,res)=>{let pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname),scaled=false;
  if(pathname.startsWith('/scaled/')){scaled=true;pathname=pathname.slice(7)}
  const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return}
  try{let b=fs.readFileSync(file);if(scaled&&path.basename(file)==='video.js'){
    let t=b.toString();for(const [from,to] of [['targetBytes: 512 * 1024 * 1024','targetBytes: 4 * 1024 * 1024'],['minimumBytes: 20 * 1024 * 1024','minimumBytes: 128 * 1024'],['finalizationReserveBytes: 32 * 1024 * 1024','finalizationReserveBytes: 256 * 1024'],['delayedOutputAllowanceBytes: 64 * 1024 * 1024','delayedOutputAllowanceBytes: 512 * 1024']]){if(!t.includes(from))throw Error('scaled anchor missing');t=t.replace(from,to)}b=Buffer.from(t)}
   res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.mp4':'video/mp4','.webm':'video/webm','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','Permissions-Policy':'camera=(), microphone=()'});res.end(b);
  }catch(e){res.writeHead(404).end(String(e.message))}
 });server.listen(0,'127.0.0.1');await once(server,'listening');details.origin=`http://127.0.0.1:${server.address().port}`;
 chrome=spawn(process.env.CHROME_PATH||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'google-chrome'),[...(process.env.QC_PC_HEADED==='1'?[]:['--headless=new']),'--remote-debugging-port=0',`--user-data-dir=${profile}`,'--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required','--mute-audio','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 let stderr='';const endpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Isolated Chrome startup timeout: '+stderr)),20000);chrome.stderr.on('data',d=>{stderr+=d;const m=stderr.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1])}});chrome.on('error',reject)});
 socket=new WebSocket(endpoint);await once(socket,'open');socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);if(!pending.has(m.id))return;const x=pending.get(m.id);pending.delete(m.id);clearTimeout(x.timer);m.error?x.reject(Error(JSON.stringify(m.error))):x.resolve(m.result)});
 details.browser=await command('Browser.getVersion');
 async function live(p,mode='photo'){
  await p.eval(`(async()=>{for(const d of document.querySelectorAll('dialog[open]'))d.close();__setupSynthetic();state.mode='${mode}';state.busy=false;elements.video.srcObject=state.stream;await elements.video.play();elements.permissionPanel.hidden=true;elements.cameraStatus.textContent="640×360 合成入力";updateModeUi();elements.shutterButton.disabled=false;window.__liveStream=state.stream;window.__autoOpens=[];for(const key of ['reviewDialog','galleryDialog']){const d=elements[key],show=d.showModal.bind(d);d.showModal=()=>{__autoOpens.push(key);return show()}}})()`);
  await until(p,'elements.video.readyState>=2 && elements.video.videoWidth>0');
 }
 async function unchanged(p){
  check('no automatic result/history modal',await p.eval('__autoOpens'),[]);
  check('live view and stream retained',await p.eval('elements.permissionPanel.hidden && elements.video.readyState>=2 && !elements.video.paused && state.stream===__liveStream && elements.video.srcObject===__liveStream && state.stream.getVideoTracks().every(t=>t.readyState==="live")'));
  check('no selected playback media',await p.eval('state.selectedMedia'),null);
  check('capture ready after save',await p.eval('!state.busy&&!state.recordingFinalizing&&!elements.shutterButton.disabled'));
 }
 for(const preference of ['fresh','always','brief','never'])await test('continuous photo '+preference,async()=>{
  const p=await open(await context(),preference==='fresh'?'/':'/?legacy='+preference);await live(p);
  await p.eval('elements.shutterButton.click()');await until(p,'!state.busy');
  check('first photo durably stored',await p.eval('countStoredMedia()'),1);await unchanged(p);
  await p.eval('elements.shutterButton.click()');await until(p,'!state.busy');
  check('second photo durably stored',await p.eval('countStoredMedia()'),2);await unchanged(p);
  check('photo completion notification',await p.eval('__toasts.some(x=>x.includes("写真を保存しました"))'));
  check('retired automatic review option not offered',await p.eval('!document.querySelector("#autoReviewField")'));
  check('legacy preference cannot be resaved as automatic',await p.eval('collectSettings().autoReview!=="always"&&collectSettings().autoReview!=="brief"'));
  if(preference==='fresh')fs.writeFileSync(path.join(output,'photo-stays-live.png'),Buffer.from((await p.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await p.eval('openGallery()');await until(p,'elements.galleryDialog.open&&!elements.galleryDialog.classList.contains("is-settling")');
  await p.eval('elements.galleryGrid.querySelector(".gallery-open").click()');await until(p,'elements.reviewDialog.open&&elements.reviewImage.complete&&elements.reviewImage.naturalWidth>0');
  check('manual thumbnail opens saved photo',await p.eval('state.selectedMedia.kind'),'photo');

 });
 await test('continuous photo waits for storage and recovers after quota error',async()=>{
  const p=await open(await context());await live(p);
  await p.eval(`window.__put=putMedia;putMedia=async m=>{window.__waiting=true;await new Promise(r=>window.__resume=r);return __put(m)};capturePhoto();true`);await until(p,'window.__waiting');
  check('photo busy and controls blocked while saving',await p.eval('state.busy&&elements.shutterButton.disabled&&elements.galleryButton.disabled'));
  await p.eval('capturePhoto()');check('no duplicate queued capture',await p.eval('countStoredMedia()'),0);
  await p.eval('__resume();true');await until(p,'!state.busy');check('one persisted after pending save',await p.eval('countStoredMedia()'),1);await unchanged(p);
  await p.eval(`putMedia=async()=>{throw new DOMException('synthetic photo quota','QuotaExceededError')};capturePhoto();true`);await until(p,'!state.busy');
  check('photo failure visible',await p.eval('__toasts.some(x=>x.includes("synthetic photo quota"))'));check('failed photo did not overwrite history',await p.eval('countStoredMedia()'),1);await unchanged(p);
  await p.eval('putMedia=__put;capturePhoto();true');await until(p,'!state.busy');check('next photo succeeds after error',await p.eval('countStoredMedia()'),2);await unchanged(p);
 });
 async function record(p){await p.eval('elements.shutterButton.click()');await until(p,'state.recorder?.state==="recording"');await sleep(1700);}
 await test('continuous sequential video and manual playback',async()=>{
  const p=await open(await context(),'/?legacy=always');await live(p,'video');
  for(let i=1;i<=2;i++){
   await record(p);await finish(p);await until(p,'!state.recordingLockRelease');
   check('completed video count '+i,await p.eval('countStoredMedia()'),i);await unchanged(p);
  }
  check('video completion notification',await p.eval('__toasts.filter(x=>x.includes("動画を保存しました")).length'),2);
  const media=await p.eval('(async()=>(await listStoredMedia()).map(m=>({kind:m.kind,size:m.blob.size,width:m.width,height:m.height})))()');details.savedVideos=media;
  check('real synthetic recordings have decodable payload',media.every(m=>m.kind==='video'&&m.size>1024&&m.width===640&&m.height===360));
  fs.writeFileSync(path.join(output,'video-stays-live.png'),Buffer.from((await p.cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await p.eval('openGallery()');await until(p,'elements.galleryDialog.open&&!elements.galleryDialog.classList.contains("is-settling")');await p.eval('elements.galleryGrid.querySelector(".gallery-open").click()');await until(p,'elements.reviewDialog.open&&elements.reviewVideo.readyState>=2');
  check('manual thumbnail opens video',await p.eval('state.selectedMedia.kind'),'video');
  await p.eval('elements.reviewVideo.play()');await until(p,'elements.reviewVideo.currentTime>0');check('manual video playback advances',await p.eval('!elements.reviewVideo.paused'));
 });
 await test('continuous video final commit gating and recovery',async()=>{
  const p=await open(await context());await live(p,'video');
  await p.eval(`window.__commit=commitRecordingMedia;commitRecordingMedia=async(...args)=>{window.__waiting=true;await new Promise(r=>window.__resume=r);return __commit(...args)}`);
  await record(p);await p.eval('stopRecording()');await until(p,'window.__waiting');
  const session=await p.eval('state.recordingSessionId');
  check('finalization blocks new capture',await p.eval('state.recordingFinalizing&&elements.shutterButton.disabled&&elements.galleryButton.disabled'));
  await p.eval('handleShutter()');check('blocked shutter kept original session',await p.eval('state.recordingSessionId'),session);check('no premature media commit',await p.eval('countStoredMedia()'),0);
  await p.eval('__resume();true');await until(p,'!state.recordingFinalizing&&!state.recordingLockRelease');check('delayed final commit persisted',await p.eval('countStoredMedia()'),1);await unchanged(p);
  await p.eval(`commitRecordingMedia=async()=>{throw new DOMException('synthetic video quota','QuotaExceededError')}`);
  await record(p);await finish(p);await until(p,'!state.recordingLockRelease');
  check('failed finalization visible',await p.eval('__toasts.some(x=>x.includes("synthetic video quota"))'));check('failed video not committed',await p.eval('countStoredMedia()'),1);
  check('recoverable final chunks retained',await p.eval('(async()=>{const s=await listRecordingSessions();return s.length===1&&(await getRecordingChunks(s[0].id)).reduce((n,b)=>n+b.size,0)>1024})()'));await unchanged(p);
  await p.eval('commitRecordingMedia=__commit;recoverInterruptedRecordings({force:true})');check('recovery persisted without opening viewer',await p.eval('countStoredMedia()'),2);check('recovered session cleaned after commit',await p.eval('(async()=>(await listRecordingSessions()).length)()'),0);await unchanged(p);
  await record(p);await finish(p);await until(p,'!state.recordingLockRelease');check('next recording still works after recovery',await p.eval('countStoredMedia()'),3);await unchanged(p);
 });

}catch(e){details.fatal=e.stack;console.error(e);process.exitCode=1}
finally{
 if(socket?.readyState===WebSocket.OPEN){for(const id of contexts)await command('Target.disposeBrowserContext',{browserContextId:id}).catch(()=>{});await command('Browser.close',{},undefined,3000).catch(()=>{});socket.close()}
 if(chrome&&!chrome.killed)chrome.kill();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));details.cleanup={temporaryServerClosed:true,temporaryBrowserCloseRequested:true,existingTrialOrUsbChanged:false};save();
}
console.log(JSON.stringify({checks,passed:results.filter(x=>x.status==='passed').length,failed:results.filter(x=>x.status==='failed').length,output}));if(results.some(x=>x.status==='failed'))process.exitCode=1;
