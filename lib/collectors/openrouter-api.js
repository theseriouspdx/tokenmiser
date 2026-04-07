'use strict';

const { httpGet } = require('../http');

/**
 * OpenRouter API collector.
 *
 * Two modes:
 *  1. Regular API key (OPENROUTER_API_KEY) — uses GET /api/v1/key
 *     Returns per-key usage summary (total, daily, weekly, monthly in USD).
 *     No per-model breakdown, but works out of the box.
 *
 *  2. Management key (OPENROUTER_MANAGEMENT_KEY) — uses GET /api/v1/activity
 *     Returns full per-model, per-day activity for the account.
 *     Requires creating a management key at openrouter.ai/settings/management-keys.
 *
 * CSV import remains the most detailed source (per-request with app_name).
 * This collector provides server-side billing totals for validation/summary.
 */
async function collect(apiKey, isManagement) {
  const headers = { Authorization: `Bearer ${apiKey}` };

  // Always fetch models for pricing data
  const models = await httpGet('openrouter.ai', '/api/v1/models', headers).catch(() => null);

  // Build pricing lookup
  const pricing = {};
  if (models?.data) {
    models.data.forEach((m) => {
      if (m.id && m.pricing) {
        pricing[m.id] = {
          prompt: parseFloat(m.pricing.prompt) || 0,
          completion: parseFloat(m.pricing.completion) || 0,
          name: m.name || m.id,
        };
      }
    });
  }

  const records = [];

  if (isManagement) {
    // ── Management key: full activity endpoint ──
    const activity = await httpGet('openrouter.ai', '/api/v1/activity', headers).catch(() => null);

    if (activity?.error) {
      throw new Error(activity.error.message || 'API error');
    }

    const activityData = Array.isArray(activity?.data) ? activity.data : [];
    activityData.forEach((entry) => {
      records.push({
        source: 'openrouter',
        billingPath: 'openrouter',
        type: 'api',
        estimated: false,
        date: entry.date || 'unknown',
        model: entry.model || entry.model_permaslug || 'unknown',
        modelName: pricing[entry.model]?.name || entry.model || 'unknown',
        promptTokens: parseInt(entry.prompt_tokens) || 0,
        completionTokens: parseInt(entry.completion_tokens) || 0,
        cost: parseFloat(entry.usage) || 0,
        requests: parseInt(entry.requests) || 0,
      });
    });

    return { records, pricing, sourceLabel: 'OpenRouter API (management key)' };
  }

  // ── Regular key: /api/v1/key usage summary ──
  const keyInfo = await httpGet('openrouter.ai', '/api/v1/key', headers).catch(() => null);

  if (keyInfo?.error) {
    throw new Error(keyInfo.error.message || 'API error');
  }

  const keyData = keyInfo?.data;
  if (!keyData) {
    return { records: [], pricing, sourceLabel: 'OpenRouter API (no data)' };
  }

  // The /api/v1/key endpoint returns usage totals, not per-model breakdown.
  // We create a single summary record per period.
  const totalUsage = parseFloat(keyData.usage) || 0;

  if (totalUsage > 0) {
    // Create a summary record — the CSV will have per-model detail
    const today = new Date().toISOString().slice(0, 10);
    records.push({
      source: 'openrouter',
      billingPath: 'openrouter',
      type: 'api',
      estimated: false,
      date: today,
      model: 'openrouter/account-total',
      modelName: 'OpenRouter Account Total',
      promptTokens: 0,
      completionTokens: 0,
      cost: totalUsage,
      requests: 0,
      isSummary: true, // Flag so dedup knows this is a total, not per-model
    });
  }

  return {
    records,
    pricing,
    sourceLabel: 'OpenRouter API (key summary)',
    keyInfo: {
      label: keyData.label || '',
      limit: keyData.limit || null,
      usage: totalUsage,
    },
  };
}

function detect() {
  return !!process.env.OPENROUTER_API_KEY || !!process.env.OPENROUTER_MANAGEMENT_KEY;
}

function envKey() {
  // Prefer management key if available, fall back to regular
  return process.env.OPENROUTER_MANAGEMENT_KEY || process.env.OPENROUTER_API_KEY;
}

function isManagementKey() {
  return !!process.env.OPENROUTER_MANAGEMENT_KEY;
}

module.exports = {
  name: 'OpenRouter API',
  slug: 'openrouter',
  type: 'api',
  detect,
  envKey,
  isManagementKey,
  collect,
  envVar: 'OPENROUTER_API_KEY',
};
