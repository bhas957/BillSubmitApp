'use strict';
// Telugu Bible reader (IRV 2019). Single-page app with hash routes:
// #home  #index  #read/BOOK/CH[/V]  #plan  #highlights[/colorId]  #journal  #memorize
// Bible text and the reading plan are static JSON under /bible/data;
// progress, highlights, journal and memory cards are synced via /api/bible.

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  books: [], byCode: {}, plan: [], planOrder: [], chapterDay: {},
  state: null, bookCache: {}, aiCache: new Map(),
  reader: null, selection: new Set(), page: 0, pages: 1,
};

const DEFAULT_SETTINGS = {
  planStart: '2026-10-05', theme: 'paper', fontSize: 21, lineHeight: 1.9, readingMode: 'scroll',
  aiLang: 'te', eyeRest: true, font: 'serif', dim: 0, verseLayout: 'flow',
};
const FONTS = {
  serif: "'Noto Serif Telugu', serif",
  sans: "'Noto Sans Telugu', sans-serif",
  mandali: "'Mandali', 'Noto Sans Telugu', sans-serif",
  ramaraja: "'Ramaraja', 'Noto Serif Telugu', serif",
};
const THEME_COLORS = { paper: '#f4ecd8', sepia: '#e9d9b6', white: '#fbfaf6', night: '#121212' };

const AI_ACTIONS = {
  explain: { te: 'పాస్టర్ వివరణ', en: 'Help me understand', icon: '🙏' },
  prayer: { te: 'పాస్టర్ ప్రార్థన', en: "Pastor's prayer", icon: '🕊' },
  apply: { te: 'నా జీవితానికి', en: 'Apply to my life', icon: '🌱' },
  context: { te: 'చారిత్రక సందర్భం', en: 'Historical context', icon: '📜' },
  xref: { te: 'సంబంధిత వచనాలు', en: 'Cross-references', icon: '🔗' },
  feeling: { te: 'నా భావనకు వచనాలు', en: 'Verses for my feeling', icon: '💛' },
};

const FEELINGS = [
  ['ఆందోళన', 'Anxious'], ['దుఃఖం', 'Sad'], ['ఒంటరితనం', 'Lonely'], ['భయం', 'Afraid'],
  ['కోపం', 'Angry'], ['అలసట', 'Weary'], ['శోధన', 'Tempted'], ['అపరాధ భావం', 'Guilty'],
  ['కృతజ్ఞత', 'Thankful'], ['సంతోషం', 'Joyful'],
];
const MOODS = ['😊', '🙂', '😐', '😔', '😟', '😠', '🙏'];

// Well-known verses for "verse of the day" (BibleWorks codes).
const VOTD = [
  'JOH 3:16', 'PSA 23:1', 'PRO 3:5', 'ISA 41:10', 'PHI 4:6', 'PHI 4:13', 'ROM 8:28', 'JER 29:11',
  'MAT 11:28', 'MAT 6:33', 'JOS 1:9', 'PSA 46:1', 'PSA 119:105', 'ROM 12:2', '2CO 5:17', 'GAL 2:20',
  'EPH 2:8', 'EPH 2:10', 'HEB 11:1', 'HEB 4:16', 'JAM 1:5', '1PE 5:7', '1JO 1:9', '1JO 4:19',
  'ISA 40:31', 'LAM 3:22', 'LAM 3:23', 'PSA 27:1', 'PSA 34:18', 'PSA 37:4', 'PSA 55:22', 'PSA 91:1',
  'PSA 103:12', 'PSA 121:2', 'PSA 139:14', 'MIC 6:8', 'ZEP 3:17', 'DEU 31:6', 'NUM 6:24', 'MAT 5:16',
  'MAT 28:20', 'JOH 14:6', 'JOH 14:27', 'JOH 15:5', 'JOH 16:33', 'ROM 5:8', 'ROM 15:13', '1CO 13:4',
  '2CO 12:9', 'GAL 5:22', 'COL 3:23', '1TH 5:16', '1TH 5:18', '2TI 1:7', 'HEB 13:5', 'REV 21:4',
  'ISA 26:3', 'PSA 16:11', 'PSA 51:10', 'ROM 8:38',
];

// Codes an AI model may use instead of the BibleWorks ones in our data.
const CODE_ALIASES = {
  JHN: 'JOH', MRK: 'MAR', MRC: 'MAR', PHP: 'PHI', JAS: 'JAM', SNG: 'SOL', SOS: 'SOL', EZK: 'EZE',
  JOL: 'JOE', NAM: 'NAH', '1JN': '1JO', '2JN': '2JO', '3JN': '3JO', JDE: 'JUD', TTS: 'TIT',
  PSM: 'PSA', PS: 'PSA', PRV: 'PRO', ECL: 'ECC', ESG: 'EST', OBD: 'OBA', ZPH: 'ZEP', HGG: 'HAG',
  ZCH: 'ZEC', MLA: 'MAL', MTT: 'MAT', LUC: 'LUK', ACTS: 'ACT', RMS: 'ROM', PHL: 'PHM', HBR: 'HEB',
  JDS: 'JUD', RVL: 'REV', JUG: 'JDG', RTH: 'RUT', EXD: 'EXO', DT: 'DEU', JSH: 'JOS', NMB: 'NUM',
};

const ATTRIBUTION = `పరిశుద్ధ గ్రంథం: ఇండియన్ రివైజ్డ్ వెర్షన్ (IRV) తెలుగు 2019 · © 2017, 2019 Bridge Connectivity Solutions ·
  <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a> ·
  text from <a href="https://ebible.org/details.php?id=tel2017" target="_blank" rel="noopener">eBible.org</a>`;

// ---- Dates (local calendar days as YYYY-MM-DD) --------------------------------
const pad2 = (n) => String(n).padStart(2, '0');
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function toUTC(s) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function addDays(s, n) {
  const d = new Date(toUTC(s) + n * 864e5);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 864e5);
const fmtDate = (s, opts = { day: 'numeric', month: 'short' }) =>
  new Date(toUTC(s)).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' });
const weekStart = (s) => addDays(s, -((new Date(toUTC(s)).getUTCDay() + 6) % 7)); // Monday

// ---- Names and references -------------------------------------------------------
const bookName = (code, lang = 'te') => S.byCode[code]?.[lang] || code;
const chapLabel = (ref, lang = 'te') => { const [c, n] = ref.split(' '); return `${bookName(c, lang)} ${n}`; };
const chapLink = (ref) => `#read/${ref.replace(' ', '/')}`;
function compressRanges(vs) {
  const out = [];
  let start = vs[0], prev = vs[0];
  for (const v of [...vs.slice(1), null]) {
    if (v === prev + 1) { prev = v; continue; }
    out.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = v;
  }
  return out.join(',');
}
const passageLabel = (code, ch, vs, lang = 'te') => `${bookName(code, lang)} ${ch}:${compressRanges(vs)}`;
const verseKey = (code, ch, v) => `${code}.${ch}.${v}`;

// "JOH 3:16", "JHN 3:16-18", "PSA 23" -> { code, ch, vs }
function parseRef(ref) {
  const m = String(ref).toUpperCase().trim().match(/^([1-3]?\s?[A-Z]{2,4})\.?\s*(\d+)(?::(\d+)(?:\s*[-–]\s*(\d+))?)?/);
  if (!m) return null;
  let code = m[1].replace(/\s/g, '');
  code = CODE_ALIASES[code] || code;
  const book = S.byCode[code];
  const ch = Number(m[2]);
  if (!book || ch < 1 || ch > book.chapters) return null;
  const vs = [];
  if (m[3]) {
    const from = Number(m[3]);
    const to = Math.min(Number(m[4] || from), from + 30);
    for (let v = from; v <= to; v++) vs.push(v);
  }
  return { code, ch, vs };
}

async function loadBook(code) {
  if (!S.bookCache[code]) {
    S.bookCache[code] = fetch(`/bible/data/${code}.json`).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${code}`);
      return r.json();
    });
  }
  return S.bookCache[code];
}
async function passageText(code, ch, vs, withNumbers = true) {
  const data = await loadBook(code);
  const chapter = data[ch] || [];
  return vs.filter((v) => chapter[v - 1]).map((v) => (withNumbers ? `${v} ` : '') + chapter[v - 1]).join(' ');
}

// ---- Server state -------------------------------------------------------------
// Optional access code (BIBLE_ACCESS_TOKEN on the server), remembered per device.
const TOKEN_KEY = 'bibleToken';
function savedToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
async function api(method, url, body, opts = {}, retried = false) {
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  const token = savedToken();
  if (token) headers['x-bible-token'] = token;
  const res = await fetch(`/api/bible${url}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    ...opts,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && json.needToken && !retried) {
    const code = prompt('యాక్సెస్ కోడ్ · Enter the Bible app access code');
    if (code) {
      try { localStorage.setItem(TOKEN_KEY, code.trim()); } catch { /* private mode */ }
      return api(method, url, body, opts, true);
    }
  }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
function normalizeState(st) {
  st.settings = { ...DEFAULT_SETTINGS, ...(st.settings || {}) };
  st.highlights ||= {}; st.completed ||= {}; st.journal ||= {}; st.memory ||= [];
  return st;
}
// Small debounced writes. Settings are sent per key so two devices changing
// different settings don't overwrite each other.
let patchTimer = null;
let pendingPatch = {};
function patchState(...keys) {
  for (const k of keys) pendingPatch[k] = S.state[k];
  clearTimeout(patchTimer);
  patchTimer = setTimeout(flushPatch, 400);
}
function patchSetting(key) {
  pendingPatch.settings = { ...pendingPatch.settings, [key]: S.state.settings[key] };
  clearTimeout(patchTimer);
  patchTimer = setTimeout(flushPatch, 400);
}
const saveFailed = (e) => toast(`సేవ్ కాలేదు / Save failed: ${e.message}`);
// Journal days and memory cards are saved one item at a time.
function saveJournal(day) {
  return api('PUT', `/journal/${day}`, { entry: S.state.journal[day] || null }).catch(saveFailed);
}
function saveMemoryCard(card) {
  return api('PUT', '/memory', { card }).catch(saveFailed);
}
function removeMemoryCard(ref) {
  return api('DELETE', '/memory', { ref }).catch(saveFailed);
}
function flushPatch() {
  clearTimeout(patchTimer);
  const body = pendingPatch;
  pendingPatch = {};
  if (!Object.keys(body).length) return;
  api('PATCH', '/state', body, { keepalive: true }).catch(saveFailed);
}

// ---- Plan helpers ---------------------------------------------------------------
const planDayToday = () => diffDays(S.state.settings.planStart, todayStr()) + 1; // < 1 before the plan starts
const dueDate = (day) => addDays(S.state.settings.planStart, day - 1);
const clampDay = (d) => Math.min(Math.max(d, 1), S.plan.length);
function chapterStatus(ref) {
  if (S.state.completed[ref]) return 'done';
  const d = S.chapterDay[ref];
  const t = planDayToday();
  if (d < t) return 'behind';
  if (d === t) return 'today';
  return 'future';
}
const behindList = () => {
  const t = planDayToday();
  return S.planOrder.filter((r) => S.chapterDay[r] < t && !S.state.completed[r]);
};
// Today's plan plus a gentle share of missed chapters, spread over the next 7 days.
function todaysQueue() {
  const behind = behindList();
  const perDay = behind.length ? Math.ceil(behind.length / 7) : 0;
  // After the plan year there is no new "today" reading, only anything left unread.
  const today = planDayToday() > S.plan.length ? [] : S.plan[clampDay(planDayToday()) - 1].chapters;
  return { today, catchup: behind.slice(0, perDay), behind, perDay };
}
function nextUnreadInQueue() {
  const q = todaysQueue();
  return [...q.catchup, ...q.today].find((r) => !S.state.completed[r]);
}
function nextInPlan(ref) {
  const i = S.planOrder.indexOf(ref);
  return S.planOrder.slice(i + 1).find((r) => !S.state.completed[r]) || null;
}
function neighborChapter(code, ch, dir) {
  const b = S.byCode[code];
  if (ch + dir >= 1 && ch + dir <= b.chapters) return `${code} ${ch + dir}`;
  const idx = S.books.indexOf(b) + dir;
  if (idx < 0 || idx >= S.books.length) return null;
  const nb = S.books[idx];
  return `${nb.code} ${dir > 0 ? 1 : nb.chapters}`;
}
// Consecutive reading days ending today (or yesterday). One missed day per week (Mon–Sun) is forgiven.
function computeStreak() {
  const readDays = new Set(Object.values(S.state.completed));
  const today = todayStr();
  let d = readDays.has(today) ? today : addDays(today, -1);
  let streak = 0;
  let pendingGrace = null; // a missed day only becomes a grace day once an earlier reading day is found
  const graceWeeks = new Set();
  const graceDays = new Set();
  for (let i = 0; i < 800; i++) {
    if (readDays.has(d)) {
      streak++;
      if (pendingGrace) { graceDays.add(pendingGrace); pendingGrace = null; }
    } else {
      const wk = weekStart(d);
      if (pendingGrace || graceWeeks.has(wk)) break;
      graceWeeks.add(wk);
      pendingGrace = d;
    }
    d = addDays(d, -1);
  }
  return { streak, readDays, graceDays };
}

// ---- UI helpers -----------------------------------------------------------------
let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function openModal(html, onMount) {
  $('#modalCard').innerHTML = html;
  $('#modal').classList.remove('hidden');
  onMount?.($('#modalCard'));
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modalCard').innerHTML = ''; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  // Plain-http LAN access (tablet) has no Clipboard API.
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  return Promise.resolve();
}

// Tiny, safe markdown: ## headings, - / 1. lists, **bold**, paragraphs.
function renderMarkdown(md) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)\*(?!\s)(.+?)\*(?=\W|$)/g, '$1<em>$2</em>');
  let html = '', list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if (!line) { closeList(); continue; }
    if ((m = line.match(/^#{1,4}\s+(.*)/))) { closeList(); html += `<h3>${inline(m[1])}</h3>`; continue; }
    if ((m = line.match(/^[-*•]\s+(.*)/))) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inline(m[1])}</li>`; continue;
    }
    if ((m = line.match(/^\d+[.)]\s+(.*)/))) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inline(m[1])}</li>`; continue;
    }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html;
}

function applySettings() {
  const s = S.state.settings;
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.style.setProperty('--fs', `${s.fontSize}px`);
  root.style.setProperty('--lh', s.lineHeight);
  root.style.setProperty('--reader-font', FONTS[s.font] || FONTS.serif);
  $('meta[name="theme-color"]').content = THEME_COLORS[s.theme] || THEME_COLORS.paper;
  $('#dim').style.opacity = (s.dim || 0) / 100;
  document.body.classList.toggle('verse-lines', s.verseLayout === 'lines');
}
function measureBar() {
  document.documentElement.style.setProperty('--barh', `${$('#bar').offsetHeight}px`);
}

// ---- Router -----------------------------------------------------------------------
const view = $('#view');
const VIEWS = {
  home: renderHome, index: renderIndex, read: renderRead, plan: renderPlan,
  highlights: renderHighlights, journal: renderJournal, memorize: renderMemorize,
};
function route() {
  const [name, ...args] = (location.hash.slice(1) || 'home').split('/');
  const key = VIEWS[name] ? name : 'home';
  clearSelection();
  document.body.classList.remove('focus');
  document.body.dataset.view = key;
  $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === key));
  $('#tabs a.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  if (key !== 'read') {
    $('#barTitle').innerHTML = 'తెలుగు బైబిల్ <small>· IRV</small>';
    window.scrollTo(0, 0);
  }
  measureBar();
  VIEWS[key](...args.map(decodeURIComponent));
}
window.addEventListener('hashchange', route);

// ---- Home -------------------------------------------------------------------------
function renderHome() {
  const t = planDayToday();
  const start = S.state.settings.planStart;
  const { today, catchup, behind, perDay } = todaysQueue();
  const doneCount = Object.keys(S.state.completed).length;
  const total = S.planOrder.length;
  const { streak, readDays, graceDays } = computeStreak();
  const ws = weekStart(todayStr());

  let dayLine;
  if (t < 1) dayLine = `ప్రణాళిక ${fmtDate(start, { weekday: 'long', day: 'numeric', month: 'long' })} నుంచి · starts in ${1 - t} day${t === 0 ? '' : 's'}`;
  else if (t > S.plan.length) dayLine = 'ప్రణాళిక సంవత్సరం పూర్తయింది · Plan year finished';
  else dayLine = `Day ${t} of ${S.plan.length} · ${fmtDate(todayStr(), { weekday: 'long', day: 'numeric', month: 'long' })}`;
  const startRef = nextUnreadInQueue();
  const todayDone = today.every((r) => S.state.completed[r]);
  const lr = S.state.lastRead;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'శుభోదయం' : hour < 17 ? 'శుభ మధ్యాహ్నం' : 'శుభ సాయంత్రం';

  view.innerHTML = `
    <div class="hello">
      <div class="day">${esc(dayLine)}</div>
      <div class="title">${greet} 🙏</div>
    </div>

    <div class="card">
      <h3>${t < 1 ? 'మొదటి రోజు చదువు' : 'ఈరోజు చదువు'} <small>${t < 1 ? 'Day 1 preview' : `Today's reading · due ${fmtDate(dueDate(clampDay(t)))}`}</small></h3>
      <div class="row">${today.map((r) => `<a class="chip st-${chapterStatus(r)}" href="${chapLink(r)}">${chapterStatus(r) === 'done' ? '✓ ' : ''}${esc(chapLabel(r))}</a>`).join('')}</div>
      <div class="row" style="margin-top:14px">
        ${startRef
          ? `<a class="btn primary" href="${chapLink(startRef)}">📖 చదవడం ప్రారంభించండి · Start: ${esc(chapLabel(startRef))}</a>`
          : `<span>🎉 ఈరోజు చదువు పూర్తయింది! Today's reading is complete.</span>`}
        ${lr && `${lr.book} ${lr.chapter}` !== startRef ? `<a class="btn ghost" href="#read/${lr.book}/${lr.chapter}">↺ Continue ${esc(bookName(lr.book))} ${lr.chapter}</a>` : ''}
      </div>
    </div>

    ${behind.length ? `
    <div class="card">
      <h3>💪 తిరిగి ట్రాక్‌లోకి <small>Gentle catch-up</small></h3>
      <p style="margin:0 0 10px;line-height:1.6">నిరుత్సాహపడకండి — దేవుని కృప ప్రతి ఉదయం కొత్తది (విలాప 3:23).<br>
        <span class="soft">You have ${behind.length} chapter${behind.length > 1 ? 's' : ''} to catch up. Read <b>${perDay} extra</b> a day for the next week${todayDone ? '' : ' alongside today’s reading'}, and you'll be right back on track.</span></p>
      <div class="row">${catchup.map((r) => `<a class="chip st-behind" href="${chapLink(r)}">${esc(chapLabel(r))}</a>`).join('')}</div>
      <div class="row" style="margin-top:12px"><button class="btn small ghost" id="freshStart">🌅 Fresh start — shift my plan so I'm on track from today</button></div>
    </div>` : ''}

    <div class="grid-2">
      <div class="card">
        <h3>🔥 వరుస రోజులు <small>Reading streak</small></h3>
        <div class="big-num">${streak} <small style="font-size:14px">day${streak === 1 ? '' : 's'}</small></div>
        <div class="week-dots">${Array.from({ length: 7 }, (_, i) => {
          const d = addDays(ws, i);
          const cls = readDays.has(d) ? 'read' : graceDays.has(d) ? 'grace' : '';
          return `<span class="${cls} ${d === todayStr() ? 'now' : ''}" title="${fmtDate(d, { weekday: 'long' })}">${'MTWTFSS'[i]}</span>`;
        }).join('')}</div>
        <p class="soft" style="font-size:12.5px;margin:10px 0 0;line-height:1.5">One missed day each week is a free <b>grace day</b> — your streak stays. Rest is part of the rhythm.</p>
      </div>
      <div class="card">
        <h3>📊 ప్రగతి <small>Progress</small></h3>
        <div class="big-num">${Math.round((doneCount / total) * 100)}%</div>
        <div class="progress" style="margin:8px 0"><span style="width:${(doneCount / total) * 100}%"></span></div>
        <div class="soft" style="font-size:13px">${doneCount} / ${total} chapters · ${testamentPct('OT')}% Old Testament · ${testamentPct('NT')}% New Testament</div>
        <div class="row" style="margin-top:10px"><a class="btn small" href="#index">Books index</a><a class="btn small" href="#plan">Full plan</a></div>
      </div>
    </div>

    <div class="card votd" style="margin-top:14px" id="votd"><h3>✨ నేటి వచనం <small>Verse of the day</small></h3><div class="soft">…</div></div>

    <div class="card">
      <h3>💛 మీరు ఎలా ఉన్నారు? <small>How are you feeling today?</small></h3>
      <div class="feel-chips">${FEELINGS.map(([te, en]) => `<button data-feel="${esc(`${te} / ${en}`)}">${te} <small>${en}</small></button>`).join('')}</div>
      <input type="text" id="feelNote" placeholder="మరింత చెప్పాలనుకుంటే… (optional: share a little more)" />
      <p class="soft" style="font-size:12px;margin:8px 0 0">The Pastor will suggest verses for your heart. ${S.state.aiConfigured ? '' : '<span class="err">Add GEMINI_API_KEY to .env to enable AI.</span>'}</p>
    </div>

    <div class="attribution">${ATTRIBUTION}</div>`;

  $('#freshStart')?.addEventListener('click', freshStart);
  $$('[data-feel]', view).forEach((b) => b.addEventListener('click', () =>
    askAI('feeling', { feeling: b.dataset.feel, note: $('#feelNote').value.trim() })));
  renderVotd();
}

function testamentPct(t) {
  const refs = S.planOrder.filter((r) => S.byCode[r.split(' ')[0]].testament === t);
  return Math.round((refs.filter((r) => S.state.completed[r]).length / refs.length) * 100);
}

function freshStart() {
  const first = behindList()[0];
  if (!first) return;
  const day = S.chapterDay[first];
  const newStart = addDays(todayStr(), -(day - 1));
  openModal(`
    <h3>🌅 కొత్త ఆరంభం · Fresh start</h3>
    <p style="line-height:1.6">Your plan will be shifted so that <b>${esc(chapLabel(first))}</b> (plan day ${day}) is today's reading.
      All chapters you've read stay green, nothing is lost — the finish date just moves to <b>${fmtDate(addDays(newStart, S.plan.length - 1), { day: 'numeric', month: 'long', year: 'numeric' })}</b>.</p>
    <p class="soft" style="font-size:13px">"ఆయన వాత్సల్యం ప్రతి ఉదయం కొత్తది." — There is no shame in starting again.</p>
    <div class="actions"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>Shift my plan</button></div>`,
  (el) => {
    $('[data-x]', el).onclick = closeModal;
    $('[data-ok]', el).onclick = () => {
      S.state.settings.planStart = newStart;
      patchSetting('planStart');
      closeModal();
      toast('Plan shifted — you are on track 🎉');
      route();
    };
  });
}

async function renderVotd() {
  const el = $('#votd');
  if (!el) return;
  const today = todayStr();
  const seed = diffDays('2026-01-01', today);
  // Every other day, revisit one of the user's own highlights (once they have a few).
  const hlKeys = Object.keys(S.state.highlights);
  let candidates = VOTD.map(parseRef).filter(Boolean);
  if (hlKeys.length >= 5 && seed % 2 === 0) {
    candidates = hlKeys.map((k) => { const [code, ch, v] = k.split('.'); return { code, ch: Number(ch), vs: [Number(v)] }; });
  }
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[(Math.abs(seed) + i) % candidates.length];
    const text = await passageText(p.code, p.ch, p.vs, false);
    if (!text || !$('#votd')) continue;
    el.innerHTML = `
      <h3>✨ నేటి వచనం <small>Verse of the day</small></h3>
      <div class="verse-text">${esc(text)}</div>
      <div class="row"><a href="#read/${p.code}/${p.ch}/${p.vs[0]}" style="font-weight:600;color:var(--accent);text-decoration:none">— ${esc(passageLabel(p.code, p.ch, p.vs))}</a>
        <span class="spacer"></span>
        <button class="btn small" data-ai="explain">🙏 Explain</button><button class="btn small" data-mem>🧠 Memorize</button></div>`;
    $('[data-ai]', el).onclick = () => askAI('explain', p);
    $('[data-mem]', el).onclick = () => addMemory(p);
    return;
  }
}

// ---- Book index -----------------------------------------------------------------------
function renderIndex() {
  const behind = behindList().length;
  const done = Object.keys(S.state.completed).length;
  const section = (t, title) => `
    <div class="testament-h" id="${t}">${title}</div>
    ${S.books.filter((b) => b.testament === t).map((b) => {
      const refs = Array.from({ length: b.chapters }, (_, i) => `${b.code} ${i + 1}`);
      const n = refs.filter((r) => S.state.completed[r]).length;
      return `<div class="card book">
        <div class="book-head"><b>${esc(b.te)}</b><small>${esc(b.en)}</small><span class="pct">${n}/${b.chapters} · ${Math.round((n / b.chapters) * 100)}%</span></div>
        <div class="cells">${refs.map((r, i) => `<a class="cell ${chapterStatus(r)}" href="${chapLink(r)}" title="${esc(chapLabel(r, 'en'))} · plan day ${S.chapterDay[r]} (${fmtDate(dueDate(S.chapterDay[r]))})">${i + 1}</a>`).join('')}</div>
      </div>`;
    }).join('')}`;
  view.innerHTML = `
    <h2 class="page-h">బైబిల్ పుస్తకాలు <small style="font-size:14px">Books</small></h2>
    <div class="card">
      <div class="row"><span><b>${done}</b> / ${S.planOrder.length} chapters read</span><span class="spacer"></span>
        ${behind ? `<span style="color:var(--behind)"><b>${behind}</b> behind plan</span>` : '<span style="color:var(--done)">✓ on track</span>'}</div>
      <div class="progress" style="margin-top:8px"><span style="width:${(done / S.planOrder.length) * 100}%"></span></div>
    </div>
    <div class="legend"><span><i class="done"></i>చదివారు · Read</span><span><i class="behind"></i>ప్రణాళిక కంటే వెనుక · Behind plan</span>
      <span><i class="today"></i>ఈరోజు · Today</span><span><i></i>రాబోయేవి · Upcoming</span>
      <span class="spacer"></span><a href="#index" data-jump="OT">పాత నిబంధన</a><a href="#index" data-jump="NT">కొత్త నిబంధన</a></div>
    ${section('OT', 'పాత నిబంధన · Old Testament')}
    ${section('NT', 'కొత్త నిబంధన · New Testament')}
    <div class="attribution">${ATTRIBUTION}</div>`;
  $$('[data-jump]', view).forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const target = $(`#${a.dataset.jump}`);
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - $('#bar').offsetHeight - 8, behavior: 'smooth' });
  }));
}

// ---- Reader -------------------------------------------------------------------------
async function renderRead(code, ch, v) {
  if (!code) {
    const lr = S.state.lastRead;
    const target = lr ? `${lr.book} ${lr.chapter}` : nextUnreadInQueue() || S.plan[0].chapters[0];
    location.replace(chapLink(target));
    return;
  }
  code = code.toUpperCase();
  code = CODE_ALIASES[code] || code;
  const book = S.byCode[code];
  if (!book) { location.replace('#index'); return; }
  ch = Math.min(Math.max(Number(ch) || 1, 1), book.chapters);
  S.reader = { code, ch };
  S.page = 0;
  const ref = `${code} ${ch}`;
  const prev = neighborChapter(code, ch, -1);
  const next = neighborChapter(code, ch, 1);
  $('#barTitle').innerHTML = `${esc(book.te)} ${ch} <small>· ${esc(book.en)}</small>`;

  view.innerHTML = `
    <section class="reader">
      <div class="reader-head">
        ${prev ? `<a href="${chapLink(prev)}" title="${esc(chapLabel(prev))}">‹ ${esc(chapLabel(prev))}</a>` : '<span></span>'}
        <span class="spacer"></span>
        ${next ? `<a href="${chapLink(next)}" title="${esc(chapLabel(next))}">${esc(chapLabel(next))} ›</a>` : ''}
      </div>
      <div class="page-wrap"><article id="text"><div class="empty">…</div></article></div>
      <div class="page-nav"><button data-page="-1" aria-label="Previous page">‹</button><span id="pageNo"></span><button data-page="1" aria-label="Next page">›</button></div>
    </section>`;

  const data = await loadBook(code);
  if (S.reader?.code !== code || S.reader?.ch !== ch || document.body.dataset.view !== 'read') return;
  const verses = data[ch] || [];
  // Some IRV verses are merged into the previous one (e.g. DEU 1:3-4); those slots are empty.
  $('#text').innerHTML = `
    <h1 class="chap-h">${esc(book.te)}<span>${ch}</span></h1>
    <p class="verses">${verses.map((t, i) => (t ? `<span class="v" data-v="${i + 1}"><sup>${i + 1}</sup>${esc(t)} </span>` : '')).join('')}</p>
    <div class="chap-end" id="chapEnd"></div>
    <span class="end-sentinel"></span>`;

  S.state.lastRead = { book: code, chapter: ch };
  patchState('lastRead');
  renderChapEnd(ref);
  applyReaderDecorations();
  setupPaging();

  if (v) {
    const el = $(`.v[data-v="${Number(v)}"]`);
    if (el) {
      el.classList.add('flash');
      if (S.state.settings.readingMode === 'paged') goPage(Math.floor(el.offsetLeft / $('.page-wrap').clientWidth));
      else el.scrollIntoView({ block: 'center' });
    }
  } else {
    window.scrollTo(0, 0);
  }
}

function renderChapEnd(ref) {
  const el = $('#chapEnd');
  if (!el) return;
  const day = S.chapterDay[ref];
  const doneOn = S.state.completed[ref];
  const planNext = nextInPlan(ref);
  const [code, ch] = ref.split(' ');
  const bookNext = neighborChapter(code, Number(ch), 1);
  el.innerHTML = `
    ${doneOn
      ? `<div style="color:var(--done);font-weight:600">✓ చదివారు · Read on ${fmtDate(doneOn, { day: 'numeric', month: 'long' })}</div>
         <div class="row"><button class="btn small ghost" id="undoRead">Undo</button><button class="btn small" id="reflect">📝 Reflect / Journal</button></div>`
      : `<button class="btn primary" id="markRead">✓ ఈ అధ్యాయం చదివాను · Mark chapter read</button>`}
    <div class="row">
      ${planNext ? `<a class="btn small" href="${chapLink(planNext)}">Next in plan: ${esc(chapLabel(planNext))} ›</a>` : ''}
      ${bookNext && bookNext !== planNext ? `<a class="btn small ghost" href="${chapLink(bookNext)}">${esc(chapLabel(bookNext))} ›</a>` : ''}
    </div>
    <div class="meta">Plan day ${day} · due ${fmtDate(dueDate(day), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
      · <span style="color:var(--${chapterStatus(ref) === 'behind' ? 'behind' : chapterStatus(ref) === 'done' ? 'done' : 'ink-soft'})">${{ done: 'done', behind: 'behind plan', today: "today's reading", future: 'upcoming' }[chapterStatus(ref)]}</span>
      <br>${ATTRIBUTION}</div>`;
  $('#markRead')?.addEventListener('click', () => markRead(ref, true));
  $('#undoRead')?.addEventListener('click', () => markRead(ref, false));
  $('#reflect')?.addEventListener('click', () => openJournalEditor(S.state.completed[ref] || todayStr()));
}

async function markRead(ref, done) {
  try {
    const res = await api('POST', '/complete', { chapter: ref, done, date: todayStr() });
    S.state.completed = res.completed;
  } catch (e) { toast(`సేవ్ కాలేదు / ${e.message}`); return; }
  renderChapEnd(ref);
  if (!done) return;
  const q = todaysQueue();
  const inQueue = [...q.catchup, ...q.today].includes(ref);
  const next = nextUnreadInQueue();
  if (inQueue && next) {
    toast(`✓ చక్కగా చేశారు! Next: ${chapLabel(next)}`);
    setTimeout(() => { if (S.reader && `${S.reader.code} ${S.reader.ch}` === ref) location.hash = chapLink(next); }, 1200);
  } else if (inQueue) {
    toast('🎉 ఈరోజు చదువు పూర్తయింది! Today’s reading is complete.');
    openJournalEditor(todayStr());
  } else {
    toast('✓ చక్కగా చేశారు! Well done.');
  }
}

function applyReaderDecorations() {
  if (!S.reader) return;
  const { code, ch } = S.reader;
  const colors = Object.fromEntries(S.state.highlightColors.map((c) => [c.id, c]));
  $$('#text .v').forEach((el) => {
    const v = Number(el.dataset.v);
    const hl = S.state.highlights[verseKey(code, ch, v)];
    const color = hl && colors[hl.colorId];
    el.classList.toggle('hl', Boolean(color));
    el.classList.toggle('has-note', Boolean(color && hl.note));
    el.classList.toggle('sel', S.selection.has(v));
    if (color) { el.style.setProperty('--hl', color.hex); el.title = color.name + (hl.note ? `\n✎ ${hl.note}` : ''); }
    else { el.style.removeProperty('--hl'); el.removeAttribute('title'); }
  });
}

// Paged mode: one CSS column per screen; each page is exactly the wrapper's width.
function setupPaging() {
  const reader = $('.reader');
  if (!reader) return;
  const paged = S.state.settings.readingMode === 'paged';
  reader.classList.toggle('paged', paged);
  const text = $('#text');
  if (!paged) {
    text.removeAttribute('style');
    $('.page-wrap').removeAttribute('style');
    return;
  }
  layoutPages();
  document.fonts?.ready.then(layoutPages);
}
function layoutPages() {
  const wrap = $('.page-wrap');
  const text = $('#text');
  if (!wrap || !text || !$('.reader.paged')) return;
  const W = wrap.clientWidth;
  const pad = W < 600 ? 20 : 44;
  const H = Math.max(240, window.innerHeight - wrap.getBoundingClientRect().top - window.scrollY - 52);
  wrap.style.height = `${H}px`;
  Object.assign(text.style, {
    height: `${H}px`, padding: `0 ${pad}px`, columnGap: `${2 * pad}px`, columnWidth: `${W - 2 * pad}px`,
  });
  S.pages = Math.floor($('.end-sentinel', text).offsetLeft / W) + 1;
  goPage(Math.min(S.page, S.pages - 1));
}
function goPage(p) {
  const wrap = $('.page-wrap');
  if (!wrap || !$('.reader.paged')) return;
  S.page = Math.max(0, Math.min(p, S.pages - 1));
  $('#text').style.transform = `translateX(${-S.page * wrap.clientWidth}px)`;
  $('#pageNo').textContent = `${S.page + 1} / ${S.pages}`;
}
function turnPage(dir) {
  if (S.page + dir >= S.pages && dir > 0) {
    const n = neighborChapter(S.reader.code, S.reader.ch, 1);
    if (n) location.hash = chapLink(n);
    return;
  }
  if (S.page + dir < 0) {
    const p = neighborChapter(S.reader.code, S.reader.ch, -1);
    if (p) location.hash = chapLink(p);
    return;
  }
  goPage(S.page + dir);
}

view.addEventListener('click', (e) => {
  if (document.body.dataset.view !== 'read') return;
  const pageBtn = e.target.closest('[data-page]');
  if (pageBtn) { turnPage(Number(pageBtn.dataset.page)); return; }
  const verse = e.target.closest('.v');
  if (verse) { toggleVerse(Number(verse.dataset.v)); return; }
  if (e.target.closest('a, button, input, textarea')) return;
  if (S.selection.size) { clearSelection(); return; }
  // Kindle-style: tap the outer edges to turn pages, the middle to show/hide the bars.
  if ($('.reader.paged') && e.target.closest('.page-wrap')) {
    const x = e.clientX / window.innerWidth;
    if (x < 0.2) { turnPage(-1); return; }
    if (x > 0.8) { turnPage(1); return; }
  }
  document.body.classList.toggle('focus');
});

let touchX = null, touchY = null;
view.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }, { passive: true });
view.addEventListener('touchend', (e) => {
  if (touchX === null || !$('.reader.paged')) return;
  const dx = e.changedTouches[0].clientX - touchX;
  const dy = e.changedTouches[0].clientY - touchY;
  touchX = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) turnPage(dx < 0 ? 1 : -1);
});
document.addEventListener('keydown', (e) => {
  if (document.body.dataset.view !== 'read' || e.target.closest('input, textarea, select')) return;
  if (!$('#modal').classList.contains('hidden')) return;
  if (e.key === 'Escape') { clearSelection(); closeDrawer(); return; }
  const paged = Boolean($('.reader.paged'));
  if (['ArrowRight', 'PageDown'].includes(e.key) || (e.key === ' ' && paged)) {
    e.preventDefault();
    if (paged) turnPage(1); else if (e.key === 'ArrowRight') turnPage(Infinity);
  } else if (['ArrowLeft', 'PageUp'].includes(e.key)) {
    if (paged) { e.preventDefault(); turnPage(-1); } else if (e.key === 'ArrowLeft') turnPage(-Infinity);
  }
});
let lastScrollY = 0;
window.addEventListener('scroll', () => {
  if (document.body.dataset.view !== 'read' || $('.reader.paged')) return;
  const y = window.scrollY;
  if (y > lastScrollY + 8 && y > 120) document.body.classList.add('focus');
  else if (y < lastScrollY - 8) document.body.classList.remove('focus');
  lastScrollY = y;
}, { passive: true });
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { measureBar(); layoutPages(); }, 150);
});

// ---- Verse selection sheet ---------------------------------------------------------
function toggleVerse(v) {
  if (S.selection.has(v)) S.selection.delete(v); else S.selection.add(v);
  applyReaderDecorations();
  renderSheet();
}
function clearSelection() {
  S.selection.clear();
  $('#sheet').classList.add('hidden');
  document.body.classList.remove('sheet-open');
  $$('#text .v.sel').forEach((el) => el.classList.remove('sel'));
}
function selectedPassage() {
  const vs = [...S.selection].sort((a, b) => a - b);
  return { code: S.reader.code, ch: S.reader.ch, vs };
}
function renderSheet() {
  if (!S.selection.size) { clearSelection(); return; }
  const p = selectedPassage();
  const keys = p.vs.map((v) => verseKey(p.code, p.ch, v));
  const current = new Set(keys.map((k) => S.state.highlights[k]?.colorId));
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-head"><b>${esc(passageLabel(p.code, p.ch, p.vs))}</b><small>${p.vs.length} verse${p.vs.length > 1 ? 's' : ''}</small>
      <span class="spacer"></span><button class="icon-btn" data-act="close" aria-label="Clear selection">✕</button></div>
    <div class="swatches">
      ${S.state.highlightColors.map((c) => `<button class="sw ${current.size === 1 && current.has(c.id) ? 'active' : ''}" data-color="${esc(c.id)}" style="--c:${esc(c.hex)}"><span class="dot"></span>${esc(c.name)}</button>`).join('')}
      ${[...current].some(Boolean) ? '<button class="sw" data-color=""><span class="dot" style="background:transparent;border:1px dashed var(--ink-soft)"></span>తీసివేయి · Remove</button>' : ''}
    </div>
    <div class="ai-main">
      <button data-ai="explain">🙏 పాస్టర్ వివరణ<small>Pastor help to understand</small></button>
      <button data-ai="prayer">🕊 పాస్టర్ ప్రార్థన<small>Pastor's prayer</small></button>
    </div>
    <div class="more-row">
      <button data-ai="apply">🌱 నా జీవితానికి · Apply</button>
      <button data-ai="context">📜 సందర్భం · Context</button>
      <button data-ai="xref">🔗 సంబంధిత వచనాలు · Cross-refs</button>
      <button data-act="note">✎ Note</button>
      <button data-act="memorize">🧠 Memorize</button>
      <button data-act="copy">📋 Copy</button>
    </div>`;
  sheet.classList.remove('hidden');
  document.body.classList.add('sheet-open');
}
$('#sheet').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const p = selectedPassage();
  if ('color' in btn.dataset) { await setHighlight(p, btn.dataset.color || null); clearSelection(); applyReaderDecorations(); return; }
  if (btn.dataset.ai) { askAI(btn.dataset.ai, p); return; }
  switch (btn.dataset.act) {
    case 'close': clearSelection(); applyReaderDecorations(); break;
    case 'note': openNoteEditor(p); break;
    case 'memorize': addMemory(p); clearSelection(); applyReaderDecorations(); break;
    case 'copy': {
      const text = await passageText(p.code, p.ch, p.vs);
      await copyText(`${text}\n— ${passageLabel(p.code, p.ch, p.vs)} (IRV తెలుగు)`);
      toast('📋 Copied');
      break;
    }
  }
});

async function setHighlight(p, colorId, note) {
  try {
    const res = await api('POST', '/highlights', { refs: p.vs.map((v) => verseKey(p.code, p.ch, v)), colorId, note });
    S.state.highlights = res.highlights;
    const c = S.state.highlightColors.find((x) => x.id === colorId);
    toast(c ? `🖍 Saved to “${c.name}”` : 'Highlight removed');
  } catch (e) { toast(`సేవ్ కాలేదు / ${e.message}`); }
}

function openNoteEditor(p) {
  const keys = p.vs.map((v) => verseKey(p.code, p.ch, v));
  const existing = keys.map((k) => S.state.highlights[k]).find(Boolean);
  let colorId = existing?.colorId || S.state.highlightColors[0].id;
  openModal(`
    <h3>✎ నోట్ · Note</h3>
    <div class="soft" style="margin-bottom:10px">${esc(passageLabel(p.code, p.ch, p.vs))}</div>
    <textarea id="noteText" placeholder="మీ ఆలోచనలు… Your thoughts">${esc(existing?.note || '')}</textarea>
    <label class="field">Highlight colour</label>
    <div class="swatches">${S.state.highlightColors.map((c) => `<button class="sw ${c.id === colorId ? 'active' : ''}" data-c="${esc(c.id)}" style="--c:${esc(c.hex)}"><span class="dot"></span>${esc(c.name)}</button>`).join('')}</div>
    <div class="actions"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>Save</button></div>`,
  (el) => {
    $$('[data-c]', el).forEach((b) => b.onclick = () => {
      colorId = b.dataset.c;
      $$('[data-c]', el).forEach((x) => x.classList.toggle('active', x === b));
    });
    $('[data-x]', el).onclick = closeModal;
    $('[data-ok]', el).onclick = async () => {
      await setHighlight(p, colorId, $('#noteText').value.trim());
      closeModal();
      if (document.body.dataset.view === 'read') { clearSelection(); applyReaderDecorations(); } else route();
    };
    $('#noteText').focus();
  });
}

// ---- AI drawer --------------------------------------------------------------------
let aiRequest = null;
function openDrawer() {
  $('#ai').classList.remove('hidden');
  if (window.innerWidth < 900) $('#aiBackdrop').classList.remove('hidden');
}
function closeDrawer() {
  $('#ai').classList.add('hidden');
  $('#aiBackdrop').classList.add('hidden');
  aiRequest = null;
}
$('#aiBackdrop').addEventListener('click', closeDrawer);

async function askAI(action, ctx) {
  const lang = S.state.settings.aiLang;
  const meta = AI_ACTIONS[action];
  const isFeeling = action === 'feeling';
  const reference = isFeeling ? ctx.feeling : passageLabel(ctx.code, ctx.ch, ctx.vs);
  const req = { action, ctx, lang, id: Symbol('ai') };
  aiRequest = req;

  const drawer = $('#ai');
  drawer.innerHTML = `
    <div class="drawer-head">
      <div class="row"><b>${meta.icon} ${meta.te}</b><small>${meta.en}</small><span class="spacer"></span>
        <button class="icon-btn" data-x aria-label="Close">✕</button></div>
      <div class="row" style="margin-top:6px"><span class="drawer-ref">${esc(reference)}</span><span class="spacer"></span>
        <span class="seg"><button data-lang="te" class="${lang === 'te' ? 'on' : ''}">తెలుగు</button><button data-lang="en" class="${lang === 'en' ? 'on' : ''}">English</button></span></div>
    </div>
    <div class="drawer-body" id="aiBody"><div class="thinking"><i></i>పాస్టర్ ఆలోచిస్తున్నారు… Pastor is thinking…</div></div>
    <div class="drawer-foot hidden" id="aiFoot"><div class="row">
      <button class="btn small" data-save>📝 డైరీలో సేవ్ · Save to journal</button>
      <button class="btn small ghost" data-copy>📋 Copy</button>
      <span class="spacer"></span><small>AI can make mistakes — test it with Scripture.</small></div></div>`;
  openDrawer();
  $('[data-x]', drawer).onclick = closeDrawer;
  $$('[data-lang]', drawer).forEach((b) => b.onclick = () => {
    S.state.settings.aiLang = b.dataset.lang;
    patchSetting('aiLang');
    askAI(action, ctx);
  });

  const cacheKey = JSON.stringify([action, reference, ctx.note || '', lang]);
  let result = S.aiCache.get(cacheKey);
  if (!result) {
    try {
      const text = isFeeling ? '' : await passageText(ctx.code, ctx.ch, ctx.vs);
      const bookCtx = isFeeling ? '' : ` (${passageLabel(ctx.code, ctx.ch, ctx.vs, 'en')}, IRV Telugu)`;
      result = await api('POST', '/ai', {
        action, lang, text, reference: reference + bookCtx, feeling: ctx.feeling, note: ctx.note,
      });
      S.aiCache.set(cacheKey, result);
    } catch (e) {
      if (aiRequest !== req) return;
      $('#aiBody').innerHTML = `<p class="err">⚠ ${esc(e.message)}</p>`;
      return;
    }
  }
  if (aiRequest !== req) return;

  const body = $('#aiBody');
  if (result.data) {
    body.innerHTML = `${result.data.intro ? renderMarkdown(result.data.intro) : ''}<div id="refCards"></div>`;
    await renderRefCards($('#refCards'), result.data.verses || []);
  } else {
    body.innerHTML = renderMarkdown(result.text);
  }
  const plain = result.text || [result.data.intro, ...(result.data.verses || []).map((x) => `- ${x.ref}: ${x.why}`)].join('\n');
  $('#aiFoot').classList.remove('hidden');
  $('[data-copy]', drawer).onclick = () => copyText(`${meta.te} · ${reference}\n\n${plain}`).then(() => toast('📋 Copied'));
  $('[data-save]', drawer).onclick = () => {
    const day = todayStr();
    const entry = (S.state.journal[day] ||= {});
    (entry.saved ||= []).push({ action, reference, text: plain, ts: Date.now() });
    saveJournal(day);
    toast('📝 Saved to today’s journal');
  };
}

async function renderRefCards(el, items) {
  const cards = await Promise.all(items.map(async (item) => {
    const p = parseRef(item.ref);
    const vs = p && (p.vs.length ? p.vs : [1]);
    const text = p ? await passageText(p.code, p.ch, vs).catch(() => '') : '';
    // A reference the model made up (bad book, chapter or verse) is shown unlinked.
    if (!p || (p.vs.length && !text)) return `<div class="ref-card"><b>${esc(item.ref)}</b><div class="why">${esc(item.why)}</div></div>`;
    return `<div class="ref-card">
      <a href="#read/${p.code}/${p.ch}/${vs[0]}" data-go>${esc(p.vs.length ? passageLabel(p.code, p.ch, p.vs) : `${bookName(p.code)} ${p.ch}`)}</a>
      <div class="why">${esc(item.why)}</div>
      ${text ? `<div class="verse-text" style="font-size:15.5px">${esc(text)}</div>` : ''}
    </div>`;
  }));
  el.innerHTML = cards.join('') || '<p class="soft">No verses returned.</p>';
  $$('[data-go]', el).forEach((a) => a.addEventListener('click', () => { if (window.innerWidth < 900) closeDrawer(); }));
}

// ---- Settings panel -------------------------------------------------------------------
function renderSettings() {
  const s = S.state.settings;
  const opt = (key, options) => `<div class="opt-row">${options.map(([val, label]) => `<button data-set="${key}" data-val="${val}" class="${String(s[key]) === String(val) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
  $('#settings').innerHTML = `
    <div class="row"><b>చదివే సెట్టింగ్స్ · Reading settings</b><span class="spacer"></span><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <h4>Theme</h4>
    <div class="themes">${[['paper', 'కాగితం<br><small>Paper</small>'], ['sepia', 'సెపియా<br><small>Sepia</small>'], ['white', 'తెలుపు<br><small>White</small>'], ['night', 'రాత్రి<br><small>Night</small>']]
      .map(([t, l]) => `<button data-theme-pick="${t}" class="${s.theme === t ? 'on' : ''}" style="background:${THEME_COLORS[t]};color:${t === 'night' ? '#c8c0b0' : '#3b3226'}">${l}</button>`).join('')}</div>
    <h4>Font</h4>
    ${opt('font', [['serif', '<span style="font-family:Noto Serif Telugu">అక్షరం</span> Serif'], ['sans', '<span style="font-family:Noto Sans Telugu">అక్షరం</span> Sans'], ['mandali', '<span style="font-family:Mandali">అక్షరం</span> Mandali'], ['ramaraja', '<span style="font-family:Ramaraja">అక్షరం</span> Ramaraja']])}
    <h4>Text size</h4>
    <div class="slider"><small>అ</small><input type="range" min="16" max="34" step="1" value="${s.fontSize}" data-range="fontSize"><b style="font-size:20px">అ</b><span>${s.fontSize}px</span></div>
    <h4>Line spacing</h4>
    <div class="slider"><input type="range" min="1.4" max="2.5" step="0.1" value="${s.lineHeight}" data-range="lineHeight"><span>${s.lineHeight}</span></div>
    <h4>Reading mode</h4>
    ${opt('readingMode', [['scroll', '↕ Scroll'], ['paged', '📖 Pages (Kindle)']])}
    <h4>Verse layout</h4>
    ${opt('verseLayout', [['flow', '¶ Paragraph'], ['lines', '☰ Verse per line']])}
    <h4>Screen dimmer</h4>
    <div class="slider"><span>☀</span><input type="range" min="0" max="60" step="5" value="${s.dim}" data-range="dim"><span>${s.dim}%</span></div>
    <h4>Eye care</h4>
    ${opt('eyeRest', [['true', '👀 20-20-20 reminder on'], ['false', 'Off']])}
    <p class="soft" style="font-size:12px;margin:6px 0 0">Every 20 minutes of reading: look ~20 feet away for 20 seconds.</p>
    <h4>Pastor AI language</h4>
    ${opt('aiLang', [['te', 'తెలుగు'], ['en', 'English']])}
    <h4>Plan start date</h4>
    <input type="date" value="${esc(s.planStart)}" data-date="planStart">`;
}
function openSettings() { renderSettings(); $('#settings').classList.remove('hidden'); }
$('#btnSettings').addEventListener('click', () => {
  if ($('#settings').classList.contains('hidden')) openSettings(); else $('#settings').classList.add('hidden');
});
function updateSetting(key, value, rerender = true) {
  const s = S.state.settings;
  s[key] = value;
  applySettings();
  patchSetting(key);
  if (rerender) renderSettings();
  if (document.body.dataset.view === 'read') {
    if (key === 'readingMode') { S.page = 0; setupPaging(); window.scrollTo(0, 0); }
    else layoutPages();
  }
  if (key === 'planStart' && document.body.dataset.view !== 'read') route();
}
$('#settings').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if ('close' in t.dataset) { $('#settings').classList.add('hidden'); return; }
  if (t.dataset.themePick) { updateSetting('theme', t.dataset.themePick); return; }
  if (t.dataset.set) {
    const raw = t.dataset.val;
    updateSetting(t.dataset.set, raw === 'true' ? true : raw === 'false' ? false : raw);
  }
});
$('#settings').addEventListener('input', (e) => {
  const key = e.target.dataset.range;
  if (!key) return;
  updateSetting(key, Number(e.target.value), false);
  e.target.parentElement.querySelector('span:last-child').textContent =
    key === 'fontSize' ? `${e.target.value}px` : key === 'dim' ? `${e.target.value}%` : e.target.value;
});
$('#settings').addEventListener('change', (e) => {
  if (e.target.dataset.date && e.target.value) updateSetting('planStart', e.target.value, false);
});
document.addEventListener('click', (e) => {
  const panel = $('#settings');
  const path = e.composedPath();
  if (!panel.classList.contains('hidden') && !path.includes(panel) && !path.includes($('#btnSettings'))) panel.classList.add('hidden');
});

// ---- Highlights ---------------------------------------------------------------------
async function renderHighlights(filter) {
  const colors = S.state.highlightColors;
  const colorById = Object.fromEntries(colors.map((c) => [c.id, c]));
  const bookIdx = Object.fromEntries(S.books.map((b, i) => [b.code, i]));
  const entries = Object.entries(S.state.highlights)
    .map(([k, h]) => { const [code, ch, v] = k.split('.'); return { code, ch: Number(ch), v: Number(v), ...h }; })
    .filter((h) => colorById[h.colorId] && (!filter || h.colorId === filter))
    .sort((a, b) => bookIdx[a.code] - bookIdx[b.code] || a.ch - b.ch || a.v - b.v);

  // Merge runs of consecutive verses with the same colour and note.
  const groups = [];
  for (const h of entries) {
    const g = groups[groups.length - 1];
    if (g && g.code === h.code && g.ch === h.ch && g.vs[g.vs.length - 1] === h.v - 1 && g.colorId === h.colorId && g.note === h.note) g.vs.push(h.v);
    else groups.push({ code: h.code, ch: h.ch, vs: [h.v], colorId: h.colorId, note: h.note });
  }
  const counts = {};
  Object.values(S.state.highlights).forEach((h) => { counts[h.colorId] = (counts[h.colorId] || 0) + 1; });

  view.innerHTML = `
    <div class="row"><h2 class="page-h">హైలైట్స్ <small style="font-size:14px">Highlights</small></h2><span class="spacer"></span>
      <button class="btn small" id="renameColors">✎ రంగుల పేర్లు · Rename colours</button></div>
    <div class="color-tabs">
      <a class="chip ${filter ? '' : 'active'}" href="#highlights">అన్నీ · All (${Object.keys(S.state.highlights).length})</a>
      ${colors.map((c) => `<a class="chip ${filter === c.id ? 'active' : ''}" href="#highlights/${esc(c.id)}"><span style="width:12px;height:12px;border-radius:50%;background:${esc(c.hex)}"></span>${esc(c.name)} (${counts[c.id] || 0})</a>`).join('')}
    </div>
    <div id="hlList">${groups.length ? '<div class="empty">…</div>' : `<div class="empty">ఇంకా హైలైట్స్ లేవు.<br>While reading, tap a verse and pick a colour to save it here.</div>`}</div>`;
  $('#renameColors').onclick = openColorEditor;
  if (!groups.length) return;

  const texts = await Promise.all(groups.map((g) => passageText(g.code, g.ch, g.vs)));
  if (document.body.dataset.view !== 'highlights') return;
  $('#hlList').innerHTML = groups.map((g, i) => `
    <div class="card hl-item" data-i="${i}">
      <div class="bar" style="--c:${esc(colorById[g.colorId].hex)}"></div>
      <div class="body">
        <div class="row"><a class="ref" href="#read/${g.code}/${g.ch}/${g.vs[0]}">${esc(passageLabel(g.code, g.ch, g.vs))}</a>
          <small>${esc(colorById[g.colorId].name)}</small><span class="spacer"></span>
          <button class="icon-btn" data-a="explain" title="Pastor help">🙏</button>
          <button class="icon-btn" data-a="note" title="Edit note">✎</button>
          <button class="icon-btn" data-a="remove" title="Remove highlight">🗑</button></div>
        <div class="verse-text">${esc(texts[i])}</div>
        ${g.note ? `<div class="note">✎ ${esc(g.note)}</div>` : ''}
      </div>
    </div>`).join('');
  $('#hlList').onclick = async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const g = groups[Number(b.closest('[data-i]').dataset.i)];
    if (b.dataset.a === 'explain') askAI('explain', g);
    if (b.dataset.a === 'note') openNoteEditor(g);
    if (b.dataset.a === 'remove') { await setHighlight(g, null); route(); }
  };
}
function openColorEditor() {
  openModal(`
    <h3>✎ రంగుల పేర్లు · Highlight colours</h3>
    <p class="soft" style="font-size:13px;margin-top:0">Give each colour a meaning, e.g. Promises, Prayers, Commands…</p>
    ${S.state.highlightColors.map((c) => `<div class="row" style="margin:8px 0;flex-wrap:nowrap"><input type="color" value="${esc(c.hex)}" data-hex="${esc(c.id)}" style="width:44px;height:38px;border:0;background:none;padding:0"><input type="text" value="${esc(c.name)}" data-name="${esc(c.id)}"></div>`).join('')}
    <div class="actions"><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>Save</button></div>`,
  (el) => {
    $('[data-x]', el).onclick = closeModal;
    $('[data-ok]', el).onclick = () => {
      S.state.highlightColors = S.state.highlightColors.map((c) => ({
        ...c,
        name: $(`[data-name="${esc(c.id)}"]`, el).value.trim() || c.name,
        hex: $(`[data-hex="${c.id}"]`, el).value,
      }));
      patchState('highlightColors');
      closeModal();
      route();
    };
  });
}

// ---- Plan -------------------------------------------------------------------------
function renderPlan() {
  const t = planDayToday();
  const behind = behindList().length;
  const daysDone = S.plan.filter((d) => d.chapters.every((r) => S.state.completed[r])).length;
  let html = '';
  let month = '';
  for (const d of S.plan) {
    const date = dueDate(d.day);
    const m = fmtDate(date, { month: 'long', year: 'numeric' });
    if (m !== month) { html += `<div class="month-h">${m}</div>`; month = m; }
    const allDone = d.chapters.every((r) => S.state.completed[r]);
    const status = allDone ? 'done' : d.day < t ? 'behind' : d.day === t ? 'today' : 'future';
    html += `<div class="plan-day ${d.day === t ? 'is-today' : ''}" ${d.day === clampDay(t) ? 'id="todayRow"' : ''}>
      <div class="d"><b>Day ${d.day}</b>${fmtDate(date, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
      <div class="chs">${d.chapters.map((r) => `<a class="chip st-${chapterStatus(r)}" href="${chapLink(r)}">${esc(chapLabel(r))}</a>`).join('')}</div>
      <div class="act">${allDone ? '<span style="color:var(--done)">✓</span>'
        : status === 'future' ? `<small>${d.verses} vv</small>`
        : `<button class="btn small ghost" data-markday="${d.day}" title="Mark all chapters of this day as read">✓ All</button>`}</div>
    </div>`;
  }
  view.innerHTML = `
    <h2 class="page-h">ఒక సంవత్సర ప్రణాళిక <small style="font-size:14px">1-year chronological plan</small></h2>
    <div class="card">
      <div class="row">
        <div><div class="soft" style="font-size:12px">Started</div><input type="date" id="planStart" value="${esc(S.state.settings.planStart)}" style="width:auto"></div>
        <div><div class="soft" style="font-size:12px">Finishes</div><b>${fmtDate(dueDate(S.plan.length), { day: 'numeric', month: 'long', year: 'numeric' })}</b></div>
        <span class="spacer"></span>
        <div style="text-align:right"><b>${daysDone}</b> / ${S.plan.length} days complete<br>
          ${behind ? `<span style="color:var(--behind)">${behind} chapters behind</span>` : '<span style="color:var(--done)">on track</span>'}</div>
      </div>
      <p class="soft" style="font-size:12.5px;margin:10px 0 0;line-height:1.55">Chronological order — Job is read with the patriarchs, Psalms with David's life, the prophets alongside Kings & Chronicles, and the letters within Acts. Each day is about 85 verses (~15–20 minutes).</p>
      <div class="row" style="margin-top:10px"><a class="btn small" href="#plan" id="jumpToday">↓ Jump to today</a></div>
    </div>
    <div class="legend"><span><i class="done"></i>Read</span><span><i class="behind"></i>Behind plan</span><span><i class="today"></i>Today</span><span><i></i>Upcoming</span></div>
    <div id="planList">${html}</div>`;

  $('#planStart').addEventListener('change', (e) => { if (e.target.value) updateSetting('planStart', e.target.value, false); });
  const jump = () => {
    const row = $('#todayRow');
    if (row) window.scrollTo({ top: row.getBoundingClientRect().top + window.scrollY - $('#bar').offsetHeight - 60 });
  };
  $('#jumpToday').addEventListener('click', (e) => { e.preventDefault(); jump(); });
  if (t > 1) jump();
  $('#planList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-markday]');
    if (!b) return;
    b.disabled = true;
    const day = S.plan[Number(b.dataset.markday) - 1];
    const chapters = day.chapters.filter((x) => !S.state.completed[x]);
    const res = await api('POST', '/complete', { chapters, done: true, date: todayStr() }).catch((err) => toast(err.message));
    if (res) S.state.completed = res.completed;
    const y = window.scrollY;
    renderPlan();
    window.scrollTo(0, y);
  });
}

// ---- Journal -------------------------------------------------------------------------
const JOURNAL_QUESTIONS = [
  ['says', 'ఈ భాగం ఏమి చెబుతోంది?', 'What does it say?'],
  ['toMe', 'ఇది నాకు ఏమి చెబుతోంది?', 'What is God saying to me?'],
  ['willDo', 'నేను ఏమి చేస్తాను?', 'What will I do (one step)?'],
];
function chaptersReadOn(day) {
  return Object.entries(S.state.completed).filter(([, d]) => d === day).map(([r]) => r)
    .sort((a, b) => S.planOrder.indexOf(a) - S.planOrder.indexOf(b));
}
function openJournalEditor(day, opts = {}) {
  const e = S.state.journal[day] || {};
  let mood = e.mood || '';
  const chs = chaptersReadOn(day);
  openModal(`
    <h3>📝 ఆలోచించండి · Reflect</h3>
    <div class="soft" style="font-size:13px">${fmtDate(day, { weekday: 'long', day: 'numeric', month: 'long' })}${chs.length ? ` · ${chs.map((r) => esc(chapLabel(r))).join(', ')}` : ''}</div>
    <p class="soft" style="font-size:12.5px;margin:8px 0 0">Two quiet minutes help the Word sink in. Everything here is optional.</p>
    ${JOURNAL_QUESTIONS.map(([k, te, en]) => `<label class="field">${te} · ${en}</label><textarea data-k="${k}">${esc(e[k] || '')}</textarea>`).join('')}
    <label class="field">ఈరోజు నా మనస్థితి · How is my heart today?</label>
    <div class="moods">${MOODS.map((m) => `<button data-mood="${m}" class="${m === mood ? 'on' : ''}">${m}</button>`).join('')}</div>
    <label class="field">ఒక కృతజ్ఞత · One thing I'm thankful for</label>
    <input type="text" data-k="gratitude" value="${esc(e.gratitude || '')}">
    <div class="actions">
      <button class="btn" data-x>${opts.after ? 'Skip' : 'Cancel'}</button>
      <button class="btn primary" data-ok>Save${opts.afterLabel ? ` · ${esc(opts.afterLabel)}` : ''}</button>
    </div>`,
  (el) => {
    $$('[data-mood]', el).forEach((b) => b.onclick = () => {
      mood = mood === b.dataset.mood ? '' : b.dataset.mood;
      $$('[data-mood]', el).forEach((x) => x.classList.toggle('on', x.dataset.mood === mood));
    });
    const finish = () => { closeModal(); opts.after?.(); };
    $('[data-x]', el).onclick = finish;
    $('[data-ok]', el).onclick = () => {
      const entry = (S.state.journal[day] ||= {});
      $$('[data-k]', el).forEach((f) => { entry[f.dataset.k] = f.value.trim(); });
      entry.mood = mood;
      entry.chapters = chaptersReadOn(day);
      saveJournal(day);
      toast('📝 Journal saved');
      finish();
      if (document.body.dataset.view === 'journal') route();
    };
  });
}
function renderJournal() {
  const days = new Set([...Object.keys(S.state.journal), ...Object.values(S.state.completed)]);
  const list = [...days].sort().reverse();
  view.innerHTML = `
    <div class="row"><h2 class="page-h">ఆత్మీయ డైరీ <small style="font-size:14px">Journal</small></h2><span class="spacer"></span>
      <button class="btn primary small" id="newEntry">＋ ఈరోజు · Today's reflection</button></div>
    ${list.length ? list.map((day) => {
      const e = S.state.journal[day] || {};
      const chs = chaptersReadOn(day);
      const hasText = JOURNAL_QUESTIONS.some(([k]) => e[k]) || e.gratitude || e.mood;
      return `<div class="card">
        <div class="row"><b>${fmtDate(day, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}</b><span style="font-size:20px">${esc(e.mood)}</span>
          <span class="spacer"></span><button class="btn small ghost" data-edit="${esc(day)}">✎ ${hasText ? 'Edit' : 'Reflect'}</button></div>
        ${chs.length ? `<div class="row" style="margin-top:6px">${chs.map((r) => `<a class="chip st-done" href="${chapLink(r)}">${esc(chapLabel(r))}</a>`).join('')}</div>` : ''}
        ${JOURNAL_QUESTIONS.filter(([k]) => e[k]).map(([k, te, en]) => `<div class="j-q">${te} · ${en}</div><div class="j-a">${esc(e[k])}</div>`).join('')}
        ${e.gratitude ? `<div class="j-q">🙏 Thankful for</div><div class="j-a">${esc(e.gratitude)}</div>` : ''}
        ${(e.saved || []).map((s, i) => `<details class="saved"><summary>${AI_ACTIONS[s.action]?.icon || '💬'} ${esc(AI_ACTIONS[s.action]?.te || s.action)} · ${esc(s.reference)}
          <button class="icon-btn" data-del="${esc(day)}|${i}" title="Delete" style="float:right;padding:0 6px">🗑</button></summary><div class="drawer-body">${renderMarkdown(s.text)}</div></details>`).join('')}
      </div>`;
    }).join('') : '<div class="empty">ఇంకా ఏమీ లేదు. After you read a chapter, take a moment to write what God is saying to you.</div>'}`;
  $('#newEntry').onclick = () => openJournalEditor(todayStr());
  view.onclick = (e) => {
    if (document.body.dataset.view !== 'journal') return;
    const ed = e.target.closest('[data-edit]');
    if (ed) openJournalEditor(ed.dataset.edit);
    const del = e.target.closest('[data-del]');
    if (del) {
      e.preventDefault();
      const [day, i] = del.dataset.del.split('|');
      S.state.journal[day].saved.splice(Number(i), 1);
      saveJournal(day);
      renderJournal();
    }
  };
}

// ---- Memorize (Leitner boxes) ---------------------------------------------------------
const BOX_DAYS = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16 };
const memKey = (p) => `${p.code}.${p.ch}.${compressRanges(p.vs)}`;
function addMemory(p) {
  const key = memKey(p);
  if (S.state.memory.some((m) => m.ref === key)) { toast('Already in your memory cards'); return; }
  const card = { ref: key, code: p.code, ch: p.ch, vs: p.vs, box: 1, due: todayStr(), added: todayStr() };
  S.state.memory.push(card);
  saveMemoryCard(card);
  toast(`🧠 Added ${passageLabel(p.code, p.ch, p.vs)} to memory cards`);
}
async function renderMemorize() {
  const today = todayStr();
  const due = S.state.memory.filter((m) => m.due <= today);
  const queue = [...due];
  view.innerHTML = `
    <h2 class="page-h">కంఠస్థం <small style="font-size:14px">Memorize Scripture</small></h2>
    <p class="soft" style="margin-top:-6px">“నీ వాక్యాన్ని నా హృదయంలో దాచుకున్నాను” — కీర్తన 119:11</p>
    <div class="card" id="review"></div>
    <h3 style="font-size:15px;margin:22px 0 10px">All cards (${S.state.memory.length})</h3>
    <div id="memList"></div>`;

  const list = await Promise.all(S.state.memory.map(async (m) => ({ m, text: await passageText(m.code, m.ch, m.vs, false) })));
  if (document.body.dataset.view !== 'memorize') return;
  const textOf = new Map(list.map(({ m, text }) => [m.ref, text]));
  $('#memList').innerHTML = list.length ? list.map(({ m, text }) => `
    <div class="card"><div class="row"><b>${esc(passageLabel(m.code, m.ch, m.vs))}</b>
      <span class="boxes" title="Box ${m.box} of 5">${[1, 2, 3, 4, 5].map((b) => `<i class="${b <= m.box ? 'on' : ''}"></i>`).join('')}</span>
      <span class="spacer"></span><small>next ${m.due <= today ? 'today' : fmtDate(m.due)}</small>
      <button class="icon-btn" data-rm="${esc(m.ref)}" title="Remove">🗑</button></div>
      <div class="verse-text soft" style="font-size:15px;margin-top:4px">${esc(text)}</div></div>`).join('')
    : '<div class="empty">No cards yet. While reading, select verses and tap “🧠 Memorize”.</div>';
  $('#memList').onclick = (e) => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    S.state.memory = S.state.memory.filter((m) => m.ref !== b.dataset.rm);
    removeMemoryCard(b.dataset.rm);
    renderMemorize();
  };

  const showNext = () => {
    const el = $('#review');
    if (!el) return;
    const m = queue[0];
    if (!m) {
      el.innerHTML = `<div class="flash-card"><div style="font-size:34px">🎉</div><b>${due.length ? 'ఈరోజు పునశ్చరణ పూర్తయింది!' : 'ఈరోజు కార్డులు లేవు'}</b>
        <div class="soft">${due.length ? 'Review done for today.' : 'Nothing due today.'}</div></div>`;
      return;
    }
    const text = textOf.get(m.ref) || '';
    const hint = text.split(/\s+/).slice(0, 3).join(' ');
    el.innerHTML = `<div class="flash-card">
      <div class="soft" style="font-size:12px">${queue.length} card${queue.length > 1 ? 's' : ''} left today</div>
      <div class="ref">${esc(passageLabel(m.code, m.ch, m.vs))}</div>
      <div class="soft">${esc(hint)} …</div>
      <p class="soft" style="font-size:13px">Say it aloud from memory, then reveal.</p>
      <button class="btn primary" id="reveal">👁 వచనం చూపించు · Show verse</button></div>`;
    $('#reveal').onclick = () => {
      el.innerHTML = `<div class="flash-card">
        <div class="ref">${esc(passageLabel(m.code, m.ch, m.vs))}</div>
        <div class="verse-text">${esc(text)}</div>
        <div class="row" style="justify-content:center">
          <button class="btn" data-grade="again">↺ మళ్ళీ · Again</button>
          <button class="btn" data-grade="hard">కష్టం · Hard</button>
          <button class="btn primary" data-grade="good">✓ గుర్తుంది · Got it</button></div></div>`;
      $$('[data-grade]', el).forEach((b) => b.onclick = () => {
        const g = b.dataset.grade;
        queue.shift();
        // Again: back to box 1 and once more later in this session. Hard: stay in the box, come back sooner.
        if (g === 'again') { m.box = 1; m.due = today; queue.push(m); }
        else if (g === 'hard') { m.due = addDays(today, Math.max(1, Math.ceil(BOX_DAYS[m.box] / 2))); }
        else { m.box = Math.min(5, m.box + 1); m.due = addDays(today, BOX_DAYS[m.box]); }
        saveMemoryCard(m);
        showNext();
      });
    };
  };
  showNext();
}

// ---- Eye rest (20-20-20) ------------------------------------------------------------
let readingMinutes = 0;
setInterval(() => {
  if (document.visibilityState !== 'visible' || document.body.dataset.view !== 'read' || !S.state?.settings.eyeRest) return;
  if (++readingMinutes < 20 || !$('#modal').classList.contains('hidden')) return;
  readingMinutes = 0;
  let left = 20;
  openModal(`<div style="text-align:center"><div style="font-size:40px">👀</div><h3>కళ్ళకు విశ్రాంతి · Rest your eyes</h3>
    <p class="soft">Look at something about 20 feet away for 20 seconds. Blink slowly.</p>
    <div class="big-num" id="eyeCount">20</div>
    <div class="actions" style="justify-content:center"><button class="btn" data-x>Skip</button></div></div>`,
  (el) => {
    const timer = setInterval(() => {
      left -= 1;
      const c = $('#eyeCount');
      if (!c) { clearInterval(timer); return; }
      c.textContent = left;
      if (left <= 0) { clearInterval(timer); closeModal(); toast('✓ Back to reading'); }
    }, 1000);
    $('[data-x]', el).onclick = () => { clearInterval(timer); closeModal(); };
  });
}, 60 * 1000);

// ---- Sync with other devices -------------------------------------------------------
// Also re-render when the calendar day changed while the app sat in the background.
let shownDay = todayStr();
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') { flushPatch(); return; }
  if (Object.keys(pendingPatch).length || !$('#modal').classList.contains('hidden')) return;
  const dayChanged = shownDay !== todayStr();
  shownDay = todayStr();
  try {
    const fresh = normalizeState(await api('GET', '/state'));
    if (!dayChanged && JSON.stringify(fresh) === JSON.stringify(S.state)) return;
    S.state = fresh;
    applySettings();
    if (document.body.dataset.view === 'read') { applyReaderDecorations(); if (S.reader) renderChapEnd(`${S.reader.code} ${S.reader.ch}`); }
    else route();
  } catch { /* offline — keep local state */ }
});

// ---- Boot ----------------------------------------------------------------------------
(async function init() {
  try {
    const [books, plan, state] = await Promise.all([
      fetch('/bible/data/books.json').then((r) => { if (!r.ok) throw new Error('Bible data missing — run "npm run bible:fetch".'); return r.json(); }),
      fetch('/bible/data/plan-chronological.json').then((r) => r.json()),
      api('GET', '/state'),
    ]);
    S.books = books;
    S.byCode = Object.fromEntries(books.map((b) => [b.code, b]));
    S.plan = plan;
    for (const d of plan) for (const r of d.chapters) { S.chapterDay[r] = d.day; S.planOrder.push(r); }
    S.state = normalizeState(state);
    applySettings();
    route();
  } catch (e) {
    view.innerHTML = `<div class="empty err">⚠ ${esc(e.message)}</div>`;
  }
})();
