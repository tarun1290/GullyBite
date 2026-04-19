import { useEffect, useState } from 'react';
import MenuEditorSection from '../../components/dashboard/menu/MenuEditorSection.jsx';
import CatalogSyncSection from '../../components/dashboard/menu/CatalogSyncSection.jsx';
import ProductSetsSection from '../../components/dashboard/menu/ProductSetsSection.jsx';
import CollectionsSection from '../../components/dashboard/menu/CollectionsSection.jsx';
import CsvImportSection from '../../components/dashboard/menu/CsvImportSection.jsx';
import ImageManagementSection from '../../components/dashboard/menu/ImageManagementSection.jsx';
import { getBranches } from '../../api/restaurant.js';
import { useToast } from '../../components/Toast.jsx';

// Mirrors the legacy "Menu" tab (dashboard.html:999-1304 + tabs/menu.js).
// Legacy tab dispatch (dashboard.html:2611) fires loadBranches + loadBranchSel
// + loadCatalogStatus + updateSyncStatus on Menu activation; we lift the
// branch fetch here and pass it to each section so they don't each re-fetch.
//
// Sub-sections map to legacy cards (see Phase 2k audit):
//   editor      — #branch-tabs + #menu-list + #m-add-form + #cat-manager-card
//   catalog     — #sync-to-btn + #sync-from-btn + #sync-status-line
//   sets        — #product-sets-card (needs a branch with catalog)
//   collections — #collections-card (needs a branch with catalog)
//   import      — #menu-import-modal (XLSX wizard)
//   images      — #bulk-img-modal + #img-stats-bar
const SECTIONS = [
  ['editor', '🍽️ Menu Editor'],
  ['catalog', '🔄 Catalog Sync'],
  ['sets', '📂 Product Sets'],
  ['collections', '📚 Collections'],
  ['import', '📥 CSV / XLSX Import'],
  ['images', '🖼️ Images'],
];

export default function MenuTab() {
  const { showToast } = useToast();
  const [activeSection, setActiveSection] = useState('editor');
  const [branches, setBranches] = useState([]);
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [selectedBranchId, setSelectedBranchId] = useState('__all__');

  const refetchBranches = async () => {
    try {
      const list = await getBranches();
      setBranches(Array.isArray(list) ? list : []);
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Failed to load branches', 'error');
    } finally {
      setBranchesLoading(false);
    }
  };

  useEffect(() => {
    refetchBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sharedProps = {
    branches,
    branchesLoading,
    selectedBranchId,
    setSelectedBranchId,
    refetchBranches,
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: '.35rem',
          flexWrap: 'wrap',
          marginBottom: '1.1rem',
          padding: '.5rem 0',
          borderBottom: '1px solid var(--rim)',
        }}
      >
        {SECTIONS.map(([v, l]) => (
          <button
            key={v}
            type="button"
            className={activeSection === v ? 'chip on' : 'chip'}
            onClick={() => setActiveSection(v)}
          >
            {l}
          </button>
        ))}
      </div>

      {activeSection === 'editor' && <MenuEditorSection {...sharedProps} />}
      {activeSection === 'catalog' && <CatalogSyncSection {...sharedProps} />}
      {activeSection === 'sets' && <ProductSetsSection {...sharedProps} />}
      {activeSection === 'collections' && <CollectionsSection {...sharedProps} />}
      {activeSection === 'import' && <CsvImportSection {...sharedProps} />}
      {activeSection === 'images' && <ImageManagementSection {...sharedProps} />}
    </div>
  );
}
