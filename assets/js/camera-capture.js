"use strict";

(() => {
  const Q = window.QuietCameraEnhancements;

  // Photo capture now lives in photo.js. Keep this module only as the enhancement-layer
  // adapter so there is a single canonical capture implementation.
  Q.enhancedCapturePhoto = capturePhoto;
  Q.getVisibleTargetRatio = getVisiblePhotoRatio;
})();
