import { useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast.jsx';
import {
  getProductSets,
  createProductSet,
  updateProductSet,
  deleteProductSet,
  autoCreateProductSets,
  syncProductSets,
} from '../../../api/restaurant.js';

// Mirrors #product-sets-card + all product-set handlers (menu.js:1887-2006).
// Requires a specific branch selected. `window.confirm` on delete becomes
// an inline two-click pattern in the card row.
const SET_TYPES = [
  ['category', 'Category'],
  ['tag', 'Tag'],
  ['manual', 'Manual IDs'],
];

function emptyForm() {
  return {
    name: '', type: 'category', filterValue: '',
    manualIdsRaw: '', sortOrder: 0,
  };
}

export default function ProductSetsSection({ branches, selectedBranchId, setSelectedBranchId }) {
  const { showToast } = useToast();
  const [sets, setSets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  const isSpecific = selectedBranchId && !selectedBranchId.startsWith('__');
  const branch = isSpecific ? branches.find((b) => b.id === selectedBranchId) : null;
  const hasCatalog = !!branch?.catalog_id;

  const load = async () => {
    if (!isSpecific) { setSets([]); return; }
    setLoading(true);
    try {
      const list = await getProductSets(selectedBranchId);
      setSets(Array.isArray(list) ? list : []);
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Failed to load sets', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBranchId]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setModalOpen(true);
  };

  const openEdit = (s) => {
    setEditingId(s.id);
    setForm({
      name: s.name || '',
      type: s.type || 'category',
      filterValue: s.filter_value || '',
      manualIdsRaw: (s.manual_retailer_ids || []).join(', '),
      sortOrder: s.sort_order || 0,
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) return showToast('Set name required', 'error');
    const body = {
      branchId: selectedBranchId,
      name,
      type: form.type,
      filterValue: form.filterValue.trim() || null,
      manualRetailerIds: form.type === 'manual'
        ? form.manualIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
      sortOrder: parseInt(form.sortOrder, 10) || 0,
    };
    setSaving(true);
    try {
      if (editingId) {
        await updateProductSet(editingId, body);
        showToast(`Set "${name}" updated`, 'success');
      } else {
        await createProductSet(body);
        showToast(`Set "${name}" created`, 'success');
      }
      setModalOpen(false);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await deleteProductSet(id);
      showToast('Set deleted', 'success');
      setPendingDelete(null);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Delete failed', 'error');
    }
  };

  const handleAuto = async () => {
    try {
      const r = await autoCreateProductSets(selectedBranchId);
      showToast(`Auto-created ${r.created || 0} sets (${r.skipped || 0} skipped)`, 'success');
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Auto-create failed', 'error');
    }
  };

  const handleSync = async () => {
    try {
      const r = await syncProductSets(selectedBranchId);
      if (r.skipped) showToast('No sets to sync', 'info');
      else showToast(`Synced — ${r.created || 0} created, ${r.updated || 0} updated on Meta`, 'success');
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Sync failed', 'error');
    }
  };

  if (!branches.length) {
    return <div className="card"><div className="cb"><p>No branches yet.</p></div></div>;
  }

  if (!isSpecific) {
    return (
      <div className="card">
        <div className="ch"><h3>📂 Product Sets</h3></div>
        <div className="cb">
          <p style={{ color: 'var(--dim)', fontSize: '.86rem', marginBottom: '.7rem' }}>
            Select a specific branch to manage its product sets.
          </p>
          <select
            value={selectedBranchId}
            onChange={(e) => setSelectedBranchId(e.target.value)}
            style={{ padding: '.4rem .6rem', borderRadius: 7, border: '1px solid var(--rim)', fontSize: '.85rem' }}
          >
            <option value="">Select branch…</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      </div>
    );
  }

  if (!hasCatalog) {
    return (
      <div className="card">
        <div className="ch"><h3>📂 Product Sets</h3></div>
        <div className="cb">
          <p style={{ color: 'var(--dim)', fontSize: '.86rem' }}>
            "{branch.name}" has no catalog yet. Create one from the Branches tab first — product
            sets only sync to Meta once a catalog exists.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>📂 Product Sets — {branch.name}</h3>
          <div style={{ display: 'flex', gap: '.4rem' }}>
            <button type="button" className="btn-g btn-sm" onClick={handleAuto}>✨ Auto-Create</button>
            <button type="button" className="btn-g btn-sm" onClick={handleSync}>🔄 Sync to Meta</button>
            <button type="button" className="btn-p btn-sm" onClick={openCreate}>+ Create Set</button>
          </div>
        </div>
        <div className="cb">
          {loading ? (
            <p style={{ color: 'var(--dim)' }}>Loading…</p>
          ) : !sets.length ? (
            <p style={{ color: 'var(--dim)', fontSize: '.82rem' }}>
              No product sets yet. Click <strong>Auto-Create</strong> to generate from your menu
              categories, or <strong>Create Set</strong> to add manually.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
              {sets.map((s) => {
                const syncBadge = s.meta_product_set_id ? (
                  <span style={{ fontSize: '.65rem', color: 'var(--wa)' }}>🟢 synced</span>
                ) : (
                  <span style={{ fontSize: '.65rem', color: 'var(--gold)' }}>🟡 pending</span>
                );
                return (
                  <div
                    key={s.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '.6rem',
                      padding: '.5rem .7rem', background: 'var(--ink2,#f4f4f5)', borderRadius: 8,
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: '.84rem', flex: 1 }}>{s.name}</span>
                    <span className="badge bd" style={{ fontSize: '.62rem' }}>{s.type}</span>
                    {syncBadge}
                    <button type="button" className="btn-g btn-sm" style={{ fontSize: '.72rem' }} onClick={() => openEdit(s)}>✏ Edit</button>
                    {pendingDelete === s.id ? (
                      <>
                        <button type="button" className="btn-sm" style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, padding: '.2rem .5rem', fontSize: '.72rem' }} onClick={() => handleDelete(s.id)}>Delete</button>
                        <button type="button" className="btn-g btn-sm" style={{ fontSize: '.72rem' }} onClick={() => setPendingDelete(null)}>Cancel</button>
                      </>
                    ) : (
                      <button type="button" className="btn-g btn-sm" style={{ fontSize: '.72rem', color: '#dc2626' }} onClick={() => setPendingDelete(s.id)}>🗑</button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {modalOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 100,
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '2rem 1rem', overflowY: 'auto',
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setModalOpen(false); }}
        >
          <div className="card" style={{ maxWidth: 480, width: '100%', background: 'var(--surface,#fff)' }}>
            <div className="ch" style={{ justifyContent: 'space-between' }}>
              <h3>{editingId ? '✏ Edit Product Set' : '+ Create Product Set'}</h3>
              <button type="button" className="btn-g btn-sm" onClick={() => setModalOpen(false)} disabled={saving}>✕</button>
            </div>
            <div className="cb">
              <div className="fgrid">
                <div className="fg span2">
                  <label>Name *</label>
                  <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="fg">
                  <label>Type</label>
                  <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
                    {SET_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div className="fg">
                  <label>Sort order</label>
                  <input type="number" value={form.sortOrder} onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))} />
                </div>
                {form.type !== 'manual' && (
                  <div className="fg span2">
                    <label>{form.type === 'category' ? 'Category name' : 'Tag name'}</label>
                    <input
                      value={form.filterValue}
                      onChange={(e) => setForm((f) => ({ ...f, filterValue: e.target.value }))}
                      placeholder={form.type === 'category' ? 'e.g. Starters' : 'e.g. spicy'}
                    />
                  </div>
                )}
                {form.type === 'manual' && (
                  <div className="fg span2">
                    <label>Manual retailer IDs (comma-separated)</label>
                    <input
                      value={form.manualIdsRaw}
                      onChange={(e) => setForm((f) => ({ ...f, manualIdsRaw: e.target.value }))}
                      placeholder="SKU-1, SKU-2, SKU-3"
                    />
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '.5rem', marginTop: '1rem' }}>
                <button type="button" className="btn-p" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : (editingId ? 'Save' : 'Create')}
                </button>
                <button type="button" className="btn-g" onClick={() => setModalOpen(false)} disabled={saving}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
