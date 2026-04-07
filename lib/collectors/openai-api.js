'use strict';

const { httpGet } = require('../http');

/**
 * OpenAI Usage + Cost API collector — UPGRADED to use documented endpoints.
 *
 * Uses two endpoints:
 *  1. Usage API:  GET /v1/organization/usage/completions
 *     - Returns token counts grouped by model, bucketed by day
 *     - Auth: Authorization: Bearer (admin key)
 *
 *  2. Cost API:   GET /v1/organization/costs
 *     - Returns actual USD dollar amounts
 *     - More accurate than estimating from tokens
 *
 * Requires: OPENAI_ADMIN_KEY or OPENAI_API_KEY (admin-scoped)
 */

const OPENAI_PRICING = {
  'gpt-4-turbo':   { prompt: 0.000010,   completion: 0.000030 },
  'gpt-4o':        { prompt: 0.0000025,  completion: 0.000010 },
  'gpt-4o-mini':   { prompt: 0.00000015, completion: 0.0000006 },
  'gpt-4':         { prompt: 0.000030,   completion: 0.000060 },
  'o1':            { prompt: 0.000015,   completion: 0.000060 },
  'o1-mini':       { prompt: 0.000003,   completion: 0.000012 },
  'o3':            { prompt: 0.000010,   completion: 0.000040 },
  'o3-mini':       { prompt: 0.0000011,  completion: 0.0000044 },
  'o4-mini':       { prompt: 0.0000011,  completion: 0.0000044 },
};

function dateRange(days = 30) {
  const now = new Date();
  const start = new Date(now - days * 24 * 60 * 60 * 1000);
  return { start, now, startUnix: Math.floor(start.getTime() / 1000), endUnix: Math.floor(now.getTime() / 1000) };
}

/**
 * Fetch actual USD costs from the Cost API.
 */
async function fetchCosts(apiKey) {
  const { startUnix, endUnix } = dateRange(30);
  const headers = { Authorization: `Bearer ${apiKey}` };
  const urlPath = `/v1/organization/costs?start_time=${startUnix}&end_time=${endUnix}&bucket_width=1d`;

  try {
    const costData = await httpGet('api.openai.com', urlPath, headers);
    const costMap = {};
    const buckets = costData?.data || [];
    (Array.isArray(buckets) ? buckets : []).forEach((bucket) => {
      const date = bucket.start_time
        ? new Date(bucket.start_time * 1000).toISOString().slice(0, 10)
        : 'unknown';
      const amount = bucket.results
        ? bucket.results.reduce((s, r) => s + (r.amount?.value || 0), 0)
        : (bucket.amount?.value || 0);
      costMap[date] = (costMap[date] || 0) + amount;
    });
    return costMap;
  } catch {
    return null;
  }
}

/**
 * Fetch token usage from the Usage API.
 */
async function fetchUsage(apiKey) {
  const { startUnix, endUnix } = dateRange(30);
  const headers = { Authorization: `Bearer ${apiKey}` };

  // Documented endpoint with group_by
  const urlPath = `/v1/organization/usage/completions?start_time=${startUnix}&end_time=${endUnix}&bucket_width=1d&group_by[]=model`;

  let usage = null;
  try {
    usage = await httpGet('api.openai.com', urlPath, headers);
  } catch {
    // Try simpler legacy endpoint
    const start = new Date(startUnix * 1000).toISOString().slice(0, 10);
    try {
      usage = await httpGet('api.openai.com', `/v1/usage?date=${start}`, headers);
    } catch {
      return null;
    }
  }

  return usage;
}

async function collect(apiKey) {
  const [usage, costMap] = await Promise.all([
    fetchUsage(apiKey),
    fetchCosts(apiKey),
  ]);

  if (!usage) return null;

  const records = [];
  const buckets = usage?.data || usage?.buckets || [];
  (Array.isArray(buckets) ? buckets : []).forEach((bucket) => {
    const date = bucket.start_time
      ? new Date(bucket.start_time * 1000).toISOString().slice(0, 10)
      : bucket.date || 'unknown';
    const results = bucket.results || [bucket];

    results.forEach((r) => {
      const model = r.model || r.snapshot_id || 'gpt-unknown';
      const input = r.input_tokens || r.prompt_tokens || r.n_context_tokens_total || 0;
      const output = r.output_tokens || r.completion_tokens || r.n_generated_tokens_total || 0;

      // Prefer Cost API data, fall back to token estimation
      let cost;
      if (costMap && costMap[date] !== undefined) {
        cost = costMap[date]; // refined below for multi-model days
      } else {
        const pKey = Object.keys(OPENAI_PRICING).find((k) =>
          model.toLowerCase().includes(k)
        );
        const rates = pKey
          ? OPENAI_PRICING[pKey]
          : { prompt: 0.0000025, completion: 0.000010 };
        cost = input * rates.prompt + output * rates.completion;
      }

      records.push({
        source: 'openai',
        billingPath: 'openai-direct',
        type: 'per-token',
        date,
        model: `openai/${model}`,
        modelName: model,
        promptTokens: input,
        completionTokens: output,
        cost,
        requests: r.requests || r.n_requests || 1,
      });
    });
  });

  // Redistribute date-level costs proportionally if multiple models per day
  if (costMap) {
    const byDate = {};
    records.forEach((r) => {
      if (!byDate[r.date]) byDate[r.date] = [];
      byDate[r.date].push(r);
    });
    Object.entries(byDate).forEach(([date, dateRecords]) => {
      if (costMap[date] !== undefined && dateRecords.length > 1) {
        const totalTokens = dateRecords.reduce(
          (s, r) => s + r.promptTokens + r.completionTokens, 0
        );
        if (totalTokens > 0) {
          dateRecords.forEach((r) => {
            r.cost = costMap[date] * ((r.promptTokens + r.completionTokens) / totalTokens);
          });
        }
      }
    });
  }

  return { records, pricing: OPENAI_PRICING, sourceLabel: 'OpenAI Usage API' };
}

function detect() {
  return !!(process.env.OPENAI_ADMIN_KEY || process.env.OPENAI_API_KEY);
}

function envKey() {
  return process.env.OPENAI_ADMIN_KEY || process.env.OPENAI_API_KEY;
}

module.exports = {
  name: 'OpenAI Usage API',
  slug: 'openai',
  type: 'api',
  detect,
  envKey,
  collect,
  envVar: 'OPENAI_ADMIN_KEY or OPENAI_API_KEY',
};
