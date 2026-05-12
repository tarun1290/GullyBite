'use strict';

// Pure payload builders for the city captain WhatsApp flow. Each
// exported function returns a plain object (or array of them) that the
// captainHandler's sendPayload helper routes to the right wa.* call.

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ─── Q1: VEG PREFERENCE ─────────────────────────────────────
function q1Buttons(cityName) {
  return {
    header: truncate(`Welcome to ${cityName} Foodie 🍽️`, 60),
    body: `What's your food preference?`,
    buttons: [
      { id: 'veg_only', title: 'Veg only' },
      { id: 'eggetarian', title: 'Eggetarian' },
      { id: 'non_veg', title: 'Non-veg' },
    ],
  };
}

// ─── Q2: CUISINE PICKS (up to 3) ────────────────────────────
// alreadyPicked: array of cuisine strings the user has already chosen.
// Each picked row gets " ✓" appended to its description.
// Always appends a final "Done" row (id 'cuisine_done').
function q2CuisineList(cuisineOptions, alreadyPicked) {
  const picked = new Set(alreadyPicked || []);
  const rows = (cuisineOptions || []).slice(0, 10).map((c) => {
    const isPicked = picked.has(c);
    return {
      id: `cuisine_pick_${c}`,
      title: truncate(c, 24),
      description: truncate(isPicked ? '✓ picked' : 'Tap to pick', 72),
    };
  });
  rows.push({
    id: 'cuisine_done',
    title: 'Done',
    description: truncate('Move to next step', 72),
  });
  return {
    body: `Which cuisines do you love? (Pick up to 3)`,
    buttonText: 'Pick cuisine',
    sections: [
      { title: 'Cuisines', rows },
    ],
  };
}

// ─── Q3: PRICE BAND ─────────────────────────────────────────
function q3Buttons() {
  return {
    body: `What's your usual budget per meal?`,
    buttons: [
      { id: 'price_budget', title: 'Under ₹200' },
      { id: 'price_mid', title: '₹200–₹500' },
      { id: 'price_premium', title: '₹500+' },
    ],
  };
}

// ─── BROWSING MENU ──────────────────────────────────────────
function browsingMenu(cityName) {
  return {
    body: `Explore ${cityName}'s best food 🍴`,
    buttonText: 'Explore',
    sections: [
      {
        title: 'Browse',
        rows: [
          { id: 'filter_cuisine', title: 'Pick a cuisine', description: 'Filter by cuisine' },
          { id: 'filter_area', title: 'Pick an area', description: 'Filter by area' },
          { id: 'filter_price', title: 'Pick a price range', description: 'Filter by price' },
          { id: 'browse_veg', title: 'Veg places only', description: 'Vegetarian-only results' },
          { id: 'browse_new', title: 'New this week', description: 'Added in last 14 days' },
        ],
      },
      {
        title: 'More',
        rows: [
          { id: 'browse_menu', title: 'Main menu', description: 'Back to the main menu' },
          { id: 'contribute_photo', title: 'Share a menu photo', description: 'Help us add new places' },
        ],
      },
    ],
  };
}

// ─── LISTINGS RESULT LIST ───────────────────────────────────
// listings: array of city_listings docs. Each row: id 'listing_<id>',
// title=name (truncated), description = "<area> · <price_band_label> [· 🟢 Veg]".
// appliedFilterLabel (optional string): appears in the body line.
function priceBandLabel(key) {
  switch (key) {
    case 'budget': return 'Under ₹200';
    case 'mid': return '₹200–₹500';
    case 'premium': return '₹500–₹1000';
    case 'luxury': return 'Above ₹1000';
    default: return '';
  }
}

function listingsResultList(listings, appliedFilterLabel) {
  const rows = (listings || []).slice(0, 10).map((l) => {
    const pb = priceBandLabel(l?.tags?.price_band);
    const isVeg = l?.tags?.veg_status === 'veg';
    const parts = [];
    if (l.area) parts.push(l.area);
    if (pb) parts.push(pb);
    if (isVeg) parts.push('🟢 Veg');
    return {
      id: `listing_${l._id}`,
      title: truncate(l.name || 'Unnamed', 24),
      description: truncate(parts.join(' · ') || ' ', 72),
    };
  });
  const body = appliedFilterLabel
    ? `Here's what we found for ${appliedFilterLabel} 👇`
    : `Here's what we found 👇`;
  return {
    body,
    buttonText: 'View options',
    sections: [{ title: 'Results', rows }],
  };
}

// ─── LISTING CARD (text + buttons pair) ─────────────────────
// Returns [{ _text: '...' }, { body, buttons }] so the handler sends
// both messages sequentially.
function listingCard(listing) {
  const pb = priceBandLabel(listing?.tags?.price_band);
  const cuisines = Array.isArray(listing?.tags?.cuisine_primary) ? listing.tags.cuisine_primary : [];
  const lines = [];
  lines.push(`*${listing.name || 'Unnamed'}*`);
  if (listing.area) lines.push(`📍 ${listing.area}`);
  if (cuisines.length > 0) lines.push(`🍴 ${cuisines.slice(0, 3).join(', ')}`);
  if (pb) lines.push(`💸 ${pb}`);
  if (listing?.tags?.veg_status === 'veg') lines.push(`🟢 Veg`);
  if (listing.description) lines.push('');
  if (listing.description) lines.push(listing.description);
  lines.push('');
  lines.push('_Reply with the buttons below._');

  const buttons = [];
  if (listing.fulfillment_mode === 'handoff' && listing.linked_restaurant_id) {
    buttons.push({ id: `order_now_${listing._id}`, title: 'Order now' });
  } else {
    // notify_only (or any other non-orderable state)
    buttons.push({ id: `notify_me_${listing._id}`, title: 'Notify me 🔔' });
  }
  // Always include Back as the third button (WhatsApp max is 3).
  buttons.push({ id: 'browse_menu', title: '⬅ Back' });

  return [
    { _text: lines.join('\n') },
    { body: 'What next?', buttons },
  ];
}

module.exports = {
  q1Buttons,
  q2CuisineList,
  q3Buttons,
  browsingMenu,
  listingsResultList,
  listingCard,
};
