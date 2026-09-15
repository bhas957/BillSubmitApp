const { randRange, randInt } = require("../utils/random");

/**
 * Procedurally generates a neutral desk/table backdrop (no external image
 * assets needed) so the warped receipt isn't composited over blank white.
 * Uses a randomized base tint, a couple of low-frequency sine terms for
 * soft mottling, and light per-pixel grain.
 */
function generateBackground(width, height, cfg) {
  const r0 = randInt(cfg.tint.rMin, cfg.tint.rMax);
  const g0 = randInt(cfg.tint.gMin, cfg.tint.gMax);
  const b0 = randInt(cfg.tint.bMin, cfg.tint.bMax);

  const freqX = randRange(0.005, 0.015);
  const freqY = randRange(0.005, 0.015);
  const phaseX = randRange(0, Math.PI * 2);
  const phaseY = randRange(0, Math.PI * 2);
  const mottleStrength = randRange(6, 16);

  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const mottle =
        Math.sin(x * freqX + phaseX) * Math.cos(y * freqY + phaseY) * mottleStrength;
      const grain = (Math.random() - 0.5) * 6;
      const idx = (y * width + x) * 4;
      out[idx] = clamp(r0 + mottle + grain);
      out[idx + 1] = clamp(g0 + mottle + grain);
      out[idx + 2] = clamp(b0 + mottle + grain);
      out[idx + 3] = 255;
    }
  }
  return out;
}

function clamp(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

module.exports = { generateBackground };
