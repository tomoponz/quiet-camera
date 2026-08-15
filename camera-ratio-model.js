"use strict";

(() => {
  const RATIO_SEQUENCE = Object.freeze(["4:3", "1:1", "16:9"]);

  function ratioValue(ratio) {
    if (ratio === "1:1") return 1;
    if (ratio === "16:9") return 16 / 9;
    return 4 / 3;
  }

  function targetTrackAspectRatio(ratio) {
    // UI labels use the long-edge:short-edge ratio. Portrait track settings may
    // report its reciprocal, which normalizedTrackAspectRatio handles below.
    return ratioValue(ratio);
  }

  function normalizedTrackAspectRatio(settings = {}) {
    const reported = Number(settings.aspectRatio);
    const width = Number(settings.width);
    const height = Number(settings.height);
    const rawRatio = Number.isFinite(reported) && reported > 0
      ? reported
      : Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
        ? width / height
        : 0;
    return rawRatio > 0 ? Math.max(rawRatio, 1 / rawRatio) : null;
  }

  function approximatelyMatches(first, second, tolerance = 0.035) {
    return Number.isFinite(first)
      && Number.isFinite(second)
      && Math.abs(first - second) / second <= tolerance;
  }

  function closestRatioLabel(actualRatio) {
    if (!Number.isFinite(actualRatio) || actualRatio <= 0) return null;
    return RATIO_SEQUENCE.reduce((closest, candidate) => (
      Math.abs(ratioValue(candidate) - actualRatio) < Math.abs(ratioValue(closest) - actualRatio)
        ? candidate
        : closest
    ), RATIO_SEQUENCE[0]);
  }

  const api = {
    RATIO_SEQUENCE,
    ratioValue,
    targetTrackAspectRatio,
    normalizedTrackAspectRatio,
    approximatelyMatches,
    closestRatioLabel,
  };

  if (typeof window !== "undefined") window.QuietCameraRatioModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
