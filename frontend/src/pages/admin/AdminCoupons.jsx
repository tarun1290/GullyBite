import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import SectionError from '../../components/dashboard/analytics/SectionError.jsx';
import {
  getAdminRestaurants,
  getCouponTemplates,
  createCouponTemplate,
} from '../../api/admin.js';

// Mirrors admin.html loadCouponsPage/loadCouponTemplates/submitCouponTemplate (5429-5527).
// Restaurant dropdown, info banner, existing templates table, create form.

function bodyOf(t) {
  const b = (t?.components || []).find((c) => c.type === 'BODY');
  return b?.text || '';
}

function StatusBadge({ status }) {
  const color = status === 'APPROVED' ? '#059669'
    : status === 'PENDING' ? '#d97706'
    : status === 'REJECTED' ? '#dc2626'
    : 'var(--dim)';
  const bg = status === 'APPROVED' ? '#d1fae5'
    : status === 'PENDING' ? '#fef3c7'
    : status === 'REJECTED' ? '#fee2e2'
    : 'var(--ink3)';
  return (
    <span style={{
      background: bg, color, padding: '.15rem .55rem',
      borderRadius: 10, fontSize: '.7rem', fontWeight: 600,
    }}>
      {status || '—'}
    </span>
  );
}

export default function AdminCoupons() {
  const { showToast } = useToast();
  const [restaurants, setRestaurants] = useState([]);
  const [restaurantsErr, setRestaurantsErr] = useState(null);
  const [restaurantId, setRestaurantId] = useState('');
  const [templates, setTemplates] = useState([]);
  const [listErr, setListErr] = useState(null);
  const [loading, setLoading] = useState(false);

  const [name, setName] = useState('');
  const [example, setExample] = useState('');
  const [header, setHeader] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState(null);

  const loadRestaurants = useCallback(async () => {
    try {
      const list = await getAdminRestaurants();
      const items = Array.isArray(list) ? list : (list?.items || list?.restaurants || []);
      const mapped = items
        .map((r) => ({ id: r.id || r._id || r.restaurant_id, name: r.business_name || r.name || r.id || r._id }))
        .filter((r) => r.id)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      setRestaurants(mapped);
      setRestaurantsErr(null);
    } catch (e) {
      setRestaurantsErr(e?.response?.data?.error || e?.message || 'Failed to load restaurants');
    }
  }, []);

  const loadTemplates = useCallback(async () => {
    if (!restaurantId) {
      setTemplates([]);
      setListErr(null);
      return;
    }
    setLoading(true);
    try {
      const res = await getCouponTemplates(restaurantId);
      setTemplates(res?.items || []);
      setListErr(null);
    } catch (e) {
      setTemplates([]);
      setListErr(e?.response?.data?.error || e?.message || 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, [restaurantId]);

  useEffect(() => { loadRestaurants(); }, [loadRestaurants]);
  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const resetForm = () => {
    setName('');
    setExample('');
    setHeader('');
    setBody('');
    setMsg(null);
  };

  const submit = async () => {
    setMsg(null);
    if (!restaurantId) { setMsg({ type: 'error', text: 'Select a restaurant first' }); return; }
    if (!name.trim()) { setMsg({ type: 'error', text: 'Name is required' }); return; }
    if (!/^[a-z0-9_]+$/.test(name.trim())) {
      setMsg({ type: 'error', text: 'Name must be lowercase alphanumeric with underscores only' });
      return;
    }
    if (!body) { setMsg({ type: 'error', text: 'Body text is required' }); return; }
    if (!example.trim()) { setMsg({ type: 'error', text: 'Example coupon code is required' }); return; }

    setSubmitting(true);
    setMsg({ type: 'info', text: 'Submitting to Meta…' });
    try {
      const r = await createCouponTemplate({
        restaurant_id: restaurantId,
        name: name.trim(),
        header_text: header.trim() || undefined,
        body_text: body,
        example_code: example.trim(),
      });
      setMsg({ type: 'success', text: `Submitted. Template ID ${r.template_id} · status ${r.status}` });
      showToast('Coupon template submitted', 'success');
      resetForm();
      loadTemplates();
    } catch (e) {
      setMsg({ type: 'error', text: e?.response?.data?.error || e?.message || 'Submit failed' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div id="pg-coupons">
      <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <label style={{ fontSize: '.8rem', color: 'var(--dim)' }}>Restaurant:</label>
        <select
          value={restaurantId}
          onChange={(e) => setRestaurantId(e.target.value)}
          style={{ ...input, flex: 1, maxWidth: 340 }}
        >
          <option value="">— Select restaurant —</option>
          {restaurants.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <button type="button" className="btn-g btn-sm" onClick={loadTemplates} disabled={!restaurantId || loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {restaurantsErr && (
        <div style={{ marginBottom: '1rem' }}>
          <SectionError message={restaurantsErr} onRetry={loadRestaurants} />
        </div>
      )}

      <div style={{
        background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8,
        padding: '.75rem .95rem', marginBottom: '1rem', fontSize: '.8rem',
        lineHeight: 1.5, color: '#1e40af',
      }}>
        <strong>How coupon templates work:</strong> Meta treats these as <em>marketing</em> templates
        with a <code style={codeChip}>copy_code</code> button.{' '}
        <code style={codeChip}>{'{{1}}'}</code> is the coupon code,{' '}
        <code style={codeChip}>{'{{2}}'}</code> (optional) is the discount amount. Approval by Meta
        usually takes a few minutes.
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="ch"><h3>Existing Coupon Templates</h3></div>
        {listErr ? (
          <div className="cb"><SectionError message={listErr} onRetry={loadTemplates} /></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr style={trHead}>
                  <th style={th}>Name</th>
                  <th style={th}>Status</th>
                  <th style={th}>Language</th>
                  <th style={th}>Body Preview</th>
                </tr>
              </thead>
              <tbody>
                {!restaurantId ? (
                  <tr><td colSpan={4} style={emptyCell}>Select a restaurant to view templates</td></tr>
                ) : loading ? (
                  <tr><td colSpan={4} style={emptyCell}>Loading…</td></tr>
                ) : templates.length === 0 ? (
                  <tr><td colSpan={4} style={emptyCell}>No coupon templates yet</td></tr>
                ) : templates.map((t, i) => (
                  <tr key={t.id || t.name || i} style={{ borderBottom: '1px solid var(--rim)' }}>
                    <td style={{ ...td, fontWeight: 600 }}>{t.name}</td>
                    <td style={td}><StatusBadge status={t.status} /></td>
                    <td style={{ ...td, fontSize: '.8rem', color: 'var(--dim)' }}>{t.language || '—'}</td>
                    <td style={{ ...td, fontSize: '.8rem', maxWidth: 420 }}>
                      {bodyOf(t).slice(0, 140)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="ch"><h3>Create New Coupon Template</h3></div>
        <div className="cb" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.85rem' }}>
          <div>
            <label style={lbl}>Template Name <span style={{ color: '#dc2626' }}>*</span></label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. festive_coupon_2026"
              style={{ ...input, width: '100%' }}
            />
            <div style={hint}>Lowercase, numbers, underscores only</div>
          </div>
          <div>
            <label style={lbl}>Example Coupon Code <span style={{ color: '#dc2626' }}>*</span></label>
            <input
              value={example}
              onChange={(e) => setExample(e.target.value)}
              placeholder="e.g. SAVE20"
              style={{ ...input, width: '100%' }}
            />
            <div style={hint}>Shown to Meta as a sample; not the actual code you'll send</div>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={lbl}>Header Text (optional)</label>
            <input
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              placeholder="e.g. Your Special Offer!"
              style={{ ...input, width: '100%' }}
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={lbl}>Body Text <span style={{ color: '#dc2626' }}>*</span></label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder="Use code {{1}} to get {{2}} off your next order."
              style={{ ...input, width: '100%', fontFamily: 'inherit', resize: 'vertical' }}
            />
            <div style={hint}>{'{{1}} = coupon code · {{2}} = discount amount (optional)'}</div>
          </div>
          <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: '.5rem' }}>
            <button type="button" className="btn-g btn-sm" onClick={resetForm} disabled={submitting}>Reset</button>
            <button type="button" className="btn-p btn-sm" onClick={submit} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit to Meta'}
            </button>
          </div>
          {msg && (
            <div style={{
              gridColumn: '1 / -1', fontSize: '.8rem',
              color: msg.type === 'error' ? '#dc2626' : msg.type === 'success' ? '#059669' : 'var(--dim)',
            }}>
              {msg.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' };
const trHead = { background: 'var(--ink)', borderBottom: '1px solid var(--rim)' };
const th = { padding: '.6rem .7rem', textAlign: 'left', fontSize: '.74rem', color: 'var(--dim)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' };
const td = { padding: '.55rem .7rem', verticalAlign: 'top' };
const emptyCell = { padding: '1.5rem', textAlign: 'center', color: 'var(--dim)' };
const input = { background: '#fff', border: '1px solid var(--rim)', borderRadius: 6, padding: '.45rem .7rem', fontSize: '.85rem' };
const lbl = { fontSize: '.75rem', color: 'var(--dim)', fontWeight: 600, display: 'block', marginBottom: '.25rem' };
const hint = { fontSize: '.7rem', color: 'var(--dim)', marginTop: '.25rem' };
const codeChip = { background: '#dbeafe', padding: '.05rem .3rem', borderRadius: 3 };
