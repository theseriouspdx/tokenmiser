'use strict';

const { httpGet } = require('../http');

/**
 * Anthropic Admin API collector — UPGRADED to use documented endpoints.
 *
 * Uses two endpoints:
 *  1. Usage API:  GET /v1/organizations/usage_report/messages
 *     - Returns token counts grouped by model, bucketed by day
 *     - Auth: x-api-key + anthropic-version header
 *
 *  2. Cost API:   GET /v1/organizations/cost_report
 *     - Returns actual USD costs (as decimal strings in cents)
 *     - More accurate than estimating from tokens
 *
 * Requires: ANTHROPIC_ADMIN_KEY (sk-ant-admin-...)
 */

// Static pricing fallback if Cost API is unavailable
const ANTHROPIC_PRICING = {
  'claude-opus-4':        { prompt: 0.000015,  completion: 0.000075 },
  'claude-sonnet-4':      { prompt: 0.000003,  completion: 0.000015 },
  'claude-3.7-sonnet':    { prompt: 0.000003,  completion: 0.000015 },
  'claude-3.5-sonnet':    { prompt: 0.000003,  completion: 0.000015 },
  'claude-3.5-haiku':     { prompt: 0.0000008, completion: 0.000004 },
  'claude-3-opus':        { prompt: 0.000015,  completion: 0.000075 },
  'claude-3-haiku':       { prompt: 0.00000025, completion: 0.00000125 },
};

function buildHeaders(adminKey) {
  return {
    'x-api-key': adminKey,
    'anthropic-version': '2023-06-01',
  };
}

function dateRange(days = 30) {
  const now = new Date();
  const start = new Date(now - days * 24 * 60 * 60 * 1000);
  return {
    startStr: start.toISOString().replace(/\.\d+Z$/, 'Z'),
    endStr: now.toISOString().replace(/\.\d+Z$/, 'Z'),
  };
}

/**
 * Fetch actual USD costs from the Cost API.
 * Returns a map of { "YYYY-MM-DD|model": costInDollars }
 */
async function fetchCosts(adminKey) {
  const { startStr, endStr } = dateRange(30);
  const headers = buildHeaders(adminKey);
  const urlPath = `/v1/organizations/cost_report?starting_at=${encodeURIComponent(startStr)}&ending_at=${encodeURIComponent(endStr)}&bucket_width=1d`;

  try {
    const costData = await httpGet('api.anthropic.com', urlPath, headers);
    const costMap = {};
    const buckets = costData?.data || costData?.buckets || [];
    (Array.isArray(buckets) ? buckets : []).forEach((bucket) => {
      const date = (bucket.started_at || bucket.date || '').slice(0, 10);
      // Cost API may report workspace-level costs; sum them per date
      const costCents = parseFloat(bucket.cost || bucket.amount || 0);
      // Cost API reports in cents as decimal strings — convert to dollars
      const costDollars = costCents / 100;
      const key = date;
      costMap[key] = (costMap[key] || 0) + costDollars;
    });
    return costMap;
  } catch {
    return null; // Cost API unavailable — fall back to token estimation
  }
}

/**
 * Fetch token usage from the Usage API.
 */
async function fetchUsage(adminKey) {
  const { startStr, endStr } = dateRange(30);
  const headers = buildHeaders(adminKey);

  // Try the documented endpoint first
  const urlPath = `/v1/organizations/usage_report/messages?starting_at=${encodeURIComponent(startStr)}&ending_at=${encodeURIComponent(endStr)}&group_by[]=model&bucket_width=1d`;

  let usage = null;
  try {
    usage = await httpGet('api.anthropic.com', urlPath, headers);
  } catch {
    // Try alternate endpoint path (older API versions)
    const altPath = `/v1/organizations/usage?starting_at=${encodeURIComponent(startStr)}&ending_at=${encodeURIComponent(endStr)}&group_by=model&bucket_width=1d`;
    try {
      usage = await httpGet('api.anthropic.com', altPath, headers);
    } catch {
      return null;
    }
  }

  return usage;
}

async function collect(adminKey) {
  // Fetch usage and costs in parallel
  const [usage, costMap] = await Promise.all([
    fetchUsage(adminKey),
    fetchCosts(adminKey),
  ]);

  if (!usage) return null;

  const records = [];
  const buckets = usage?.data || usage?.buckets || [];
  (Array.isArray(buckets) ? buckets : []).forEach((bucket) => {
    const date = (bucket.started_at || bucket.date || '').slice(0, 10);
    const model = bucket.model || 'claude-unknown';
    const input =
      (bucket.input_tokens || bucket.uncached_input_tokens || 0) +
      (bucket.cached_input_tokens || bucket.cache_creation_tokens || 0);
    const output = bucket.output_tokens || 0;

    // Prefer Cost API data if available, else estimate from tokens
    let cost;
    if (costMap && costMap[date] !== undefined) {
      // Distribute date-level cost proportionally by tokens in this bucket
      // (Cost API may not break down by model — distribute by token weight)
      cost = costMap[date]; // Will be refined below if multiple models per day
    } else {
      // Fall back to token-based estimation
      const pKey = Object.keys(ANTHROPIC_PRICING).find((k) =>
        model.toLowerCase().includes(k)
      );
      const rates = pKey
        ? ANTHROPIC_PRICING[pKey]
        : { prompt: 0.000003, completion: 0.000015 };
      cost = input * rates.prompt + output * rates.completion;
    }

    records.push({
      source: 'anthropic',
      billingPath: 'anthropic-direct',
      type: 'per-token',
      date,
      model: `anthropic/${model}`,
      modelName: model,
      promptTokens: input,
      completionTokens: output,
      cost,
      requests: bucket.requests || bucket.request_count || 1,
    });
  });

  // If we got cost data at the date level but have multiple models per day,
  // redistribute proportionally by token count within each day
  if (costMap) {
    const byDate = {};
    records.forEach((r) => {
      if (!byDate[r.date]) byDate[r.date] = [];
      byDate[r.date].push(r);
    });

    Object.entries(byDate).forEach(([date, dateRecords]) => {
      if (costMap[date] !== undefined && dateRecords.length > 1) {
        const totalTokens = dateRecords.reduce(
          (s, r) => s + r.promptTokens + r.completionTokens,
          0
        );
        if (totalTokens > 0) {
          dateRecords.forEach((r) => {
            const tokenShare = (r.promptTokens + r.completionTokens) / totalTokens;
            r.cost = costMap[date] * tokenShare;
          });
        }
      }
    });
  }

  return { records, pricing: ANTHROPIC_PRICING, sourceLabel: 'Anthropic Admin API' };
}

function detect() {
  return !!process.env.ANTHROPIC_ADMIN_KEY;
}

function envKey() {
  return process.env.ANTHROPIC_ADMIN_KEY;
}

module.exports = {
  name: 'Anthropic Admin API',
  slug: 'anthropic',
  type: 'api',
  detect,
  envKey,
  collect,
  envVar: 'ANTHROPIC_ADMIN_KEY',
};
