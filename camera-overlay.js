"use strict";

(() => {
  const root=document.documentElement,surface=document.querySelector("#cameraSurface");
  if(!surface)return;
  const model=window.QuietCameraDeviceLayout,controls=surface.querySelector("#cameraControls");
  const stage=elements.cameraStage,selector=surface.querySelector(".mode-switcher");
  const modeRow=surface.querySelector(".mode-control-row"),microphone=elements.microphoneStatusButton;
  const toolbar=surface.querySelector(".camera-top-controls"),capture=surface.querySelector(".bottom-controls");
  const status=controls.querySelector(".status-bar");
  const label=document.createElement("span");label.id="previewFrameLabel";label.className="preview-frame-label";
  stage.append(label);
  const guide=document.querySelector("#photoFrameGuide"),context=document.createElement("canvas").getContext("2d");
  let frame=0,quarter=0;
  const px=(name,value)=>surface.style.setProperty(name,`${Math.max(0,value)}px`);
  // Chromium's native horizontal range still uses the viewport X axis when
  // its ancestor is rotated. Map pointer movement to the visible track axis.
  // Keyboard input continues to use the native range implementation.
  const range=elements.zoomRange;
  let zoomPointer=null;
  function endZoomPointer(){
    if(zoomPointer!==null&&range.hasPointerCapture(zoomPointer))range.releasePointerCapture(zoomPointer);
    zoomPointer=null;
  }
  function pointZoom(event){
    const r=range.getBoundingClientRect(),q=Number(surface.dataset.deviceRotation)||0;
    const length=q===90||q===270?r.height:r.width;
    const position=q===90?r.bottom-event.clientY:q===270?event.clientY-r.top:event.clientX-r.left;
    // The thumb center travels inside half a thumb at each end.
    const inset=Math.min(8,length/2),fraction=Math.max(0,Math.min(1,(position-inset)/Math.max(1,length-2*inset)));
    const value=Number(range.min)+fraction*(Number(range.max)-Number(range.min));
    range.value=String(value);
    range.dispatchEvent(new Event("input",{bubbles:true}));
  }
  range.addEventListener("pointerdown",event=>{
    if(!root.classList.contains("overlay-camera-layout")||range.disabled||event.button!==0)return;
    if(zoomPointer!==null){endZoomPointer();return;}
    event.preventDefault();range.focus({preventScroll:true});zoomPointer=event.pointerId;
    range.setPointerCapture(event.pointerId);pointZoom(event);
  });
  range.addEventListener("pointermove",event=>{if(event.pointerId===zoomPointer){event.preventDefault();pointZoom(event);}});
  for(const name of ["pointerup","pointercancel","lostpointercapture"])range.addEventListener(name,event=>{
    if(event.pointerId!==zoomPointer)return;
    if(name==="pointerup"){event.preventDefault();pointZoom(event);range.dispatchEvent(new Event("change",{bubbles:true}));}
    endZoomPointer();
  });
  window.addEventListener("blur",endZoomPointer);
  window.addEventListener("orientationchange",endZoomPointer);
  screen.orientation?.addEventListener("change",endZoomPointer);
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
    const pcControls=style.getPropertyValue("--pc-controls-enabled").trim()==="1";
    const safe=model.insets({top:parseFloat(style.paddingTop)||0,right:parseFloat(style.paddingRight)||0,bottom:parseFloat(style.paddingBottom)||0,left:parseFloat(style.paddingLeft)||0},quarter);
    px("--device-width",size.width);px("--device-height",size.height);
    for(const edge of ["top","right","bottom","left"])px(`--device-safe-${edge}`,safe[edge]);
    surface.style.setProperty("--device-matrix",model.matrix(size.width,size.height,quarter));
    surface.style.setProperty("--device-ink-turn",`${quarter*90}deg`);
    surface.dataset.deviceRotation=String(quarter*90);
    for(const button of controls.querySelectorAll(".mode-switcher>button,.camera-top-controls>button,.bottom-controls>button:not(#shutterButton),#microphoneStatusButton"))upright(button);
    for(const readout of controls.querySelectorAll(".recording-metric,#recordingAudioState,.zoom-control>label,.zoom-control>output"))upright(readout);
    upright(status);
    // Coordinates stay attached to the physical portrait device. The video
    // itself stays upright; no camera track or capture processing is rotated.
    const controlsWidth=Math.max(1,size.width-Math.max(8,safe.left)-Math.max(8,safe.right));
    const rootFont=parseFloat(getComputedStyle(root).fontSize)||16,desiredMicFont=rootFont*.75;
    const micFont=getComputedStyle(elements.microphoneStatusText);
    if(context)context.font=`${micFont.fontWeight} ${desiredMicFont}px ${micFont.fontFamily}`;
    const textWidth=context?.measureText("MIC OFF").width||desiredMicFont*4.7;
    const maxMicWidth=Math.max(44,(controlsWidth-98)/2-6);
    const micWidth=Math.min(maxMicWidth,Math.max(64,Math.ceil(textWidth+12)));
    const micTextWidth=quarter%2?44:micWidth-12;
    const measuredMicWidth=pcControls?Math.max(micWidth,parseFloat(getComputedStyle(microphone).width)||0):micWidth;
    px("--overlay-mic-width",measuredMicWidth);
    px("--overlay-mic-font-size",desiredMicFont*Math.min(1,micTextWidth/Math.max(1,textWidth)));
    px("--overlay-mode-width",Math.max(98,Math.min(240,controlsWidth-2*(measuredMicWidth+6))));
    const reservedMicHeight=Math.max(54,Math.ceil(rootFont*.65*1.05+desiredMicFont*1.05+11));
    const modeHeight=Math.max(54,selector.getBoundingClientRect()[quarter%2?"width":"height"],reservedMicHeight,pcControls?parseFloat(getComputedStyle(microphone).height)||0:0);
    px("--overlay-mode-height",modeHeight);
    const immersive=root.classList.contains("immersive-mode");
    const immersiveClearance=pcControls?toolbar.querySelector("#fullscreenButton").getBoundingClientRect()[quarter%2?"width":"height"]+8:56;
    const modeTop=Math.max(8,safe.top)+(immersive?immersiveClearance:0);
    px("--overlay-mode-top",modeTop);px("--overlay-toolbar-top",modeTop+modeHeight+8);
    const toolbarHeight=toolbar.getBoundingClientRect()[quarter%2?"width":"height"];
    px("--overlay-recording-top",modeTop+modeHeight+(immersive?8:toolbarHeight+16));
    const captureHeight=capture.getBoundingClientRect()[quarter%2?"width":"height"];
    if(context){
      const font=getComputedStyle(elements.zoomValue);
      context.font=`${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
      px("--zoom-readout-width",Math.max(42,Math.ceil(context.measureText(`${Number(range.max||1).toFixed(1)}×`).width)+8));
    }
    px("--overlay-zoom-bottom",Math.max(8,safe.bottom)+captureHeight+20);
    // Reserve the complete counter-rotated readout footprint, not the thin
    // original span boxes. Keep both fields readable above the zoom control.
    const ink=status.firstElementChild;
    const inkBox=ink.getBoundingClientRect();
    const extent=Math.ceil(Math.max(inkBox.width,inkBox.height))+8;
    px("--overlay-status-extent",extent);
    const zoomHeight=elements.zoomControl.hidden?0:elements.zoomControl.getBoundingClientRect()[quarter%2?"width":"height"];
    px("--overlay-status-bottom",Math.max(8,safe.bottom)+captureHeight+(zoomHeight?20+zoomHeight+8:8));
    // Measure actual button and slider hit areas in the fixed portrait plane.
    // Landscape alone uses the space between controls and ends before zoom.
    // Portrait retains the v3 frame geometry; photo cropping is a separate
    // presentation policy and does not require moving or shrinking that frame.
    const surfaceBox=surface.getBoundingClientRect();
    const inverse=new DOMMatrixReadOnly(model.matrix(size.width,size.height,quarter)).inverse();
    const canonicalBox=element=>{
      const r=element.getBoundingClientRect();
      const points=[[r.left,r.top],[r.right,r.top],[r.left,r.bottom],[r.right,r.bottom]].map(([x,y])=>inverse.transformPoint({x:x-surfaceBox.left,y:y-surfaceBox.top}));
      const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
      return {top:Math.min(...ys),bottom:Math.max(...ys)};
    };
    let start=safe.top,end=size.height-safe.bottom;
    for(const button of controls.querySelectorAll("button")){
      const r=button.getBoundingClientRect();
      if(!r.width||!r.height||getComputedStyle(button).visibility==="hidden")continue;
      const b=canonicalBox(button);
      if(button.closest(".bottom-controls"))end=Math.min(end,b.top-4);
      else start=Math.max(start,b.bottom+4);
    }
    if(!elements.zoomControl.hidden&&elements.zoomControl.getBoundingClientRect().width)end=Math.min(end,canonicalBox(elements.zoomControl).top-4);
    const region={x:safe.left,y:start,width:Math.max(0,size.width-safe.left-safe.right),height:Math.max(0,end-start)};
    const [a,b]=(state.mode==="video"?state.videoRatio:state.ratio).split(":").map(Number);
    let aspect=b/a;
    const held=stage.querySelector(".camera-transition-frame");
    const sw=elements.video.videoWidth||held?.width,sh=elements.video.videoHeight||held?.height;
    if(state.mode==="video"&&sw&&sh)aspect=quarter%2?sh/sw:sw/sh;
    const canonical=quarter%2?model.fitRegion(region,aspect):model.fit(size.width,size.height,safe,b/a,quarter).canonical;
    const box=model.rect(canonical,size.width,size.height,quarter);
    px("--overlay-frame-x",box.x);px("--overlay-frame-y",box.y);
    px("--overlay-frame-width",box.width);px("--overlay-frame-height",box.height);
    surface.dataset.previewAvailable=String(quarter%2?region.height>0:true);
    stage.dataset.previewPolicy=state.mode==="photo"?"saved-crop":"full-stream";
    const deliveredRatio=sw&&sh?window.QuietCameraRatioModel.closestRatioLabel(Math.max(sw/sh,sh/sw)):state.videoRatio;
    const text=state.mode==="photo"?`写真の保存範囲 ${state.ratio}`:`動画・映像全体 ${deliveredRatio}`;
    if(label.textContent!==text)label.textContent=text;
    label.hidden=state.mode==="photo";
    // The restored portrait frame sits behind the top controls. Keep the
    // saved-range notice readable without moving the frame or any control.
    label.style.top=`${quarter===0?Math.max(6,start+2-box.y):6}px`;
    stage.setAttribute("aria-label",text);
    guide.hidden=true; // The photo frame itself is now the announced saved crop.
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(layout);}
  window.QuietCameraOverlay={schedule};
  for(const event of ["resize","orientationchange","quietcamera:immersivechange"])window.addEventListener(event,schedule,{passive:true});
  screen.orientation?.addEventListener("change",schedule);
  window.visualViewport?.addEventListener("resize",schedule,{passive:true});
  window.visualViewport?.addEventListener("scroll",schedule,{passive:true});
  for(const event of ["loadedmetadata","resize"])elements.video.addEventListener(event,()=>{
    if(state.mode==="video"&&state.stream&&!state.cameraTransitioning&&elements.video.readyState>=2&&elements.video.videoWidth&&elements.video.videoHeight){
      syncVideoRatioWithTrack({aspectRatio:elements.video.videoWidth/elements.video.videoHeight});
    }
    schedule();
  });
  new MutationObserver(schedule).observe(stage,{attributes:true,attributeFilter:["class","data-capture-mode"]});
  new MutationObserver(schedule).observe(controls,{childList:true,characterData:true,subtree:true});
  new MutationObserver(schedule).observe(root,{attributes:true,attributeFilter:["class","style"]});
  if(typeof ResizeObserver==="function"){
    const observer=new ResizeObserver(schedule);
    for(const element of [modeRow,selector,microphone,toolbar,surface,elements.zoomControl,capture])observer.observe(element);
  }
  layout();
})();
