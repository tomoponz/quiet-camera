// Isolated fault injection and generated stills only. No physical media or user profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createOwnedScratch, cleanupBrowserTest} from './browser-cleanup.mjs';

const root=path.resolve(process.env.QC_GALLERY_RESILIENCE_ROOT||path.resolve(import.meta.dirname,'..'));
const output=process.env.QC_GALLERY_RESILIENCE_OUTPUT||path.join(root,'test-results/gallery-resilience');
fs.mkdirSync(output,{recursive:true});
const scratch=createOwnedScratch('quiet-camera-gallery-resilience-');
const checks=[],results=[],details={},exceptions=[],audits=[],contexts=[],pages=[];
let chrome,socket,server,sequence=0;const pending=new Map();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(name,actual,expected=true){assert.deepEqual(actual,expected,name);checks.push({name,passed:true});}
function command(method,params={},session=null,timeout=25000){return new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},timeout);
  pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(session?{sessionId:session}:{})}));
});}
function page(session){const p={session,cdp:(m,p)=>command(m,p,session),eval:async expression=>{
  const r=await command('Runtime.evaluate',{expression:'(async()=>('+expression+'))()',awaitPromise:true,returnByValue:true,userGesture:true},session);
  if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;
}};p.run=source=>p.eval('(async()=>{'+source+'})()');return p;}
async function until(p,expression,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await p.eval(expression))return;await sleep(40);}throw Error('Timed out: '+expression);}
async function test(name,task){const contextStart=contexts.length,pageStart=pages.length;try{await task();results.push({name,passed:true});}
  catch(error){results.push({name,passed:false,error:error.stack});console.error(name+': '+error.message);}
  finally{for(const p of pages.slice(pageStart)){try{audits.push(await p.eval('__resilienceAudit.nativeMediaCalls'));}catch{audits.push(null);}}
    for(const id of contexts.slice(contextStart))await command('Target.disposeBrowserContext',{browserContextId:id}).catch(()=>{});}
}
const init=`window.__resilienceAudit={nativeMediaCalls:0};window.__deferStartup=true;
Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{__resilienceAudit.nativeMediaCalls++;throw Error('Physical media prohibited')},enumerateDevices:async()=>[],getSupportedConstraints:()=>({}),addEventListener(){}}});
Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});
window.confirm=()=>true;window.__shares=[];Object.defineProperty(navigator,'share',{value:async data=>__shares.push(data.files.map(f=>({name:f.name,size:f.size})))});Object.defineProperty(navigator,'canShare',{value:()=>true});`;
async function open(){const {browserContextId}=await command('Target.createBrowserContext');contexts.push(browserContextId);
  const {targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});
  const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});const p=page(sessionId);pages.push(p);
  await p.cdp('Page.enable');await p.cdp('Runtime.enable');await p.cdp('Page.addScriptToEvaluateOnNewDocument',{source:init});
  await p.cdp('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await p.cdp('Page.navigate',{url:details.origin+'/'});
  await until(p,'document.readyState==="complete" && typeof state!=="undefined" && typeof __startApplicationForTest==="function"');
  await p.run(`window.__toasts=[];window.__downloads=[];window.__flashCount=0;window.__toast=showToast;showToast=message=>{__toasts.push(message);__toast(message)};triggerDownload=(blob,name)=>__downloads.push({size:blob.size,name});flash=()=>{__flashCount++};
    window.__photoBlob=async(w=96,h=64)=>{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.fillStyle='#275f9e';x.fillRect(0,0,w,h);x.fillStyle='#ffd040';x.fillRect(0,0,w/4,h);return canvasToBlob(c,'image/jpeg',.92)};
    window.__seedPhoto=async(id,time)=>{const blob=await __photoBlob();await putMedia({id,createdAt:time,kind:'photo',blob,previewBlob:blob,thumbnailBlob:blob,extension:'jpg',mimeType:'image/jpeg',width:96,height:64,meta:'GENERATED '+id})};
    window.__seedBad=async()=>{await putRecordingChunk('damaged-owner',0,new Blob(['retained chunk'],{type:'video/webm'}));await putMedia({id:'damaged',createdAt:1800000000000,kind:'video',backingRecordingId:'damaged-owner',backingSizeBytes:9999,backingChunkCount:2,mimeType:'video/webm',extension:'webm',meta:'GENERATED INCONSISTENT VIDEO'})};
    window.__setupPreview=async()=>{const c=document.createElement('canvas');c.width=640;c.height=360;const x=c.getContext('2d');x.fillStyle='#295a85';x.fillRect(0,0,640,360);window.__previewCanvas=c;window.__previewTimer=setInterval(()=>x.fillRect(0,0,640,360),50);state.stream=c.captureStream(20);state.videoTrack=state.stream.getVideoTracks()[0];state.mode='photo';state.ratio='16:9';state.timerSeconds=0;elements.video.srcObject=state.stream;await elements.video.play();updateModeUi();elements.permissionPanel.hidden=true;};
    window.__rawSnapshot=async()=>{const db=await openDatabase(),names=Array.from(db.objectStoreNames).sort(),tx=db.transaction(names,'readonly'),done=transactionDone(tx);const rows=await Promise.all(names.map(async n=>[n,await requestToPromise(tx.objectStore(n).getAll())]));await done;const norm=async v=>{if(v instanceof Blob)return {size:v.size,type:v.type,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await v.arrayBuffer()))).map(b=>b.toString(16).padStart(2,'0')).join('')};if(Array.isArray(v))return Promise.all(v.map(norm));if(v&&typeof v==='object'){const o={};for(const k of Object.keys(v).sort())o[k]=await norm(v[k]);return o;}return v;};return {version:db.version,rows:await norm(rows)};};`);
  return p;
}

try{
  server=http.createServer((req,res)=>{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname),file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    try{let bytes=fs.readFileSync(file);
      // Hold only startup so each fresh database can be seeded before the real initializer.
      if(pathname==='/assets/js/bootstrap.js')bytes=Buffer.from('window.__startApplicationForTest=()=>{\n'+bytes.toString()+'\n};if(!window.__deferStartup)__startApplicationForTest();');
      res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.mp4':'video/mp4','.webm':'video/webm'})[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','Permissions-Policy':'camera=(), microphone=()'});res.end(bytes);
    }catch{res.writeHead(404).end();}});
  server.listen(0,'127.0.0.1');await once(server,'listening');details.origin='http://127.0.0.1:'+server.address().port;
  chrome=spawn(process.env.CHROME_PATH||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'google-chrome'),['--headless=new','--remote-debugging-port=0','--user-data-dir='+path.join(scratch,'profile'),'--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check','--mute-audio','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let stderr='';const endpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Chrome startup timeout '+stderr)),15000);chrome.stderr.on('data',d=>{stderr+=d;const m=stderr.match(/DevTools listening on (ws:\/\/\S+)/);if(m){clearTimeout(timer);resolve(m[1]);}});});
  socket=new WebSocket(endpoint);await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
  socket.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.id){const task=pending.get(data.id);if(!task)return;pending.delete(data.id);clearTimeout(task.timer);data.error?task.reject(Error(JSON.stringify(data.error))):task.resolve(data.result);}else if(data.method==='Runtime.exceptionThrown')exceptions.push(data.params.exceptionDetails);});

  await test('a damaged record does not block history or a successful photo save',async()=>{
    const p=await open();await p.eval(`(async()=>{await __seedPhoto('healthy',1700000000000);await __seedBad();recoverInterruptedRecordings=async()=>{};__startApplicationForTest();await __setupPreview();Object.defineProperty(window,'ImageCapture',{configurable:true,value:undefined});})()`);
    await p.eval('openGallery().catch(error=>{window.__openError=error.message})');
    const opened=await p.eval('elements.galleryDialog.open');await p.eval('elements.galleryDialog.close()');
    const before=await p.eval('countStoredMedia()');await p.eval('capturePhoto()');
    const observation=await p.eval(`(async()=>({opened:${opened},openError:window.__openError||null,count:await countStoredMedia(),toasts:__toasts,flashCount:__flashCount,unavailable:state.gallery.filter(m=>m.unavailable).map(m=>m.id)}))()`);
    details.corruptionAndSave=observation;
    check('photo persisted despite pre-existing damaged video',observation.count,before+1);
    check('history opens despite one damaged video',observation.opened);
    check('saved photo reports success',observation.toasts.at(-1).includes('写真を保存しました'));
    check('saved photo flashes once',observation.flashCount,1);
    check('one damaged record is represented',observation.unavailable,['damaged']);
    await p.run(`await openGallery();window.__healthyId=state.gallery.find(m=>m.kind==='photo').id;elements.galleryGrid.querySelector('[data-id="'+__healthyId+'"] .gallery-open').click()`);
    await until(p,'!document.querySelector("#reviewNewerPhoto").disabled');await p.eval('document.querySelector("#reviewNewerPhoto").click()');
    await until(p,'__toasts.at(-1).includes("履歴から別の項目")');
    check('damaged adjacent media preserves the current viewer and explains the alternative',await p.eval('elements.reviewDialog.open&&state.selectedMedia.id===__healthyId'));
  });

  await test('unavailable records retain bytes and cannot silently enter batch export',async()=>{
    const p=await open();await p.eval(`(async()=>{for(let i=0;i<61;i++)await __seedPhoto('photo-'+i,1700000000000+i);const image=await __photoBlob();const pdf=await jpegPagesToPdf([await blobToJpegPage(image)]);await putMedia({id:'healthy-pdf',createdAt:1700000000100,kind:'photo',blob:pdf,previewBlob:image,extension:'pdf',mimeType:'application/pdf',meta:'PDF · 1ページ'});const video=await fetch('/tests/fixtures/portrait.mp4').then(r=>r.blob());await putMedia({id:'healthy-video',createdAt:1700000000200,kind:'video',blob:video,previewBlob:video,extension:'mp4',mimeType:'video/mp4',meta:'GENERATED VIDEO'});await __seedBad();window.__beforeRead=await __rawSnapshot();recoverInterruptedRecordings=async()=>{};await initializeApp();})()`);
    check('first history read stays paged',await p.eval('state.gallery.length'),60);
    await p.eval('openGallery()');await p.eval('refreshGallery({append:true})');
    check('all records remain reachable',await p.eval('state.gallery.length'),64);
    await p.run(`state.selectedGalleryIds.add('damaged');state.selectedGalleryIds.add('photo-60');updateGallerySelectionUi();await refreshGallery()`);
    check('selected damaged metadata does not fail refresh',await p.eval('state.selectedGalleryIds.size'),2);
    check('unavailable item is visible and named',await p.eval(`document.querySelector('[data-id="damaged"]').textContent.includes('読み込めない項目')`));
    check('batch exports disabled, explicit delete available',await p.eval(`[document.querySelector('#saveGalleryButton').disabled,document.querySelector('#shareGalleryButton').disabled,elements.exportPdfButton.disabled,elements.deleteSelectedButton.disabled]`),[true,true,true,false]);
    check('selection notice explains unavailable item',await p.eval(`document.querySelector('#gallerySelectionNotice').textContent.includes('読み込めない項目')`));
    const screenshot=await p.cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(output,'unavailable-history.png'),Buffer.from(screenshot.data,'base64'));
    await p.run(`document.querySelector('#saveGalleryButton').dispatchEvent(new MouseEvent('click'));document.querySelector('#shareGalleryButton').dispatchEvent(new MouseEvent('click'));await QuietCameraGallery.exportPdf()`);await sleep(150);
    check('defensive batch validation produces no external files',await p.eval('[__downloads.length,__shares.length]'),[0,0]);
    check('reading and refused export do not alter stored data',await p.eval('__rawSnapshot()'),await p.eval('__beforeRead'));
    await p.run(`state.selectedGalleryIds.clear();state.selectedGalleryIds.add('photo-60');updateGallerySelectionUi();document.querySelector('#saveGalleryButton').click()`);
    await until(p,'__downloads.length===1');await p.eval(`document.querySelector('#shareGalleryButton').click()`);await until(p,'__shares.length===1');
    check('healthy selection saves and shares',await p.eval('[__downloads[0].size>0,__shares[0].length]'),[true,1]);
    await p.run(`state.selectedGalleryIds.clear();updateGallerySelectionUi();document.querySelector('#gallerySelectionButton').click()`);
    // Leaving selection mode is explicit; opening a damaged item never creates a Blob URL.
    await p.run(`elements.galleryDialog.close();await openGallery();document.querySelector('[data-id="damaged"] .gallery-open').click()`);
    check('unavailable item cannot open a media viewer',await p.eval('elements.reviewDialog.open'),false);
    await p.eval(`document.querySelector('[data-id="photo-60"] .gallery-open').click()`);
    check('healthy photo opens normally',await p.eval('elements.reviewDialog.open&&state.selectedMedia.id==="photo-60"'));
    await p.run(`elements.reviewDialog.close();await openGallery();state.selectedGalleryIds.add('damaged');updateGallerySelectionUi();await QuietCameraGallery.deleteSelected()`);
    check('explicit deletion removes only damaged record',await p.eval('[(await countStoredMedia()),await getStoredMedia("damaged"),(await getRecordingChunks("damaged-owner")).length]'),[63,null,0]);
    check('healthy records still readable after deletion',await p.eval(`(await getStoredMedia('healthy-video')).blob.size>0 && (await getStoredMedia('healthy-pdf')).blob.size>0`));
  });

  await test('saved media stays successful when the gallery refresh itself fails',async()=>{
    const p=await open();await p.run(`recoverInterruptedRecordings=async()=>{};await initializeApp();await __setupPreview();Object.defineProperty(window,'ImageCapture',{configurable:true,value:undefined});window.__refresh=refreshGallery;refreshGallery=async()=>{throw Error('Injected history read failure')};await capturePhoto()`);
    const observation=await p.eval(`({toasts:__toasts,count:await countStoredMedia(),flashCount:__flashCount,records:(await listStoredMedia()).map(m=>({galleryUpdated:'galleryUpdated' in m,unavailable:'unavailable' in m}))})`);details.refreshFailure=observation;
    check('save remains committed',observation.count,1);check('success and refresh warning are separate',observation.toasts.at(-1).includes('写真を保存しました')&&observation.toasts.at(-1).includes('履歴の更新に失敗'));
    check('in-memory reporting flags are not persisted',observation.records,[{galleryUpdated:false,unavailable:false}]);
    await p.run(`window.__put=putMedia;putMedia=async()=>{throw new DOMException('保存容量が不足しています','QuotaExceededError')};await capturePhoto()`);
    check('a failed database write is never reported as saved',await p.eval('!__toasts.at(-1).includes("保存しました") && (await countStoredMedia())===1'));
  });

  await test('PDF metadata matches embedded image dimensions and ImageCapture fallback is usable',async()=>{
    const p=await open();await p.run(`recoverInterruptedRecordings=async()=>{};await initializeApp();await __setupPreview();window.__still=await __photoBlob(4096,3072);window.__imageCaptureCalls=0;Object.defineProperty(window,'ImageCapture',{configurable:true,value:class{async takePhoto(){__imageCaptureCalls++;return __still}}});elements.photoFormatSelect.value='application/pdf';await capturePhoto()`);
    const pdf=await p.eval(String.raw`(async()=>{const media=(await listStoredMedia())[0],text=await media.blob.text(),m=text.match(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)/);return {width:media.width,height:media.height,meta:media.meta,embedded:m?[Number(m[1]),Number(m[2])]:null,calls:__imageCaptureCalls};})()`);details.pdf=pdf;
    check('synthetic ImageCapture takePhoto branch executed',pdf.calls,1);check('PDF contains an image',Array.isArray(pdf.embedded));
    check('PDF image maximum remains 2048 pixels',Math.max(...pdf.embedded),2048);check('stored dimensions describe the embedded image',[pdf.width,pdf.height],pdf.embedded);
    check('displayed PDF dimensions are accurate',pdf.meta.includes(pdf.embedded.join('×')));
    await p.run(`Object.defineProperty(window,'ImageCapture',{configurable:true,value:class{async takePhoto(){throw Error('Injected still capture failure')}}});elements.photoFormatSelect.value='image/jpeg';await capturePhoto()`);
    check('ImageCapture rejection falls back to preview',await p.eval(`(await listStoredMedia())[0].meta.includes('プレビュー取得')`));
    const capture=await p.eval(`(async()=>{const media=(await listStoredMedia())[0],image=await createImageBitmap(media.blob),size=[image.width,image.height];image.close();return {size,width:media.width,height:media.height};})()`);
    check('fallback metadata matches decoded pixels',capture.size,[capture.width,capture.height]);
  });

  await test('history appears before slow recovery and remains usable if recovery rejects',async()=>{
    const p=await open();await p.run(`await __seedPhoto('before-recovery',1700000000000);window.__recoveryEntered=false;recoverInterruptedRecordings=async()=>{__recoveryEntered=true;await new Promise((resolve,reject)=>{window.__releaseRecovery=resolve;window.__rejectRecovery=reject})};window.__startup=initializeApp()`);
    await until(p,'__recoveryEntered');const before=await p.eval('({count:Number(elements.galleryCount.textContent),items:state.gallery.length,hidden:elements.previewThumbnail.hidden})');details.beforeRecovery=before;
    // Always release the injected wait, including the baseline where this assertion fails.
    await p.run(`__rejectRecovery(Error('Injected recovery failure'));await __startup.catch(error=>{window.__startupError=error.message})`);
    check('existing history appears during recovery',before,{count:1,items:1,hidden:false});
    await p.eval('openGallery()');check('recovery failure does not block healthy history',await p.eval('elements.galleryDialog.open&&state.gallery.length===1'));
    check('recovery failure is explained',await p.eval('__toasts.some(t=>t.includes("中断した録画の確認に失敗"))'));
  });

  check('all browser page audits were captured',audits.every(n=>n!==null)&&audits.length===pages.length);
  check('no physical camera or microphone requests',audits.every(n=>n===0));check('no uncaught page exceptions',exceptions,[]);
  const passed=results.every(r=>r.passed);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed,root,checks,results,details,exceptions,audit:{nativeMediaCalls:audits.reduce((sum,n)=>sum+n,0)},limits:['Synthetic media and fault injection only; no real camera, microphone, USB, existing server/profile, or OS share destination.']},null,2));
  console.log(JSON.stringify({passed,checks:checks.length,cases:results.length,output,audit:{nativeMediaCalls:audits.reduce((sum,n)=>sum+n,0)}}));if(!passed)process.exitCode=1;
}catch(error){fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:error.stack,results,checks,details,exceptions,audit:{nativeMediaCalls:audits.length?audits.reduce((sum,n)=>sum+(n||0),0):null}},null,2));console.error(error);process.exitCode=1;}
finally{await cleanupBrowserTest({scratch,chrome,socket,command,server,output,pending});}
