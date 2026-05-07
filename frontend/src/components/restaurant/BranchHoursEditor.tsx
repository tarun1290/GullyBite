'use client';

import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../Toast';
import Toggle from '../Toggle';
import { getBranchHours, updateBranchHours } from '../../api/restaurant';
import type { BranchHours, BranchHoursDay } from '../../types';

const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

type DayName = typeof DAY_NAMES[number];

interface PresetDef { open: string; close: string; closedDays: DayName[] }

const PRESETS: Record<string, PresetDef> = {
  standard: { open: '10:00', close: '22:00', closedDays: [] },
  weekdays: { open: '10:00', close: '22:00', closedDays: ['saturday', 'sunday'] },
  late: { open: '18:00', close: '02:00', closedDays: [] },
};

type HoursMap = Record<DayName, BranchHoursDay>;

function emptyHours(): HoursMap {
  const h = {} as HoursMap;
  DAY_NAMES.forEach((d) => {
    h[d] = { open: '10:00', close: '22:00', is_closed: false };
  });
  return h;
}

interface BranchHoursEditorProps {
  branchId: string;
  onSaved?: () => void;
}

export default function BranchHoursEditor({ branchId, onSaved }: BranchHoursEditorProps) {
  const { showToast } = useToast();
  const [hours, setHours] = useState<HoursMap>(emptyHours());
  const [sameHours, setSameHours] = useState<boolean>(false);
  const [uniOpen, setUniOpen] = useState<string>('10:00');
  const [uniClose, setUniClose] = useState<string>('22:00');
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [status, setStatus] = useState<string>('');

  const load = async () => {
    setLoading(true);
    setStatus('Loading…');
    try {
      const res = await getBranchHours(branchId);
      const incoming: BranchHours | null = res?.hours && typeof res.hours === 'object' ? res.hours : null;
      const h = emptyHours();
      DAY_NAMES.forEach((d) => {
        const dh = incoming?.[d];
        h[d] = {
          open: dh?.open || '10:00',
          close: dh?.close || '22:00',
          is_closed: !!dh?.is_closed,
        };
      });
      setHours(h);
      const openDays = DAY_NAMES.filter((d) => !h[d].is_closed);
      if (openDays.length > 1) {
        const firstDay = openDays[0];
        if (firstDay) {
          const first = h[firstDay];
          const allSame = openDays.every((d) => h[d].open === first.open && h[d].close === first.close);
          if (allSame) {
            setSameHours(true);
            setUniOpen(first.open);
            setUniClose(first.close);
          }
        }
      }
      setStatus('');
    } catch (err: unknown) {
      setStatus('');
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load hours', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  const updateDay = (day: DayName, patch: Partial<BranchHoursDay>) => {
    setHours((h) => ({ ...h, [day]: { ...h[day], ...patch } }));
  };

  const applyPreset = (key: string) => {
    const p = PRESETS[key];
    if (!p) return;
    const next = {} as HoursMap;
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

  const handleSameToggle = (next: boolean) => {
    setSameHours(next);
    if (next) {
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
    const payload: BranchHours = {};
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
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to save hours', 'error');
      setStatus('Failed');
    } finally {
      setSaving(false);
    }
  };

  const rows = useMemo(() => DAY_NAMES.map((d, i) => ({
    day: d,
    label: DAY_LABELS[i] || d,
    ...hours[d],
  })), [hours]);

  return (
    <div className="p-[0.8rem] bg-ink2 border border-bdr rounded-lg">
      <div className="flex items-center justify-between mb-[0.6rem]">
        <h4 className="m-0 text-[0.88rem] text-tx">Operating Hours</h4>
        <label className="flex items-center gap-[0.4rem] text-[0.78rem] text-dim cursor-pointer">
          <input
            type="checkbox"
            checked={sameHours}
            onChange={(e) => handleSameToggle(e.target.checked)}
            className="accent-wa"
          />
          Same hours every day
        </label>
      </div>

      <div className="flex gap-[0.4rem] mb-[0.6rem] flex-wrap">
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
        <div className="mb-2 py-2 px-[0.6rem] bg-bg border border-bdr rounded-md">
          <div className="flex items-center gap-[0.6rem] text-[0.82rem]">
            <span className="text-dim w-[50px]">All days</span>
            <input
              type="time"
              value={uniOpen}
              onChange={(e) => setUniOpen(e.target.value)}
              className="py-1 px-[0.4rem] border border-rim rounded-[4px] text-[0.78rem]"
            />
            <span className="text-dim">to</span>
            <input
              type="time"
              value={uniClose}
              onChange={(e) => setUniClose(e.target.value)}
              className="py-1 px-[0.4rem] border border-rim rounded-[4px] text-[0.78rem]"
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
              className="hours-row flex items-center gap-2 py-[0.35rem] text-[0.82rem] border-b border-bdr"
              data-day={r.day}
            >
              <span className="w-20 text-dim font-medium">{r.label}</span>
              <Toggle
                checked={!r.is_closed}
                onChange={(next) => updateDay(r.day, { is_closed: !next })}
              />
              <span className="text-[0.72rem] text-dim w-11">
                {r.is_closed ? 'Closed' : 'Open'}
              </span>
              {!sameHours && (
                <>
                  <input
                    type="time"
                    value={r.open}
                    disabled={disabled}
                    onChange={(e) => updateDay(r.day, { open: e.target.value })}
                    className={`py-[0.2rem] px-[0.35rem] border border-rim rounded-[4px] text-[0.78rem] ${disabled ? 'opacity-[0.45]' : 'opacity-100'}`}
                  />
                  <span className={`text-dim ${disabled ? 'opacity-[0.45]' : 'opacity-100'}`}>to</span>
                  <input
                    type="time"
                    value={r.close}
                    disabled={disabled}
                    onChange={(e) => updateDay(r.day, { close: e.target.value })}
                    className={`py-[0.2rem] px-[0.35rem] border border-rim rounded-[4px] text-[0.78rem] ${disabled ? 'opacity-[0.45]' : 'opacity-100'}`}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-[0.6rem] mt-[0.6rem]">
        <button type="button" className="btn-p btn-sm" onClick={handleSave} disabled={saving || loading}>
          {saving ? 'Saving…' : 'Save Hours'}
        </button>
        <span className="text-[0.75rem] text-dim">{status}</span>
      </div>
      <div className="mt-[0.4rem] text-[0.72rem] text-dim">
        Changes take effect immediately. Customers see updated hours on WhatsApp.
      </div>
    </div>
  );
}
