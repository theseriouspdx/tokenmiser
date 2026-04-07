'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

const CC_PRICING = {
  'claude-opus-4':   { prompt: 0.000015,  completion: 0.000075 },
  'claude-sonnet-4': { prompt: 0.000003,  completion: 0.000015 },
  'claude-haiku-4':  { prompt: 0.0000008, completion: 0.000004 },
};

function findJsonlFiles(dir, results, depth) {
  if (depth <= 0) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) {
        findJsonlFiles(full, results, depth - 1);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs > Date.now() - 30 * 24 * 60 * 60 * 1000) {
            results.push(full);
          }
        } catch {}
      }
    }
  } catch {}
}

/**
 * Infer billing path from model name format.
 * - Model with provider prefix (e.g. "anthropic/claude-4.6-sonnet", "deepseek/deepseek-chat-v3")
 *   → routed through OpenRouter or similar provider API (per-token billing)
 * - Model without prefix (e.g. "claude-sonnet-4-6", "claude-haiku-4-5-20251001")
 *   → OAuth / subscription billing (Claude Pro, Max, etc.)
 */
function inferBillingPath(model) {
  return model.includes('/') ? 'openrouter' : 'oauth';
}

function collect() {
  const claudeDir = path.join(HOME, '.claude');
  if (!fs.existsSync(claudeDir)) return null;

  const projectsDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  const jsonlFiles = [];
  try {
    findJsonlFiles(projectsDir, jsonlFiles, 5);
  } catch {
    return null;
  }

  if (jsonlFiles.length === 0) return null;

  const records = [];
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  // Aggregate by date + model + billingPath + entrypoint
  const dayModel = {};

  for (const file of jsonlFiles) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const msg = entry.message || {};
          const usage = msg.usage || entry.usage;
          if (!usage) continue;
          if (!usage.input_tokens && !usage.output_tokens && !usage.cache_creation_input_tokens) continue;

          const ts = entry.timestamp || entry.createdAt;
          if (!ts) continue;
          const time = typeof ts === 'number' ? ts : new Date(ts).getTime();
          if (time < thirtyDaysAgo) continue;

          const date = new Date(time).toISOString().slice(0, 10);
          const model = msg.model || entry.model || 'claude-unknown';
          const entrypoint = entry.entrypoint || 'unknown';
          const billingPath = inferBillingPath(model);
          const input = usage.input_tokens || 0;
          const output = usage.output_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;
          const cacheCreate = usage.cache_creation_input_tokens || 0;
          const totalInput = input + cacheRead + cacheCreate;

          // Key includes billing path and entrypoint so they stay separate
          const key = `${date}|${model}|${billingPath}|${entrypoint}`;
          if (!dayModel[key]) {
            dayModel[key] = { date, model, billingPath, entrypoint, promptTokens: 0, completionTokens: 0, requests: 0 };
          }
          dayModel[key].promptTokens += totalInput;
          dayModel[key].completionTokens += output;
          dayModel[key].requests += 1;
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable files */ }
  }

  Object.values(dayModel).forEach((agg) => {
    const pKey = Object.keys(CC_PRICING).find((k) =>
      agg.model.toLowerCase().includes(k.replace(/-\d+$/, ''))
    );
    const rates = pKey ? CC_PRICING[pKey] : { prompt: 0.000003, completion: 0.000015 };
    const estimatedCost = agg.promptTokens * rates.prompt + agg.completionTokens * rates.completion;

    // For OAuth billing, cost is covered by subscription — don't show estimated per-token cost
    const isOAuth = agg.billingPath === 'oauth';

    records.push({
      source: 'claude-code',
      billingPath: agg.billingPath,
      type: 'local-log',
      estimated: !isOAuth, // OAuth usage isn't estimated per-token, it's subscription
      date: agg.date,
      model: agg.model.includes('/') ? agg.model : `anthropic/${agg.model}`,
      modelName: agg.model,
      promptTokens: agg.promptTokens,
      completionTokens: agg.completionTokens,
      cost: isOAuth ? 0 : estimatedCost, // OAuth cost comes from subscription config, not per-token
      requests: agg.requests,
      entrypoint: agg.entrypoint,
    });
  });

  return records.length > 0
    ? { records, pricing: CC_PRICING, sourceLabel: 'Claude Code (local logs)' }
    : null;
}

function detect() {
  return fs.existsSync(path.join(HOME, '.claude', 'projects'));
}

module.exports = {
  name: 'Claude Code (local logs)',
  slug: 'claude-code',
  type: 'local-log',
  detect,
  collect,
  logPath: '~/.claude/projects/',
};
