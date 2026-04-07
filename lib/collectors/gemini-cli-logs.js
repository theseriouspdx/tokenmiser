'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

/**
 * Gemini CLI (@google/gemini-cli) log collector.
 *
 * Gemini CLI stores data at:
 *   ~/.gemini/
 *     logs/sessions/     — session transcripts
 *     history/           — conversation history
 *
 * Session files are JSONL with entries containing:
 *   - Session metadata (model, auth type)
 *   - Request/response pairs with usage stats
 *
 * Billing paths:
 *   - Google AI Studio API key → per-token (free tier or paid)
 *   - Gemini Advanced subscription → OAuth/subscription ($20/mo)
 *   - Vertex AI → per-token (GCP billing)
 *
 * Note: Gemini CLI log format is not yet fully stable. This collector
 * uses best-effort parsing and is flagged as experimental.
 */

const GEMINI_PRICING = {
  'gemini-2.5-pro':    { prompt: 0.00000125, completion: 0.000010 },
  'gemini-2.5-flash':  { prompt: 0.000000075, completion: 0.0000003 },
  'gemini-2.0-flash':  { prompt: 0.0000001,  completion: 0.0000004 },
  'gemini-1.5-pro':    { prompt: 0.00000125, completion: 0.000005 },
  'gemini-1.5-flash':  { prompt: 0.000000075, completion: 0.0000003 },
};

function getGeminiDir() {
  return path.join(HOME, '.gemini');
}

/**
 * Find session files in ~/.gemini/ — searches logs/sessions/ and history/
 */
function findSessionFiles() {
  const geminiDir = getGeminiDir();
  const files = [];
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  // Search patterns for session data
  const searchDirs = [
    path.join(geminiDir, 'logs', 'sessions'),
    path.join(geminiDir, 'logs'),
    path.join(geminiDir, 'history'),
    path.join(geminiDir, 'sessions'),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      walkDir(dir, files, thirtyDaysAgo, 3);
    } catch { /* skip unreadable dirs */ }
  }

  return files;
}

function walkDir(dir, files, thirtyDaysAgo, depth) {
  if (depth <= 0) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) {
        walkDir(full, files, thirtyDaysAgo, depth - 1);
      } else if (e.isFile() && (e.name.endsWith('.jsonl') || e.name.endsWith('.json'))) {
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs > thirtyDaysAgo) {
            files.push(full);
          }
        } catch { /* skip unreadable files */ }
      }
    }
  } catch { /* skip unreadable dirs */ }
}

/**
 * Parse a session file for usage data.
 * Handles both JSONL (one JSON per line) and single JSON array formats.
 */
function parseSessionFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return [];

  const entries = [];

  // Try JSONL first (one JSON object per line)
  const lines = content.split('\n').filter(Boolean);
  let isJsonl = false;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      entries.push(entry);
      isJsonl = true;
    } catch {
      // Not valid JSONL line
    }
  }

  // If not JSONL, try single JSON array/object
  if (!isJsonl) {
    try {
      const data = JSON.parse(content);
      if (Array.isArray(data)) {
        entries.push(...data);
      } else {
        entries.push(data);
      }
    } catch { /* skip unparseable files */ }
  }

  return entries;
}

/**
 * Extract usage data from parsed entries.
 * Gemini CLI entries may contain:
 *   - usageMetadata with promptTokenCount, candidatesTokenCount, totalTokenCount
 *   - model name
 *   - timestamps
 */
function extractUsage(entries, fileStat) {
  const results = [];

  for (const entry of entries) {
    // Look for usage metadata in various locations
    const usage = entry.usageMetadata || entry.usage_metadata ||
                  entry.usage || entry.tokenCount ||
                  (entry.response && (entry.response.usageMetadata || entry.response.usage_metadata));

    if (!usage) continue;

    const promptTokens = usage.promptTokenCount || usage.prompt_token_count ||
                         usage.input_tokens || usage.prompt_tokens || 0;
    const completionTokens = usage.candidatesTokenCount || usage.candidates_token_count ||
                             usage.output_tokens || usage.completion_tokens || 0;
    const cachedTokens = usage.cachedContentTokenCount || usage.cached_content_token_count || 0;

    if (promptTokens === 0 && completionTokens === 0) continue;

    // Extract model name
    const model = entry.model || entry.modelVersion || entry.model_version ||
                  (entry.request && entry.request.model) || 'gemini-unknown';

    // Extract timestamp
    const ts = entry.timestamp || entry.created_at || entry.createTime ||
               (entry.request && entry.request.timestamp);
    let time;
    if (ts) {
      time = typeof ts === 'number' ? ts : new Date(ts).getTime();
    } else {
      time = fileStat.mtimeMs;
    }

    const date = new Date(time).toISOString().slice(0, 10);

    results.push({
      date,
      model: model.replace(/^models\//, ''), // Strip "models/" prefix
      promptTokens: promptTokens + cachedTokens,
      completionTokens,
    });
  }

  return results;
}

/**
 * Infer billing path from model name and context.
 * Gemini models accessed via:
 *  - Google AI Studio API key → 'google-api'
 *  - Gemini Advanced subscription → 'google-subscription'
 *  - Vertex AI → 'vertex-ai'
 *
 * Heuristic: Gemini CLI defaults to Google AI Studio API key auth.
 * If we can't determine auth type, assume API key (per-token).
 */
function inferBillingPath(model) {
  // Vertex AI models often have specific naming
  if (model.includes('vertex') || model.includes('publishers/')) {
    return 'vertex-ai';
  }
  // Default: Google AI Studio API key (per-token, possibly free tier)
  return 'google-api';
}

function collect() {
  const sessionFiles = findSessionFiles();
  if (sessionFiles.length === 0) return null;

  const dayModel = {};

  for (const filePath of sessionFiles) {
    try {
      const stat = fs.statSync(filePath);
      const entries = parseSessionFile(filePath);
      const usageData = extractUsage(entries, stat);

      for (const u of usageData) {
        const billingPath = inferBillingPath(u.model);
        const key = `${u.date}|${u.model}|${billingPath}`;

        if (!dayModel[key]) {
          dayModel[key] = {
            date: u.date, model: u.model, billingPath,
            promptTokens: 0, completionTokens: 0, requests: 0,
          };
        }
        dayModel[key].promptTokens += u.promptTokens;
        dayModel[key].completionTokens += u.completionTokens;
        dayModel[key].requests += 1;
      }
    } catch { /* skip unreadable files */ }
  }

  const records = Object.values(dayModel).map((agg) => {
    // Find pricing match
    const pKey = Object.keys(GEMINI_PRICING).find((k) =>
      agg.model.toLowerCase().includes(k)
    );
    const rates = pKey ? GEMINI_PRICING[pKey] : { prompt: 0.000001, completion: 0.000004 };
    const estimatedCost = agg.promptTokens * rates.prompt + agg.completionTokens * rates.completion;

    const isSubscription = agg.billingPath === 'google-subscription';

    return {
      source: 'gemini-cli',
      billingPath: agg.billingPath,
      type: 'local-log',
      estimated: !isSubscription,
      date: agg.date,
      model: agg.model.includes('/') ? agg.model : `google/${agg.model}`,
      modelName: agg.model,
      promptTokens: agg.promptTokens,
      completionTokens: agg.completionTokens,
      cost: isSubscription ? 0 : estimatedCost,
      requests: agg.requests,
    };
  });

  return records.length > 0
    ? { records, pricing: GEMINI_PRICING, sourceLabel: 'Gemini CLI (local logs)' }
    : null;
}

function detect() {
  const geminiDir = getGeminiDir();
  if (!fs.existsSync(geminiDir)) return false;

  // Check for any of the known data directories
  const dataDirs = ['logs', 'history', 'sessions'];
  for (const d of dataDirs) {
    if (fs.existsSync(path.join(geminiDir, d))) return true;
  }

  return false;
}

module.exports = {
  name: 'Gemini CLI (local logs)',
  slug: 'gemini-cli',
  type: 'local-log',
  detect,
  collect,
  logPath: '~/.gemini/',
  experimental: true,
};
