'use strict';

/**
 * Subscription cost calculation with proration.
 *
 * Handles:
 *  - Fixed monthly subscription costs
 *  - Multiple plans per account (mid-month changes)
 *  - Proration for partial months
 *  - Multiple accounts per provider
 */

const { readConfig, KNOWN_PROVIDERS } = require('./config');

/**
 * Calculate the number of days in a given month.
 */
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * Calculate prorated cost for a plan within a given month.
 *
 * @param {Object} plan - { name, monthlyCost, startDate, endDate }
 * @param {number} year - Year to calculate for
 * @param {number} month - Month (1-12) to calculate for
 * @returns {number} Prorated cost for this month
 */
function proratedCost(plan, year, month) {
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);
  const totalDays = daysInMonth(year, month);

  const planStart = new Date(plan.startDate);
  const planEnd = plan.endDate ? new Date(plan.endDate) : new Date(9999, 11, 31);

  // No overlap
  if (planStart > monthEnd || planEnd < monthStart) return 0;

  // Calculate active days in this month
  const effectiveStart = planStart > monthStart ? planStart : monthStart;
  const effectiveEnd = planEnd < monthEnd ? planEnd : monthEnd;

  const activeDays = Math.max(
    0,
    Math.ceil((effectiveEnd - effectiveStart) / (24 * 60 * 60 * 1000)) + 1
  );

  // If full month, return full cost
  if (activeDays >= totalDays) return plan.monthlyCost;

  // Prorate
  return (activeDays / totalDays) * plan.monthlyCost;
}

/**
 * Calculate subscription costs for a given month across all configured subscriptions.
 *
 * @param {number} year
 * @param {number} month (1-12)
 * @returns {Array} Array of { id, provider, accountLabel, planName, monthlyCost, proratedCost, activeDays, totalDays }
 */
function getSubscriptionCosts(year, month) {
  const config = readConfig();
  const results = [];
  const totalDays = daysInMonth(year, month);

  for (const sub of config.subscriptions) {
    const provName = (KNOWN_PROVIDERS[sub.provider] || KNOWN_PROVIDERS.other).name;

    for (const plan of sub.plans || []) {
      const cost = proratedCost(plan, year, month);
      if (cost > 0) {
        results.push({
          id: sub.id,
          provider: sub.provider,
          providerName: provName,
          accountLabel: sub.accountLabel,
          planName: plan.name,
          monthlyCost: plan.monthlyCost,
          proratedCost: cost,
          startDate: plan.startDate,
          endDate: plan.endDate,
          isPartial: cost < plan.monthlyCost,
          totalDays,
        });
      }
    }
  }

  return results;
}

/**
 * Generate subscription records suitable for dashboard embedding.
 * These are different from per-token records — they represent fixed monthly costs.
 *
 * @param {number} days - Number of days to look back
 * @returns {Array} Subscription cost records
 */
function getSubscriptionRecords(days = 30) {
  const now = new Date();
  const records = [];

  // Calculate for each month in the range
  const monthsSeen = new Set();

  for (let d = 0; d < days; d++) {
    const date = new Date(now - d * 24 * 60 * 60 * 1000);
    const key = `${date.getFullYear()}-${date.getMonth() + 1}`;
    if (monthsSeen.has(key)) continue;
    monthsSeen.add(key);

    const costs = getSubscriptionCosts(date.getFullYear(), date.getMonth() + 1);
    for (const c of costs) {
      records.push({
        type: 'subscription',
        source: `subscription-${c.provider}`,
        billingPath: `subscription/${c.provider}/${c.accountLabel}`,
        provider: c.provider,
        providerName: c.providerName,
        accountLabel: c.accountLabel,
        planName: c.planName,
        monthlyCost: c.monthlyCost,
        proratedCost: c.proratedCost,
        isPartial: c.isPartial,
        month: key,
        year: date.getFullYear(),
        monthNum: date.getMonth() + 1,
      });
    }
  }

  return records;
}

/**
 * Get total subscription cost for a given period.
 */
function getTotalSubscriptionCost(days = 30) {
  const records = getSubscriptionRecords(days);
  return records.reduce((s, r) => s + r.proratedCost, 0);
}

module.exports = {
  proratedCost,
  getSubscriptionCosts,
  getSubscriptionRecords,
  getTotalSubscriptionCost,
  daysInMonth,
};
