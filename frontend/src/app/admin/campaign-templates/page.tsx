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
    <span style={{
      padding: '.15rem .5rem', borderRadius: 999, fontSize: '.7rem',
      fontWeight: 700, letterSpacing: '.03em', textTransform: 'uppercase',
      background: b.bg, color: b.fg, border: `1px solid ${b.border}`,
    }}>{status || 'pending'}</span>
  );
}

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
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: '.75rem', marginBottom: '1rem',
      }}>
        <div>
          <h2 style={{ margin: 0 }}>Campaign Template Library</h2>
          <div style={{ fontSize: '.82rem', color: 'var(--dim)', marginTop: '.2rem' }}>
            Curated catalog of campaign templates available to restaurants.
          </div>
        </div>
        <button className="btn-p" onClick={openCreate}>+ Add Template</button>
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="cb" style={{ display: 'flex', gap: '.75rem', flexWrap: 'wrap' }}>
          <div>
            <label style={{ fontSize: '.75rem', color: 'var(--dim)', display: 'block' }}>Use case</label>
            <select value={filterUseCase} onChange={(e) => setFilterUseCase(e.target.value)}>
              <option value="">All</option>
              {USE_CASES.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: '.75rem', color: 'var(--dim)', display: 'block' }}>Approval</label>
            <select value={filterApproval} onChange={(e) => setFilterApproval(e.target.value)}>
              <option value="">All</option>
              {APPROVAL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: '.75rem', color: 'var(--dim)', display: 'block' }}>Active</label>
            <select value={filterActive} onChange={(e) => setFilterActive(e.target.value)}>
              <option value="">All</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ color: 'var(--dim)', padding: '1rem' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card"><div className="cb" style={{ color: 'var(--dim)' }}>No templates found.</div></div>
      ) : (
        <div style={{ display: 'grid', gap: '.75rem' }}>
          {rows.map((doc) => (
            <div key={doc.template_id} className="card">
              <div className="cb">
                <div style={{
                  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '.6rem',
                  justifyContent: 'space-between', marginBottom: '.5rem',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: '1rem' }}>{doc.display_name || doc.template_id}</strong>
                    <span className="chip" style={{ background: '#eef2ff', color: 'var(--gb-indigo-800)' }}>{doc.use_case}</span>
                    <span className="chip" style={{ background: '#f0fdf4', color: '#166534' }}>{doc.category}</span>
                    <ApprovalBadge status={doc.meta_approval_status} />
                    {!doc.is_active && (
                      <span className="chip" style={{ background: 'var(--gb-red-100)', color: 'var(--gb-red-900)' }}>INACTIVE</span>
                    )}
                  </div>
                  <div style={{ fontSize: '.78rem', color: 'var(--dim)' }}>
                    ₹{Number(doc.per_message_cost_rs || 0).toFixed(2)} / msg
                  </div>
                </div>
                <div style={{
                  fontSize: '.8rem', color: 'var(--gb-slate-700)', background: 'var(--ink3,#f4f4f5)',
                  padding: '.55rem .7rem', borderRadius: 6, whiteSpace: 'pre-wrap',
                  fontFamily: 'ui-monospace,Menlo,monospace',
                }}>
                  {doc.body_template || '(no body)'}
                </div>
                <div style={{ fontSize: '.72rem', color: 'var(--dim)', marginTop: '.4rem' }}>
                  <code>{doc.template_id}</code>
                  {' • '}
                  {doc.language || 'en'}
                  {' • '}
                  {Array.isArray(doc.variables) ? doc.variables.length : 0} variable(s)
                </div>
                {doc.meta_rejection_reason && (
                  <div style={{ fontSize: '.75rem', color: 'var(--gb-red-600)', marginTop: '.3rem' }}>
                    Rejection: {doc.meta_rejection_reason}
                  </div>
                )}
                <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginTop: '.7rem' }}>
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
                    style={{ flex: 1, minWidth: 180, padding: '.35rem .55rem', border: '1px solid var(--rim)', borderRadius: 6 }}
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
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', zIndex: 1000,
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '2rem 1rem',
            overflowY: 'auto',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) closeForm(); }}
        >
          <div className="card" style={{ width: 'min(960px, 100%)', marginBottom: '2rem' }}>
            <div className="ch" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>{editingIsNew ? 'New Campaign Template' : `Edit: ${editingTemplateId}`}</h3>
              <button className="btn-g btn-sm" onClick={closeForm}>Close</button>
            </div>
            <div className="cb" style={{ display: 'grid', gap: '.9rem', gridTemplateColumns: '1fr 1fr' }}>
              <div>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Template ID (Meta name)</label>
                <input
                  type="text"
                  value={form.template_id}
                  onChange={(e) => setF('template_id', e.target.value)}
                  disabled={!editingIsNew}
                  placeholder="e.g. gb_welcome_v1"
                  style={{ width: '100%', padding: '.45rem .6rem', border: '1px solid var(--rim)', borderRadius: 6 }}
                />
                {formErrors.template_id && <div style={{ color: 'var(--gb-red-500)', fontSize: '.72rem' }}>{formErrors.template_id}</div>}
              </div>
              <div>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Display name</label>
                <input
                  type="text"
                  value={form.display_name}
                  onChange={(e) => setF('display_name', e.target.value)}
                  style={{ width: '100%', padding: '.45rem .6rem', border: '1px solid var(--rim)', borderRadius: 6 }}
                />
                {formErrors.display_name && <div style={{ color: 'var(--gb-red-500)', fontSize: '.72rem' }}>{formErrors.display_name}</div>}
              </div>
              <div>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Category</label>
                <select value={form.category} onChange={(e) => setF('category', e.target.value)} style={{ width: '100%' }}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Use case</label>
                <select value={form.use_case} onChange={(e) => setF('use_case', e.target.value)} style={{ width: '100%' }}>
                  {USE_CASES.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Language</label>
                <input
                  type="text"
                  value={form.language}
                  onChange={(e) => setF('language', e.target.value)}
                  placeholder="en"
                  style={{ width: '100%', padding: '.45rem .6rem', border: '1px solid var(--rim)', borderRadius: 6 }}
                />
              </div>
              <div>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Per-message cost (₹)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.per_message_cost_rs}
                  onChange={(e) => setF('per_message_cost_rs', e.target.value)}
                  style={{ width: '100%', padding: '.45rem .6rem', border: '1px solid var(--rim)', borderRadius: 6 }}
                />
              </div>
              <div>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Header type</label>
                <select value={form.header_type} onChange={(e) => setF('header_type', e.target.value)} style={{ width: '100%' }}>
                  {HEADER_TYPES.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Header text (if text)</label>
                <input
                  type="text"
                  value={form.header_text}
                  onChange={(e) => setF('header_text', e.target.value)}
                  style={{ width: '100%', padding: '.45rem .6rem', border: '1px solid var(--rim)', borderRadius: 6 }}
                />
              </div>

              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Body template</label>
                <textarea
                  rows={5}
                  value={form.body_template}
                  onChange={(e) => setF('body_template', e.target.value)}
                  placeholder="Hi {{customer_name}}, your order from {{restaurant_name}} is ready!"
                  style={{
                    width: '100%', padding: '.55rem .7rem', border: '1px solid var(--rim)',
                    borderRadius: 6, fontFamily: 'ui-monospace,Menlo,monospace', fontSize: '.82rem',
                  }}
                />
                {formErrors.body_template && <div style={{ color: 'var(--gb-red-500)', fontSize: '.72rem' }}>{formErrors.body_template}</div>}
              </div>

              <div>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Footer text</label>
                <input
                  type="text"
                  value={form.footer_text}
                  onChange={(e) => setF('footer_text', e.target.value)}
                  style={{ width: '100%', padding: '.45rem .6rem', border: '1px solid var(--rim)', borderRadius: 6 }}
                />
              </div>
              <div>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>CTA button text</label>
                <input
                  type="text"
                  value={form.cta_button_text}
                  onChange={(e) => setF('cta_button_text', e.target.value)}
                  style={{ width: '100%', padding: '.45rem .6rem', border: '1px solid var(--rim)', borderRadius: 6 }}
                />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Preview text (restaurant-facing summary)</label>
                <input
                  type="text"
                  value={form.preview_text}
                  onChange={(e) => setF('preview_text', e.target.value)}
                  style={{ width: '100%', padding: '.45rem .6rem', border: '1px solid var(--rim)', borderRadius: 6 }}
                />
              </div>

              <div style={{ gridColumn: '1 / -1' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  marginBottom: '.35rem',
                }}>
                  <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Variables</label>
                  <button className="btn-g btn-sm" onClick={addVar}>+ Add variable</button>
                </div>
                {form.variables.length === 0 ? (
                  <div style={{ fontSize: '.75rem', color: 'var(--dim)' }}>No variables defined.</div>
                ) : (
                  <div style={{ display: 'grid', gap: '.45rem' }}>
                    {form.variables.map((v, idx) => (
                      <div key={idx} style={{
                        display: 'grid',
                        gridTemplateColumns: '1.2fr 1.2fr 1.2fr .7fr 1.5fr auto',
                        gap: '.4rem', alignItems: 'center',
                      }}>
                        <input
                          type="text" placeholder="name" value={v.name}
                          onChange={(e) => setVar(idx, 'name', e.target.value)}
                          style={{ padding: '.35rem .55rem', border: '1px solid var(--rim)', borderRadius: 6 }}
                        />
                        <input
                          type="text" placeholder="label" value={v.label}
                          onChange={(e) => setVar(idx, 'label', e.target.value)}
                          style={{ padding: '.35rem .55rem', border: '1px solid var(--rim)', borderRadius: 6 }}
                        />
                        <select value={v.source} onChange={(e) => setVar(idx, 'source', e.target.value)}>
                          {VARIABLE_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                        <label style={{ fontSize: '.75rem', display: 'flex', alignItems: 'center', gap: '.3rem' }}>
                          <input type="checkbox" checked={!!v.required}
                            onChange={(e) => setVar(idx, 'required', e.target.checked)} />
                          required
                        </label>
                        <input
                          type="text" placeholder="example" value={v.example || ''}
                          onChange={(e) => setVar(idx, 'example', e.target.value)}
                          style={{ padding: '.35rem .55rem', border: '1px solid var(--rim)', borderRadius: 6 }}
                        />
                        <button className="btn-g btn-sm" onClick={() => removeVar(idx)}>×</button>
                      </div>
                    ))}
                  </div>
                )}
                {formErrors.variables && <div style={{ color: 'var(--gb-red-500)', fontSize: '.72rem' }}>{formErrors.variables}</div>}
              </div>

              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Live preview</label>
                <div style={{
                  padding: '.7rem .85rem', border: '1px solid #bbf7d0', background: '#f0fdf4',
                  borderRadius: 8, whiteSpace: 'pre-wrap', fontSize: '.85rem', color: '#14532d',
                  minHeight: 70,
                }}>{preview || '(empty)'}</div>
              </div>

              <div>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Applicable restaurant types (csv, empty = all)</label>
                <input
                  type="text"
                  value={form.applicable_restaurant_types}
                  onChange={(e) => setF('applicable_restaurant_types', e.target.value)}
                  placeholder="veg, non_veg"
                  style={{ width: '100%', padding: '.45rem .6rem', border: '1px solid var(--rim)', borderRadius: 6 }}
                />
              </div>
              <div>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Active</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem', fontSize: '.85rem' }}>
                  <input
                    type="checkbox"
                    checked={!!form.is_active}
                    onChange={(e) => setF('is_active', e.target.checked)}
                  />
                  Visible to restaurants (when approved)
                </label>
              </div>

              <div>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Approval status</label>
                <select value={form.meta_approval_status} onChange={(e) => setF('meta_approval_status', e.target.value)} style={{ width: '100%' }}>
                  {APPROVAL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: '.78rem', fontWeight: 600 }}>Rejection reason</label>
                <input
                  type="text"
                  value={form.meta_rejection_reason}
                  onChange={(e) => setF('meta_rejection_reason', e.target.value)}
                  style={{ width: '100%', padding: '.45rem .6rem', border: '1px solid var(--rim)', borderRadius: 6 }}
                />
              </div>

              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '.5rem', justifyContent: 'flex-end' }}>
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
