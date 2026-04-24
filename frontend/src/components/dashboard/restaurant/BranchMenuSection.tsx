'use client';

import { useEffect, useState } from 'react';
import { useToast } from '../../Toast';
import CategoriesManager from '../menu/CategoriesManager';
import {
  getBranchMenu,
  createBranchCatalog,
  syncBranchCatalog,
} from '../../../api/restaurant';
import type { Branch } from '../../../types';

interface MenuItemRow {
  id: string;
  name?: string;
  category_id?: string;
  category_name?: string;
  price_paise?: number;
  is_available?: boolean;
}

interface CatalogCreateResponse {
  alreadyExists?: boolean;
  success?: boolean;
  error?: string;
}

interface CatalogSyncResponse {
  success?: boolean;
  updated?: number;
  deleted?: number;
  errors?: string[];
}

interface BranchMenuSectionProps {
  branch: Branch;
  onCatalogChange?: () => void;
}

export default function BranchMenuSection({ branch, onCatalogChange }: BranchMenuSectionProps) {
  const { showToast } = useToast();
  const [items, setItems] = useState<MenuItemRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [creating, setCreating] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);

  const load = async () => {
    setLoading(true);
    try {
      const list = (await getBranchMenu(branch.id)) as MenuItemRow[] | null;
      setItems(Array.isArray(list) ? list : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load menu', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch.id]);

  const handleCreateCatalog = async () => {
    setCreating(true);
    try {
      const r = (await createBranchCatalog(branch.id)) as CatalogCreateResponse | null;
      if (r?.alreadyExists) {
        showToast('Catalog already exists for this branch', 'info');
      } else if (r?.success) {
        showToast(`✅ Catalog ready for ${branch.name}!`, 'success');
      } else {
        showToast(r?.error || 'Catalog creation returned no success flag', 'error');
      }
      if (onCatalogChange) onCatalogChange();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Catalog creation failed', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleSyncCatalog = async () => {
    setSyncing(true);
    try {
      const r = (await syncBranchCatalog(branch.id)) as CatalogSyncResponse | null;
      if (r?.success) {
        showToast(`✅ ${branch.name}: ${r.updated || 0} live, ${r.deleted || 0} removed`, 'success');
      } else {
        showToast(r?.errors?.[0] || 'Sync failed', 'error');
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Sync failed', 'error');
    } finally {
      setSyncing(false);
    }
  };

  const itemsByCategory = items.reduce<Record<string, MenuItemRow[]>>((acc, it) => {
    const key = it.category_name || it.category_id || 'Uncategorized';
    if (!acc[key]) acc[key] = [];
    acc[key].push(it);
    return acc;
  }, {});

  return (
    <div>
      <div
        className="cat-strip"
        style={{
          padding: '.7rem .85rem',
          background: 'var(--ink2,#f4f4f5)',
          border: '1px solid var(--bdr,#e5e7eb)',
          borderRadius: 8,
          marginBottom: '.8rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.6rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.55rem' }}>
            <span className="cat-ico" style={{ fontSize: '1.1rem' }}>
              {branch.catalog_id ? '🟢' : '🟡'}
            </span>
            <div>
              <div style={{ fontSize: '.85rem', fontWeight: 600 }}>
                {branch.catalog_id ? 'Catalog Connected' : 'No Catalog Yet'}
              </div>
              {branch.catalog_id ? (
                <div style={{ fontSize: '.72rem', color: 'var(--dim)', fontFamily: 'monospace' }}>
                  {branch.catalog_id}
                </div>
              ) : (
                <div style={{ fontSize: '.72rem', color: 'var(--dim)' }}>
                  Create one to start syncing this branch&apos;s menu to WhatsApp.
                </div>
              )}
            </div>
          </div>
          <div className="cat-acts" style={{ display: 'flex', gap: '.4rem' }}>
            {!branch.catalog_id && (
              <button
                type="button"
                className="btn-p btn-sm"
                onClick={handleCreateCatalog}
                disabled={creating}
              >
                {creating ? 'Creating…' : '✨ Create Catalog'}
              </button>
            )}
            {branch.catalog_id && (
              <button
                type="button"
                className="btn-g btn-sm"
                onClick={handleSyncCatalog}
                disabled={syncing}
              >
                {syncing ? 'Syncing…' : '🔄 Sync to Meta'}
              </button>
            )}
          </div>
        </div>
      </div>

      <CategoriesManager branchId={branch.id} />

      <div className="card" style={{ marginTop: '.8rem' }}>
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h4 style={{ margin: 0 }}>Menu Items <span style={{ fontSize: '.72rem', color: 'var(--dim)' }}>({items.length})</span></h4>
          <span style={{ fontSize: '.72rem', color: 'var(--dim)' }}>
            Add/edit items in the Menu tab
          </span>
        </div>
        <div className="cb">
          {loading ? (
            <p style={{ color: 'var(--dim)', fontSize: '.84rem' }}>Loading…</p>
          ) : !items.length ? (
            <div className="empty" style={{ textAlign: 'center', padding: '1rem 0' }}>
              <div className="ei" style={{ fontSize: '2rem' }}>🍽️</div>
              <p style={{ fontSize: '.82rem', color: 'var(--dim)', marginTop: '.4rem' }}>
                No items for this branch yet. Head to the Menu tab to add items or assign existing ones.
              </p>
            </div>
          ) : (
            Object.entries(itemsByCategory).map(([catName, its]) => (
              <div key={catName} style={{ marginBottom: '.8rem' }}>
                <div
                  style={{
                    fontSize: '.78rem', fontWeight: 600, color: 'var(--dim)',
                    textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: '.3rem',
                  }}
                >
                  {catName}
                </div>
                {its.map((it) => (
                  <div
                    key={it.id}
                    className="mi"
                    style={{
                      display: 'flex', alignItems: 'center', gap: '.6rem',
                      padding: '.35rem .6rem', borderBottom: '1px solid var(--bdr,#e5e7eb)',
                      fontSize: '.84rem',
                    }}
                  >
                    <span className="mi-name" style={{ flex: 1 }}>{it.name}</span>
                    <span className="mi-price" style={{ color: 'var(--dim)' }}>
                      ₹{((it.price_paise || 0) / 100).toFixed(0)}
                    </span>
                    <span
                      className={`badge ${it.is_available ? 'bg' : 'br'}`}
                      style={{ fontSize: '.65rem' }}
                    >
                      {it.is_available ? 'On' : 'Off'}
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
