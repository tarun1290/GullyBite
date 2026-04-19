import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../Toast.jsx';
import {
  getBranches,
  getBranchItems,
  getCustomerTags,
  createCampaign,
  sendCampaign,
} from '../../../api/restaurant.js';

// Mirrors the inline create-campaign form from legacy dashboard.html:1826-1889
// plus createCampaign / createAndSendCampaign in restaurant.js:758-779. Max
// 30 products, tag picker lazy-loaded on segment change, schedule optional.
const SEGMENTS = [
  ['all', 'All Customers'],
  ['recent', 'Recent (last 30 days)'],
  ['inactive', 'Inactive (60+ days)'],
  ['tag', 'By Customer Tag (match all)'],
  ['any_tag', 'By Customer Tag (match any)'],
];

const EMPTY = {
  name: '',
  branchId: '',
  productIds: [],
  segment: 'all',
  tags: [],
  scheduleAt: '',
  header: '',
  body: '',
};

export default function CampaignCreateForm({ atCap, onCreated }) {
  const { showToast } = useToast();
  const [form, setForm] = useState(EMPTY);
  const [branches, setBranches] = useState([]);
  const [branchesErr, setBranchesErr] = useState(null);
  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsErr, setProductsErr] = useState(null);
  const [tags, setTags] = useState(null);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagsErr, setTagsErr] = useState(null);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getBranches()
      .then((rows) => { if (!cancelled) setBranches(rows || []); })
      .catch((e) => { if (!cancelled) setBranchesErr(e?.response?.data?.error || e.message || 'Failed to load branches'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!form.branchId) { setProducts([]); return undefined; }
    let cancelled = false;
    setProductsLoading(true);
    setProductsErr(null);
    getBranchItems(form.branchId)
      .then((items) => { if (!cancelled) setProducts(items || []); })
      .catch((e) => { if (!cancelled) setProductsErr(e?.response?.data?.error || e.message || 'Failed to load products'); })
      .finally(() => { if (!cancelled) setProductsLoading(false); });
    return () => { cancelled = true; };
  }, [form.branchId]);

  const needsTags = form.segment === 'tag' || form.segment === 'any_tag';
  useEffect(() => {
    if (!needsTags || tags !== null || tagsLoading) return;
    setTagsLoading(true);
    setTagsErr(null);
    getCustomerTags()
      .then((d) => setTags(d?.tags || []))
      .catch((e) => setTagsErr(e?.response?.data?.error || e.message || 'Failed to load tags'))
      .finally(() => setTagsLoading(false));
  }, [needsTags, tags, tagsLoading]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const toggleProduct = (id) => {
    setForm((f) => {
      const has = f.productIds.includes(id);
      if (has) return { ...f, productIds: f.productIds.filter((p) => p !== id) };
      if (f.productIds.length >= 30) {
        showToast('Maximum 30 products per campaign', 'error');
        return f;
      }
      return { ...f, productIds: [...f.productIds, id] };
    });
  };

  const toggleTag = (t) => {
    setForm((f) => {
      const has = f.tags.includes(t);
      return { ...f, tags: has ? f.tags.filter((x) => x !== t) : [...f.tags, t] };
    });
  };

  const buildBody = () => {
    const name = form.name.trim();
    if (!name) { showToast('Enter a campaign name', 'error'); return null; }
    if (!form.branchId) { showToast('Select a branch', 'error'); return null; }
    if (!form.productIds.length) { showToast('Select at least one product', 'error'); return null; }
    if (needsTags && !form.tags.length) { showToast('Select at least one tag', 'error'); return null; }
    return {
      branchId: form.branchId,
      name,
      productIds: form.productIds,
      segment: form.segment,
      scheduleAt: form.scheduleAt || null,
      headerText: form.header.trim() || null,
      bodyText: form.body.trim() || null,
      ...(needsTags ? { tags: form.tags } : {}),
    };
  };

  const resetAfterSuccess = () => {
    setForm(EMPTY);
    setProducts([]);
  };

  const handleCreate = async () => {
    const body = buildBody();
    if (!body) return;
    setCreating(true);
    try {
      await createCampaign(body);
      showToast(body.scheduleAt ? 'Campaign scheduled!' : 'Campaign created (draft)', 'success');
      resetAfterSuccess();
      onCreated?.();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Create failed', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleCreateAndSend = async () => {
    const body = buildBody();
    if (!body) return;
    body.scheduleAt = null;
    setSending(true);
    try {
      const campaign = await createCampaign(body);
      showToast('Sending campaign…', 'info');
      const result = await sendCampaign(campaign.id || campaign._id);
      showToast(
        `Campaign sent: ${result?.sent ?? 0} delivered, ${result?.failed ?? 0} failed`,
        'success',
      );
      resetAfterSuccess();
      onCreated?.();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Send failed', 'error');
    } finally {
      setSending(false);
    }
  };

  const selectedCount = form.productIds.length;
  const productRows = useMemo(() => products.map((item) => (
    <label
      key={item.id}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '.5rem',
        padding: '.3rem .4rem',
        borderRadius: 6,
        cursor: 'pointer',
        fontSize: '.82rem',
      }}
    >
      <input
        type="checkbox"
        checked={form.productIds.includes(item.id)}
        onChange={() => toggleProduct(item.id)}
      />
      <span>{item.food_type === 'veg' ? '🟢' : '🔴'}</span>
      <span style={{ flex: 1 }}>
        {item.name}{item.variant_value ? ` — ${item.variant_value}` : ''}
      </span>
      <span style={{ color: 'var(--dim)' }}>₹{((item.price_paise || 0) / 100).toFixed(0)}</span>
    </label>
  )), [products, form.productIds]);

  return (
    <div className="card" style={{ marginBottom: '1.2rem' }}>
      <div className="ch"><h3>New Campaign</h3></div>
      <div className="cb">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
          <div>
            <label className="lbl">Campaign Name *</label>
            <input
              className="inp"
              placeholder="e.g. Weekend Special Menu"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </div>
          <div>
            <label className="lbl">Branch *</label>
            <select
              className="inp"
              value={form.branchId}
              onChange={(e) => set('branchId', e.target.value)}
            >
              <option value="">Select branch…</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            {branchesErr && (
              <div style={{ color: '#b91c1c', fontSize: '.72rem', marginTop: '.3rem' }}>
                {branchesErr}
              </div>
            )}
          </div>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label className="lbl">Select Products * (max 30)</label>
          <div style={{
            maxHeight: 200,
            overflowY: 'auto',
            border: '1px solid var(--rim)',
            borderRadius: 8,
            padding: '.6rem',
            background: 'var(--ink4)',
          }}
          >
            {!form.branchId ? (
              <span style={{ color: 'var(--dim)', fontSize: '.82rem' }}>Select a branch first</span>
            ) : productsErr ? (
              <span style={{ color: 'var(--red,#b91c1c)', fontSize: '.82rem' }}>{productsErr}</span>
            ) : productsLoading ? (
              <span style={{ color: 'var(--dim)', fontSize: '.82rem' }}>Loading products…</span>
            ) : products.length === 0 ? (
              <span style={{ color: 'var(--dim)', fontSize: '.82rem' }}>
                No menu items found for this branch
              </span>
            ) : productRows}
          </div>
          <div style={{ fontSize: '.72rem', color: 'var(--dim)', marginTop: '.3rem' }}>
            {selectedCount}/30 selected
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
          <div>
            <label className="lbl">Customer Segment</label>
            <select
              className="inp"
              value={form.segment}
              onChange={(e) => set('segment', e.target.value)}
            >
              {SEGMENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="lbl">Schedule (optional)</label>
            <input
              className="inp"
              type="datetime-local"
              value={form.scheduleAt}
              onChange={(e) => set('scheduleAt', e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '.5rem' }}>
            <button
              type="button"
              className="btn"
              style={{ flex: 1 }}
              disabled={creating || sending}
              onClick={handleCreate}
            >
              {creating ? '…' : 'Create'}
            </button>
            <button
              type="button"
              className="btn-g"
              style={{ flex: 1, opacity: atCap ? 0.5 : 1, cursor: atCap ? 'not-allowed' : 'pointer' }}
              disabled={creating || sending || atCap}
              title={atCap ? 'Daily limit reached. Resets at midnight.' : ''}
              onClick={handleCreateAndSend}
            >
              {sending ? 'Sending…' : 'Send Now'}
            </button>
          </div>
        </div>

        {needsTags && (
          <div style={{ marginBottom: '1rem' }}>
            <label className="lbl">Tags</label>
            <div style={{
              border: '1px solid var(--rim)',
              borderRadius: 8,
              padding: '.6rem',
              background: 'var(--ink4)',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '.5rem',
            }}
            >
              {tagsErr ? (
                <span style={{ color: '#b91c1c', fontSize: '.82rem' }}>Failed to load tags: {tagsErr}</span>
              ) : tagsLoading ? (
                <span style={{ color: 'var(--dim)', fontSize: '.82rem' }}>Loading tags…</span>
              ) : !tags || tags.length === 0 ? (
                <span style={{ color: 'var(--dim)', fontSize: '.82rem' }}>
                  No tags yet — customers are tagged automatically after their first order.
                </span>
              ) : (
                tags.map((t) => (
                  <label
                    key={t}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '.4rem',
                      padding: '.3rem .6rem',
                      border: '1px solid var(--rim)',
                      borderRadius: 999,
                      cursor: 'pointer',
                      fontSize: '.82rem',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={form.tags.includes(t)}
                      onChange={() => toggleTag(t)}
                    /> {t}
                  </label>
                ))
              )}
            </div>
            <div style={{ fontSize: '.72rem', color: 'var(--dim)', marginTop: '.3rem' }}>
              Tags are assigned automatically from order history (e.g. <em>loyal</em>, <em>repeat</em>, <em>dormant</em>, <em>high_value</em>).
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div>
            <label className="lbl">Header Text</label>
            <input
              className="inp"
              placeholder="e.g. Weekend Specials 🔥"
              maxLength={60}
              value={form.header}
              onChange={(e) => set('header', e.target.value)}
            />
          </div>
          <div>
            <label className="lbl">Body Text</label>
            <input
              className="inp"
              placeholder="Check out our latest picks!"
              maxLength={1024}
              value={form.body}
              onChange={(e) => set('body', e.target.value)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
