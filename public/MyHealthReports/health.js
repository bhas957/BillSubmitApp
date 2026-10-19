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

  async function api(path, opts = {}) {
    const res = await fetch(`/api/health${path}`, {
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

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', toggleTheme));
    document.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', logout));
    updateThemeButtons();
  });

  window.Health = { api, toast, esc, fmtDate, effectiveTheme };
})();
