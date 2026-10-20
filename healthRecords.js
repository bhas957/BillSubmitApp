// Turns health report PDFs (any lab or hospital) into structured JSON records,
// and builds everything the My Health Reports app reads from those records.
//
// One record per report file, kept in data/records/<report name>.json:
//   { id, file, sha256, type, date, provider, orderedVia, orderId, title, status,
//     results: [{ test, key, value, unit, valueText, refRange, flag, verified }],
//     findings: [{ area, text }], impression, summary, edits: {...}, ... }
// `edits` holds hand corrections (title, date, provider, values: { key: n|null })
// and survives re-parsing. A record with `locked: true` is never re-parsed.
//
// Parsing: Gemini reads the PDF and fills a fixed JSON schema (works for any
// provider). Every number it returns is then looked up in the PDF's own text;
// values that can't be found are marked verified:false. For Thyrocare PDFs the
// offline rule parser also runs and wins where the two disagree. Without a
// Gemini key only the rule parser runs.
//
// Derived files (all rebuilt from the records):
//   data/health-records.json  every report, for the app, the AI and exports
//   data/health-data.json     marker values per blood test, for the charts
const crypto = require('crypto');
const { PDFParse } = require('pdf-parse');
const MARKERS = require('./healthMarkers');

const SCHEMA = 'my-health-records/1';
const BY_KEY = new Map(MARKERS.map((m) => [m.key, m]));
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const FOLDERS = { lab: 'Blood Tests', imaging: 'scans', cardiac: 'scans', other: 'other' };

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const pad = (n) => String(n).padStart(2, '0');

async function pdfText(buffer, password) {
  const parser = new PDFParse({ data: buffer, password });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

// Labs often email password-protected PDFs. Tries no password, then each of
// `passwords`. Returns { text, encrypted, password } or throws a clear error.
async function readPdf(buffer, passwords = []) {
  try {
    return { text: await pdfText(buffer), encrypted: false };
  } catch (err) {
    if (!/password/i.test(`${err.name} ${err.message}`)) return { text: '', encrypted: false };
  }
  for (const password of passwords.filter(Boolean)) {
    try {
      return { text: await pdfText(buffer, password), encrypted: true, password };
    } catch { /* try the next one */ }
  }
  throw Object.assign(new Error('This PDF is password-protected. Add its password to HEALTH_PDF_PASSWORDS in .env (comma separated).'), { code: 'PDF_PASSWORD' });
}

// ---- Units ------------------------------------------------------------------
function normUnit(u) {
  return String(u || '').toLowerCase()
    .replace(/[µμ]/g, 'u').replace(/×/g, 'x').replace(/³/g, '^3').replace(/⁶/g, '^6')
    .replace(/cells?\//g, '/').replace(/cu\.?\s*mm|mm\^?3|cmm/g, 'mm3')
    .replace(/\s+/g, '');
}

const COUNT_UNITS = { 'x10^3/ul': 1, '10^3/ul': 1, 'thou/ul': 1, 'x10^9/l': 1, '/nl': 1, '/mm3': 0.001, '/ul': 0.001 };

// Factor that converts `unit` to the marker's unit, or null if unknown.
function unitFactor(marker, unit) {
  const u = normUnit(unit);
  if (!u || !marker.unit || u === normUnit(marker.unit)) return 1;
  if (marker.units === 'count') return COUNT_UNITS[u] ?? null;
  if (marker.units && marker.units[u] != null) return marker.units[u];
  const same = [['uiu/ml', 'miu/l', 'uu/ml'], ['ug/dl', 'mcg/dl'], ['umol/l', 'mcmol/l'], ['u/l', 'iu/l'], ['mm/hr', 'mm/h', 'mm/1sthr']];
  return same.some((g) => g.includes(u) && g.includes(normUnit(marker.unit))) ? 1 : null;
}

const round = (v) => +Number(v).toPrecision(6);

// ---- Verification -------------------------------------------------------------
// True when the number is printed somewhere in the report text ("10,160",
// "45.40" and "45.4" all count). Catches values a model made up.
function makeVerifier(text) {
  const plain = String(text || '').replace(/(\d),(?=\d{3}\b)/g, '$1');
  return (value) => {
    if (value == null || !Number.isFinite(value)) return false;
    const forms = new Set([String(value)]);
    for (let d = 0; d <= 3; d++) forms.add(value.toFixed(d));
    for (const f of forms) {
      if (Number(f) !== value) continue;
      const re = new RegExp(`(?<![\\d.])${f.replace('.', '\\.')}(?:0*)(?![\\d])`);
      if (re.test(plain)) return true;
    }
    return false;
  };
}

// ---- Rule parser (offline; tuned for Thyrocare / PharmEasy layouts) ----------
const SKIP_LINE = /^(Method|Clinical|Kit|Specifications|Reference|Disclaimer)|Available|Ready|significance|causes|indicate|\t(Good|Low|High)\s*$/i;
// "ng/dL<TAB>336" or "E.C.L.I.A 273" just above the label (single-test pages)
const VALUE_ABOVE = /^(?:[^\t\d]*[a-zA-Zµμ%][^\t]*\t|[A-Z][A-Z.\- ]*\s)\s*(\d+(?:\.\d+)?)\s*$/;
// "5.5<TAB>H.P.L.C %" just below the label (HbA1c pages)
const VALUE_BELOW = /^(\d+(?:\.\d+)?)\t[A-Z]/;
// "H.P.L.C %<TAB>5.3" just below the label (older Thyrocare HbA1c pages)
const UNIT_VALUE_BELOW = /^[^\t\d]*[a-zA-Z%][^\t\d]*\t(\d+(?:\.\d+)?)\s*$/;

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
    const next = lines[i + 1] || '';
    const below = next.match(VALUE_BELOW) || next.match(UNIT_VALUE_BELOW);
    if (below) return Number(below[1]);
  }
  return null;
}

// Earliest "20 Sep 2021 10:51" / "30/Oct/2023 12:04PM" / "19-Oct-2026 17:45"
// timestamp in the report: sample collection comes before receipt and release.
function collectedDate(text, fileName) {
  const stamps = [...text.matchAll(/\b(\d{1,2})[ /-](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[ ,/-]+(20\d\d)[ ,]+(\d{1,2}):(\d\d)\s*([AP]M)?/gi)]
    .map((m) => {
      const h = (Number(m[4]) % (m[6] ? 12 : 24)) + (/PM/i.test(m[6] || '') ? 12 : 0);
      return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}T${pad(h)}:${m[5]}`;
    })
    .sort();
  if (stamps.length) return { date: stamps[0].slice(0, 10), time: stamps[0].slice(11) };
  const slash = text.match(/TEST DATE\s*(\d{2})\/(\d{2})\/(20\d\d)/i);
  if (slash) return { date: `${slash[3]}-${slash[2]}-${slash[1]}`, time: null };
  const any = text.match(/\b(\d{1,2})[ -](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*,?[ -](20\d\d)\b/i);
  if (any) return { date: `${any[3]}-${pad(MONTHS[any[2].toLowerCase()])}-${pad(any[1])}`, time: null };
  const f = String(fileName).match(/(20\d\d)[_-](\d{1,2})(?:[_-](\d{1,2}))?/);
  return { date: f ? `${f[1]}-${pad(f[2])}-${pad(f[3] || 1)}` : null, time: null };
}

function detectSource(text, fileName) {
  const provider = /thyrocare/i.test(text) ? 'Thyrocare'
    : /apollo/i.test(text) ? 'Apollo Diagnostics'
      : /even hospitals|EVEN-\d/i.test(text) ? 'Even Hospitals'
        : 'Unknown';
  const pe = String(fileName).match(/^(\d{6,8})_|_PE(\d{6,8})\b/);
  const orderedVia = /MFINE/.test(text) ? 'MFine' : pe || /pharmeasy/i.test(text) ? 'PharmEasy' : null;
  return { provider, orderedVia, orderId: pe ? pe[1] || pe[2] : null };
}

function detectType(text) {
  if (/ECHOCARDIOGRAM|ELECTROCARDIOGRAM|\bECG\b/i.test(text) && text.length < 8000) return 'cardiac';
  if (/ULTRASOUND|SC ?AN NAME|X-?RAY|\bMRI\b|\bCT SCAN/i.test(text) && text.length < 8000) return 'imaging';
  return 'lab';
}

function ruleTitle(text) {
  const m = text.match(/TEST ASKED\s*:?\s*([^\n]+)/i) || text.match(/Test Asked\s*:\s*([^\n]+)/)
    || text.match(/\(\d+Y\/[MF]\)\n([^\n]+)\n/) || text.match(/SC ?AN NAME\n([^\n]+)/i);
  return m ? m[1].replace(/^[:\s]+/, '').trim() : 'Health report';
}

function parseWithRules(text, fileName) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const { date, time } = collectedDate(text, fileName);
  const type = detectType(text);
  const results = [];
  if (type === 'lab') {
    for (const m of MARKERS) {
      if (!m.label) continue;
      const v = findValue(lines, m);
      if (v !== null) results.push({ test: m.name, key: m.key, value: v, unit: m.unit, verified: true, source: 'rules' });
    }
  }
  return {
    type,
    date,
    collectedTime: time,
    ...detectSource(text, fileName),
    title: ruleTitle(text),
    status: /PARTIAL|Processing\s*[1-9]|Interim/i.test(`${fileName} ${text.slice(0, 3000)}`) ? 'interim' : 'final',
    results,
    findings: [],
    impression: (text.match(/IMPRES ?SION\s*\n([^\n]+(?:\n[^\n]+)?)/i) || [])[1]?.replace(/\n(AUTHORISED|Page)[\s\S]*/i, '').trim() || '',
  };
}

// ---- Gemini parser ------------------------------------------------------------
const S = (type, extra = {}) => ({ type, ...extra });
const RESPONSE_SCHEMA = S('OBJECT', {
  properties: {
    reportType: S('STRING', { enum: ['lab', 'imaging', 'cardiac', 'other'] }),
    provider: S('STRING', { description: 'Lab or hospital that performed the test, e.g. "Thyrocare", "Apollo Diagnostics"' }),
    orderedVia: S('STRING', { nullable: true, description: 'Booking platform if different from the lab, e.g. PharmEasy, MFine, Tata 1mg' }),
    orderId: S('STRING', { nullable: true }),
    title: S('STRING', { description: 'Short name of the package or scan, max 8 words' }),
    collectedDate: S('STRING', { description: 'Sample collection / test date, YYYY-MM-DD' }),
    collectedTime: S('STRING', { nullable: true, description: 'HH:MM, 24h' }),
    reportedDate: S('STRING', { nullable: true, description: 'YYYY-MM-DD' }),
    status: S('STRING', { enum: ['final', 'interim'] }),
    patientName: S('STRING', { nullable: true }),
    patientAge: S('NUMBER', { nullable: true }),
    patientSex: S('STRING', { nullable: true }),
    doctor: S('STRING', { nullable: true, description: 'Reporting/consulting doctor' }),
    results: S('ARRAY', {
      items: S('OBJECT', {
        properties: {
          test: S('STRING', { description: 'Test name exactly as printed' }),
          panel: S('STRING', { nullable: true, description: 'Section/profile it belongs to, e.g. Lipid profile' }),
          key: S('STRING', { nullable: true, description: 'Catalogue key if this test is one of them, else null' }),
          value: S('NUMBER', { nullable: true, description: 'Numeric result exactly as printed, null if not numeric' }),
          valueText: S('STRING', { description: 'Result as printed, e.g. "NEGATIVE", "1-2", "9.04"' }),
          unit: S('STRING', { nullable: true, description: 'Unit as printed' }),
          refRange: S('STRING', { nullable: true, description: 'Reference range as printed' }),
          flag: S('STRING', { nullable: true, enum: ['H', 'L', 'A', 'N'], description: 'H high, L low, A abnormal (non-numeric), N normal' }),
        },
        required: ['test', 'valueText'],
      }),
    }),
    findings: S('ARRAY', {
      items: S('OBJECT', { properties: { area: S('STRING'), text: S('STRING') }, required: ['area', 'text'] }),
      description: 'For scans/ECG/echo: one entry per organ or parameter group',
    }),
    impression: S('STRING', { nullable: true, description: 'Final impression / conclusion as printed' }),
    summary: S('STRING', { description: 'One or two plain-English sentences: what was tested and anything outside normal' }),
  },
  required: ['reportType', 'provider', 'title', 'collectedDate', 'status', 'results', 'findings', 'summary'],
});

function extractionPrompt() {
  const catalogue = MARKERS.filter((m) => !m.derived).map((m) => `${m.key}: ${m.name} (${m.unit || 'ratio'})`).join('\n');
  return `Extract this medical report into the JSON schema.

Rules:
- Copy every measured result in the report: all lab tests (including urine, blood count, ratios, toxic elements), or every measurement in a scan/ECG/echo.
- Skip interpretation tables, pregnancy ranges, method descriptions, comments and disclaimers. Do not repeat the same test twice.
- value: the number exactly as printed (drop thousands separators). Do NOT convert units. If the result is not a number, value=null and put the text in valueText.
- key: if the test is one of the catalogue markers below, give its key; otherwise null. Match by meaning, e.g. "THYROID STIMULATING HORMONE (TSH)" = tsh, "HAEMOGLOBIN" = hb, "LYMPHOCYTES" absolute count = lymph (not the % one).
- collectedDate is when the sample was collected or the test was done, not when the report was printed.
- Never invent values. If something is not in the report, leave it null.

Catalogue:
${catalogue}`;
}

async function parseWithGemini({ buffer, mimeType, text, apiKey, model, encrypted }) {
  // Inline files must stay under Gemini's 20 MB request limit, and Gemini can't
  // open password-protected PDFs: send the extracted text in those cases.
  const usePdf = buffer && !encrypted && buffer.length < 14 * 1024 * 1024;
  if (!usePdf && !(text && text.length > 200)) throw new Error('File too large for AI parsing and has no text layer');
  const parts = usePdf
    ? [{ inlineData: { mimeType, data: buffer.toString('base64') } }, { text: extractionPrompt() }]
    : [{ text: `${extractionPrompt()}\n\n<report>\n${text}\n</report>` }];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 60000,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `Gemini request failed (HTTP ${res.status})`);
  const out = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  if (!out) throw new Error(`Gemini returned nothing (${body.promptFeedback?.blockReason || body.candidates?.[0]?.finishReason || 'empty'})`);
  if (body.candidates?.[0]?.finishReason === 'MAX_TOKENS') throw new Error('Gemini reply was cut off (report too long)');
  return JSON.parse(out);
}

function fromGemini(g, verify) {
  const results = (g.results || []).map((r) => {
    const marker = r.key && BY_KEY.get(r.key);
    const value = typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null;
    return {
      test: String(r.test || '').trim(),
      panel: r.panel || undefined,
      key: marker ? marker.key : undefined,
      value,
      valueText: r.valueText || (value != null ? String(value) : ''),
      unit: r.unit || undefined,
      refRange: r.refRange || undefined,
      flag: r.flag || undefined,
      verified: value == null ? undefined : verify(value),
      source: 'ai',
    };
  }).filter((r) => r.test);
  return {
    type: ['lab', 'imaging', 'cardiac', 'other'].includes(g.reportType) ? g.reportType : 'other',
    date: /^\d{4}-\d{2}-\d{2}$/.test(g.collectedDate || '') ? g.collectedDate : null,
    collectedTime: g.collectedTime || null,
    reportedDate: g.reportedDate || null,
    provider: g.provider || 'Unknown',
    orderedVia: g.orderedVia || null,
    orderId: g.orderId || null,
    title: g.title || 'Health report',
    status: g.status === 'interim' ? 'interim' : 'final',
    patient: { name: g.patientName || undefined, age: g.patientAge ?? undefined, sex: g.patientSex || undefined },
    doctor: g.doctor || undefined,
    results,
    findings: g.findings || [],
    impression: g.impression || '',
    summary: g.summary || '',
  };
}

// Rule values are trusted for the markers they know; AI values fill the rest.
function mergeRules(ai, rules) {
  const warnings = [];
  const byKey = new Map(rules.results.map((r) => [r.key, r]));
  for (const r of ai.results) {
    const rule = r.key && byKey.get(r.key);
    if (!rule) continue;
    byKey.delete(r.key);
    const factor = unitFactor(BY_KEY.get(r.key), r.unit);
    const aiValue = r.value != null && factor != null ? round(r.value * factor) : null;
    if (aiValue !== rule.value) {
      warnings.push(`${r.test}: AI read ${r.valueText}, rule parser read ${rule.value}; kept ${rule.value}`);
      Object.assign(r, { value: rule.value, unit: BY_KEY.get(r.key).unit, verified: true, source: 'rules' });
    }
  }
  for (const r of byKey.values()) ai.results.push(r); // markers the AI missed
  if (!ai.orderId && rules.orderId) ai.orderId = rules.orderId;
  if (!ai.orderedVia && rules.orderedVia) ai.orderedVia = rules.orderedVia;
  return warnings;
}

// Parses one report file into a record (without id/file; see finishRecord).
async function parseReport({ buffer, fileName, mimeType = 'application/pdf', gemini, passwords = [], profile = 'me' }) {
  const { text, encrypted } = mimeType === 'application/pdf' ? await readPdf(buffer, passwords) : { text: '', encrypted: false };
  const rules = text ? parseWithRules(text, fileName) : null;
  const warnings = [];
  let rec;
  let extractedBy;
  if (gemini?.apiKey) {
    const g = await parseWithGemini({ buffer, mimeType, text, apiKey: gemini.apiKey, model: gemini.model, encrypted });
    rec = fromGemini(g, text ? makeVerifier(text) : () => undefined);
    extractedBy = `gemini:${gemini.model}`;
    if (rules && rules.provider === 'Thyrocare' && rec.type === 'lab') {
      warnings.push(...mergeRules(rec, rules));
      extractedBy += '+rules';
    }
  } else if (rules) {
    rec = rules;
    extractedBy = 'rules';
    if (rules.provider !== 'Thyrocare' && rules.type === 'lab') {
      warnings.push(`No parser for ${rules.provider} lab reports without AI; add GEMINI_API_KEY and run "npm run health:build -- --force"`);
    }
  } else {
    throw new Error('This file has no readable text. Add GEMINI_API_KEY so the AI can read it.');
  }
  const unverified = rec.results.filter((r) => r.verified === false).length;
  if (unverified) warnings.push(`${unverified} value(s) could not be found in the PDF text; check them against the original`);
  if (!rec.date) warnings.push('Could not find the test date; set it in edits.date');
  return { ...rec, profile, encrypted: encrypted || undefined, sha256: sha256(buffer), extractedBy, extractedAt: new Date().toISOString(), warnings };
}

// Cheap pre-check before spending a Gemini call on an email attachment.
const MEDICAL_HINTS = /reference (range|interval)|bio\.? ?ref|biological ref|sample (collected|type)|specimen|patient name|haemoglobin|hemoglobin|cholesterol|thyroid|impression|radiolog|ultrasound|echocardiogra|pathology|laboratory/gi;
function looksMedical(text) {
  return new Set((String(text).match(MEDICAL_HINTS) || []).map((m) => m.toLowerCase())).size >= 2;
}

// ---- Naming -------------------------------------------------------------------
function slug(s, max = 48) {
  const words = String(s || '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let out = '';
  for (const w of words) {
    const word = w.length <= 3 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1).toLowerCase();
    if ((out + word).length > max) break;
    out += (out ? '-' : '') + word;
  }
  return out || 'Report';
}

// "2026-10-19_Thyrocare_Mens-Wellness-Hive_PE7557278.pdf" in "Blood Tests";
// other family members' reports go under "people/<profile>/Blood Tests".
function canonicalPath(rec, ext = '.pdf') {
  const r = effective(rec);
  const order = r.orderId ? `_${r.orderedVia === 'PharmEasy' ? 'PE' : ''}${r.orderId}` : '';
  const via = r.orderedVia && r.orderedVia !== 'PharmEasy' ? `${slug(r.orderedVia)}-` : '';
  const name = `${r.date || 'undated'}_${slug(r.provider, 24)}_${via}${slug(r.title)}${order}${r.status === 'interim' ? '_INTERIM' : ''}${ext}`;
  const base = FOLDERS[r.type] || 'other';
  return { folder: r.profile && r.profile !== 'me' ? `people/${r.profile}/${base}` : base, name };
}

// Profile a report file belongs to, from its path under pdf/.
const profileFromPath = (rel) => (String(rel).match(/^people\/([a-z0-9-]+)\//) || [])[1] || 'me';

// ---- Records → app data -----------------------------------------------------------
const EDITABLE = ['title', 'date', 'collectedTime', 'provider', 'orderedVia', 'orderId', 'type', 'status', 'profile'];

// The record with hand edits applied, and marker values converted to catalogue units.
function effective(rec) {
  const e = rec.edits || {};
  const out = { ...rec, ...Object.fromEntries(EDITABLE.filter((k) => e[k] !== undefined).map((k) => [k, e[k]])) };
  out.profile = out.profile || 'me';
  if (e.reviewed) out.reviewed = e.reviewed;
  const values = {};
  for (const r of rec.results || []) {
    const m = r.key && BY_KEY.get(r.key);
    if (!m || r.value == null || values[m.key] != null) continue;
    const f = unitFactor(m, r.unit);
    if (f != null) values[m.key] = round(r.value * f);
  }
  for (const [k, v] of Object.entries(e.values || {})) {
    if (v === null) delete values[k];
    else values[k] = v;
  }
  for (const m of MARKERS) {
    if (!m.derived) continue;
    const v = m.derived(values);
    if (v != null) values[m.key] = v;
  }
  out.values = values;
  return out;
}

const publicMarkers = () => MARKERS.map(({ label, notLabel, derived, units, ...rest }) => ({ ...rest, derived: Boolean(derived) }));

// health-records.json: every report with edits applied.
function buildCombined(records) {
  const reports = records.map(effective).sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.file.localeCompare(b.file));
  const latest = [...reports].reverse().find((r) => r.profile === 'me' && (r.patient?.name || r.patient?.age));
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    patient: latest?.patient || {},
    markers: publicMarkers(),
    reports,
  };
}

// health-data.json: the shape compare.html / index.html chart from.
function buildChartData(combined, profile = 'me') {
  return {
    generatedAt: combined.generatedAt,
    markers: combined.markers,
    reports: forProfile(combined, profile).reports
      .filter((r) => r.type === 'lab' && r.date && Object.keys(r.values).length)
      .map((r) => ({ id: r.id, date: r.date, time: r.collectedTime || null, file: r.file, provider: r.provider, partial: r.status === 'interim', values: r.values })),
  };
}

// Only one person's reports (and their patient details).
function forProfile(combined, profile = 'me') {
  const reports = combined.reports.filter((r) => (r.profile || 'me') === profile);
  const latest = [...reports].reverse().find((r) => r.patient?.name || r.patient?.age);
  return { ...combined, patient: latest?.patient || {}, reports };
}

function markerStatus(m, v) {
  if (v == null) return null;
  if (m.low != null && v < m.low) return 'low';
  if (m.high != null && v > m.high) return 'high';
  return 'ok';
}

// What changed in lab report `id` compared with the same person's previous lab report.
function changesFor(combined, id) {
  const rec = combined.reports.find((r) => r.id === id);
  if (!rec || rec.type !== 'lab' || !rec.date) return null;
  const prev = combined.reports
    .filter((r) => r.type === 'lab' && (r.profile || 'me') === (rec.profile || 'me') && r.date && r.date < rec.date && Object.keys(r.values || {}).length)
    .pop();
  const out = { id, date: rec.date, provider: rec.provider, comparedTo: prev ? { id: prev.id, date: prev.date, provider: prev.provider } : null, newlyOut: [], backToNormal: [], stillOut: [], bigMoves: [], firstTime: [], caveats: [] };
  for (const m of MARKERS) {
    const v = rec.values?.[m.key];
    if (v == null) continue;
    const item = { key: m.key, name: m.name, unit: m.unit, value: v, status: markerStatus(m, v), low: m.low, high: m.high };
    const p = prev?.values?.[m.key];
    if (p == null) {
      if (item.status !== 'ok') out.firstTime.push(item);
      continue;
    }
    item.before = p;
    const was = markerStatus(m, p);
    if (was === 'ok' && item.status !== 'ok') out.newlyOut.push(item);
    else if (was !== 'ok' && item.status === 'ok') out.backToNormal.push(item);
    else if (item.status !== 'ok') out.stillOut.push(item);
    const pct = p ? ((v - p) / Math.abs(p)) * 100 : 0;
    if (Math.abs(pct) >= 20) out.bigMoves.push({ ...item, pct: Math.round(pct) });
  }
  out.bigMoves.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).splice(8);
  if (prev && prev.provider !== rec.provider) {
    out.caveats.push(`Different labs (${prev.provider} → ${rec.provider}): methods and normal ranges differ, so small changes may not be real.`);
  }
  const hour = (r) => (r?.collectedTime ? Number(r.collectedTime.slice(0, 2)) : null);
  if (hour(prev) != null && hour(rec) != null && Math.abs(hour(prev) - hour(rec)) >= 3) {
    out.caveats.push(`Samples taken at different times of day (${prev.collectedTime} vs ${rec.collectedTime}); TSH and cortisol are much higher in the early morning.`);
  }
  return out;
}

// Retest suggestions from one person's latest blood test: out-of-range groups
// in 3 months, a full check-up 12 months after the last one.
function retestSuggestions(combined) {
  const labs = combined.reports.filter((r) => r.type === 'lab' && r.date && Object.keys(r.values || {}).length);
  const latest = labs[labs.length - 1];
  if (!latest) return [];
  const addMonths = (iso, n) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 10);
  };
  const byCat = new Map();
  for (const m of MARKERS) {
    const s = markerStatus(m, latest.values[m.key]);
    if (s && s !== 'ok') byCat.set(m.cat, [...(byCat.get(m.cat) || []), m]);
  }
  const out = [...byCat].map(([cat, ms]) => ({
    title: `Retest ${cat.toLowerCase()}: ${ms.map((m) => m.name).join(', ')}`,
    due: addMonths(latest.date, 3),
    markers: ms.map((m) => m.key),
    notes: `Out of range on ${latest.date} (${latest.provider}). Use the same lab and a fasting morning sample (before 9 AM) so results are comparable.`,
  }));
  out.push({
    title: 'Yearly full body check-up',
    due: addMonths(latest.date, 12),
    markers: [],
    notes: `Last full panel on ${latest.date} (${latest.provider}).`,
  });
  return out;
}

// ---- FHIR R4 export ----------------------------------------------------------------
function toFhirBundle(combined) {
  const pid = 'patient-1';
  const entries = [{
    resource: {
      resourceType: 'Patient',
      id: pid,
      name: combined.patient?.name ? [{ text: combined.patient.name }] : undefined,
      gender: /^m/i.test(combined.patient?.sex || '') ? 'male' : /^f/i.test(combined.patient?.sex || '') ? 'female' : 'unknown',
    },
  }];
  for (const r of combined.reports) {
    const obsIds = [];
    (r.results || []).forEach((res, i) => {
      const m = res.key && BY_KEY.get(res.key);
      const id = `${r.id}-obs-${i}`;
      obsIds.push(id);
      const coding = [{ system: 'urn:my-health-records:test', code: res.key || slug(res.test, 60), display: res.test }];
      if (m?.loinc) coding.unshift({ system: 'http://loinc.org', code: m.loinc, display: m.name });
      const obs = {
        resourceType: 'Observation',
        id,
        status: r.status === 'interim' ? 'preliminary' : 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: r.type === 'lab' ? 'laboratory' : 'imaging' }] }],
        code: { coding, text: res.test },
        subject: { reference: `Patient/${pid}` },
        effectiveDateTime: r.collectedTime ? `${r.date}T${r.collectedTime}:00` : r.date,
        performer: [{ display: r.provider }],
      };
      if (res.value != null) obs.valueQuantity = { value: res.value, unit: res.unit || undefined };
      else obs.valueString = res.valueText;
      if (res.refRange) obs.referenceRange = [{ text: res.refRange }];
      if (res.flag && res.flag !== 'N') {
        obs.interpretation = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: res.flag }] }];
      }
      entries.push({ resource: obs });
    });
    entries.push({
      resource: {
        resourceType: 'DiagnosticReport',
        id: r.id,
        status: r.status === 'interim' ? 'preliminary' : 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: r.type === 'lab' ? 'LAB' : r.type === 'cardiac' ? 'CUS' : 'RAD' }] }],
        code: { text: r.title },
        subject: { reference: `Patient/${pid}` },
        effectiveDateTime: r.date,
        performer: [{ display: r.provider }],
        result: obsIds.map((id) => ({ reference: `Observation/${id}` })),
        conclusion: [r.impression, ...(r.findings || []).map((f) => `${f.area}: ${f.text}`)].filter(Boolean).join('\n') || undefined,
        presentedForm: [{ contentType: 'application/pdf', title: r.file }],
      },
    });
  }
  return { resourceType: 'Bundle', type: 'collection', timestamp: combined.generatedAt, entry: entries };
}

// ---- Context for the AI assistant ----------------------------------------------------
// Compact on purpose: trends per marker instead of repeating the catalogue in
// every report, so ~10 years of reports fit in a few thousand tokens.
function aiContext(combined, problems = [], { medications = [], measurements = [], profile } = {}) {
  const reports = combined.reports;
  const markerTrends = {};
  for (const m of combined.markers) {
    const series = reports.filter((r) => r.values?.[m.key] != null).map((r) => [r.date, r.values[m.key]]);
    if (!series.length) continue;
    markerTrends[m.key] = {
      name: m.name,
      unit: m.unit || undefined,
      normal: m.low != null && m.high != null ? `${m.low}–${m.high}` : m.high != null ? `<${m.high}` : m.low != null ? `>${m.low}` : undefined,
      optimal: m.optimal ? `${m.optimal[0]}–${m.optimal[1]}` : undefined,
      series,
    };
  }
  const metrics = ['weight', 'waist', 'bpSys', 'bpDia', 'pulse', 'sleepHours', 'steps', 'glucose'];
  const sorted = [...measurements].sort((a, b) => a.date.localeCompare(b.date));
  return {
    patient: { ...combined.patient, profile: profile ? { name: profile.name, relation: profile.relation, sex: profile.sex, birthYear: profile.birthYear } : undefined },
    today: new Date().toISOString().slice(0, 10),
    medicationsAndSupplements: medications.map((m) => ({
      name: m.name,
      kind: m.kind,
      dose: m.dose || undefined,
      frequency: m.frequency || undefined,
      reason: m.reason || undefined,
      started: m.startedOn || undefined,
      stopped: m.stoppedOn || 'still taking',
      meantToAffect: m.markers?.length ? m.markers : undefined,
      notes: m.notes || undefined,
    })),
    // Body measurements: one row per date, columns: date + metrics (blank = not measured)
    bodyMeasurements: sorted.length ? {
      columns: ['date', ...metrics],
      units: { weight: 'kg', waist: 'cm', bpSys: 'mmHg', bpDia: 'mmHg', pulse: 'bpm', sleepHours: 'h', steps: 'steps/day', glucose: 'mg/dL (home meter)' },
      rows: sorted.slice(-120).map((x) => [x.date, ...metrics.map((k) => x[k] ?? '')]),
    } : undefined,
    reports: reports.map((r) => ({
      date: r.date,
      type: r.type,
      provider: r.provider + (r.orderedVia ? ` (via ${r.orderedVia})` : ''),
      title: r.title,
      status: r.status,
      file: r.file,
      summary: r.summary || undefined,
      // Tests that aren't tracked markers (urine, differential %, elements...): name value unit [range] flag
      otherResults: (r.results || []).filter((x) => !x.key).map((x) => `${x.test}: ${x.valueText}${x.unit ? ` ${x.unit}` : ''}${x.refRange ? ` [${x.refRange}]` : ''}${x.flag && x.flag !== 'N' ? ` ${x.flag}` : ''}`),
      findings: r.findings?.length ? r.findings : undefined,
      impression: r.impression || undefined,
    })),
    markerTrends,
    healthProblems: problems.map((p) => ({
      title: p.title,
      category: p.category,
      status: p.status,
      severity: p.severity,
      since: p.onset || undefined,
      resolvedOn: p.resolvedOn || undefined,
      frequency: p.frequency || undefined,
      triggers: p.triggers || undefined,
      whatHelps: p.relievers || undefined,
      medicines: p.medicines || undefined,
      doctorPlan: p.doctor || undefined,
      notes: p.notes ? p.notes.slice(0, 1500) : undefined,
      recentLog: (p.log || []).slice(0, 8).map((l) => `${l.date} [${l.severity}/10] ${l.note}`),
    })),
  };
}

module.exports = {
  SCHEMA, MARKERS, FOLDERS, EDITABLE, sha256, pdfText, readPdf, looksMedical, parseReport, canonicalPath, profileFromPath,
  effective, forProfile, buildCombined, buildChartData, changesFor, retestSuggestions, markerStatus,
  toFhirBundle, aiContext, makeVerifier, unitFactor,
};
