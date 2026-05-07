'use client';

import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../Toast';
import {
  getBranches,
  getBranchItems,
  getCustomerTags,
  createCampaign,
  sendCampaign,
} from '../../../api/restaurant';
import type { Branch } from '../../../types';

const SEGMENTS: ReadonlyArray<readonly [string, string]> = [
  ['all', 'All Customers'],
  ['recent', 'Recent (last 30 days)'],
  ['inactive', 'Inactive (60+ days)'],
  ['tag', 'By Customer Tag (match all)'],
  ['any_tag', 'By Customer Tag (match any)'],
];

interface CampaignFormState {
  name: string;
  branchId: string;
  productIds: string[];
  segment: string;
  tags: string[];
  scheduleAt: string;
  header: string;
  body: string;
}

interface BranchProduct {
  id: string;
  name: string;
  variant_value?: string;
  food_type?: string;
  price_paise?: number;
}

interface CustomerTagsResponse {
  tags?: string[];
}

interface CreateCampaignResult {
  id?: string;
  _id?: string;
}

interface SendCampaignResult {
  sent?: number;
  failed?: number;
}

const EMPTY: CampaignFormState = {
  name: '',
  branchId: '',
  productIds: [],
  segment: 'all',
  tags: [],
  scheduleAt: '',
  header: '',
  body: '',
};

interface CampaignCreateFormProps {
  atCap: boolean;
  onCreated?: (() => void) | undefined;
}

export default function CampaignCreateForm({ atCap, onCreated }: CampaignCreateFormProps) {
  const { showToast } = useToast();
  const [form, setForm] = useState<CampaignFormState>(EMPTY);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchesErr, setBranchesErr] = useState<string | null>(null);
  const [products, setProducts] = useState<BranchProduct[]>([]);
  const [productsLoading, setProductsLoading] = useState<boolean>(false);
  const [productsErr, setProductsErr] = useState<string | null>(null);
  const [tags, setTags] = useState<string[] | null>(null);
  const [tagsLoading, setTagsLoading] = useState<boolean>(false);
  const [tagsErr, setTagsErr] = useState<string | null>(null);
  const [creating, setCreating] = useState<boolean>(false);
  const [sending, setSending] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    getBranches()
      .then((rows) => { if (!cancelled) setBranches(rows || []); })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e as { response?: { data?: { error?: string } }; message?: string };
        setBranchesErr(err?.response?.data?.error || err?.message || 'Failed to load branches');
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!form.branchId) { setProducts([]); return undefined; }
    let cancelled = false;
    setProductsLoading(true);
    setProductsErr(null);
    getBranchItems(form.branchId)
      .then((items) => { if (!cancelled) setProducts((items as BranchProduct[]) || []); })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e as { response?: { data?: { error?: string } }; message?: string };
        setProductsErr(err?.response?.data?.error || err?.message || 'Failed to load products');
      })
      .finally(() => { if (!cancelled) setProductsLoading(false); });
    return () => { cancelled = true; };
  }, [form.branchId]);

  const needsTags = form.segment === 'tag' || form.segment === 'any_tag';
  useEffect(() => {
    if (!needsTags || tags !== null || tagsLoading) return;
    setTagsLoading(true);
    setTagsErr(null);
    getCustomerTags()
      .then((d) => setTags(((d as CustomerTagsResponse | null)?.tags) || []))
      .catch((e: unknown) => {
        const err = e as { response?: { data?: { error?: string } }; message?: string };
        setTagsErr(err?.response?.data?.error || err?.message || 'Failed to load tags');
      })
      .finally(() => setTagsLoading(false));
  }, [needsTags, tags, tagsLoading]);

  const set = <K extends keyof CampaignFormState>(k: K, v: CampaignFormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const toggleProduct = (id: string) => {
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

  const toggleTag = (t: string) => {
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
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Create failed', 'error');
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
      const campaign = (await createCampaign(body)) as CreateCampaignResult;
      showToast('Sending campaign…', 'info');
      const cid = campaign.id || campaign._id || '';
      const result = (await sendCampaign(cid)) as SendCampaignResult;
      showToast(
        `Campaign sent: ${result?.sent ?? 0} delivered, ${result?.failed ?? 0} failed`,
        'success',
      );
      resetAfterSuccess();
      onCreated?.();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Send failed', 'error');
    } finally {
      setSending(false);
    }
  };

  const selectedCount = form.productIds.length;
  const productRows = useMemo(() => products.map((item) => (
    <label
      key={item.id}
      className="flex items-center gap-2 py-[0.3rem] px-[0.4rem] rounded-md cursor-pointer text-[0.82rem]"
    >
      <input
        type="checkbox"
        checked={form.productIds.includes(item.id)}
        onChange={() => toggleProduct(item.id)}
      />
      <span>{item.food_type === 'veg' ? '🟢' : '🔴'}</span>
      <span className="flex-1">
        {item.name}{item.variant_value ? ` — ${item.variant_value}` : ''}
      </span>
      <span className="text-dim">₹{((item.price_paise || 0) / 100).toFixed(0)}</span>
    </label>
  )), [products, form.productIds]);

  return (
    <div className="card mb-[1.2rem]">
      <div className="ch"><h3>New Campaign</h3></div>
      <div className="cb">
        <div className="grid grid-cols-2 gap-4 mb-4">
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
              <div className="text-[#b91c1c] text-[0.72rem] mt-[0.3rem]">
                {branchesErr}
              </div>
            )}
          </div>
        </div>

        <div className="mb-4">
          <label className="lbl">Select Products * (max 30)</label>
          <div className="max-h-[200px] overflow-y-auto border border-rim rounded-lg p-[0.6rem] bg-ink4">
            {!form.branchId ? (
              <span className="text-dim text-[0.82rem]">Select a branch first</span>
            ) : productsErr ? (
              <span className="text-red text-[0.82rem]">{productsErr}</span>
            ) : productsLoading ? (
              <span className="text-dim text-[0.82rem]">Loading products…</span>
            ) : products.length === 0 ? (
              <span className="text-dim text-[0.82rem]">
                No menu items found for this branch
              </span>
            ) : productRows}
          </div>
          <div className="text-[0.72rem] text-dim mt-[0.3rem]">
            {selectedCount}/30 selected
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 mb-4">
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
          <div className="flex items-end gap-2">
            <button
              type="button"
              className="btn flex-1"
              disabled={creating || sending}
              onClick={handleCreate}
            >
              {creating ? '…' : 'Create'}
            </button>
            <button
              type="button"
              className={`btn-g flex-1 ${atCap ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              disabled={creating || sending || atCap}
              title={atCap ? 'Daily limit reached. Resets at midnight.' : ''}
              onClick={handleCreateAndSend}
            >
              {sending ? 'Sending…' : 'Send Now'}
            </button>
          </div>
        </div>

        {needsTags && (
          <div className="mb-4">
            <label className="lbl">Tags</label>
            <div className="border border-rim rounded-lg p-[0.6rem] bg-ink4 flex flex-wrap gap-2">
              {tagsErr ? (
                <span className="text-[#b91c1c] text-[0.82rem]">Failed to load tags: {tagsErr}</span>
              ) : tagsLoading ? (
                <span className="text-dim text-[0.82rem]">Loading tags…</span>
              ) : !tags || tags.length === 0 ? (
                <span className="text-dim text-[0.82rem]">
                  No tags yet — customers are tagged automatically after their first order.
                </span>
              ) : (
                tags.map((t) => (
                  <label
                    key={t}
                    className="inline-flex items-center gap-[0.4rem] py-[0.3rem] px-[0.6rem] border border-rim rounded-full cursor-pointer text-[0.82rem]"
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
            <div className="text-[0.72rem] text-dim mt-[0.3rem]">
              Tags are assigned automatically from order history (e.g. <em>loyal</em>, <em>repeat</em>, <em>dormant</em>, <em>high_value</em>).
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
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
