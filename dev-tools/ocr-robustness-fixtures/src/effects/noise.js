function clamp(v) {
  return Math.max(0, Math.min(255, v));
}

/** Standard Box-Muller transform for approximately-gaussian random values. */
function gaussianRandom() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Adds per-pixel gaussian grain, simulating high-ISO sensor noise. */
function applySensorNoise(raw, width, height, amountStdDev) {
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const n = gaussianRandom() * amountStdDev;
    raw[idx] = clamp(raw[idx] + n);
    raw[idx + 1] = clamp(raw[idx + 1] + n);
    raw[idx + 2] = clamp(raw[idx + 2] + n);
  }
}

module.exports = { applySensorNoise };
