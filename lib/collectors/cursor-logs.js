'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const HOME = os.homedir();

/**
 * Cursor IDE usage collector (EXPERIMENTAL).
 *
 * Cursor stores data in SQLite databases:
 *   macOS:  ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *   Linux:  ~/.config/Cursor/User/globalStorage/state.vscdb
 *
 * Tables:
 *   - ItemTable: key-value store with JSON blobs (settings, auth, chat data)
 *   - cursorDiskKV: chat history, composer data, message bubbles
 *
 * Token counts in cursorDiskKV are "best-effort" — often show 0 because
 * Cursor's backend returns token data after streaming ends, and the client
 * doesn't always capture it. We track request counts and whatever token
 * data is available.
 *
 * Cursor is subscription-based ($20/mo Hobby, $40/mo Pro, $40/mo Business).
 * All records are marked as subscription billing — no per-token cost.
 *
 * Requires: sqlite3 command-line tool (usually pre-installed on macOS)
 */

const CURSOR_PRICING = {
  'claude-sonnet-4':    { prompt: 0.000003,  completion: 0.000015 },
  'claude-3.5-sonnet':  { prompt: 0.000003,  completion: 0.000015 },
  'gpt-4o':             { prompt: 0.0000025, completion: 0.000010 },
  'gpt-4o-mini':        { prompt: 0.00000015, completion: 0.0000006 },
  'cursor-small':       { prompt: 0.000001,  completion: 0.000002 },
};

function getCursorDbPath() {
  const platform = os.platform();
  if (platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  } else if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  } else {
    return path.join(HOME, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
}

/**
 * Check if sqlite3 CLI is available.
 */
function hasSqlite3() {
  try {
    execSync('which sqlite3 2>/dev/null || where sqlite3 2>NUL', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a sqlite3 query and return the output as string.
 */
function sqliteQuery(dbPath, query) {
  try {
    const result = execSync(
      `sqlite3 -json "${dbPath}" "${query.replace(/"/g, '\\"')}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 10 * 1024 * 1024 }
    );
    return JSON.parse(result.toString());
  } catch {
    return null;
  }
}

/**
 * Fallback: run query with separator output instead of JSON
 */
function sqliteQueryRaw(dbPath, query) {
  try {
    const result = execSync(
      `sqlite3 -separator '|||' "${dbPath}" "${query.replace(/"/g, '\\"')}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 10 * 1024 * 1024 }
    );
    return result.toString().trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Extract chat/composer data from cursorDiskKV table.
 * Keys follow patterns like: composerData:<id>, bubbleId:<composerId>:<bubbleId>
 */
function extractComposerData(dbPath) {
  const records = [];
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

  // Try to get composer data entries
  const rows = sqliteQueryRaw(dbPath,
    "SELECT key, length(value) FROM cursorDiskKV WHERE key LIKE 'composerData:%' OR key LIKE 'bubbleId:%' LIMIT 5000"
  );

  if (rows.length === 0) {
    // Fallback: try ItemTable for chat data
    const itemRows = sqliteQueryRaw(dbPath,
      "SELECT key FROM ItemTable WHERE key LIKE '%composer%' OR key LIKE '%chat%' OR key LIKE '%aichat%' LIMIT 100"
    );

    // Try to extract from ItemTable chat entries
    for (const row of itemRows) {
      const key = row.split('|||')[0];
      if (!key) continue;

      try {
        const valueRows = sqliteQueryRaw(dbPath,
          `SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}'`
        );
        if (valueRows.length === 0) continue;

        const value = valueRows[0];
        // Try to parse as JSON and extract usage
        const data = JSON.parse(value);
        extractFromChatData(data, records, ninetyDaysAgo);
      } catch { /* skip unparseable entries */ }
    }

    return records;
  }

  // Parse composer data for token counts
  for (const row of rows) {
    const parts = row.split('|||');
    const key = parts[0];
    if (!key || !key.startsWith('composerData:')) continue;

    try {
      const valueRows = sqliteQueryRaw(dbPath,
        `SELECT value FROM cursorDiskKV WHERE key = '${key.replace(/'/g, "''")}'`
      );
      if (valueRows.length === 0) continue;

      const value = valueRows[0];
      const data = JSON.parse(value);
      extractFromComposer(data, records, ninetyDaysAgo);
    } catch { /* skip unparseable entries */ }
  }

  return records;
}

function extractFromComposer(data, records, ninetyDaysAgo) {
  // Composer data typically has: createdAt, model, messages with tokenCount
  const createdAt = data.createdAt || data.created_at || data.timestamp;
  if (!createdAt) return;

  const time = typeof createdAt === 'number' ? createdAt : new Date(createdAt).getTime();
  if (time < ninetyDaysAgo) return;

  const date = new Date(time).toISOString().slice(0, 10);
  const model = data.model || data.selectedModel || 'cursor-unknown';

  // Try to get token counts from messages
  let inputTokens = 0;
  let outputTokens = 0;
  let requestCount = 0;

  const messages = data.messages || data.conversation || [];
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const tc = msg.tokenCount || msg.token_count || {};
      inputTokens += tc.inputTokens || tc.input_tokens || 0;
      outputTokens += tc.outputTokens || tc.output_tokens || 0;
      if (msg.type === 2 || msg.role === 'assistant') requestCount++;
    }
  }

  // Even if token counts are 0, record the request for volume tracking
  if (requestCount > 0 || inputTokens > 0 || outputTokens > 0) {
    records.push({
      date,
      model,
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      requests: Math.max(requestCount, 1),
    });
  }
}

function extractFromChatData(data, records, ninetyDaysAgo) {
  // Handle array of chat sessions
  const sessions = Array.isArray(data) ? data : [data];

  for (const session of sessions) {
    if (!session) continue;

    const createdAt = session.createdAt || session.created_at || session.timestamp;
    if (!createdAt) continue;

    const time = typeof createdAt === 'number' ? createdAt : new Date(createdAt).getTime();
    if (time < ninetyDaysAgo) continue;

    const date = new Date(time).toISOString().slice(0, 10);
    const model = session.model || session.selectedModel || 'cursor-unknown';

    records.push({
      date,
      model,
      promptTokens: session.totalInputTokens || 0,
      completionTokens: session.totalOutputTokens || 0,
      requests: session.messageCount || session.turnCount || 1,
    });
  }
}

function collect() {
  const dbPath = getCursorDbPath();
  if (!fs.existsSync(dbPath)) return null;
  if (!hasSqlite3()) {
    process.stderr.write('  ⚠ Cursor DB found but sqlite3 not available. Install sqlite3 to enable Cursor tracking.\n');
    return null;
  }

  const rawRecords = extractComposerData(dbPath);
  if (rawRecords.length === 0) return null;

  // Aggregate by date + model
  const dayModel = {};
  for (const r of rawRecords) {
    const key = `${r.date}|${r.model}`;
    if (!dayModel[key]) {
      dayModel[key] = { date: r.date, model: r.model, promptTokens: 0, completionTokens: 0, requests: 0 };
    }
    dayModel[key].promptTokens += r.promptTokens;
    dayModel[key].completionTokens += r.completionTokens;
    dayModel[key].requests += r.requests;
  }

  const records = Object.values(dayModel).map((agg) => {
    return {
      source: 'cursor',
      billingPath: 'cursor-subscription',
      type: 'local-log',
      estimated: false, // Subscription — cost comes from config, not per-token
      date: agg.date,
      model: agg.model.includes('/') ? agg.model : `cursor/${agg.model}`,
      modelName: agg.model,
      promptTokens: agg.promptTokens,
      completionTokens: agg.completionTokens,
      cost: 0, // Subscription cost tracked via config system
      requests: agg.requests,
    };
  });

  return records.length > 0
    ? { records, pricing: CURSOR_PRICING, sourceLabel: 'Cursor IDE (local, experimental)' }
    : null;
}

function detect() {
  return fs.existsSync(getCursorDbPath());
}

module.exports = {
  name: 'Cursor (experimental)',
  slug: 'cursor',
  type: 'local-log',
  detect,
  collect,
  logPath: getCursorDbPath(),
  experimental: true,
};
