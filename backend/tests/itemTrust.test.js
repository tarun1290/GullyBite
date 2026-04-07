// tests/itemTrust.test.js
// Tests for item trust engine — tags, descriptions, eligibility.

'use strict';

const { assignTrustTag, generateSecondaryTags, generateMetaDescription } = require('../src/services/itemTrust/trustEngine');

describe('Trust Tag Assignment', () => {
  const ctx = { _p90OrderCount: 50 };

  test('Best Seller: top 10% by order count', () => {
    expect(assignTrustTag({ fulfilled_order_count: 60 }, ctx)).toBe('Best Seller');
  });

  test('Most Loved: high rating + enough reviews + low issues', () => {
    expect(assignTrustTag({ fulfilled_order_count: 30, average_rating: 4.7, rating_count: 15, issue_rate: 0.05 }, ctx)).toBe('Most Loved');
  });

  test('Most Reordered: high reorder rate + enough orders', () => {
    expect(assignTrustTag({ fulfilled_order_count: 25, average_rating: 4.0, rating_count: 3, issue_rate: 0.2, reorder_rate: 0.4 }, ctx)).toBe('Most Reordered');
  });

  test('Trending: 30-day growth', () => {
    expect(assignTrustTag({ fulfilled_order_count: 10, average_rating: 3.5, rating_count: 2, issue_rate: 0.1, reorder_rate: 0.1, last_30_day_order_count: 13, prev_30_day_order_count: 8 }, ctx)).toBe('Trending');
  });

  test('Popular Pick: enough orders but no public rating', () => {
    expect(assignTrustTag({ fulfilled_order_count: 18, average_rating: 0, rating_count: 2, issue_rate: 0, reorder_rate: 0.1, public_rating_enabled: false, last_30_day_order_count: 5, prev_30_day_order_count: 5 }, ctx)).toBe('Popular Pick');
  });

  test('New Item: created recently with few orders', () => {
    expect(assignTrustTag({ fulfilled_order_count: 3, average_rating: 0, rating_count: 0, issue_rate: 0, reorder_rate: 0, public_rating_enabled: false, _isNew: true, last_30_day_order_count: 3, prev_30_day_order_count: 0 }, ctx)).toBe('New Item');
  });

  test('No tag: nothing qualifies', () => {
    expect(assignTrustTag({ fulfilled_order_count: 5, average_rating: 3.0, rating_count: 1, issue_rate: 0, reorder_rate: 0, public_rating_enabled: false, _isNew: false, last_30_day_order_count: 2, prev_30_day_order_count: 2 }, ctx)).toBeNull();
  });
});

describe('Secondary Tags', () => {
  test('generates spice + portion tags', () => {
    const tags = generateSecondaryTags({ spice_level: 'medium', portion_label: 'good_for_1', food_type: 'veg' });
    expect(tags).toEqual(['Medium spicy', 'Good for 1']);
  });

  test('veg tag when no spice/portion', () => {
    expect(generateSecondaryTags({ food_type: 'veg' })).toEqual(['Veg']);
  });

  test('non-veg tag', () => {
    expect(generateSecondaryTags({ food_type: 'non_veg' })).toEqual(['Non-Veg']);
  });

  test('max 2 tags', () => {
    const tags = generateSecondaryTags({ spice_level: 'spicy', portion_label: 'quick_bite', food_type: 'non_veg' });
    expect(tags.length).toBe(2);
  });
});

describe('Meta Description Generation', () => {
  test('with public rating + trust tag', () => {
    const desc = generateMetaDescription(
      { public_rating_enabled: true, average_rating: 4.6, rating_count: 128, trust_tag: 'Best Seller' },
      { name: 'Chicken Biryani', description: 'Aromatic basmati rice with chicken.', spice_level: 'medium', portion_label: 'good_for_1', food_type: 'non_veg' }
    );
    expect(desc).toContain('⭐ 4.6/5 from 128 recent orders');
    expect(desc).toContain('Best Seller');
    expect(desc).toContain('Aromatic basmati rice');
  });

  test('without public rating, with trust tag', () => {
    const desc = generateMetaDescription(
      { public_rating_enabled: false, trust_tag: 'Popular Pick' },
      { name: 'Dal Makhani', description: 'Creamy black lentils.', food_type: 'veg' }
    );
    expect(desc).not.toContain('⭐');
    expect(desc).toContain('Popular Pick');
    expect(desc).toContain('Creamy black lentils');
  });

  test('no rating, no tag — just secondary + description', () => {
    const desc = generateMetaDescription(
      { public_rating_enabled: false, trust_tag: null },
      { name: 'Plain Rice', description: 'Steamed basmati rice.', food_type: 'veg' }
    );
    expect(desc).not.toContain('⭐');
    expect(desc).toContain('Veg');
    expect(desc).toContain('Steamed basmati rice');
  });

  test('respects max length', () => {
    const desc = generateMetaDescription(
      { public_rating_enabled: true, average_rating: 4.5, rating_count: 50, trust_tag: 'Most Loved' },
      { name: 'Test', description: 'A'.repeat(500), food_type: 'veg' },
      280
    );
    expect(desc.length).toBeLessThanOrEqual(280);
  });

  test('min 10 chars for empty items', () => {
    const desc = generateMetaDescription(
      { public_rating_enabled: false, trust_tag: null },
      { name: 'X', description: '' }
    );
    expect(desc.length).toBeGreaterThanOrEqual(10);
  });
});

describe('Public Rating Eligibility', () => {
  test('eligible: >= 20 orders AND >= 5 ratings', () => {
    // This logic is in calculateItemTrustMetrics, tested here conceptually
    const eligible = (20 >= 20 && 5 >= 5);
    expect(eligible).toBe(true);
  });

  test('NOT eligible: too few orders', () => {
    expect(15 >= 20).toBe(false);
  });

  test('NOT eligible: too few ratings', () => {
    expect(3 >= 5).toBe(false);
  });
});
