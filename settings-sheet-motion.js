"use strict";

// CSS pixels / millisecond. Recent motion, not total pull distance, determines
// flick intent. Kept independent from DOM timing so boundary cases are testable.
((root) => {
  const WINDOW_MS = 100;
  const IDLE_MS = 80;
  const SPEED = 0.75;
  const TRAVEL = 40;

  function releaseIntent(samples, now) {
    const byTime = new Map();
    for (const sample of samples) {
      if ([sample.time, sample.x, sample.y].every(Number.isFinite) && sample.time <= now) byTime.set(sample.time, sample);
    }
    const points = [...byTime.values()].sort((a, b) => a.time - b.time);
    const idle = { action: "resize", velocity: 0, travel: 0, span: 0, samples: 0 };
    let lastMotion = null;
    let lastDirection = 0;
    for (let i = 1; i < points.length; i += 1) {
      const dy = points[i].y - points[i - 1].y;
      if (Math.abs(dy) >= 0.5) lastMotion = points[i].time;
      if (Math.abs(dy) >= 2) lastDirection = Math.sign(dy);
    }
    if (lastMotion === null || now - lastMotion > IDLE_MS) return idle;
    const recent = points.filter(point => point.time >= now - WINDOW_MS);
    if (recent.length < 3) return idle;
    const first = recent[0], last = recent.at(-1);
    const span = last.time - first.time;
    if (span < 24) return idle;
    const meanTime = recent.reduce((sum, point) => sum + point.time - first.time, 0) / recent.length;
    const meanY = recent.reduce((sum, point) => sum + point.y, 0) / recent.length;
    let numerator = 0, denominator = 0;
    for (const point of recent) {
      const dt = point.time - first.time - meanTime;
      numerator += dt * (point.y - meanY);
      denominator += dt * dt;
    }
    const velocity = denominator ? numerator / denominator : 0;
    const travel = last.y - first.y;
    const deliberate = Math.abs(travel) >= TRAVEL
      && Math.abs(travel) > Math.abs(last.x - first.x) * 1.5
      && Math.sign(velocity) === lastDirection
      && Math.sign(travel) === lastDirection;
    const action = deliberate && Math.abs(velocity) + 1e-9 >= SPEED
      ? velocity > 0 ? "dismiss" : "expand"
      : "resize";
    return { action, velocity, travel, span, samples: recent.length };
  }

  const model = { releaseIntent, WINDOW_MS, IDLE_MS, SPEED, TRAVEL };
  if (typeof module === "object" && module.exports) module.exports = model;
  else root.QuietCameraSheetMotion = model;
})(typeof window === "object" ? window : globalThis);
