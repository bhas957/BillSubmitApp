const fs = require("fs");
const path = require("path");
const config = require("../config");
const { renderPdfPages } = require("./pdfRender");
const { processImage } = require("./pipeline");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

async function main() {
  const inputDir = path.resolve(__dirname, "..", config.inputDir);
  const outputDir = path.resolve(__dirname, "..", config.outputDir);

  if (!fs.existsSync(inputDir)) {
    console.error(`Input directory not found: ${inputDir}`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(outputDir, { recursive: true });

  const files = fs
    .readdirSync(inputDir)
    .filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()) || path.extname(f).toLowerCase() === ".pdf");

  if (files.length === 0) {
    console.log(`No .pdf/.png/.jpg/.jpeg files found in ${inputDir}`);
    return;
  }

  let generated = 0;
  for (const file of files) {
    const fullPath = path.join(inputDir, file);
    const ext = path.extname(file).toLowerCase();
    const baseName = path.basename(file, ext);

    try {
      if (ext === ".pdf") {
        const pages = await renderPdfPages(fullPath, config.pdfRenderDensity);
        for (let i = 0; i < pages.length; i++) {
          const outBuffer = await processImage(pages[i], config);
          const suffix = pages.length > 1 ? `-p${i + 1}` : "";
          const outPath = path.join(outputDir, `${baseName}${suffix}.jpg`);
          fs.writeFileSync(outPath, outBuffer);
          console.log(`Wrote ${outPath}`);
          generated++;
        }
      } else {
        const inputBuffer = fs.readFileSync(fullPath);
        const outBuffer = await processImage(inputBuffer, config);
        const outPath = path.join(outputDir, `${baseName}.jpg`);
        fs.writeFileSync(outPath, outBuffer);
        console.log(`Wrote ${outPath}`);
        generated++;
      }
    } catch (err) {
      console.error(`Failed on ${file}: ${err.message}`);
    }
  }

  console.log(`Done. ${generated} fixture image(s) written to ${outputDir}`);
}

main();
