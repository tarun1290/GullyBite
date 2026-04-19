import { useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast.jsx';
import { assignProductToBranch, getBranchSuggestions } from '../../../api/restaurant.js';

// Mirrors #branch-suggest-modal + openBranchSuggestions + bsToggle + bsApply
// (menu.js:2730-2823). Pulls backend suggestions, lets the operator toggle
// branch picks, then applies them by looping per-branch assign-branch calls.
const REASON_LABEL = {
  name_match: 'name match',
  category_cluster: 'category cluster',
  all_active_fallback: 'fallback (all active)',
};

export default function BranchSuggestionsModal({ branches, menuItems, onClose, onApplied }) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [selection, setSelection] = useState({});
  const [applying, setApplying] = useState(false);
  const [banner, setBanner] = useState('Loading suggestions…');

  useEffect(() => {
    (async () => {
      try {
        const r = await getBranchSuggestions();
        const list = (r && r.suggestions) || [];
        const nameById = new Map();
        (menuItems || []).forEach((it) => {
          const key = String(it._id || it.id);
          nameById.set(key, it.name);
        });
        const mapped = list.map((s) => ({
          product_id: s.product_id,
          suggested_branch_ids: s.suggested_branch_ids || [],
          reason: s.reason,
          name: nameById.get(String(s.product_id)) || s.product_id,
        }));
        const sel = {};
        mapped.forEach((row) => { sel[row.product_id] = new Set(row.suggested_branch_ids); });
        setRows(mapped);
        setSelection(sel);
        if (!mapped.length) setBanner('No suggestions — every product is already assigned.');
        else setBanner(`Suggested mapping available for ${mapped.length} product${mapped.length === 1 ? '' : 's'}. Edit selections below or accept all.`);
      } catch (err) {
        setBanner('Failed: ' + (err.message || 'load error'));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (pid, bid) => {
    setSelection((s) => {
      const next = { ...s };
      const cur = new Set(next[pid] || []);
      if (cur.has(bid)) cur.delete(bid); else cur.add(bid);
      next[pid] = cur;
      return next;
    });
  };

  const acceptAll = () => {
    const next = {};
    rows.forEach((r) => { next[r.product_id] = new Set(r.suggested_branch_ids); });
    setSelection(next);
  };

  const apply = async () => {
    setApplying(true);
    let ok = 0; let fail = 0;
    for (const row of rows) {
      const picks = [...(selection[row.product_id] || [])];
      for (const bid of picks) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await assignProductToBranch(row.product_id, { branch_id: bid, price: 0, availability: true });
          ok += 1;
        } catch {
          fail += 1;
        }
      }
    }
    setApplying(false);
    showToast(`Applied ${ok} assignment${ok === 1 ? '' : 's'}${fail ? ` · ${fail} failed` : ''}`, fail ? 'error' : 'success');
    if (onApplied) onApplied();
    if (onClose) onClose();
  };

  const branchOpts = (branches || []).map((b) => ({ id: String(b._id || b.id), name: b.name || b.id }));

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 100,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '2rem 1rem', overflowY: 'auto',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="card" style={{ maxWidth: 680, width: '100%', background: 'var(--surface,#fff)' }}>
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>🪄 Branch Suggestions</h3>
          <button type="button" className="btn-g btn-sm" onClick={onClose} disabled={applying}>✕</button>
        </div>
        <div className="cb">
          <p style={{ fontSize: '.82rem', color: 'var(--dim)', marginBottom: '.7rem' }}>{banner}</p>
          {loading ? (
            <p style={{ color: 'var(--dim)' }}>Loading…</p>
          ) : (
            <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid var(--rim)', borderRadius: 8 }}>
              {rows.map((row) => {
                const sel = selection[row.product_id] || new Set();
                return (
                  <div key={row.product_id} style={{ padding: '.65rem .8rem', borderBottom: '1px solid #f1f5f9' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.35rem' }}>
                      <div style={{ fontWeight: 600, fontSize: '.86rem' }}>{row.name}</div>
                      <div style={{ fontSize: '.7rem', color: 'var(--dim)' }}>{REASON_LABEL[row.reason] || row.reason}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '.35rem', flexWrap: 'wrap' }}>
                      {branchOpts.length ? branchOpts.map((b) => {
                        const on = sel.has(b.id);
                        return (
                          <label
                            key={b.id}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: '.3rem',
                              fontSize: '.78rem', padding: '.15rem .45rem',
                              border: `1px solid ${on ? '#4f46e5' : '#e5e7eb'}`,
                              borderRadius: 99, background: on ? '#eef2ff' : '#fff', cursor: 'pointer',
                            }}
                          >
                            <input type="checkbox" checked={on} onChange={() => toggle(row.product_id, b.id)} style={{ margin: 0 }} />
                            {b.name}
                          </label>
                        );
                      }) : <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>No branches yet</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ display: 'flex', gap: '.5rem', marginTop: '1rem', justifyContent: 'flex-end' }}>
            <button type="button" className="btn-g" onClick={acceptAll} disabled={applying || loading || !rows.length}>Accept suggested</button>
            <button type="button" className="btn-p" onClick={apply} disabled={applying || loading || !rows.length}>
              {applying ? 'Applying…' : 'Apply selected'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
