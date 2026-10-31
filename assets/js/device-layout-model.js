"use strict";

((root, factory) => {
  const model = factory();
  if (typeof module === "object" && module.exports) module.exports = model;
  else root.QuietCameraDeviceLayout = model;
})(typeof window === "object" ? window : globalThis, () => {
  const turn = angle => ((Math.round(angle / 90) % 4) + 4) % 4;
  function rotation({ type, angle, legacyAngle, width, height, previous = 0 }) {
    if (/^(portrait|landscape)-(primary|secondary)$/.test(type || "")) {
      if (Number.isFinite(angle)) {
        const quarter = turn(angle);
        const naturalPortrait = type.startsWith("portrait") === (quarter % 2 === 0);
        return turn(angle - (naturalPortrait ? 0 : 90));
      }
      return { "portrait-primary":0, "landscape-primary":1, "portrait-secondary":2, "landscape-secondary":3 }[type];
    }
    if (Number.isFinite(legacyAngle)) return turn(legacyAngle);
    // Without orientation APIs, the viewport cannot reveal left vs right.
    return width > height ? (previous % 2 ? previous : 1) : 0;
  }
  function size(width, height, quarter) {
    return quarter % 2 ? { width:height, height:width } : { width, height };
  }
  function insets({ top=0, right=0, bottom=0, left=0 }, quarter) {
    return [
      { top, right, bottom, left },
      { top:left, right:top, bottom:right, left:bottom },
      { top:bottom, right:left, bottom:top, left:right },
      { top:right, right:bottom, bottom:left, left:top },
    ][quarter];
  }
  function rect({ x, y, width, height }, w, h, quarter) {
    return [
      { x, y, width, height },
      { x:y, y:w-x-width, width:height, height:width },
      { x:w-x-width, y:h-y-height, width, height },
      { x:h-y-height, y:x, width:height, height:width },
    ][quarter];
  }
  function matrix(w, h, quarter) {
    return ["matrix(1,0,0,1,0,0)", `matrix(0,-1,1,0,0,${w})`, `matrix(-1,0,0,-1,${w},${h})`, `matrix(0,1,-1,0,${h},0)`][quarter];
  }
  function fit(width, height, safe, aspect, quarter) {
    const usableWidth=Math.max(1,width-safe.left-safe.right),usableHeight=Math.max(1,height-safe.top-safe.bottom);
    const frameWidth=Math.min(usableWidth,usableHeight*aspect);
    const canonical={x:safe.left+(usableWidth-frameWidth)/2,y:safe.top,width:frameWidth,height:frameWidth/aspect};
    return { canonical, viewport:rect(canonical,width,height,quarter) };
  }
  function fitRegion(region, aspect) {
    const width=Math.max(0,region.width),height=Math.max(0,region.height);
    const fittedWidth=Math.min(width,height*aspect),fittedHeight=fittedWidth/aspect;
    return {x:region.x+(width-fittedWidth)/2,y:region.y+height-fittedHeight,width:fittedWidth,height:fittedHeight};
  }
  return { rotation, size, insets, rect, matrix, fit, fitRegion };
});
