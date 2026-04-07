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
          const input = usage.input_tokens || 0;
          const output = usage.output_tokens || 0;
          const cacheRead = usage.cache_read_input_tokens || 0;
          const cacheCreate = usage.cache_creation_input_tokens || 0;
          const totalInput = input + cacheRead + cacheCreate;

          const key = `${date}|${model}`;
          if (!dayModel[key]) {
            dayModel[key] = { date, model, promptTokens: 0, completionTokens: 0, requests: 0 };
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

    records.push({
      source: 'claude-code',
      billingPath: 'local-estimate',
      type: 'local-log',
      estimated: true,
      date: agg.date,
      model: agg.model.includes('/') ? agg.model : `anthropic/${agg.model}`,
      modelName: agg.model,
      promptTokens: agg.promptTokens,
      completionTokens: agg.completionTokens,
      cost: estimatedCost,
      requests: agg.requests,
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
