'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast';
import {
  getAdminCampaignTemplates,
  createCampaignTemplate,
  updateCampaignTemplate,
  deleteCampaignTemplate,
  activateCampaignTemplate,
  updateCampaignTemplateApproval,
} from '../../../api/admin';

const USE_CASES = [
  'welcome', 'winback_short', 'winback_long', 'birthday',
  'loyalty_expiry', 'milestone', 'manual_blast',
  'festival', 'new_dish', 'general',
] as const;
const CATEGORIES = ['marketing', 'utility'] as const;
const HEADER_TYPES = ['none', 'text', 'image'] as const;
const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'paused'] as const;
const VARIABLE_SOURCES = ['auto', 'restaurant_input', 'customer_data', 'system'] as const;

interface TemplateVariable {
  name: string;
  label: string;
  source: string;
  required: boolean;
  example?: string;
}

interface CampaignTemplate {
  template_id: string;
  display_name?: string;
  category?: string;
  use_case?: string;
  language?: string;
  header_type?: string;
  header_text?: string;
  body_template?: string;
  footer_text?: string;
  cta_button_text?: string;
  preview_text?: string;
  variables?: TemplateVariable[];
  per_message_cost_rs?: number | string;
  is_active?: boolean;
  meta_approval_status?: string;
  meta_rejection_reason?: string;
  applicable_restaurant_types?: string[];
}

interface TemplateFormState {
  template_id: string;
  display_name: string;
  category: string;
  use_case: string;
  language: string;
  header_type: string;
  header_text: string;
  body_template: string;
  footer_text: string;
  cta_button_text: string;
  preview_text: string;
  variables: TemplateVariable[];
  per_message_cost_rs: number | string;
  is_active: boolean;
  meta_approval_status: string;
  meta_rejection_reason: string;
  applicable_restaurant_types: string;
}

type EditingState = (CampaignTemplate & { _new?: boolean }) | { _new: true; template_id?: string } | null;

const emptyVariable = (): TemplateVariable => ({
  name: '', label: '', source: 'restaurant_input', required: false, example: '',
});

const emptyForm = (): TemplateFormState => ({
  template_id: '',
  display_name: '',
  category: 'marketing',
  use_case: 'general',
  language: 'en',
  header_type: 'none',
  header_text: '',
  body_template: '',
  footer_text: '',
  cta_button_text: '',
  preview_text: '',
  variables: [],
  per_message_cost_rs: 0.65,
  is_active: true,
  meta_approval_status: 'pending',
  meta_rejection_reason: '',
  applicable_restaurant_types: '',
});

interface ApprovalBadgeProps { status?: string }

function ApprovalBadge({ status }: ApprovalBadgeProps) {
  const map: Record<string, { bg: string; fg: string; border: string }> = {
    approved: { bg: '#d1fae5', fg: '#065f46', border: '#a7f3d0' },
    pending:  { bg: 'var(--gb-amber-100)', fg: '#92400e', border: '#fde68a' },
    rejected: { bg: 'var(--gb-red-100)', fg: 'var(--gb-red-900)', border: 'var(--gb-red-200)' },
    paused:   { bg: 'var(--gb-neutral-200)', fg: 'var(--gb-neutral-700)', border: 'var(--gb-neutral-300)' },
  };
  const b = map[status || ''] || map.pending!;
  return (
    <span
      className="py-[0.15rem] px-2 rounded-full text-[0.7rem] font-bold tracking-[0.03em] uppercase border"
      // bg / fg / border from the per-status palette by status at runtime
      // (approved/pending/rejected/paused — 4 distinct triplets).
      style={{ background: b.bg, color: b.fg, borderColor: b.border }}
    >{status || 'pending'}</span>
  );
}

const INPUT_CLS = 'w-full py-[0.45rem] px-[0.6rem] border border-rim rounded-md';
const INPUT_SM_CLS = 'py-[0.35rem] px-[0.55rem] border border-rim rounded-md';
const LBL_CLS = 'text-[0.78rem] font-semibold';
const ERR_CLS = 'text-red-500 text-[0.72rem]';

function renderBodyPreview(body: string, variables: TemplateVariable[]): string {
  if (!body) return '';
  return String(body).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const v = (variables || []).find((x) => x.name === name);
    return v?.example || `{{${name}}}`;
  });
}

export default function AdminCampaignTemplatesPage() {
  const { showToast } = useToast();
  const [rows, setRows] = useState<CampaignTemplate[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [filterUseCase, setFilterUseCase] = useState<string>('');
  const [filterApproval, setFilterApproval] = useState<string>('');
  const [filterActive, setFilterActive] = useState<string>('');

  const [editing, setEditing] = useState<EditingState>(null);
  const [form, setForm] = useState<TemplateFormState>(emptyForm());
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<boolean>(false);
  const [rejectReasonByTid, setRejectReasonByTid] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (filterUseCase) params.use_case = filterUseCase;
      if (filterApproval) params.meta_approval_status = filterApproval;
      if (filterActive !== '') params.is_active = filterActive;
      const data = (await getAdminCampaignTemplates(params)) as CampaignTemplate[] | null;
      setRows(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load templates', 'error');
    } finally {
      setLoading(false);
    }
  }, [filterUseCase, filterApproval, filterActive, showToast]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setEditing({ _new: true });
    setForm(emptyForm());
    setFormErrors({});
  };
  const openEdit = (doc: CampaignTemplate) => {
    setEditing(doc);
    setForm({
      template_id: doc.template_id || '',
      display_name: doc.display_name || '',
      category: doc.category || 'marketing',
      use_case: doc.use_case || 'general',
      language: doc.language || 'en',
      header_type: doc.header_type || 'none',
      header_text: doc.header_text || '',
      body_template: doc.body_template || '',
      footer_text: doc.footer_text || '',
      cta_button_text: doc.cta_button_text || '',
      preview_text: doc.preview_text || '',
      variables: Array.isArray(doc.variables) ? doc.variables.map((v) => ({ ...v })) : [],
      per_message_cost_rs: Number(doc.per_message_cost_rs) || 0,
      is_active: doc.is_active !== false,
      meta_approval_status: doc.meta_approval_status || 'pending',
      meta_rejection_reason: doc.meta_rejection_reason || '',
      applicable_restaurant_types: Array.isArray(doc.applicable_restaurant_types)
        ? doc.applicable_restaurant_types.join(',') : '',
    });
    setFormErrors({});
  };
  const closeForm = () => { setEditing(null); setFormErrors({}); };

  const setF = <K extends keyof TemplateFormState>(k: K, v: TemplateFormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const setVar = <K extends keyof TemplateVariable>(idx: number, k: K, v: TemplateVariable[K]) =>
    setForm((f) => {
      const next = f.variables.slice();
      const cur = next[idx];
      if (cur) next[idx] = { ...cur, [k]: v };
      return { ...f, variables: next };
    });
  const addVar = () => setForm((f) => ({ ...f, variables: [...f.variables, emptyVariable()] }));
  const removeVar = (idx: number) => setForm((f) => ({
    ...f, variables: f.variables.filter((_, i) => i !== idx),
  }));

  const submit = async () => {
    const payload: Record<string, unknown> = {
      ...form,
      per_message_cost_rs: Number(form.per_message_cost_rs) || 0,
      applicable_restaurant_types: form.applicable_restaurant_types
        .split(',').map((s) => s.trim()).filter(Boolean),
    };
    if (!payload.header_text) delete payload.header_text;
    if (!payload.footer_text) delete payload.footer_text;
    if (!payload.cta_button_text) delete payload.cta_button_text;
    if (!payload.preview_text) delete payload.preview_text;
    if (!payload.meta_rejection_reason) delete payload.meta_rejection_reason;

    setSaving(true);
    try {
      if (editing && '_new' in editing && editing._new) {
        await createCampaignTemplate(payload);
        showToast('Template created', 'success');
      } else if (editing && 'template_id' in editing && editing.template_id) {
        const { template_id: _omit, ...rest } = payload;
        void _omit;
        await updateCampaignTemplate(editing.template_id, rest);
        showToast('Template updated', 'success');
      }
      closeForm();
      await load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string; fields?: Record<string, string> } }; message?: string };
      const fields = e?.response?.data?.fields;
      if (fields) setFormErrors(fields);
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (doc: CampaignTemplate) => {
    try {
      if (doc.is_active) await deleteCampaignTemplate(doc.template_id);
      else await activateCampaignTemplate(doc.template_id);
      await load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Action failed', 'error');
    }
  };

  const setApproval = async (doc: CampaignTemplate, status: string) => {
    try {
      const body: Record<string, unknown> = { status };
      if (status === 'rejected') {
        const reason = rejectReasonByTid[doc.template_id] || '';
        if (!reason.trim()) { showToast('Enter a rejection reason', 'error'); return; }
        body.rejection_reason = reason.trim();
      }
      await updateCampaignTemplateApproval(doc.template_id, body);
      showToast(`Marked ${status}`, 'success');
      await load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Action failed', 'error');
    }
  };

  const preview = useMemo(() => renderBodyPreview(form.body_template, form.variables), [form.body_template, form.variables]);

  const editingIsNew = editing && '_new' in editing && editing._new;
  const editingTemplateId = editing && 'template_id' in editing ? editing.template_id : '';

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div>
          <h2 className="m-0">Campaign Template Library</h2>
          <div className="text-[0.82rem] text-dim mt-[0.2rem]">
            Curated catalog of campaign templates available to restaurants.
          </div>
        </div>
        <button className="btn-p" onClick={openCreate}>+ Add Template</button>
      </div>

      <div className="card mb-4">
        <div className="cb flex gap-3 flex-wrap">
          <div>
            <label className="text-[0.75rem] text-dim block">Use case</label>
            <select value={filterUseCase} onChange={(e) => setFilterUseCase(e.target.value)}>
              <option value="">All</option>
              {USE_CASES.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[0.75rem] text-dim block">Approval</label>
            <select value={filterApproval} onChange={(e) => setFilterApproval(e.target.value)}>
              <option value="">All</option>
              {APPROVAL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[0.75rem] text-dim block">Active</label>
            <select value={filterActive} onChange={(e) => setFilterActive(e.target.value)}>
              <option value="">All</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-dim p-4">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card"><div className="cb text-dim">No templates found.</div></div>
      ) : (
        <div className="grid gap-3">
          {rows.map((doc) => (
            <div key={doc.template_id} className="card">
              <div className="cb">
                <div className="flex items-center flex-wrap gap-[0.6rem] justify-between mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <strong className="text-base">{doc.display_name || doc.template_id}</strong>
                    <span className="chip bg-[#eef2ff] text-indigo-800">{doc.use_case}</span>
                    <span className="chip bg-[#f0fdf4] text-[#166534]">{doc.category}</span>
                    <ApprovalBadge status={doc.meta_approval_status} />
                    {!doc.is_active && (
                      <span className="chip bg-red-100 text-red-900">INACTIVE</span>
                    )}
                  </div>
                  <div className="text-[0.78rem] text-dim">
                    ₹{Number(doc.per_message_cost_rs || 0).toFixed(2)} / msg
                  </div>
                </div>
                <div className="text-[0.8rem] text-slate-700 bg-ink3 py-[0.55rem] px-[0.7rem] rounded-md whitespace-pre-wrap font-mono">
                  {doc.body_template || '(no body)'}
                </div>
                <div className="text-[0.72rem] text-dim mt-[0.4rem]">
                  <code>{doc.template_id}</code>
                  {' • '}
                  {doc.language || 'en'}
                  {' • '}
                  {Array.isArray(doc.variables) ? doc.variables.length : 0} variable(s)
                </div>
                {doc.meta_rejection_reason && (
                  <div className="text-[0.75rem] text-red-600 mt-[0.3rem]">
                    Rejection: {doc.meta_rejection_reason}
                  </div>
                )}
                <div className="flex gap-2 flex-wrap mt-[0.7rem]">
                  <button className="btn-g btn-sm" onClick={() => openEdit(doc)}>Edit</button>
                  <button className="btn-g btn-sm" onClick={() => toggleActive(doc)}>
                    {doc.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                  {doc.meta_approval_status !== 'approved' && (
                    <button className="btn-g btn-sm" onClick={() => setApproval(doc, 'approved')}>Approve</button>
                  )}
                  {doc.meta_approval_status !== 'paused' && (
                    <button className="btn-g btn-sm" onClick={() => setApproval(doc, 'paused')}>Pause</button>
                  )}
                  <input
                    type="text"
                    placeholder="Rejection reason…"
                    value={rejectReasonByTid[doc.template_id] || ''}
                    onChange={(e) => setRejectReasonByTid((prev) => ({ ...prev, [doc.template_id]: e.target.value }))}
                    className="flex-1 min-w-[180px] py-[0.35rem] px-[0.55rem] border border-rim rounded-md"
                  />
                  <button className="btn-g btn-sm" onClick={() => setApproval(doc, 'rejected')}>Reject</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 bg-[rgba(15,23,42,0.45)] z-1000 flex items-start justify-center py-8 px-4 overflow-y-auto"
          onClick={(e) => { if (e.target === e.currentTarget) closeForm(); }}
        >
          <div className="card w-[min(960px,100%)] mb-8">
            <div className="ch flex justify-between items-center">
              <h3>{editingIsNew ? 'New Campaign Template' : `Edit: ${editingTemplateId}`}</h3>
              <button className="btn-g btn-sm" onClick={closeForm}>Close</button>
            </div>
            <div className="cb grid gap-[0.9rem] grid-cols-2">
              <div>
                <label className={LBL_CLS}>Template ID (Meta name)</label>
                <input
                  type="text"
                  value={form.template_id}
                  onChange={(e) => setF('template_id', e.target.value)}
                  disabled={!editingIsNew}
                  placeholder="e.g. gb_welcome_v1"
                  className={INPUT_CLS}
                />
                {formErrors.template_id && <div className={ERR_CLS}>{formErrors.template_id}</div>}
              </div>
              <div>
                <label className={LBL_CLS}>Display name</label>
                <input
                  type="text"
                  value={form.display_name}
                  onChange={(e) => setF('display_name', e.target.value)}
                  className={INPUT_CLS}
                />
                {formErrors.display_name && <div className={ERR_CLS}>{formErrors.display_name}</div>}
              </div>
              <div>
                <label className={LBL_CLS}>Category</label>
                <select value={form.category} onChange={(e) => setF('category', e.target.value)} className="w-full">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className={LBL_CLS}>Use case</label>
                <select value={form.use_case} onChange={(e) => setF('use_case', e.target.value)} className="w-full">
                  {USE_CASES.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <div>
                <label className={LBL_CLS}>Language</label>
                <input
                  type="text"
                  value={form.language}
                  onChange={(e) => setF('language', e.target.value)}
                  placeholder="en"
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className={LBL_CLS}>Per-message cost (₹)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.per_message_cost_rs}
                  onChange={(e) => setF('per_message_cost_rs', e.target.value)}
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className={LBL_CLS}>Header type</label>
                <select value={form.header_type} onChange={(e) => setF('header_type', e.target.value)} className="w-full">
                  {HEADER_TYPES.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              <div>
                <label className={LBL_CLS}>Header text (if text)</label>
                <input
                  type="text"
                  value={form.header_text}
                  onChange={(e) => setF('header_text', e.target.value)}
                  className={INPUT_CLS}
                />
              </div>

              <div className="col-span-2">
                <label className={LBL_CLS}>Body template</label>
                <textarea
                  rows={5}
                  value={form.body_template}
                  onChange={(e) => setF('body_template', e.target.value)}
                  placeholder="Hi {{customer_name}}, your order from {{restaurant_name}} is ready!"
                  className="w-full py-[0.55rem] px-[0.7rem] border border-rim rounded-md font-mono text-[0.82rem]"
                />
                {formErrors.body_template && <div className={ERR_CLS}>{formErrors.body_template}</div>}
              </div>

              <div>
                <label className={LBL_CLS}>Footer text</label>
                <input
                  type="text"
                  value={form.footer_text}
                  onChange={(e) => setF('footer_text', e.target.value)}
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className={LBL_CLS}>CTA button text</label>
                <input
                  type="text"
                  value={form.cta_button_text}
                  onChange={(e) => setF('cta_button_text', e.target.value)}
                  className={INPUT_CLS}
                />
              </div>
              <div className="col-span-2">
                <label className={LBL_CLS}>Preview text (restaurant-facing summary)</label>
                <input
                  type="text"
                  value={form.preview_text}
                  onChange={(e) => setF('preview_text', e.target.value)}
                  className={INPUT_CLS}
                />
              </div>

              <div className="col-span-2">
                <div className="flex items-center justify-between mb-[0.35rem]">
                  <label className={LBL_CLS}>Variables</label>
                  <button className="btn-g btn-sm" onClick={addVar}>+ Add variable</button>
                </div>
                {form.variables.length === 0 ? (
                  <div className="text-[0.75rem] text-dim">No variables defined.</div>
                ) : (
                  <div className="grid gap-[0.45rem]">
                    {form.variables.map((v, idx) => (
                      <div key={idx} className="grid grid-cols-[1.2fr_1.2fr_1.2fr_0.7fr_1.5fr_auto] gap-[0.4rem] items-center">
                        <input
                          type="text" placeholder="name" value={v.name}
                          onChange={(e) => setVar(idx, 'name', e.target.value)}
                          className={INPUT_SM_CLS}
                        />
                        <input
                          type="text" placeholder="label" value={v.label}
                          onChange={(e) => setVar(idx, 'label', e.target.value)}
                          className={INPUT_SM_CLS}
                        />
                        <select value={v.source} onChange={(e) => setVar(idx, 'source', e.target.value)}>
                          {VARIABLE_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                        <label className="text-[0.75rem] flex items-center gap-[0.3rem]">
                          <input type="checkbox" checked={!!v.required}
                            onChange={(e) => setVar(idx, 'required', e.target.checked)} />
                          required
                        </label>
                        <input
                          type="text" placeholder="example" value={v.example || ''}
                          onChange={(e) => setVar(idx, 'example', e.target.value)}
                          className={INPUT_SM_CLS}
                        />
                        <button className="btn-g btn-sm" onClick={() => removeVar(idx)}>×</button>
                      </div>
                    ))}
                  </div>
                )}
                {formErrors.variables && <div className={ERR_CLS}>{formErrors.variables}</div>}
              </div>

              <div className="col-span-2">
                <label className={LBL_CLS}>Live preview</label>
                <div className="py-[0.7rem] px-[0.85rem] border border-[#bbf7d0] bg-[#f0fdf4] rounded-lg whitespace-pre-wrap text-[0.85rem] text-[#14532d] min-h-[70px]">
                  {preview || '(empty)'}
                </div>
              </div>

              <div>
                <label className={LBL_CLS}>Applicable restaurant types (csv, empty = all)</label>
                <input
                  type="text"
                  value={form.applicable_restaurant_types}
                  onChange={(e) => setF('applicable_restaurant_types', e.target.value)}
                  placeholder="veg, non_veg"
                  className={INPUT_CLS}
                />
              </div>
              <div>
                <label className={LBL_CLS}>Active</label>
                <label className="flex items-center gap-[0.4rem] text-[0.85rem]">
                  <input
                    type="checkbox"
                    checked={!!form.is_active}
                    onChange={(e) => setF('is_active', e.target.checked)}
                  />
                  Visible to restaurants (when approved)
                </label>
              </div>

              <div>
                <label className={LBL_CLS}>Approval status</label>
                <select value={form.meta_approval_status} onChange={(e) => setF('meta_approval_status', e.target.value)} className="w-full">
                  {APPROVAL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className={LBL_CLS}>Rejection reason</label>
                <input
                  type="text"
                  value={form.meta_rejection_reason}
                  onChange={(e) => setF('meta_rejection_reason', e.target.value)}
                  className={INPUT_CLS}
                />
              </div>

              <div className="col-span-2 flex gap-2 justify-end">
                <button className="btn-g" onClick={closeForm} disabled={saving}>Cancel</button>
                <button className="btn-p" onClick={submit} disabled={saving}>
                  {saving ? 'Saving…' : (editingIsNew ? 'Create' : 'Save changes')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
