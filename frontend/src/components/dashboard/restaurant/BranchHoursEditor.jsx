import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast.jsx';
import Toggle from '../../../components/Toggle.jsx';
import { getBranchHours, updateBranchHours } from '../../../api/restaurant.js';

// Mirrors #hours-editor-{branchId} in restaurant.js:820-1024.
// Day grid + "Same hours every day" toggle + 3 presets + Save.
// Closed-day handling: is_closed=true. Time fields are still sent
// even when closed — backend ignores them.
const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const PRESETS = {
  standard: { open: '10:00', close: '22:00', closedDays: [] },
  weekdays: { open: '10:00', close: '22:00', closedDays: ['saturday', 'sunday'] },
  late: { open: '18:00', close: '02:00', closedDays: [] },
};

function emptyHours() {
  const h = {};
  DAY_NAMES.forEach((d) => {
    h[d] = { open: '10:00', close: '22:00', is_closed: false };
  });
  return h;
}

export default function BranchHoursEditor({ branchId, onSaved }) {
  const { showToast } = useToast();
  const [hours, setHours] = useState(emptyHours());
  const [sameHours, setSameHours] = useState(false);
  const [uniOpen, setUniOpen] = useState('10:00');
  const [uniClose, setUniClose] = useState('22:00');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  const load = async () => {
    setLoading(true);
    setStatus('Loading…');
    try {
      const res = await getBranchHours(branchId);
      const h = res?.hours && typeof res.hours === 'object' ? { ...emptyHours(), ...res.hours } : emptyHours();
      // Normalize each day (server may omit fields).
      DAY_NAMES.forEach((d) => {
        h[d] = {
          open: h[d]?.open || '10:00',
          close: h[d]?.close || '22:00',
          is_closed: !!h[d]?.is_closed,
        };
      });
      setHours(h);
      // Auto-detect "same hours" so the toggle reflects the current data.
      const openDays = DAY_NAMES.filter((d) => !h[d].is_closed);
      if (openDays.length > 1) {
        const first = h[openDays[0]];
        const allSame = openDays.every((d) => h[d].open === first.open && h[d].close === first.close);
        if (allSame) {
          setSameHours(true);
          setUniOpen(first.open);
          setUniClose(first.close);
        }
      }
      setStatus('');
    } catch (err) {
      setStatus('');
      showToast(err?.response?.data?.error || err.message || 'Failed to load hours', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  const updateDay = (day, patch) => {
    setHours((h) => ({ ...h, [day]: { ...h[day], ...patch } }));
  };

  const applyPreset = (key) => {
    const p = PRESETS[key];
    if (!p) return;
    const next = {};
    DAY_NAMES.forEach((d) => {
      next[d] = {
        open: p.open,
        close: p.close,
        is_closed: p.closedDays.includes(d),
      };
    });
    setHours(next);
    setUniOpen(p.open);
    setUniClose(p.close);
  };

  const handleSameToggle = (next) => {
    setSameHours(next);
    if (next) {
      // Seed uniform from the first open day so users don't lose context.
      const firstOpen = DAY_NAMES.find((d) => !hours[d].is_closed);
      if (firstOpen) {
        setUniOpen(hours[firstOpen].open);
        setUniClose(hours[firstOpen].close);
      }
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setStatus('Saving…');
    const payload = {};
    DAY_NAMES.forEach((d) => {
      const dh = hours[d];
      payload[d] = {
        open: sameHours ? uniOpen : dh.open,
        close: sameHours ? uniClose : dh.close,
        is_closed: !!dh.is_closed,
      };
    });
    try {
      await updateBranchHours(branchId, payload);
      showToast('Operating hours saved!', 'success');
      setStatus('Saved!');
      setTimeout(() => setStatus(''), 2000);
      if (onSaved) onSaved();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Failed to save hours', 'error');
      setStatus('Failed');
    } finally {
      setSaving(false);
    }
  };

  const rows = useMemo(() => DAY_NAMES.map((d, i) => ({
    day: d,
    label: DAY_LABELS[i],
    ...hours[d],
  })), [hours]);

  return (
    <div
      style={{
        padding: '.8rem',
        background: 'var(--ink2,#f4f4f5)',
        border: '1px solid var(--bdr,#e5e7eb)',
        borderRadius: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '.6rem' }}>
        <h4 style={{ margin: 0, fontSize: '.88rem', color: 'var(--txt)' }}>Operating Hours</h4>
        <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem', fontSize: '.78rem', color: 'var(--dim)', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={sameHours}
            onChange={(e) => handleSameToggle(e.target.checked)}
            style={{ accentColor: 'var(--wa,#22c55e)' }}
          />
          Same hours every day
        </label>
      </div>

      <div style={{ display: 'flex', gap: '.4rem', marginBottom: '.6rem', flexWrap: 'wrap' }}>
        <button type="button" className="btn-g btn-sm" onClick={() => applyPreset('standard')} disabled={saving || loading}>
          Standard (10–22)
        </button>
        <button type="button" className="btn-g btn-sm" onClick={() => applyPreset('weekdays')} disabled={saving || loading}>
          Weekdays Only
        </button>
        <button type="button" className="btn-g btn-sm" onClick={() => applyPreset('late')} disabled={saving || loading}>
          Late Night (18–02)
        </button>
      </div>

      {sameHours && (
        <div
          style={{
            marginBottom: '.5rem',
            padding: '.5rem .6rem',
            background: 'var(--bg)',
            border: '1px solid var(--bdr,#e5e7eb)',
            borderRadius: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', fontSize: '.82rem' }}>
            <span style={{ color: 'var(--dim)', width: 50 }}>All days</span>
            <input
              type="time"
              value={uniOpen}
              onChange={(e) => setUniOpen(e.target.value)}
              style={{ padding: '.25rem .4rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.78rem' }}
            />
            <span style={{ color: 'var(--dim)' }}>to</span>
            <input
              type="time"
              value={uniClose}
              onChange={(e) => setUniClose(e.target.value)}
              style={{ padding: '.25rem .4rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.78rem' }}
            />
          </div>
        </div>
      )}

      <div>
        {rows.map((r) => {
          const disabled = r.is_closed || sameHours;
          return (
            <div
              key={r.day}
              className="hours-row"
              data-day={r.day}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '.5rem',
                padding: '.35rem 0',
                fontSize: '.82rem',
                borderBottom: '1px solid var(--bdr,#e5e7eb)',
              }}
            >
              <span style={{ width: 80, color: 'var(--dim)', fontWeight: 500 }}>{r.label}</span>
              <Toggle
                checked={!r.is_closed}
                onChange={(next) => updateDay(r.day, { is_closed: !next })}
              />
              <span style={{ fontSize: '.72rem', color: 'var(--dim)', width: 44 }}>
                {r.is_closed ? 'Closed' : 'Open'}
              </span>
              {!sameHours && (
                <>
                  <input
                    type="time"
                    value={r.open}
                    disabled={disabled}
                    onChange={(e) => updateDay(r.day, { open: e.target.value })}
                    style={{
                      padding: '.2rem .35rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.78rem',
                      opacity: disabled ? 0.45 : 1,
                    }}
                  />
                  <span style={{ color: 'var(--dim)', opacity: disabled ? 0.45 : 1 }}>to</span>
                  <input
                    type="time"
                    value={r.close}
                    disabled={disabled}
                    onChange={(e) => updateDay(r.day, { close: e.target.value })}
                    style={{
                      padding: '.2rem .35rem', border: '1px solid var(--rim)', borderRadius: 4, fontSize: '.78rem',
                      opacity: disabled ? 0.45 : 1,
                    }}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginTop: '.6rem' }}>
        <button type="button" className="btn-p btn-sm" onClick={handleSave} disabled={saving || loading}>
          {saving ? 'Saving…' : 'Save Hours'}
        </button>
        <span style={{ fontSize: '.75rem', color: 'var(--dim)' }}>{status}</span>
      </div>
      <div style={{ marginTop: '.4rem', fontSize: '.72rem', color: 'var(--dim)' }}>
        Changes take effect immediately. Customers see updated hours on WhatsApp.
      </div>
    </div>
  );
}
