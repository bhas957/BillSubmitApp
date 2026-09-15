const sharp = require("sharp");

/**
 * Decodes any sharp-readable input into a plain RGBA raw buffer, since the
 * effect functions all do their own pixel math and don't want to think
 * about codecs.
 */
async function toRawRGBA(input) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** Wraps a raw RGBA buffer back into a sharp instance. */
function fromRawRGBA(data, width, height) {
  return sharp(data, { raw: { width, height, channels: 4 } });
}

/** Allocates a transparent RGBA buffer of the given size. */
function blankRGBA(width, height) {
  return Buffer.alloc(width * height * 4);
}

module.exports = { toRawRGBA, fromRawRGBA, blankRGBA };
