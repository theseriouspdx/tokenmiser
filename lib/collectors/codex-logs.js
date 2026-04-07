'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

/**
 * OpenAI Codex CLI log collector.
 *
 * Codex CLI stores session transcripts at:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Each JSONL line contains session event data including model usage.
 * Log format includes ISO 8601 timestamps and structured session data.
 */

const CODEX_PRICING = {
  'o3':       { prompt: 0.000010,   completion: 0.000040 },
  'o3-mini':  { prompt: 0.0000011,  completion: 0.0000044 },
  'o4-mini':  { prompt: 0.0000011,  completion: 0.0000044 },
  'gpt-4o':   { prompt: 0.0000025,  completion: 0.000010 },
  'gpt-4':    { prompt: 0.000030,   completion: 0.000060 },
};

function findSessionFiles(baseDir) {
  const files = [];
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  // Walk YYYY/MM/DD structure
  try {
    const years = fs.readdirSync(baseDir).filter((d) => /^\d{4}$/.test(d));
    for (const year of years) {
      const yearDir = path.join(baseDir, year);
      try {
        const months = fs.readdirSync(yearDir).filter((d) => /^\d{2}$/.test(d));
        for (const month of months) {
          const monthDir = path.join(yearDir, month);
          try {
            const days = fs.readdirSync(monthDir).filter((d) => /^\d{2}$/.test(d));
            for (const day of days) {
              const dayDir = path.join(monthDir, day);
              try {
                const sessionFiles = fs.readdirSync(dayDir).filter(
                  (f) => f.startsWith('rollout-') && f.endsWith('.jsonl')
                );
                for (const sf of sessionFiles) {
                  const full = path.join(dayDir, sf);
                  try {
                    const stat = fs.statSync(full);
                    if (stat.mtimeMs > thirtyDaysAgo) {
                      files.push({ path: full, date: `${year}-${month}-${day}` });
                    }
                  } catch {}
                }
              } catch {}
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}

  return files;
}

function collect() {
  const sessionsDir = path.join(HOME, '.codex', 'sessions');
  if (!fs.existsSync(sessionsDir)) return null;

  const sessionFiles = findSessionFiles(sessionsDir);
  if (sessionFiles.length === 0) return null;

  const dayModel = {};

  for (const { path: filePath, date } of sessionFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          // Look for usage data in various possible structures
          const usage = entry.usage || entry.message?.usage || {};
          const model = entry.model || entry.message?.model || 'codex-unknown';

          const input = usage.input_tokens || usage.prompt_tokens || 0;
          const output = usage.output_tokens || usage.completion_tokens || 0;
          if (input === 0 && output === 0) continue;

          const key = `${date}|${model}`;
          if (!dayModel[key]) {
            dayModel[key] = { date, model, promptTokens: 0, completionTokens: 0, requests: 0 };
          }
          dayModel[key].promptTokens += input;
          dayModel[key].completionTokens += output;
          dayModel[key].requests += 1;
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable files */ }
  }

  const records = Object.values(dayModel).map((agg) => {
    const pKey = Object.keys(CODEX_PRICING).find((k) =>
      agg.model.toLowerCase().includes(k)
    );
    const rates = pKey ? CODEX_PRICING[pKey] : { prompt: 0.0000025, completion: 0.000010 };
    const estimatedCost = agg.promptTokens * rates.prompt + agg.completionTokens * rates.completion;

    return {
      source: 'codex-cli',
      billingPath: 'local-estimate',
      type: 'local-log',
      estimated: true,
      date: agg.date,
      model: agg.model.includes('/') ? agg.model : `openai/${agg.model}`,
      modelName: agg.model,
      promptTokens: agg.promptTokens,
      completionTokens: agg.completionTokens,
      cost: estimatedCost,
      requests: agg.requests,
    };
  });

  return records.length > 0
    ? { records, pricing: CODEX_PRICING, sourceLabel: 'Codex CLI (local logs)' }
    : null;
}

function detect() {
  return fs.existsSync(path.join(HOME, '.codex', 'sessions'));
}

module.exports = {
  name: 'Codex CLI (local logs)',
  slug: 'codex-cli',
  type: 'local-log',
  detect,
  collect,
  logPath: '~/.codex/sessions/',
};
