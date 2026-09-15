const { fromPath } = require("pdf2pic");

/**
 * Rasterizes every page of a PDF to a PNG buffer at the given DPI.
 * Requires GraphicsMagick + Ghostscript to be installed and on PATH
 * (pdf2pic shells out to them) — see the README for setup.
 */
async function renderPdfPages(pdfPath, density) {
  const converter = fromPath(pdfPath, {
    density,
    format: "png",
    preserveAspectRatio: true,
  });

  try {
    const pages = await converter.bulk(-1, { responseType: "buffer" });
    return pages.map((p) => p.buffer);
  } catch (err) {
    throw new Error(
      `Failed to render "${pdfPath}" with pdf2pic. This tool needs GraphicsMagick ` +
        `and Ghostscript installed and on PATH. Original error: ${err.message}`
    );
  }
}

module.exports = { renderPdfPages };
