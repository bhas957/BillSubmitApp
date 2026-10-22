// Floating "Ask about my reports" chat: a robot button at the bottom right that
// opens a chat panel. Attached files (PDF, CSV, text, images) stay with the chat
// and are sent with every question, along with all the stored records.
// Needs health.js first. Add with <script src="chat.js" defer></script>.
(function () {
  const { api, esc, url, profile } = window.Health;
  const KEY = `health-ask-thread-${profile()}`;
  const ACCEPT = '.pdf,.csv,.tsv,.txt,.md,.json,.png,.jpg,.jpeg,.webp';
  const MAX_FILE = 10 * 1024 * 1024;
  const MAX_FILES = 5;
  const SUGGEST = [
    'What is out of range in my latest report, most important first?',
    'How has my TSH changed over the years, and what should I ask the endocrinologist?',
    'Could my results explain my fatigue and leg pain?',
    'What should I eat and avoid for my cholesterol and insulin?',
    'Did my Vitamin D supplement actually raise my Vitamin D?',
    'Which tests should I repeat, and when?',
  ];
  const ROBOT = '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 4v4"/><circle cx="16" cy="3.5" r="1.3" fill="currentColor"/><rect x="6" y="8" width="20" height="16" rx="4"/><circle cx="12" cy="15" r="2" fill="currentColor"/><circle cx="20" cy="15" r="2" fill="currentColor"/><path d="M12.5 20h7"/><path d="M3 14v5M29 14v5"/><path d="M11 24v3h10v-3"/></svg>';
  const CLIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7.1"/></svg>';

  let history = [];
  try { history = JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch { history = []; }
  let files = []; // File objects; kept in memory only, so a reload drops them
  let busy = false;
  let loaded = false;

  // Small, safe Markdown: escape first, then links, bold/italic, headings, lists, paragraphs.
  function md(text) {
    const inline = (s) => esc(s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    const out = [];
    let list = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd();
      let m;
      if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
      else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
      else if ((m = line.match(/^#{1,4}\s+(.*)/))) { close(); out.push(`<h4>${inline(m[1])}</h4>`); }
      else if (!line.trim()) close();
      else { close(); out.push(`<p${/^based on:/i.test(line) ? ' class="based"' : ''}>${inline(line)}</p>`); }
    }
    close();
    return out.join('');
  }

  const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const safeHref = (u) => (/^https?:\/\//i.test(u) ? u : '#');

  function sourcesHtml(h) {
    if (!h.sources?.length && !h.searches?.length) return '';
    return `<div class="hc-sources"><div class="who">From the web</div>
      ${h.sources?.length ? `<ol>${h.sources.map((s) => `<li><a href="${esc(safeHref(s.uri))}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></li>`).join('')}</ol>` : ''}
      ${h.searches?.length ? `<div class="hc-searches">Searched: ${h.searches.map((q) => `<a href="https://www.google.com/search?q=${encodeURIComponent(q)}" target="_blank" rel="noopener noreferrer">${esc(q)}</a>`).join(' · ')}</div>` : ''}
    </div>`;
  }

  // ---- DOM ----
  const root = document.createElement('div');
  root.className = 'hc no-print';
  root.innerHTML = `
    <button class="hc-fab" type="button" aria-expanded="false" aria-controls="hcPanel" title="Ask about my reports">${ROBOT}<span class="hc-fab-label">Ask AI</span></button>
    <section class="hc-panel hidden" id="hcPanel" role="dialog" aria-label="Ask about my reports">
      <header class="hc-head">
        <span class="hc-head-icon">${ROBOT}</span>
        <div class="hc-head-text"><b>Ask about my reports</b><span id="hcCtx">Loading your records…</span></div>
        <button class="btn ghost small hidden" type="button" id="hcClear" title="Start a new chat">New</button>
        <button class="btn ghost small hc-x" type="button" id="hcClose" aria-label="Close chat">✕</button>
      </header>
      <div class="hc-body" id="hcBody">
        <div class="hc-suggest" id="hcSuggest">${SUGGEST.map((s) => `<button class="chip" type="button">${esc(s)}</button>`).join('')}</div>
        <div class="hc-thread" id="hcThread" aria-live="polite"></div>
      </div>
      <div class="hc-files hidden" id="hcFiles"></div>
      <form class="hc-composer" id="hcForm">
        <label class="btn ghost hc-attach" title="Attach PDF, CSV, text or image files (up to 5, 10 MB each)">${CLIP}<span class="sr">Attach files</span>
          <input type="file" id="hcFile" accept="${ACCEPT}" multiple class="hidden" />
        </label>
        <textarea id="hcQ" rows="1" placeholder="Ask a question…" aria-label="Your question"></textarea>
        <button class="btn primary" id="hcSend">Ask</button>
      </form>
      <p class="hc-foot">Google Gemini with your records, attached files and Google Search. Can be wrong; not a diagnosis.</p>
      <div class="hc-drop hidden" id="hcDrop">Drop files to attach</div>
    </section>`;
  document.body.appendChild(root);

  const $ = (id) => root.querySelector(`#${id}`);
  const fab = root.querySelector('.hc-fab');
  const panel = $('hcPanel');
  const thread = $('hcThread');
  const body = $('hcBody');
  const q = $('hcQ');

  function render() {
    thread.innerHTML = history.map((h) => (h.role === 'user'
      ? `<div class="hc-msg user">${esc(h.text)}${h.files?.length ? `<div class="hc-att">📎 ${h.files.map(esc).join(', ')}</div>` : ''}</div>`
      : `<div class="hc-msg model ${h.error ? 'error' : ''}"><div class="who">AI</div>${h.error ? esc(h.text) : md(h.text)}${sourcesHtml(h)}</div>`)).join('');
    $('hcSuggest').classList.toggle('hidden', history.length > 0);
    $('hcClear').classList.toggle('hidden', !history.length && !files.length);
    try { sessionStorage.setItem(KEY, JSON.stringify(history)); } catch { /* private mode */ }
  }

  function renderFiles(note) {
    const el = $('hcFiles');
    el.innerHTML = files.map((f, i) => `<span class="hc-file" title="${esc(f.name)}">📎 ${esc(f.name)} <span class="muted">${size(f.size)}</span><button type="button" data-rm="${i}" aria-label="Remove ${esc(f.name)}">✕</button></span>`).join('')
      + (note ? `<span class="hc-note warn">${esc(note)}</span>` : '')
      + (files.length ? '<span class="hc-note muted">Sent with every question in this chat.</span>' : '');
    el.classList.toggle('hidden', !files.length && !note);
    $('hcClear').classList.toggle('hidden', !history.length && !files.length);
  }

  function addFiles(list) {
    const okExt = new RegExp(`(${ACCEPT.split(',').map((e) => `\\${e}`).join('|')})$`, 'i');
    const skipped = [];
    for (const f of list) {
      if (!okExt.test(f.name)) skipped.push(`${f.name}: not a PDF, CSV, text or image file`);
      else if (f.size > MAX_FILE) skipped.push(`${f.name}: larger than 10 MB`);
      else if (files.length >= MAX_FILES) skipped.push(`${f.name}: up to ${MAX_FILES} files`);
      else if (!files.some((x) => x.name === f.name && x.size === f.size)) files.push(f);
    }
    renderFiles(skipped.join(' · '));
  }

  function scrollDown() { body.scrollTop = body.scrollHeight; }

  async function ask(question) {
    if (busy) return;
    busy = true;
    const prior = history.filter((h) => !h.error).map(({ role, text }) => ({ role, text }));
    history.push({ role: 'user', text: question, files: files.map((f) => f.name) });
    render();
    thread.insertAdjacentHTML('beforeend', `<div class="hc-msg model typing"><div class="who">AI</div>${files.length ? 'Reading your reports and files…' : 'Reading your reports…'}</div>`);
    scrollDown();
    $('hcSend').disabled = true;
    try {
      const form = new FormData();
      form.append('question', question);
      form.append('history', JSON.stringify(prior));
      for (const f of files) form.append('files', f, f.name);
      const res = await fetch(url('/ask'), { method: 'POST', body: form, credentials: 'same-origin' });
      const d = await res.json().catch(() => ({}));
      if (res.status === 401 && d.needLogin) { location.href = `/health.html?next=${encodeURIComponent(location.pathname)}`; return; }
      if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`);
      history.push({ role: 'model', text: d.answer, sources: d.sources, searches: d.searches });
    } catch (e) {
      history.push({ role: 'model', text: e.message, error: true });
    } finally {
      busy = false;
      $('hcSend').disabled = false;
    }
    render();
    const last = thread.lastElementChild;
    if (last) body.scrollTop = last.offsetTop - 8;
  }

  async function loadContext() {
    if (loaded) return;
    loaded = true;
    const ctx = $('hcCtx');
    try {
      const d = await api('/records');
      const labs = d.reports.filter((r) => r.type === 'lab').length;
      ctx.textContent = d.reports.length
        ? `${labs} lab + ${d.reports.length - labs} other reports, symptoms, medicines${d.aiSearch ? ', Google Search' : ''}`
        : 'No reports yet — you can still attach files';
      ctx.title = 'See exactly what is sent: /api/health/records?ai=1';
      if (!d.aiConfigured) {
        ctx.textContent = 'AI is not set up: add GEMINI_API_KEY and restart the server';
        $('hcSend').disabled = true;
      }
    } catch (e) {
      ctx.textContent = e.message;
    }
  }

  function open() {
    panel.classList.remove('hidden');
    fab.setAttribute('aria-expanded', 'true');
    root.classList.add('open');
    loadContext();
    render();
    scrollDown();
    q.focus();
  }
  function close() {
    panel.classList.add('hidden');
    fab.setAttribute('aria-expanded', 'false');
    root.classList.remove('open');
    fab.focus();
  }

  fab.addEventListener('click', () => (panel.classList.contains('hidden') ? open() : close()));
  $('hcClose').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.classList.contains('hidden')) close(); });
  // Any link or button marked data-open-chat opens the panel instead of navigating.
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-open-chat]');
    if (t) { e.preventDefault(); open(); }
  });

  $('hcForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = q.value.trim();
    if (!text || busy) return;
    q.value = '';
    q.style.height = '';
    ask(text);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('hcForm').requestSubmit(); }
  });
  q.addEventListener('input', () => { q.style.height = ''; q.style.height = `${Math.min(q.scrollHeight, 140)}px`; });
  $('hcSuggest').addEventListener('click', (e) => { if (e.target.classList.contains('chip')) ask(e.target.textContent); });
  $('hcClear').addEventListener('click', () => { history = []; files = []; renderFiles(); render(); q.focus(); });
  $('hcFile').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; q.focus(); });
  $('hcFiles').addEventListener('click', (e) => {
    const i = e.target.getAttribute('data-rm');
    if (i !== null) { files.splice(Number(i), 1); renderFiles(); }
  });

  // Drag and drop onto the panel.
  let depth = 0;
  panel.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); depth++; $('hcDrop').classList.remove('hidden'); } });
  panel.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  panel.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('hcDrop').classList.add('hidden'); } });
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    $('hcDrop').classList.add('hidden');
    addFiles([...(e.dataTransfer?.files || [])]);
  });

  if (location.hash === '#ask') { window.history.replaceState(null, '', location.pathname + location.search); open(); }
})();
