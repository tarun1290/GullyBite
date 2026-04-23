import { useEffect, useMemo, useState } from 'react';
import Toggle from '../../../components/Toggle.jsx';
import { useToast } from '../../../components/Toast.jsx';
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
} from '../../../api/restaurant.js';
import CategoriesManager from './CategoriesManager.jsx';
import ItemFormModal from './ItemFormModal.jsx';
import AssignBranchModal from './AssignBranchModal.jsx';
import BranchSuggestionsModal from './BranchSuggestionsModal.jsx';

// Mirrors loadMenu + renderMenuGroups + doToggleItem + doBulkAvailability
// + doDeleteItem + doBulkDelete + doFixCatalog (menu.js:770-1498). The
// window.confirm/prompt fallbacks are rewritten as inline two-click or
// small inline prompts to match the cross-phase "no native dialogs" rule.

function foodTypeIcon(ft) {
  const cfg = {
    veg: { color: '#22C55E', title: 'Veg' },
    non_veg: { color: '#DC2626', title: 'Non-Veg' },
    egg: { color: '#EAB308', title: 'Egg' },
    vegan: { color: '#16A34A', title: 'Vegan' },
  };
  const c = cfg[ft] || { color: '#9CA3AF', title: 'Not set' };
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

function branchStatusCell(item) {
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

export default function MenuEditorSection({
  branches, branchesLoading, selectedBranchId, setSelectedBranchId, refetchBranches,
}) {
  const { showToast } = useToast();
  const [items, setItems] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [unassignedCount, setUnassignedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState(new Set());
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [assignFor, setAssignFor] = useState(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [pendingBulkAvail, setPendingBulkAvail] = useState(null);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [fixingCatalog, setFixingCatalog] = useState(false);
  const [manualCatalogId, setManualCatalogId] = useState('');
  const [manualCatalogPrompt, setManualCatalogPrompt] = useState(false);

  const isAll = selectedBranchId === '__all__';
  const isUnassigned = selectedBranchId === '__unassigned__';
  const isAssignedOnly = selectedBranchId === '__assigned__';
  const isSpecificBranch = !isAll && !isUnassigned && !isAssignedOnly && !!selectedBranchId;
  const currentBranch = isSpecificBranch ? branches.find((b) => b.id === selectedBranchId) : null;
  const hasCatalog = !!currentBranch?.catalog_id;

  const load = async () => {
    if (branchesLoading) return;
    setLoading(true);
    setChecked(new Set());
    try {
      if (isUnassigned) {
        const list = await getMenuUnassigned();
        const arr = Array.isArray(list) ? list : [];
        setItems(arr);
        setTotalCount(arr.length);
        setUnassignedCount(arr.length);
      } else if (isAll || isAssignedOnly) {
        const data = await getMenuAll();
        const groups = data?.groups || data || [];
        let flat = groups.flatMap((g) => (g.items || []).map((it) => ({
          ...it, _categoryName: g.name || 'Uncategorized',
        })));
        if (isAssignedOnly) {
          flat = flat.filter((it) => {
            const ids = Array.isArray(it.branch_ids) ? it.branch_ids : [];
            return it.is_unassigned !== true && (ids.length > 0 || it.branch_id);
          });
        }
        setItems(flat);
        setTotalCount(data?.total_count || flat.length);
        setUnassignedCount(data?.unassigned_count || 0);
      } else if (isSpecificBranch) {
        const groups = await getBranchMenu(selectedBranchId);
        const flat = (groups || []).flatMap((g) => (g.items || []).map((it) => ({
          ...it, _categoryName: g.name || 'Uncategorized',
        })));
        setItems(flat);
        setTotalCount(flat.length);
        setUnassignedCount(0);
      } else {
        setItems([]); setTotalCount(0); setUnassignedCount(0);
      }
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Failed to load menu', 'error');
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
  const groupedDisplay = useMemo(() => {
    const out = [];
    const seen = new Map(); // groupId -> index in `out`
    for (const it of items) {
      const gid = it.item_group_id;
      if (gid) {
        if (seen.has(gid)) {
          out[seen.get(gid)].variants.push(it);
        } else {
          const entry = {
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

  const toggleGroupExpanded = (groupId) => {
    setExpandedGroups((s) => {
      const next = new Set(s);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  };
  const allClosing = availCount > 0;

  const handleToggle = async (id, next, name) => {
    // Optimistic row update
    setItems((list) => list.map((it) => (it.id === id ? { ...it, is_available: next } : it)));
    try {
      await updateItemAvailability(id, next);
      showToast(`"${name}" ${next ? 'back on menu' : 'marked unavailable'} — syncing to WhatsApp...`, 'success');
    } catch (err) {
      setItems((list) => list.map((it) => (it.id === id ? { ...it, is_available: !next } : it)));
      showToast(err?.response?.data?.error || err.message || 'Update failed', 'error');
    }
  };

  const handleApplyAllBranches = async (id, next, name) => {
    try {
      const r = await updateItemAvailabilityAllBranches(id, next);
      showToast(`"${name}" updated at ${r.affected_branches || 0} branch${(r.affected_branches || 0) > 1 ? 'es' : ''} — syncing...`, 'success');
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Update failed', 'error');
    }
  };

  const handleBulkAvail = async () => {
    const targetAvail = !allClosing;
    const branchId = isSpecificBranch ? selectedBranchId : undefined;
    try {
      const r = await bulkUpdateAvailability(branchId
        ? { available: targetAvail, branch_id: branchId }
        : { available: targetAvail });
      showToast(targetAvail
        ? `🟢 ${r.updated_count} items back online — syncing...`
        : `🔴 ${r.updated_count} items marked unavailable — syncing...`, 'success');
      setPendingBulkAvail(null);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Bulk update failed', 'error');
    }
  };

  const handleDelete = async (id) => {
    try {
      await deleteMenuItem(id);
      showToast('Item deleted', 'success');
      setPendingDeleteId(null);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Delete failed', 'error');
    }
  };

  const handleBulkDelete = async () => {
    const ids = [...checked];
    if (!ids.length) return;
    try {
      const r = await bulkDeleteMenuItems(ids);
      showToast(`${r.deleted || ids.length} items deleted`, 'success');
      setChecked(new Set());
      setPendingBulkDelete(false);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Bulk delete failed', 'error');
    }
  };

  const handleFixCatalog = async () => {
    if (!isSpecificBranch) return;
    setFixingCatalog(true);
    try {
      const r = await fixBranchCatalog(selectedBranchId);
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
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Save failed', 'error');
    }
  };

  const toggleChecked = (id) => {
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = (on) => {
    setChecked(on ? new Set(items.map((it) => it.id)) : new Set());
  };

  const showBranchBadge = isAll || isUnassigned || isAssignedOnly;

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
                {(() => {
                  // Shared per-item row renderer. Used both for plain non-grouped
                  // items (existing behavior preserved) and for variant child
                  // rows under an expanded group header. `opts.isVariantChild`
                  // toggles the indented-name + blank-index treatment.
                  const renderItemRow = (item, idx, opts = {}) => {
                    const isVariantChild = !!opts.isVariantChild;
                    const dim = item.is_available ? {} : { opacity: 0.55 };
                    const displayName = isVariantChild
                      ? (
                        <span style={{ paddingLeft: '1.5rem', color: 'var(--acc)', fontSize: '.78rem', fontWeight: 500 }}>
                          · {item.size || item.variant_value || 'Variant'}
                        </span>
                      )
                      : item.item_group_id
                        ? (<>
                          {item.name} <span style={{ fontSize: '.72rem', color: 'var(--acc)', fontWeight: 500 }}>· {item.size || item.variant_value || 'Variant'}</span>
                        </>)
                        : item.name;
                    const priceCell = item.sale_price_paise ? (
                      <>
                        <span style={{ textDecoration: 'line-through', color: 'var(--mute)', fontSize: '.75rem' }}>₹{item.price_paise / 100}</span>
                        {' '}
                        <span style={{ color: '#dc2626', fontWeight: 600 }}>₹{item.sale_price_paise / 100}</span>
                      </>
                    ) : `₹${item.price_paise / 100}`;
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
                            checked={!!item.is_available}
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

                  const rows = [];
                  groupedDisplay.forEach((entry, idx) => {
                    if (!entry._isGroup) {
                      rows.push(renderItemRow(entry, idx));
                      return;
                    }
                    // ── Group header row ──
                    const variantIds = entry.variants.map((v) => v.id);
                    const allChecked = variantIds.length > 0 && variantIds.every((id) => checked.has(id));
                    const isExpanded = expandedGroups.has(entry._groupId);
                    const first = entry.variants[0];
                    const prices = entry.variants.map((v) => v.price_paise || 0);
                    const minP = Math.min(...prices);
                    const maxP = Math.max(...prices);
                    const priceCell = minP === maxP ? `₹${minP / 100}` : `₹${minP / 100} – ₹${maxP / 100}`;
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
                            checked={!!first.is_available}
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
                })()}
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
