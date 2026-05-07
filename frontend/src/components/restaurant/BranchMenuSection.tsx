'use client';

import { useEffect, useState } from 'react';
import { useToast } from '../Toast';
import CategoriesManager from './menu/CategoriesManager';
import {
  getBranchMenu,
  createBranchCatalog,
  syncBranchCatalog,
} from '../../api/restaurant';
import type { Branch } from '../../types';

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
        await load();
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
      <div className="cat-strip py-[0.7rem] px-[0.85rem] bg-ink2 border border-bdr rounded-lg mb-[0.8rem]">
        <div className="flex items-center justify-between gap-[0.6rem] flex-wrap">
          <div className="flex items-center gap-[0.55rem]">
            <span className="cat-ico text-[1.1rem]">
              {branch.catalog_id ? '🟢' : '🟡'}
            </span>
            <div>
              <div className="text-[0.85rem] font-semibold">
                {branch.catalog_id ? 'Catalog Connected' : 'No Catalog Yet'}
              </div>
              {branch.catalog_id ? (
                <div className="text-[0.72rem] text-dim font-mono">
                  {branch.catalog_id}
                </div>
              ) : (
                <div className="text-[0.72rem] text-dim">
                  Create one to start syncing this branch&apos;s menu to WhatsApp.
                </div>
              )}
            </div>
          </div>
          <div className="cat-acts flex gap-[0.4rem]">
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

      <div className="card mt-[0.8rem]">
        <div className="ch justify-between">
          <h4 className="m-0">Menu Items <span className="text-[0.72rem] text-dim">({items.length})</span></h4>
          <span className="text-[0.72rem] text-dim">
            Add/edit items in the Menu tab
          </span>
        </div>
        <div className="cb">
          {loading ? (
            <p className="text-dim text-[0.84rem]">Loading…</p>
          ) : !items.length ? (
            <div className="empty text-center py-4">
              <div className="ei text-[2rem]">🍽️</div>
              <p className="text-[0.82rem] text-dim mt-[0.4rem]">
                No items for this branch yet. Head to the Menu tab to add items or assign existing ones.
              </p>
            </div>
          ) : (
            Object.entries(itemsByCategory).map(([catName, its]) => (
              <div key={catName} className="mb-[0.8rem]">
                <div className="text-[0.78rem] font-semibold text-dim uppercase tracking-[0.5px] mb-[0.3rem]">
                  {catName}
                </div>
                {its.map((it) => (
                  <div
                    key={it.id}
                    className="mi flex items-center gap-[0.6rem] py-[0.35rem] px-[0.6rem] border-b border-bdr text-[0.84rem]"
                  >
                    <span className="mi-name flex-1">{it.name}</span>
                    <span className="mi-price text-dim">
                      ₹{((it.price_paise || 0) / 100).toFixed(0)}
                    </span>
                    <span className={`badge ${it.is_available ? 'bg' : 'br'} text-[0.65rem]`}>
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
