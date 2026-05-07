'use client';

import { useEffect, useState } from 'react';
import MenuEditorSection from '../../../components/restaurant/menu/MenuEditorSection';
import CatalogSyncSection from '../../../components/restaurant/menu/CatalogSyncSection';
import ProductSetsSection from '../../../components/restaurant/menu/ProductSetsSection';
import CollectionsSection from '../../../components/restaurant/menu/CollectionsSection';
import CsvImportSection from '../../../components/restaurant/menu/CsvImportSection';
import ImageManagementSection from '../../../components/restaurant/menu/ImageManagementSection';
import { getBranches } from '../../../api/restaurant';
import { useToast } from '../../../components/Toast';
import type { Branch } from '../../../types';

type SectionKey = 'editor' | 'catalog' | 'sets' | 'collections' | 'import' | 'images';

const SECTIONS: ReadonlyArray<readonly [SectionKey, string]> = [
  ['editor',      '🍽️ Menu Editor'],
  ['catalog',     '🔄 Catalog Sync'],
  ['sets',        '📂 Product Sets'],
  ['collections', '📚 Collections'],
  ['import',      '📥 CSV / XLSX Import'],
  ['images',      '🖼️ Images'],
];

export default function MenuPage() {
  const { showToast } = useToast();
  const [activeSection, setActiveSection] = useState<SectionKey>('editor');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState<boolean>(true);
  const [selectedBranchId, setSelectedBranchId] = useState<string>('__all__');

  const refetchBranches = async () => {
    try {
      const list = await getBranches();
      setBranches(Array.isArray(list) ? list : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      showToast(e?.response?.data?.error || e?.message || 'Failed to load branches', 'error');
    } finally {
      setBranchesLoading(false);
    }
  };

  useEffect(() => {
    refetchBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div className="flex gap-[0.35rem] flex-wrap mb-[1.1rem] py-2 border-b border-rim">
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

      {activeSection === 'editor' && (
        <MenuEditorSection
          branches={branches}
          branchesLoading={branchesLoading}
          selectedBranchId={selectedBranchId}
          setSelectedBranchId={setSelectedBranchId}
          refetchBranches={refetchBranches}
        />
      )}
      {activeSection === 'catalog' && (
        <CatalogSyncSection
          branches={branches}
          selectedBranchId={selectedBranchId}
        />
      )}
      {activeSection === 'sets' && (
        <ProductSetsSection
          branches={branches}
          selectedBranchId={selectedBranchId}
          setSelectedBranchId={setSelectedBranchId}
        />
      )}
      {activeSection === 'collections' && (
        <CollectionsSection
          branches={branches}
          selectedBranchId={selectedBranchId}
          setSelectedBranchId={setSelectedBranchId}
        />
      )}
      {activeSection === 'import' && (
        <CsvImportSection
          branches={branches}
          selectedBranchId={selectedBranchId}
          setSelectedBranchId={setSelectedBranchId}
        />
      )}
      {activeSection === 'images' && <ImageManagementSection />}
    </div>
  );
}
