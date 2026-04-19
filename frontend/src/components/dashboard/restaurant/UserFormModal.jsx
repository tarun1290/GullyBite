import { useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast.jsx';
import { createUser, updateUser } from '../../../api/restaurant.js';

// Mirrors #user-modal + doSaveUser (restaurant.js:320-342, dashboard.html:1986-2009).
// On EDIT, phone and PIN are intentionally not editable (legacy parity) —
// PIN changes go through the separate Reset-PIN flow.
const ROLES = [
  ['manager', '📋 Manager'],
  ['kitchen', '👨‍🍳 Kitchen'],
  ['delivery', '🚴 Delivery'],
];

function emptyForm() {
  return { name: '', phone: '', pin: '', role: 'manager', branchIds: [] };
}

export default function UserFormModal({ open, onClose, onSaved, editing, branches }) {
  const { showToast } = useToast();
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        name: editing.name || '',
        phone: editing.phone || '',
        pin: '',
        role: editing.role || 'manager',
        branchIds: Array.isArray(editing.branch_ids) ? [...editing.branch_ids] : [],
      });
    } else {
      setForm(emptyForm());
    }
  }, [open, editing]);

  const isEdit = !!editing;

  const toggleBranch = (id) => {
    setForm((f) => ({
      ...f,
      branchIds: f.branchIds.includes(id)
        ? f.branchIds.filter((x) => x !== id)
        : [...f.branchIds, id],
    }));
  };

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) return showToast('Name is required', 'error');
    setSaving(true);
    try {
      if (isEdit) {
        await updateUser(editing.id, { name, role: form.role, branchIds: form.branchIds });
        showToast('User updated', 'success');
      } else {
        const phone = form.phone.trim();
        const pin = form.pin.trim();
        if (!phone || !pin) { setSaving(false); return showToast('Phone and PIN are required', 'error'); }
        await createUser({ name, phone, pin, role: form.role, branchIds: form.branchIds });
        showToast('User created', 'success');
      }
      if (onSaved) onSaved();
      onClose();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 999,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card" style={{ width: 440, maxWidth: '95vw', background: 'var(--surface,#fff)' }}>
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>{isEdit ? 'Edit Team Member' : 'Add Team Member'}</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{ background: 'none', border: 'none', fontSize: '1.3rem', cursor: 'pointer' }}
          >
            ×
          </button>
        </div>
        <div className="cb">
          <div className="fg" style={{ marginBottom: '.7rem' }}>
            <label>Name ★</label>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Rahul Sharma"
            />
          </div>
          <div className="fg" style={{ marginBottom: '.7rem' }}>
            <label>Phone {isEdit ? '' : '★'}</label>
            <input
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              placeholder="+91 98765 43210"
              disabled={isEdit}
              style={isEdit ? { opacity: 0.6 } : undefined}
            />
            {isEdit && (
              <div style={{ fontSize: '.7rem', color: 'var(--dim)', marginTop: '.2rem' }}>
                Phone is locked after creation.
              </div>
            )}
          </div>
          {!isEdit && (
            <div className="fg" style={{ marginBottom: '.7rem' }}>
              <label>PIN (4-6 digits) ★</label>
              <input
                type="password"
                maxLength={6}
                value={form.pin}
                onChange={(e) => setForm((f) => ({ ...f, pin: e.target.value }))}
                placeholder="1234"
              />
            </div>
          )}
          <div className="fg" style={{ marginBottom: '.7rem' }}>
            <label>Role ★</label>
            <select
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
              style={{ padding: '.5rem', border: '1px solid var(--rim)', borderRadius: 'var(--r,6px)', width: '100%' }}
            >
              {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="fg" style={{ marginBottom: '.7rem' }}>
            <label>Branches <small style={{ color: 'var(--dim)' }}>(leave empty for all)</small></label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem', marginTop: '.3rem' }}>
              {(branches || []).map((b) => {
                const on = form.branchIds.includes(b.id);
                return (
                  <label
                    key={b.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '.3rem',
                      fontSize: '.8rem', padding: '.2rem .5rem',
                      border: `1px solid ${on ? 'var(--wa,#22c55e)' : 'var(--rim)'}`,
                      borderRadius: 4, cursor: 'pointer',
                      background: on ? 'rgba(34,197,94,.08)' : 'transparent',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleBranch(b.id)}
                    />
                    {b.name}
                  </label>
                );
              })}
              {!branches?.length && (
                <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>No branches yet.</span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '.5rem', marginTop: '.8rem' }}>
            <button type="button" className="btn-p" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Member')}
            </button>
            <button type="button" className="btn-g" onClick={onClose} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
