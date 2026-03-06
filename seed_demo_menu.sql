-- ==================================================================
-- GullyBite — Demo Menu Seed Data
-- "Spice Route Kitchen" — full Indian restaurant menu
-- Covers: 6 categories · 30+ items · 9 variant groups
--
-- HOW TO USE:
--   1. Open Supabase Dashboard → SQL Editor
--   2. Copy your Branch UUID from:
--      Dashboard → Branches tab → click branch → copy the UUID from URL
--   3. Replace YOUR_BRANCH_ID_HERE below with that UUID
--   4. Paste the whole script and click Run
-- ==================================================================

DO $$
DECLARE
  -- ❗ REPLACE THIS with your actual branch UUID
  v_branch UUID := 'YOUR_BRANCH_ID_HERE';

  -- Category IDs (auto-generated)
  c_starters   UUID := uuid_generate_v4();
  c_mains      UUID := uuid_generate_v4();
  c_biryani    UUID := uuid_generate_v4();
  c_breads     UUID := uuid_generate_v4();
  c_desserts   UUID := uuid_generate_v4();
  c_beverages  UUID := uuid_generate_v4();

  -- Item Group IDs — shared across all variants of the same dish
  g_paneer_tikka     UUID := uuid_generate_v4();
  g_chicken65        UUID := uuid_generate_v4();
  g_pbm              UUID := uuid_generate_v4();
  g_butter_chicken   UUID := uuid_generate_v4();
  g_veg_biryani      UUID := uuid_generate_v4();
  g_chicken_biryani  UUID := uuid_generate_v4();
  g_gulab_jamun      UUID := uuid_generate_v4();
  g_mango_lassi      UUID := uuid_generate_v4();
  g_cold_coffee      UUID := uuid_generate_v4();

BEGIN

-- ── CATEGORIES ─────────────────────────────────────────────────────
INSERT INTO menu_categories (id, branch_id, name, description, sort_order) VALUES
  (c_starters,  v_branch, 'Starters',       'Crispy bites to kick off your meal',                1),
  (c_mains,     v_branch, 'Main Course',    'Rich curries and gravies, best paired with breads', 2),
  (c_biryani,   v_branch, 'Biryani & Rice', 'Slow-cooked dum biryanis and fragrant rice',        3),
  (c_breads,    v_branch, 'Breads',         'Fresh from the tandoor',                            4),
  (c_desserts,  v_branch, 'Desserts',       'Sweet endings to your perfect meal',                5),
  (c_beverages, v_branch, 'Beverages',      'Cool drinks and hot chai',                          6);

-- ── STARTERS ───────────────────────────────────────────────────────

-- Standalone
INSERT INTO menu_items
  (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_available, is_bestseller, sort_order)
VALUES
  (v_branch, c_starters,
   'Veg Samosa',
   'Crispy golden pastry stuffed with spiced potato and peas. Served with mint chutney.',
   8000, 'SR-starters-veg-samosa',
   'https://placehold.co/400x400/f97316/ffffff?text=Veg+Samosa',
   'veg', TRUE, FALSE, 1),

  (v_branch, c_starters,
   'Fish Fingers',
   'Tender fish fillets in crispy golden breadcrumbs. Served with tartar sauce.',
   32000, 'SR-starters-fish-fingers',
   'https://placehold.co/400x400/f97316/ffffff?text=Fish+Fingers',
   'non_veg', TRUE, FALSE, 6),

  (v_branch, c_starters,
   'Mushroom Pepper Fry',
   'Button mushrooms tossed with freshly ground pepper and herbs. Vegan favourite.',
   18000, 'SR-starters-mushroom-pepper',
   'https://placehold.co/400x400/84cc16/ffffff?text=Mushroom+Fry',
   'vegan', TRUE, FALSE, 7);

-- Variant group: Paneer Tikka (Half / Full)
INSERT INTO menu_items
  (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_available, is_bestseller, sort_order, item_group_id, variant_type, variant_value)
VALUES
  (v_branch, c_starters,
   'Paneer Tikka',
   'Marinated cottage cheese grilled in tandoor with bell peppers. Smoky and juicy.',
   22000, 'SR-starters-paneer-tikka-half',
   'https://placehold.co/400x400/f97316/ffffff?text=Paneer+Tikka',
   'veg', TRUE, TRUE, 2, g_paneer_tikka, 'portion', 'Half'),

  (v_branch, c_starters,
   'Paneer Tikka',
   'Marinated cottage cheese grilled in tandoor with bell peppers. Smoky and juicy.',
   38000, 'SR-starters-paneer-tikka-full',
   'https://placehold.co/400x400/f97316/ffffff?text=Paneer+Tikka',
   'veg', TRUE, TRUE, 3, g_paneer_tikka, 'portion', 'Full');

-- Variant group: Chicken 65 (Half / Full)
INSERT INTO menu_items
  (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_available, is_bestseller, sort_order, item_group_id, variant_type, variant_value)
VALUES
  (v_branch, c_starters,
   'Chicken 65',
   'Spicy deep-fried chicken with curry leaves and green chillies. A South Indian classic.',
   28000, 'SR-starters-chicken65-half',
   'https://placehold.co/400x400/dc2626/ffffff?text=Chicken+65',
   'non_veg', TRUE, TRUE, 4, g_chicken65, 'portion', 'Half'),

  (v_branch, c_starters,
   'Chicken 65',
   'Spicy deep-fried chicken with curry leaves and green chillies. A South Indian classic.',
   48000, 'SR-starters-chicken65-full',
   'https://placehold.co/400x400/dc2626/ffffff?text=Chicken+65',
   'non_veg', TRUE, TRUE, 5, g_chicken65, 'portion', 'Full');

-- ── MAIN COURSE ────────────────────────────────────────────────────

-- Standalone
INSERT INTO menu_items
  (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_available, is_bestseller, sort_order)
VALUES
  (v_branch, c_mains,
   'Dal Makhani',
   'Slow-cooked black lentils simmered overnight in tomato and cream. Soul of North Indian cuisine.',
   22000, 'SR-mains-dal-makhani',
   'https://placehold.co/400x400/92400e/ffffff?text=Dal+Makhani',
   'veg', TRUE, TRUE, 1),

  (v_branch, c_mains,
   'Palak Paneer',
   'Fresh cottage cheese in a smooth spiced spinach gravy. Nutritious and flavourful.',
   24000, 'SR-mains-palak-paneer',
   'https://placehold.co/400x400/16a34a/ffffff?text=Palak+Paneer',
   'veg', TRUE, FALSE, 7),

  (v_branch, c_mains,
   'Lamb Rogan Josh',
   'Kashmiri slow-cooked lamb in aromatic whole spices. Bold, hearty, unforgettable.',
   58000, 'SR-mains-lamb-rogan-josh',
   'https://placehold.co/400x400/dc2626/ffffff?text=Rogan+Josh',
   'non_veg', TRUE, FALSE, 6);

-- Variant group: Paneer Butter Masala (Half / Full)
INSERT INTO menu_items
  (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_available, is_bestseller, sort_order, item_group_id, variant_type, variant_value)
VALUES
  (v_branch, c_mains,
   'Paneer Butter Masala',
   'Soft paneer cubes in a rich tomato-cream gravy. Perfect with naan.',
   26000, 'SR-mains-pbm-half',
   'https://placehold.co/400x400/ea580c/ffffff?text=Paneer+Butter+Masala',
   'veg', TRUE, TRUE, 2, g_pbm, 'portion', 'Half'),

  (v_branch, c_mains,
   'Paneer Butter Masala',
   'Soft paneer cubes in a rich tomato-cream gravy. Perfect with naan.',
   44000, 'SR-mains-pbm-full',
   'https://placehold.co/400x400/ea580c/ffffff?text=Paneer+Butter+Masala',
   'veg', TRUE, TRUE, 3, g_pbm, 'portion', 'Full');

-- Variant group: Butter Chicken (Half / Full)
INSERT INTO menu_items
  (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_available, is_bestseller, sort_order, item_group_id, variant_type, variant_value)
VALUES
  (v_branch, c_mains,
   'Butter Chicken',
   'Tender chicken in a velvety tomato-butter-cream sauce. India''s most loved dish.',
   30000, 'SR-mains-butter-chicken-half',
   'https://placehold.co/400x400/b45309/ffffff?text=Butter+Chicken',
   'non_veg', TRUE, TRUE, 4, g_butter_chicken, 'portion', 'Half'),

  (v_branch, c_mains,
   'Butter Chicken',
   'Tender chicken in a velvety tomato-butter-cream sauce. India''s most loved dish.',
   52000, 'SR-mains-butter-chicken-full',
   'https://placehold.co/400x400/b45309/ffffff?text=Butter+Chicken',
   'non_veg', TRUE, TRUE, 5, g_butter_chicken, 'portion', 'Full');

-- ── BIRYANI & RICE ─────────────────────────────────────────────────

-- Standalone
INSERT INTO menu_items
  (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_available, is_bestseller, sort_order)
VALUES
  (v_branch, c_biryani,
   'Mutton Dum Biryani',
   'Slow-cooked mutton on the bone with aromatic basmati. A royal feast.',
   62000, 'SR-biryani-mutton-full',
   'https://placehold.co/400x400/92400e/ffffff?text=Mutton+Biryani',
   'non_veg', TRUE, FALSE, 5),

  (v_branch, c_biryani,
   'Jeera Rice',
   'Steamed basmati rice tempered with cumin seeds and ghee. Simple perfection.',
   12000, 'SR-biryani-jeera-rice',
   'https://placehold.co/400x400/ca8a04/ffffff?text=Jeera+Rice',
   'veg', TRUE, FALSE, 6);

-- Variant group: Veg Dum Biryani (Half / Full)
INSERT INTO menu_items
  (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_available, is_bestseller, sort_order, item_group_id, variant_type, variant_value)
VALUES
  (v_branch, c_biryani,
   'Veg Dum Biryani',
   'Fragrant basmati layered with seasonal vegetables and whole spices, slow-cooked dum style.',
   22000, 'SR-biryani-veg-half',
   'https://placehold.co/400x400/ca8a04/ffffff?text=Veg+Biryani',
   'veg', TRUE, FALSE, 1, g_veg_biryani, 'size', 'Half'),

  (v_branch, c_biryani,
   'Veg Dum Biryani',
   'Fragrant basmati layered with seasonal vegetables and whole spices, slow-cooked dum style.',
   38000, 'SR-biryani-veg-full',
   'https://placehold.co/400x400/ca8a04/ffffff?text=Veg+Biryani',
   'veg', TRUE, FALSE, 2, g_veg_biryani, 'size', 'Full');

-- Variant group: Chicken Dum Biryani (Half / Full)
INSERT INTO menu_items
  (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_available, is_bestseller, sort_order, item_group_id, variant_type, variant_value)
VALUES
  (v_branch, c_biryani,
   'Chicken Dum Biryani',
   'Tender chicken with saffron-infused basmati and caramelised onions.',
   28000, 'SR-biryani-chicken-half',
   'https://placehold.co/400x400/b45309/ffffff?text=Chicken+Biryani',
   'non_veg', TRUE, TRUE, 3, g_chicken_biryani, 'size', 'Half'),

  (v_branch, c_biryani,
   'Chicken Dum Biryani',
   'Tender chicken with saffron-infused basmati and caramelised onions.',
   48000, 'SR-biryani-chicken-full',
   'https://placehold.co/400x400/b45309/ffffff?text=Chicken+Biryani',
   'non_veg', TRUE, TRUE, 4, g_chicken_biryani, 'size', 'Full');

-- ── BREADS ─────────────────────────────────────────────────────────

INSERT INTO menu_items
  (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_available, sort_order)
VALUES
  (v_branch, c_breads,
   'Butter Naan',
   'Soft tandoor-baked flatbread brushed with butter. Classic and irresistible.',
   5000, 'SR-breads-butter-naan',
   'https://placehold.co/400x400/d97706/ffffff?text=Butter+Naan',
   'veg', TRUE, 1),

  (v_branch, c_breads,
   'Garlic Naan',
   'Fluffy naan topped with minced garlic and coriander, baked to golden perfection.',
   6000, 'SR-breads-garlic-naan',
   'https://placehold.co/400x400/d97706/ffffff?text=Garlic+Naan',
   'veg', TRUE, 2),

  (v_branch, c_breads,
   'Tandoori Roti',
   'Whole wheat bread baked in clay oven. Light, healthy, goes with everything.',
   4000, 'SR-breads-tandoori-roti',
   'https://placehold.co/400x400/d97706/ffffff?text=Tandoori+Roti',
   'veg', TRUE, 3),

  (v_branch, c_breads,
   'Lachha Paratha',
   'Multi-layered flaky whole wheat paratha with a buttery crispy exterior.',
   7000, 'SR-breads-lachha-paratha',
   'https://placehold.co/400x400/d97706/ffffff?text=Lachha+Paratha',
   'veg', TRUE, 4),

  (v_branch, c_breads,
   'Peshwari Naan',
   'Stuffed naan filled with coconut, almonds and raisins. Sweetly exotic.',
   9000, 'SR-breads-peshwari-naan',
   'https://placehold.co/400x400/d97706/ffffff?text=Peshwari+Naan',
   'veg', TRUE, 5);

-- ── DESSERTS ───────────────────────────────────────────────────────

-- Standalone
INSERT INTO menu_items
  (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_available, sort_order)
VALUES
  (v_branch, c_desserts,
   'Mango Kulfi',
   'Traditional Indian ice cream with condensed milk and fresh Alphonso mango. Creamy and rich.',
   14000, 'SR-desserts-mango-kulfi',
   'https://placehold.co/400x400/f59e0b/ffffff?text=Mango+Kulfi',
   'veg', TRUE, 3),

  (v_branch, c_desserts,
   'Rasmalai',
   'Cottage cheese patties soaked in chilled saffron-infused cream. A Bengali delicacy.',
   16000, 'SR-desserts-rasmalai',
   'https://placehold.co/400x400/f59e0b/ffffff?text=Rasmalai',
   'veg', TRUE, 4),

  (v_branch, c_desserts,
   'Kheer',
   'Slow-cooked rice pudding with cardamom, saffron and toasted nuts.',
   12000, 'SR-desserts-kheer',
   'https://placehold.co/400x400/f59e0b/ffffff?text=Kheer',
   'veg', TRUE, 5);

-- Variant group: Gulab Jamun (2 Pieces / 4 Pieces)
INSERT INTO menu_items
  (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_available, is_bestseller, sort_order, item_group_id, variant_type, variant_value)
VALUES
  (v_branch, c_desserts,
   'Gulab Jamun',
   'Soft milk-solid dumplings soaked in rose-cardamom sugar syrup. Served warm.',
   10000, 'SR-desserts-gulab-jamun-2pc',
   'https://placehold.co/400x400/f59e0b/ffffff?text=Gulab+Jamun',
   'veg', TRUE, TRUE, 1, g_gulab_jamun, 'pack', '2 Pieces'),

  (v_branch, c_desserts,
   'Gulab Jamun',
   'Soft milk-solid dumplings soaked in rose-cardamom sugar syrup. Served warm.',
   18000, 'SR-desserts-gulab-jamun-4pc',
   'https://placehold.co/400x400/f59e0b/ffffff?text=Gulab+Jamun',
   'veg', TRUE, TRUE, 2, g_gulab_jamun, 'pack', '4 Pieces');

-- ── BEVERAGES ──────────────────────────────────────────────────────

-- Standalone
INSERT INTO menu_items
  (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_available, sort_order)
VALUES
  (v_branch, c_beverages,
   'Masala Chai',
   'Strong spiced tea with ginger, cardamom and cinnamon. The perfect Indian warm-up.',
   4000, 'SR-bev-masala-chai',
   'https://placehold.co/400x400/0ea5e9/ffffff?text=Masala+Chai',
   'veg', TRUE, 5),

  (v_branch, c_beverages,
   'Fresh Lime Soda',
   'Freshly squeezed limes over soda with a pinch of chaat masala. Sweet or salted.',
   8000, 'SR-bev-fresh-lime-soda',
   'https://placehold.co/400x400/0ea5e9/ffffff?text=Lime+Soda',
   'veg', TRUE, 6),

  (v_branch, c_beverages,
   'Virgin Mojito',
   'Muddled mint, lime juice and soda over crushed ice. Cool and zesty.',
   14000, 'SR-bev-virgin-mojito',
   'https://placehold.co/400x400/0ea5e9/ffffff?text=Virgin+Mojito',
   'veg', TRUE, 7),

  (v_branch, c_beverages,
   'Watermelon Juice',
   'Cold-pressed fresh watermelon with a hint of mint. Pure summer in a glass.',
   10000, 'SR-bev-watermelon-juice',
   'https://placehold.co/400x400/0ea5e9/ffffff?text=Watermelon+Juice',
   'vegan', TRUE, 8);

-- Variant group: Mango Lassi (Regular / Large)
INSERT INTO menu_items
  (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_available, is_bestseller, sort_order, item_group_id, variant_type, variant_value)
VALUES
  (v_branch, c_beverages,
   'Mango Lassi',
   'Thick blended yoghurt with fresh Alphonso mango pulp. Chilled and refreshing.',
   12000, 'SR-bev-mango-lassi-reg',
   'https://placehold.co/400x400/0ea5e9/ffffff?text=Mango+Lassi',
   'veg', TRUE, TRUE, 1, g_mango_lassi, 'size', 'Regular (300ml)'),

  (v_branch, c_beverages,
   'Mango Lassi',
   'Thick blended yoghurt with fresh Alphonso mango pulp. Chilled and refreshing.',
   18000, 'SR-bev-mango-lassi-large',
   'https://placehold.co/400x400/0ea5e9/ffffff?text=Mango+Lassi',
   'veg', TRUE, TRUE, 2, g_mango_lassi, 'size', 'Large (500ml)');

-- Variant group: Cold Coffee (Regular / Large)
INSERT INTO menu_items
  (branch_id, category_id, name, description, price_paise, retailer_id, image_url, food_type, is_available, is_bestseller, sort_order, item_group_id, variant_type, variant_value)
VALUES
  (v_branch, c_beverages,
   'Cold Coffee',
   'Blended coffee with chilled milk and ice cream. Creamy, bold, energising.',
   14000, 'SR-bev-cold-coffee-reg',
   'https://placehold.co/400x400/0ea5e9/ffffff?text=Cold+Coffee',
   'veg', TRUE, FALSE, 3, g_cold_coffee, 'size', 'Regular (300ml)'),

  (v_branch, c_beverages,
   'Cold Coffee',
   'Blended coffee with chilled milk and ice cream. Creamy, bold, energising.',
   20000, 'SR-bev-cold-coffee-large',
   'https://placehold.co/400x400/0ea5e9/ffffff?text=Cold+Coffee',
   'veg', TRUE, FALSE, 4, g_cold_coffee, 'size', 'Large (500ml)');

-- ── DONE ───────────────────────────────────────────────────────────
RAISE NOTICE '✅ Demo menu seeded!';
RAISE NOTICE '   6 categories | 32 items | 9 variant groups';
RAISE NOTICE '   Variant groups: Paneer Tikka, Chicken 65, Paneer Butter Masala,';
RAISE NOTICE '   Butter Chicken, Veg Biryani, Chicken Biryani,';
RAISE NOTICE '   Gulab Jamun, Mango Lassi, Cold Coffee';
RAISE NOTICE '';
RAISE NOTICE '   Next: Dashboard → Sync to WhatsApp → Sync Product Sets';

END $$;
