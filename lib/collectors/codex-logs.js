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
 * Each JSONL has a session_meta entry with model_provider (e.g. "openrouter"),
 * source (e.g. "vscode"), and usage in event_msg entries of type "token_count".
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
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

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
                    if (stat.mtimeMs > ninetyDaysAgo) {
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

/**
 * Parse a single Codex session file.
 * Reads session_meta for model_provider and source,
 * then accumulates token_count events for usage totals.
 */
function parseSession(filePath, date) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(Boolean);

  let modelProvider = 'unknown';
  let appSource = 'codex-cli';
  let sessionProject = '';
  const tokenEvents = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Extract session metadata
      if (entry.type === 'session_meta') {
        const payload = entry.payload || {};
        modelProvider = payload.model_provider || 'unknown';
        appSource = payload.source || 'cli'; // "vscode", "cli", etc.
        // Extract project from cwd or working_directory
        const cwd = payload.cwd || payload.working_directory || '';
        if (cwd) {
          sessionProject = path.basename(cwd);
        }
        continue;
      }

      // Extract token usage from token_count events
      if (entry.type === 'event_msg') {
        const payload = entry.payload || {};
        if (payload.type === 'token_count' && payload.info) {
          const lastUsage = payload.info.last_token_usage;
          if (lastUsage) {
            tokenEvents.push({
              input: lastUsage.input_tokens || 0,
              cached: lastUsage.cached_input_tokens || 0,
              output: lastUsage.output_tokens || 0,
              reasoning: lastUsage.reasoning_output_tokens || 0,
            });
          }
        }
      }
    } catch { /* skip malformed lines */ }
  }

  return { modelProvider, appSource, tokenEvents, date, project: sessionProject };
}

function collect() {
  const sessionsDir = path.join(HOME, '.codex', 'sessions');
  if (!fs.existsSync(sessionsDir)) return null;

  const sessionFiles = findSessionFiles(sessionsDir);
  if (sessionFiles.length === 0) return null;

  const dayModel = {};

  for (const { path: filePath, date } of sessionFiles) {
    try {
      const session = parseSession(filePath, date);
      if (session.tokenEvents.length === 0) continue;

      // Use the last token_count event (cumulative totals for the session)
      const lastEvent = session.tokenEvents[session.tokenEvents.length - 1];
      const input = lastEvent.input + lastEvent.cached;
      const output = lastEvent.output + lastEvent.reasoning;
      if (input === 0 && output === 0) continue;

      // Detect billing path: if provider is "openai" and no API key set, assume ChatGPT subscription
      let billingPath = session.modelProvider; // "openrouter", "openai", etc.
      if (billingPath === 'openai' && !process.env.OPENAI_API_KEY && !process.env.OPENAI_ADMIN_KEY) {
        billingPath = 'chatgpt-subscription';
      }

      const model = 'codex-session'; // Codex doesn't log per-model, just session totals
      const project = session.project || '';
      const key = `${date}|${model}|${billingPath}|${session.appSource}|${project}`;

      if (!dayModel[key]) {
        dayModel[key] = {
          date, model, billingPath, appSource: session.appSource,
          promptTokens: 0, completionTokens: 0, requests: 0, project,
        };
      }
      dayModel[key].promptTokens += input;
      dayModel[key].completionTokens += output;
      dayModel[key].requests += 1; // Each session file = 1 session
    } catch { /* skip unreadable files */ }
  }

  const records = Object.values(dayModel).map((agg) => {
    const pKey = Object.keys(CODEX_PRICING).find((k) =>
      agg.model.toLowerCase().includes(k)
    );
    const rates = pKey ? CODEX_PRICING[pKey] : { prompt: 0.0000025, completion: 0.000010 };
    const estimatedCost = agg.promptTokens * rates.prompt + agg.completionTokens * rates.completion;

    const isSubscription = agg.billingPath === 'chatgpt-subscription';

    return {
      source: 'codex-cli',
      billingPath: agg.billingPath,
      type: 'local-log',
      estimated: !isSubscription,
      date: agg.date,
      model: agg.model.includes('/') ? agg.model : `openai/${agg.model}`,
      modelName: agg.model,
      promptTokens: agg.promptTokens,
      completionTokens: agg.completionTokens,
      cost: isSubscription ? 0 : estimatedCost,
      requests: agg.requests,
      entrypoint: agg.appSource,
      project: agg.project,
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
