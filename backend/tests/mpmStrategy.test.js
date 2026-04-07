// tests/mpmStrategy.test.js
// Tests for the MPM Strategy Engine — config, bestseller selection, batching.

'use strict';

const { MPM_STRATEGY_CONFIG, getStrategyConfig } = require('../src/services/mpmStrategy/config');
const { applyAllFuturePrioritizers } = require('../src/services/mpmStrategy/futurePrioritizers');

describe('MPM Strategy Config', () => {

  test('default config has active features enabled', () => {
    expect(MPM_STRATEGY_CONFIG.enableBestSellers).toBe(true);
    expect(MPM_STRATEGY_CONFIG.enableCategoryAwareBatching).toBe(true);
    expect(MPM_STRATEGY_CONFIG.enableFoodBeverageSplit).toBe(true);
    expect(MPM_STRATEGY_CONFIG.enableCompressedCatalogSource).toBe(true);
  });

  test('default config has future modules disabled', () => {
    expect(MPM_STRATEGY_CONFIG.enableTimeOfDayPrioritization).toBe(false);
    expect(MPM_STRATEGY_CONFIG.enableStockAwareSuppression).toBe(false);
    expect(MPM_STRATEGY_CONFIG.enableOutletBestsellerWeighting).toBe(false);
    expect(MPM_STRATEGY_CONFIG.enableCampaignPriority).toBe(false);
    expect(MPM_STRATEGY_CONFIG.enableSeasonalBoosting).toBe(false);
    expect(MPM_STRATEGY_CONFIG.enableNewLaunchBoost).toBe(false);
    expect(MPM_STRATEGY_CONFIG.enableReorderPriority).toBe(false);
  });

  test('limits are correct', () => {
    expect(MPM_STRATEGY_CONFIG.maxProductsPerMPM).toBe(30);
    expect(MPM_STRATEGY_CONFIG.maxSectionsPerMPM).toBe(10);
    expect(MPM_STRATEGY_CONFIG.minBestsellersForSection).toBe(2);
    expect(MPM_STRATEGY_CONFIG.maxBestsellersInSection).toBe(15);
  });
});

describe('Future Prioritizers (disabled)', () => {

  test('all disabled prioritizers return items unchanged', async () => {
    const items = [
      { name: 'Item A', price_paise: 10000 },
      { name: 'Item B', price_paise: 20000 },
    ];
    const config = { ...MPM_STRATEGY_CONFIG }; // all future modules disabled

    const result = await applyAllFuturePrioritizers(items, config);
    expect(result).toEqual(items);
    expect(result).toHaveLength(2);
  });

  test('disabled modules do not modify item order or count', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      name: `Item ${i}`, price_paise: (i + 1) * 100,
    }));
    const config = { ...MPM_STRATEGY_CONFIG };

    const result = await applyAllFuturePrioritizers(items, config);
    expect(result).toHaveLength(50);
    expect(result[0].name).toBe('Item 0');
    expect(result[49].name).toBe('Item 49');
  });
});

describe('MPM Batching Rules', () => {

  test('maxProductsPerMPM is 30 (Meta limit)', () => {
    expect(MPM_STRATEGY_CONFIG.maxProductsPerMPM).toBe(30);
  });

  test('maxSectionsPerMPM is 10 (Meta limit)', () => {
    expect(MPM_STRATEGY_CONFIG.maxSectionsPerMPM).toBe(10);
  });
});

describe('Exported mpmBuilder helpers', () => {
  const { getCategoryOrder, getCategoryEmoji, isFoodCategory, isDrinkCategory, selectVariantRepresentative } = require('../src/services/mpmBuilder');

  test('getCategoryOrder returns index for known categories', () => {
    expect(getCategoryOrder('your usuals')).toBeLessThan(getCategoryOrder('bestsellers'));
    expect(getCategoryOrder('bestsellers')).toBeLessThan(getCategoryOrder('starters'));
    expect(getCategoryOrder('starters')).toBeLessThan(getCategoryOrder('desserts'));
    expect(getCategoryOrder('unknown')).toBe(999);
  });

  test('getCategoryEmoji returns emoji', () => {
    expect(getCategoryEmoji('bestsellers')).toBe('🔥');
    expect(getCategoryEmoji('pizza')).toBe('🍕');
    expect(getCategoryEmoji('unknown')).toBe('🍴');
  });

  test('food and drink classification', () => {
    expect(isFoodCategory('starters')).toBe(true);
    expect(isFoodCategory('pizza')).toBe(true);
    expect(isDrinkCategory('beverages')).toBe(true);
    expect(isDrinkCategory('desserts')).toBe(true);
    expect(isFoodCategory('beverages')).toBe(false);
  });

  test('selectVariantRepresentative picks cheapest', () => {
    const variants = [
      { name: 'Large', price_paise: 30000 },
      { name: 'Small', price_paise: 15000 },
      { name: 'Medium', price_paise: 22000 },
    ];
    const rep = selectVariantRepresentative(variants);
    expect(rep.name).toBe('Small');
    expect(rep.price_paise).toBe(15000);
  });
});
