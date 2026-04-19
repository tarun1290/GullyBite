// frontend/js/tabs/marketing.js
// Restaurant dashboard: WhatsApp marketing message ledger.
// Reads GET /api/restaurant/marketing-messages. Phone is always masked here.

(function () {
  let _state = { page: 1, limit: 20, from: null, to: null };

  function _fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  async function loadMarketingMessages() {
    const tbody = document.getElementById('mkt-msg-body');
    const totalEl = document.getElementById('mkt-msg-total');
    const countEl = document.getElementById('mkt-msg-count');
    if (!tbody) return;

    const params = new URLSearchParams();
    params.set('page', _state.page);
    params.set('limit', _state.limit);
    if (_state.from) params.set('from', _state.from);
    if (_state.to)   params.set('to',   _state.to);

    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:1.2rem;color:var(--dim)">Loading…</td></tr>';

    try {
      const d = await api('/api/restaurant/marketing-messages?' + params.toString());
      if (totalEl) totalEl.textContent = '₹' + (Math.round((d.total_cost || 0) * 100) / 100).toFixed(2);
      if (countEl) countEl.textContent = (d.total || 0) + ' messages';

      if (!d.items?.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:1.2rem;color:var(--dim)">No marketing messages in this range.</td></tr>';
        return;
      }

      tbody.innerHTML = d.items.map(m => (
        '<tr>'
        + '<td style="padding:.5rem .7rem">' + _esc(m.customer_name || '—') + '</td>'
        + '<td style="padding:.5rem .7rem;font-family:monospace;color:var(--dim)">' + _esc(m.phone || '—') + '</td>'
        + '<td style="padding:.5rem .7rem">' + _esc(m.message_type || '—') + '</td>'
        + '<td style="padding:.5rem .7rem">' + _esc(m.category || '—') + '</td>'
        + '<td style="padding:.5rem .7rem">₹' + (Number(m.cost || 0).toFixed(2)) + '</td>'
        + '<td style="padding:.5rem .7rem">' + _esc(m.status || '—') + '</td>'
        + '<td style="padding:.5rem .7rem;color:var(--dim);font-size:.8rem">' + _fmtDate(m.sent_at) + '</td>'
        + '</tr>'
      )).join('');
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:1.2rem;color:#dc2626">Failed to load: ' + _esc(err.message || err) + '</td></tr>';
    }
  }

  function setMarketingRange(fromIso, toIso) {
    _state.from = fromIso || null;
    _state.to = toIso || null;
    _state.page = 1;
    loadMarketingMessages();
  }

  window.loadMarketingMessages = loadMarketingMessages;
  window.setMarketingRange = setMarketingRange;
})();
