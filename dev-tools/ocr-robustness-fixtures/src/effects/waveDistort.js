const { randRange } = require("../utils/random");

/**
 * Displaces each row horizontally by a sine wave, simulating a receipt
 * that isn't lying perfectly flat. Operates on a raw RGBA buffer and
 * returns a same-size buffer; edge pixels are clamped rather than left
 * transparent since this runs before the image is placed on the canvas.
 */
function applyWaveDistort(raw, width, height, cfg) {
  const amplitude = randRange(1, cfg.maxAmplitudePx);
  const wavelength = randRange(cfg.wavelengthRangePx[0], cfg.wavelengthRangePx[1]);
  const phase = randRange(0, Math.PI * 2);

  const out = Buffer.alloc(raw.length);
  for (let y = 0; y < height; y++) {
    const shift = amplitude * Math.sin((2 * Math.PI * y) / wavelength + phase);
    for (let x = 0; x < width; x++) {
      let sx = x - shift;
      sx = Math.max(0, Math.min(width - 1, sx));
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, width - 1);
      const fx = sx - x0;

      const rowOffset = y * width;
      const srcIdx0 = (rowOffset + x0) * 4;
      const srcIdx1 = (rowOffset + x1) * 4;
      const dstIdx = (rowOffset + x) * 4;
      for (let c = 0; c < 4; c++) {
        out[dstIdx + c] = raw[srcIdx0 + c] * (1 - fx) + raw[srcIdx1 + c] * fx;
      }
    }
  }
  return out;
}

module.exports = { applyWaveDistort };
