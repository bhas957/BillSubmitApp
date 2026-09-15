/**
 * Tunables for the fixture generator. Every effect has a `probability`
 * (0-1 chance it's applied to a given image) and a range/strength knob.
 * Randomization keeps a batch from producing only one kind of degradation.
 */
module.exports = {
  // Where to read clean source files from / write generated fixtures to,
  // relative to this package's root.
  inputDir: "input",
  outputDir: "output",

  // Resolution used when rasterizing PDF pages before any effects run.
  pdfRenderDensity: 220, // DPI

  // Random rotation + corner jitter, simulating a hand-held camera angle.
  perspective: {
    probability: 0.9,
    maxRotationDeg: 4,
    maxCornerShiftPct: 0.06, // fraction of image width/height per corner
  },

  // Gentle horizontal sine-wave displacement, simulating paper that isn't
  // perfectly flat.
  waveDistort: {
    probability: 0.35,
    maxAmplitudePx: 5,
    wavelengthRangePx: [220, 480],
  },

  // Padding (as a fraction of the receipt's longest edge) added around the
  // receipt before compositing it onto a background canvas.
  background: {
    paddingPct: [0.18, 0.4],
    tint: {
      // Randomized between a light desk and a darker wood tone.
      rMin: 150, rMax: 225,
      gMin: 140, gMax: 210,
      bMin: 120, bMax: 190,
    },
  },

  vignette: {
    probability: 0.7,
    strength: [0.15, 0.4], // 0 = no darkening, 1 = fully black corners
  },

  flashBloom: {
    probability: 0.3,
    strength: [0.1, 0.3],
  },

  // Soft directional light gradient across the page (uneven overhead
  // lighting) — intentionally generic, not shaped like an object or hand.
  unevenLighting: {
    probability: 0.5,
    strength: [0.08, 0.3],
  },

  lensBlur: {
    probability: 0.55,
    sigma: [0.3, 1.4],
  },

  sensorNoise: {
    probability: 0.8,
    amount: [3, 12], // stddev of added grain, 0-255 scale
  },

  // Final output mimics a phone photo: long edge in this range, re-encoded
  // as JPEG with randomized quality (lower quality adds compression noise).
  outputLongEdgePx: [1600, 2600],
  jpegQuality: [68, 92],
};
