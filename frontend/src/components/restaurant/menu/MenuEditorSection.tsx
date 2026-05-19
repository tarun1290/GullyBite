'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Toggle from '../../Toggle';
import { useToast } from '../../Toast';
import { useRestaurant } from '../../../contexts/RestaurantContext';
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
      className="inline-flex items-center justify-center w-[14px] h-[14px] border-2 rounded-sm box-border"
      // border colour is per-food-type from FOOD_TYPE_CFG (veg / non_veg /
      // egg / vegan) at runtime — Tailwind can't pre-bake the palette.
      style={{ borderColor: c.color }}
    >
      <span
        className="w-[7px] h-[7px] rounded-full block"
        // Same runtime-palette reason as the parent.
        style={{ background: c.color }}
      />
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
        <span className="inline-flex items-center gap-1 bg-red-50 text-red-600 py-0.5 px-2 rounded-full text-xs font-semibold border border-red-200">
          ❌ Unassigned
        </span>
        <div className="text-xs text-red-600 mt-0.5">Not visible to customers</div>
      </>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 bg-wa-light text-green-700 py-0.5 px-2 rounded-full text-xs font-semibold border border-green-200">
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
  // Restaurant-level profile from the shared RestaurantProvider context
  // (wrapped at DashboardLayoutClient). Already fetched once by the
  // provider — reading it here adds no extra API call.
  const { restaurant } = useRestaurant();
  const [items, setItems] = useState<LooseItem[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [unassignedCount, setUnassignedCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [showAdd, setShowAdd] = useState<boolean>(false);
  // Edit-mode handle: when set, ItemFormModal opens pre-filled with this row.
  // Distinct from `showAdd` so the create path (which targets a branch by id)
  // and the edit path (which targets a single item by id) can't collide.
  const [editingItem, setEditingItem] = useState<MenuItem | null>(null);
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
  const isSpecificBranch = !isAll && !isUnassigned && Boolean(selectedBranchId);
  const currentBranch = isSpecificBranch ? branches.find((b) => b.id === selectedBranchId) : null;
  // A catalog is valid if EITHER the branch has its own catalog OR the
  // restaurant has a restaurant-level catalog (single-type restaurants
  // run a single shared catalog at the restaurant level, so the
  // branch-only check fired the "No catalog" warning incorrectly). The
  // Branch type only carries `catalog_id`; the Restaurant type carries
  // both `meta_catalog_id` and `catalog_id`.
  const hasCatalog = Boolean(
    currentBranch?.catalog_id
    || restaurant?.meta_catalog_id
    || restaurant?.catalog_id
  );

  // Auto-select the only branch for single-type restaurants. The parent
  // defaults selectedBranchId to '__all__'; single-type tenants have one
  // branch and expect to land on it directly. Fires once after branches
  // load (guarded by a ref so a later manual switch back to "All
  // Products" isn't snapped away).
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (branchesLoading) return;
    const firstBranch = branches[0];
    if (!firstBranch) return;
    if (restaurant?.business_type !== 'single') return;
    if (selectedBranchId === '__all__') {
      autoSelectedRef.current = true;
      setSelectedBranchId(firstBranch.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchesLoading, branches, restaurant]);

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
      } else if (isAll) {
        const data = (await getMenuAll()) as MenuAllApi | LooseItem[] | null;
        const groups: MenuGroupApi[] = Array.isArray(data)
          ? (data as unknown as MenuGroupApi[])
          : (data?.groups || []);
        const flat: LooseItem[] = groups.flatMap((g) => (g.items || []).map((it) => ({
          ...it, _categoryName: g.name || 'Uncategorized',
        })));
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

  const showBranchBadge = isAll || isUnassigned;

  interface RenderOpts { isVariantChild?: boolean }

  const renderItemRow = (item: LooseItem, idx: number, opts: RenderOpts = {}): ReactNode => {
    const isVariantChild = Boolean(opts.isVariantChild);
    const variantLabel = item.size || item.variant_value || 'Variant';
    const displayName: ReactNode = isVariantChild
      ? (
        <span className="pl-6 text-acc text-sm font-medium">
          · {variantLabel}
        </span>
      )
      : item.item_group_id
        ? (<>
          {item.name} <span className="text-xs text-acc font-medium">· {variantLabel}</span>
        </>)
        : item.name;
    const pricePaise = item.price_paise || 0;
    const salePaise = item.sale_price_paise || 0;
    const priceCell: ReactNode = salePaise ? (
      <>
        <span className="line-through text-mute text-xs">₹{pricePaise / 100}</span>
        {' '}
        <span className="text-red-500 font-semibold">₹{salePaise / 100}</span>
      </>
    ) : `₹${pricePaise / 100}`;
    return (
      <tr
        key={item.id}
        className={`${idx % 2 ? 'bg-ink4' : ''} ${item.is_available ? 'opacity-100' : 'opacity-[0.55]'}`}
      >
        <td className="py-2 px-1.5 text-center">
          <input
            type="checkbox"
            checked={checked.has(item.id)}
            onChange={() => toggleChecked(item.id)}
          />
        </td>
        <td className="py-2 px-3 text-center text-dim text-sm">
          {isVariantChild ? '' : idx + 1}
        </td>
        <td className="py-2 px-3 text-sm font-medium">
          {displayName}
          {item.is_bestseller && <span className="text-xs text-yellow-500 ml-1">⭐</span>}
          {!item.is_available && <span className="text-xs text-neutral-400 ml-1">(unavailable)</span>}
        </td>
        <td className="py-2 px-3 text-sm text-dim">{item._categoryName || '—'}</td>
        {showBranchBadge && (
          <td className="py-2 px-3 text-sm text-dim">{item.branch_name || '—'}</td>
        )}
        <td className="py-2 px-3">
          {branchStatusCell(item)}
          {item.meta_status === 'incomplete' && (
            <div className="mt-1 inline-flex items-center gap-1 bg-amber-100 text-amber-900 py-0.5 px-2 rounded-full text-xs font-semibold border border-yellow-200">
              ⚠ Incomplete
            </div>
          )}
          {item.meta_status === 'ready' && (
            <div className="mt-1 inline-flex items-center gap-1 bg-blue-100 text-blue-600 py-0.5 px-2 rounded-full text-xs font-semibold border border-[#bfdbfe]">
              ✔ Ready
            </div>
          )}
        </td>
        <td className="py-2 px-3 text-center">{foodTypeIcon(item.food_type)}</td>
        <td className="py-2 px-3 text-right font-medium">{priceCell}</td>
        <td className="py-2 px-3 text-center">
          <Toggle
            checked={Boolean(item.is_available)}
            onChange={(next) => handleToggle(item.id, next, item.name)}
          />
        </td>
        <td className="py-2 px-3 text-center whitespace-nowrap">
          <button
            type="button"
            className="bg-none border border-rim rounded-md py-0.5 px-1.5 cursor-pointer text-base text-dim mr-1"
            onClick={() => setEditingItem(item as MenuItem)}
            title="Edit item"
          >
            ✏️
          </button>
          <button
            type="button"
            className="bg-none border border-rim rounded-md py-0.5 px-1.5 cursor-pointer text-xs text-wa mr-1"
            onClick={() => setAssignFor({ id: item.id, name: item.name })}
            title="Assign to a branch"
          >
            ＋ Branch
          </button>
          {Array.isArray(item.branch_ids) && item.branch_ids.length > 1 && (
            <button
              type="button"
              className="bg-none border border-rim rounded-md py-0.5 px-1.5 cursor-pointer text-xs text-dim mr-1"
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
                className="btn-del btn-sm"
                onClick={() => handleDelete(item.id)}
              >
                Yes
              </button>
              <button
                type="button"
                className="btn-g btn-xs ml-0.5"
                onClick={() => setPendingDeleteId(null)}
              >
                No
              </button>
            </>
          ) : (
            <button
              type="button"
              className="bg-none border-0 cursor-pointer text-base text-neutral-400"
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
        <tr key={`group-${entry._groupId}`} className="bg-green-50 border-t border-rim">
          <td className="py-2 px-1.5 text-center">
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
          <td className="py-2 px-3 text-center">
            <button
              type="button"
              onClick={() => toggleGroupExpanded(entry._groupId)}
              className="bg-none border-0 cursor-pointer text-sm text-dim py-0.5 px-1"
              aria-label={isExpanded ? 'Collapse variants' : 'Expand variants'}
            >
              {isExpanded ? '▼' : '▶'}
            </button>
          </td>
          <td className="py-2 px-3 text-sm font-bold">
            {entry.name}
            <span className="text-xs text-dim font-medium ml-1.5">
              · {entry.variants.length} variant{entry.variants.length === 1 ? '' : 's'}
            </span>
          </td>
          <td className="py-2 px-3 text-sm text-dim">{first._categoryName || '—'}</td>
          {showBranchBadge && (
            <td className="py-2 px-3 text-sm text-dim">{first.branch_name || '—'}</td>
          )}
          <td className="py-2 px-3">{branchStatusCell(first)}</td>
          <td className="py-2 px-3 text-center">{foodTypeIcon(first.food_type)}</td>
          <td className="py-2 px-3 text-right font-semibold">{priceCell}</td>
          <td className="py-2 px-3 text-center">
            <Toggle
              checked={Boolean(first.is_available)}
              onChange={(next) => entry.variants.forEach((v) => handleToggle(v.id, next, v.name))}
            />
          </td>
          <td className="py-2 px-3 text-center whitespace-nowrap">
            <button
              type="button"
              className="bg-none border border-rim rounded-md py-0.5 px-1.5 cursor-pointer text-base text-dim mr-1"
              onClick={() => setEditingItem(first as MenuItem)}
              title="Edit first variant — expand the group to edit other variants individually"
            >
              ✏️
            </button>
            <button
              type="button"
              className="bg-none border border-rim rounded-md py-0.5 px-1.5 cursor-pointer text-xs text-wa mr-1"
              onClick={() => setAssignFor({ id: first.id, name: first.name })}
              title="Assign group's first variant to a branch"
            >
              ＋ Branch
            </button>
            {pendingDeleteId === first.id ? (
              <>
                <button
                  type="button"
                  className="btn-del btn-sm"
                  onClick={() => handleDelete(first.id)}
                >
                  Yes
                </button>
                <button
                  type="button"
                  className="btn-g btn-xs ml-0.5"
                  onClick={() => setPendingDeleteId(null)}
                >
                  No
                </button>
              </>
            ) : (
              <button
                type="button"
                className="bg-none border-0 cursor-pointer text-base text-neutral-400"
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
      <div className="card mb-3 flex flex-wrap gap-2 items-center py-3 px-3.5">
        <label className="text-sm text-dim mr-1">Branch:</label>
        <select
          value={selectedBranchId}
          onChange={(e) => setSelectedBranchId(e.target.value)}
          className="h-9 px-3 rounded-md border border-rim2 text-base min-w-[220px] bg-white text-tx"
          disabled={branchesLoading}
        >
          <option value="__all__">All Products ({totalCount})</option>
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
            className="btn-g btn-xs"
            onClick={handleFixCatalog}
            disabled={fixingCatalog}
          >
            {fixingCatalog ? '🔧 Checking…' : '🔧 Fix Catalog'}
          </button>
        )}

        <div className="flex-1" />

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
        <div className="card mb-3 py-3 px-3.5 bg-amber-50 border-yellow-200">
          <p className="text-sm mb-2 text-amber-900">
            Auto-discovery failed. Paste your Meta Catalog ID (find it in Meta Business Suite → Commerce Manager → your catalog → Settings):
          </p>
          <div className="flex gap-1.5">
            <input
              value={manualCatalogId}
              onChange={(e) => setManualCatalogId(e.target.value)}
              placeholder="numeric catalog id"
              className="flex-1 py-1.5 px-2.5 rounded-md border border-rim text-base"
            />
            <button type="button" className="btn-p btn-sm" onClick={handleManualCatalog}>Save</button>
            <button type="button" className="btn-g btn-sm" onClick={() => { setManualCatalogPrompt(false); setManualCatalogId(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Bulk action bar */}
      {items.length > 0 && (
        <div className="flex gap-2 flex-wrap items-center mb-3 text-sm">
          <span className="text-dim">
            {isAll ? `Showing all ${totalCount} items${unassignedCount ? ` · ${unassignedCount} unassigned` : ''}` :
              isUnassigned ? `${totalCount} unassigned items` :
                totalCount ? `${totalCount} items` : ''}
            {groupedItemCount > 0 ? ` (${groupedItemCount} grouped)` : ''}
          </span>
          <div className="flex-1" />
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
              <span className="text-sm text-amber-600">
                {allClosing ? 'Mark all items unavailable?' : 'Bring all items back online?'}
              </span>
              <button type="button" className="btn-p btn-sm" onClick={handleBulkAvail}>Confirm</button>
              <button type="button" className="btn-g btn-sm" onClick={() => setPendingBulkAvail(null)}>Cancel</button>
            </>
          )}

          {checked.size > 0 && (
            pendingBulkDelete ? (
              <>
                <span className="text-sm text-red-600">Delete {checked.size} item{checked.size > 1 ? 's' : ''}?</span>
                <button type="button" className="btn-del btn-sm" onClick={handleBulkDelete}>Yes, delete</button>
                <button type="button" className="btn-g btn-sm" onClick={() => setPendingBulkDelete(false)}>Cancel</button>
              </>
            ) : (
              <button type="button" className="btn-del" onClick={() => setPendingBulkDelete(true)}>
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
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          {loading ? (
            <div className="p-8 text-center text-dim">Loading…</div>
          ) : !items.length ? (
            <div className="empty p-8 text-center">
              <div className="ei text-3xl">{isUnassigned ? '✅' : '🍽️'}</div>
              <h3 className="mt-1.5">
                {isUnassigned ? 'No unassigned items' : 'No menu items yet'}
              </h3>
              <p className="text-dim text-base">
                {isUnassigned ? 'All items are assigned to branches' : 'Add items using the "+ Add" button above'}
              </p>
            </div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-neutral-50 border-b-2 border-rim">
                  <th className="py-2 px-1.5 text-center w-8">
                    <input
                      type="checkbox"
                      checked={checked.size > 0 && checked.size === items.length}
                      onChange={(e) => toggleAll(e.target.checked)}
                    />
                  </th>
                  <th className="py-2 px-3 text-center text-xs text-dim w-10">#</th>
                  <th className="py-2 px-3 text-left text-xs text-dim">Item Name</th>
                  <th className="py-2 px-3 text-left text-xs text-dim">Category</th>
                  {showBranchBadge && <th className="py-2 px-3 text-left text-xs text-dim">Branch</th>}
                  <th className="py-2 px-3 text-left text-xs text-dim w-[140px]">Branch Status</th>
                  <th className="py-2 px-3 text-center text-xs text-dim w-[60px]">Type</th>
                  <th className="py-2 px-3 text-right text-xs text-dim w-[90px]">Price</th>
                  <th className="py-2 px-3 text-center text-xs text-dim w-[70px]">Status</th>
                  <th className="py-2 px-3 text-center text-xs text-dim w-[130px]">Actions</th>
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
      {editingItem && (
        <ItemFormModal
          // The existing item lives under its own branch (which may differ
          // from the currently-selected one when viewing "All Products").
          // ItemFormModal will fall back to initialItem.branch_id when this
          // is empty.
          branchId={String(editingItem.branch_id || selectedBranchId || '')}
          mode="edit"
          initialItem={editingItem}
          onClose={() => setEditingItem(null)}
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
