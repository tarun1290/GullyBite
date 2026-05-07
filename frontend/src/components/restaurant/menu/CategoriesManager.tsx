'use client';

import { useEffect, useState } from 'react';
import { useToast } from '../../Toast';
import {
  getBranchCategories,
  createBranchCategory,
  updateBranchCategory,
  deleteBranchCategory,
} from '../../../api/restaurant';

interface Category {
  id: string;
  name: string;
}

interface CategoriesManagerProps {
  branchId: string;
  onChange?: () => void;
}

export default function CategoriesManager({ branchId, onChange }: CategoriesManagerProps) {
  const { showToast } = useToast();
  const [open, setOpen] = useState<boolean>(false);
  const [cats, setCats] = useState<Category[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [newName, setNewName] = useState<string>('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const load = async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const list = (await getBranchCategories(branchId)) as Category[] | null | undefined;
      setCats(Array.isArray(list) ? list : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load categories', 'error');
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
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Create failed', 'error');
    }
  };

  const handleSave = async (id: string) => {
    const name = editingName.trim();
    if (!name) return showToast('Category name cannot be empty', 'error');
    try {
      await updateBranchCategory(branchId, id, name);
      setEditingId(null);
      setEditingName('');
      showToast(`Renamed to "${name}"`, 'success');
      load();
      if (onChange) onChange();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Rename failed', 'error');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteBranchCategory(branchId, id);
      showToast('Deleted', 'success');
      setPendingDelete(null);
      load();
      if (onChange) onChange();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Delete failed', 'error');
    }
  };

  if (!branchId) return null;

  return (
    <div className="card mb-4">
      <div className="ch justify-between">
        <h3 className="text-[0.92rem]">📁 Categories</h3>
        <button type="button" className="btn-g btn-sm" onClick={() => setOpen((v) => !v)}>
          {open ? '▲ collapse' : '▼ expand'}
        </button>
      </div>
      {open && (
        <div className="cb">
          <div className="flex gap-2 mb-[0.7rem]">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New category name"
              className="flex-1 py-[0.4rem] px-[0.6rem] border border-rim rounded-md text-[0.85rem]"
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
            />
            <button type="button" className="btn-p btn-sm" onClick={handleCreate}>+ Add</button>
          </div>
          {loading ? (
            <p className="text-dim text-[0.82rem]">Loading…</p>
          ) : !cats.length ? (
            <p className="text-dim text-[0.82rem]">No categories yet.</p>
          ) : (
            <div className="flex flex-col gap-[0.4rem]">
              {cats.map((c) => (
                <div
                  key={c.id}
                  className="flex gap-2 items-center py-[0.38rem] px-2 bg-ink2 rounded-[7px]"
                >
                  {editingId === c.id ? (
                    <input
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSave(c.id);
                        if (e.key === 'Escape') { setEditingId(null); setEditingName(''); }
                      }}
                      className="flex-1 py-[0.28rem] px-2 border border-bdr rounded-md text-[0.84rem]"
                      autoFocus
                    />
                  ) : (
                    <span className="flex-1 text-[0.84rem]">{c.name}</span>
                  )}
                  {editingId === c.id ? (
                    <>
                      <button type="button" className="btn-p btn-sm" onClick={() => handleSave(c.id)}>Save</button>
                      <button type="button" className="btn-g btn-sm" onClick={() => { setEditingId(null); setEditingName(''); }}>Cancel</button>
                    </>
                  ) : pendingDelete === c.id ? (
                    <>
                      <span className="text-[0.72rem] text-[#b91c1c]">Delete?</span>
                      <button type="button" className="btn-del btn-sm" onClick={() => handleDelete(c.id)}>Yes</button>
                      <button type="button" className="btn-g btn-sm" onClick={() => setPendingDelete(null)}>No</button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="btn-g btn-sm" onClick={() => { setEditingId(c.id); setEditingName(c.name); }}>✏ Edit</button>
                      <button type="button" className="btn-g btn-sm text-[#dc2626]" onClick={() => setPendingDelete(c.id)}>🗑</button>
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
