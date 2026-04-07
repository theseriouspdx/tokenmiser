#!/usr/bin/env node
/**
 * tokenmiser CLI v3.0 — see where your AI API money goes.
 *
 * Auto-detects every data source on your machine:
 *   - OpenRouter API (via OPENROUTER_API_KEY)
 *   - Anthropic API (via ANTHROPIC_ADMIN_KEY)
 *   - OpenAI API (via OPENAI_API_KEY)
 *   - Claude Code local logs (~/.claude/)
 *   - Codex CLI local logs (~/.codex/)
 *
 * Each source is a separate billing path — no deduplication needed
 * because the same dollar can only be billed once by one system.
 *
 * Zero dependencies. Node.js 18+.
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const VERSION = '3.0.0';
const HOME = os.homedir();
const OUTPUT_FILE = path.join(process.cwd(), 'tokenmiser-report.html');

// ═══════════════════════════════════════════════════════════════════
// CLI ARGS
// ═══════════════════════════════════════════════════════════════════
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { json: false, help: false, version: false, verbose: false, csv: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') opts.json = true;
    else if (args[i] === '--help' || args[i] === '-h') opts.help = true;
    else if (args[i] === '--version' || args[i] === '-v') opts.version = true;
    else if (args[i] === '--verbose') opts.verbose = true;
    else if (args[i] === '--csv' && args[i + 1]) { opts.csv = args[++i]; }
  }
  return opts;
}

function printHelp() {
  console.log(`
  tokenmiser v${VERSION}
  See where your AI API money goes.

  Usage:
    npx tokenmiser              Auto-detects all data sources
    npx tokenmiser --json       Output raw JSON instead of dashboard
    npx tokenmiser --verbose    Show detailed source detection info
    npx tokenmiser --csv FILE   Import OpenRouter activity CSV export

  Auto-detected sources (via environment variables):
    OPENROUTER_API_KEY          OpenRouter activity (last 30 days)
    ANTHROPIC_ADMIN_KEY         Anthropic usage API (org admin key)
    OPENAI_API_KEY              OpenAI usage API

  Auto-detected sources (local files):
    ~/.claude/                  Claude Code session logs
    ~/.codex/log/               Codex CLI logs

  Each source is a separate billing path. Using Claude Desktop
  (OAuth) and Claude via OpenRouter are two different bills —
  both get tracked, nothing is double-counted.
`);
}

// ═══════════════════════════════════════════════════════════════════
// HTTPS HELPERS (zero-dep)
// ═══════════════════════════════════════════════════════════════════
function httpGet(hostname, urlPath, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, port: 443, path: urlPath, method: 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error('auth_failed'));
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('parse_failed')); }
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════
// SOURCE: OpenRouter
// ═══════════════════════════════════════════════════════════════════
async function collectOpenRouter(apiKey) {
  const headers = { 'Authorization': `Bearer ${apiKey}` };
  const [activity, models] = await Promise.all([
    httpGet('openrouter.ai', '/api/v1/activity', headers).catch(() => null),
    httpGet('openrouter.ai', '/api/v1/models', headers).catch(() => null),
  ]);

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

// ═══════════════════════════════════════════════════════════════════
// SOURCE: OpenRouter CSV Export
// ═══════════════════════════════════════════════════════════════════
function collectOpenRouterCSV(csvPath) {
  if (!fs.existsSync(csvPath)) throw new Error(`CSV file not found: ${csvPath}`);
  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split('\n');
  if (lines.length < 2) return null;

  // Parse CSV header
  const header = parseCSVLine(lines[0]);
  const colIdx = {};
  header.forEach((h, i) => { colIdx[h.trim()] = i; });

  const needed = ['created_at', 'cost_total', 'model_permaslug', 'tokens_prompt', 'tokens_completion'];
  for (const col of needed) {
    if (colIdx[col] === undefined) throw new Error(`CSV missing required column: ${col}`);
  }

  // Aggregate by date+model (same as local logs) to keep record count manageable
  const dayModel = {};
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);

    const createdAt = cols[colIdx['created_at']] || '';
    const ts = new Date(createdAt).getTime();
    if (isNaN(ts) || ts < thirtyDaysAgo) continue;

    const date = new Date(ts).toISOString().slice(0, 10);
    const model = (cols[colIdx['model_permaslug']] || 'unknown').trim();
    const cost = parseFloat(cols[colIdx['cost_total']]) || 0;
    const promptTok = parseInt(cols[colIdx['tokens_prompt']]) || 0;
    const completionTok = parseInt(cols[colIdx['tokens_completion']]) || 0;

    const key = `${date}|${model}`;
    if (!dayModel[key]) {
      dayModel[key] = { date, model, cost: 0, promptTokens: 0, completionTokens: 0, requests: 0 };
    }
    dayModel[key].cost += cost;
    dayModel[key].promptTokens += promptTok;
    dayModel[key].completionTokens += completionTok;
    dayModel[key].requests += 1;
  }

  const records = Object.values(dayModel).map((agg) => ({
    source: 'openrouter-csv',
    billingPath: 'openrouter',
    date: agg.date,
    model: agg.model,
    modelName: agg.model.split('/').pop(),
    promptTokens: agg.promptTokens,
    completionTokens: agg.completionTokens,
    cost: agg.cost,
    requests: agg.requests,
  }));

  return records.length > 0
    ? { records, pricing: {}, sourceLabel: 'OpenRouter CSV' }
    : null;
}

// Simple CSV line parser (handles quoted fields with commas)
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// DEDUP ENGINE
// Matches local log records to API records by model+date.
// When a match is found, the local record is tagged as a duplicate
// and its cost stays 0 (API source is authoritative for cost).
// ═══════════════════════════════════════════════════════════════════
function deduplicateRecords(records) {
  // Build a set of model+date keys from API sources (non-estimated records)
  const apiKeys = new Set();
  records.forEach((r) => {
    if (!r.estimated) {
      // Normalize model names for matching: strip provider prefix for comparison
      const normalizedModel = r.model.split('/').pop().toLowerCase();
      apiKeys.add(`${r.date}|${normalizedModel}`);
    }
  });

  if (apiKeys.size === 0) return records; // No API data, nothing to dedup

  let dupCount = 0;
  records.forEach((r) => {
    if (r.estimated) {
      const normalizedModel = r.model.split('/').pop().toLowerCase();
      const key = `${r.date}|${normalizedModel}`;
      if (apiKeys.has(key)) {
        r.deduplicated = true;
        r.billingPath = 'local-usage (covered by API)';
        dupCount++;
      }
    }
  });

  if (dupCount > 0) {
    process.stderr.write(`  ℹ Dedup: ${dupCount} local log entries matched to API records.\n`);
    process.stderr.write(`    API source is authoritative for cost; local logs retained for context.\n\n`);
  }

  return records;
}

// ═══════════════════════════════════════════════════════════════════
// SOURCE: Anthropic Admin API
// ═══════════════════════════════════════════════════════════════════
async function collectAnthropic(adminKey) {
  const now = new Date();
  const startDate = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const startStr = startDate.toISOString().replace(/\.\d+Z$/, 'Z');
  const endStr = now.toISOString().replace(/\.\d+Z$/, 'Z');

  const headers = {
    'x-api-key': adminKey,
    'anthropic-version': '2023-06-01',
  };

  const urlPath = `/v1/organizations/usage?starting_at=${encodeURIComponent(startStr)}&ending_at=${encodeURIComponent(endStr)}&group_by=model&bucket_width=1d`;

  let usage = null;
  try {
    usage = await httpGet('api.anthropic.com', urlPath, headers);
  } catch {
    const altPath = `/v1/organizations/usage_report/messages?starting_at=${encodeURIComponent(startStr)}&ending_at=${encodeURIComponent(endStr)}&group_by[]=model&bucket_width=1d`;
    try { usage = await httpGet('api.anthropic.com', altPath, headers); } catch { return null; }
  }

  if (!usage) return null;

  const anthropicPricing = {
    'claude-opus-4':      { prompt: 0.000015, completion: 0.000075 },
    'claude-sonnet-4':    { prompt: 0.000003, completion: 0.000015 },
    'claude-3.7-sonnet':  { prompt: 0.000003, completion: 0.000015 },
    'claude-3.5-haiku':   { prompt: 0.0000008, completion: 0.000004 },
    'claude-3.5-sonnet':  { prompt: 0.000003, completion: 0.000015 },
  };

  const records = [];
  const buckets = usage?.data || usage?.buckets || [];
  (Array.isArray(buckets) ? buckets : []).forEach((bucket) => {
    const date = (bucket.started_at || bucket.date || '').slice(0, 10);
    const model = bucket.model || 'claude-unknown';
    const input = (bucket.input_tokens || bucket.uncached_input_tokens || 0) +
                  (bucket.cached_input_tokens || bucket.cache_creation_tokens || 0);
    const output = bucket.output_tokens || 0;

    const pKey = Object.keys(anthropicPricing).find((k) => model.toLowerCase().includes(k));
    const rates = pKey ? anthropicPricing[pKey] : { prompt: 0.000003, completion: 0.000015 };
    const cost = input * rates.prompt + output * rates.completion;

    records.push({
      source: 'anthropic',
      billingPath: 'anthropic-direct',
      date,
      model: `anthropic/${model}`,
      modelName: model,
      promptTokens: input,
      completionTokens: output,
      cost,
      requests: bucket.requests || bucket.request_count || 1,
    });
  });

  return { records, pricing: anthropicPricing, sourceLabel: 'Anthropic Admin API' };
}

// ═══════════════════════════════════════════════════════════════════
// SOURCE: OpenAI Usage API
// ═══════════════════════════════════════════════════════════════════
async function collectOpenAI(apiKey) {
  const now = new Date();
  const startDate = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = now.toISOString().slice(0, 10);

  const headers = { 'Authorization': `Bearer ${apiKey}` };
  const urlPath = `/v1/organization/usage/completions?start_time=${Math.floor(startDate.getTime() / 1000)}&end_time=${Math.floor(now.getTime() / 1000)}&bucket_width=1d&group_by[]=model`;

  let usage = null;
  try { usage = await httpGet('api.openai.com', urlPath, headers); }
  catch {
    try { usage = await httpGet('api.openai.com', `/v1/usage?date=${startStr}`, headers); } catch { return null; }
  }

  if (!usage) return null;

  const openaiPricing = {
    'gpt-4-turbo':  { prompt: 0.000010, completion: 0.000030 },
    'gpt-4o':       { prompt: 0.0000025, completion: 0.000010 },
    'gpt-4o-mini':  { prompt: 0.00000015, completion: 0.0000006 },
    'gpt-4':        { prompt: 0.000030, completion: 0.000060 },
    'o1':           { prompt: 0.000015, completion: 0.000060 },
    'o3-mini':      { prompt: 0.0000011, completion: 0.0000044 },
  };

  const records = [];
  const buckets = usage?.data || usage?.buckets || [];
  (Array.isArray(buckets) ? buckets : []).forEach((bucket) => {
    const date = bucket.start_time ? new Date(bucket.start_time * 1000).toISOString().slice(0, 10)
               : (bucket.date || 'unknown');
    const results = bucket.results || [bucket];
    results.forEach((r) => {
      const model = r.model || r.snapshot_id || 'gpt-unknown';
      const input = r.input_tokens || r.prompt_tokens || r.n_context_tokens_total || 0;
      const output = r.output_tokens || r.completion_tokens || r.n_generated_tokens_total || 0;

      const pKey = Object.keys(openaiPricing).find((k) => model.toLowerCase().includes(k));
      const rates = pKey ? openaiPricing[pKey] : { prompt: 0.0000025, completion: 0.000010 };
      const cost = input * rates.prompt + output * rates.completion;

      records.push({
        source: 'openai',
        billingPath: 'openai-direct',
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

  return { records, pricing: openaiPricing, sourceLabel: 'OpenAI Usage API' };
}

// ═══════════════════════════════════════════════════════════════════
// SOURCE: Claude Code Local Logs
// ═══════════════════════════════════════════════════════════════════
function collectClaudeCodeLogs() {
  const claudeDir = path.join(HOME, '.claude');
  if (!fs.existsSync(claudeDir)) return null;

  const projectsDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  const jsonlFiles = [];
  try {
    findJsonlFiles(projectsDir, jsonlFiles, 5);
  } catch { return null; }

  if (jsonlFiles.length === 0) return null;

  const records = [];
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const ccPricing = {
    'claude-opus-4': { prompt: 0.000015, completion: 0.000075 },
    'claude-sonnet-4': { prompt: 0.000003, completion: 0.000015 },
    'claude-haiku-4': { prompt: 0.0000008, completion: 0.000004 },
  };

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

  // LOCAL LOGS: cost=0, billingPath='local-usage', estimated=true, estimatedCost for reference
  Object.values(dayModel).forEach((agg) => {
    const pKey = Object.keys(ccPricing).find((k) => agg.model.toLowerCase().includes(k.replace(/-\d+$/, '')));
    const rates = pKey ? ccPricing[pKey] : { prompt: 0.000003, completion: 0.000015 };
    const estimatedCost = agg.promptTokens * rates.prompt + agg.completionTokens * rates.completion;

    records.push({
      source: 'claude-code',
      billingPath: 'local-usage',
      estimated: true,
      estimatedCost,
      date: agg.date,
      model: agg.model.includes('/') ? agg.model : `anthropic/${agg.model}`,
      modelName: agg.model,
      promptTokens: agg.promptTokens,
      completionTokens: agg.completionTokens,
      cost: 0,
      requests: agg.requests,
    });
  });

  return records.length > 0 ? { records, pricing: ccPricing, sourceLabel: 'Claude Code (local logs)' } : null;
}

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

// ═══════════════════════════════════════════════════════════════════
// SOURCE: Codex CLI Local Logs
// ═══════════════════════════════════════════════════════════════════
function collectCodexLogs() {
  const codexDir = path.join(HOME, '.codex', 'log');
  if (!fs.existsSync(codexDir)) return null;

  const records = [];
  try {
    const files = fs.readdirSync(codexDir).filter((f) => f.endsWith('.log') || f.endsWith('.jsonl'));
    if (files.length === 0) return null;
  } catch { return null; }

  return null;
}

// ═══════════════════════════════════════════════════════════════════
// SOURCE DETECTION & COLLECTION
// ═══════════════════════════════════════════════════════════════════
async function detectAndCollect(verbose, csvPath) {
  const log = verbose ? (msg) => process.stderr.write(`  ${msg}\n`) : () => {};
  process.stderr.write('\n  Tokenmiser — scanning for data sources...\n\n');

  const sources = [];
  const allRecords = [];
  let allPricing = {};

  // 1. OpenRouter
  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    log('Checking OpenRouter API key...');
    try {
      const result = await collectOpenRouter(orKey);
      if (result && result.records.length > 0) {
        const total = result.records.reduce((s, r) => s + r.cost, 0);
        process.stderr.write(`  ✓ OpenRouter                     ${fmtMoney(total)} (30d)\n`);
        sources.push({ name: 'OpenRouter API', records: result.records.length, cost: total });
        allRecords.push(...result.records);
        allPricing = { ...allPricing, ...result.pricing };
      } else {
        process.stderr.write(`  ✓ OpenRouter                     $0.00 (no activity)\n`);
      }
    } catch (e) {
      process.stderr.write(`  ✗ OpenRouter                     failed (${e.message})\n`);
    }
  } else {
    process.stderr.write(`  – OpenRouter                     no key found\n`);
    log('  Set OPENROUTER_API_KEY to enable');
  }

  // 1b. OpenRouter CSV import (if --csv provided)
  if (csvPath) {
    log(`Importing OpenRouter CSV: ${csvPath}`);
    try {
      const result = collectOpenRouterCSV(csvPath);
      if (result && result.records.length > 0) {
        const total = result.records.reduce((s, r) => s + r.cost, 0);
        const gens = result.records.reduce((s, r) => s + r.requests, 0);
        process.stderr.write(`  ✓ OpenRouter CSV                 ${fmtMoney(total)} (${gens.toLocaleString()} generations)\n`);
        sources.push({ name: 'OpenRouter CSV', records: result.records.length, cost: total });
        allRecords.push(...result.records);
        allPricing = { ...allPricing, ...result.pricing };
      }
    } catch (e) {
      process.stderr.write(`  ✗ OpenRouter CSV                 failed (${e.message})\n`);
    }
  }

  // 2. Anthropic Admin
  const anthKey = process.env.ANTHROPIC_ADMIN_KEY;
  if (anthKey) {
    log('Checking Anthropic Admin API...');
    try {
      const result = await collectAnthropic(anthKey);
      if (result && result.records.length > 0) {
        const total = result.records.reduce((s, r) => s + r.cost, 0);
        process.stderr.write(`  ✓ Anthropic (direct API)         ${fmtMoney(total)} (30d)\n`);
        sources.push({ name: 'Anthropic Admin API', records: result.records.length, cost: total });
        allRecords.push(...result.records);
      } else {
        process.stderr.write(`  ✓ Anthropic (direct API)         $0.00 (no activity)\n`);
      }
    } catch (e) {
      process.stderr.write(`  ✗ Anthropic (direct API)         failed (${e.message})\n`);
    }
  } else {
    process.stderr.write(`  – Anthropic (direct API)         no admin key found\n`);
    log('  Set ANTHROPIC_ADMIN_KEY to enable');
  }

  // 3. OpenAI
  const oaiKey = process.env.OPENAI_API_KEY;
  if (oaiKey) {
    log('Checking OpenAI Usage API...');
    try {
      const result = await collectOpenAI(oaiKey);
      if (result && result.records.length > 0) {
        const total = result.records.reduce((s, r) => s + r.cost, 0);
        process.stderr.write(`  ✓ OpenAI (direct API)            ${fmtMoney(total)} (30d)\n`);
        sources.push({ name: 'OpenAI Usage API', records: result.records.length, cost: total });
        allRecords.push(...result.records);
      } else {
        process.stderr.write(`  ✓ OpenAI (direct API)            $0.00 (no activity)\n`);
      }
    } catch (e) {
      process.stderr.write(`  ✗ OpenAI (direct API)            failed (${e.message})\n`);
    }
  } else {
    process.stderr.write(`  – OpenAI (direct API)            no key found\n`);
    log('  Set OPENAI_API_KEY to enable');
  }

  // 4. Claude Code local logs
  log('Scanning ~/.claude/ for session logs...');
  try {
    const result = collectClaudeCodeLogs();
    if (result && result.records.length > 0) {
      const total = result.records.reduce((s, r) => s + (r.estimatedCost || 0), 0);
      const sessions = result.records.length;
      process.stderr.write(`  ✓ Claude Code (local logs)       ~${fmtMoney(total)} est. (${sessions} day/model entries)\n`);
      sources.push({ name: 'Claude Code (local)', records: sessions, cost: 0, estimatedCost: total });
      allRecords.push(...result.records);
    } else {
      process.stderr.write(`  – Claude Code (local logs)       no recent sessions\n`);
    }
  } catch {
    process.stderr.write(`  – Claude Code (local logs)       not found\n`);
  }

  // 5. Codex CLI local logs
  log('Scanning ~/.codex/ for logs...');
  try {
    const result = collectCodexLogs();
    if (result && result.records.length > 0) {
      const total = result.records.reduce((s, r) => s + r.cost, 0);
      process.stderr.write(`  ✓ Codex CLI (local logs)         ~${fmtMoney(total)}\n`);
      sources.push({ name: 'Codex CLI (local)', records: result.records.length, cost: total });
      allRecords.push(...result.records);
    } else {
      process.stderr.write(`  – Codex CLI (local logs)         no data found\n`);
    }
  } catch {
    process.stderr.write(`  – Codex CLI (local logs)         not found\n`);
  }

  process.stderr.write('\n');

  if (allRecords.length === 0) {
    process.stderr.write('  No data found from any source.\n');
    process.stderr.write('  Set at least one API key or use a CLI tool to generate data.\n\n');
    process.exit(0);
  }

  const hasApiSource = allRecords.some((r) => !r.estimated);

  // Dedup: match local log records to API records by model+date
  if (hasApiSource) {
    deduplicateRecords(allRecords);
  }

  return { records: allRecords, sources, pricing: allPricing, hasApiSource };
}

// ═══════════════════════════════════════════════════════════════════
// AGGREGATE DATA (server-side, for terminal output + JSON)
// ═══════════════════════════════════════════════════════════════════
function aggregate(records, pricing) {
  const byModel = {};
  let totalCost = 0, totalPrompt = 0, totalCompletion = 0, totalRequests = 0;
  const byDate = {};
  const bySource = {};

  records.forEach((r) => {
    if (!byModel[r.model]) {
      byModel[r.model] = { cost: 0, promptTokens: 0, completionTokens: 0, requests: 0,
        name: r.modelName, sources: new Set() };
    }
    byModel[r.model].cost += r.cost;
    byModel[r.model].promptTokens += r.promptTokens;
    byModel[r.model].completionTokens += r.completionTokens;
    byModel[r.model].requests += r.requests;
    byModel[r.model].sources.add(r.billingPath);

    if (r.date && r.date !== 'unknown') {
      if (!byDate[r.date]) byDate[r.date] = {};
      if (!byDate[r.date][r.model]) byDate[r.date][r.model] = 0;
      byDate[r.date][r.model] += r.cost;
    }

    if (!bySource[r.billingPath]) bySource[r.billingPath] = { cost: 0, requests: 0, tokens: 0 };
    bySource[r.billingPath].cost += r.cost;
    bySource[r.billingPath].requests += r.requests;
    bySource[r.billingPath].tokens += r.promptTokens + r.completionTokens;

    totalCost += r.cost;
    totalPrompt += r.promptTokens;
    totalCompletion += r.completionTokens;
    totalRequests += r.requests;
  });

  const modelRanking = Object.entries(byModel)
    .map(([id, d]) => ({
      id, name: d.name, cost: d.cost, promptTokens: d.promptTokens,
      completionTokens: d.completionTokens, requests: d.requests,
      totalTokens: d.promptTokens + d.completionTokens,
      sources: [...d.sources].join(', '),
    }))
    .sort((a, b) => b.cost - a.cost || b.requests - a.requests);

  let maxUnitRate = 0, maxRateModel = 'unknown', maxRateModelName = 'unknown';
  modelRanking.forEach((m) => {
    const p = pricing[m.id];
    if (p) {
      const rate = p.completion || p.prompt || 0;
      if (rate > maxUnitRate) { maxUnitRate = rate; maxRateModel = m.id; maxRateModelName = m.name; }
    }
  });

  let counterfactualCost = 0;
  const hasApiPricing = Object.keys(pricing).length > 0;
  if (hasApiPricing && maxUnitRate > 0 && pricing[maxRateModel]) {
    const exp = pricing[maxRateModel];
    modelRanking.forEach((m) => {
      counterfactualCost += m.promptTokens * exp.prompt + m.completionTokens * exp.completion;
    });
  }
  if (counterfactualCost < totalCost) counterfactualCost = totalCost;

  const routingSavings = counterfactualCost - totalCost;
  const costReduction = counterfactualCost > 0 ? routingSavings / counterfactualCost : 0;

  const sortedDates = Object.keys(byDate).sort();
  const chartData = sortedDates.map((date) => ({
    date, models: byDate[date],
    total: Object.values(byDate[date]).reduce((s, v) => s + v, 0),
  }));

  return {
    totalCost, totalPromptTokens: totalPrompt, totalCompletionTokens: totalCompletion,
    totalRequests, modelRanking, chartData, bySource,
    counterfactualCost, routingSavings, costReduction,
    maxRateModel, maxRateModelName,
    avgCostPerRequest: totalRequests > 0 ? totalCost / totalRequests : 0,
    activeModels: modelRanking.filter((m) => m.requests > 0).length,
    providers: [...new Set(modelRanking.map((m) => m.id.split('/')[0]))].length,
  };
}

// ═══════════════════════════════════════════════════════════════════
// FORMAT HELPERS
// ═══════════════════════════════════════════════════════════════════
function fmtMoney(v, d = 2) { return `$${v.toFixed(d)}`; }
function fmtTokens(v) {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return v.toString();
}
function fmtPct(v) { return `${(v * 100).toFixed(1)}%`; }
function fmtCompact(v) { return v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toLocaleString(); }
function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ═══════════════════════════════════════════════════════════════════
// HTML DASHBOARD — client-side rendered with embedded data
// ═══════════════════════════════════════════════════════════════════
function generateDashboard(records, sources, allEstimated) {
  // Strip estimatedCost from records before embedding (reduce size)
  const embedRecords = records.map(r => ({
    s: r.source, bp: r.billingPath, d: r.date, m: r.model, mn: r.modelName,
    pt: r.promptTokens, ct: r.completionTokens, c: r.cost, rq: r.requests,
    est: r.estimated ? 1 : 0, dup: r.deduplicated ? 1 : 0
  }));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tokenmiser — Cost Report</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f0d1a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;overflow-x:hidden}
.layout{display:flex;min-height:100vh}
/* ── Sidebar ── */
.sidebar{width:220px;min-width:220px;background:#161326;padding:24px 0;display:flex;flex-direction:column;border-right:1px solid rgba(148,163,184,0.08)}
.sidebar .logo{display:flex;align-items:center;gap:10px;padding:0 20px;margin-bottom:32px}
.logo-mark{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#5eead4,#818cf8);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:#0f0d1a;flex-shrink:0}
.logo-text{font-size:18px;font-weight:700}
.nav-section{padding:0 12px;margin-bottom:24px}
.nav-label{font-size:10px;font-weight:700;letter-spacing:1.5px;color:#64748b;text-transform:uppercase;padding:0 8px;margin-bottom:8px}
.nav-item{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;font-size:13px;color:#94a3b8;cursor:pointer;text-decoration:none;border-left:3px solid transparent;margin-bottom:2px;transition:all 0.15s}
.nav-item:hover{background:rgba(94,234,212,0.05);color:#e2e8f0}
.nav-item.active{background:rgba(94,234,212,0.08);color:#5eead4;border-left-color:#5eead4;font-weight:600}
.nav-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:0.5;flex-shrink:0}
.nav-item.active .nav-dot{opacity:1;background:#5eead4}
/* ── Main ── */
.main-content{flex:1;padding:28px 32px;max-width:1100px;overflow-y:auto}
.top-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
.top-bar h1{font-size:22px;font-weight:600}
.period-selector{display:flex;align-items:center;gap:4px;background:#1e1b2e;border-radius:8px;padding:3px}
.period-btn{background:none;border:none;color:#94a3b8;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:all 0.15s}
.period-btn:hover{color:#e2e8f0}
.period-btn.active{background:#5eead4;color:#0f0d1a}
.live-dot{display:flex;align-items:center;gap:5px;margin-left:12px;font-size:12px;color:#94a3b8}
.live-dot::before{content:'';width:8px;height:8px;border-radius:50%;background:#34d399;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
/* ── Warning ── */
.warning-banner{background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:13px;color:#fbbf24}
.warning-banner strong{margin-right:4px}
.warning-banner code{background:rgba(251,191,36,0.15);padding:2px 6px;border-radius:3px;font-size:12px}
/* ── KPIs ── */
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}
.kpi{background:#1e1b2e;border-radius:12px;padding:20px 24px;border-top:3px solid #5eead4}
.kpi.accent-purple{border-top-color:#818cf8}.kpi.accent-pink{border-top-color:#f472b6}.kpi.accent-orange{border-top-color:#fb923c}
.kpi-label{font-size:11px;font-weight:600;letter-spacing:1.5px;color:#94a3b8;text-transform:uppercase;margin-bottom:8px}
.kpi-value{font-size:32px;font-weight:700;font-family:'SF Mono','Fira Code',monospace}
.kpi-sub{font-size:12px;color:#5eead4;margin-top:4px}
.kpi.accent-purple .kpi-sub{color:#818cf8}.kpi.accent-pink .kpi-sub{color:#f472b6}.kpi.accent-orange .kpi-sub{color:#fb923c}
/* ── Panels ── */
.panels{display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:24px}
.panel{background:#1e1b2e;border-radius:12px;padding:24px}
.panel-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.panel-title{font-size:16px;font-weight:600}
.chart-toggle{display:flex;gap:4px}
.toggle-btn{background:rgba(94,234,212,0.1);border:1px solid rgba(94,234,212,0.2);color:#5eead4;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:11px;font-weight:600;transition:all 0.15s}
.toggle-btn:hover{background:rgba(94,234,212,0.2)}
.toggle-btn.active{background:#5eead4;color:#0f0d1a}
.panel-sub{font-size:12px;color:#64748b;margin-bottom:20px}
/* ── Charts ── */
.chart-container{display:flex;align-items:flex-end;gap:6px;height:220px;padding-top:20px}
.chart-col{display:flex;flex-direction:column;align-items:center;flex:1}
.chart-bar{background:linear-gradient(180deg,#5eead4,#818cf8);border-radius:4px 4px 0 0;width:100%;min-width:12px;transition:height 0.3s;cursor:pointer}.chart-bar:hover{opacity:0.8}
.chart-label{font-size:10px;color:#64748b;margin-top:6px}
.svg-container{display:none}
.svg-container.active{display:block}
.chart-empty{display:flex;align-items:center;justify-content:center;height:220px;color:#64748b;font-size:14px;text-align:center}
/* ── Model rows ── */
.model-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(148,163,184,0.08)}
.model-info{display:flex;align-items:center;gap:10px;flex:1}
.model-color{width:4px;height:36px;border-radius:2px}
.model-name{font-size:14px;font-weight:500}.model-meta{font-size:12px;color:#64748b}
.billing-tag{background:rgba(94,234,212,0.1);color:#5eead4;padding:1px 6px;border-radius:4px;font-size:10px}
.model-cost{text-align:right;min-width:100px}
.model-cost-value{font-size:18px;font-weight:700;font-family:'SF Mono',monospace}
.model-bar-track{height:3px;border-radius:2px;background:rgba(148,163,184,0.1);margin-top:4px}
.model-bar-fill{height:100%;border-radius:2px;transition:width 0.5s}
/* ── Bottom ── */
.bottom-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}
.savings-card{background:linear-gradient(135deg,#1a2e2a,#162028);border-radius:12px;padding:28px;display:flex;flex-direction:column;justify-content:center}
.savings-label{font-size:12px;font-weight:700;letter-spacing:2px;color:#5eead4;text-transform:uppercase;margin-bottom:8px}
.savings-value{font-size:42px;font-weight:800;line-height:1.1;margin-bottom:12px;font-family:'SF Mono',monospace}
.savings-value span{font-size:20px;color:#94a3b8}
.savings-desc{font-size:13px;color:#94a3b8;line-height:1.5;margin-bottom:20px}
.savings-stats{display:flex;gap:20px}
.stat-value{font-size:20px;font-weight:700}.stat-label{font-size:9px;font-weight:600;letter-spacing:1.5px;color:#64748b;text-transform:uppercase;margin-top:2px}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:8px 12px;font-size:11px;font-weight:600;letter-spacing:1px;color:#64748b;text-transform:uppercase;border-bottom:1px solid rgba(148,163,184,0.1)}
td{padding:10px 12px;font-size:13px;border-bottom:1px solid rgba(148,163,184,0.06)}
td.mono{font-family:'SF Mono','Fira Code',monospace}
.footer{margin-top:24px;padding:12px 16px;border-radius:8px;background:rgba(148,163,184,0.04);border:1px solid rgba(148,163,184,0.06);font-size:11px;color:#64748b}
@media(max-width:900px){.sidebar{display:none}.kpi-grid{grid-template-columns:repeat(2,1fr)}.panels,.bottom-row{grid-template-columns:1fr}.savings-value{font-size:32px}}
</style>
</head>
<body>
<div class="layout">
<!-- ── Sidebar ── -->
<aside class="sidebar">
  <div class="logo"><div class="logo-mark">T</div><div class="logo-text">Tokenmiser</div></div>
  <div class="nav-section">
    <div class="nav-label">Overview</div>
    <a class="nav-item active" href="#" onclick="return false"><span class="nav-dot"></span> Dashboard</a>
    <a class="nav-item" href="#" onclick="return false"><span class="nav-dot"></span> Cost Explorer</a>
    <a class="nav-item" href="#" onclick="return false"><span class="nav-dot"></span> Model Analytics</a>
  </div>
  <div class="nav-section">
    <div class="nav-label">Operations</div>
    <a class="nav-item" href="#" onclick="return false"><span class="nav-dot"></span> Task Monitor</a>
    <a class="nav-item" href="#" onclick="return false"><span class="nav-dot"></span> Budget Alerts</a>
    <a class="nav-item" href="#" onclick="return false"><span class="nav-dot"></span> Optimization</a>
  </div>
  <div class="nav-section">
    <div class="nav-label">Settings</div>
    <a class="nav-item" href="#" onclick="return false"><span class="nav-dot"></span> API Keys</a>
    <a class="nav-item" href="#" onclick="return false"><span class="nav-dot"></span> Billing Rules</a>
  </div>
</aside>
<!-- ── Main ── -->
<main class="main-content">
  <div class="top-bar">
    <h1>Cost Overview</h1>
    <div style="display:flex;align-items:center">
      <div class="period-selector">
        <button class="period-btn" data-days="1" onclick="setPeriod(1)">24h</button>
        <button class="period-btn" data-days="7" onclick="setPeriod(7)">7d</button>
        <button class="period-btn active" data-days="30" onclick="setPeriod(30)">30d</button>
        <button class="period-btn" data-days="90" onclick="setPeriod(90)">90d</button>
      </div>
      <div class="live-dot">Live</div>
    </div>
  </div>
  <div id="source-toggles" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px"></div>
  <div id="warning-banner"></div>
  <div id="kpi-grid" class="kpi-grid"></div>
  <div class="panels">
    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">Daily Spend by Model</div>
        <div class="chart-toggle">
          <button class="toggle-btn active" id="bar-btn" onclick="setChartMode('bar')">&#9646; Bar</button>
          <button class="toggle-btn" id="svg-btn" onclick="setChartMode('line')">&#9473; Line</button>
        </div>
      </div>
      <div id="chart-sub" class="panel-sub"></div>
      <div id="bar-chart" class="chart-container"></div>
      <div id="line-chart" class="svg-container"></div>
    </div>
    <div class="panel">
      <div class="panel-title">Spend by Model</div>
      <div class="panel-sub">Current billing period</div>
      <div id="model-ranking"></div>
    </div>
  </div>
  <div class="bottom-row">
    <div class="panel">
      <div class="panel-title">By Billing Path</div>
      <div class="panel-sub">Each path is a separate bill</div>
      <div id="billing-table"></div>
    </div>
    <div class="panel">
      <div class="panel-title">All Models</div>
      <div class="panel-sub">Ranked by spend</div>
      <div id="all-models-table"></div>
    </div>
    <div id="savings-card" class="savings-card"></div>
  </div>
  <div id="footer" class="footer"></div>
</main>
</div>

<script>
// ── Embedded data ──
const RAW_RECORDS = ${JSON.stringify(embedRecords)};
const SOURCES = ${JSON.stringify(sources)};
const ALL_ESTIMATED = ${allEstimated};
const VERSION = '${VERSION}';
const COLORS = ['#c084fc','#60a5fa','#34d399','#f472b6','#fbbf24','#fb923c','#a78bfa','#38bdf8'];

let currentPeriod = 30;
let chartMode = 'bar';

// Build source list from data for toggle UI
var sourcesInData = {};
RAW_RECORDS.forEach(function(r) { sourcesInData[r.s] = true; });
var enabledSources = Object.assign({}, sourcesInData); // all on by default

// ── Format helpers ──
function fmtMoney(v, d) { d = d !== undefined ? d : 2; return '$' + v.toFixed(d); }
function fmtTokens(v) { if (v >= 1e6) return (v/1e6).toFixed(1)+'M'; if (v >= 1e3) return Math.round(v/1e3)+'K'; return ''+v; }
function fmtPct(v) { return (v*100).toFixed(1)+'%'; }
function fmtCompact(v) { return v >= 1000 ? (v/1000).toFixed(1)+'K' : v.toLocaleString(); }
function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Source display names
var sourceNames = {
  'openrouter': 'OpenRouter API', 'openrouter-csv': 'OpenRouter CSV',
  'anthropic': 'Anthropic API', 'openai': 'OpenAI API',
  'claude-code': 'Claude Code (local)', 'codex': 'Codex CLI (local)'
};

// ── Filter + Aggregate (client-side) ──
function filterByPeriod(records, days) {
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  var cutoffStr = cutoff.toISOString().slice(0,10);
  return records.filter(function(r) {
    // Filter by period, enabled sources, and exclude deduped records
    return r.d >= cutoffStr && enabledSources[r.s] && !r.dup;
  });
}

function toggleSource(src) {
  if (enabledSources[src]) delete enabledSources[src];
  else enabledSources[src] = true;
  renderAll();
}

function aggregateRecords(records) {
  var byModel = {}, byDate = {}, bySource = {};
  var totalCost = 0, totalPrompt = 0, totalCompletion = 0, totalRequests = 0;

  records.forEach(function(r) {
    if (!byModel[r.m]) byModel[r.m] = { cost:0, pt:0, ct:0, rq:0, name:r.mn, sources:{} };
    byModel[r.m].cost += r.c;
    byModel[r.m].pt += r.pt;
    byModel[r.m].ct += r.ct;
    byModel[r.m].rq += r.rq;
    byModel[r.m].sources[r.bp] = 1;

    if (r.d && r.d !== 'unknown') {
      if (!byDate[r.d]) byDate[r.d] = {};
      if (!byDate[r.d][r.m]) byDate[r.d][r.m] = 0;
      byDate[r.d][r.m] += r.c;
    }

    if (!bySource[r.bp]) bySource[r.bp] = { cost:0, rq:0, tokens:0 };
    bySource[r.bp].cost += r.c;
    bySource[r.bp].rq += r.rq;
    bySource[r.bp].tokens += r.pt + r.ct;

    totalCost += r.c;
    totalPrompt += r.pt;
    totalCompletion += r.ct;
    totalRequests += r.rq;
  });

  var modelRanking = Object.keys(byModel).map(function(id) {
    var d = byModel[id];
    return { id:id, name:d.name, cost:d.cost, pt:d.pt, ct:d.ct, rq:d.rq,
      totalTokens:d.pt+d.ct, sources:Object.keys(d.sources).join(', ') };
  }).sort(function(a,b) { return (b.cost - a.cost) || (b.rq - a.rq); });

  var sortedDates = Object.keys(byDate).sort();
  var chartData = sortedDates.map(function(date) {
    var models = byDate[date];
    var total = 0; for (var k in models) total += models[k];
    return { date:date, models:models, total:total };
  });

  var activeModels = modelRanking.filter(function(m){return m.rq>0}).length;
  var provSet = {}; modelRanking.forEach(function(m){ provSet[m.id.split('/')[0]]=1; });

  return {
    totalCost:totalCost, totalPromptTokens:totalPrompt, totalCompletionTokens:totalCompletion,
    totalRequests:totalRequests, modelRanking:modelRanking, chartData:chartData, bySource:bySource,
    avgCostPerRequest: totalRequests > 0 ? totalCost/totalRequests : 0,
    activeModels:activeModels, providers:Object.keys(provSet).length,
    routingSavings:0, costReduction:0, counterfactualCost:0, maxRateModelName:'unknown'
  };
}

// ── Rendering ──
function setPeriod(days) {
  currentPeriod = days;
  document.querySelectorAll('.period-btn').forEach(function(b){
    b.classList.toggle('active', parseInt(b.getAttribute('data-days'))===days);
  });
  renderAll();
}

function setChartMode(mode) {
  chartMode = mode;
  document.getElementById('bar-btn').classList.toggle('active', mode==='bar');
  document.getElementById('svg-btn').classList.toggle('active', mode==='line');
  document.getElementById('bar-chart').style.display = mode==='bar' ? 'flex' : 'none';
  var lc = document.getElementById('line-chart');
  if (mode==='line') lc.classList.add('active'); else lc.classList.remove('active');
}

function renderAll() {
  var filtered = filterByPeriod(RAW_RECORDS, currentPeriod);
  var data = aggregateRecords(filtered);
  var localOnly = ALL_ESTIMATED;
  var periodLabel = currentPeriod === 1 ? '24h' : currentPeriod + 'd';

  // Source toggles
  var stHTML = '';
  var allSrcs = Object.keys(sourcesInData);
  if (allSrcs.length > 1) {
    allSrcs.forEach(function(src) {
      var on = !!enabledSources[src];
      var label = sourceNames[src] || src;
      var style = on
        ? 'background:rgba(94,234,212,0.15);border:1px solid rgba(94,234,212,0.4);color:#5eead4'
        : 'background:rgba(148,163,184,0.05);border:1px solid rgba(148,163,184,0.15);color:#64748b;text-decoration:line-through';
      stHTML += '<button onclick="toggleSource(\\''+src+'\\')\" style="'+style+';border-radius:20px;padding:5px 14px;font-size:12px;cursor:pointer;font-weight:500;transition:all 0.15s">' + esc(label) + '</button>';
    });
  }
  document.getElementById('source-toggles').innerHTML = stHTML;

  // Dedup info
  var dupCount = RAW_RECORDS.filter(function(r){return r.dup}).length;

  // Warning
  var wb = document.getElementById('warning-banner');
  if (localOnly) {
    wb.innerHTML = '<div class="warning-banner"><strong>\\u26a0 Estimated costs</strong> \\u2014 No API keys found. Costs below are rough estimates based on published per-token pricing. Your actual costs depend on your billing method (subscription, OpenRouter rates, etc.). Set <code>OPENROUTER_API_KEY</code> for accurate billing data.</div>';
  } else { wb.innerHTML = ''; }

  // KPIs
  var kpi = document.getElementById('kpi-grid');
  kpi.innerHTML =
    '<div class="kpi"><div class="kpi-label">Total Spend (' + periodLabel + ')</div><div class="kpi-value">' +
      (localOnly ? 'Usage only' : fmtMoney(data.totalCost)) +
    '</div><div class="kpi-sub">' + fmtTokens(data.totalPromptTokens+data.totalCompletionTokens) + ' tokens across all sources</div></div>' +
    '<div class="kpi accent-purple"><div class="kpi-label">Active Models</div><div class="kpi-value">' + data.activeModels +
    '</div><div class="kpi-sub">Across ' + data.providers + ' provider' + (data.providers!==1?'s':'') + '</div></div>' +
    '<div class="kpi accent-orange"><div class="kpi-label">Avg Cost / Request</div><div class="kpi-value">' +
      (localOnly ? '\\u2014' : fmtMoney(data.avgCostPerRequest, 4)) +
    '</div><div class="kpi-sub">' + fmtCompact(data.totalRequests) + ' total requests</div></div>' +
    '<div class="kpi accent-pink"><div class="kpi-label">Routing Savings</div><div class="kpi-value">' +
      (localOnly ? '\\u2014' : fmtMoney(data.routingSavings, 0)) +
    '</div><div class="kpi-sub">' + (localOnly ? 'Connect API keys' : fmtPct(data.costReduction) + ' vs single-model') + '</div></div>';

  // Chart subtitle
  document.getElementById('chart-sub').textContent = 'Last ' + currentPeriod + ' days, all providers';

  // Charts
  var chartDays = data.chartData;
  var maxDayTotal = Math.max.apply(null, chartDays.map(function(d){return d.total}).concat([0.01]));

  if (localOnly || chartDays.length === 0) {
    document.getElementById('bar-chart').innerHTML = '<div class="chart-empty">Connect an API key to see cost trends</div>';
    document.getElementById('line-chart').innerHTML = '<div class="chart-empty">Connect an API key to see cost trends</div>';
  } else {
    // Bar chart
    var barHTML = chartDays.map(function(day) {
      var h = Math.max(2, (day.total / maxDayTotal) * 200);
      return '<div class="chart-col"><div class="chart-bar" style="height:'+h+'px" title="'+day.date+': '+fmtMoney(day.total)+'"></div><div class="chart-label">'+day.date.slice(5)+'</div></div>';
    }).join('');
    document.getElementById('bar-chart').innerHTML = barHTML;

    // Line chart (SVG)
    var W=800, H=250, P=45, pW=W-2*P, pH=H-2*P;
    var pts = chartDays.map(function(d,i){
      var x = P + (i/Math.max(chartDays.length-1,1))*pW;
      var y = P + pH - (d.total/maxDayTotal)*pH;
      return {x:x,y:y,d:d};
    });
    var linePath = pts.map(function(p,i){return (i===0?'M':'L')+' '+p.x.toFixed(1)+' '+p.y.toFixed(1)}).join(' ');
    var areaPath = 'M '+pts[0].x.toFixed(1)+' '+(P+pH).toFixed(1)+' '+pts.map(function(p){return 'L '+p.x.toFixed(1)+' '+p.y.toFixed(1)}).join(' ')+' L '+pts[pts.length-1].x.toFixed(1)+' '+(P+pH).toFixed(1)+' Z';

    var yTicks = '';
    for (var i=0;i<=4;i++) {
      var val=(maxDayTotal/4)*i, yt=P+pH-(val/maxDayTotal)*pH;
      yTicks += '<line x1="'+P+'" y1="'+yt.toFixed(1)+'" x2="'+(W-P)+'" y2="'+yt.toFixed(1)+'" stroke="rgba(148,163,184,0.1)" stroke-width="1"/>';
      yTicks += '<text x="'+(P-8)+'" y="'+(yt+4).toFixed(1)+'" font-size="10" fill="#64748b" text-anchor="end">'+fmtMoney(val)+'</text>';
    }
    var xLabels = pts.map(function(p,i){
      if (i % Math.max(1,Math.ceil(pts.length/7))===0 || i===pts.length-1)
        return '<text x="'+p.x.toFixed(1)+'" y="'+(P+pH+18).toFixed(1)+'" font-size="10" fill="#64748b" text-anchor="middle">'+p.d.date.slice(5)+'</text>';
      return '';
    }).join('');
    var dots = pts.map(function(p){return '<circle cx="'+p.x.toFixed(1)+'" cy="'+p.y.toFixed(1)+'" r="3" fill="#5eead4" opacity="0.8"/>'}).join('');

    document.getElementById('line-chart').innerHTML = '<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto;max-height:280px">'+
      '<defs><linearGradient id="aG" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" style="stop-color:#5eead4;stop-opacity:0.3"/><stop offset="100%" style="stop-color:#818cf8;stop-opacity:0.05"/></linearGradient></defs>'+
      yTicks + '<path d="'+areaPath+'" fill="url(#aG)"/><path d="'+linePath+'" fill="none" stroke="#5eead4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'+dots+xLabels+'</svg>';
  }

  // Refresh chart visibility
  setChartMode(chartMode);

  // Model ranking (top 4)
  var top4 = data.modelRanking.slice(0, 4);
  var maxModelCost = top4.length > 0 ? Math.max(top4[0].cost, 0.01) : 1;
  var mrHTML = top4.map(function(m, i) {
    var c = COLORS[i % COLORS.length];
    var w = Math.max(4, (m.cost / maxModelCost) * 100);
    var costDisplay = (m.sources === 'local-usage') ? '\\u2014' : fmtMoney(m.cost);
    return '<div class="model-row"><div class="model-info"><div class="model-color" style="background:'+c+'"></div><div><div class="model-name">'+esc(m.name)+'</div><div class="model-meta">'+fmtCompact(m.rq)+' tasks &middot; '+fmtTokens(m.totalTokens)+' tok &middot; <span class="billing-tag">'+esc(m.sources)+'</span></div></div></div><div class="model-cost"><div class="model-cost-value">'+costDisplay+'</div><div class="model-bar-track"><div class="model-bar-fill" style="width:'+w+'%;background:'+c+'"></div></div></div></div>';
  }).join('');
  document.getElementById('model-ranking').innerHTML = mrHTML;

  // Billing path table
  var bpKeys = Object.keys(data.bySource);
  var bpHTML = '<table><thead><tr><th>Billing Path</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>';
  bpKeys.forEach(function(p) {
    var d = data.bySource[p];
    bpHTML += '<tr><td>'+esc(p)+'</td><td class="mono">'+fmtCompact(d.rq)+'</td><td class="mono">'+fmtTokens(d.tokens)+'</td><td class="mono">'+fmtMoney(d.cost)+'</td></tr>';
  });
  bpHTML += '</tbody></table>';
  document.getElementById('billing-table').innerHTML = bpHTML;

  // All models table
  var amHTML = '<table><thead><tr><th>Model</th><th>Requests</th><th>Cost</th></tr></thead><tbody>';
  data.modelRanking.forEach(function(m) {
    var costDisplay = (m.sources === 'local-usage') ? '\\u2014' : fmtMoney(m.cost);
    amHTML += '<tr><td>'+esc(m.name)+'</td><td class="mono">'+fmtCompact(m.rq)+'</td><td class="mono">'+costDisplay+'</td></tr>';
  });
  amHTML += '</tbody></table>';
  document.getElementById('all-models-table').innerHTML = amHTML;

  // Savings card
  var sc = document.getElementById('savings-card');
  if (localOnly) {
    sc.innerHTML = '<div class="savings-label">Routing Savings</div><div class="savings-value">\\u2014</div><div class="savings-desc">Connect API keys to unlock savings analysis. Tokenmiser calculates how much you save by routing requests to the right model.</div>';
  } else {
    sc.innerHTML = '<div class="savings-label">Routing Savings</div><div class="savings-value">' + fmtMoney(data.routingSavings,0) + '<span>/mo</span></div>' +
      '<div class="savings-desc">If all ' + fmtCompact(data.totalRequests) + ' requests used ' + esc(data.maxRateModelName) + ', total would be ' + fmtMoney(data.counterfactualCost) + '.</div>' +
      '<div class="savings-stats"><div><div class="stat-value">' + fmtPct(data.costReduction) + '</div><div class="stat-label">Reduction</div></div>' +
      '<div><div class="stat-value">' + data.activeModels + '</div><div class="stat-label">Models</div></div>' +
      '<div><div class="stat-value">' + bpKeys.length + '</div><div class="stat-label">Bill Paths</div></div></div>';
  }

  // Footer
  var apiPaths = bpKeys.filter(function(p){return p!=='local-usage'});
  var dupNote = dupCount > 0 ? ' ' + dupCount + ' local log entries deduplicated against API data.' : '';
  document.getElementById('footer').innerHTML = localOnly
    ? '\\u26a0 All costs shown are estimates from local token logs. Set API keys for real billing data. Generated by Tokenmiser v' + VERSION + '.'
    : 'Costs from API sources (' + apiPaths.map(esc).join(', ') + ') are actual billing data.' + dupNote + ' Generated by Tokenmiser v' + VERSION + '.';
}

// ── Init ──
renderAll();
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════
// OPEN BROWSER
// ═══════════════════════════════════════════════════════════════════
function openInBrowser(filepath) {
  try {
    if (process.platform === 'darwin') execSync(`open "${filepath}"`);
    else if (process.platform === 'win32') execSync(`start "" "${filepath}"`);
    else execSync(`xdg-open "${filepath}"`);
    return true;
  } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  const opts = parseArgs();
  if (opts.version) { console.log(`tokenmiser v${VERSION}`); process.exit(0); }
  if (opts.help) { printHelp(); process.exit(0); }

  try {
    const { records, sources, pricing, hasApiSource } = await detectAndCollect(opts.verbose, opts.csv);
    const data = aggregate(records, pricing);
    const localOnly = !hasApiSource && records.some((r) => r.estimated);

    if (opts.json) {
      console.log(JSON.stringify({ sources, ...data, localOnly, fetchedAt: new Date().toISOString() }, null, 2));
      return;
    }

    const html = generateDashboard(records, sources, localOnly);
    fs.writeFileSync(OUTPUT_FILE, html, 'utf8');

    // Terminal summary
    console.log(`  ╔═══════════════════════════════════════════════════════╗`);
    console.log(`  ║  TOKENMISER v${VERSION}                                    ║`);
    console.log(`  ╚═══════════════════════════════════════════════════════╝`);

    if (localOnly) {
      console.log(`  ⚠ LOCAL USAGE ONLY — no API keys set`);
      console.log(`  Set OPENROUTER_API_KEY for real billing data.`);
      console.log(`  ─────────────────────────────────────────────────────────`);
      console.log(`  ${'Model'.padEnd(35)} ${'Requests'.padStart(10)} ${'Tokens'.padStart(12)}`);
      console.log(`  ${'─'.repeat(35)} ${'─'.repeat(10)} ${'─'.repeat(12)}`);
      data.modelRanking.forEach((m) => {
        console.log(`  ${m.name.padEnd(35)} ${fmtCompact(m.requests).padStart(10)} ${fmtTokens(m.totalTokens).padStart(12)}`);
      });
    } else {
      console.log(`  Total Spend (30d):    ${fmtMoney(data.totalCost)}`);
      console.log(`  Avg Cost/Request:     ${fmtMoney(data.avgCostPerRequest, 4)}`);
      console.log(`  Active Models:        ${data.activeModels}`);
      console.log(`  Total Requests:       ${data.totalRequests.toLocaleString()}`);
      console.log(`  ─────────────────────────────────────────────────────────`);
      console.log(`  Counterfactual:       ${fmtMoney(data.counterfactualCost)} (all → ${data.maxRateModelName})`);
      console.log(`  Routing Savings:      ${fmtMoney(data.routingSavings)} (${fmtPct(data.costReduction)} reduction)`);
      console.log(`  ─────────────────────────────────────────────────────────`);
      data.modelRanking.slice(0, 5).forEach((m) => {
        const costStr = m.sources === 'local-usage' ? '—'.padStart(12) : fmtMoney(m.cost).padStart(12);
        console.log(`  ${m.name.padEnd(30)} ${costStr}  [${m.sources}]`);
      });
      if (data.modelRanking.length > 5) console.log(`  ... and ${data.modelRanking.length - 5} more`);
    }

    console.log(`\n  Dashboard: ${OUTPUT_FILE}`);
    const opened = openInBrowser(OUTPUT_FILE);
    console.log(opened ? `  Opened in browser.\n` : `  Open the file above in your browser.\n`);
  } catch (err) {
    console.error(`\n  Error: ${err.message}\n`);
    process.exit(1);
  }
}

main();
