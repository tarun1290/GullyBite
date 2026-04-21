import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import Toggle from '../../components/Toggle.jsx';
import {
  getAdminFestivals,
  createFestival,
  updateFestival,
  toggleFestival,
  seedFestivalCalendarAdmin,
} from '../../api/admin.js';

// Admin festival calendar management. Backed by /api/admin/festivals/*.
// Seeds festivals_calendar for the current + next year, lists them
// grouped by year, and lets admins add/edit/toggle individual rows.

const APPLICABLE_OPTIONS = ['all', 'hindu', 'muslim', 'christian', 'sikh'];

function fmtDate(d) {
  if (!d) return '—';
  try {
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return '—';
    return dt.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '—';
  }
}

function toDateInput(d) {
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

const EMPTY_FORM = {
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

export default function AdminFestivals() {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [yearFilter, setYearFilter] = useState('');
  const [modal, setModal] = useState(null); // null | { mode: 'create'|'edit', form }
  const [busy, setBusy] = useState(false);
  const [seedBusy, setSeedBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = yearFilter ? { year: yearFilter } : {};
      const data = await getAdminFestivals(params);
      setRows(Array.isArray(data?.festivals) ? data.festivals : []);
    } catch (err) {
      showToast(err?.response?.data?.error || err?.message || 'Failed to load festivals', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [yearFilter]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      const y = r.year;
      if (!map.has(y)) map.set(y, []);
      map.get(y).push(r);
    }
    return Array.from(map.entries()).sort((a, b) => b[0] - a[0]);
  }, [rows]);

  const handleToggle = async (slug) => {
    try {
      await toggleFestival(slug);
      await load();
    } catch (err) {
      showToast(err?.response?.data?.error || 'Toggle failed', 'error');
    }
  };

  const handleSeed = async () => {
    if (seedBusy) return;
    setSeedBusy(true);
    try {
      const result = await seedFestivalCalendarAdmin();
      showToast(`Seeded ${result?.inserted || 0} festivals (${result?.skipped || 0} already present)`, 'success');
      await load();
    } catch (err) {
      showToast(err?.response?.data?.error || 'Seed failed', 'error');
    } finally {
      setSeedBusy(false);
    }
  };

  const openCreate = () => setModal({ mode: 'create', form: { ...EMPTY_FORM } });

  const openEdit = (row) => setModal({
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
      const body = {
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
        // PUT — slug-keyed. Slug itself isn't editable here.
        await updateFestival(form.slug, body);
        showToast('Festival updated', 'success');
      }
      closeModal();
      await load();
    } catch (err) {
      showToast(err?.response?.data?.error || err?.message || 'Save failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const updateForm = (patch) => setModal((m) => (m ? { ...m, form: { ...m.form, ...patch } } : m));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', gap: '.5rem', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0 }}>Festival Calendar</h2>
          <div style={{ fontSize: '.84rem', color: 'var(--dim)', marginTop: '.2rem' }}>
            Platform-wide Indian occasions. Restaurants are nudged 48h before each festival to send a campaign.
          </div>
        </div>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <select
            value={yearFilter}
            onChange={(e) => setYearFilter(e.target.value)}
            style={{ padding: '.4rem .6rem', border: '1px solid #e5e7eb', borderRadius: 6 }}
          >
            <option value="">All years</option>
            {Array.from(new Set(rows.map((r) => r.year))).sort((a, b) => b - a).map((y) => (
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
        <div style={{ color: 'var(--dim)', padding: '1rem' }}>Loading festivals…</div>
      ) : rows.length === 0 ? (
        <div className="card">
          <div className="cb" style={{ color: 'var(--dim)' }}>
            No festivals yet. Click <strong>Seed Current + Next Year</strong> to bootstrap the calendar.
          </div>
        </div>
      ) : (
        grouped.map(([year, list]) => (
          <div key={year} className="card" style={{ marginBottom: '1rem' }}>
            <div className="ch" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>{year}</strong>
              <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>{list.length} festivals</span>
            </div>
            <div className="cb" style={{ padding: 0, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.85rem' }}>
                <thead style={{ background: 'var(--panel, #f9fafb)' }}>
                  <tr>
                    <th style={thStyle}>Festival</th>
                    <th style={thStyle}>Date</th>
                    <th style={thStyle}>Notify</th>
                    <th style={thStyle}>Applicable</th>
                    <th style={{ ...thStyle, textAlign: 'center' }}>Active</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.slug} style={{ borderTop: '1px solid #e5e7eb' }}>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 500 }}>{r.name}</div>
                        <div style={{ fontSize: '.72rem', color: 'var(--dim)' }}>{r.slug}</div>
                      </td>
                      <td style={tdStyle}>{fmtDate(r.date)}</td>
                      <td style={tdStyle}>{fmtDate(r.notification_date)}</td>
                      <td style={tdStyle}>{r.applicable_to}</td>
                      <td style={{ ...tdStyle, textAlign: 'center' }}>
                        <Toggle checked={r.is_active !== false} onChange={() => handleToggle(r.slug)} />
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
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
          <div style={{ display: 'grid', gap: '.6rem' }}>
            <FormRow label="Name">
              <input
                type="text"
                value={modal.form.name}
                onChange={(e) => updateForm({ name: e.target.value })}
                style={inputStyle}
              />
            </FormRow>
            <FormRow label="Slug">
              <input
                type="text"
                value={modal.form.slug}
                onChange={(e) => updateForm({ slug: e.target.value })}
                disabled={modal.mode === 'edit'}
                placeholder="e.g. diwali_2026"
                style={{ ...inputStyle, opacity: modal.mode === 'edit' ? 0.6 : 1 }}
              />
            </FormRow>
            <FormRow label="Date">
              <input
                type="date"
                value={modal.form.date}
                onChange={(e) => updateForm({ date: e.target.value })}
                style={inputStyle}
              />
            </FormRow>
            <FormRow label="Notification date">
              <input
                type="date"
                value={modal.form.notification_date}
                onChange={(e) => updateForm({ notification_date: e.target.value })}
                placeholder="Auto = date − 48h"
                style={inputStyle}
              />
            </FormRow>
            <FormRow label="Year">
              <input
                type="number"
                value={modal.form.year}
                onChange={(e) => updateForm({ year: e.target.value })}
                style={inputStyle}
              />
            </FormRow>
            <FormRow label="Applicable to">
              <select
                value={modal.form.applicable_to}
                onChange={(e) => updateForm({ applicable_to: e.target.value })}
                style={inputStyle}
              >
                {APPLICABLE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </FormRow>
            <FormRow label="Template use case">
              <input
                type="text"
                value={modal.form.default_template_use_case}
                onChange={(e) => updateForm({ default_template_use_case: e.target.value })}
                style={inputStyle}
              />
            </FormRow>
            <FormRow label="Suggested hint">
              <textarea
                rows={2}
                value={modal.form.suggested_message_hint}
                onChange={(e) => updateForm({ suggested_message_hint: e.target.value })}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </FormRow>
            <FormRow label="Active">
              <Toggle
                checked={!!modal.form.is_active}
                onChange={(v) => updateForm({ is_active: v })}
              />
            </FormRow>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '.4rem', marginTop: '1rem' }}>
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

const thStyle = { padding: '.55rem .7rem', textAlign: 'left', fontWeight: 600, fontSize: '.78rem', color: '#374151' };
const tdStyle = { padding: '.55rem .7rem', verticalAlign: 'middle' };
const inputStyle = { padding: '.4rem .55rem', border: '1px solid #e5e7eb', borderRadius: 6, width: '100%' };

function FormRow({ label, children }) {
  return (
    <label style={{ display: 'grid', gridTemplateColumns: '140px 1fr', alignItems: 'center', gap: '.6rem' }}>
      <span style={{ fontSize: '.82rem', color: 'var(--dim)' }}>{label}</span>
      <div>{children}</div>
    </label>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100, padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 'var(--r, 8px)',
          width: '100%', maxWidth: 520, maxHeight: '90vh', overflow: 'auto',
          padding: '1.25rem',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: '1.1rem', cursor: 'pointer' }}
            aria-label="Close"
          >×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
