const { randRange } = require("../utils/random");

function clamp(v) {
  return Math.max(0, Math.min(255, v));
}

/** Darkens toward the corners, like a phone camera's natural vignette. */
function applyVignette(raw, width, height, strength) {
  const cx = width / 2;
  const cy = height / 2;
  const maxDist = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy) / maxDist;
      const falloff = 1 - strength * Math.pow(dist, 2.2);
      const idx = (y * width + x) * 4;
      raw[idx] = clamp(raw[idx] * falloff);
      raw[idx + 1] = clamp(raw[idx + 1] * falloff);
      raw[idx + 2] = clamp(raw[idx + 2] * falloff);
    }
  }
}

/** Adds a soft bright patch at a random spot, like flash glare/reflection. */
function applyFlashBloom(raw, width, height, strength) {
  const bx = randRange(width * 0.2, width * 0.8);
  const by = randRange(height * 0.15, height * 0.65);
  const radius = randRange(width, width * 1.6) * 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - bx;
      const dy = y - by;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const falloff = Math.max(0, 1 - dist / radius);
      const boost = strength * falloff * falloff * 255;
      if (boost <= 0) continue;
      const idx = (y * width + x) * 4;
      raw[idx] = clamp(raw[idx] + boost);
      raw[idx + 1] = clamp(raw[idx + 1] + boost);
      raw[idx + 2] = clamp(raw[idx + 2] + boost);
    }
  }
}

/**
 * A soft directional brightness gradient across the whole frame, like
 * uneven ambient/overhead light. Deliberately a plain linear gradient —
 * not shaped like any object.
 */
function applyUnevenLighting(raw, width, height, strength) {
  const angle = randRange(0, Math.PI * 2);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const diag = Math.sqrt(width * width + height * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const proj = (x * dx + y * dy) / diag; // roughly -0.7..0.7
      const factor = 1 + strength * proj;
      const idx = (y * width + x) * 4;
      raw[idx] = clamp(raw[idx] * factor);
      raw[idx + 1] = clamp(raw[idx + 1] * factor);
      raw[idx + 2] = clamp(raw[idx + 2] * factor);
    }
  }
}

module.exports = { applyVignette, applyFlashBloom, applyUnevenLighting };
