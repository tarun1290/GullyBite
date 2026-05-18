// src/services/delivery/lspAdapter.js
// 3PL (LSP) abstraction layer. Normalizes provider-specific webhook
// events and issue/refund metadata onto one vendor-neutral shape so the
// rest of the codebase (proroutingState, issues, the debit-at-risk
// cron) is not coupled to Prorouting's field names. Extend the
// per-provider blocks as new 3PLs (Shadowfax, Dunzo, …) are onboarded.

'use strict';

const PROVIDERS = { PROROUTING: 'prorouting' };

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

// normalizeEvent(provider, rawPayload) → vendor-neutral event shape, or
// null for an unknown/unmapped event (callers should skip, not throw).
function normalizeEvent(provider, rawPayload) {
  if (!provider || !rawPayload) return null;

  if (provider === PROVIDERS.PROROUTING) {
    // Prorouting status webhooks: { status, order: {...}, agent/rider }.
    const body = rawPayload.order || rawPayload;
    const eventType = String(
      rawPayload.status || rawPayload.event || body.status || '',
    ).trim();
    if (!eventType) return null;

    const orderId = body.client_order_id || body.clientorderid
      || body.gullybite_order_id || rawPayload.client_order_id
      || rawPayload.order_id || null;
    if (!orderId) return null;

    const timestamp = body.timestamp || body.updated_at
      || rawPayload.timestamp || new Date().toISOString();
    const riderId = body.rider_id || body.agent_id
      || rawPayload.rider_id || rawPayload.agent?.id || null;

    return {
      provider: PROVIDERS.PROROUTING,
      order_id: String(orderId),
      event_type: eventType,
      timestamp,
      rider_id: riderId ? String(riderId) : null,
      metadata: rawPayload,
    };
  }

  // Unknown provider — no mapping yet.
  return null;
}

// getLspIssueFields(provider, data) → the lsp_* fields to $set on the
// order doc. data: { issue_id, issue_state, raised_at }. Only Prorouting
// is mapped today; unknown providers still get a shaped object so
// callers write consistently. lsp_escalation_deadline = raised_at + 12h.
function getLspIssueFields(provider, data = {}) {
  const raisedAt = data.raised_at instanceof Date
    ? data.raised_at
    : (data.raised_at ? new Date(data.raised_at) : new Date());
  const escalationDeadline = new Date(raisedAt.getTime() + TWELVE_HOURS_MS);
  return {
    lsp_provider: provider || null,
    lsp_issue_id: data.issue_id ?? null,
    lsp_issue_state: data.issue_state ?? null,
    lsp_issue_raised_at: raisedAt,
    lsp_escalation_deadline: escalationDeadline,
  };
}

// Refund eligibility per provider × issue category. Default true for any
// provider or category not explicitly listed (fail-open: an unmapped
// fault is treated as refundable; ops can still override either way).
const REFUND_ELIGIBILITY = {
  prorouting: {
    delivered_not_marked: true,
    fake_pickup: true,
    food_spillage: true,
    rude_agent: true,
    rider_runaway: true,
    delivery_late: true,
    delivery_not_received: true,
  },
  // Future: shadowfax: { ... }, dunzo: { ... }
};

function isRefundEligible(provider, category) {
  return REFUND_ELIGIBILITY[provider]?.[category] ?? true;
}

module.exports = {
  PROVIDERS,
  normalizeEvent,
  getLspIssueFields,
  REFUND_ELIGIBILITY,
  isRefundEligible,
};
