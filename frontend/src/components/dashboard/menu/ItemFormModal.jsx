import { useEffect, useRef, useState } from 'react';
import { useToast } from '../../../components/Toast.jsx';
import {
  getBranchCategories,
  createBranchCategory,
  createBranchMenuItem,
  uploadMenuImage,
} from '../../../api/restaurant.js';

// Mirrors #m-add-form + doAddItem() in menu.js:1182-1268. Modal-style panel
// rendered inline inside the editor when the user clicks "+ Add item".
// Implements: food-type select, category dropdown w/ inline create, optional
// variants (Size/Portion/Pack/Custom presets, each emits its own POST with a
// shared itemGroupId), image upload via uploadMenuImage, advanced Meta fields.
const VARIANT_PRESETS = {
  Size: ['Small', 'Medium', 'Large'],
  Portion: ['Half', 'Full'],
  Pack: ['Single', 'Family', 'Party Pack'],
  Custom: ['Option 1', 'Option 2'],
};

const FOOD_TYPES = [
  ['veg', '🟢 Veg'],
  ['non_veg', '🔴 Non-Veg'],
  ['egg', '🟡 Egg'],
  ['vegan', '🌱 Vegan'],
];

export default function ItemFormModal({ branchId, onClose, onSaved }) {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [price, setPrice] = useState('');
  const [foodType, setFoodType] = useState('veg');
  const [categoryId, setCategoryId] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [categories, setCategories] = useState([]);
  const [hasVariants, setHasVariants] = useState(false);
  const [variantType, setVariantType] = useState('Size');
  const [variants, setVariants] = useState([{ name: 'Small', price: '' }]);
  const [imageUrl, setImageUrl] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const [imageS3Key, setImageS3Key] = useState('');
  const [imgBusy, setImgBusy] = useState(false);
  const [showAdv, setShowAdv] = useState(false);
  const [advGroupId, setAdvGroupId] = useState('');
  const [advSize, setAdvSize] = useState('');
  const [advSalePrice, setAdvSalePrice] = useState('');
  const [advStock, setAdvStock] = useState('');
  const [advTags, setAdvTags] = useState('');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!branchId) return;
    getBranchCategories(branchId).then((list) => {
      setCategories(Array.isArray(list) ? list : []);
    }).catch(() => {});
  }, [branchId]);

  const handleVariantTypeChange = (t) => {
    setVariantType(t);
    const preset = VARIANT_PRESETS[t] || ['Option 1'];
    setVariants(preset.map((n) => ({ name: n, price: '' })));
  };

  const handleVariantAdd = () => setVariants((v) => [...v, { name: '', price: '' }]);
  const handleVariantChange = (i, field, value) => {
    setVariants((v) => v.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)));
  };
  const handleVariantRemove = (i) => setVariants((v) => v.filter((_, idx) => idx !== i));

  const handleImgFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImgBusy(true);
    try {
      const data = await uploadMenuImage(file);
      setImageUrl(data.url || '');
      setThumbnailUrl(data.thumbnail_url || '');
      setImageS3Key(data.s3_key || '');
      showToast('Image uploaded!', 'success');
    } catch (err) {
      showToast(err.message || 'Upload failed', 'error');
    } finally {
      setImgBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleSave = async () => {
    if (!name.trim()) return showToast('Item name is required', 'error');

    let resolvedCat = categoryId;
    if (categoryId === '__new__') {
      const newName = newCategoryName.trim();
      if (!newName) return showToast('Enter a category name', 'error');
      try {
        const cat = await createBranchCategory(branchId, newName);
        resolvedCat = cat.id;
      } catch (err) {
        return showToast(err?.response?.data?.error || err.message || 'Failed to create category', 'error');
      }
    }

    const common = {
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
      if (hasVariants) {
        const rows = variants
          .map((v) => ({ name: (v.name || '').trim(), price: parseFloat(v.price) }))
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
    } catch (err) {
      showToast(err?.response?.data?.error || err.message || 'Failed to add item', 'error');
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
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="card"
        style={{ maxWidth: 680, width: '100%', background: 'var(--surface,#fff)' }}
      >
        <div className="ch" style={{ justifyContent: 'space-between' }}>
          <h3>➕ Add Menu Item</h3>
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
              <select value={foodType} onChange={(e) => setFoodType(e.target.value)}>
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
                This item has size/portion variants
              </label>
            </div>

            {!hasVariants ? (
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
                  disabled={imgBusy || !branchId}
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
            <button type="button" className="btn-p" onClick={handleSave} disabled={saving || !branchId}>
              {saving ? 'Adding…' : 'Add Item'}
            </button>
            <button type="button" className="btn-g" onClick={onClose} disabled={saving}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
