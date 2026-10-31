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
const output=process.env.QUIET_CAMERA_SHEET_TEST_OUTPUT||path.resolve(root,'test-results/settings');
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
let audit;
try{
 const version=await command('Browser.getVersion');
 const {browserContextId}=await command('Target.createBrowserContext');
 for(const name of ['camera','microphone'])await command('Browser.setPermission',{permission:{name},setting:'denied',browserContextId});
 const {targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});({sessionId}=await command('Target.attachToTarget',{targetId,flatten:true}));
 await cdp('Page.enable');await cdp('Runtime.enable');await metrics(393,800);
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
  window.__audit={mediaCalls:0,settingsWrites:0};
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{__audit.mediaCalls++;throw new Error('Media forbidden');},enumerateDevices:async()=>[],getSupportedConstraints:()=>({}),addEventListener(){}}});
  Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});
 `});
 await cdp('Page.navigate',{url});await until('document.readyState==="complete" && !!window.QuietCameraEnhancements && typeof state!=="undefined"');
 await evaluate('saveSettings=()=>__audit.settingsWrites++;window.__initialSettings=JSON.stringify(collectSettings())');
 const settle=async()=>{await sleep(80);await until('!elements.settingsDialog.classList.contains("is-settling")');await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')};
 const measure=()=>evaluate(`(()=>{
  const d=elements.settingsDialog,h=document.querySelector('#settingsResizeHandle'),r=d.getBoundingClientRect(),hr=h.getBoundingClientRect(),s=getComputedStyle(h),root=getComputedStyle(document.documentElement),v=visualViewport;
  const available=Math.max(0,Math.floor(v.height-Math.max(8,parseFloat(root.getPropertyValue('--layout-safe-top'))||0)));
  const min=Number(h.getAttribute('aria-valuemin')),max=Number(h.getAttribute('aria-valuemax'));
  return {open:d.open,height:r.height,top:r.top,bottom:r.bottom,min,max,half:Math.min(max,Math.max(min,Math.round(available/2))),handle:{x:hr.x+hr.width/2,y:hr.y+hr.height/2,width:hr.width,height:hr.height,text:h.textContent.trim(),border:s.borderWidth,name:h.getAttribute('aria-label'),role:h.getAttribute('role'),tabIndex:h.tabIndex},ready:d.classList.contains('is-dismiss-ready'),resizing:d.classList.contains('is-resizing'),offset:new DOMMatrixReadOnly(getComputedStyle(d).transform).m42,pageY:scrollY,bodyPosition:document.body.style.position};
 })()`);
 const opening=async()=>{await evaluate('if(elements.settingsDialog.open)elements.closeSettingsButton.click()');await settle();await evaluate('elements.settingsButton.click()');await until('elements.settingsDialog.open');await settle();const m=await measure();check('opening uses maximum usable viewport '+results.length,Math.abs(m.height-m.max)<2,true);return m;};
 const key=async k=>{await evaluate('document.querySelector("#settingsResizeHandle").focus({preventScroll:true})');await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:k,code:k});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:k,code:k});await settle();};
 let gesture;
 const start=async()=>{const m=await measure();gesture={...m.handle,id:1};await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:gesture.x,y:gesture.y,id:1,radiusX:3,radiusY:3,force:1}]});return m;};
 const move=async(dy,dx=0)=>{for(let i=1;i<=5;i++){await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:gesture.x+dx*i/5,y:gesture.y+dy*i/5,id:1,radiusX:3,radiusY:3,force:1}]});await sleep(20)}await settle()};
 const end=async(cancel=false)=>{await sleep(160);await cdp('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});await settle()};
 let m=await opening();check('only the horizontal handle is visible',[m.handle.text,m.handle.border],['','0px']);check('invisible hit area remains at least 44px',m.handle.width>=44&&m.handle.height>=44,true);check('accessible handle retains role, name and focus',[m.handle.role,!!m.handle.name,m.handle.tabIndex],['separator',true,0]);await shot('01-full-height-line-only.png');
 await key('Home');m=await measure();await start();await move(-80);await end();check('upward drag expands', (await measure()).height>m.height+70,true);
 m=await start();await move(40);await end();check('ordinary downward resize stays open',(await measure()).open,true);check('ordinary downward resize shrinks',(await measure()).height<m.height-30,true);
 await key('Home');await start();await move(32);await end();check('small pull below minimum does not dismiss',(await measure()).open,true);
 await opening();m=await start();await move(m.height-m.min+105);check('slow downward pull follows below minimum and stays open',[(await measure()).offset>90,(await measure()).open],[true,true]);await shot('02-downward-dismiss-ready.png');await end();
 check('slow release below minimum returns without dismissing',[(await measure()).open,Math.abs((await measure()).offset)<1],[true,true]);await evaluate('elements.closeSettingsButton.click()');await settle();check('dismiss restores focus and expanded state',await evaluate('[document.activeElement===elements.settingsButton,elements.settingsButton.getAttribute("aria-expanded")]'),[true,'false']);check('dismiss leaves no drag or body lock',[(await measure()).resizing,(await measure()).bodyPosition],[false,'']);
 await opening();m=await start();await move(m.height-m.min+105);await end(true);check('pointercancel never dismisses',(await measure()).open,true);check('pointercancel restores starting height',Math.abs((await measure()).height-m.height)<2,true);
 m=await start();await move(m.height-m.min+105);await evaluate('document.querySelector("#settingsResizeHandle").dispatchEvent(new PointerEvent("lostpointercapture",{pointerId:1}))');await end();check('lost capture never dismisses',(await measure()).open,true);check('lost capture restores height',Math.abs((await measure()).height-m.height)<2,true);
 m=await start();await move(m.height-m.min+105);await evaluate('window.dispatchEvent(new Event("blur"))');await end();check('interrupted window focus never dismisses',(await measure()).open,true);
 m=await start();await move(m.height-m.min+105);await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:gesture.x,y:gesture.y+100,id:1},{x:gesture.x+25,y:gesture.y+100,id:2}]});await end();check('second contact cancels dismissal',(await measure()).open,true);
 await opening();m=await start();await move(m.height-m.min+100);await metrics(800,393);await end();check('rotation during drag never dismisses',(await measure()).open,true);check('rotation releases pointer state',(await measure()).resizing,false);await shot('03-landscape-clamped.png');
 await metrics(393,800);await opening();await key('Home');m=await start();await move(85,110);await end();check('sideways drag does not dismiss',(await measure()).open,true);
 await opening();
 await evaluate('elements.settingsSheetBody.scrollTop=120');
 const p=await evaluate('(()=>{const r=elements.settingsSheetBody.getBoundingClientRect();return{x:r.right-5,y:r.y+r.height/2}})()');
 await cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});await cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x,y:p.y+100,id:1}]});await end();check('content scrolling never dismisses',(await measure()).open,true);
 await key('Home');check('focus does not draw an outer handle frame',await evaluate('getComputedStyle(document.querySelector("#settingsResizeHandle")).outlineStyle'),'none');check('keyboard focus remains visible on the line',await evaluate('parseFloat(getComputedStyle(document.querySelector("#settingsResizeHandle"),"::before").outlineWidth)>=2'),true);const low=(await measure()).height;await key('ArrowUp');check('ArrowUp adjusts height',(await measure()).height>low+20,true);await key('End');check('End reaches maximum',Math.abs((await measure()).height-(await measure()).max)<2,true);await key('Home');check('Home reaches minimum',Math.abs((await measure()).height-(await measure()).min)<2,true);
 await key('Escape');check('Escape closes settings',(await measure()).open,false);
 await evaluate('window.scrollTo(0,120);window.__pageBefore=scrollY;window.__bodyBefore=document.body.getAttribute("style")');
 for(let i=0;i<3;i++){await opening();await key('Home');await evaluate('elements.closeSettingsButton.click()');await settle();check('repeated close restores page '+i,await evaluate('[scrollY,document.body.getAttribute("style")]'),await evaluate('[__pageBefore,__bodyBefore]'));}
 for(const [w,h]of[[320,480],[800,360],[393,800]]){await metrics(w,h);m=await opening();check('small/landscape extent stays usable '+w+'x'+h,m.top>=-0.5&&m.bottom<=h+0.5&&m.height>=m.min-1,true);}
 await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{top:30,bottom:20,left:0,right:0}});m=await opening();check('safe-area opening stays below top inset',m.top>=30,true);await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,bottom:0,left:0,right:0}});
 await evaluate('Object.defineProperty(visualViewport,"height",{configurable:true,value:360});Object.defineProperty(visualViewport,"offsetTop",{configurable:true,value:60});visualViewport.dispatchEvent(new Event("resize"))');await settle();m=await measure();check('simulated keyboard viewport clamps sheet',m.top>=60&&m.bottom<=420.5,true);await shot('04-keyboard-viewport.png');
 await evaluate('delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event("resize"))');await settle();
 await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});m=await opening();await start();await move(m.height-m.min+105);await end();check('reduced-motion slow pull remains open',(await measure()).open,true);await evaluate('elements.closeSettingsButton.click()');await settle();
 await evaluate('elements.settingsDialog.show();elements.settingsDialog.close();elements.settingsDialog.show()');await settle();m=await measure();check('rapid close/reopen has full-height and no stale drag',m.open&&Math.abs(m.height-m.max)<2&&!m.resizing,true);await evaluate('elements.closeSettingsButton.click()');await settle();
 await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 const gestureCases=[];
 await evaluate(`window.__touchTrace=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])document.querySelector('#settingsResizeHandle').addEventListener(type,e=>__touchTrace.push({type,time:e.timeStamp,x:e.clientX,y:e.clientY,trusted:e.isTrusted,height:elements.settingsDialog.getBoundingClientRect().height}),{capture:true,passive:true})`);
 const nativeSwipe=async(dy,{duration=64,steps=8,hold=0,cancel=false,release=true,content=false}={})=>{
  const before=await measure();const point=content?await evaluate('(()=>{const r=elements.settingsSheetBody.getBoundingClientRect();return {x:r.right-4,y:r.y+50}})()'):before.handle;
  await evaluate('__touchTrace=[]');const epoch=Date.now()/1000-.4;
  const touch=y=>({x:point.x,y,id:1,radiusX:3,radiusY:3,force:1});
  await cdp('Input.dispatchTouchEvent',{type:'touchStart',timestamp:epoch,touchPoints:[touch(point.y)]});
  for(let i=1;i<=steps;i++)await cdp('Input.dispatchTouchEvent',{type:'touchMove',timestamp:epoch+duration*i/steps/1000,touchPoints:[touch(point.y+dy*i/steps)]});
  const moved=await measure();
  if(!release)return {before,moved,epoch,point};
  if(hold)await sleep(hold);
  await cdp('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',timestamp:epoch+(duration+hold+1)/1000,touchPoints:[]});
  const intent=await evaluate('(()=>{const a=__touchTrace.filter(p=>p.type!=="pointercancel");return {trace:__touchTrace,intent:QuietCameraSheetMotion.releaseIntent(a,a.at(-1)?.time||0)}})()');
  const after=await measure();gestureCases.push({dy,duration,steps,hold,cancel,content,...intent,after});return {before,moved,after,...intent};
 };
 await opening();m=await start();const originalHandleY=m.handle.y;
 for(const dy of [40,140,m.height-m.min+70]){await move(dy);check('handle tracks finger through minimum '+dy,Math.abs((await measure()).handle.y-originalHandleY-dy)<1.1,true);}
 await end();check('slow release rebounds to minimum without closing',[(await measure()).open,Math.abs((await measure()).height-(await measure()).min)<2,Math.abs((await measure()).offset)<1],[true,true,true]);
 await opening();const slow=await nativeSwipe(70,{duration:400,steps:12});await settle();check('native slow downward drag keeps adjusted height',[(await measure()).open,Math.abs((await measure()).height-(slow.before.height-70))<2],[true,true]);
 await opening();const flick=await nativeSwipe(96);check('fast down starts a visible release animation',await evaluate('elements.settingsDialog.open&&elements.settingsDialog.dataset.sheetState==="closing"'),true);check('fast down has measured recent speed',flick.intent.velocity>=.75&&flick.intent.action==='dismiss',true);
 const keys=await evaluate('elements.settingsDialog.getAnimations()[0]?.effect.getKeyframes().map(k=>({height:k.height,transform:k.transform}))');fs.writeFileSync(path.join(output,'first-flick-trace.json'),JSON.stringify({flick,keys},null,2));check('release animation starts at current height',Math.abs(parseFloat(keys[0].height)-flick.trace.at(-1).height)<1,true);
 await sleep(35);const midway=await measure();check('dismiss translates continuously without opacity fade',midway.open&&midway.offset>0&&await evaluate('getComputedStyle(elements.settingsDialog).opacity==="1"'),true);await shot('05-velocity-dismiss-mid-motion.png');await until('!elements.settingsDialog.open');await settle();check('fast flick closes after animation',[(await measure()).open,(await measure()).resizing],[false,false]);check('animated close restores trigger focus',await evaluate('document.activeElement===elements.settingsButton'),true);
 await opening();await key('Home');const up=await nativeSwipe(-48,{duration:40,steps:5});await settle();check('upward flick expands beyond release height to max',up.moved.height<up.before.max-4&&Math.abs((await measure()).height-(await measure()).max)<2,true);await shot('06-upward-flick-expanded.png');
 await opening();const held=await nativeSwipe(96,{hold:140});await settle();check('holding after a fast move prevents stale dismissal',[held.intent.action,(await measure()).open],['resize',true]);
 for(const steps of [4,8]){await opening();const cadence=await nativeSwipe(88,{duration:80,steps});await until('!elements.settingsDialog.open');await settle();check('native cadence '+steps+' recognizes fast release',cadence.intent.action,'dismiss');check('native sequence events are trusted '+steps,cadence.trace.every(p=>p.trusted),true);}
 await opening();const near=await nativeSwipe(60,{duration:100,steps:10});await settle();check('native below-speed-threshold drag stays open',[near.intent.action,(await measure()).open],['resize',true]);
 await opening();const cancelled=await nativeSwipe(96,{cancel:true});await settle();check('cancelled fast drag restores original height',[(await measure()).open,Math.abs((await measure()).height-cancelled.before.height)<2],[true,true]);
 await opening();await nativeSwipe(96);await metrics(800,393);await sleep(300);check('rotation interrupts dismissal without closing',(await measure()).open,true);check('rotation clears transient motion',await evaluate('!elements.settingsDialog.dataset.sheetState&&!elements.settingsDialog.classList.contains("is-settling")'),true);
 await metrics(393,800);await opening();await nativeSwipe(96);await evaluate('elements.settingsButton.click()');await sleep(300);m=await measure();check('reopen during closing cancels stale completion',m.open&&Math.abs(m.height-m.max)<2&&!m.resizing,true);
 await nativeSwipe(96);await evaluate('elements.closeSettingsButton.click();elements.settingsButton.click()');await sleep(300);m=await measure();check('close-button and rapid reopen restore full-height',m.open&&Math.abs(m.height-m.max)<2&&Math.abs(m.offset)<1,true);
 await opening();await nativeSwipe(96);await evaluate('(()=>{const a=elements.settingsDialog.getAnimations()[0];a.pause();a.currentTime=40})()');await start();await move(-30);await end();await sleep(280);check('grabbing handle at a fixed animation frame cancels pending close',(await measure()).open,true);
 await opening();await nativeSwipe(96,{content:true});await settle();check('fast settings content scroll never dismisses',(await measure()).open,true);
 await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await opening();await nativeSwipe(96);await settle();check('reduced motion skips dismiss animation',await evaluate('!elements.settingsDialog.open&&elements.settingsDialog.getAnimations().length===0'),true);
 await opening();await key('Home');await nativeSwipe(-48,{duration:40,steps:5});await settle();check('reduced motion expands without animation',await evaluate('elements.settingsDialog.open&&elements.settingsDialog.getAnimations().length===0'),true);check('reduced motion reaches maximum',Math.abs((await measure()).height-(await measure()).max)<2,true);
 await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await opening();await nativeSwipe(96);await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await settle();check('live reduced-motion change finishes safely',(await measure()).open,false);
 await evaluate('scrollTo(0,120);window.__kineticBackground=[scrollY,document.body.getAttribute("style"),document.documentElement.style.overflow]');await opening();await nativeSwipe(96);await settle();check('velocity dismissal restores background and interaction',await evaluate('[scrollY,document.body.getAttribute("style"),document.documentElement.style.overflow]'),await evaluate('__kineticBackground'));check('animated dismissal restores expanded state',await evaluate('elements.settingsButton.getAttribute("aria-expanded")'),'false');
 await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 await metrics(393,900);await opening();await key('End');await shot('07-maximum-safe-screen.png');
 await evaluate(`window.__nativeFullscreenCalls=0;for(const e of [document.documentElement,elements.cameraStage])e.requestFullscreen=()=>{__nativeFullscreenCalls++;throw new Error('Native fullscreen forbidden in settings test')};
  const fixture=document.createElement('div');fixture.id='testLongSettings';
  for(let i=0;i<20;i++){const row=document.createElement('div');row.className='setting-field';const label=document.createElement('span');label.textContent='TEST ROW '+i;const b=document.createElement('button');b.type='button';b.textContent='SAMPLE '+i;b.style.minHeight='44px';row.append(label,b);fixture.append(row)}elements.settingsPanel.append(fixture);
 `);
 const maxGeometry=()=>evaluate(`(()=>{const v=visualViewport,s=getComputedStyle(document.documentElement),a=Math.max(8,parseFloat(s.getPropertyValue('--layout-safe-top'))||0),b=Math.max(8,parseFloat(s.getPropertyValue('--layout-safe-bottom'))||0),r=e=>{const p=e.getBoundingClientRect();return {top:p.top,bottom:p.bottom,left:p.left,right:p.right,height:p.height}};return {top:v.offsetTop+a,bottom:v.offsetTop+v.height,height:Math.floor(v.height-a),close:r(elements.closeSettingsButton),body:r(elements.settingsSheetBody),bodyOverflow:getComputedStyle(elements.settingsSheetBody).overflowY,pageY:scrollY}})()`);
 const maxCases=[];
 for(const[w,h]of[[320,480],[393,900],[900,393]]){
  await metrics(w,h);await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,bottom:0,left:0,right:0}});await opening();await nativeSwipe(-48,{duration:40,steps:5});await settle();m=await measure();const g=await maxGeometry();
  check('up flick reaches whole safe viewport '+w+'x'+h,Math.abs(m.height-g.height)<2&&Math.abs(m.top-g.top)<2&&Math.abs(m.bottom-g.bottom)<2,true);
  check('dismiss button remains inside safe viewport '+w,g.close.top>=g.top&&g.close.bottom<=g.bottom,true);check('max settings content uses internal scroll '+w,g.bodyOverflow,'auto');
  await evaluate('elements.settingsSheetBody.scrollTop=0;document.querySelector("#testLongSettings .setting-field:last-child button").focus()');await settle();
  const focused=await evaluate('(()=>{const a=document.activeElement.getBoundingClientRect(),b=elements.settingsSheetBody.getBoundingClientRect();return {visible:a.top>=b.top-.5&&a.bottom<=b.bottom+.5,scroll:elements.settingsSheetBody.scrollTop,pageY:scrollY}})()');
  check('last content can receive visible focus '+w,focused.visible&&focused.scroll>0,true);check('internal focus scroll does not move background '+w,focused.pageY,g.pageY);maxCases.push({width:w,height:h,sheet:m,safe:g,focused});
  await opening();m=await start();await move(-(m.max-m.height+20));await end();check('slow drag also reaches whole-screen maximum '+w,Math.abs((await measure()).height-g.height)<2,true);
  await evaluate('elements.closeSettingsButton.click()');await settle();m=await opening();check('max close reopens at maximum '+w,Math.abs(m.height-m.max)<2,true);
 }
 await metrics(393,900);await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{top:30,bottom:24,left:12,right:18}});await opening();await key('End');m=await measure();let safe=await maxGeometry();check('full extent respects all vertical safe areas',Math.abs(m.top-30)<2&&Math.abs(m.bottom-900)<2&&m.height===870,true);check('close button clears horizontal cutout margins',safe.close.left>=12&&safe.close.right<=393-18,true);await shot('08-maximum-with-safe-areas.png');
 await evaluate('Object.defineProperty(visualViewport,"height",{configurable:true,value:300});Object.defineProperty(visualViewport,"offsetTop",{configurable:true,value:90});visualViewport.dispatchEvent(new Event("resize"))');await settle();m=await measure();safe=await maxGeometry();check('max extent follows simulated keyboard viewport',Math.abs(m.top-120)<2&&Math.abs(m.bottom-390)<2&&m.height===270,true);
 await evaluate('document.querySelector("#testLongSettings .setting-field:last-child button").focus()');await settle();check('last content remains above keyboard',await evaluate('(()=>{const a=document.activeElement.getBoundingClientRect(),b=elements.settingsSheetBody.getBoundingClientRect();return a.top>=b.top-.5&&a.bottom<=b.bottom+.5&&a.bottom<=390})()'),true);await shot('09-maximum-keyboard-viewport.png');
 await evaluate('delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event("resize"))');await settle();m=await measure();check('keyboard dismissal restores full maximum',m.height===870&&Math.abs(m.top-30)<2,true);
 for(let i=0;i<2;i++){await metrics(900,393);await settle();m=await measure();safe=await maxGeometry();check('expanded sheet tracks rotation '+i,Math.abs(m.height-safe.height)<2&&m.top>=safe.top-.5,true);await metrics(393,900);await settle();}
 await evaluate('elements.closeSettingsButton.click()');await settle();check('max close restores trigger focus',await evaluate('document.activeElement===elements.settingsButton'),true);check('settings never invoke native fullscreen',await evaluate('[__nativeFullscreenCalls,document.fullscreenElement===null,document.documentElement.classList.contains("immersive-mode")]'),[0,true,false]);
 await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,bottom:0,left:0,right:0}});await evaluate('document.querySelector("#testLongSettings").remove();scrollTo(0,120);window.__maxBackground=[scrollY,document.body.getAttribute("style"),document.documentElement.style.overflow]');await opening();await key('End');await nativeSwipe(96);await settle();check('max flick dismissal restores background',await evaluate('[scrollY,document.body.getAttribute("style"),document.documentElement.style.overflow]'),await evaluate('__maxBackground'));
 for(const dpr of [1,2.75]){await cdp('Emulation.setDeviceMetricsOverride',{width:393,height:801,deviceScaleFactor:dpr,mobile:true,screenWidth:393,screenHeight:801,screenOrientation:{type:'portraitPrimary',angle:0}});await cdp('Emulation.setSafeAreaInsetsOverride',{insets:{top:27,bottom:23,left:0,right:0}});await opening();await evaluate('Object.defineProperty(visualViewport,"height",{configurable:true,value:700.25});Object.defineProperty(visualViewport,"offsetTop",{configurable:true,value:19.125});visualViewport.dispatchEvent(new Event("resize"))');await settle();const b=await evaluate('(()=>{const r=elements.settingsDialog.getBoundingClientRect(),v=visualViewport;return {bottom:r.bottom,visibleBottom:v.offsetTop+v.height,lastPixel:elements.settingsDialog.contains(document.elementFromPoint(innerWidth/2,v.offsetTop+v.height-.5)),padding:parseFloat(getComputedStyle(elements.settingsDialog).paddingBottom)}})()');check('background covers fractional visible bottom DPR'+dpr,Math.abs(b.bottom-b.visibleBottom)<.05&&b.lastPixel&&b.padding>=36,true);await evaluate('delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event("resize"))');}check('camera settings values are preserved',await evaluate('JSON.stringify(collectSettings())===__initialSettings'),true);check('no persistent settings write from resizing',await evaluate('__audit.settingsWrites'),0);
 audit=await evaluate('__audit');check('no camera or microphone requests',audit.mediaCalls,0);check('no uncaught exceptions',exceptions.length,0);
 const record={passed:true,engine:version.product,version:await evaluate('elements.versionBadge.textContent'),fixtureOnly:true,realDeviceUsed:false,kinetics:gestureCases,maxCases,maximumRule:'Visual viewport minus top safe area (at least8px); panel background reaches visible bottom; bottom safe area is interior padding; keyboard excluded; no native fullscreen',checks:results,audit,exceptions,openingRule:'100% of usable visual viewport on each opening; bottom safe area covered by background; preserve resized fraction only while open',dismissRule:'Handle-only recent velocity >=0.75 CSS px/ms over a 100ms sample window, 40px recent travel, vertical dominance>1.5, >=3 samples/24ms; idle>80ms cancels flick. Down dismisses, up expands; slow release retains height or snaps to min. Motion140-240ms, reduced-motion immediate.'};
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(record,null,2));console.log(JSON.stringify({passed:true,checks:results.length,engine:version.product,audit,output}));
}catch(error){await shot('failure.png').catch(()=>{});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:error.stack,checks:results,exceptions},null,2));console.error(error);process.exitCode=1;}
} catch(error) {
 fs.writeFileSync(path.join(output,'harness-failure.json'),JSON.stringify({passed:false,error:error.stack},null,2));console.error(error);process.exitCode=1;
} finally {
 await cleanupBrowserTest({scratch,chrome,socket,command:cleanupCommand,server,output,pending});
}
