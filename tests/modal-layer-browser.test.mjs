// Synthetic media only, with a fresh browser profile and isolated storage.
// No real camera, microphone, phone, or user gallery is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const root=process.env.QUIET_CAMERA_MODAL_TEST_ROOT||path.resolve(import.meta.dirname,'..');
const output=process.env.QUIET_CAMERA_MODAL_TEST_OUTPUT||path.resolve(root,'test-results/history');
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
const baselineMode=process.env.QUIET_CAMERA_MODAL_BASELINE==='1';
let audit;
try{
 const version=await command('Browser.getVersion');
 const {browserContextId}=await command('Target.createBrowserContext');
 for(const name of ['camera','microphone'])await command('Browser.setPermission',{permission:{name},setting:'denied',browserContextId});
 const {targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});
 ({sessionId}=await command('Target.attachToTarget',{targetId,flatten:true}));
 await cdp('Page.enable');await cdp('Runtime.enable');await metrics(390,844);
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
  window.__audit={mediaCalls:0};
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{__audit.mediaCalls++;throw new Error('Device media forbidden');},enumerateDevices:async()=>[],getSupportedConstraints:()=>({}),addEventListener(){}}});
  Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});
 `});
 await cdp('Page.navigate',{url});await until('typeof selectMedia === "function" && !!window.QuietCameraEnhancements');
 await evaluate(`(async()=>{
  for(let i=0;i<32;i++){
   const c=document.createElement('canvas');c.width=320;c.height=240;const x=c.getContext('2d');x.fillStyle='hsl('+i*29+' 60% 30%)';x.fillRect(0,0,320,240);x.fillStyle='white';x.font='bold 25px sans-serif';x.fillText('SAMPLE '+i,20,120);
   const blob=await canvasToBlob(c,'image/png',1);await putMedia({id:'p'+String(i).padStart(3,'0'),kind:'photo',createdAt:1700000000000+i*1000,blob,previewBlob:blob,extension:'png',mimeType:'image/png',meta:'SAMPLE '+i});
  }
  await refreshGallery();
  const spacer=document.createElement('div');spacer.id='testPageTail';spacer.style.height='2600px';document.body.append(spacer);
 })()`);
 const wheel=async(x,y,dy)=>{await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX:0,deltaY:dy});await sleep(180);};
 const touchDrag=async(x,y,dy)=>{
  const p=(y)=>({x,y,id:1,radiusX:3,radiusY:3,force:1});
  await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p(y)]});
  for(let i=1;i<=6;i++){await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[p(y+dy*i/6)]});await sleep(24);}
  await sleep(160);await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(160);
 };
 const tap=async(x,y)=>{await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});await cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(100);};
 const gallery=async()=>{await evaluate('(async()=>{await refreshGallery();renderGallery();elements.galleryButton.focus({preventScroll:true});elements.galleryDialog.showModal()})()');await sleep(100);};
 const galleryClose=async()=>{await evaluate('elements.closeGalleryButton.click()');await until('!elements.galleryDialog.open');await sleep(100);};
 const scrollState=()=>evaluate('({y:scrollY,bodyTop:document.body.getBoundingClientRect().top,position:document.body.style.position,overflow:document.documentElement.style.overflow})');
 const stable=async(name,before)=>{const after=await scrollState();check(name,[after.y,after.bodyTop],[before.y,before.bodyTop]);};
 await evaluate('document.body.style.paddingRight="3px";window.scrollTo(0,460)');await sleep(70);
 const original=await evaluate('({x:scrollX,y:scrollY,body:document.body.getAttribute("style"),html:document.documentElement.getAttribute("style")})');
 await gallery();
 // Put an actual checkbox under the sticky toolbar. Hit testing must return
 // the toolbar, not the later card's z-index:2 label.
 const overlap=await evaluate(`(()=>{
  const d=elements.galleryDialog,t=d.querySelector('.gallery-toolbar');
  for(let scroll=30;scroll<600;scroll+=10){
   d.scrollTop=scroll;const tr=t.getBoundingClientRect();
   for(const label of d.querySelectorAll('.gallery-select')){
    const r=label.getBoundingClientRect(),top=Math.max(r.top,tr.top),bottom=Math.min(r.bottom,tr.bottom);
    if(bottom-top<10)continue;
    const x=r.left+20,y=(top+bottom)/2,hit=document.elementFromPoint(x,y);
    return {point:{x,y},overlapping:true,toolbarWins:!!hit?.closest('.gallery-toolbar'),hit:hit?.outerHTML.slice(0,180),cardIsolation:getComputedStyle(label.closest('.gallery-card')).isolation,scrollTop:d.scrollTop};
   }
  }
  throw new Error('No checkbox/toolbar overlap found in scroll range');
 })()`);
 await shot(baselineMode?'01-before-checkbox-overlap.png':'01-after-checkbox-overlap.png');
 if(baselineMode){
  const before=await scrollState();await wheel(2,8,370);await touchDrag(2,300,-160);const after=await scrollState();
  await shot('02-before-background-scroll.png');
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({baseline:true,engine:version.product,overlap,background:{before,after,moved:before.y!==after.y||before.bodyTop!==after.bodyTop},fixtureOnly:true},null,2));
  console.log(JSON.stringify({baseline:true,overlap,backgroundMoved:before.y!==after.y||before.bodyTop!==after.bodyTop,output}));
 }else{
  check('checkbox is really under sticky toolbar',overlap.overlapping,true);check('sticky toolbar paints above checkbox',overlap.toolbarWins,true);check('card owns its stacking context',overlap.cardIsolation,'isolate');
  const locked=await scrollState();await wheel(2,8,370);await touchDrag(2,300,-160);await stable('backdrop wheel and touch do not move background',locked);
  await evaluate('elements.galleryDialog.scrollTop=0');await wheel(200,500,400);check('history panel still scrolls',await evaluate('elements.galleryDialog.scrollTop>50'),true);await stable('panel wheel does not move page',locked);
  await evaluate('elements.galleryDialog.scrollTop=0');await touchDrag(200,500,-150);check('history touch scrolling remains enabled',await evaluate('elements.galleryDialog.scrollTop>30'),true);
  for(const end of ['top','bottom']){
   await evaluate(`elements.galleryDialog.scrollTop=${end==='top'?0:'elements.galleryDialog.scrollHeight'}`);await wheel(200,500,end==='top'?-600:600);await touchDrag(200,500,end==='top'?180:-180);await stable(end+' overscroll does not chain to background',locked);
  }
  // The interactive checkbox retains its 44px label and selection behavior.
  await evaluate('elements.galleryDialog.scrollTop=0');
  const labelPoint=await evaluate('(()=>{const r=document.querySelector(".gallery-select").getBoundingClientRect();return{x:r.x+20,y:r.y+20,width:r.width,height:r.height}})()');
  await tap(labelPoint.x,labelPoint.y);check('checkbox remains tappable',await evaluate('document.querySelector(".gallery-select input").checked'),true);check('checkbox touch target retained',[labelPoint.width,labelPoint.height],[44,44]);
  await galleryClose();check('close restores exact original scroll',await evaluate('scrollY'),original.y);check('close restores inline styles',await evaluate('[document.body.getAttribute("style"),document.documentElement.getAttribute("style")]'),[original.body,original.html]);
  check('focus returns to gallery trigger',await evaluate('document.activeElement===elements.galleryButton'),true);
  await wheel(2,500,200);check('camera page remains fixed without a leftover inline lock',await evaluate('[scrollY,document.body.style.position]'),[original.y,'']);await evaluate(`scrollTo(0,${original.y})`);
  for(let i=0;i<3;i++){await gallery();await galleryClose();check('repeated open/close restores position '+i,await evaluate('scrollY'),original.y);}
  await gallery();
  await evaluate('window.__unlockEvents=[];new MutationObserver(()=>__unlockEvents.push(document.body.style.position)).observe(document.body,{attributes:true,attributeFilter:["style"]});document.querySelector(".gallery-open").click()');
  await until('elements.reviewDialog.open && !!state.selectedMedia');await sleep(100);
  check('gallery to viewer retains background lock',await evaluate('document.body.style.position'),'fixed');check('transition never briefly unlocks',await evaluate('__unlockEvents.every(x=>x==="fixed")'),true);
  check('viewer overlays all history checkboxes',await evaluate('(()=>{const r=elements.reviewImage.getBoundingClientRect();return !!document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest("#reviewDialog")})()'),true);
  const photo=await selected();await swipe(-90);await until(`state.selectedMedia?.id!==${JSON.stringify(photo)}`);check('photo swipe remains functional',await evaluate('state.selectedMedia.kind'),'photo');
  const afterSwipe=await selected();await cdp('Emulation.setPageScaleFactor',{pageScaleFactor:2});await sleep(70);await swipe(-80);check('zoomed pan does not navigate',await selected(),afterSwipe);check('native zoom retained',await evaluate('visualViewport.scale>1.5'),true);await cdp('Emulation.setPageScaleFactor',{pageScaleFactor:1});
  await metrics(844,390);check('landscape keeps lock',await evaluate('document.body.style.position'),'fixed');await shot('02-landscape-review-locked.png');
  await evaluate('elements.reviewDialog.dispatchEvent(new Event("cancel",{cancelable:true}))');check('cancel event alone does not prematurely unlock',await evaluate('document.body.style.position'),'fixed');
  await evaluate('elements.closeReviewButton.focus()');await cdp('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await until('!elements.reviewDialog.open');await sleep(90);check('Escape/back close restores page',await evaluate('[document.body.style.position,scrollY]'),['',original.y]);
  await metrics(390,844);const beforeRotationOpen=await evaluate('scrollY');await gallery();await metrics(844,390);const rotated=await scrollState();await wheel(2,8,300);await stable('rotation and backdrop scroll remain locked',rotated);await galleryClose();check('rotation close restores position at opening',await evaluate('scrollY'),beforeRotationOpen);
  await metrics(390,844);await evaluate(`scrollTo(0,${original.y})`);await gallery();await shot('03-portrait-history.png');
  // Native backdrop click and rapid re-open use the same cleanup path.
  const backdrop=await evaluate('(()=>{const r=elements.galleryDialog.getBoundingClientRect();return {x:2,y:Math.max(2,r.top-3)}})()');
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...backdrop});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...backdrop});await until('!elements.galleryDialog.open');await sleep(80);check('backdrop close restores position',await evaluate('scrollY'),original.y);
  await evaluate('elements.galleryDialog.showModal();elements.galleryDialog.close();elements.galleryDialog.showModal()');await sleep(120);check('queued close cannot unlock rapid reopen',await evaluate('[elements.galleryDialog.open,document.body.style.position]'),[true,'fixed']);await galleryClose();
  await gallery();await evaluate('window.__preventCancel=e=>e.preventDefault();elements.galleryDialog.addEventListener("cancel",__preventCancel)');
  await cdp('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await sleep(90);check('prevented native cancel keeps dialog and lock',await evaluate('[elements.galleryDialog.open,document.body.style.position]'),[true,'fixed']);await evaluate('elements.galleryDialog.removeEventListener("cancel",__preventCancel)');await galleryClose();
  await open('p015');await sleep(70);check('direct review also locks page',await evaluate('document.body.style.position'),'fixed');await close();await sleep(70);check('direct review close restores position',await evaluate('scrollY'),original.y);
  check('original styles restored after all transitions',await evaluate('[document.body.getAttribute("style"),document.documentElement.getAttribute("style")]'),[original.body,original.html]);
  audit=await evaluate('__audit');check('no camera or microphone requests',audit.mediaCalls,0);check('no uncaught exceptions',exceptions.length,0);
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:true,engine:version.product,version:await evaluate('document.querySelector("#versionBadge").textContent'),fixtureOnly:true,realDeviceUsed:false,phoneBrowserOperated:false,checks:results,overlap,audit,exceptions},null,2));
  console.log(JSON.stringify({passed:true,checks:results.length,engine:version.product,audit,output}));
 }
}catch(error){
 try{await shot('failure.png')}catch{}
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:error.stack,checks:results,exceptions},null,2));console.error(error);process.exitCode=1;
}finally{
 try{await command('Browser.close')}catch{}
 socket.close();server.close();
}
