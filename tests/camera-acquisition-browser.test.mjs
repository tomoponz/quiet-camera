// Synthetic media only, with a fresh browser profile and isolated storage.
// No real camera, microphone, phone, or user gallery is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createOwnedScratch,cleanupBrowserTest} from './browser-cleanup.mjs';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const root=path.resolve(process.env.QC_CAMERA_ACQUISITION_ROOT||path.resolve(import.meta.dirname,'..'));
const output=process.env.QC_CAMERA_ACQUISITION_OUTPUT||path.resolve(root,'test-results/camera-acquisition');
const fixtures=process.env.QUIET_CAMERA_REVIEW_FIXTURES||path.resolve(root,'tests/fixtures');
fs.mkdirSync(output,{recursive:true});
const scratch=createOwnedScratch('quiet-camera-acquisition-');
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

// Read actual WebM TrackEntry elements, independent of the app's saved metadata
// and the MediaRecorder constructor audit. No external decoder is required.
function webmTracks(buffer) {
  const tracks=[];
  const vint=(offset,marker=false)=>{
    let length=1,mask=128;while(length<=8&&!(buffer[offset]&mask)){length++;mask>>=1;}
    if(length>8||offset+length>buffer.length)throw new Error('Invalid WebM element');
    let value=marker?buffer[offset]:buffer[offset]&(mask-1);
    for(let i=1;i<length;i++)value=value*256+buffer[offset+i];
    return{length,value};
  };
  const entries=(start,end)=>{
    const list=[];
    while(start<end){const id=vint(start,true),size=vint(start+id.length),data=start+id.length+size.length,next=Math.min(end,data+size.value);if(next<=start)throw new Error('Invalid WebM length');list.push({id:id.value,data,end:next});start=next;}
    return list;
  };
  const scan=(start,end)=>{for(const entry of entries(start,end)){
    if(entry.id===0x18538067||entry.id===0x1654ae6b)scan(entry.data,entry.end);
    else if(entry.id===0xae){const children=entries(entry.data,entry.end),type=children.find(x=>x.id===0x83),codec=children.find(x=>x.id===0x86);tracks.push({type:type?buffer[type.data]:null,codec:codec?buffer.subarray(codec.data,codec.end).toString():null});}
  }};
  scan(0,buffer.length);return tracks;
}
const ready=()=>until('!!state.stream&&!state.cameraStartPending&&!state.cameraTransitioning&&elements.video.readyState>=2&&!elements.shutterButton.disabled',14000);
const change=async(id,value)=>evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
const reset=async({mode='video',mic='off',ratio='16:9',preference=mic==='on'?'auto':'off',decision=mic==='on'?'on':'off'}={})=>{
  await evaluate(`state.cameraStartGeneration++;state.cameraStartPending=false;stopCamera();QuietCameraEnhancements.endPreviewTransition();if(elements.cameraPermissionDialog.open)elements.cameraPermissionDialog.close();if(elements.settingsDialog.open)elements.settingsDialog.close();state.mode=${JSON.stringify(mode)};state.microphonePreference=${JSON.stringify(preference)};state.microphoneDecision=${JSON.stringify(decision)};state.videoRatio=${JSON.stringify(ratio)};state.timerSeconds=0;state.busy=false;state.selectedDeviceId='synthetic-rear';state.facingMode='environment';elements.microphoneSelect.value=${JSON.stringify(mic)};elements.videoResolutionSelect.value='720';elements.videoFrameRateSelect.value='30';elements.videoQualitySelect.value='economy';elements.recordingLimitSelect.value='10';window.__delay=80;window.__failure=null;window.__audioFailure=null;window.__failures=[];window.__dropAudio=false;window.__forceRecorderFailure=false;setControlsDisabled(false);updateModeUi();`);
};
const begin=async()=>evaluate('void(window.__start=startCamera())');
const recordings=[];
async function record(name,audioExpected){
  const previous=await evaluate('countStoredMedia()');
  await evaluate('startRecording()');
  check(name+' recorder starts',await evaluate('state.recorder?.state'),'recording');
  check(name+' recorder input tracks',await evaluate('state.recorder.stream.getAudioTracks().length'),audioExpected?1:0);
  check(name+' recording badge describes tracks',await evaluate('elements.recordingAudioState.textContent'),audioExpected?'音声あり':'音声なし');
  // A wall-clock delay does not prove that a busy encoder received a frame.
  // Require two nonempty dataavailable chunks to be committed before stopping;
  // the saved container and its audio tracks are still checked independently.
  await until('state.recorder?.state==="recording"&&state.recordingChunkIndex>=2&&state.recordingBytes>0',15000);
  await evaluate('state.recordingWriteQueue');
  const progress=await evaluate('({chunks:state.recordingChunkIndex,bytes:state.recordingBytes,emittedBytes:state.recordingEmittedBytes,events:__audit.recorders.at(-1).data})');
  check(name+' nonempty chunks committed before stop',progress.chunks>=2&&progress.bytes>0&&progress.events.filter(event=>event.size>0).length>=2,true);
  await evaluate('stopRecording()');
  await until(`!state.recordingFinalizing&&state.galleryTotalCount===${previous+1}`,20000);
  const saved=await evaluate(`(async()=>{const m=await getStoredMedia(state.recordingMediaId);return{id:m.id,audio:m.audio,meta:m.meta,data:Array.from(new Uint8Array(await m.blob.arrayBuffer()))}})()`);
  check(name+' saved audio metadata',saved.audio,audioExpected);
  check(name+' saved text',saved.meta.includes(audioExpected?'音声あり':'音声なし'),true);
  const bytes=Buffer.from(saved.data),tracks=webmTracks(bytes);
  check(name+' encoded video track',tracks.some(t=>t.type===1),true);
  check(name+' encoded audio track',tracks.some(t=>t.type===2),audioExpected);
  fs.writeFileSync(path.join(output,name+'.webm'),bytes);
  recordings.push({name,size:bytes.length,tracks,audio:saved.audio,meta:saved.meta,progress});
}
let audit;
const documentAudits=[];
const closeSynthetic=()=>evaluate('(async()=>{for(const stream of window.__streams||[])stream.getTracks().forEach(track=>track.stop());for(const timer of window.__paintTimers||[])clearInterval(timer);await window.__audio?.close()})()');
try{
  const {browserContextId}=await command('Target.createBrowserContext');
  for(const name of ['camera','microphone'])await command('Browser.setPermission',{permission:{name},setting:'denied',browserContextId});
  const{targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});
  ({sessionId}=await command('Target.attachToTarget',{targetId,flatten:true}));
  await cdp('Page.enable');await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:393,height:800,deviceScaleFactor:1,mobile:true});
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__audit={nativeMediaCalls:0,requests:[],recorders:[],toasts:[],dialogs:[]};
    window.__forbiddenNativeMedia=()=>{__audit.nativeMediaCalls++;throw new Error('Physical media is forbidden in this test')};
    Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:options=>window.__openSynthetic(options),enumerateDevices:async()=>[{kind:'videoinput',deviceId:'synthetic-rear',label:'Synthetic rear'},{kind:'videoinput',deviceId:'synthetic-front',label:'Synthetic front'}],getSupportedConstraints:()=>({aspectRatio:true,resizeMode:true}),addEventListener(){}}});
    Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({waiting:null,addEventListener(){}}),addEventListener(){}}});
    Object.defineProperty(window,'ImageCapture',{value:undefined,configurable:true});
    const NativeRecorder=MediaRecorder;window.MediaRecorder=new Proxy(NativeRecorder,{construct(target,args){if(window.__forceRecorderFailure)throw new TypeError('Synthetic recorder constructor failed');const audit={audio:args[0].getAudioTracks().length,video:args[0].getVideoTracks().length,data:[]};__audit.recorders.push(audit);const recorder=Reflect.construct(target,args,target);recorder.addEventListener('dataavailable',event=>audit.data.push({size:event.data?.size||0,time:performance.now()}));return recorder}});
  `});
  await cdp('Page.navigate',{url});
  await until('document.readyState==="complete"&&!!window.QuietCameraEnhancements?.enhancedStartCamera');
  check('page load never acquires camera or microphone',await evaluate('__audit.requests.length'),0);
  const installSynthetic=()=>evaluate(`(async()=>{
    window.__streams=[];window.__paintTimers=[];window.__audio=new AudioContext();await __audio.resume();
    window.__newAudioTrack=()=>{const oscillator=__audio.createOscillator(),destination=__audio.createMediaStreamDestination();oscillator.frequency.value=440;oscillator.connect(destination);oscillator.start();return destination.stream.getAudioTracks()[0]};
    window.__openSynthetic=async options=>{
      const request={options:structuredClone(options),delay:__delay};__audit.requests.push(request);
      const failure=__failures.shift()||__failure||(options.audio&&__audioFailure),dropAudio=__dropAudio;
      await new Promise(r=>setTimeout(r,request.delay));if(failure)throw new DOMException('Synthetic media failure',failure);
      const c=document.createElement('canvas');c.width=640;c.height=Math.round(c.width/(options.video.aspectRatio?.exact||16/9));
      const x=c.getContext('2d');request.frames=0;const paint=()=>{x.fillStyle='#346d65';x.fillRect(0,0,c.width,c.height);x.fillStyle='#fff';x.fillRect(20,20,90,70);x.fillStyle='#efb347';x.fillRect((request.frames++%40)*12,110,10,30)};paint();
      const stream=c.captureStream(30),track=stream.getVideoTracks()[0],settings=track.getSettings.bind(track);
      const timer=setInterval(()=>{if(track.readyState!=='live'){clearInterval(timer);return;}paint();track.requestFrame?.()},33);__paintTimers.push(timer);
      track.getSettings=()=>({...settings(),deviceId:'synthetic-rear',facingMode:'environment',frameRate:30});track.getCapabilities=()=>({});track.applyConstraints=async()=>{};
      if(options.audio&&!dropAudio)stream.addTrack(__newAudioTrack());
      __streams.push(stream);request.audio=stream.getAudioTracks().length;request.completed=true;return stream;
    };
    const originalToast=showToast;showToast=message=>{__audit.toasts.push(message);originalToast(message)};
    const originalPermissionDialog=showCameraPermissionDialog;showCameraPermissionDialog=()=>{__audit.dialogs.push('cameraPermission');return originalPermissionDialog()};
    pickRecorderMimeType=()=>{if(!MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus'))throw new Error('Required synthetic WebM support unavailable');return 'video/webm;codecs=vp8,opus'};
  })()`);
  await installSynthetic();

  await reset({mode:'photo',preference:'auto',decision:'unresolved'});
  await evaluate('window.__delay=350;window.__audioFailure="NotAllowedError";window.__requestCount=__audit.requests.length;window.__dialogCount=__audit.dialogs.length;void(window.__video=setMode("video"))');await sleep(40);
  await evaluate('void(window.__photo=setMode("photo"))');await evaluate('Promise.all([__video,__photo])');
  check('photo selected during first microphone prompt shares its refusal',await evaluate('[__audit.requests.length-__requestCount,__audit.dialogs.length-__dialogCount,state.mode,state.stream,elements.startButton.disabled,state.cameraStartPending]'),[1,0,'photo',null,false,false]);

  await reset({mode:'photo',preference:'auto',decision:'unresolved'});
  await evaluate('window.__audioFailure="NotAllowedError";window.__requestCount=__audit.requests.length;window.__dialogCount=__audit.dialogs.length;setMode("video")');
  check('first camera and microphone denial does not automatically request twice',await evaluate('[__audit.requests.length-__requestCount,__audit.dialogs.length-__dialogCount,state.stream,elements.startButton.disabled,elements.permissionPanel.hidden]'),[1,0,null,false,false]);
  await evaluate('window.__requestCount=__audit.requests.length;startCamera()');await ready();
  check('explicit camera retry after denial requests video only',await evaluate('__audit.requests.slice(__requestCount).map(r=>!!r.options.audio)'),[false]);

  for(const selected of ['', 'synthetic-rear']){
    await reset();await evaluate(`state.selectedDeviceId=${JSON.stringify(selected)};window.__failure='NotAllowedError';window.__before=__audit.requests.length`);
    await evaluate('startCamera()');
    check('permission refusal has one request '+(selected||'automatic'),await evaluate('__audit.requests.length-__before'),1);
    check('permission refusal allows manual retry',await evaluate('[elements.cameraPermissionDialog.open,elements.startButton.disabled,!!state.cameraStartPending]'),[true,false,false]);
  }
  await evaluate('window.__failure=null;elements.cameraPermissionDialog.close();startCamera()');await ready();
  check('explicit retry can recover',await evaluate('!!state.stream'),true);

  await reset({mode:'photo',ratio:'4:3'});await evaluate('window.__delay=350;window.__oldStreams=__streams.length;window.__toastStart=__audit.toasts.length');
  await begin();await sleep(40);await evaluate('void(window.__mode=setMode("video"))');await ready();await evaluate('Promise.all([__start,__mode])');
  check('initial mode switch honors selected ratio',await evaluate('[state.mode,state.videoRatio,Math.round(state.videoTrack.getSettings().width/state.videoTrack.getSettings().height*1000)]'),['video','4:3',1333]);
  check('initial mode switch has no false unsupported toast',await evaluate('__audit.toasts.slice(__toastStart).some(t=>t.includes("対応しない"))'),false);
  check('obsolete initial streams stopped',await evaluate('__streams.slice(__oldStreams,-1).every(s=>s.getTracks().every(t=>t.readyState==="ended"))'),true);

  await reset({ratio:'4:3'});await evaluate('window.__delay=350');await begin();await sleep(40);await evaluate('void(window.__ratio=cycleRatio())');await ready();await evaluate('Promise.all([__start,__ratio])');
  check('ratio changes during initial acquisition apply to tracks',await evaluate('[state.videoRatio,state.videoTrack.getSettings().width===state.videoTrack.getSettings().height]'),['1:1',true]);

  await reset();await begin();await ready();await evaluate('window.__delay=350;window.__oldStreams=__streams.length');
  await change('microphoneSelect','on');await sleep(45);await change('microphoneSelect','off');await ready();await sleep(420);
  check('ON to OFF race drops obsolete audio',await evaluate('[elements.microphoneStatusText.textContent,state.stream.getAudioTracks().length,__streams.slice(__oldStreams,-1).every(s=>s.getTracks().every(t=>t.readyState==="ended"))]'),['OFF',0,true]);
  await record('mic-off-race',false);

  await evaluate('window.__delay=350');await change('videoResolutionSelect','1080');await sleep(45);await change('microphoneSelect','on');await ready();await sleep(420);
  check('ON during resolution acquisition gets audio',await evaluate('[elements.microphoneStatusText.textContent,state.stream.getAudioTracks().filter(t=>t.readyState==="live").length]'),['ON',1]);
  await record('mic-on-race',true);

  await change('microphoneSelect','off');await ready();
  await evaluate('elements.settingsButton.click();elements.microphoneSelect.focus()');
  const key=async(name,code)=>{await cdp('Input.dispatchKeyEvent',{type:'rawKeyDown',key:name,code:name,windowsVirtualKeyCode:code});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:name,code:name,windowsVirtualKeyCode:code});};
  await key('ArrowDown',40);await until('elements.microphoneSelect.value==="on"');
  check('keyboard ON actually requested an audio stream',await evaluate('__audit.requests.at(-1).options.audio!==false'),true);
  await sleep(45);await key('ArrowUp',38);await until('elements.microphoneSelect.value==="off"');await sleep(50);await evaluate('elements.closeSettingsButton.click()');await ready();await sleep(420);
  check('keyboard rapid MIC switch ends OFF without audio',await evaluate('[elements.microphoneSelect.value,state.stream.getAudioTracks().length]'),['off',0]);
  await record('mic-off-keyboard',false);

  await evaluate('state.stream.addTrack(__newAudioTrack())');
  check('defensive OFF test contains unexpected source audio',await evaluate('state.stream.getAudioTracks().length'),1);
  await record('mic-off-defensive',false);

  await reset({mic:'on'});await evaluate('window.__dropAudio=true');await begin();await ready();
  await evaluate('window.__recorderCount=__audit.recorders.length;startRecording()');
  check('MIC ON without audio refuses before recorder',await evaluate('[__audit.recorders.length-__recorderCount,state.busy,!!state.recorder,elements.microphoneSelect.disabled,elements.toast.textContent.includes("マイクの音声を取得できません")]'),[0,false,false,false,true]);
  check('missing-audio refusal leaves no recording session',await evaluate('listRecordingSessions().then(s=>s.length)'),0);

  await reset({mic:'on'});await begin();await ready();await evaluate('state.stream.getAudioTracks()[0].enabled=false;window.__recorderCount=__audit.recorders.length;startRecording()');
  check('disabled audio refuses recording',await evaluate('[__audit.recorders.length-__recorderCount,elements.toast.textContent.includes("マイクの音声を取得できません")]'),[0,true]);
  await evaluate('state.stream.getAudioTracks()[0].enabled=true;state.timerSeconds=3;window.__requestCount=__audit.requests.length;void(window.__record=startRecording())');
  await until('elements.countdown.textContent==="3"');
  check('countdown locks all mutable recording settings',await evaluate('[elements.microphoneSelect,elements.cameraSourceSelect,elements.videoResolutionSelect,elements.videoFrameRateSelect,elements.videoQualitySelect,elements.recordingLimitSelect,elements.ratioButton,elements.photoModeButton,elements.focusResetButton,elements.shutterButton].every(e=>e.disabled)'),true);
  await evaluate('(async()=>{elements.cameraSourceSelect.dispatchEvent(new Event("change"));await startCamera();await QuietCameraEnhancements.resetFocus();await setMode("photo");await cycleRatio()})()');
  check('countdown blocks camera restart and mode changes',await evaluate('[__audit.requests.length-__requestCount,state.mode,state.videoRatio]'),[0,'video','16:9']);
  await evaluate('__record');check('countdown starts one valid recorder',await evaluate('[state.recorder.state,state.recordingAudioEnabled,state.recordingLimitMs]'),['recording',true,600000]);
  await sleep(1100);await evaluate('stopRecording({cancel:true})');await until('!state.recordingFinalizing');

  await evaluate('window.__recorderCount=__audit.recorders.length;void(window.__record=startRecording())');await until('elements.countdown.textContent==="3"');
  await evaluate('state.stream.getAudioTracks()[0].stop()');await evaluate('__record');
  check('audio ending during countdown refuses safely',await evaluate('[__audit.recorders.length-__recorderCount,state.busy,elements.toast.textContent.includes("マイクの音声を取得できません")]'),[0,false,true]);

  await reset();await begin();await ready();await evaluate('window.__forceRecorderFailure=true;startRecording()');
  check('recorder failure uses Japanese guidance',await evaluate('[elements.toast.textContent.includes("録画を開始できませんでした"),elements.toast.textContent.includes("Synthetic"),state.busy,elements.microphoneSelect.disabled]'),[true,false,false,false]);
  check('constructor failure leaves no recording session',await evaluate('listRecordingSessions().then(s=>s.length)'),0);

  await reset();await evaluate('window.__failures=["OverconstrainedError"];window.__requestCount=__audit.requests.length');await begin();await ready();
  check('constraint failure still uses fallback',await evaluate('__audit.requests.length-__requestCount>=2'),true);

  await reset({mic:'on'});
  await evaluate('window.__requestCount=__audit.requests.length;window.__oldStreams=__streams.length;const originalPlay=elements.video.play;elements.video.play=function(){this.play=originalPlay;return Promise.reject(new DOMException("Synthetic playback failure","NotAllowedError"))};startCamera()');
  check('playback failure does not turn granted microphone into a refusal',await evaluate('[__audit.requests.length-__requestCount,state.microphoneDecision,elements.microphoneSelect.value,state.stream,elements.shutterButton.disabled,__streams.slice(__oldStreams).every(s=>s.getTracks().every(t=>t.readyState==="ended"))]'),[1,'on','on',null,true,true]);
  await evaluate('startCamera()');await ready();
  check('retry after playback failure retains requested audio',await evaluate('[!!__audit.requests.at(-1).options.audio,state.stream.getAudioTracks().length,elements.microphoneSelect.value]'),[true,1,'on']);

  await reset({mode:'photo',preference:'auto',decision:'unresolved'});await begin();await ready();
  await evaluate('window.__failures=["OverconstrainedError","NotAllowedError"];window.__requestCount=__audit.requests.length;window.__dialogCount=__audit.dialogs.length;setMode("video")');await ready();
  check('device fallback followed by microphone refusal adds no application dialog',await evaluate('[__audit.requests.slice(__requestCount).map(r=>!!r.options.audio),__audit.dialogs.length-__dialogCount,state.microphoneDecision,elements.microphoneSelect.value,state.stream.getAudioTracks().length]'),[[true,true,false],0,'denied','off',0]);

  // A legacy microphone:"off" value was written for every old session. Only
  // the new explicit preference may suppress the first video-mode request.
  await reset({mode:'photo',preference:'auto',decision:'unresolved'});
  await evaluate('window.__requestCount=__audit.requests.length;window.__dialogCount=__audit.dialogs.length');await begin();await ready();
  check('photo startup requests video without audio',await evaluate('__audit.requests.slice(__requestCount).map(r=>!!r.options.audio)'),[false]);
  await evaluate('window.__requestCount=__audit.requests.length;window.__delay=350;void(window.__mode=setMode("video"))');await sleep(45);
  check('video selection requests audio before recording',await evaluate('[__audit.requests.length-__requestCount,!!__audit.requests.at(-1).options.audio,!!state.cameraStartPending]'),[1,true,true]);
  await evaluate('window.__recorderCount=__audit.recorders.length;startRecording()');
  check('permission acquisition cannot start an early recorder',await evaluate('[elements.shutterButton.disabled,__audit.recorders.length-__recorderCount]'),[true,0]);
  await evaluate('__mode');await ready();
  check('granted video entry exposes live microphone',await evaluate('[elements.microphoneSelect.value,state.stream.getAudioTracks().filter(t=>t.readyState==="live").length]'),['on',1]);
  check('video entry adds no application confirmation',await evaluate('__audit.dialogs.length-__dialogCount'),0);
  await record('video-entry-with-audio',true);

  await change('microphoneSelect','off');await ready();
  check('manual OFF is recorded as an explicit preference',await evaluate('[state.microphonePreference,JSON.parse(localStorage.getItem("quiet-camera-settings-v3")).microphonePreference]'),['off','off']);
  await evaluate('window.__requestCount=__audit.requests.length;setMode("photo")');await ready();await evaluate('setMode("video")');await ready();
  check('manual OFF survives photo and video switches',await evaluate('[elements.microphoneSelect.value,__audit.requests.slice(__requestCount).every(r=>r.options.audio===false),state.stream.getAudioTracks().length]'),['off',true,0]);
  await change('microphoneSelect','on');await ready();
  check('manual ON removes only the explicit OFF preference',await evaluate('(()=>{const s=JSON.parse(localStorage.getItem("quiet-camera-settings-v3"));return[state.microphonePreference,Object.hasOwn(s,"microphonePreference"),s.microphone,s.videoResolution,s.recordingLimit]})()'),['auto',false,'off','720','10']);

  await reset({mode:'photo',preference:'auto',decision:'unresolved'});await begin();await ready();
  await evaluate('window.__audioFailure="NotAllowedError";window.__requestCount=__audit.requests.length;window.__dialogCount=__audit.dialogs.length;setMode("video")');await ready();
  check('microphone denial restores an already allowed camera once',await evaluate('__audit.requests.slice(__requestCount).map(r=>!!r.options.audio)'),[true,false]);
  check('microphone denial uses audio-free video and truthful status',await evaluate('[state.mode,state.microphoneDecision,elements.microphoneSelect.value,state.stream.getAudioTracks().length,document.querySelector(".microphone-status-current").textContent.trim()]'),['video','denied','off',0,'音声なし']);
  check('microphone denial adds no application permission dialog',await evaluate('[__audit.dialogs.length-__dialogCount,elements.cameraPermissionDialog.open]'),[0,false]);
  await record('video-entry-microphone-denied',false);
  await evaluate('window.__requestCount=__audit.requests.length;setMode("photo")');await ready();await evaluate('setMode("video")');await ready();
  check('denial does not request microphone again on mode cycles',await evaluate('__audit.requests.slice(__requestCount).every(r=>r.options.audio===false)'),true);
  await evaluate('window.__audioFailure=null;window.__requestCount=__audit.requests.length');await change('microphoneSelect','on');await ready();
  check('explicit ON retries after a denial',await evaluate('[__audit.requests.length-__requestCount,!!__audit.requests.at(-1).options.audio,elements.microphoneSelect.value,state.stream.getAudioTracks().length,state.microphonePreference]'),[1,true,'on',1,'auto']);



  await reset({mode:'photo',preference:'auto',decision:'unresolved'});await begin();await ready();
  await evaluate('window.__delay=350;window.__oldStreams=__streams.length;void(window.__mode=setMode("video"))');await sleep(45);await evaluate('void(window.__photo=setMode("photo"))');await evaluate('Promise.all([__mode,__photo])');await ready();
  check('returning to photo during permission acquisition stops obsolete audio',await evaluate('[state.mode,state.stream.getAudioTracks().length,__streams.slice(__oldStreams,-1).every(s=>s.getTracks().every(t=>t.readyState==="ended"))]'),['photo',0,true]);

  await reset({mode:'photo',preference:'auto',decision:'unresolved'});await begin();await ready();
  await evaluate('window.__delay=350;window.__audioFailure="NotAllowedError";window.__requestCount=__audit.requests.length;void(window.__video=setMode("video"))');await sleep(40);
  await evaluate('window.__delay=60;void(window.__photo=setMode("photo"))');await evaluate('__photo');await ready();await evaluate('__video');
  check('late microphone refusal is remembered after photo has resumed',await evaluate('[state.mode,state.microphoneDecision,elements.microphoneSelect.value,state.stream.getAudioTracks().length]'),['photo','denied','off',0]);
  await evaluate('setMode("video")');await ready();
  check('late refusal suppresses the next automatic microphone request',await evaluate('__audit.requests.slice(__requestCount).filter(r=>r.options.audio).length'),1);

  await reset({mode:'photo',preference:'auto',decision:'unresolved'});await begin();await ready();
  await evaluate('window.__delay=350;window.__oldStreams=__streams.length;void(window.__mode=setMode("video"))');await sleep(45);await change('microphoneSelect','off');await evaluate('__mode');await ready();await sleep(420);
  check('manual OFF wins over a late initial microphone grant',await evaluate('[state.microphonePreference,elements.microphoneSelect.value,state.stream.getAudioTracks().length,__streams.slice(__oldStreams,-1).every(s=>s.getTracks().every(t=>t.readyState==="ended"))]'),['off','off',0,true]);

  await reset({mode:'photo',preference:'auto',decision:'unresolved'});await begin();await ready();
  await evaluate('window.__delay=350;window.__audioFailure="NotAllowedError";window.__requestCount=__audit.requests.length;window.__dialogCount=__audit.dialogs.length;void(window.__first=setMode("video"))');await sleep(40);
  await evaluate('void(window.__photo=setMode("photo"))');await sleep(40);await evaluate('void(window.__last=setMode("video"))');await evaluate('Promise.all([__first,__photo,__last])');await ready();
  check('rapid video photo video shares the pending microphone refusal',await evaluate('[__audit.requests.slice(__requestCount).filter(r=>r.options.audio).length,state.mode,state.microphoneDecision,elements.microphoneSelect.value,state.stream.getAudioTracks().length,__audit.dialogs.length-__dialogCount]'),[1,'video','denied','off',0,0]);
  check('rapid refused mode changes leave only the active camera stream',await evaluate('__streams.filter(s=>s.getTracks().some(t=>t.readyState==="live")).length'),1);
  await change('microphoneSelect','off');await ready();

  const reloadApplication=async()=>{
    documentAudits.push(await evaluate('__audit'));await closeSynthetic();
    await cdp('Page.navigate',{url:url+'?reload='+documentAudits.length});
    await until('document.readyState==="complete"&&!!window.QuietCameraEnhancements?.enhancedStartCamera');
    check('reload does not access camera or microphone '+documentAudits.length,await evaluate('__audit.requests.length'),0);
    await installSynthetic();
    await evaluate('window.__delay=80;window.__failure=null;window.__audioFailure=null;window.__failures=[];window.__dropAudio=false');
  };
  await evaluate('window.__savedBeforeReload=localStorage.getItem("quiet-camera-settings-v3")');
  const savedManualOff=await evaluate('__savedBeforeReload');await reloadApplication();
  check('manual OFF survives a real page reload without rewriting settings',await evaluate('[state.microphonePreference,elements.microphoneSelect.value,localStorage.getItem("quiet-camera-settings-v3")]'),['off','off',savedManualOff]);
  await evaluate('window.__requestCount=__audit.requests.length;startCamera()');await ready();
  check('restored manual OFF starts video without audio',await evaluate('__audit.requests.slice(__requestCount).map(r=>!!r.options.audio)'),[false]);
  await evaluate('localStorage.setItem("quiet-camera-settings-v3",JSON.stringify({mode:"video",microphone:"off"}))');await reloadApplication();
  check('legacy automatic OFF does not mean manual OFF',await evaluate('[state.mode,state.microphonePreference,state.microphoneDecision,elements.microphoneSelect.value]'),['video','auto','unresolved','off']);
  await evaluate('window.__requestCount=__audit.requests.length;startCamera()');await ready();
  check('restored video requests audio only after explicit camera start',await evaluate('[__audit.requests.length-__requestCount,!!__audit.requests.at(-1).options.audio,state.stream.getAudioTracks().length]'),[1,true,1]);

  await shot('ready-after-regressions.png');
  documentAudits.push(await evaluate('__audit'));
  audit={nativeMediaCalls:documentAudits.reduce((n,a)=>n+a.nativeMediaCalls,0),requests:documentAudits.flatMap(a=>a.requests),recorders:documentAudits.flatMap(a=>a.recorders),toasts:documentAudits.flatMap(a=>a.toasts),dialogs:documentAudits.flatMap(a=>a.dialogs),documents:documentAudits.length};check('real camera microphone never called',audit.nativeMediaCalls,0);check('no uncaught browser exceptions',exceptions.length,0);
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:true,checks:results,recordings,audit,exceptions,limits:['PC Chromium, generated canvas video and WebAudio oscillator only.','Physical camera/microphone permissions denied. No device or OS share/save UI exercised.','Encoded WebM tracks are inspected independently of application metadata.']},null,2));
  console.log(JSON.stringify({passed:true,checks:results.length,output,audit:{nativeMediaCalls:audit.nativeMediaCalls}}));
}catch(error){
  await shot('failure.png').catch(()=>{});
  audit=await evaluate('window.__audit').catch(()=>null);
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:false,error:error.stack,checks:results,recordings,audit,exceptions,debug:await evaluate('({pending:state.cameraStartPending,busy:state.busy,mode:state.mode,mic:elements.microphoneSelect.value,ratio:state.videoRatio,status:elements.cameraStatus.textContent,toast:elements.toast.textContent,recorderState:state.recorder?.state,recordingChunks:state.recordingChunkIndex,recordingBytes:state.recordingBytes,emittedBytes:state.recordingEmittedBytes,audioContext:window.__audio?.state,visibility:document.visibilityState})').catch(()=>null)},null,2));console.error(error);process.exitCode=1;
}finally{
  await closeSynthetic().catch(()=>{});
  await cleanupBrowserTest({scratch,chrome,socket,command,server,output,pending});
}
