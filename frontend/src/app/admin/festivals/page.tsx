'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast';
import Toggle from '../../../components/Toggle';
import {
  getAdminFestivals,
  createFestival,
  updateFestival,
  toggleFestival,
  seedFestivalCalendarAdmin,
} from '../../../api/admin';

const APPLICABLE_OPTIONS = ['all', 'hindu', 'muslim', 'christian', 'sikh'];

interface Festival {
  slug: string;
  name: string;
  date?: string;
  notification_date?: string;
  default_template_use_case?: string;
  suggested_message_hint?: string | null;
  applicable_to?: string;
  is_active?: boolean;
  year?: number;
}

interface FestivalsResponse { festivals?: Festival[] }

interface SeedResult { inserted?: number; skipped?: number }

interface FestivalFormState {
  slug: string;
  name: string;
  date: string;
  notification_date: string;
  default_template_use_case: string;
  suggested_message_hint: string;
  applicable_to: string;
  is_active: boolean;
  year: string | number;
}

interface ModalState {
  mode: 'create' | 'edit';
  form: FestivalFormState;
}

function fmtDate(d?: string): string {
  if (!d) return '—';
  try {
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return '—';
    return dt.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '—';
  }
}

function toDateInput(d?: string): string {
  if (!d) return '';
  try {
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return '';
  }
}

const EMPTY_FORM: FestivalFormState = {
  slug: '',
  name: '',
  date: '',
  notification_date: '',
  default_template_use_case: 'festival',
  suggested_message_hint: '',
  applicable_to: 'all',
  is_active: true,
  year: '',
};

const TH_CLS = 'py-[0.55rem] px-[0.7rem] text-left font-semibold text-[0.78rem] text-neutral-700';
const TD_CLS = 'py-[0.55rem] px-[0.7rem] align-middle';
const INPUT_CLS = 'py-[0.4rem] px-[0.55rem] border border-neutral-200 rounded-md w-full';

export default function AdminFestivalsPage() {
  const { showToast } = useToast();
  const [loading, setLoading] = useState<boolean>(true);
  const [rows, setRows] = useState<Festival[]>([]);
  const [yearFilter, setYearFilter] = useState<string>('');
  const [modal, setModal] = useState<ModalState | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [seedBusy, setSeedBusy] = useState<boolean>(false);

  const load = async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = yearFilter ? { year: yearFilter } : {};
      const data = (await getAdminFestivals(params)) as FestivalsResponse | null;
      setRows(Array.isArray(data?.festivals) ? data.festivals : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load festivals', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [yearFilter]);

  const grouped = useMemo<Array<[number, Festival[]]>>(() => {
    const map = new Map<number, Festival[]>();
    for (const r of rows) {
      const y = r.year ?? 0;
      if (!map.has(y)) map.set(y, []);
      map.get(y)!.push(r);
    }
    return Array.from(map.entries()).sort((a, b) => b[0] - a[0]);
  }, [rows]);

  const handleToggle = async (slug: string) => {
    try {
      await toggleFestival(slug);
      await load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      showToast(e?.response?.data?.error || 'Toggle failed', 'error');
    }
  };

  const handleSeed = async () => {
    if (seedBusy) return;
    setSeedBusy(true);
    try {
      const result = (await seedFestivalCalendarAdmin()) as SeedResult | null;
      showToast(`Seeded ${result?.inserted || 0} festivals (${result?.skipped || 0} already present)`, 'success');
      await load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      showToast(e?.response?.data?.error || 'Seed failed', 'error');
    } finally {
      setSeedBusy(false);
    }
  };

  const openCreate = () => setModal({ mode: 'create', form: { ...EMPTY_FORM } });

  const openEdit = (row: Festival) => setModal({
    mode: 'edit',
    form: {
      slug: row.slug,
      name: row.name,
      date: toDateInput(row.date),
      notification_date: toDateInput(row.notification_date),
      default_template_use_case: row.default_template_use_case || 'festival',
      suggested_message_hint: row.suggested_message_hint || '',
      applicable_to: row.applicable_to || 'all',
      is_active: row.is_active !== false,
      year: row.year || '',
    },
  });

  const closeModal = () => setModal(null);

  const saveModal = async () => {
    if (!modal) return;
    const { mode, form } = modal;
    if (!form.name?.trim() || !form.slug?.trim() || !form.date) {
      showToast('Name, slug, and date are required', 'error');
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        slug: form.slug.trim(),
        date: form.date,
        notification_date: form.notification_date || undefined,
        default_template_use_case: form.default_template_use_case || 'festival',
        suggested_message_hint: form.suggested_message_hint?.trim() || null,
        applicable_to: form.applicable_to || 'all',
        is_active: !!form.is_active,
        year: form.year ? Number(form.year) : undefined,
      };
      if (mode === 'create') {
        await createFestival(body);
        showToast('Festival created', 'success');
      } else {
        await updateFestival(form.slug, body);
        showToast('Festival updated', 'success');
      }
      closeModal();
      await load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const updateForm = (patch: Partial<FestivalFormState>) =>
    setModal((m) => (m ? { ...m, form: { ...m.form, ...patch } } : m));

  return (
    <div>
      <div className="flex justify-between items-center mb-4 gap-2 flex-wrap">
        <div>
          <h2 className="m-0">Festival Calendar</h2>
          <div className="text-[0.84rem] text-dim mt-[0.2rem]">
            Platform-wide Indian occasions. Restaurants are nudged 48h before each festival to send a campaign.
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <select
            value={yearFilter}
            onChange={(e) => setYearFilter(e.target.value)}
            className="py-[0.4rem] px-[0.6rem] border border-neutral-200 rounded-md"
          >
            <option value="">All years</option>
            {Array.from(new Set(rows.map((r) => r.year ?? 0))).sort((a, b) => b - a).map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <button className="btn-g btn-sm" onClick={handleSeed} disabled={seedBusy}>
            {seedBusy ? 'Seeding…' : 'Seed Current + Next Year'}
          </button>
          <button className="btn-p btn-sm" onClick={openCreate}>+ Add Festival</button>
        </div>
      </div>

      {loading ? (
        <div className="text-dim p-4">Loading festivals…</div>
      ) : rows.length === 0 ? (
        <div className="card">
          <div className="cb text-dim">
            No festivals yet. Click <strong>Seed Current + Next Year</strong> to bootstrap the calendar.
          </div>
        </div>
      ) : (
        grouped.map(([year, list]) => (
          <div key={year} className="card mb-4">
            <div className="ch flex justify-between">
              <strong>{year}</strong>
              <span className="text-[0.78rem] text-dim">{list.length} festivals</span>
            </div>
            <div className="cb p-0 overflow-x-auto">
              <table className="w-full border-collapse text-[0.85rem]">
                <thead className="bg-panel">
                  <tr>
                    <th className={TH_CLS}>Festival</th>
                    <th className={TH_CLS}>Date</th>
                    <th className={TH_CLS}>Notify</th>
                    <th className={TH_CLS}>Applicable</th>
                    <th className={`${TH_CLS} text-center`}>Active</th>
                    <th className={`${TH_CLS} text-right`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.slug} className="border-t border-neutral-200">
                      <td className={TD_CLS}>
                        <div className="font-medium">{r.name}</div>
                        <div className="text-[0.72rem] text-dim">{r.slug}</div>
                      </td>
                      <td className={TD_CLS}>{fmtDate(r.date)}</td>
                      <td className={TD_CLS}>{fmtDate(r.notification_date)}</td>
                      <td className={TD_CLS}>{r.applicable_to}</td>
                      <td className={`${TD_CLS} text-center`}>
                        <Toggle checked={r.is_active !== false} onChange={() => handleToggle(r.slug)} />
                      </td>
                      <td className={`${TD_CLS} text-right`}>
                        <button className="btn-g btn-sm" onClick={() => openEdit(r)}>Edit</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {modal && (
        <Modal onClose={closeModal} title={modal.mode === 'create' ? 'Add Festival' : 'Edit Festival'}>
          <div className="grid gap-[0.6rem]">
            <FormRow label="Name">
              <input
                type="text"
                value={modal.form.name}
                onChange={(e) => updateForm({ name: e.target.value })}
                className={INPUT_CLS}
              />
            </FormRow>
            <FormRow label="Slug">
              <input
                type="text"
                value={modal.form.slug}
                onChange={(e) => updateForm({ slug: e.target.value })}
                disabled={modal.mode === 'edit'}
                placeholder="e.g. diwali_2026"
                className={`${INPUT_CLS} ${modal.mode === 'edit' ? 'opacity-60' : 'opacity-100'}`}
              />
            </FormRow>
            <FormRow label="Date">
              <input
                type="date"
                value={modal.form.date}
                onChange={(e) => updateForm({ date: e.target.value })}
                className={INPUT_CLS}
              />
            </FormRow>
            <FormRow label="Notification date">
              <input
                type="date"
                value={modal.form.notification_date}
                onChange={(e) => updateForm({ notification_date: e.target.value })}
                placeholder="Auto = date − 48h"
                className={INPUT_CLS}
              />
            </FormRow>
            <FormRow label="Year">
              <input
                type="number"
                value={modal.form.year}
                onChange={(e) => updateForm({ year: e.target.value })}
                className={INPUT_CLS}
              />
            </FormRow>
            <FormRow label="Applicable to">
              <select
                value={modal.form.applicable_to}
                onChange={(e) => updateForm({ applicable_to: e.target.value })}
                className={INPUT_CLS}
              >
                {APPLICABLE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </FormRow>
            <FormRow label="Template use case">
              <input
                type="text"
                value={modal.form.default_template_use_case}
                onChange={(e) => updateForm({ default_template_use_case: e.target.value })}
                className={INPUT_CLS}
              />
            </FormRow>
            <FormRow label="Suggested hint">
              <textarea
                rows={2}
                value={modal.form.suggested_message_hint}
                onChange={(e) => updateForm({ suggested_message_hint: e.target.value })}
                className={`${INPUT_CLS} resize-y`}
              />
            </FormRow>
            <FormRow label="Active">
              <Toggle
                checked={!!modal.form.is_active}
                onChange={(v: boolean) => updateForm({ is_active: v })}
              />
            </FormRow>
          </div>
          <div className="flex justify-end gap-[0.4rem] mt-4">
            <button className="btn-g btn-sm" onClick={closeModal} disabled={busy}>Cancel</button>
            <button className="btn-p btn-sm" onClick={saveModal} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface FormRowProps { label: string; children: ReactNode }

function FormRow({ label, children }: FormRowProps): ReactNode {
  return (
    <label className="grid grid-cols-[140px_1fr] items-center gap-[0.6rem]">
      <span className="text-[0.82rem] text-dim">{label}</span>
      <div>{children}</div>
    </label>
  );
}

interface ModalProps { title: string; onClose: () => void; children: ReactNode }

function Modal({ title, onClose, children }: ModalProps): ReactNode {
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-100 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-neutral-0 rounded-r w-full max-w-[520px] max-h-[90vh] overflow-auto p-5"
      >
        <div className="flex justify-between items-center mb-4">
          <h3 className="m-0">{title}</h3>
          <button
            onClick={onClose}
            className="bg-none border-0 text-[1.1rem] cursor-pointer"
            aria-label="Close"
          >×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
