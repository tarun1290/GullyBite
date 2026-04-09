// frontend/js/shared.js
// Shared utilities for dashboard tab modules
// These functions are used by multiple tabs and remain global during migration.

/* ─────────────────────────── STATE ─────────────────────── */
var token    = localStorage.getItem('zm_token');
var rest     = null;
var branches = [];

/* ─────────────────────────── API ────────────────────────── */
async function api(path, opts = {}) {
  var controller = new AbortController();
  var timeoutMs = opts.timeout || 20000; // 20s default timeout
  var timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  try {
    var res = await fetch(path, {
      ...opts,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...opts.headers },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    clearTimeout(timer);
    if (res.status === 401) { logout(); return null; }
    if (!res.ok) { var e = await res.json().catch(function() { return {}; }); throw new Error(e.error || res.statusText); }
    return res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  }
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

/* ─────────── WHATSAPP CONNECT CTA — single source of truth ──────────── */
// Used by: dashboard banner, wizard checklist, settings card.
// The standalone onboarding page (index.html) defines its own copies because
// it does not load shared.js. Keep the SVG path and labels in sync if changed.
const WA_CONNECT_ICON_14 = '<svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>';
const WA_CONNECT_LABEL_DEFAULT   = 'Connect WhatsApp Business';
const WA_CONNECT_LABEL_RECONNECT = 'Reconnect WhatsApp Business';

// waConnectBtnHTML(reconnect) → inner HTML for any button using .btn-wa-connect
function waConnectBtnHTML(reconnect) {
  return WA_CONNECT_ICON_14 + ' ' + (reconnect ? WA_CONNECT_LABEL_RECONNECT : WA_CONNECT_LABEL_DEFAULT);
}

/* ─────────── META OAUTH START — REDIRECT ONLY ──────────────────
 * Single entry point for "Connect WhatsApp Business". Calls the backend to
 * mint a CSRF state row + auth URL, then full-page navigates to Meta. There
 * is NO popup, NO FB.login, NO postMessage handoff. The Vercel Lambda that
 * receives the callback will fully link the WABA before redirecting back to
 * /dashboard.html?meta_connect_id=...
 *
 * This function is called from:
 *   - dashboard banner (doBannerConnect)
 *   - settings card    (doReconnectMeta / _doMetaConnect)
 *   - onboarding page  (doConnectMeta in index.html)
 *
 * Reentrancy guard prevents a double-click from minting two state rows.
 */
var _gbMetaConnectInProgress = false;
async function gbConnectMetaRedirect(opts) {
  if (_gbMetaConnectInProgress) return;
  _gbMetaConnectInProgress = true;
  var returnTo = (opts && opts.returnTo) || (typeof location !== 'undefined' ? location.pathname + location.hash : null);
  try {
    var res = await fetch('/auth/meta/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || localStorage.getItem('zm_token') || '') },
      body: JSON.stringify({ return_to: returnTo }),
    });
    var data = await res.json().catch(function(){ return {}; });
    if (!res.ok || !data.authUrl) {
      _gbMetaConnectInProgress = false;
      var msg = data.error || ('Could not start Meta connection (HTTP ' + res.status + ')');
      if (typeof toast === 'function') toast(msg, 'err');
      else alert(msg);
      return;
    }
    // Full-page redirect — leaves _gbMetaConnectInProgress=true on purpose,
    // because the navigation aborts any further JS in this page anyway.
    window.location.href = data.authUrl;
  } catch (e) {
    _gbMetaConnectInProgress = false;
    var emsg = (e && e.message) || 'Network error starting Meta connection';
    if (typeof toast === 'function') toast(emsg, 'err');
    else alert(emsg);
  }
}
