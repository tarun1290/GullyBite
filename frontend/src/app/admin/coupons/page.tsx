'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import SectionError from '../../../components/restaurant/analytics/SectionError';
import {
  getAdminRestaurants,
  getCouponTemplates,
  createCouponTemplate,
} from '../../../api/admin';

interface RestaurantLite { id: string; name: string }

interface RestaurantApiRow {
  id?: string;
  _id?: string;
  restaurant_id?: string;
  business_name?: string;
  name?: string;
}

interface RestaurantsListEnvelope {
  items?: RestaurantApiRow[];
  restaurants?: RestaurantApiRow[];
}

interface TemplateComp { type?: string; text?: string }

interface CouponTemplate {
  id?: string;
  name: string;
  status?: string;
  language?: string;
  components?: TemplateComp[];
}

interface CouponTemplatesResponse { items?: CouponTemplate[] }

interface CreateTemplateResponse { template_id?: string; status?: string }

interface MsgState { type: 'error' | 'success' | 'info'; text: string }

function bodyOf(t: CouponTemplate): string {
  const b = (t?.components || []).find((c) => c.type === 'BODY');
  return b?.text || '';
}

interface StatusBadgeProps { status?: string }

function StatusBadge({ status }: StatusBadgeProps) {
  const cls = status === 'APPROVED'
    ? 'bg-[#d1fae5] text-[#059669]'
    : status === 'PENDING'
      ? 'bg-amber-100 text-amber-500'
      : status === 'REJECTED'
        ? 'bg-red-100 text-red-500'
        : 'bg-ink3 text-dim';
  return (
    <span className={`py-[0.15rem] px-[0.55rem] rounded-[10px] text-[0.7rem] font-semibold ${cls}`}>
      {status || '—'}
    </span>
  );
}

const TABLE_CLS = 'w-full border-collapse text-[0.82rem]';
const TR_HEAD_CLS = 'bg-ink border-b border-rim';
const TH_CLS = 'py-[0.6rem] px-[0.7rem] text-left text-[0.74rem] text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-[0.55rem] px-[0.7rem] align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';
const INPUT_CLS = 'bg-neutral-0 border border-rim rounded-md py-[0.45rem] px-[0.7rem] text-[0.85rem]';
const LBL_CLS = 'text-[0.75rem] text-dim font-semibold block mb-1';
const HINT_CLS = 'text-[0.7rem] text-dim mt-1';
const CODE_CHIP_CLS = 'bg-[#dbeafe] py-[0.05rem] px-[0.3rem] rounded-[3px]';

export default function AdminCouponsPage() {
  const { showToast } = useToast();
  const [restaurants, setRestaurants] = useState<RestaurantLite[]>([]);
  const [restaurantsErr, setRestaurantsErr] = useState<string | null>(null);
  const [restaurantId, setRestaurantId] = useState<string>('');
  const [templates, setTemplates] = useState<CouponTemplate[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const [name, setName] = useState<string>('');
  const [example, setExample] = useState<string>('');
  const [header, setHeader] = useState<string>('');
  const [body, setBody] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [msg, setMsg] = useState<MsgState | null>(null);

  const loadRestaurants = useCallback(async () => {
    try {
      const list = (await getAdminRestaurants()) as RestaurantApiRow[] | RestaurantsListEnvelope | null;
      const items: RestaurantApiRow[] = Array.isArray(list)
        ? list
        : (list?.items || list?.restaurants || []);
      const mapped: RestaurantLite[] = items
        .map((r) => ({ id: (r.id || r._id || r.restaurant_id) || '', name: r.business_name || r.name || r.id || r._id || '' }))
        .filter((r) => r.id)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      setRestaurants(mapped);
      setRestaurantsErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setRestaurantsErr(er?.response?.data?.error || er?.message || 'Failed to load restaurants');
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
      const res = (await getCouponTemplates(restaurantId)) as CouponTemplatesResponse | null;
      setTemplates(res?.items || []);
      setListErr(null);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setTemplates([]);
      setListErr(er?.response?.data?.error || er?.message || 'Failed to load templates');
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
      const r = (await createCouponTemplate({
        restaurant_id: restaurantId,
        name: name.trim(),
        header_text: header.trim() || undefined,
        body_text: body,
        example_code: example.trim(),
      })) as CreateTemplateResponse | null;
      setMsg({ type: 'success', text: `Submitted. Template ID ${r?.template_id} · status ${r?.status}` });
      showToast('Coupon template submitted', 'success');
      resetForm();
      loadTemplates();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setMsg({ type: 'error', text: er?.response?.data?.error || er?.message || 'Submit failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const msgCls = msg
    ? msg.type === 'error' ? 'text-red-500' : msg.type === 'success' ? 'text-[#059669]' : 'text-dim'
    : '';

  return (
    <div id="pg-coupons">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <label className="text-[0.8rem] text-dim">Restaurant:</label>
        <select
          value={restaurantId}
          onChange={(e) => setRestaurantId(e.target.value)}
          className={`${INPUT_CLS} flex-1 max-w-[340px]`}
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
        <div className="mb-4">
          <SectionError message={restaurantsErr} onRetry={loadRestaurants} />
        </div>
      )}

      <div className="bg-[#eff6ff] border border-[#bfdbfe] rounded-lg py-3 px-[0.95rem] mb-4 text-[0.8rem] leading-normal text-[#1e40af]">
        <strong>How coupon templates work:</strong> Meta treats these as <em>marketing</em> templates
        with a <code className={CODE_CHIP_CLS}>copy_code</code> button.{' '}
        <code className={CODE_CHIP_CLS}>{'{{1}}'}</code> is the coupon code,{' '}
        <code className={CODE_CHIP_CLS}>{'{{2}}'}</code> (optional) is the discount amount. Approval by Meta
        usually takes a few minutes.
      </div>

      <div className="card mb-4">
        <div className="ch"><h3>Existing Coupon Templates</h3></div>
        {listErr ? (
          <div className="cb"><SectionError message={listErr} onRetry={loadTemplates} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className={TABLE_CLS}>
              <thead>
                <tr className={TR_HEAD_CLS}>
                  <th className={TH_CLS}>Name</th>
                  <th className={TH_CLS}>Status</th>
                  <th className={TH_CLS}>Language</th>
                  <th className={TH_CLS}>Body Preview</th>
                </tr>
              </thead>
              <tbody>
                {!restaurantId ? (
                  <tr><td colSpan={4} className={EMPTY_CLS}>Select a restaurant to view templates</td></tr>
                ) : loading ? (
                  <tr><td colSpan={4} className={EMPTY_CLS}>Loading…</td></tr>
                ) : templates.length === 0 ? (
                  <tr><td colSpan={4} className={EMPTY_CLS}>No coupon templates yet</td></tr>
                ) : templates.map((t, i) => (
                  <tr key={t.id || t.name || i} className="border-b border-rim">
                    <td className={`${TD_CLS} font-semibold`}>{t.name}</td>
                    <td className={TD_CLS}><StatusBadge status={t.status} /></td>
                    <td className={`${TD_CLS} text-[0.8rem] text-dim`}>{t.language || '—'}</td>
                    <td className={`${TD_CLS} text-[0.8rem] max-w-[420px]`}>
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
        <div className="cb grid grid-cols-2 gap-[0.85rem]">
          <div>
            <label className={LBL_CLS}>Template Name <span className="text-red-500">*</span></label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. festive_coupon_2026"
              className={`${INPUT_CLS} w-full`}
            />
            <div className={HINT_CLS}>Lowercase, numbers, underscores only</div>
          </div>
          <div>
            <label className={LBL_CLS}>Example Coupon Code <span className="text-red-500">*</span></label>
            <input
              value={example}
              onChange={(e) => setExample(e.target.value)}
              placeholder="e.g. SAVE20"
              className={`${INPUT_CLS} w-full`}
            />
            <div className={HINT_CLS}>Shown to Meta as a sample; not the actual code you&apos;ll send</div>
          </div>
          <div className="col-span-2">
            <label className={LBL_CLS}>Header Text (optional)</label>
            <input
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              placeholder="e.g. Your Special Offer!"
              className={`${INPUT_CLS} w-full`}
            />
          </div>
          <div className="col-span-2">
            <label className={LBL_CLS}>Body Text <span className="text-red-500">*</span></label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder="Use code {{1}} to get {{2}} off your next order."
              className={`${INPUT_CLS} w-full font-[inherit] resize-y`}
            />
            <div className={HINT_CLS}>{'{{1}} = coupon code · {{2}} = discount amount (optional)'}</div>
          </div>
          <div className="col-span-2 flex justify-end gap-2">
            <button type="button" className="btn-g btn-sm" onClick={resetForm} disabled={submitting}>Reset</button>
            <button type="button" className="btn-p btn-sm" onClick={submit} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit to Meta'}
            </button>
          </div>
          {msg && (
            <div className={`col-span-2 text-[0.8rem] ${msgCls}`}>
              {msg.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
