'use client';

import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent } from 'react';
import { useToast } from '../../Toast';
import {
  getBranchCategories,
  createBranchCategory,
  createBranchMenuItem,
  updateMenuItem,
  uploadMenuImage,
} from '../../../api/restaurant';
import type { FoodType, MenuItem } from '../../../types';

const VARIANT_PRESETS: Record<string, string[]> = {
  Size: ['Small', 'Medium', 'Large'],
  Portion: ['Half', 'Full'],
  Pack: ['Single', 'Family', 'Party Pack'],
  Custom: ['Option 1', 'Option 2'],
};

const FOOD_TYPES: ReadonlyArray<readonly [FoodType, string]> = [
  ['veg', '🟢 Veg'],
  ['non_veg', '🔴 Non-Veg'],
  ['egg', '🟡 Egg'],
  ['vegan', '🌱 Vegan'],
];

interface Category {
  id: string;
  name: string;
}

interface VariantRow {
  name: string;
  price: number | string;
}

interface ImageUploadResult {
  url?: string;
  thumbnail_url?: string;
  s3_key?: string;
}

// `mode === 'edit'` re-uses the same form to PATCH an existing menu_item via
// PUT /api/restaurant/menu/:id. The data model has one document per variant
// (rows in the table sharing item_group_id), so edit mode operates on a
// SINGLE document — the multi-variant insert path used by create is
// suppressed. To convert a non-variant item into part of a group, the user
// can fill in `variantType` + `variantValue` (and optionally `itemGroupId`
// in the advanced section) on the row.
type ModalMode = 'create' | 'edit';

interface ItemFormModalProps {
  // Branch context for the form. In create mode this is the target branch
  // for the new item; in edit mode it's the branch the existing item lives
  // under (used to populate the category dropdown). Optional in edit mode
  // because `initialItem.branch_id` is the source of truth there — pass an
  // empty string and the modal will fall back to the item's own branch_id.
  branchId: string;
  mode?: ModalMode;
  initialItem?: MenuItem;
  onClose: () => void;
  onSaved?: () => void;
}

// Convert an api-shaped MenuItem (snake_case, paise) into the form's internal
// state. Only used in edit mode; pulled out so the field-mapping is in one
// place. Anything not represented in the form gracefully maps to '' / [] /
// false so the user can still save without re-entering everything.
interface InitialFormState {
  name: string;
  desc: string;
  price: string;
  foodType: FoodType;
  categoryId: string;
  imageUrl: string;
  thumbnailUrl: string;
  imageS3Key: string;
  hasVariantFields: boolean;
  variantType: string;
  variantValue: string;
  advGroupId: string;
  advSize: string;
  advSalePrice: string;
  advStock: string;
  advTags: string;
}

function deriveInitialState(item: MenuItem | undefined): InitialFormState {
  if (!item) {
    return {
      name: '', desc: '', price: '', foodType: 'veg', categoryId: '',
      imageUrl: '', thumbnailUrl: '', imageS3Key: '',
      hasVariantFields: false, variantType: 'Size', variantValue: '',
      advGroupId: '', advSize: '', advSalePrice: '', advStock: '', advTags: '',
    };
  }
  const pricePaise = typeof item.price_paise === 'number' ? item.price_paise : 0;
  const priceRs = pricePaise > 0 ? String(pricePaise / 100) : (item.price_rs != null ? String(item.price_rs) : '');
  // sale_price_rs may be derived; sale_price_paise is what the table reads,
  // so check both. Kept blank if zero/absent to avoid spuriously sending
  // salePriceRs=0 on save.
  const salePaise = typeof item.sale_price_paise === 'number' ? (item.sale_price_paise as number) : 0;
  const saleRs = salePaise > 0 ? String(salePaise / 100) : (item.sale_price_rs != null ? String(item.sale_price_rs) : '');
  const stockField = typeof item.quantity_to_sell_on_facebook === 'number'
    ? String(item.quantity_to_sell_on_facebook) : '';
  const tags = Array.isArray(item.product_tags) ? item.product_tags.join(', ') : '';
  const variantType = item.variant_type ? String(item.variant_type) : 'Size';
  const variantValue = item.variant_value ? String(item.variant_value) : '';
  return {
    name: item.name || '',
    desc: item.description || '',
    price: priceRs,
    foodType: (item.food_type as FoodType) || 'veg',
    categoryId: item.category_id ? String(item.category_id) : '',
    imageUrl: item.image_url || '',
    thumbnailUrl: item.thumbnail_url || '',
    imageS3Key: item.image_s3_key || '',
    hasVariantFields: Boolean(item.variant_type || item.variant_value || item.item_group_id),
    variantType,
    variantValue,
    advGroupId: item.item_group_id ? String(item.item_group_id) : '',
    advSize: item.size ? String(item.size) : '',
    advSalePrice: saleRs,
    advStock: stockField,
    advTags: tags,
  };
}

export default function ItemFormModal({
  branchId,
  mode = 'create',
  initialItem,
  onClose,
  onSaved,
}: ItemFormModalProps) {
  const { showToast } = useToast();
  const isEdit = mode === 'edit' && !!initialItem;
  const seed = isEdit ? deriveInitialState(initialItem) : deriveInitialState(undefined);
  // The branch the form targets for category lookup. In edit mode we prefer
  // the item's own branch_id over any branch passed in by the caller — the
  // table sometimes opens edit from the "All Products" view where the
  // selected branch is a sentinel like '__all__' rather than a real id.
  const formBranchId = isEdit
    ? String((initialItem?.branch_id as string | undefined) || branchId || '')
    : branchId;

  const [name, setName] = useState<string>(seed.name);
  const [desc, setDesc] = useState<string>(seed.desc);
  const [price, setPrice] = useState<string>(seed.price);
  const [foodType, setFoodType] = useState<FoodType>(seed.foodType);
  const [categoryId, setCategoryId] = useState<string>(seed.categoryId);
  const [newCategoryName, setNewCategoryName] = useState<string>('');
  const [categories, setCategories] = useState<Category[]>([]);
  // In create mode this drives the multi-variant insert path. In edit mode
  // it instead reveals two simple fields (variantType + variantValue) that
  // are written straight onto the single document being edited — no
  // multi-row insertion. Renamed conceptually but kept as-is to minimise
  // diff scope.
  const [hasVariants, setHasVariants] = useState<boolean>(isEdit ? seed.hasVariantFields : false);
  const [variantType, setVariantType] = useState<string>(seed.variantType);
  const [variants, setVariants] = useState<VariantRow[]>([{ name: 'Small', price: '' }]);
  // Edit-mode-only: the variant_value of the single doc being edited (e.g.
  // "Small", "Family Pack"). Unused in create mode — the create flow
  // reads variant labels from the multi-row variants[] above instead.
  const [editVariantValue, setEditVariantValue] = useState<string>(seed.variantValue);
  const [imageUrl, setImageUrl] = useState<string>(seed.imageUrl);
  const [thumbnailUrl, setThumbnailUrl] = useState<string>(seed.thumbnailUrl);
  const [imageS3Key, setImageS3Key] = useState<string>(seed.imageS3Key);
  const [imgBusy, setImgBusy] = useState<boolean>(false);
  const [showAdv, setShowAdv] = useState<boolean>(false);
  const [advGroupId, setAdvGroupId] = useState<string>(seed.advGroupId);
  const [advSize, setAdvSize] = useState<string>(seed.advSize);
  const [advSalePrice, setAdvSalePrice] = useState<string>(seed.advSalePrice);
  const [advStock, setAdvStock] = useState<string>(seed.advStock);
  const [advTags, setAdvTags] = useState<string>(seed.advTags);
  const [saving, setSaving] = useState<boolean>(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!formBranchId) return;
    getBranchCategories(formBranchId).then((list) => {
      setCategories(Array.isArray(list) ? (list as Category[]) : []);
    }).catch(() => {});
  }, [formBranchId]);

  const handleVariantTypeChange = (t: string) => {
    setVariantType(t);
    const preset = VARIANT_PRESETS[t] || ['Option 1'];
    setVariants(preset.map((n) => ({ name: n, price: '' })));
  };

  const handleVariantAdd = () => setVariants((v) => [...v, { name: '', price: '' }]);
  const handleVariantChange = (i: number, field: 'name' | 'price', value: string) => {
    setVariants((v) => v.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)));
  };
  const handleVariantRemove = (i: number) => setVariants((v) => v.filter((_, idx) => idx !== i));

  const handleImgFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImgBusy(true);
    try {
      const data = (await uploadMenuImage(file)) as ImageUploadResult;
      setImageUrl(data.url || '');
      setThumbnailUrl(data.thumbnail_url || '');
      setImageS3Key(data.s3_key || '');
      showToast('Image uploaded!', 'success');
    } catch (err: unknown) {
      const e2 = err as { message?: string };
      showToast(e2?.message || 'Upload failed', 'error');
    } finally {
      setImgBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleSave = async () => {
    if (!name.trim()) return showToast('Item name is required', 'error');

    let resolvedCat: string | null = categoryId || null;
    if (categoryId === '__new__') {
      const newName = newCategoryName.trim();
      if (!newName) return showToast('Enter a category name', 'error');
      // Need a real branch id to create a category against; fall back to
      // the form's resolved branch (which prefers initialItem.branch_id in
      // edit mode).
      const targetBranch = formBranchId;
      if (!targetBranch) return showToast('Cannot create a category without a branch context', 'error');
      try {
        const cat = (await createBranchCategory(targetBranch, newName)) as Category;
        resolvedCat = cat.id;
      } catch (err: unknown) {
        const e = err as { response?: { data?: { error?: string } }; message?: string };
        return showToast(e?.response?.data?.error || e?.message || 'Failed to create category', 'error');
      }
    }

    const common: Record<string, unknown> = {
      description: desc,
      foodType,
      categoryId: resolvedCat || null,
      imageUrl,
      ...(thumbnailUrl && { thumbnailUrl }),
      ...(imageS3Key && { imageS3Key }),
      ...(advGroupId.trim() && { itemGroupId: advGroupId.trim() }),
      ...(advSize.trim() && { size: advSize.trim() }),
      ...(advSalePrice && { salePriceRs: parseFloat(advSalePrice) }),
      ...(advStock && { quantityToSellOnFacebook: parseInt(advStock, 10) }),
      ...(advTags.trim() && { productTags: advTags.split(',').map((t) => t.trim()).filter(Boolean) }),
    };

    setSaving(true);
    try {
      if (isEdit && initialItem) {
        // Edit mode: PATCH a single document. The variants UI is hidden in
        // edit mode (each row is one doc), so we send variantType/Value
        // straight from the simple inline fields. Empty strings are sent
        // to clear the field — the backend translates them to `null`.
        if (!price) { setSaving(false); return showToast('Price is required', 'error'); }
        const body: Record<string, unknown> = {
          ...common,
          name: name.trim(),
          priceRs: parseFloat(price),
        };
        if (hasVariants) {
          body.variantType = variantType || '';
          body.variantValue = editVariantValue.trim();
        } else {
          // User unchecked the variant fields — explicitly clear them so
          // the row is converted back to a non-variant item.
          body.variantType = '';
          body.variantValue = '';
        }
        await updateMenuItem(initialItem.id, body);
        showToast(`Item updated — syncing to WhatsApp...`, 'success');
        if (onSaved) onSaved();
        if (onClose) onClose();
        return;
      }

      // Create mode (existing behaviour, unchanged below this line).
      if (hasVariants) {
        const rows = variants
          .map((v) => ({ name: (v.name || '').trim(), price: parseFloat(String(v.price)) }))
          .filter((v) => v.name && !Number.isNaN(v.price) && v.price > 0);
        if (!rows.length) {
          setSaving(false);
          return showToast('Add at least one variant with a name and price', 'error');
        }
        const groupId = `GRP-${Date.now()}`;
        for (const v of rows) {
          // eslint-disable-next-line no-await-in-loop
          await createBranchMenuItem(branchId, {
            ...common,
            name: name.trim(),
            priceRs: v.price,
            itemGroupId: groupId,
            variantType,
            variantValue: v.name,
          });
        }
        showToast(`"${name}" added with ${rows.length} variants! Click Sync to push.`, 'success');
      } else {
        if (!price) { setSaving(false); return showToast('Price is required', 'error'); }
        await createBranchMenuItem(branchId, {
          ...common,
          name: name.trim(),
          priceRs: parseFloat(price),
        });
        showToast(`"${name}" added! Click Sync to push to WhatsApp.`, 'success');
      }
      if (onSaved) onSaved();
      if (onClose) onClose();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      const fallback = isEdit ? 'Failed to update item' : 'Failed to add item';
      showToast(e?.response?.data?.error || e?.message || fallback, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 100,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '2rem 1rem', overflowY: 'auto',
      }}
      onClick={(e: MouseEvent<HTMLDivElement>) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="card"
        style={{ maxWidth: 680, width: '100%', background: 'var(--surface,#fff)' }}
      >
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>{isEdit ? '✏️ Edit Menu Item' : '➕ Add Menu Item'}</h3>
          <button type="button" className="btn-g btn-sm" onClick={onClose} disabled={saving}>✕</button>
        </div>
        <div className="cb">
          <div className="fgrid">
            <div className="fg span2">
              <label>Item Name *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Paneer Butter Masala" />
            </div>
            <div className="fg span2">
              <label>Description</label>
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                rows={2}
                placeholder="Optional short description"
                style={{ fontFamily: 'inherit' }}
              />
            </div>
            <div className="fg">
              <label>Food Type</label>
              <select value={foodType} onChange={(e) => setFoodType(e.target.value as FoodType)}>
                {FOOD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="fg">
              <label>Category</label>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">No category</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                <option value="__new__">+ New category…</option>
              </select>
            </div>
            {categoryId === '__new__' && (
              <div className="fg span2">
                <input
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  placeholder="New category name"
                />
              </div>
            )}

            <div className="fg span2">
              <label style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                <input
                  type="checkbox"
                  checked={hasVariants}
                  onChange={(e) => setHasVariants(e.target.checked)}
                />
                {isEdit ? 'This item is a size/portion variant' : 'This item has size/portion variants'}
              </label>
            </div>

            {/* Edit mode: always show the price field for the single doc; the
                variant block (when ticked) only adds variantType + variantValue.
                Create mode keeps the original behavior — multi-row variants
                replace the single price field. */}
            {isEdit ? (
              <>
                <div className="fg">
                  <label>Price (₹) *</label>
                  <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" />
                </div>
                {hasVariants && (
                  <>
                    <div className="fg">
                      <label>Variant Type</label>
                      <select value={variantType} onChange={(e) => setVariantType(e.target.value)}>
                        {Object.keys(VARIANT_PRESETS).map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div className="fg span2">
                      <label>Variant Value (e.g. Small, Family Pack)</label>
                      <input
                        value={editVariantValue}
                        onChange={(e) => setEditVariantValue(e.target.value)}
                        placeholder="Small"
                      />
                    </div>
                  </>
                )}
              </>
            ) : !hasVariants ? (
              <div className="fg">
                <label>Price (₹) *</label>
                <input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" />
              </div>
            ) : (
              <div className="fg span2">
                <label>Variant Type</label>
                <select value={variantType} onChange={(e) => handleVariantTypeChange(e.target.value)}>
                  {Object.keys(VARIANT_PRESETS).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <div style={{ marginTop: '.6rem', display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
                  {variants.map((v, i) => (
                    <div key={i} style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
                      <input
                        value={v.name}
                        onChange={(e) => handleVariantChange(i, 'name', e.target.value)}
                        placeholder="Variant name"
                        style={{ flex: 1.4, padding: '.42rem .6rem', border: '1px solid var(--rim)', borderRadius: 7, fontSize: '.84rem' }}
                      />
                      <input
                        type="number"
                        value={v.price}
                        onChange={(e) => handleVariantChange(i, 'price', e.target.value)}
                        placeholder="Price ₹"
                        style={{ flex: 1, padding: '.42rem .6rem', border: '1px solid var(--rim)', borderRadius: 7, fontSize: '.84rem' }}
                      />
                      <button
                        type="button"
                        onClick={() => handleVariantRemove(i)}
                        style={{ background: 'none', border: 'none', color: '#dc2626', fontSize: '1.1rem', cursor: 'pointer' }}
                        title="Remove"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button type="button" className="btn-g btn-sm" onClick={handleVariantAdd} style={{ alignSelf: 'flex-start' }}>+ Add variant</button>
                </div>
              </div>
            )}

            <div className="fg span2">
              <label>Image</label>
              <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
                {imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageUrl}
                    alt=""
                    style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 7, border: '1px solid var(--rim)' }}
                  />
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  onChange={handleImgFile}
                  disabled={imgBusy || !formBranchId}
                />
                {imgBusy && <span style={{ fontSize: '.78rem', color: 'var(--dim)' }}>Uploading…</span>}
              </div>
              <input
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="Or paste image URL"
                style={{ marginTop: '.4rem' }}
              />
            </div>
          </div>

          <div style={{ marginTop: '.9rem' }}>
            <button
              type="button"
              className="btn-g btn-sm"
              onClick={() => setShowAdv((v) => !v)}
            >
              {showAdv ? '▲ Hide advanced' : '▼ Advanced Meta fields'}
            </button>
          </div>

          {showAdv && (
            <div className="fgrid" style={{ marginTop: '.7rem' }}>
              <div className="fg">
                <label>Item Group ID</label>
                <input value={advGroupId} onChange={(e) => setAdvGroupId(e.target.value)} placeholder="GRP-…" />
              </div>
              <div className="fg">
                <label>Size</label>
                <input value={advSize} onChange={(e) => setAdvSize(e.target.value)} />
              </div>
              <div className="fg">
                <label>Sale Price (₹)</label>
                <input type="number" value={advSalePrice} onChange={(e) => setAdvSalePrice(e.target.value)} />
              </div>
              <div className="fg">
                <label>Stock (FB qty)</label>
                <input type="number" value={advStock} onChange={(e) => setAdvStock(e.target.value)} />
              </div>
              <div className="fg span2">
                <label>Tags (comma-separated)</label>
                <input value={advTags} onChange={(e) => setAdvTags(e.target.value)} placeholder="spicy, popular, chef-special" />
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: '.5rem', marginTop: '1rem' }}>
            <button type="button" className="btn-p" onClick={handleSave} disabled={saving || !formBranchId}>
              {saving ? (isEdit ? 'Saving…' : 'Adding…') : (isEdit ? 'Save Changes' : 'Add Item')}
            </button>
            <button type="button" className="btn-g" onClick={onClose} disabled={saving}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
