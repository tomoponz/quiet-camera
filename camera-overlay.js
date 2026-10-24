"use strict";

(() => {
  const root=document.documentElement,surface=document.querySelector("#cameraSurface");
  if(!surface)return;
  const model=window.QuietCameraDeviceLayout,controls=surface.querySelector("#cameraControls");
  const stage=elements.cameraStage,selector=surface.querySelector(".mode-switcher");
  const modeRow=surface.querySelector(".mode-control-row"),microphone=elements.microphoneStatusButton;
  const toolbar=surface.querySelector(".camera-top-controls"),capture=surface.querySelector(".bottom-controls");
  const guide=document.querySelector("#photoFrameGuide"),context=document.createElement("canvas").getContext("2d");
  let frame=0,quarter=0;
  const px=(name,value)=>surface.style.setProperty(name,`${Math.max(0,value)}px`);
  function upright(element){
    if(element.childNodes.length===1&&element.firstElementChild?.classList.contains("device-upright"))return;
    const span=document.createElement("span");span.className="device-upright";
    span.append(...element.childNodes);element.append(span);
  }
  function layout(){
    frame=0;
    const view=window.visualViewport,height=view?.height||innerHeight,width=view?.width||innerWidth;
    px("--camera-view-height",height);px("--camera-view-width",width);
    px("--camera-view-top",view?.offsetTop||0);px("--camera-view-left",view?.offsetLeft||0);
    quarter=model.rotation({type:screen.orientation?.type,angle:screen.orientation?.angle,legacyAngle:window.orientation,width,height,previous:quarter});
    const size=model.size(width,height,quarter),style=getComputedStyle(surface);
    const safe=model.insets({top:parseFloat(style.paddingTop)||0,right:parseFloat(style.paddingRight)||0,bottom:parseFloat(style.paddingBottom)||0,left:parseFloat(style.paddingLeft)||0},quarter);
    px("--device-width",size.width);px("--device-height",size.height);
    for(const edge of ["top","right","bottom","left"])px(`--device-safe-${edge}`,safe[edge]);
    surface.style.setProperty("--device-matrix",model.matrix(size.width,size.height,quarter));
    surface.style.setProperty("--device-ink-turn",`${quarter*90}deg`);
    surface.dataset.deviceRotation=String(quarter*90);
    for(const button of controls.querySelectorAll(".mode-switcher>button,.camera-top-controls>button,.bottom-controls>button:not(#shutterButton),#microphoneStatusButton"))upright(button);
    for(const readout of controls.querySelectorAll(".status-bar>span,.recording-metric,#recordingAudioState,.zoom-control>label,.zoom-control>output"))upright(readout);
    // Coordinates stay attached to the physical portrait device. The video
    // itself stays upright; no camera track or capture processing is rotated.
    const [a,b]=(state.mode==="video"?state.videoRatio:state.ratio).split(":").map(Number);
    const fitted=model.fit(size.width,size.height,safe,b/a,quarter),box=fitted.viewport;
    px("--overlay-frame-x",box.x);px("--overlay-frame-y",box.y);
    px("--overlay-frame-width",box.width);px("--overlay-frame-height",box.height);
    const controlsWidth=Math.max(1,size.width-Math.max(8,safe.left)-Math.max(8,safe.right));
    const rootFont=parseFloat(getComputedStyle(root).fontSize)||16,desiredMicFont=rootFont*.75;
    const micFont=getComputedStyle(elements.microphoneStatusText);
    if(context)context.font=`${micFont.fontWeight} ${desiredMicFont}px ${micFont.fontFamily}`;
    const textWidth=context?.measureText("MIC OFF").width||desiredMicFont*4.7;
    const maxMicWidth=Math.max(44,(controlsWidth-98)/2-6);
    const micWidth=Math.min(maxMicWidth,Math.max(64,Math.ceil(textWidth+12)));
    const micTextWidth=quarter%2?44:micWidth-12;
    px("--overlay-mic-width",micWidth);
    px("--overlay-mic-font-size",desiredMicFont*Math.min(1,micTextWidth/Math.max(1,textWidth)));
    px("--overlay-mode-width",Math.max(98,Math.min(240,controlsWidth-2*(micWidth+6))));
    const reservedMicHeight=Math.max(54,Math.ceil(rootFont*.65*1.05+desiredMicFont*1.05+11));
    const modeHeight=Math.max(54,selector.getBoundingClientRect()[quarter%2?"width":"height"],reservedMicHeight);
    px("--overlay-mode-height",modeHeight);
    const immersive=root.classList.contains("immersive-mode");
    const modeTop=Math.max(8,safe.top)+(immersive?56:0);
    px("--overlay-mode-top",modeTop);px("--overlay-toolbar-top",modeTop+modeHeight+8);
    const toolbarHeight=toolbar.getBoundingClientRect()[quarter%2?"width":"height"];
    px("--overlay-recording-top",modeTop+modeHeight+(immersive?8:toolbarHeight+16));
    const captureHeight=capture.getBoundingClientRect()[quarter%2?"width":"height"];
    px("--overlay-zoom-bottom",Math.max(8,safe.bottom)+captureHeight+20);
    px("--overlay-status-bottom",Math.max(8,safe.bottom)+captureHeight+2);
    const sw=elements.video.videoWidth,sh=elements.video.videoHeight,aspect=box.width/box.height;
    guide.hidden=state.mode!=="photo"||!sw||!sh;
    if(!guide.hidden){
      const scale=Math.min(box.width/sw,box.height/sh),crop=calculateCrop(sw,sh,aspect);
      guide.hidden=crop.sw===sw&&crop.sh===sh;
      Object.assign(guide.style,{left:`${(box.width-sw*scale)/2+crop.sx*scale}px`,top:`${(box.height-sh*scale)/2+crop.sy*scale}px`,width:`${crop.sw*scale}px`,height:`${crop.sh*scale}px`});
    }
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(layout);}
  window.QuietCameraOverlay={schedule};
  for(const event of ["resize","orientationchange","quietcamera:immersivechange"])window.addEventListener(event,schedule,{passive:true});
  screen.orientation?.addEventListener("change",schedule);
  window.visualViewport?.addEventListener("resize",schedule,{passive:true});
  window.visualViewport?.addEventListener("scroll",schedule,{passive:true});
  for(const event of ["loadedmetadata","resize"])elements.video.addEventListener(event,schedule);
  new MutationObserver(schedule).observe(stage,{attributes:true,attributeFilter:["class","data-capture-mode"]});
  new MutationObserver(schedule).observe(controls,{childList:true,characterData:true,subtree:true});
  new MutationObserver(schedule).observe(root,{attributes:true,attributeFilter:["class","style"]});
  if(typeof ResizeObserver==="function"){
    const observer=new ResizeObserver(schedule);
    for(const element of [modeRow,selector,microphone,toolbar,surface])observer.observe(element);
  }
  layout();
})();
