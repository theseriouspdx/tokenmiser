'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

/*
 * Gemini CLI (@google/gemini-cli) log collector.
 *
 * Gemini CLI stores session data at:
 *   ~/.gemini/tmp/{project}/chats/session-{timestamp}-{hash}.json
 *
 * Each session file is a JSON object with:
 *   { sessionId, projectHash, startTime, lastUpdated, kind, messages: [...] }
 *
 * Messages with type "gemini" contain:
 *   { id, timestamp, type: "gemini", tokens: { input, output, cached, thoughts, tool, total }, model }
 *
 * Billing paths:
 *   - oauth_creds.json present -> google-subscription (Gemini Advanced, $20/mo)
 *   - Otherwise -> google-api (per-token via API key or free tier)
 */

const GEMINI_PRICING = {
  'gemini-3.1-pro':    { prompt: 0.00000125, completion: 0.000010 },
  'gemini-3-pro':      { prompt: 0.00000125, completion: 0.000010 },
  'gemini-3-flash':    { prompt: 0.000000075, completion: 0.0000003 },
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
 * Detect whether ~/.gemini/tmp exists with chat session data.
 */
function detect() {
  const tmpDir = path.join(getGeminiDir(), 'tmp');
  if (!fs.existsSync(tmpDir)) return false;

  // Check for at least one project dir with a chats/ subdirectory
  try {
    const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        const chatsDir = path.join(tmpDir, e.name, 'chats');
        if (fs.existsSync(chatsDir)) return true;
      }
    }
  } catch { /* skip */ }

  return false;
}

/**
 * Detect billing path based on OAuth credentials.
 * If ~/.gemini/oauth_creds.json exists, the user is on a Google subscription.
 */
function detectBillingPath() {
  const oauthFile = path.join(getGeminiDir(), 'oauth_creds.json');
  if (fs.existsSync(oauthFile)) {
    return 'google-subscription';
  }
  return 'google-api';
}

/**
 * Find all session JSON files within the 90-day lookback window.
 * Path pattern: ~/.gemini/tmp/{project}/chats/session-*.json
 */
function findSessionFiles() {
  const tmpDir = path.join(getGeminiDir(), 'tmp');
  if (!fs.existsSync(tmpDir)) return [];

  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const files = [];

  try {
    const projectDirs = fs.readdirSync(tmpDir, { withFileTypes: true });
    for (const projEntry of projectDirs) {
      if (!projEntry.isDirectory()) continue;

      const chatsDir = path.join(tmpDir, projEntry.name, 'chats');
      if (!fs.existsSync(chatsDir)) continue;

      try {
        const chatFiles = fs.readdirSync(chatsDir);
        for (const fileName of chatFiles) {
          if (!fileName.startsWith('session-') || !fileName.endsWith('.json')) continue;

          const fullPath = path.join(chatsDir, fileName);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.mtimeMs > ninetyDaysAgo) {
              files.push({ path: fullPath, project: projEntry.name });
            }
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch { /* skip */ }

  return files;
}

/**
 * Parse a single session file and extract per-message usage data.
 * Returns array of { date, model, promptTokens, completionTokens, cachedTokens, requests, project }
 */
function parseSession(filePath, project) {
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return [];

  let session;
  try {
    session = JSON.parse(content);
  } catch {
    return [];
  }

  const messages = session.messages;
  if (!Array.isArray(messages)) return [];

  const results = [];

  for (const msg of messages) {
    if (msg.type !== 'gemini') continue;

    const tokens = msg.tokens;
    if (!tokens) continue;

    const input = tokens.input || 0;
    const output = tokens.output || 0;
    const cached = tokens.cached || 0;

    if (input === 0 && output === 0) continue;

    // Get date from message timestamp, falling back to session startTime
    const ts = msg.timestamp || session.startTime;
    let date;
    if (ts) {
      date = new Date(ts).toISOString().slice(0, 10);
    } else {
      // Last resort: extract date from filename (session-2026-03-25T20-01-...)
      const match = path.basename(filePath).match(/session-(\d{4}-\d{2}-\d{2})/);
      date = match ? match[1] : new Date().toISOString().slice(0, 10);
    }

    const model = (msg.model || 'gemini-unknown').replace(/^models\//, '');

    results.push({
      date,
      model,
      promptTokens: input + cached,
      completionTokens: output,
      cachedTokens: cached,
      project,
    });
  }

  return results;
}

function collect() {
  const sessionFiles = findSessionFiles();
  if (sessionFiles.length === 0) return null;

  const billingPath = detectBillingPath();
  const isSubscription = billingPath === 'google-subscription';

  // Aggregate by date|model|project
  const dayModel = {};

  for (const { path: filePath, project } of sessionFiles) {
    try {
      const usageData = parseSession(filePath, project);

      for (const u of usageData) {
        const key = `${u.date}|${u.model}|${u.project}`;

        if (!dayModel[key]) {
          dayModel[key] = {
            date: u.date,
            model: u.model,
            project: u.project,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            requests: 0,
          };
        }
        dayModel[key].promptTokens += u.promptTokens;
        dayModel[key].completionTokens += u.completionTokens;
        dayModel[key].cachedTokens += u.cachedTokens;
        dayModel[key].requests += 1;
      }
    } catch { /* skip unreadable files */ }
  }

  const records = Object.values(dayModel).map((agg) => {
    // Find pricing match — strip -preview suffix for matching
    const modelLower = agg.model.toLowerCase();
    const pKey = Object.keys(GEMINI_PRICING).find((k) =>
      modelLower.startsWith(k) || modelLower.includes(k)
    );
    const rates = pKey ? GEMINI_PRICING[pKey] : { prompt: 0.000001, completion: 0.000004 };
    const estimatedCost = agg.promptTokens * rates.prompt + agg.completionTokens * rates.completion;

    return {
      source: 'gemini-cli',
      billingPath,
      type: 'local-log',
      estimated: !isSubscription,
      date: agg.date,
      model: agg.model.includes('/') ? agg.model : `google/${agg.model}`,
      modelName: agg.model,
      promptTokens: agg.promptTokens,
      completionTokens: agg.completionTokens,
      cachedTokens: agg.cachedTokens,
      cost: isSubscription ? 0 : estimatedCost,
      requests: agg.requests,
      project: agg.project,
    };
  });

  return records.length > 0
    ? { records, pricing: GEMINI_PRICING, sourceLabel: 'Gemini CLI (local logs)' }
    : null;
}

module.exports = {
  name: 'Gemini CLI (local logs)',
  slug: 'gemini-cli',
  type: 'local-log',
  detect,
  collect,
  logPath: '~/.gemini/tmp/',
};
