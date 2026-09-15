/**
 * Minimal planar homography (perspective transform) implementation.
 * No native deps (no opencv) — just solves the standard 8-equation linear
 * system for a 3x3 projective matrix mapping 4 source points to 4
 * destination points, then samples the inverse transform with bilinear
 * interpolation. Good enough for warping a receipt-sized image; not meant
 * for anything performance-critical.
 */

/** Solves the linear system Ax = b via Gaussian elimination with partial pivoting. */
function solveLinearSystem(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivotRow][col])) pivotRow = r;
    }
    [M[col], M[pivotRow]] = [M[pivotRow], M[col]];

    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-12) continue; // degenerate; leave as-is
    for (let c = col; c <= n; c++) M[col][c] /= pivot;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

/** Computes the 3x3 homography mapping src[i] -> dst[i] for 4 point pairs. Returns a 9-element array (row-major, h[8] = 1). */
function computeHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  const h = solveLinearSystem(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("Singular homography matrix");
  const invDet = 1 / det;
  return [A, D, G, B, E, H, C, F, I].map((v) => v * invDet);
}

function applyHomography(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  const px = (m[0] * x + m[1] * y + m[2]) / w;
  const py = (m[3] * x + m[4] * y + m[5]) / w;
  return [px, py];
}

function bilinearSample(data, width, height, x, y) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;

  const out = new Array(4);
  for (let c = 0; c < 4; c++) {
    const i00 = (y0 * width + x0) * 4 + c;
    const i10 = (y0 * width + x1) * 4 + c;
    const i01 = (y1 * width + x0) * 4 + c;
    const i11 = (y1 * width + x1) * 4 + c;
    const top = data[i00] * (1 - fx) + data[i10] * fx;
    const bottom = data[i01] * (1 - fx) + data[i11] * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
  return out;
}

/**
 * Warps `src` (raw RGBA, srcW x srcH) so its four corners land on
 * `dstQuad` (array of 4 [x,y] points) within a canvasW x canvasH output.
 * Pixels outside the quad are left fully transparent so the result can be
 * composited straight onto a background.
 */
function warpToQuad(src, srcW, srcH, dstQuad, canvasW, canvasH) {
  const srcCorners = [
    [0, 0],
    [srcW - 1, 0],
    [srcW - 1, srcH - 1],
    [0, srcH - 1],
  ];
  const forward = computeHomography(srcCorners, dstQuad);
  const inverse = invert3x3(forward);

  const xs = dstQuad.map((p) => p[0]);
  const ys = dstQuad.map((p) => p[1]);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const maxX = Math.min(canvasW - 1, Math.ceil(Math.max(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(canvasH - 1, Math.ceil(Math.max(...ys)));

  const out = Buffer.alloc(canvasW * canvasH * 4);

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const [sx, sy] = applyHomography(inverse, x + 0.5, y + 0.5);
      const sample = bilinearSample(src, srcW, srcH, sx, sy);
      if (!sample) continue;
      const idx = (y * canvasW + x) * 4;
      out[idx] = sample[0];
      out[idx + 1] = sample[1];
      out[idx + 2] = sample[2];
      out[idx + 3] = 255;
    }
  }
  return out;
}

module.exports = { computeHomography, invert3x3, applyHomography, warpToQuad };
