'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../components/Toast';
import { useAdminAuth } from '../../../contexts/AdminAuthContext';
import {
  createCity,
  getCities,
  getMetaPhoneNumbers,
} from '../../../api/admin';
import type { CityDoc, MetaPhoneNumber } from '../../../types';

const TH_CLS = 'py-2.5 px-3 text-left text-xs text-dim uppercase font-bold tracking-[0.04em]';
const TD_CLS = 'py-2.5 px-3 align-top';
const EMPTY_CLS = 'p-6 text-center text-dim';

interface StatusChipProps { status: CityDoc['status'] }

function statusClass(status: CityDoc['status']): string {
  switch (status) {
    case 'active':
      return 'chip on';
    case 'setup':
      return 'chip text-yellow-600';
    case 'paused':
      return 'chip text-dim';
    case 'deleted':
      return 'chip text-red-600';
    default:
      return 'chip';
  }
}

function StatusChip({ status }: StatusChipProps) {
  return <span className={statusClass(status)}>{status}</span>;
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('en-IN'); } catch { return '—'; }
}

interface CreateCityFormState {
  name: string;
  display_name: string;
  areas: string;
  phone_number_id: string;
}

const EMPTY_FORM: CreateCityFormState = {
  name: '',
  display_name: '',
  areas: '',
  phone_number_id: '',
};

export default function AdminCitiesPage() {
  const { showToast } = useToast();
  const { adminUser } = useAdminAuth();

  const [rows, setRows] = useState<CityDoc[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const [creating, setCreating] = useState<boolean>(false);
  const [form, setForm] = useState<CreateCityFormState>(EMPTY_FORM);
  const [phones, setPhones] = useState<MetaPhoneNumber[]>([]);
  const [phonesLoading, setPhonesLoading] = useState<boolean>(false);
  const [phonesErr, setPhonesErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const canCreate = adminUser?.role !== 'city_ops';

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await getCities();
      setRows(Array.isArray(data) ? data : []);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setErr(er?.response?.data?.error || er?.message || 'Failed to load cities');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = useCallback(async () => {
    setCreating(true);
    setForm(EMPTY_FORM);
    setPhonesErr(null);
    setPhonesLoading(true);
    try {
      const data = await getMetaPhoneNumbers();
      setPhones(Array.isArray(data) ? data : []);
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      setPhonesErr(er?.response?.data?.error || er?.message || 'Failed to load WABA phone numbers');
    } finally {
      setPhonesLoading(false);
    }
  }, []);

  const closeCreate = useCallback(() => {
    setCreating(false);
    setForm(EMPTY_FORM);
    setPhones([]);
    setPhonesErr(null);
  }, []);

  const submit = useCallback(async () => {
    const name = form.name.trim();
    if (!name) {
      showToast('Name is required', 'error');
      return;
    }
    if (!form.phone_number_id) {
      showToast('Please select a WABA phone number', 'error');
      return;
    }
    const areas = form.areas
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    setSubmitting(true);
    try {
      await createCity({
        name,
        display_name: form.display_name.trim() || undefined,
        phone_number_id: form.phone_number_id,
        areas: areas.length > 0 ? areas : undefined,
      });
      showToast('City created', 'success');
      closeCreate();
      await load();
    } catch (e: unknown) {
      const er = e as { response?: { data?: { error?: string } }; message?: string };
      showToast(er?.response?.data?.error || er?.message || 'Failed to create city', 'error');
    } finally {
      setSubmitting(false);
    }
  }, [form, showToast, closeCreate, load]);

  const totalLabel = useMemo<string>(() => {
    if (loading) return '';
    return `${rows.length} record(s)`;
  }, [loading, rows]);

  return (
    <div id="pg-cities" className="space-y-4 p-4">
      <div className="card">
        <div className="ch gap-2.5 flex-wrap">
          <div>
            <h3>Cities</h3>
            <div className="text-xs text-dim">Manage city WABA + listings</div>
          </div>
          <span className="text-dim text-xs">{totalLabel}</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="btn-g btn-sm"
              onClick={load}
              disabled={loading}
            >
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
            {canCreate && (
              <button
                type="button"
                className="btn-g btn-sm"
                onClick={openCreate}
                disabled={creating}
              >
                + Create City
              </button>
            )}
          </div>
        </div>

        {err ? (
          <div className="cb">
            <div className="notice warn">
              <div className="notice-ico">⚠️</div>
              <div className="notice-body">
                <p>{err}</p>
                <button type="button" className="btn-g btn-sm" onClick={load}>Retry</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="cb overflow-x-auto p-0">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-ink border-b border-rim">
                  <th className={TH_CLS}>Name</th>
                  <th className={TH_CLS}>Display Name</th>
                  <th className={TH_CLS}>Status</th>
                  <th className={TH_CLS}>Listings</th>
                  <th className={TH_CLS}>Created</th>
                  <th className={TH_CLS}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className={EMPTY_CLS}>Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={6} className={EMPTY_CLS}>No cities yet</td></tr>
                ) : (
                  rows.map((c) => (
                    <tr key={c._id} className="border-b border-rim">
                      <td className={TD_CLS}>
                        <strong>{c.name}</strong>
                        <div className="text-xs text-dim">/{c.slug}</div>
                      </td>
                      <td className={TD_CLS}>{c.display_name || '—'}</td>
                      <td className={TD_CLS}><StatusChip status={c.status} /></td>
                      <td className={TD_CLS}>{typeof c.listing_count === 'number' ? c.listing_count : '—'}</td>
                      <td className={TD_CLS}>{fmtDate(c.created_at)}</td>
                      <td className={TD_CLS}>
                        <Link
                          href={`/admin/cities/${encodeURIComponent(c.slug)}`}
                          className="btn-g btn-sm"
                        >View</Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating && canCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="card w-full max-w-lg">
            <div className="ch">
              <h3>Create City</h3>
              <button
                type="button"
                className="btn-g btn-sm ml-auto"
                onClick={closeCreate}
                disabled={submitting}
              >Close</button>
            </div>
            <div className="cb space-y-3">
              <div>
                <label className="lbl">Name</label>
                <input
                  type="text"
                  className="inp"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Hyderabad"
                  disabled={submitting}
                />
              </div>
              <div>
                <label className="lbl">Display Name (optional)</label>
                <input
                  type="text"
                  className="inp"
                  value={form.display_name}
                  onChange={(e) => setForm((p) => ({ ...p, display_name: e.target.value }))}
                  placeholder="defaults to name"
                  disabled={submitting}
                />
              </div>
              <div>
                <label className="lbl">Areas (comma-separated)</label>
                <textarea
                  rows={3}
                  className="inp"
                  value={form.areas}
                  onChange={(e) => setForm((p) => ({ ...p, areas: e.target.value }))}
                  placeholder="Banjara Hills, Jubilee Hills, Gachibowli"
                  disabled={submitting}
                />
              </div>
              <div>
                <label className="lbl">WABA Phone Number</label>
                {phonesLoading ? (
                  <div className="text-xs text-dim">Loading phone numbers…</div>
                ) : phonesErr ? (
                  <div className="notice warn">
                    <div className="notice-ico">⚠️</div>
                    <div className="notice-body"><p>{phonesErr}</p></div>
                  </div>
                ) : (
                  <select
                    className="inp"
                    value={form.phone_number_id}
                    onChange={(e) => setForm((p) => ({ ...p, phone_number_id: e.target.value }))}
                    disabled={submitting}
                  >
                    <option value="">— Select a phone number —</option>
                    {phones.map((p) => {
                      const qual = p.quality_rating ? ` · ${p.quality_rating}` : '';
                      const assigned = p.assigned_to_city ? ` (assigned: ${p.assigned_to_city})` : '';
                      const label = `${p.display_phone_number} — ${p.verified_name}${qual}${assigned}`;
                      return (
                        <option
                          key={p.id}
                          value={p.id}
                          disabled={p.assigned_to_city !== null}
                        >{label}</option>
                      );
                    })}
                  </select>
                )}
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  className="btn-g btn-sm"
                  onClick={closeCreate}
                  disabled={submitting}
                >Cancel</button>
                <button
                  type="button"
                  className="btn-g btn-sm"
                  onClick={submit}
                  disabled={submitting || phonesLoading}
                >{submitting ? 'Creating…' : 'Create'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
