const { warpToQuad } = require("./homography");
const { randRange } = require("../utils/random");

function rotatePoint([x, y], cx, cy, angleRad) {
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

/**
 * Places the source image inside a canvasW x canvasH transparent frame,
 * centered in a `rect`, then applies a small random rotation plus
 * independent per-corner jitter so it reads as "photographed at a slight
 * angle" rather than perfectly scanned.
 */
function applyPerspective(srcRaw, srcW, srcH, rect, canvasW, canvasH, cfg) {
  const angle = (randRange(-cfg.maxRotationDeg, cfg.maxRotationDeg) * Math.PI) / 180;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  let corners = [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y],
    [rect.x + rect.w, rect.y + rect.h],
    [rect.x, rect.y + rect.h],
  ].map((p) => rotatePoint(p, cx, cy, angle));

  const maxShiftX = rect.w * cfg.maxCornerShiftPct;
  const maxShiftY = rect.h * cfg.maxCornerShiftPct;
  corners = corners.map(([x, y]) => [
    x + randRange(-maxShiftX, maxShiftX),
    y + randRange(-maxShiftY, maxShiftY),
  ]);

  return warpToQuad(srcRaw, srcW, srcH, corners, canvasW, canvasH);
}

module.exports = { applyPerspective };
