# GullyBite MongoDB Schema Reference

> **Source of truth:** `backend/src/schemas/collections.js`
> **Validation:** `backend/src/schemas/validate.js`
> **Database:** MongoDB (no SQL — all `.sql` files are archived legacy)

## Collections Overview

| Collection | Purpose | Key Fields |
|------------|---------|------------|
| `restaurants` | Restaurant accounts | business_name, status, meta_catalog_id |
| `branches` | Restaurant outlets | restaurant_id, name, latitude/longitude |
| `menu_items` | Menu products per branch | retailer_id, name, price_paise, food_type |
| `menu_categories` | Item categories per branch | branch_id, name, sort_order |
| `orders` | Customer orders | order_number, customer_id, status, total_rs |
| `order_items` | Line items in orders | order_id, item_name, quantity, unit_price_rs |
| `customers` | WhatsApp customers | wa_phone, bsuid, name |
| `conversations` | Bot conversation state | customer_id, state, session_data |
| `payments` | Razorpay payment records | order_id, status, amount_rs |
| `settlements` | Weekly restaurant payouts | restaurant_id, period, net_payout_rs |
| `whatsapp_accounts` | WABA connections | restaurant_id, phone_number_id, catalog_id |
| `referrals` | Referral attribution | customer_wa_phone, status, commission_status |
| `referral_links` | GBREF link tracking | code, restaurant_id, click_count |
| `order_ratings` | Post-order feedback | order_id, taste/packing/delivery/value ratings |
| `customer_addresses` | Saved delivery addresses | customer_id, label, latitude/longitude |
| `coupons` | Discount codes | restaurant_id, code, discount |
| `campaigns` | Marketing campaigns | restaurant_id, name, status |
| `abandoned_carts` | Cart recovery tracking | customer_phone, cart_items, recovery_status |
| `activity_logs` | System audit trail | action, description, severity |
| `webhook_logs` | Incoming webhook log | source, payload, processed |
| `admin_users` | Admin dashboard accounts | email, role, permissions |
| `platform_settings` | Platform-wide config | _id (fixed keys), various config |
| `templates` | WhatsApp message templates | name, status, components |
| `template_mappings` | Event-to-template mapping | event, template_name, variables |

## Core Collection Details

### restaurants
```
_id: UUID (primary key)
business_name: string (required)
status: 'active' | 'pending' | 'suspended' | 'rejected'
approval_status: 'pending' | 'approved' | 'rejected'
meta_catalog_id: string (Meta Commerce catalog ID)
commission_pct: number (platform fee %, default 10)
created_at: date
```

### menu_items
```
_id: UUID
restaurant_id: UUID (required)
branch_id: UUID (required)
retailer_id: string (unique, branch-encoded: {branch-slug}-{item-slug}-{size})
name: string (required)
price_paise: number (required, integer, 1 INR = 100 paise)
food_type: 'veg' | 'non_veg' | 'vegan' | 'egg'
item_group_id: string (groups variants of same item)
is_available: boolean (required)
catalog_sync_status: 'pending' | 'synced' | 'error'
trust_metrics: { average_rating, trust_tag, public_rating_enabled, ... }
meta_description_generated: string (auto-generated trust-rich description)
```

### orders
```
_id: UUID
order_number: string (e.g., 'ZM-20260408-0001')
customer_id: UUID (required)
branch_id: UUID (required)
subtotal_rs: number (food items only)
total_rs: number (customer pays)
status: PENDING_PAYMENT → PAID → CONFIRMED → PREPARING → PACKED → DISPATCHED → DELIVERED
referral_id: UUID (if referred)
referral_fee_rs: number (7.5% of subtotal)
settlement_id: UUID (set when settled)
```

### referrals
```
_id: UUID
restaurant_id: UUID (required)
customer_wa_phone: string (required)
source: 'gbref' | 'directory' | 'admin'
status: 'active' | 'converted' | 'expired' | 'superseded' | 'reversed'
attribution_window_hours: 4 or 8 (based on IST time)
commission_status: 'pending' | 'confirmed' | 'reversed' | 'settled'
expires_at: date
```

### settlements
```
_id: UUID
restaurant_id: UUID (required)
period_start/period_end: date
platform_fee_rs: number (food_revenue * commission_rate)
platform_fee_gst_rs: number (18%)
referral_fee_rs: number
referral_fee_gst_rs: number (18%)
is_first_billing_month: boolean (if true, platform fee waived)
net_payout_rs: number
payout_status: 'pending' | 'processing' | 'completed' | 'failed'
```

## ID Format

All `_id` fields use UUID v4 strings (not MongoDB ObjectId). Generated via `newId()` from `config/database.js`.

## Indexes

Defined in `backend/src/config/indexes.js`. Created on server startup via `ensureIndexes()`.

## Validation

Use `validateDocument(collectionName, doc)` from `schemas/validate.js`:

```javascript
const { validateDocument } = require('./schemas/validate');
const { valid, errors } = validateDocument('orders', orderDoc);
if (!valid) console.warn('Validation errors:', errors);
```

Validation is opt-in. It never throws — returns `{ valid, errors }`.
