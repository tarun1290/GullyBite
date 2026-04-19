import { useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast.jsx';
import {
  getBranchCategories,
  createBranchCategory,
  updateBranchCategory,
  deleteBranchCategory,
} from '../../../api/restaurant.js';

// Mirrors #cat-manager-card + toggleCatManager() + renderCatList() + doCreateCat()
// + startEditCat/saveCat/cancelEditCat/doDeleteCat (menu.js:1052-1137). The
// delete confirm is converted to an inline two-click pattern.
export default function CategoriesManager({ branchId, onChange }) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [cats, setCats] = useState([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);

  const load = async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const list = await getBranchCategories(branchId);
      setCats(Array.isArray(list) ? list : []);
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Failed to load categories', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, branchId]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return showToast('Enter a category name', 'error');
    try {
      await createBranchCategory(branchId, name);
      setNewName('');
      showToast(`Category "${name}" created`, 'success');
      load();
      if (onChange) onChange();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Create failed', 'error');
    }
  };

  const handleSave = async (id) => {
    const name = editingName.trim();
    if (!name) return showToast('Category name cannot be empty', 'error');
    try {
      await updateBranchCategory(branchId, id, name);
      setEditingId(null);
      setEditingName('');
      showToast(`Renamed to "${name}"`, 'success');
      load();
      if (onChange) onChange();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Rename failed', 'error');
    }
  };

  const handleDelete = async (id) => {
    try {
      await deleteBranchCategory(branchId, id);
      showToast('Deleted', 'success');
      setPendingDelete(null);
      load();
      if (onChange) onChange();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Delete failed', 'error');
    }
  };

  if (!branchId) return null;

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div className="ch" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ fontSize: '.92rem' }}>📁 Categories</h3>
        <button type="button" className="btn-g btn-sm" onClick={() => setOpen((v) => !v)}>
          {open ? '▲ collapse' : '▼ expand'}
        </button>
      </div>
      {open && (
        <div className="cb">
          <div style={{ display: 'flex', gap: '.5rem', marginBottom: '.7rem' }}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New category name"
              style={{
                flex: 1, padding: '.4rem .6rem', border: '1px solid var(--rim)',
                borderRadius: 6, fontSize: '.85rem',
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
            />
            <button type="button" className="btn-p btn-sm" onClick={handleCreate}>+ Add</button>
          </div>
          {loading ? (
            <p style={{ color: 'var(--dim)', fontSize: '.82rem' }}>Loading…</p>
          ) : !cats.length ? (
            <p style={{ color: 'var(--dim)', fontSize: '.82rem' }}>No categories yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
              {cats.map((c) => (
                <div
                  key={c.id}
                  style={{
                    display: 'flex', gap: '.5rem', alignItems: 'center',
                    padding: '.38rem .5rem', background: 'var(--ink2)', borderRadius: 7,
                  }}
                >
                  {editingId === c.id ? (
                    <input
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSave(c.id);
                        if (e.key === 'Escape') { setEditingId(null); setEditingName(''); }
                      }}
                      style={{
                        flex: 1, padding: '.28rem .5rem', border: '1px solid var(--bdr)',
                        borderRadius: 6, fontSize: '.84rem',
                      }}
                      autoFocus
                    />
                  ) : (
                    <span style={{ flex: 1, fontSize: '.84rem' }}>{c.name}</span>
                  )}
                  {editingId === c.id ? (
                    <>
                      <button type="button" className="btn-p btn-sm" onClick={() => handleSave(c.id)}>Save</button>
                      <button type="button" className="btn-g btn-sm" onClick={() => { setEditingId(null); setEditingName(''); }}>Cancel</button>
                    </>
                  ) : pendingDelete === c.id ? (
                    <>
                      <span style={{ fontSize: '.72rem', color: '#b91c1c' }}>Delete?</span>
                      <button type="button" className="btn-sm" style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, padding: '.25rem .6rem', fontSize: '.72rem' }} onClick={() => handleDelete(c.id)}>Yes</button>
                      <button type="button" className="btn-g btn-sm" onClick={() => setPendingDelete(null)}>No</button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="btn-g btn-sm" onClick={() => { setEditingId(c.id); setEditingName(c.name); }}>✏ Edit</button>
                      <button type="button" className="btn-g btn-sm" style={{ color: '#dc2626' }} onClick={() => setPendingDelete(c.id)}>🗑</button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
