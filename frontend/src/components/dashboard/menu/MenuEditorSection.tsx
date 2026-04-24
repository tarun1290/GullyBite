'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Toggle from '../../Toggle';
import { useToast } from '../../Toast';
import {
  getMenuAll,
  getMenuUnassigned,
  getBranchMenu,
  updateItemAvailability,
  updateItemAvailabilityAllBranches,
  bulkUpdateAvailability,
  deleteMenuItem,
  bulkDeleteMenuItems,
  fixBranchCatalog,
  patchBranch,
} from '../../../api/restaurant';
import CategoriesManager from './CategoriesManager';
import ItemFormModal from './ItemFormModal';
import AssignBranchModal from './AssignBranchModal';
import BranchSuggestionsModal from './BranchSuggestionsModal';
import type { Branch, FoodType, MenuItem } from '../../../types';

// Mirrors loadMenu + renderMenuGroups + doToggleItem + doBulkAvailability
// + doDeleteItem + doBulkDelete + doFixCatalog (menu.js:770-1498). The
// window.confirm/prompt fallbacks are rewritten as inline two-click or
// small inline prompts to match the cross-phase "no native dialogs" rule.

interface FoodTypeCfg { color: string; title: string }
const FOOD_TYPE_CFG: Record<string, FoodTypeCfg> = {
  veg:     { color: '#22C55E', title: 'Veg' },
  non_veg: { color: '#DC2626', title: 'Non-Veg' },
  egg:     { color: '#EAB308', title: 'Egg' },
  vegan:   { color: '#16A34A', title: 'Vegan' },
};

function foodTypeIcon(ft?: FoodType | string) {
  const c = FOOD_TYPE_CFG[String(ft || '')] || { color: '#9CA3AF', title: 'Not set' };
  return (
    <span
      title={c.title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 14, height: 14, border: `2px solid ${c.color}`, borderRadius: 2, boxSizing: 'border-box',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: c.color, display: 'block' }} />
    </span>
  );
}

type LooseItem = MenuItem & {
  _categoryName?: string;
  branch_ids?: string[];
  branch_name?: string;
  is_unassigned?: boolean;
  is_available?: boolean;
  is_bestseller?: boolean;
  meta_status?: string;
  sale_price_paise?: number;
};

interface MenuGroupApi {
  name?: string;
  items?: LooseItem[];
}

interface MenuAllApi {
  groups?: MenuGroupApi[];
  total_count?: number;
  unassigned_count?: number;
}

interface FixCatalogResult { catalogId?: string }

interface BulkAvailResult { updated_count?: number }

interface BulkDeleteResult { deleted?: number }

interface AffectResult { affected_branches?: number }

type GroupEntry = {
  _isGroup: true;
  _groupId: string;
  id: string;
  name: string;
  variants: LooseItem[];
};

type DisplayEntry = LooseItem | GroupEntry;

function isGroup(e: DisplayEntry): e is GroupEntry {
  return (e as GroupEntry)._isGroup === true;
}

function branchStatusCell(item: LooseItem): ReactNode {
  const ids = Array.isArray(item.branch_ids) ? item.branch_ids : [];
  const legacy = item.branch_id ? 1 : 0;
  const count = ids.length || legacy;
  const unassigned = item.is_unassigned === true || count === 0;
  if (unassigned) {
    return (
      <>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: '.3rem',
          background: '#fef2f2', color: '#b91c1c', padding: '.15rem .55rem',
          borderRadius: 99, fontSize: '.7rem', fontWeight: 600, border: '1px solid #fecaca',
        }}
        >
          ❌ Unassigned
        </span>
        <div style={{ fontSize: '.65rem', color: '#b91c1c', marginTop: '.15rem' }}>Not visible to customers</div>
      </>
    );
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '.3rem',
      background: '#dcfce7', color: '#15803d', padding: '.15rem .55rem',
      borderRadius: 99, fontSize: '.7rem', fontWeight: 600, border: '1px solid #bbf7d0',
    }}
    >
      ✅ {count} Branch{count !== 1 ? 'es' : ''}
    </span>
  );
}

interface MenuEditorSectionProps {
  branches: Branch[];
  branchesLoading: boolean;
  selectedBranchId: string;
  setSelectedBranchId: (id: string) => void;
  refetchBranches: () => void | Promise<void>;
}

export default function MenuEditorSection({
  branches, branchesLoading, selectedBranchId, setSelectedBranchId, refetchBranches,
}: MenuEditorSectionProps) {
  const { showToast } = useToast();
  const [items, setItems] = useState<LooseItem[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [unassignedCount, setUnassignedCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [showAdd, setShowAdd] = useState<boolean>(false);
  const [assignFor, setAssignFor] = useState<{ id: string; name: string } | null>(null);
  const [showSuggestions, setShowSuggestions] = useState<boolean>(false);
  const [pendingBulkAvail, setPendingBulkAvail] = useState<'open' | 'close' | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState<boolean>(false);
  const [fixingCatalog, setFixingCatalog] = useState<boolean>(false);
  const [manualCatalogId, setManualCatalogId] = useState<string>('');
  const [manualCatalogPrompt, setManualCatalogPrompt] = useState<boolean>(false);

  const isAll = selectedBranchId === '__all__';
  const isUnassigned = selectedBranchId === '__unassigned__';
  const isAssignedOnly = selectedBranchId === '__assigned__';
  const isSpecificBranch = !isAll && !isUnassigned && !isAssignedOnly && Boolean(selectedBranchId);
  const currentBranch = isSpecificBranch ? branches.find((b) => b.id === selectedBranchId) : null;
  const hasCatalog = Boolean(currentBranch?.catalog_id);

  const load = async () => {
    if (branchesLoading) return;
    setLoading(true);
    setChecked(new Set());
    try {
      if (isUnassigned) {
        const list = (await getMenuUnassigned()) as LooseItem[] | null;
        const arr = Array.isArray(list) ? list : [];
        setItems(arr);
        setTotalCount(arr.length);
        setUnassignedCount(arr.length);
      } else if (isAll || isAssignedOnly) {
        const data = (await getMenuAll()) as MenuAllApi | LooseItem[] | null;
        const groups: MenuGroupApi[] = Array.isArray(data)
          ? (data as unknown as MenuGroupApi[])
          : (data?.groups || []);
        let flat: LooseItem[] = groups.flatMap((g) => (g.items || []).map((it) => ({
          ...it, _categoryName: g.name || 'Uncategorized',
        })));
        if (isAssignedOnly) {
          flat = flat.filter((it) => {
            const ids = Array.isArray(it.branch_ids) ? it.branch_ids : [];
            return it.is_unassigned !== true && (ids.length > 0 || it.branch_id);
          });
        }
        setItems(flat);
        const total = !Array.isArray(data) ? data?.total_count : undefined;
        setTotalCount(total ?? flat.length);
        const ucount = !Array.isArray(data) ? data?.unassigned_count : undefined;
        setUnassignedCount(ucount ?? 0);
      } else if (isSpecificBranch) {
        const groups = (await getBranchMenu(selectedBranchId)) as MenuGroupApi[] | null;
        const flat: LooseItem[] = (groups || []).flatMap((g) => (g.items || []).map((it) => ({
          ...it, _categoryName: g.name || 'Uncategorized',
        })));
        setItems(flat);
        setTotalCount(flat.length);
        setUnassignedCount(0);
      } else {
        setItems([]); setTotalCount(0); setUnassignedCount(0);
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load menu', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    setExpandedGroups(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBranchId, branchesLoading]);

  const availCount = useMemo(() => items.filter((i) => i.is_available).length, [items]);

  // Collapse the flat items array into groups by item_group_id. Items without
  // a group ID stay as plain entries. Group entries carry _isGroup + _groupId
  // + variants[] so the renderer can branch on the marker. Order is preserved
  // — the first variant of a group decides where the header appears.
  const groupedDisplay = useMemo<DisplayEntry[]>(() => {
    const out: DisplayEntry[] = [];
    const seen = new Map<string, number>();
    for (const it of items) {
      const gid = it.item_group_id;
      if (gid) {
        const existingIdx = seen.get(gid);
        if (existingIdx !== undefined) {
          const entry = out[existingIdx];
          if (entry && isGroup(entry)) entry.variants.push(it);
        } else {
          const entry: GroupEntry = {
            _isGroup: true,
            _groupId: gid,
            id: gid,
            name: it.name,
            variants: [it],
          };
          seen.set(gid, out.length);
          out.push(entry);
        }
      } else {
        out.push(it);
      }
    }
    return out;
  }, [items]);

  const groupedItemCount = useMemo(
    () => items.filter((i) => i.item_group_id).length,
    [items],
  );

  const toggleGroupExpanded = (groupId: string) => {
    setExpandedGroups((s) => {
      const next = new Set(s);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  };
  const allClosing = availCount > 0;

  const handleToggle = async (id: string, next: boolean, name: string) => {
    // Optimistic row update
    setItems((list) => list.map((it) => (it.id === id ? { ...it, is_available: next } : it)));
    try {
      await updateItemAvailability(id, next);
      showToast(`"${name}" ${next ? 'back on menu' : 'marked unavailable'} — syncing to WhatsApp...`, 'success');
    } catch (err: unknown) {
      setItems((list) => list.map((it) => (it.id === id ? { ...it, is_available: !next } : it)));
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Update failed', 'error');
    }
  };

  const handleApplyAllBranches = async (id: string, next: boolean, name: string) => {
    try {
      const r = (await updateItemAvailabilityAllBranches(id, next)) as AffectResult;
      const n = r.affected_branches || 0;
      showToast(`"${name}" updated at ${n} branch${n > 1 ? 'es' : ''} — syncing...`, 'success');
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Update failed', 'error');
    }
  };

  const handleBulkAvail = async () => {
    const targetAvail = !allClosing;
    const branchId = isSpecificBranch ? selectedBranchId : undefined;
    try {
      const r = (await bulkUpdateAvailability(branchId
        ? { available: targetAvail, branch_id: branchId }
        : { available: targetAvail })) as BulkAvailResult;
      showToast(targetAvail
        ? `🟢 ${r.updated_count} items back online — syncing...`
        : `🔴 ${r.updated_count} items marked unavailable — syncing...`, 'success');
      setPendingBulkAvail(null);
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Bulk update failed', 'error');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteMenuItem(id);
      showToast('Item deleted', 'success');
      setPendingDeleteId(null);
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Delete failed', 'error');
    }
  };

  const handleBulkDelete = async () => {
    const ids = [...checked];
    if (!ids.length) return;
    try {
      const r = (await bulkDeleteMenuItems(ids)) as BulkDeleteResult;
      showToast(`${r.deleted || ids.length} items deleted`, 'success');
      setChecked(new Set());
      setPendingBulkDelete(false);
      load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Bulk delete failed', 'error');
    }
  };

  const handleFixCatalog = async () => {
    if (!isSpecificBranch) return;
    setFixingCatalog(true);
    try {
      const r = (await fixBranchCatalog(selectedBranchId)) as FixCatalogResult | null;
      if (r?.catalogId) {
        showToast(`✅ Catalog fixed! ID: ${r.catalogId}`, 'success');
        refetchBranches();
      } else {
        setManualCatalogPrompt(true);
      }
    } catch {
      setManualCatalogPrompt(true);
    } finally {
      setFixingCatalog(false);
    }
  };

  const handleManualCatalog = async () => {
    const v = manualCatalogId.trim();
    if (!v) return;
    try {
      await patchBranch(selectedBranchId, { catalogId: v });
      showToast('✅ Catalog ID saved', 'success');
      setManualCatalogPrompt(false);
      setManualCatalogId('');
      refetchBranches();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Save failed', 'error');
    }
  };

  const toggleChecked = (id: string) => {
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = (on: boolean) => {
    setChecked(on ? new Set(items.map((it) => it.id)) : new Set());
  };

  const showBranchBadge = isAll || isUnassigned || isAssignedOnly;

  interface RenderOpts { isVariantChild?: boolean }

  const renderItemRow = (item: LooseItem, idx: number, opts: RenderOpts = {}): ReactNode => {
    const isVariantChild = Boolean(opts.isVariantChild);
    const dim = item.is_available ? {} : { opacity: 0.55 };
    const variantLabel = item.size || item.variant_value || 'Variant';
    const displayName: ReactNode = isVariantChild
      ? (
        <span style={{ paddingLeft: '1.5rem', color: 'var(--acc)', fontSize: '.78rem', fontWeight: 500 }}>
          · {variantLabel}
        </span>
      )
      : item.item_group_id
        ? (<>
          {item.name} <span style={{ fontSize: '.72rem', color: 'var(--acc)', fontWeight: 500 }}>· {variantLabel}</span>
        </>)
        : item.name;
    const pricePaise = item.price_paise || 0;
    const salePaise = item.sale_price_paise || 0;
    const priceCell: ReactNode = salePaise ? (
      <>
        <span style={{ textDecoration: 'line-through', color: 'var(--mute)', fontSize: '.75rem' }}>₹{pricePaise / 100}</span>
        {' '}
        <span style={{ color: '#dc2626', fontWeight: 600 }}>₹{salePaise / 100}</span>
      </>
    ) : `₹${pricePaise / 100}`;
    return (
      <tr key={item.id} style={{ background: idx % 2 ? 'var(--ink4,#f9fafb)' : '', ...dim }}>
        <td style={{ padding: '.45rem .4rem', textAlign: 'center' }}>
          <input
            type="checkbox"
            checked={checked.has(item.id)}
            onChange={() => toggleChecked(item.id)}
          />
        </td>
        <td style={{ padding: '.45rem .7rem', textAlign: 'center', color: 'var(--dim)', fontSize: '.78rem' }}>
          {isVariantChild ? '' : idx + 1}
        </td>
        <td style={{ padding: '.45rem .7rem', fontSize: '.82rem', fontWeight: 500 }}>
          {displayName}
          {item.is_bestseller && <span style={{ fontSize: '.6rem', color: '#f59e0b', marginLeft: '.25rem' }}>⭐</span>}
          {!item.is_available && <span style={{ fontSize: '.65rem', color: '#9ca3af', marginLeft: '.25rem' }}>(unavailable)</span>}
        </td>
        <td style={{ padding: '.45rem .7rem', fontSize: '.78rem', color: 'var(--dim)' }}>{item._categoryName || '—'}</td>
        {showBranchBadge && (
          <td style={{ padding: '.45rem .7rem', fontSize: '.78rem', color: 'var(--dim)' }}>{item.branch_name || '—'}</td>
        )}
        <td style={{ padding: '.45rem .7rem' }}>
          {branchStatusCell(item)}
          {item.meta_status === 'incomplete' && (
            <div style={{
              marginTop: '.2rem', display: 'inline-flex', alignItems: 'center', gap: '.25rem',
              background: '#fef3c7', color: '#92400e', padding: '.1rem .45rem',
              borderRadius: 99, fontSize: '.65rem', fontWeight: 600, border: '1px solid #fde68a',
            }}
            >
              ⚠ Incomplete
            </div>
          )}
          {item.meta_status === 'ready' && (
            <div style={{
              marginTop: '.2rem', display: 'inline-flex', alignItems: 'center', gap: '.25rem',
              background: '#dbeafe', color: '#1d4ed8', padding: '.1rem .45rem',
              borderRadius: 99, fontSize: '.65rem', fontWeight: 600, border: '1px solid #bfdbfe',
            }}
            >
              ✔ Ready
            </div>
          )}
        </td>
        <td style={{ padding: '.45rem .7rem', textAlign: 'center' }}>{foodTypeIcon(item.food_type)}</td>
        <td style={{ padding: '.45rem .7rem', textAlign: 'right', fontWeight: 500 }}>{priceCell}</td>
        <td style={{ padding: '.45rem .7rem', textAlign: 'center' }}>
          <Toggle
            checked={Boolean(item.is_available)}
            onChange={(next) => handleToggle(item.id, next, item.name)}
          />
        </td>
        <td style={{ padding: '.45rem .7rem', textAlign: 'center', whiteSpace: 'nowrap' }}>
          <button
            type="button"
            style={{
              background: 'none', border: '1px solid var(--rim,#e5e7eb)', borderRadius: 6,
              padding: '.18rem .42rem', cursor: 'pointer', fontSize: '.7rem',
              color: 'var(--wa)', marginRight: '.25rem',
            }}
            onClick={() => setAssignFor({ id: item.id, name: item.name })}
            title="Assign to a branch"
          >
            ＋ Branch
          </button>
          {Array.isArray(item.branch_ids) && item.branch_ids.length > 1 && (
            <button
              type="button"
              style={{
                background: 'none', border: '1px solid var(--rim,#e5e7eb)', borderRadius: 6,
                padding: '.18rem .42rem', cursor: 'pointer', fontSize: '.7rem',
                color: 'var(--dim)', marginRight: '.25rem',
              }}
              onClick={() => handleApplyAllBranches(item.id, !item.is_available, item.name)}
              title="Apply toggle to all branches"
            >
              All
            </button>
          )}
          {pendingDeleteId === item.id ? (
            <>
              <button
                type="button"
                className="btn-sm"
                style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, padding: '.2rem .5rem', fontSize: '.7rem' }}
                onClick={() => handleDelete(item.id)}
              >
                Yes
              </button>
              <button
                type="button"
                className="btn-g btn-sm"
                style={{ marginLeft: '.15rem', fontSize: '.7rem', padding: '.2rem .4rem' }}
                onClick={() => setPendingDeleteId(null)}
              >
                No
              </button>
            </>
          ) : (
            <button
              type="button"
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.85rem', color: '#9ca3af' }}
              onClick={() => setPendingDeleteId(item.id)}
              title="Delete"
            >
              🗑️
            </button>
          )}
        </td>
      </tr>
    );
  };

  const tableRows = (() => {
    const rows: ReactNode[] = [];
    groupedDisplay.forEach((entry, idx) => {
      if (!isGroup(entry)) {
        rows.push(renderItemRow(entry, idx));
        return;
      }
      // ── Group header row ──
      const variantIds = entry.variants.map((v) => v.id);
      const allChecked = variantIds.length > 0 && variantIds.every((id) => checked.has(id));
      const isExpanded = expandedGroups.has(entry._groupId);
      const first = entry.variants[0];
      if (!first) return;
      const prices = entry.variants.map((v) => v.price_paise || 0);
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);
      const priceCell: ReactNode = minP === maxP ? `₹${minP / 100}` : `₹${minP / 100} – ₹${maxP / 100}`;
      rows.push(
        <tr key={`group-${entry._groupId}`} style={{ background: '#f0fdf4', borderTop: '1px solid var(--rim,#e5e7eb)' }}>
          <td style={{ padding: '.45rem .4rem', textAlign: 'center' }}>
            <input
              type="checkbox"
              checked={allChecked}
              onChange={() => {
                setChecked((s) => {
                  const next = new Set(s);
                  if (allChecked) variantIds.forEach((id) => next.delete(id));
                  else variantIds.forEach((id) => next.add(id));
                  return next;
                });
              }}
            />
          </td>
          <td style={{ padding: '.45rem .7rem', textAlign: 'center' }}>
            <button
              type="button"
              onClick={() => toggleGroupExpanded(entry._groupId)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: '.78rem', color: 'var(--dim)', padding: '.1rem .25rem',
              }}
              aria-label={isExpanded ? 'Collapse variants' : 'Expand variants'}
            >
              {isExpanded ? '▼' : '▶'}
            </button>
          </td>
          <td style={{ padding: '.45rem .7rem', fontSize: '.84rem', fontWeight: 700 }}>
            {entry.name}
            <span style={{ fontSize: '.7rem', color: 'var(--dim)', fontWeight: 500, marginLeft: '.4rem' }}>
              · {entry.variants.length} variant{entry.variants.length === 1 ? '' : 's'}
            </span>
          </td>
          <td style={{ padding: '.45rem .7rem', fontSize: '.78rem', color: 'var(--dim)' }}>{first._categoryName || '—'}</td>
          {showBranchBadge && (
            <td style={{ padding: '.45rem .7rem', fontSize: '.78rem', color: 'var(--dim)' }}>{first.branch_name || '—'}</td>
          )}
          <td style={{ padding: '.45rem .7rem' }}>{branchStatusCell(first)}</td>
          <td style={{ padding: '.45rem .7rem', textAlign: 'center' }}>{foodTypeIcon(first.food_type)}</td>
          <td style={{ padding: '.45rem .7rem', textAlign: 'right', fontWeight: 600 }}>{priceCell}</td>
          <td style={{ padding: '.45rem .7rem', textAlign: 'center' }}>
            <Toggle
              checked={Boolean(first.is_available)}
              onChange={(next) => entry.variants.forEach((v) => handleToggle(v.id, next, v.name))}
            />
          </td>
          <td style={{ padding: '.45rem .7rem', textAlign: 'center', whiteSpace: 'nowrap' }}>
            <button
              type="button"
              style={{
                background: 'none', border: '1px solid var(--rim,#e5e7eb)', borderRadius: 6,
                padding: '.18rem .42rem', cursor: 'pointer', fontSize: '.7rem',
                color: 'var(--wa)', marginRight: '.25rem',
              }}
              onClick={() => setAssignFor({ id: first.id, name: first.name })}
              title="Assign group's first variant to a branch"
            >
              ＋ Branch
            </button>
            {pendingDeleteId === first.id ? (
              <>
                <button
                  type="button"
                  className="btn-sm"
                  style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, padding: '.2rem .5rem', fontSize: '.7rem' }}
                  onClick={() => handleDelete(first.id)}
                >
                  Yes
                </button>
                <button
                  type="button"
                  className="btn-g btn-sm"
                  style={{ marginLeft: '.15rem', fontSize: '.7rem', padding: '.2rem .4rem' }}
                  onClick={() => setPendingDeleteId(null)}
                >
                  No
                </button>
              </>
            ) : (
              <button
                type="button"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.85rem', color: '#9ca3af' }}
                onClick={() => setPendingDeleteId(first.id)}
                title="Delete first variant"
              >
                🗑️
              </button>
            )}
          </td>
        </tr>
      );
      if (isExpanded) {
        entry.variants.forEach((v, vi) => {
          rows.push(renderItemRow(v, idx + vi + 1, { isVariantChild: true }));
        });
      }
    });
    return rows;
  })();

  return (
    <div>
      {/* Branch selector */}
      <div
        className="card"
        style={{
          marginBottom: '.8rem', display: 'flex', flexWrap: 'wrap',
          gap: '.5rem', alignItems: 'center', padding: '.7rem .9rem',
        }}
      >
        <label style={{ fontSize: '.82rem', color: 'var(--dim)', marginRight: '.3rem' }}>Branch:</label>
        <select
          value={selectedBranchId}
          onChange={(e) => setSelectedBranchId(e.target.value)}
          style={{ padding: '.4rem .6rem', borderRadius: 7, border: '1px solid var(--rim)', fontSize: '.85rem' }}
          disabled={branchesLoading}
        >
          <option value="__all__">All Products ({totalCount})</option>
          <option value="__assigned__">✅ Assigned only</option>
          <option value="__unassigned__">
            {unassignedCount ? `⚠️ Unassigned (${unassignedCount})` : '⚠️ Unassigned'}
          </option>
          <option disabled>──────────</option>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>

        {isSpecificBranch && (
          hasCatalog ? (
            <span className="badge bg">✅ Catalog Live</span>
          ) : (
            <span className="badge ba">⚠️ No catalog — create in Branches tab</span>
          )
        )}
        {isSpecificBranch && hasCatalog && (
          <button
            type="button"
            className="btn-g btn-sm"
            style={{ fontSize: '.7rem' }}
            onClick={handleFixCatalog}
            disabled={fixingCatalog}
          >
            {fixingCatalog ? '🔧 Checking…' : '🔧 Fix Catalog'}
          </button>
        )}

        <div style={{ flex: 1 }} />

        <button
          type="button"
          className="btn-g btn-sm"
          onClick={() => setShowSuggestions(true)}
          title="See suggested branch assignments"
        >
          🪄 Branch Suggestions
        </button>
        <button
          type="button"
          className="btn-p btn-sm"
          onClick={() => setShowAdd(true)}
          disabled={!isSpecificBranch}
          title={isSpecificBranch ? 'Add a new item to this branch' : 'Select a specific branch to add items'}
        >
          + Add Item
        </button>
      </div>

      {/* Manual catalog ID prompt (replaces window.prompt) */}
      {manualCatalogPrompt && (
        <div
          className="card"
          style={{ marginBottom: '.8rem', padding: '.7rem .9rem', background: '#fffbeb', borderColor: '#fde68a' }}
        >
          <p style={{ fontSize: '.82rem', marginBottom: '.5rem', color: '#92400e' }}>
            Auto-discovery failed. Paste your Meta Catalog ID (find it in Meta Business Suite → Commerce Manager → your catalog → Settings):
          </p>
          <div style={{ display: 'flex', gap: '.4rem' }}>
            <input
              value={manualCatalogId}
              onChange={(e) => setManualCatalogId(e.target.value)}
              placeholder="numeric catalog id"
              style={{ flex: 1, padding: '.4rem .6rem', borderRadius: 6, border: '1px solid var(--rim)', fontSize: '.85rem' }}
            />
            <button type="button" className="btn-p btn-sm" onClick={handleManualCatalog}>Save</button>
            <button type="button" className="btn-g btn-sm" onClick={() => { setManualCatalogPrompt(false); setManualCatalogId(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Bulk action bar */}
      {items.length > 0 && (
        <div
          style={{
            display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center',
            marginBottom: '.7rem', fontSize: '.82rem',
          }}
        >
          <span style={{ color: 'var(--dim)' }}>
            {isAll ? `Showing all ${totalCount} items${unassignedCount ? ` · ${unassignedCount} unassigned` : ''}` :
              isUnassigned ? `${totalCount} unassigned items` :
                totalCount ? `${totalCount} items` : ''}
            {groupedItemCount > 0 ? ` (${groupedItemCount} grouped)` : ''}
          </span>
          <div style={{ flex: 1 }} />
          {pendingBulkAvail === null ? (
            <button
              type="button"
              className="btn-g btn-sm"
              onClick={() => setPendingBulkAvail(allClosing ? 'close' : 'open')}
            >
              {allClosing ? '🔴 Close Menu' : '🟢 Reopen Menu'}
            </button>
          ) : (
            <>
              <span style={{ fontSize: '.78rem', color: '#b45309' }}>
                {allClosing ? 'Mark all items unavailable?' : 'Bring all items back online?'}
              </span>
              <button type="button" className="btn-sm" style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, padding: '.3rem .7rem', fontSize: '.78rem' }} onClick={handleBulkAvail}>Confirm</button>
              <button type="button" className="btn-g btn-sm" onClick={() => setPendingBulkAvail(null)}>Cancel</button>
            </>
          )}

          {checked.size > 0 && (
            pendingBulkDelete ? (
              <>
                <span style={{ fontSize: '.78rem', color: '#b91c1c' }}>Delete {checked.size} item{checked.size > 1 ? 's' : ''}?</span>
                <button type="button" className="btn-sm" style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, padding: '.3rem .7rem', fontSize: '.78rem' }} onClick={handleBulkDelete}>Yes, delete</button>
                <button type="button" className="btn-g btn-sm" onClick={() => setPendingBulkDelete(false)}>Cancel</button>
              </>
            ) : (
              <button type="button" className="btn-g btn-sm" style={{ color: '#dc2626' }} onClick={() => setPendingBulkDelete(true)}>
                🗑 Delete {checked.size}
              </button>
            )
          )}
        </div>
      )}

      {/* Categories manager (specific branch only) */}
      {isSpecificBranch && (
        <CategoriesManager branchId={selectedBranchId} onChange={load} />
      )}

      {/* Items table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--dim)' }}>Loading…</div>
          ) : !items.length ? (
            <div className="empty" style={{ padding: '2rem', textAlign: 'center' }}>
              <div className="ei" style={{ fontSize: '2rem' }}>{isUnassigned ? '✅' : '🍽️'}</div>
              <h3 style={{ marginTop: '.4rem' }}>
                {isUnassigned ? 'No unassigned items' : 'No menu items yet'}
              </h3>
              <p style={{ color: 'var(--dim)', fontSize: '.85rem' }}>
                {isUnassigned ? 'All items are assigned to branches' : 'Add items using the "+ Add" button above'}
              </p>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.84rem' }}>
              <thead>
                <tr style={{ background: '#f9fafb', borderBottom: '2px solid var(--rim,#e5e7eb)' }}>
                  <th style={{ padding: '.55rem .4rem', textAlign: 'center', width: 32 }}>
                    <input
                      type="checkbox"
                      checked={checked.size > 0 && checked.size === items.length}
                      onChange={(e) => toggleAll(e.target.checked)}
                    />
                  </th>
                  <th style={{ padding: '.55rem .7rem', textAlign: 'center', fontSize: '.77rem', color: 'var(--dim)', width: 40 }}>#</th>
                  <th style={{ padding: '.55rem .7rem', textAlign: 'left', fontSize: '.77rem', color: 'var(--dim)' }}>Item Name</th>
                  <th style={{ padding: '.55rem .7rem', textAlign: 'left', fontSize: '.77rem', color: 'var(--dim)' }}>Category</th>
                  {showBranchBadge && <th style={{ padding: '.55rem .7rem', textAlign: 'left', fontSize: '.77rem', color: 'var(--dim)' }}>Branch</th>}
                  <th style={{ padding: '.55rem .7rem', textAlign: 'left', fontSize: '.77rem', color: 'var(--dim)', width: 140 }}>Branch Status</th>
                  <th style={{ padding: '.55rem .7rem', textAlign: 'center', fontSize: '.77rem', color: 'var(--dim)', width: 60 }}>Type</th>
                  <th style={{ padding: '.55rem .7rem', textAlign: 'right', fontSize: '.77rem', color: 'var(--dim)', width: 90 }}>Price</th>
                  <th style={{ padding: '.55rem .7rem', textAlign: 'center', fontSize: '.77rem', color: 'var(--dim)', width: 70 }}>Status</th>
                  <th style={{ padding: '.55rem .7rem', textAlign: 'center', fontSize: '.77rem', color: 'var(--dim)', width: 130 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tableRows}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showAdd && isSpecificBranch && (
        <ItemFormModal
          branchId={selectedBranchId}
          onClose={() => setShowAdd(false)}
          onSaved={load}
        />
      )}
      {assignFor && (
        <AssignBranchModal
          productId={assignFor.id}
          productName={assignFor.name}
          branches={branches}
          onClose={() => setAssignFor(null)}
          onSaved={load}
        />
      )}
      {showSuggestions && (
        <BranchSuggestionsModal
          branches={branches}
          menuItems={items}
          onClose={() => setShowSuggestions(false)}
          onApplied={load}
        />
      )}
    </div>
  );
}
