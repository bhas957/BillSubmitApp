// Builds public/MyHealthReports/data/health-data.json from the lab-report PDFs
// in public/MyHealthReports/pdf/Blood Tests (Thyrocare / PharmEasy layout).
//
//   npm run health:build
//
// The PDFs print the test name, value, unit and range in a different column
// order every year, so for each marker we find the line carrying its label,
// strip out ranges and units, and keep the number that is left. Single-test
// pages put the value on a "unit<TAB>value" line just above the label, so that
// is the fallback. Anything still wrong can be fixed by hand in
// data/overrides.json:  { "2026-10-19": { "t3": 75 } }   (null removes a value).
//
// Both the PDFs and the generated data are personal, so they are git-ignored.
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const MARKERS = require('./markers');

const ROOT = path.resolve(__dirname, '../../public/MyHealthReports');
const BLOOD_DIR = path.join(ROOT, 'pdf', 'Blood Tests');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_FILE = path.join(DATA_DIR, 'health-data.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'overrides.json');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const SKIP_LINE = /^(Method|Clinical|Kit|Specifications|Reference|Disclaimer)|Available|Ready|significance|causes|indicate|\t(Good|Low|High)\s*$/i;
// "ng/dL<TAB>336" or "E.C.L.I.A 273" just above the label (single-test pages)
const VALUE_ABOVE = /^(?:[^\t\d]*[a-zA-Zµμ%][^\t]*\t|[A-Z][A-Z.\- ]*\s)\s*(\d+(?:\.\d+)?)\s*$/;
// "5.5<TAB>H.P.L.C %" just below the label (HbA1c pages)
const VALUE_BELOW = /^(\d+(?:\.\d+)?)\t[A-Z]/;

async function pdfText(file) {
  const parser = new PDFParse({ data: fs.readFileSync(file) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

function collectedDate(text, fileName) {
  const m = text.match(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (20\d\d)\b/i);
  if (m) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const f = fileName.match(/_(20\d\d)_(\d{1,2})/);
  return f ? `${f[1]}-${f[2].padStart(2, '0')}-01` : null;
}

function numbersLeft(line, label) {
  const rest = line
    .replace(label, ' ')
    .replace(/mL\/min\/1\.73 ?m2/gi, ' ')
    .replace(/X 10[³^]\d?\s*\/\s*[μµ]L|10\^6\/[μµ]L/gi, ' ')
    .replace(/\d+:\d+\s*-\s*\d+:\d+/g, ' ')
    .replace(/[<>]\s*=?\s*\d+(\.\d+)?/g, ' ')
    .replace(/\d+(\.\d+)?\s*[-–]\s*\d+(\.\d+)?/g, ' ');
  return rest.match(/(?<![\w.:/-])\d+(\.\d+)?(?![\w.:/])/g) || [];
}

function findValue(lines, marker) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!marker.label.test(line) || SKIP_LINE.test(line)) continue;
    if (marker.notLabel && marker.notLabel.test(line)) continue;
    const nums = numbersLeft(line, marker.label);
    if (nums.length) return Number(nums[0]);
    if (line.length > 70) continue;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const m = lines[j].match(VALUE_ABOVE);
      if (m) return Number(m[1]);
    }
    const below = (lines[i + 1] || '').match(VALUE_BELOW);
    if (below) return Number(below[1]);
  }
  return null;
}

function readOverrides() {
  if (!fs.existsSync(OVERRIDES_FILE)) return {};
  return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
}

async function main() {
  const files = fs.readdirSync(BLOOD_DIR).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  const overrides = readOverrides();
  const reports = [];

  for (const file of files) {
    const text = await pdfText(path.join(BLOOD_DIR, file));
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const date = collectedDate(text, file);
    const values = {};
    for (const m of MARKERS) {
      if (m.label) {
        const v = findValue(lines, m);
        if (v !== null) values[m.key] = v;
      }
    }
    Object.assign(values, overrides[date] || {});
    for (const m of MARKERS) {
      if (m.derived) {
        const v = m.derived(values);
        if (v !== null) values[m.key] = v;
      }
      if (values[m.key] === null) delete values[m.key];
    }
    reports.push({ date, file: `Blood Tests/${file}`, partial: /PARTIAL/i.test(file), values });
    console.log(`${date}  ${String(Object.keys(values).length).padStart(2)} markers  ${file}`);
  }

  reports.sort((a, b) => a.date.localeCompare(b.date));
  const markers = MARKERS.map(({ label, notLabel, derived, ...rest }) => ({ ...rest, derived: Boolean(derived) }));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), markers, reports }, null, 2));
  console.log(`\nWrote ${path.relative(process.cwd(), OUT_FILE)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
