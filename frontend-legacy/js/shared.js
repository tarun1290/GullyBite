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

/* ─────────── META OAUTH — DUAL STRATEGY (POPUP + REDIRECT) ──────
 *
 * Connect WhatsApp Business uses a dual-strategy auth flow:
 *
 *   PRIMARY  : redirect (full-page navigation to Meta's OAuth dialog)
 *              — guaranteed to work in every browser environment, no popup
 *              blocker risk, no postMessage handoff. This is the SAFE path
 *              and is the default if anything goes wrong.
 *
 *   ENHANCED : popup (window.open + postMessage handoff)
 *              — better UX when the browser supports it (no full-page reload,
 *              user keeps their dashboard tab). Only attempted on desktop
 *              non-Safari browsers because Safari's ITP, mobile webviews, and
 *              in-app browsers all break the popup→opener postMessage path.
 *
 * Decision tree:
 *
 *   gbConnectMetaBusiness()  ── always called from button onclick
 *     │
 *     ├── _gbCanUsePopup()?  ── returns false on mobile, Safari, webviews
 *     │     │
 *     │     YES → _gbTryPopup()
 *     │              │
 *     │              ├── window.open(about:blank) succeeds?
 *     │              │     │
 *     │              │     YES → fetch /auth/meta/start { mode:'popup' }
 *     │              │              → popup.location.href = authUrl
 *     │              │              → wait for postMessage('gb-meta-connect-result')
 *     │              │              → on result: gbHandleMetaConnectResult()
 *     │              │
 *     │              NO  → fall through to redirect
 *     │
 *     NO  → _gbDoRedirect()
 *              → fetch /auth/meta/start { mode:'redirect' }
 *              → window.location.href = authUrl
 *              → callback redirects to /dashboard.html?meta_connect_id=...
 *              → initDash() reads meta_connect_id and calls gbHandleMetaConnectResult()
 *
 * Both paths converge on gbHandleMetaConnectResult({ resultId }), which calls
 * /auth/meta/result to fetch the authoritative outcome and refresh the UI.
 */

/** Detect whether the current browser is suitable for popup auth.
 *  Returns false (→ redirect) for mobile, Safari, and known webviews.
 *  Conservative on purpose: false positives just mean we use the safe path. */
function _gbCanUsePopup() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  var ua = navigator.userAgent || '';
  // Common in-app browsers and webviews — these break window.opener / postMessage.
  if (/FBAN|FBAV|FB_IAB|Instagram|Twitter|Line\/|MicroMessenger|MQQBrowser|WhatsApp|Snapchat|LinkedInApp|Pinterest/i.test(ua)) return false;
  // Any mobile device — popups are unreliable, full-page redirect is the standard pattern.
  if (/Mobile|Android|iPhone|iPad|iPod|Windows Phone|webOS|BlackBerry/i.test(ua)) return false;
  // Safari (any platform) — Intelligent Tracking Prevention disrupts the
  // popup→opener postMessage path across same-origin navigations. Note that
  // Chrome/Firefox/Edge on iOS all report "Safari" in their UA but include
  // their own marker (CriOS, FxiOS, EdgiOS), so we exclude those.
  var isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS|OPR|Opera/i.test(ua);
  if (isSafari) return false;
  return true;
}

var _gbMetaConnectInProgress = false;
var _gbMetaConnectPopup = null;
var _gbMetaConnectPopupPoll = null;

/** Public entry point. Call from any "Connect WhatsApp Business" button. */
async function gbConnectMetaBusiness(opts) {
  if (_gbMetaConnectInProgress) return;
  _gbMetaConnectInProgress = true;
  opts = opts || {};
  var preferPopup = opts.preferPopup !== false && _gbCanUsePopup();

  if (preferPopup) {
    var popupHandled = await _gbTryPopup(opts);
    if (popupHandled) return; // popup flow took over (or failed loudly)
    // Otherwise fall through to redirect.
  }
  await _gbDoRedirect(opts);
}

/** Backward-compat alias — forces redirect path. */
function gbConnectMetaRedirect(opts) {
  return gbConnectMetaBusiness(Object.assign({}, opts || {}, { preferPopup: false }));
}

/** Try the popup flow. Returns true if the popup was opened (success or handled
 *  failure), false if the popup was blocked and the caller should try redirect. */
async function _gbTryPopup(opts) {
  // CRITICAL: window.open MUST be called synchronously inside the click handler,
  // before any await. We open about:blank and navigate it later.
  var w = 600, h = 720;
  var screenW = (window.screen && window.screen.width) || 1280;
  var screenH = (window.screen && window.screen.height) || 800;
  var left = Math.max(0, Math.round((screenW - w) / 2));
  var top  = Math.max(0, Math.round((screenH - h) / 2));
  var features = 'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top + ',resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=no';
  var popup;
  try {
    popup = window.open('about:blank', 'gb-meta-connect', features);
  } catch (e) { popup = null; }
  if (!popup || popup.closed || typeof popup.closed === 'undefined') {
    // Blocked by the browser. Caller will fall back to redirect.
    return false;
  }
  _gbMetaConnectPopup = popup;

  // Show a friendly loading screen in the popup while we mint the auth URL.
  // Some browsers reject document.write on about:blank — that's fine, the
  // popup just stays blank for ~200ms until popup.location.href is set.
  try {
    popup.document.open();
    popup.document.write('<!doctype html><html><head><title>Connecting…</title></head><body style="font-family:system-ui;text-align:center;padding:60px 20px;color:#1f2937"><p>Loading Meta authorization…</p></body></html>');
    popup.document.close();
  } catch (e) {}

  try {
    var jwt = (typeof token !== 'undefined' && token) || localStorage.getItem('zm_token') || '';
    var res = await fetch('/auth/meta/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
      body: JSON.stringify({
        mode: 'popup',
        return_to: opts.returnTo || (location.pathname + (location.hash || '')),
      }),
    });
    var data = await res.json().catch(function(){ return {}; });
    if (!res.ok || !data.authUrl) {
      try { popup.close(); } catch (e) {}
      _gbMetaConnectInProgress = false;
      _gbMetaConnectPopup = null;
      var msg = data.error || ('Could not start Meta connection (HTTP ' + res.status + ')');
      if (typeof toast === 'function') toast(msg, 'err'); else alert(msg);
      _gbResetMetaConnectButtons();
      return true; // we surfaced an error — don't fall back to redirect
    }
    popup.location.href = data.authUrl;
    _gbStartPopupCancelPoll(popup);
    return true;
  } catch (e) {
    try { popup.close(); } catch (_) {}
    _gbMetaConnectInProgress = false;
    _gbMetaConnectPopup = null;
    // Network error during /auth/meta/start — try the redirect path so the
    // user still gets a working connection attempt.
    return false;
  }
}

/** Poll for popup-closed-without-result so we can show a "cancelled" toast. */
function _gbStartPopupCancelPoll(popup) {
  if (_gbMetaConnectPopupPoll) clearInterval(_gbMetaConnectPopupPoll);
  _gbMetaConnectPopupPoll = setInterval(function () {
    if (!popup || popup.closed) {
      clearInterval(_gbMetaConnectPopupPoll);
      _gbMetaConnectPopupPoll = null;
      // If a result was already received, _gbMetaConnectInProgress is false.
      // If still true, the user closed the popup without finishing.
      if (_gbMetaConnectInProgress) {
        _gbMetaConnectInProgress = false;
        _gbMetaConnectPopup = null;
        _gbResetMetaConnectButtons();
        if (typeof toast === 'function') toast('Connection cancelled', 'nfo');
      }
    }
  }, 500);
}

/** Redirect path — full-page navigation. Always works. */
async function _gbDoRedirect(opts) {
  opts = opts || {};
  try {
    var jwt = (typeof token !== 'undefined' && token) || localStorage.getItem('zm_token') || '';
    var res = await fetch('/auth/meta/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
      body: JSON.stringify({
        mode: 'redirect',
        return_to: opts.returnTo || (location.pathname + (location.hash || '')),
      }),
    });
    var data = await res.json().catch(function(){ return {}; });
    if (!res.ok || !data.authUrl) {
      _gbMetaConnectInProgress = false;
      var msg = data.error || ('Could not start Meta connection (HTTP ' + res.status + ')');
      if (typeof toast === 'function') toast(msg, 'err'); else alert(msg);
      _gbResetMetaConnectButtons();
      return;
    }
    // Full-page navigation. _gbMetaConnectInProgress stays true on purpose
    // because the page is unloading anyway.
    window.location.href = data.authUrl;
  } catch (e) {
    _gbMetaConnectInProgress = false;
    var emsg = (e && e.message) || 'Network error starting Meta connection';
    if (typeof toast === 'function') toast(emsg, 'err'); else alert(emsg);
    _gbResetMetaConnectButtons();
  }
}

/** Listen for the popup → opener postMessage. Strict origin check. */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('message', function (ev) {
    if (!ev || ev.origin !== window.location.origin) return;
    var d = ev.data;
    if (!d || d.type !== 'gb-meta-connect-result' || !d.resultId) return;
    // Stop the cancel-poll, we have a real result.
    if (_gbMetaConnectPopupPoll) {
      clearInterval(_gbMetaConnectPopupPoll);
      _gbMetaConnectPopupPoll = null;
    }
    _gbMetaConnectInProgress = false;
    _gbMetaConnectPopup = null;
    gbHandleMetaConnectResult(d.resultId).catch(function(){});
  });
}

/** Shared result handler — called by both popup (via postMessage) and redirect
 *  (via dashboard initDash). Fetches the authoritative result and refreshes UI. */
async function gbHandleMetaConnectResult(resultId) {
  if (!resultId) return;
  _gbResetMetaConnectButtons();
  try {
    var result = await api('/auth/meta/result?id=' + encodeURIComponent(resultId));
    if (result && result.ok) {
      if (typeof toast === 'function') toast('WhatsApp connected!', 'ok');
      try {
        rest = await api('/auth/me');
        var banner = document.getElementById('wa-connect-banner');
        if (banner) banner.style.display = 'none';
        if (rest && rest.approval_status !== 'approved') {
          var pb = document.getElementById('pending-banner');
          if (pb) pb.style.display = 'flex';
        }
        if (typeof loadProfile === 'function') loadProfile();
        if (typeof loadWA === 'function') loadWA();
        if (typeof renderWizard === 'function') renderWizard();
      } catch (e) { /* refresh failure is non-fatal */ }
    } else {
      var msg = (result && result.message) || (result && result.error) || 'Meta connection failed — please try again';
      if (typeof toast === 'function') toast(msg, 'err');
    }
  } catch (e) {
    var emsg = (e && e.message) || 'Meta connection failed';
    if (typeof toast === 'function') toast('Meta connection failed: ' + emsg, 'err');
  }
}

/** Reset both Connect buttons (banner + settings card) to their default state.
 *  Lives in shared.js so the popup-cancel + result paths can call it without
 *  depending on settings.js being loaded. */
function _gbResetMetaConnectButtons() {
  // settings.js exposes _resetConnectBtns when loaded; defer to it if present.
  if (typeof _resetConnectBtns === 'function') {
    try { _resetConnectBtns(); return; } catch (e) {}
  }
  // Best-effort fallback for pages that don't load settings.js.
  ['banner-connect-btn', 'wa-reconnect-btn', 'connect-btn'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.disabled = false;
  });
}
