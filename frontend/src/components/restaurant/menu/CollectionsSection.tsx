'use client';

import { useEffect, useState, type MouseEvent } from 'react';
import { useToast } from '../../Toast';
import {
  getCollections,
  createCollection,
  updateCollection,
  deleteCollection,
  reorderCollections,
  autoCreateCollections,
  syncCollections,
  getProductSets,
} from '../../../api/restaurant';
import type { Branch } from '../../../types';

interface FormState {
  name: string;
  description: string;
  coverImageUrl: string;
  sortOrder: number | string;
  productSetIds: string[];
}

interface ProductSetRow {
  id: string;
  name: string;
  type?: string;
}

interface CollectionRow {
  id: string;
  name: string;
  description?: string;
  cover_image_url?: string;
  sort_order?: number;
  product_set_ids?: string[];
  product_sets?: { name: string }[];
  synced?: boolean;
  is_active?: boolean;
}

interface AutoCreateResult { created?: number; skipped?: number }
interface SyncResult { created?: number; updated?: number; skipped?: boolean }

interface CollectionsSectionProps {
  branches: Branch[];
  selectedBranchId: string;
  setSelectedBranchId: (id: string) => void;
}

function emptyForm(): FormState {
  return {
    name: '', description: '', coverImageUrl: '', sortOrder: 0, productSetIds: [],
  };
}

export default function CollectionsSection({ branches, selectedBranchId, setSelectedBranchId }: CollectionsSectionProps) {
  const { showToast } = useToast();
  const [colls, setColls] = useState<CollectionRow[]>([]);
  const [sets, setSets] = useState<ProductSetRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState<boolean>(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const isSpecific = Boolean(selectedBranchId) && !selectedBranchId.startsWith('__');
  const branch = isSpecific ? branches.find((b) => b.id === selectedBranchId) : null;
  const hasCatalog = Boolean(branch?.catalog_id);

  const load = async () => {
    if (!isSpecific) { setColls([]); return; }
    setLoading(true);
    try {
      const list = (await getCollections(selectedBranchId)) as CollectionRow[] | null;
      setColls(Array.isArray(list) ? list : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load collections', 'error');
    } finally {
      setLoading(false);
    }
  };

  const loadSets = async () => {
    if (!isSpecific) { setSets([]); return; }
    try {
      const list = (await getProductSets(selectedBranchId)) as ProductSetRow[] | null;
      setSets(Array.isArray(list) ? list : []);
    } catch { setSets([]); }
  };

  useEffect(() => {
    load();
    loadSets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBranchId]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setModalOpen(true);
  };

  const openEdit = (c: CollectionRow) => {
    setEditingId(c.id);
    setForm({
      name: c.name || '',
      description: c.description || '',
      coverImageUrl: c.cover_image_url || '',
      sortOrder: c.sort_order || 0,
      productSetIds: c.product_set_ids || [],
    });
    setModalOpen(true);
  };

  const toggleSet = (id: string) => {
    setForm((f) => {
      const has = f.productSetIds.includes(id);
      return {
        ...f,
        productSetIds: has ? f.productSetIds.filter((x) => x !== id) : [...f.productSetIds, id],
      };
    });
  };

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) return showToast('Collection name required', 'error');
    const body = {
      branchId: selectedBranchId,
      name,
      description: form.description.trim() || null,
      productSetIds: form.productSetIds,
      coverImageUrl: form.coverImageUrl.trim() || null,
      sortOrder: parseInt(String(form.sortOrder), 10) || 0,
    };
    setSaving(true);
    try {
      if (editingId) {
        await updateCollection(editingId, body);
        showToast(`Collection "${name}" updated`, 'success');
      } else {
        await createCollection(body);
        showToast(`Collection "${name}" created`, 'success');
      }
      setModalOpen(false);
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCollection(id);
      showToast('Collection deleted', 'success');
      setPendingDelete(null);
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Delete failed', 'error');
    }
  };

  const handleAuto = async () => {
    try {
      const r = (await autoCreateCollections(selectedBranchId)) as AutoCreateResult;
      showToast(`Auto-created ${r.created || 0} collections (${r.skipped || 0} skipped)`, 'success');
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Auto-create failed', 'error');
    }
  };

  const handleSync = async () => {
    try {
      const r = (await syncCollections(selectedBranchId)) as SyncResult;
      if (r.skipped) showToast('No collections to sync', 'info');
      else showToast(`Synced — ${r.created || 0} created, ${r.updated || 0} updated on Meta`, 'success');
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Sync failed', 'error');
    }
  };

  const handleDrop = async (toIdx: number) => {
    if (dragIdx === null || dragIdx === toIdx) return;
    const reordered = [...colls];
    const [moved] = reordered.splice(dragIdx, 1);
    if (!moved) return;
    reordered.splice(toIdx, 0, moved);
    setColls(reordered);
    setDragIdx(null);
    try {
      await reorderCollections(reordered.map((c, i) => ({ id: c.id, sort_order: i })));
      showToast('Order updated', 'success');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Reorder failed', 'error');
      load();
    }
  };

  if (!branches.length) {
    return <div className="card"><div className="cb"><p>No branches yet.</p></div></div>;
  }

  if (!isSpecific) {
    return (
      <div className="card">
        <div className="ch"><h3>📚 Collections</h3></div>
        <div className="cb">
          <p style={{ color: 'var(--dim)', fontSize: '.86rem', marginBottom: '.7rem' }}>
            Select a specific branch to manage its collections.
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
        <div className="ch"><h3>📚 Collections</h3></div>
        <div className="cb">
          <p style={{ color: 'var(--dim)', fontSize: '.86rem' }}>
            &quot;{branch?.name}&quot; has no catalog yet. Create one from the Branches tab first.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>📚 Collections — {branch?.name}</h3>
          <div style={{ display: 'flex', gap: '.4rem' }}>
            <button type="button" className="btn-g btn-sm" onClick={handleAuto}>✨ Auto-Create</button>
            <button type="button" className="btn-g btn-sm" onClick={handleSync}>🔄 Sync to Meta</button>
            <button type="button" className="btn-p btn-sm" onClick={openCreate}>+ Create</button>
          </div>
        </div>
        <div className="cb">
          {loading ? (
            <p style={{ color: 'var(--dim)' }}>Loading…</p>
          ) : !colls.length ? (
            <p style={{ color: 'var(--dim)', fontSize: '.82rem' }}>
              No collections yet. Click <strong>Auto-Create</strong> to generate from product sets,
              or <strong>Create</strong> to add manually.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
              {colls.map((c, idx) => {
                const setCount = c.product_sets?.length || 0;
                const setNames = c.product_sets?.map((s) => s.name).join(', ') || '—';
                const syncBadge = c.synced ? (
                  <span style={{ fontSize: '.65rem', color: 'var(--wa)' }}>🟢 synced</span>
                ) : (
                  <span style={{ fontSize: '.65rem', color: 'var(--gold)' }}>🟡 pending</span>
                );
                return (
                  <div
                    key={c.id}
                    draggable
                    onDragStart={() => setDragIdx(idx)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => handleDrop(idx)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '.6rem',
                      padding: '.55rem .7rem', background: 'var(--ink2,#f4f4f5)', borderRadius: 8,
                      opacity: dragIdx === idx ? 0.4 : 1,
                    }}
                  >
                    <span style={{ cursor: 'grab', color: 'var(--mute,var(--dim))', fontSize: '1rem' }} title="Drag to reorder">⠿</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: '.84rem' }}>{c.name}</div>
                      <div style={{ fontSize: '.7rem', color: 'var(--dim)' }}>
                        {setCount} set{setCount !== 1 ? 's' : ''}: {setNames}
                      </div>
                    </div>
                    {c.is_active === false && <span style={{ fontSize: '.65rem', color: 'var(--mute,var(--dim))' }}>⚪ inactive</span>}
                    {syncBadge}
                    <button type="button" className="btn-g btn-sm" style={{ fontSize: '.72rem' }} onClick={() => openEdit(c)}>✏ Edit</button>
                    {pendingDelete === c.id ? (
                      <>
                        <button type="button" className="btn-del btn-sm" onClick={() => handleDelete(c.id)}>Delete</button>
                        <button type="button" className="btn-g btn-sm" style={{ fontSize: '.72rem' }} onClick={() => setPendingDelete(null)}>Cancel</button>
                      </>
                    ) : (
                      <button type="button" className="btn-g btn-sm" style={{ fontSize: '.72rem', color: '#dc2626' }} onClick={() => setPendingDelete(c.id)}>🗑</button>
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
          onClick={(e: MouseEvent<HTMLDivElement>) => { if (e.target === e.currentTarget) setModalOpen(false); }}
        >
          <div className="card" style={{ maxWidth: 540, width: '100%', background: 'var(--surface,#fff)' }}>
            <div className="ch" style={{ justifyContent: 'space-between' }}>
              <h3>{editingId ? '✏ Edit Collection' : '+ Create Collection'}</h3>
              <button type="button" className="btn-g btn-sm" onClick={() => setModalOpen(false)} disabled={saving}>✕</button>
            </div>
            <div className="cb">
              <div className="fgrid">
                <div className="fg span2">
                  <label>Name *</label>
                  <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="fg span2">
                  <label>Description</label>
                  <textarea
                    value={form.description}
                    onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                    rows={2}
                    style={{ fontFamily: 'inherit' }}
                  />
                </div>
                <div className="fg">
                  <label>Sort order</label>
                  <input type="number" value={form.sortOrder} onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))} />
                </div>
                <div className="fg span2">
                  <label>Cover image URL</label>
                  <input value={form.coverImageUrl} onChange={(e) => setForm((f) => ({ ...f, coverImageUrl: e.target.value }))} placeholder="https://…" />
                </div>
                <div className="fg span2">
                  <label>Product sets</label>
                  {!sets.length ? (
                    <p style={{ fontSize: '.78rem', color: 'var(--dim)' }}>No product sets. Create them in the Product Sets tab first.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '.2rem', maxHeight: 180, overflowY: 'auto' }}>
                      {sets.map((s) => (
                        <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '.4rem', padding: '.25rem 0', fontSize: '.84rem', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={form.productSetIds.includes(s.id)}
                            onChange={() => toggleSet(s.id)}
                          />
                          {s.name} <span style={{ fontSize: '.65rem', color: 'var(--dim)' }}>({s.type})</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
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
