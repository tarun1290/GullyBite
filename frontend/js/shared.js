// frontend/js/shared.js
// Shared utilities for dashboard tab modules
// These functions are used by multiple tabs and remain global during migration.

/* ─────────────────────────── STATE ─────────────────────── */
var token    = localStorage.getItem('zm_token');
var rest     = null;
var branches = [];

/* ─────────────────────────── API ────────────────────────── */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { logout(); return null; }
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.statusText); }
  return res.json();
}

/* ─────────────────────────── AUTH ──────────────────────── */
function logout() {
  localStorage.removeItem('zm_token');
  token = null;
  rest  = null;
  window.location.href = '/';
}

/* ─────────────────────────── TOAST ─────────────────────── */
var _tt;
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${{ ok: '\u2713', err: '\u2717', nfo: '\u2139' }[type] || '\u2022'}</span><span>${msg}</span>`;
  el.className = 'on ' + type;
  clearTimeout(_tt);
  _tt = setTimeout(() => el.classList.remove('on'), 3800);
}

/* ─────────────────────────── UTILITIES ───────────────────── */
function fmtINR(n) {
  if (n == null) return '\u20B90.00';
  const val = parseFloat(n);
  return '\u20B9' + val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function timeAgo(ts) {
  const m = Math.round((Date.now() - new Date(ts)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  if (m < 1440) return Math.round(m / 60) + 'h ago';
  return Math.round(m / 1440) + 'd ago';
}

function _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
