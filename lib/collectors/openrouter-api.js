'use strict';

const { httpGet } = require('../http');

/**
 * OpenRouter API collector.
 * Fetches activity data using OPENROUTER_API_KEY.
 */
async function collect(apiKey) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const [activity, models] = await Promise.all([
    httpGet('openrouter.ai', '/api/v1/activity', headers).catch(() => null),
    httpGet('openrouter.ai', '/api/v1/models', headers).catch(() => null),
  ]);

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
  const activityData = Array.isArray(activity?.data) ? activity.data : [];
  activityData.forEach((entry) => {
    records.push({
      source: 'openrouter',
      billingPath: 'openrouter',
      type: 'per-token',
      date: entry.date || 'unknown',
      model: entry.model || entry.model_permaslug || 'unknown',
      modelName: pricing[entry.model]?.name || entry.model || 'unknown',
      promptTokens: parseInt(entry.prompt_tokens) || 0,
      completionTokens: parseInt(entry.completion_tokens) || 0,
      cost: parseFloat(entry.usage) || 0,
      requests: parseInt(entry.requests) || 0,
    });
  });

  return { records, pricing, sourceLabel: 'OpenRouter API' };
}

function detect() {
  return !!process.env.OPENROUTER_API_KEY;
}

function envKey() {
  return process.env.OPENROUTER_API_KEY;
}

module.exports = {
  name: 'OpenRouter API',
  slug: 'openrouter',
  type: 'api',
  detect,
  envKey,
  collect,
  envVar: 'OPENROUTER_API_KEY',
};
