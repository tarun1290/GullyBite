// tests/reorderIntelligence.test.js
// Tests for the Reorder Intelligence Layer — config, scoring, future modules.

'use strict';

const { REORDER_CONFIG, getReorderConfig } = require('../src/services/reorderIntelligence/config');
const { applyAllFutureReorderModules } = require('../src/services/reorderIntelligence/reorderEngine');

describe('Reorder Intelligence Config', () => {

  test('active features enabled by default', () => {
    expect(REORDER_CONFIG.enableBasicReorderIntelligence).toBe(true);
    expect(REORDER_CONFIG.enableYourUsualsGroup).toBe(true);
  });

  test('future modules disabled by default', () => {
    expect(REORDER_CONFIG.enableTimeOfDayReorder).toBe(false);
    expect(REORDER_CONFIG.enableDayOfWeekReorder).toBe(false);
    expect(REORDER_CONFIG.enableComboAffinity).toBe(false);
    expect(REORDER_CONFIG.enableBeveragePairing).toBe(false);
    expect(REORDER_CONFIG.enableReactivationNudges).toBe(false);
    expect(REORDER_CONFIG.enableRoutineMealPatterns).toBe(false);
  });

  test('sensible defaults', () => {
    expect(REORDER_CONFIG.maxReorderCandidates).toBe(12);
    expect(REORDER_CONFIG.minOrdersForReorder).toBe(1);
    expect(REORDER_CONFIG.reorderHistoryDays).toBe(90);
    expect(REORDER_CONFIG.minReorderScore).toBe(10);
  });
});

describe('Future Reorder Modules (disabled)', () => {

  test('disabled modules return candidates unchanged', async () => {
    const candidates = [
      { name: 'Butter Chicken', _reorderScore: 80 },
      { name: 'Dal Makhani', _reorderScore: 60 },
    ];
    const config = { ...REORDER_CONFIG }; // all future disabled

    const result = await applyAllFutureReorderModules(candidates, config);
    expect(result).toEqual(candidates);
    expect(result).toHaveLength(2);
  });

  test('disabled modules preserve order', async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      name: `Item ${i}`, _reorderScore: 100 - i,
    }));
    const config = { ...REORDER_CONFIG };

    const result = await applyAllFutureReorderModules(candidates, config);
    expect(result[0].name).toBe('Item 0');
    expect(result[9].name).toBe('Item 9');
  });
});

describe('MPM Category Order (Your Usuals)', () => {
  const { getCategoryOrder, getCategoryEmoji, isFoodCategory } = require('../src/services/mpmBuilder');

  test('Your Usuals sorts before Bestsellers', () => {
    expect(getCategoryOrder('your usuals')).toBeLessThan(getCategoryOrder('bestsellers'));
  });

  test('Your Usuals has emoji', () => {
    expect(getCategoryEmoji('your usuals')).toBe('⭐');
  });

  test('Your Usuals classified as food category', () => {
    expect(isFoodCategory('your usuals')).toBe(true);
  });
});
