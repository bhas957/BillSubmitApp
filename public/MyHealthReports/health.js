// Shared helpers for the My Health Reports pages.
(function () {
  const THEME_KEY = 'health-theme';

  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY) || ''; } catch { return ''; }
  }
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  applyTheme(storedTheme());

  function effectiveTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
    document.dispatchEvent(new CustomEvent('themechange'));
    updateThemeButtons();
  }

  function updateThemeButtons() {
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      const dark = effectiveTheme() === 'dark';
      b.textContent = dark ? '☀' : '☾';
      b.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
      b.title = b.getAttribute('aria-label');
    });
  }

  // Family profiles: the selected person is sent with every API call.
  const PROFILE_KEY = 'health-profile';
  function profile() {
    try { return localStorage.getItem(PROFILE_KEY) || 'me'; } catch { return 'me'; }
  }
  function setProfile(id) {
    try { localStorage.setItem(PROFILE_KEY, id); } catch { /* private mode */ }
  }
  // "/api/health/x" (or a path under it) with the current profile added.
  function url(path) {
    const full = path.startsWith('/') && !path.startsWith('/api/') ? `/api/health${path}` : path;
    return `${full}${full.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile())}`;
  }

  async function api(path, opts = {}) {
    const res = await fetch(url(path), {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.needLogin) {
      location.href = `/health.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      throw new Error('Login required');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function logout() {
    await fetch('/api/health/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    location.href = '/health.html';
  }

  let toastTimer;
  function toast(msg, ms = 2600) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtDate(iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
    if (!iso) return '';
    return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', opts);
  }

  // Person switcher in the top bar of every page.
  async function mountProfilePicker() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    let profiles;
    try {
      ({ profiles } = await api('/profiles'));
    } catch { return; }
    if (!profiles.some((p) => p.id === profile())) { setProfile('me'); location.reload(); return; }
    const sel = document.createElement('select');
    sel.className = 'profile-pick no-print';
    sel.setAttribute('aria-label', 'Whose records');
    sel.title = 'Whose records you are looking at';
    sel.innerHTML = profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.id === 'me' && p.name === 'Me' ? 'Me' : p.name)}</option>`).join('')
      + '<option value="__manage">Add / manage people…</option>';
    sel.value = profile();
    sel.addEventListener('change', () => {
      if (sel.value === '__manage') { location.href = 'people.html'; return; }
      setProfile(sel.value);
      location.reload();
    });
    bar.insertBefore(sel, bar.querySelector('[data-theme-toggle]'));
    const current = profiles.find((p) => p.id === profile());
    document.dispatchEvent(new CustomEvent('profile', { detail: { profile: current, profiles } }));
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', toggleTheme));
    document.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', logout));
    updateThemeButtons();
    if (!document.body.hasAttribute('data-no-profile')) mountProfilePicker();
  });

  const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  window.Health = { api, url, toast, esc, fmtDate, effectiveTheme, profile, setProfile, today };
})();
