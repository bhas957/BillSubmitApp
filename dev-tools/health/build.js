// Reads every report in public/MyHealthReports/pdf, parses the ones it hasn't
// seen before into data/records/<name>.json, renames each file to
// "YYYY-MM-DD_Provider_Test[_OrderId].pdf" in the right folder, and rebuilds
// data/health-records.json + data/health-data.json.
//
//   npm run health:build                 parse new files only
//   npm run health:build -- --force      re-parse everything that isn't locked
//   npm run health:build -- --rules      don't use Gemini (offline rule parser)
//   npm run health:build -- --no-rename  keep file names as they are
//   npm run health:build -- --prune      delete records whose file is gone
//
// Files are matched to records by content hash, so renaming or moving a PDF by
// hand never causes a re-parse. Uses GEMINI_API_KEY from .env when set.
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const H = require('../../healthRecords');

const ROOT = path.resolve(__dirname, '../../public/MyHealthReports');
const PDF_DIR = path.join(ROOT, 'pdf');
const DATA_DIR = path.join(ROOT, 'data');
const REC_DIR = path.join(DATA_DIR, 'records');
const REPORT_FILE = /\.(pdf|png|jpe?g)$/i;
const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

const args = new Set(process.argv.slice(2));
const gemini = !args.has('--rules') && process.env.GEMINI_API_KEY
  ? { apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_EXTRACT_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash' }
  : null;

const walk = (dir, base = '') => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []).flatMap((e) => {
  const rel = base ? `${base}/${e.name}` : e.name;
  if (e.isDirectory()) return walk(path.join(dir, e.name), rel);
  return REPORT_FILE.test(e.name) ? [rel] : [];
});

function loadRecords() {
  if (!fs.existsSync(REC_DIR)) return [];
  return fs.readdirSync(REC_DIR).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      return { ...JSON.parse(fs.readFileSync(path.join(REC_DIR, f), 'utf8')), _json: f };
    } catch (err) {
      throw new Error(`data/records/${f} is not valid JSON (${err.message}). Fix it and run again.`);
    }
  });
}

function freePath(folder, name, sha) {
  let candidate = name;
  for (let i = 2; ; i++) {
    const full = path.join(PDF_DIR, folder, candidate);
    if (!fs.existsSync(full) || H.sha256(fs.readFileSync(full)) === sha) return candidate;
    candidate = name.replace(/(\.[^.]+)$/, `-${i}$1`);
  }
}

async function main() {
  console.log(gemini ? `Parser: Gemini (${gemini.model}) + rules` : 'Parser: offline rules (set GEMINI_API_KEY for any-provider parsing)');
  const old = loadRecords();
  const bySha = new Map(old.map((r) => [r.sha256, r]));
  const seen = new Set();
  const records = [];
  let parsed = 0;
  let failed = 0;

  for (const rel of walk(PDF_DIR).sort()) {
    const full = path.join(PDF_DIR, rel);
    const buffer = fs.readFileSync(full);
    const sha = H.sha256(buffer);
    if (seen.has(sha)) {
      console.log(`  duplicate of an earlier file, skipped: ${rel}`);
      continue;
    }
    seen.add(sha);
    let rec = bySha.get(sha);
    if (!rec || (args.has('--force') && !rec.locked)) {
      try {
        const fresh = await H.parseReport({
          buffer,
          fileName: path.basename(rel),
          mimeType: MIME[path.extname(rel).toLowerCase()],
          gemini,
          passwords: (process.env.HEALTH_PDF_PASSWORDS || '').split(','),
          profile: H.profileFromPath(rel),
        });
        rec = { ...fresh, edits: rec?.edits, locked: rec?.locked, _json: rec?._json };
        parsed++;
      } catch (err) {
        failed++;
        console.error(`  ✗ ${rel}: ${err.message}`);
        if (!rec) continue;
      }
    }
    rec.profile = rec.profile || H.profileFromPath(rel);
    let target = rel;
    if (!args.has('--no-rename')) {
      const { folder, name } = H.canonicalPath(rec, path.extname(rel).toLowerCase());
      const free = freePath(folder, name, sha);
      target = `${folder}/${free}`;
      if (target !== rel) {
        fs.mkdirSync(path.join(PDF_DIR, folder), { recursive: true });
        fs.renameSync(full, path.join(PDF_DIR, folder, free));
        console.log(`  renamed  ${rel}\n       →  ${target}`);
      }
    }
    rec.file = target;
    rec.id = path.basename(target).replace(/\.[^.]+$/, '');
    records.push(rec);
    const e = H.effective(rec);
    const counts = rec.type === 'lab' ? `${Object.keys(e.values).length} markers, ${rec.results.length} results` : `${(rec.findings || []).length} findings`;
    console.log(`${e.date || '????-??-??'}  ${rec.type.padEnd(7)} ${counts.padEnd(26)} ${rec.extractedBy.padEnd(10)} ${target}`);
    for (const w of rec.warnings || []) console.log(`            ! ${w}`);
  }

  fs.mkdirSync(REC_DIR, { recursive: true });
  for (const rec of records) {
    const { _json, ...data } = rec;
    const file = `${rec.id}.json`;
    fs.writeFileSync(path.join(REC_DIR, file), `${JSON.stringify(data, null, 2)}\n`);
    if (_json && _json !== file) fs.rmSync(path.join(REC_DIR, _json), { force: true });
  }
  for (const r of old.filter((o) => !seen.has(o.sha256))) {
    if (args.has('--prune')) {
      fs.rmSync(path.join(REC_DIR, r._json));
      console.log(`  removed record for missing file: ${r.file}`);
    } else {
      console.log(`  ! record ${r._json} has no file any more (run with --prune to delete it)`);
      records.push(r);
    }
  }

  const combined = H.buildCombined(records.map(({ _json, ...r }) => r));
  fs.writeFileSync(path.join(DATA_DIR, 'health-records.json'), JSON.stringify(combined, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'health-data.json'), JSON.stringify(H.buildChartData(combined), null, 2));
  console.log(`\n${records.length} reports (${parsed} parsed now${failed ? `, ${failed} failed` : ''}). Wrote data/health-records.json and data/health-data.json`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
