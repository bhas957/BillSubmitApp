// Downloads the IRV Telugu 2019 Bible (eBible.org "tel2017", CC BY-SA 4.0) and
// writes the reader's data files to public/bible/data/:
//   books.json                 66 books: code, Telugu + English names, verse counts
//   <BOOK>.json                { "1": ["verse 1", ...], ... }
//   plan-chronological.json    365 days, balanced by verse count
//
// Usage: npm run bible:fetch            (downloads the zip)
//        npm run bible:fetch -- --vpl path/to/tel2017_vpl.txt
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const chronologicalOrder = require('./chronological-order');

const VPL_ZIP_URL = 'https://eBible.org/Scriptures/tel2017_vpl.zip';
const OUT_DIR = path.resolve(__dirname, '../../public/bible/data');
const PLAN_DAYS = 365;

// BibleWorks codes as used in tel2017_vpl.txt, in canonical order.
const BOOKS = [
  ['GEN', 'ఆదికాండం', 'Genesis'], ['EXO', 'నిర్గమకాండం', 'Exodus'],
  ['LEV', 'లేవీయకాండం', 'Leviticus'], ['NUM', 'సంఖ్యాకాండం', 'Numbers'],
  ['DEU', 'ద్వితీయోపదేశకాండం', 'Deuteronomy'], ['JOS', 'యెహోషువ', 'Joshua'],
  ['JDG', 'న్యాయాధిపతులు', 'Judges'], ['RUT', 'రూతు', 'Ruth'],
  ['1SA', '1 సమూయేలు', '1 Samuel'], ['2SA', '2 సమూయేలు', '2 Samuel'],
  ['1KI', '1 రాజులు', '1 Kings'], ['2KI', '2 రాజులు', '2 Kings'],
  ['1CH', '1 దినవృత్తాంతాలు', '1 Chronicles'], ['2CH', '2 దినవృత్తాంతాలు', '2 Chronicles'],
  ['EZR', 'ఎజ్రా', 'Ezra'], ['NEH', 'నెహెమ్యా', 'Nehemiah'],
  ['EST', 'ఎస్తేరు', 'Esther'], ['JOB', 'యోబు', 'Job'],
  ['PSA', 'కీర్తనలు', 'Psalms'], ['PRO', 'సామెతలు', 'Proverbs'],
  ['ECC', 'ప్రసంగి', 'Ecclesiastes'], ['SOL', 'పరమగీతం', 'Song of Songs'],
  ['ISA', 'యెషయా', 'Isaiah'], ['JER', 'యిర్మీయా', 'Jeremiah'],
  ['LAM', 'విలాపవాక్యాలు', 'Lamentations'], ['EZE', 'యెహెజ్కేలు', 'Ezekiel'],
  ['DAN', 'దానియేలు', 'Daniel'], ['HOS', 'హోషేయ', 'Hosea'],
  ['JOE', 'యోవేలు', 'Joel'], ['AMO', 'ఆమోసు', 'Amos'],
  ['OBA', 'ఓబద్యా', 'Obadiah'], ['JON', 'యోనా', 'Jonah'],
  ['MIC', 'మీకా', 'Micah'], ['NAH', 'నహూము', 'Nahum'],
  ['HAB', 'హబక్కూకు', 'Habakkuk'], ['ZEP', 'జెఫన్యా', 'Zephaniah'],
  ['HAG', 'హగ్గయి', 'Haggai'], ['ZEC', 'జెకర్యా', 'Zechariah'],
  ['MAL', 'మలాకీ', 'Malachi'],
  ['MAT', 'మత్తయి', 'Matthew'], ['MAR', 'మార్కు', 'Mark'],
  ['LUK', 'లూకా', 'Luke'], ['JOH', 'యోహాను', 'John'],
  ['ACT', 'అపొస్తలుల కార్యాలు', 'Acts'], ['ROM', 'రోమా', 'Romans'],
  ['1CO', '1 కొరింథీ', '1 Corinthians'], ['2CO', '2 కొరింథీ', '2 Corinthians'],
  ['GAL', 'గలతీ', 'Galatians'], ['EPH', 'ఎఫెసీ', 'Ephesians'],
  ['PHI', 'ఫిలిప్పీ', 'Philippians'], ['COL', 'కొలస్సీ', 'Colossians'],
  ['1TH', '1 థెస్సలొనీక', '1 Thessalonians'], ['2TH', '2 థెస్సలొనీక', '2 Thessalonians'],
  ['1TI', '1 తిమోతి', '1 Timothy'], ['2TI', '2 తిమోతి', '2 Timothy'],
  ['TIT', 'తీతు', 'Titus'], ['PHM', 'ఫిలేమోను', 'Philemon'],
  ['HEB', 'హెబ్రీ', 'Hebrews'], ['JAM', 'యాకోబు', 'James'],
  ['1PE', '1 పేతురు', '1 Peter'], ['2PE', '2 పేతురు', '2 Peter'],
  ['1JO', '1 యోహాను', '1 John'], ['2JO', '2 యోహాను', '2 John'],
  ['3JO', '3 యోహాను', '3 John'], ['JUD', 'యూదా', 'Jude'],
  ['REV', 'ప్రకటన', 'Revelation'],
];

async function downloadVpl() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'irv-'));
  const zipPath = path.join(workDir, 'tel2017_vpl.zip');
  console.log(`Downloading ${VPL_ZIP_URL} ...`);
  const res = await fetch(VPL_ZIP_URL);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

  // Windows 10+ ships bsdtar, which can read zip files; Git Bash's GNU tar cannot.
  if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-xf', zipPath, '-C', workDir]);
  } else {
    execFileSync('unzip', ['-o', zipPath, '-d', workDir]);
  }
  return path.join(workDir, 'tel2017_vpl.txt');
}

function parseVpl(text) {
  const verses = {}; // code -> chapter -> [text]
  for (const line of text.split(/\r?\n/)) {
    const m = line.replace(/^\uFEFF/, '').match(/^([1-3A-Z]{3}) (\d+):(\d+) (.*)$/);
    if (!m) continue;
    const [, code, ch, v, body] = m;
    const chapters = (verses[code] ||= {});
    const list = (chapters[ch] ||= []);
    list[Number(v) - 1] = body.trim();
  }
  return verses;
}

function expandOrder(order, booksByCode) {
  const refs = [];
  for (const entry of order) {
    const [code, range] = entry.split(' ');
    const book = booksByCode[code];
    if (!book) throw new Error(`Unknown book in chronological order: ${entry}`);
    let from = 1;
    let to = book.chapters;
    if (range) [from, to = from] = range.split('-').map(Number);
    for (let c = from; c <= to; c++) refs.push(`${code} ${c}`);
  }
  return refs;
}

function checkCoverage(refs, books) {
  const seen = new Map();
  for (const r of refs) seen.set(r, (seen.get(r) || 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([r]) => r);
  const missing = [];
  for (const b of books) {
    for (let c = 1; c <= b.chapters; c++) if (!seen.has(`${b.code} ${c}`)) missing.push(`${b.code} ${c}`);
  }
  const extra = refs.filter((r) => {
    const [code, c] = r.split(' ');
    const b = books.find((x) => x.code === code);
    return Number(c) > b.chapters;
  });
  if (dupes.length || missing.length || extra.length) {
    throw new Error(
      `Chronological order is not a clean cover of the Bible.\n` +
      `  missing: ${missing.join(', ') || '-'}\n  repeated: ${dupes.join(', ') || '-'}\n  out of range: ${extra.join(', ') || '-'}`
    );
  }
}

// Splits the ordered chapters into PLAN_DAYS days with roughly equal verse
// counts. Each day aims for (verses left / days left), so a long chapter
// such as Psalm 119 only shortens the days around it instead of skewing the year.
function buildPlan(refs, verseCount) {
  const plan = [];
  let i = 0;
  let versesLeft = refs.reduce((sum, r) => sum + verseCount(r), 0);
  for (let day = 1; day <= PLAN_DAYS; day++) {
    const daysLeft = PLAN_DAYS - day + 1;
    if (i >= refs.length) throw new Error(`Ran out of chapters on day ${day}`);
    const target = versesLeft / daysLeft;
    const chapters = [];
    let sum = 0;
    if (day === PLAN_DAYS) {
      while (i < refs.length) { sum += verseCount(refs[i]); chapters.push(refs[i++]); }
    } else {
      while (i < refs.length) {
        const n = verseCount(refs[i]);
        // Always take at least one chapter; leave at least one chapter for each remaining day.
        if (chapters.length && (sum + n / 2 > target || refs.length - i <= daysLeft - 1)) break;
        sum += n;
        chapters.push(refs[i++]);
      }
    }
    versesLeft -= sum;
    plan.push({ day, chapters, verses: sum });
  }
  return plan;
}

async function main() {
  const vplArg = process.argv.indexOf('--vpl');
  const vplPath = vplArg > -1 ? process.argv[vplArg + 1] : await downloadVpl();
  const verses = parseVpl(fs.readFileSync(vplPath, 'utf8'));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const books = BOOKS.map(([code, te, en], idx) => {
    const chapters = verses[code];
    if (!chapters) throw new Error(`Book ${code} not found in ${vplPath}`);
    const verseCounts = Object.keys(chapters)
      .map(Number).sort((a, b) => a - b)
      .map((c) => chapters[c].length);
    fs.writeFileSync(path.join(OUT_DIR, `${code}.json`), JSON.stringify(chapters), 'utf8');
    return { code, te, en, testament: idx < 39 ? 'OT' : 'NT', chapters: verseCounts.length, verses: verseCounts };
  });
  fs.writeFileSync(path.join(OUT_DIR, 'books.json'), JSON.stringify(books), 'utf8');

  const booksByCode = Object.fromEntries(books.map((b) => [b.code, b]));
  const refs = expandOrder(chronologicalOrder, booksByCode);
  checkCoverage(refs, books);
  const verseCount = (ref) => {
    const [code, c] = ref.split(' ');
    return booksByCode[code].verses[Number(c) - 1];
  };
  const plan = buildPlan(refs, verseCount);
  fs.writeFileSync(path.join(OUT_DIR, 'plan-chronological.json'), JSON.stringify(plan), 'utf8');

  const totalChapters = books.reduce((s, b) => s + b.chapters, 0);
  const totalVerses = books.reduce((s, b) => s + b.verses.reduce((a, n) => a + n, 0), 0);
  const perDay = plan.map((d) => d.verses);
  console.log(`Wrote ${books.length} books, ${totalChapters} chapters, ${totalVerses} verses to ${OUT_DIR}`);
  console.log(`Plan: ${plan.length} days, ${plan.reduce((s, d) => s + d.chapters.length, 0)} chapters, ` +
    `verses/day min ${Math.min(...perDay)} avg ${Math.round(totalVerses / plan.length)} max ${Math.max(...perDay)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
