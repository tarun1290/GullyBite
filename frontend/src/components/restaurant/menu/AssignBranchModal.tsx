'use client';

import { useState, type MouseEvent } from 'react';
import { useToast } from '../../Toast';
import { assignProductToBranch } from '../../../api/restaurant';
import type { Branch } from '../../../types';

interface AssignBranchModalProps {
  productId: string;
  productName: string;
  branches: Branch[];
  onClose: () => void;
  onSaved?: () => void;
}

export default function AssignBranchModal({ productId, productName, branches, onClose, onSaved }: AssignBranchModalProps) {
  const { showToast } = useToast();
  const [branchId, setBranchId] = useState<string>('');
  const [price, setPrice] = useState<string>('');
  const [tax, setTax] = useState<string>('');
  const [avail, setAvail] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);

  const handleSave = async () => {
    if (!branchId) return showToast('Pick a branch', 'error');
    const p = parseFloat(price);
    if (Number.isNaN(p) || p < 0) return showToast('Price is required', 'error');
    const t = parseFloat(tax);
    setBusy(true);
    try {
      await assignProductToBranch(productId, {
        branch_id: branchId,
        price: p,
        tax_percentage: Number.isNaN(t) ? undefined : t,
        availability: avail,
      });
      showToast('✅ Assigned to branch', 'success');
      if (onSaved) onSaved();
      if (onClose) onClose();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Assign failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const operational = (branches || []).filter((b) => b.is_active !== false);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 100,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '2rem 1rem',
      }}
      onClick={(e: MouseEvent<HTMLDivElement>) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card" style={{ maxWidth: 480, width: '100%', background: 'var(--surface,#fff)' }}>
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>📌 Assign to Branch</h3>
          <button type="button" className="btn-g btn-sm" onClick={onClose} disabled={busy}>✕</button>
        </div>
        <div className="cb">
          <p style={{ fontSize: '.82rem', color: 'var(--dim)', marginBottom: '.7rem' }}>
            Assigning <strong>{productName}</strong> to a branch. Set the per-branch price so customers
            at that outlet see the right amount.
          </p>
          <div className="fgrid">
            <div className="fg span2">
              <label>Branch *</label>
              <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">Select branch…</option>
                {operational.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.fssai_number ? '' : ' (no FSSAI)'}
                  </option>
                ))}
              </select>
            </div>
            <div className="fg">
              <label>Price (₹) *</label>
              <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <div className="fg">
              <label>Tax % (optional)</label>
              <input type="number" value={tax} onChange={(e) => setTax(e.target.value)} />
            </div>
            <div className="fg span2">
              <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                <input type="checkbox" checked={avail} onChange={(e) => setAvail(e.target.checked)} />
                Available at this branch
              </label>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '.5rem', marginTop: '1rem' }}>
            <button type="button" className="btn-p" onClick={handleSave} disabled={busy}>
              {busy ? 'Assigning…' : 'Assign'}
            </button>
            <button type="button" className="btn-g" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
