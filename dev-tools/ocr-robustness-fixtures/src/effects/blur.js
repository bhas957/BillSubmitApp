/** Gaussian defocus blur, simulating a slightly out-of-focus camera shot. */
function applyLensBlur(sharpImage, sigma) {
  return sharpImage.blur(sigma);
}

module.exports = { applyLensBlur };
