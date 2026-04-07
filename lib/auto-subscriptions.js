'use strict';

/**
 * Auto-detect subscriptions from collected usage data.
 *
 * When no subscriptions are manually configured, infer them from billing paths
 * found in collected records. This gives users useful subscription data without
 * requiring manual config.
 *
 * Detection rules:
 *   - 'oauth' billing path from Claude Code → Claude Pro/Max subscription
 *   - 'google-subscription' from Gemini CLI → Gemini Advanced
 *   - 'chatgpt-subscription' from Codex CLI → ChatGPT Plus/Pro
 *   - 'cursor-subscription' from Cursor → Cursor Pro
 *
 * Auto-detected subscriptions are returned in the same format as configured ones
 * but flagged as autoDetected: true so the dashboard can show them differently.
 */

const { KNOWN_PROVIDERS } = require('./config');

/**
 * Map from billing path → subscription template.
 * monthlyCost is a conservative estimate (cheapest paid plan).
 */
const BILLING_PATH_MAP = {
  'oauth': {
    provider: 'anthropic',
    planName: 'Pro (detected)',
    monthlyCost: 20,
  },
  'google-subscription': {
    provider: 'google',
    planName: 'Advanced (detected)',
    monthlyCost: 20,
  },
  'chatgpt-subscription': {
    provider: 'openai',
    planName: 'Plus (detected)',
    monthlyCost: 20,
  },
  'cursor-subscription': {
    provider: 'cursor',
    planName: 'Pro (detected)',
    monthlyCost: 20,
  },
};

/**
 * Detect subscriptions from collected records.
 *
 * @param {Array} records - All collected records from detectAndCollect()
 * @returns {Array} Auto-detected subscription records in the same format
 *   as getSubscriptionRecords() but with autoDetected: true
 */
function detectSubscriptions(records) {
  if (!records || records.length === 0) return [];

  // Find unique subscription billing paths present in the data
  const detectedPaths = new Map(); // billingPath → { earliestDate, latestDate, totalRequests }

  for (const r of records) {
    const bp = r.billingPath;
    if (!BILLING_PATH_MAP[bp]) continue;

    if (!detectedPaths.has(bp)) {
      detectedPaths.set(bp, {
        earliestDate: r.date,
        latestDate: r.date,
        totalRequests: 0,
      });
    }

    const info = detectedPaths.get(bp);
    if (r.date < info.earliestDate) info.earliestDate = r.date;
    if (r.date > info.latestDate) info.latestDate = r.date;
    info.totalRequests += (r.requests || 1);
  }

  if (detectedPaths.size === 0) return [];

  const results = [];

  for (const [bp, info] of detectedPaths) {
    const template = BILLING_PATH_MAP[bp];
    const provName = (KNOWN_PROVIDERS[template.provider] || KNOWN_PROVIDERS.other).name;

    // Determine which months are covered
    const start = new Date(info.earliestDate);
    const end = new Date(info.latestDate);
    const monthsSeen = new Set();

    const cursor = new Date(start);
    while (cursor <= end) {
      monthsSeen.add(`${cursor.getFullYear()}-${cursor.getMonth() + 1}`);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    // Always include the end month
    monthsSeen.add(`${end.getFullYear()}-${end.getMonth() + 1}`);

    for (const monthKey of monthsSeen) {
      const [year, month] = monthKey.split('-').map(Number);

      results.push({
        type: 'subscription',
        source: `subscription-${template.provider}`,
        billingPath: `subscription/${template.provider}/auto-detected`,
        provider: template.provider,
        providerName: provName,
        accountLabel: 'Auto-detected',
        planName: template.planName,
        monthlyCost: template.monthlyCost,
        proratedCost: template.monthlyCost, // Full month assumed
        isPartial: false,
        month: monthKey,
        year,
        monthNum: month,
        autoDetected: true,
      });
    }
  }

  return results;
}

module.exports = {
  detectSubscriptions,
  BILLING_PATH_MAP,
};
