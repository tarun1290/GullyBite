# Dashboard Modularization Plan

## File Stats
- **Total lines:** 9,043
- **File size:** 495 KB
- **CSS:** Lines 1-318 (1 `<style>` block)
- **External scripts:** Lines 320-322 (XLSX, Chart.js)
- **Main JS:** Lines 2282-9023 (1 large `<script>` block = ~6,741 lines of JS)
- **HTML tabs:** Lines 333-2280 (sidebar + 20 tab containers + 6 modals)

---

## Architecture Decision

### Target Structure
```
frontend/
  dashboard.html          -- Shell: sidebar, header, CSS, shared JS, tab containers
  js/
    shared.js             -- api(), toast(), goTab(), fmtINR(), timeAgo(), globals
    tabs/
      overview.js         -- Overview tab
      orders.js           -- Orders tab + order detail modal
      menu.js             -- Menu tab (branches, categories, CSV, catalog sync, product sets, collections)
      messages.js         -- Messages inbox tab
      analytics.js        -- Analytics + Customers + Ratings tabs
      payments.js         -- Financials + Settlements + Wallet tabs
      restaurant.js       -- Coupons + Campaigns + Loyalty + Team + Issues tabs
      settings.js         -- Settings (Profile + WhatsApp + Integrations + Catalog Mgmt + Sync Logs)
```

### Loading Strategy
- Each tab JS file attaches functions to `window` (no ES modules -- dashboard.html loads via `<script src>`)
- Shell's `goTab()` calls each tab's `load()` entry point
- Shared utilities loaded first via `shared.js`

---

## Tab Map

### 1. Overview
- **HTML:** `#tab-overview` (lines 416-439)
- **Load fn:** `loadOverview()`
- **JS functions:** `loadOverview`, `loadOverviewCharts`, `renderWizard`, `loadRecent`
- **Globals read:** `rest`, `branches`, `token`
- **Cross-tab calls:** `goTab('orders')`, `goTab('menu')`, `goTab('settings')` (via wizard)
- **Complexity:** LOW

### 2. Orders
- **HTML:** `#tab-orders` (lines 441-459)
- **Modal:** `#ord-modal` (lines 2174-2183)
- **Load fn:** `loadOrders('ALL')`
- **JS functions:** `loadOrders`, `doFilterOrders`, `sbadge`, `fmtEta`, `oaction`, `openOrdModal`, `closeOrdModal`, `doUpdateOrder`, `doDispatch`, `doCancelDelivery`
- **Globals:** `oFilter`, `rest`, `token`
- **Cross-tab calls:** None outbound; inbound from WebSocket `new_order` event
- **Complexity:** MEDIUM

### 3. Menu (includes Branches)
- **HTML:** `#tab-branches` (lines 738-892), `#tab-menu` (lines 894-1147)
- **Modals:** `#set-modal` (line 1123), `#coll-modal` (line 1102), `#var-modal` (line 2185)
- **Load fn:** `loadBranchSel()` + `loadMenu()`, `loadBranches()`
- **JS functions (65+):**
  - Branches: `loadBranches`, `renderBranchCard`, `_formatHoursSummary`, `doCreateCatalog`, `doSync`, `animBar`, `doToggle`, `openHoursEditor`, `renderHoursRows`, `toggleDayOpen`, `toggleSameHours`, `applyHoursPreset`, `saveHours`, `editBranchAddr`, `_editAddrSearch`, `_editAddrKeydown`, `_editAddrPick`, `saveBranchAddr`, `doAddBranch`, `addrSearch`, `_addrHover`, `_addrHighlightUpdate`, `_addrKeydown`, `addrPick`, `_setAddrIcon`, `handleOutletCsvFile`, `handleOutletCsvDrop`, `processOutletFile`, `resetOutletCsv`, `geocodeAddress`, `doUploadOutletCsv`, `doDownloadOutletSample`
  - Menu: `loadBranchSel`, `selectBranchTab`, `doSelectBranch`, `loadMenu`, `renderMenuGroups`, `toggleAddDropdown`, `toggleMenuSection`, `loadCatalogPanelContent`, `doAddItem`, `doToggleItem`, `doBulkAvailability`, `_updateBulkAvailBtn`, `doDeleteItem`, `toggleAllMenuItems`, `updateBulkBar`, `clearMenuSelection`, `doBulkDelete`, `doQuickSync`, `doSyncToCatalog`, `doSyncFromCatalog`, `updateSyncStatus`, `timeAgoShort`, `doFixCatalog`
  - CSV: `splitCSVLine`, `parseFile`, `parseRawCSV`, `autoMatch`, `renderMapper`, `updateMapperSel`, `confirmMapper`, `applyMapping`, `handleCsvFile`, `handleCsvDrop`, `processCsvFile`, `resetCsv`, `doUploadCsv`, `doDownloadSample`
  - Categories: `toggleCatManager`, `renderCatList`, `doCreateCat`, `startEditCat`, `cancelEditCat`, `saveCat`, `doDeleteCat`, `onCatChange`
  - Variants: `onVariantToggle`, `addVariantRow`, `openVarModal`, `closeVarModal`, `doAddVariant`
  - Product sets: `doSyncSets`, `loadProductSets`, `onSetTypeChange`, `openCreateSetModal`, `openEditSetModal`, `closeSetModal`, `doSaveSet`, `doDeleteSet`, `doAutoCreateSets`, `doSyncAllSets`
  - Collections: `loadCollections`, `setupCollDragDrop`, `openCreateCollModal`, `openEditCollModal`, `loadCollSetsPicker`, `closeCollModal`, `doSaveColl`, `doDeleteColl`, `doAutoCreateCollections`, `doSyncAllCollections`
  - Image: `syncImgPreview`, `handleImgFile`, `resetImgPicker`, `updateImgQuality`, `loadImageStats`, `openBulkImageUpload`, `closeBulkImageUpload`, `updateBulkFileList`, `doBulkImageUpload`
- **Globals:** `branches`, `_menuItems`, `_allMenuData`, `_addrSuggestions`, `_editAddrTimers`, `_editAddrSuggestions`, `_editAddrHighlight`, `_editAddrDetails`, `_hoursCache`, `outletCsvParsed`, `_outletCsvRaw`, `csvParsed`, `_csvRaw`, `_catManagerOpen`, `VARIANT_PRESETS`, `MENU_FIELDS`, `OUTLET_FIELDS`, `META_COLUMN_ALIASES`, `_editingSetId`, `_editingCollId`, `varItemId`, `varItemName`
- **Cross-tab calls:** `goTab('branches')` from menu, WebSocket `catalog_sync` event
- **Complexity:** VERY HIGH (largest tab, ~3000+ JS lines)

### 4. Messages
- **HTML:** `#tab-messages` (lines 593-631)
- **Load fn:** `loadMessages()`
- **JS functions:** `loadMessages`, `fetchThreads`, `renderMsgBubble`, `fetchMsgMediaThumb`, `openMsgMedia`, `loadMsgThread`, `refreshActiveThread`, `sendMsgReply`, `resolveThread`, `setMsgFilter`, `debounceMsgSearch`, `createIssueFromThread`, `startMsgPoll`
- **Globals:** `msgFilter`, `msgSearch`, `msgThreads`, `msgActiveCust`, `msgPollTimer`, `msgThreadPollTimer`, `_lastUnreadCount`, `_msgSearchTimer`
- **Cross-tab calls:** Updates `#msg-badge` in sidebar; calls `openCreateIssue` (Issues)
- **Complexity:** MEDIUM

### 5. Analytics (includes Customers, Ratings, Conversations)
- **HTML:** `#tab-analytics` (lines 461-580), `#tab-customers` (lines 582-591), `#tab-ratings` (lines 1567-1614)
- **Load fn:** `loadAnalytics()`, `loadRatings()`, `loadCustomers()`
- **JS functions:** `anSetPeriod`, `anSetGranularity`, `loadAnalytics`, `loadConversationAnalytics`, `anLoadOverview`, `anLoadRevenue`, `anLoadTopItems`, `anLoadPeakHours`, `anLoadCustomers`, `anLoadDelivery`, `_destroyChart`, `loadCustomers`, `debounceCustSearch`, `toggleCustHistory`, `showCustOrderHistory`, `loadRatings`
- **Globals:** `_anPeriod`, `_anGranularity`, `_anCharts`, `_convosChart`, `_custSearch`, `_custDebounce`, `_rtPage`
- **Cross-tab calls:** None significant
- **Complexity:** MEDIUM

### 6. Payments (Financials + Settlements + Wallet)
- **HTML:** `#tab-financials` (lines 1821-1972), `#tab-settlements` (lines 1389-1399), `#tab-wallet` (lines 1340-1387)
- **Modal:** `#fin-settle-modal` (line 2266)
- **Load fn:** `loadFinancials()`, `loadSettlements()`, `loadWallet()`
- **JS functions:** `fmtINR`, `loadFinancials`, `setFinPeriod`, `toggleFinCustomRange`, `applyFinCustomRange`, `loadFinSummary`, `renderFinBreakdown`, `loadFinChart`, `loadFinSettlements`, `openSettlementDetail`, `closeFinSettleModal`, `downloadFinSettlement`, `loadFinPayments`, `loadWallet`
- **Globals:** `finPeriod`, `finChartInstance`, `finSettlePage`, `finPayPage`, `finCurrentSettleId`
- **Cross-tab calls:** None
- **Note:** `fmtINR` used by Orders tab too -- move to shared
- **Complexity:** MEDIUM

### 7. Restaurant (Coupons + Campaigns + Loyalty + Team + Issues)
- **HTML:** `#tab-coupons` (lines 1481-1565), `#tab-campaigns` (lines 1616-1700), `#tab-team` (lines 1702-1760), `#tab-loyalty` (lines 1762-1819), `#tab-issues` (lines 633-736), `#tab-referrals` (lines 1427-1479)
- **Modals:** `#user-modal` (line 1736), `#iss-create-modal` (line 707)
- **Load fn:** `loadCoupons()`, `loadLoyalty()`, `loadTeam()`, `loadIssues()`, `loadCampaigns()`
- **JS functions:**
  - Coupons: `toggleCouponTypeFields`, `loadCoupons`, `createCoupon`, `toggleCoupon`, `deleteCoupon`
  - Campaigns: `loadCampaigns`, `loadCampaignProducts`, `updateCmpCount`, `getCmpBody`, `createCampaign`, `createAndSendCampaign`, `sendCampaignNow`, `deleteCampaignRow`, `pauseCampaignNow`, `resumeCampaignNow`
  - Team: `loadTeam`, `openAddUserModal`, `closeUserModal` + save/delete user inline
  - Loyalty: `loadLoyalty`
  - Issues: `loadIssues`, `loadIssueStats`, `loadIssueList`, `catLabel`, `slaLabel`, `setIssFilter`, `debounceIssSearch`, `openIssDetail`, `closeIssDetail`, `issAction`, `sendIssMsg`, `issEscalate`, `issResolve`, `openCreateIssue`, `doCreateIssue`, `issStat`
  - Referrals: `loadReferrals`
- **Globals:** `_lyPage`, `_issSearchTimer`, `issFilter`, `issPage`, `issActiveIssue`, `ISS_PRI_CLR`, `ISS_PRI_BG`, `ISS_ST_CLR`, `waTemplates`
- **Cross-tab calls:** Messages calls `openCreateIssue`; Issues calls `goTab('orders')`
- **Complexity:** HIGH (many sub-sections)

### 8. Settings (Profile + WhatsApp + Integrations + Catalog Mgmt + Sync Logs)
- **HTML:** `#tab-settings` (lines 1974-2172), `#tab-whatsapp` (lines 1149-1338), `#tab-integrations` (lines 1401-1425)
- **Modals:** `#int-modal` (line 2227), `#int-variant-modal` (line 2250)
- **Load fn:** `loadProfile()`, `loadWA()`, `loadIntegrations()`, `loadCatalogMgmt()`, `loadSyncLogs()`
- **JS functions:**
  - Profile: `loadProfile`, `saveProfile`, `toggleDashGstHint`, `updateDashDeliveryHint`
  - WhatsApp: `loadWA`, `loadUsernameStatus`, `loadMessagingStatus`, `loadMessagingAnalytics`, `provisionCatalog`, `loadWATemplates`, `renderTemplateTable`, `loadTemplateMappings`, `onEventTemplateChange`, `clearEventTemplate`, `saveTemplateMappings`, `_setConnectBtns`, `_showDashFallback`, `_doMetaConnect`
  - Catalog Mgmt: `loadCatalogMgmt`, `toggleCatalogLink`, `toggleCatalogCart`, `toggleCatalogVisibility`, + 10+ doXxx catalog functions
  - Integrations: `loadIntegrations`, `refreshIntTile`, `renderIntLog`, `doToggleInt`, `openIntModal`, `closeIntModal`, `doSaveIntegration`, `doSyncIntegration`, `doSyncPlatform`, `doRemoveIntegration`, `showSyncResults`, `dismissSyncResults`, `openVariantModal`, `closeVariantModal`, `snakeToCamel`, `loadFeedStatus`, `doRegisterFeed`
  - Sync Logs: `loadSyncLogs`
- **Globals:** `_catMgmtData`, `_embeddedSignupSessionInfo`, `waTemplates`, `EVENT_META`, `VAR_FIELDS`, `INT_DEFS`, `intActivePlatform`, `_variantPlatform`, `_currentUser`, `BANNER_BTN_HTML`
- **Cross-tab calls:** None significant
- **Complexity:** HIGH

---

## Shared Utilities (stay in shell or shared.js)

### Functions
| Function | Used By | Location |
|----------|---------|----------|
| `api(path, opts)` | ALL tabs | Line 2419 |
| `toast(msg, type)` | ALL tabs | Line 8850 |
| `goTab(name, el)` | ALL tabs + cross-tab | Line 2371 |
| `fmtINR(n)` | Orders, Payments, Overview | Line 5803 |
| `timeAgo(ts)` | Messages, Issues, Overview | Line 8944 |
| `_esc(s)` | Menu, Branches, Messages | Line 3270 |
| `initDash()` | Shell (entry point) | Line 2431 |
| `logout()` | Shell (sidebar) | Line 2330 |
| `connectWebSocket()` | Shell (init) | Line 8957 |

### Global State
| Variable | Used By | Note |
|----------|---------|------|
| `token` | ALL (via api()) | Auth JWT |
| `rest` | ALL tabs | Restaurant object |
| `branches` | Menu, Overview, Branches, Analytics | Branch list |
| `TMETA` | goTab routing | Tab metadata map |
| `TAB_REDIRECT` | goTab routing | Sub-tab aliases |

---

## Cross-Tab Dependencies

| Dependency | From | To | Resolution |
|-----------|------|------|-----------|
| `fmtINR()` | Payments | Orders, Overview | Move to shared.js |
| `openCreateIssue()` | Messages | Issues/Restaurant | Move to shared.js or use custom event |
| `goTab()` links | Multiple | Multiple | Already shared |
| `branches` global | Menu/Branches | Overview, Analytics | Keep in shared state |
| WebSocket `new_order` | WebSocket | Orders, Overview, sidebar badge | Use custom events: `document.dispatchEvent(new CustomEvent('ws:new_order'))` |
| WebSocket `catalog_sync` | WebSocket | Menu | Use custom event |
| `msg-badge` sidebar update | Messages | Sidebar | Use custom event |
| `doSelectBranch()` | Branches cards | Menu tab | Either shared or custom event |

---

## Migration Order

Extract in order of increasing complexity:

1. **shared.js** -- Extract shared utilities first (api, toast, goTab, fmtINR, timeAgo, _esc, globals)
2. **analytics.js** -- Mostly self-contained charts + tables
3. **payments.js** -- Self-contained financials + settlements
4. **restaurant.js** -- Coupons/campaigns/team/loyalty/issues (many sub-sections but isolated)
5. **messages.js** -- Has polling timer, issue cross-tab dep
6. **orders.js** -- Medium complexity, WebSocket dependency
7. **overview.js** -- Depends on many other tabs being loaded
8. **settings.js** -- Large, complex (WhatsApp, catalog mgmt, integrations)
9. **menu.js** -- LAST (most complex: branches, CSV, catalog sync, product sets, collections, 65+ functions)

---

## Extraction Strategy Per Tab

For each tab extraction:

1. Create `frontend/js/tabs/{tab}.js`
2. Move all tab-specific functions into it
3. Move tab-specific globals to top of tab file
4. Replace inline `onclick` handlers with function references (functions now on `window`)
5. Verify each function is accessible from HTML via `window.functionName`
6. Test tab switching still works
7. Remove moved code from dashboard.html

### Function Exposure Pattern
```javascript
// frontend/js/tabs/orders.js
(function() {
  let oFilter = 'ALL';  // tab-local state
  
  async function loadOrders(s) { ... }
  function doFilterOrders(s, el) { ... }
  
  // Expose to window for onclick handlers
  window.loadOrders = loadOrders;
  window.doFilterOrders = doFilterOrders;
  // ... etc
})();
```

---

## Backup
- Original file backed up to `frontend/dashboard.html.backup` (9,043 lines)
