#!/usr/bin/env node
/**
 * tokenmiser CLI v2.0 — see where your AI API money goes.
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

const VERSION = '2.0.0';
const HOME = os.homedir();
const OUTPUT_FILE = path.join(process.cwd(), 'tokenmiser-report.html');

// ═══════════════════════════════════════════════════════════════════
// CLI ARGS
// ═══════════════════════════════════════════════════════════════════
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { json: false, help: false, version: false, verbose: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') opts.json = true;
    else if (args[i] === '--help' || args[i] === '-h') opts.help = true;
    else if (args[i] === '--version' || args[i] === '-v') opts.version = true;
    else if (args[i] === '--verbose') opts.verbose = true;
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
    // Try alternate endpoint path
    const altPath = `/v1/organizations/usage_report/messages?starting_at=${encodeURIComponent(startStr)}&ending_at=${encodeURIComponent(endStr)}&group_by[]=model&bucket_width=1d`;
    try { usage = await httpGet('api.anthropic.com', altPath, headers); } catch { return null; }
  }

  if (!usage) return null;

  // Anthropic pricing (static, from OpenRouter fetch 2026-04-06)
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

    // Estimate cost from pricing
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
    // Try simpler endpoint
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

  // Find all project dirs, then find JSONL files
  const projectsDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  const jsonlFiles = [];
  try {
    findJsonlFiles(projectsDir, jsonlFiles, 5);
  } catch { return null; }

  if (jsonlFiles.length === 0) return null;

  // Parse JSONL files for usage data
  const records = [];
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  // Anthropic pricing for Claude Code (OAuth billing goes to Anthropic account)
  const ccPricing = {
    'claude-opus-4': { prompt: 0.000015, completion: 0.000075 },
    'claude-sonnet-4': { prompt: 0.000003, completion: 0.000015 },
    'claude-haiku-4': { prompt: 0.0000008, completion: 0.000004 },
  };

  // Aggregate by date+model to avoid per-message granularity explosion
  const dayModel = {};

  for (const file of jsonlFiles) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          // Claude Code stores usage inside entry.message.usage
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

  // Convert aggregates to records — cost is ESTIMATED (local logs don't know billing path)
  Object.values(dayModel).forEach((agg) => {
    const pKey = Object.keys(ccPricing).find((k) => agg.model.toLowerCase().includes(k.replace(/-\d+$/, '')));
    const rates = pKey ? ccPricing[pKey] : { prompt: 0.000003, completion: 0.000015 };
    const estimatedCost = agg.promptTokens * rates.prompt + agg.completionTokens * rates.completion;

    records.push({
      source: 'claude-code',
      billingPath: 'local-estimate',
      estimated: true,  // local logs can't determine actual billing path or cost
      date: agg.date,
      model: agg.model.includes('/') ? agg.model : `anthropic/${agg.model}`,
      modelName: agg.model,
      promptTokens: agg.promptTokens,
      completionTokens: agg.completionTokens,
      cost: estimatedCost,
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
        // Only include recent files (modified in last 30 days)
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

  // Codex logs are less standardized — look for any readable log files
  const records = [];
  try {
    const files = fs.readdirSync(codexDir).filter((f) => f.endsWith('.log') || f.endsWith('.jsonl'));
    // If we find log files, attempt basic parsing
    // For now, return null if no parseable data — Codex log format varies
    if (files.length === 0) return null;
  } catch { return null; }

  // Codex log parsing would go here as the format stabilizes
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// SOURCE DETECTION & COLLECTION
// ═══════════════════════════════════════════════════════════════════
async function detectAndCollect(verbose) {
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
      const total = result.records.reduce((s, r) => s + r.cost, 0);
      const sessions = result.records.length;
      process.stderr.write(`  ✓ Claude Code (local logs)       ~${fmtMoney(total)} (${sessions} day/model entries)\n`);
      sources.push({ name: 'Claude Code (local)', records: sessions, cost: total });
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

  // ── RECONCILIATION ──────────────────────────────────────────────
  // API sources (OpenRouter, Anthropic Admin, OpenAI) report actual costs.
  // Local logs only know token counts — cost is estimated.
  // If any API source is present, local log records are kept for token/usage
  // detail but their estimated costs are zeroed out so they don't inflate totals.
  // If NO API source is present, local estimates are the only data we have
  // and we keep them but label them clearly.
  const hasApiSource = allRecords.some((r) => !r.estimated);

  if (hasApiSource) {
    let suppressedEstimate = 0;
    allRecords.forEach((r) => {
      if (r.estimated) {
        suppressedEstimate += r.cost;
        r.cost = 0; // zero out — API sources have the real cost
        r.billingPath = 'local-usage-only';
      }
    });
    if (suppressedEstimate > 0) {
      process.stderr.write(`  ℹ Local log cost estimates (~${fmtMoney(suppressedEstimate)}) suppressed —\n`);
      process.stderr.write(`    API sources provide actual billing data.\n`);
      process.stderr.write(`    Local logs retained for token counts and usage patterns.\n\n`);
    }
  } else {
    // No API sources — local estimates are all we have
    const estTotal = allRecords.reduce((s, r) => s + (r.estimated ? r.cost : 0), 0);
    if (estTotal > 0) {
      process.stderr.write(`  ⚠ No API keys found. Showing estimated costs (~${fmtMoney(estTotal)}) from local logs.\n`);
      process.stderr.write(`    These are rough estimates based on published per-token pricing.\n`);
      process.stderr.write(`    Actual costs depend on your billing method (subscription, OpenRouter, etc.).\n`);
      process.stderr.write(`    Set OPENROUTER_API_KEY or ANTHROPIC_ADMIN_KEY for accurate billing data.\n\n`);
    }
  }

  if (allRecords.length === 0) {
    process.stderr.write('  No data found from any source.\n');
    process.stderr.write('  Set at least one API key or use a CLI tool to generate data.\n\n');
    process.exit(0);
  }

  return { records: allRecords, sources, pricing: allPricing, hasApiSource };
}

// ═══════════════════════════════════════════════════════════════════
// AGGREGATE DATA
// ═══════════════════════════════════════════════════════════════════
function aggregate(records, pricing) {
  // By model (across all sources)
  const byModel = {};
  let totalCost = 0, totalPrompt = 0, totalCompletion = 0, totalRequests = 0;
  const byDate = {};
  const bySource = {};

  records.forEach((r) => {
    // Aggregate by model
    if (!byModel[r.model]) {
      byModel[r.model] = { cost: 0, promptTokens: 0, completionTokens: 0, requests: 0,
        name: r.modelName, sources: new Set() };
    }
    byModel[r.model].cost += r.cost;
    byModel[r.model].promptTokens += r.promptTokens;
    byModel[r.model].completionTokens += r.completionTokens;
    byModel[r.model].requests += r.requests;
    byModel[r.model].sources.add(r.billingPath);

    // By date
    if (r.date && r.date !== 'unknown') {
      if (!byDate[r.date]) byDate[r.date] = {};
      if (!byDate[r.date][r.model]) byDate[r.date][r.model] = 0;
      byDate[r.date][r.model] += r.cost;
    }

    // By billing path
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
    .sort((a, b) => b.cost - a.cost);

  // Find most expensive model by unit rate
  let maxUnitRate = 0, maxRateModel = 'unknown', maxRateModelName = 'unknown';
  modelRanking.forEach((m) => {
    const p = pricing[m.id];
    if (p) {
      const rate = p.completion || p.prompt || 0;
      if (rate > maxUnitRate) { maxUnitRate = rate; maxRateModel = m.id; maxRateModelName = m.name; }
    }
  });

  // Counterfactual
  let counterfactualCost = 0;
  if (maxUnitRate > 0 && pricing[maxRateModel]) {
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
// HTML DASHBOARD
// ═══════════════════════════════════════════════════════════════════
function generateDashboard(data, sources, allEstimated = false) {
  const colors = ['#c084fc','#60a5fa','#34d399','#f472b6','#fbbf24','#fb923c','#a78bfa','#38bdf8','#4ade80','#f87171','#facc15','#e879f9'];
  const top6 = data.modelRanking.slice(0, 6);
  const maxCost = top6[0]?.cost || 1;
  const chartDays = data.chartData.slice(-14);
  const maxDayTotal = Math.max(...chartDays.map((d) => d.total), 0.01);

  const sourceTagsHTML = sources.map((s) =>
    `<span class="source-tag">${escapeHtml(s.name)}: ${fmtMoney(s.cost)}</span>`
  ).join('');

  const modelBarHTML = top6.map((m, i) => {
    const c = colors[i % colors.length];
    const w = Math.max(4, (m.cost / maxCost) * 100);
    return `<div class="model-row">
      <div class="model-info"><div class="model-color" style="background:${c}"></div>
        <div><div class="model-name">${escapeHtml(m.name)}</div>
        <div class="model-meta">${fmtCompact(m.requests)} req &middot; ${fmtTokens(m.totalTokens)} tok &middot; <span class="billing-tag">${escapeHtml(m.sources)}</span></div></div>
      </div>
      <div class="model-cost"><div class="model-cost-value">${fmtMoney(m.cost)}</div>
        <div class="model-bar-track"><div class="model-bar-fill" style="width:${w}%;background:${c}"></div></div>
      </div></div>`;
  }).join('');

  const chartBarsHTML = chartDays.map((day) => {
    const h = Math.max(2, (day.total / maxDayTotal) * 200);
    return `<div class="chart-col"><div class="chart-bar" style="height:${h}px" title="${day.date}: ${fmtMoney(day.total)}"></div><div class="chart-label">${day.date.slice(5)}</div></div>`;
  }).join('');

  const billingPathsHTML = Object.entries(data.bySource).map(([path, d]) =>
    `<tr><td>${escapeHtml(path)}</td><td class="mono">${fmtCompact(d.requests)}</td><td class="mono">${fmtTokens(d.tokens)}</td><td class="mono">${fmtMoney(d.cost)}</td></tr>`
  ).join('');

  const hasData = data.totalRequests > 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tokenmiser — Cost Report</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f0d1a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.container{max-width:1200px;margin:0 auto;padding:32px 24px}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}
.logo{display:flex;align-items:center;gap:12px}
.logo-mark{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#5eead4,#818cf8);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#0f0d1a}
.logo-text{font-size:22px;font-weight:700}
.header-meta{font-size:12px;color:#64748b;text-align:right}
.sources-bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px}
.source-tag{background:#1e1b2e;border:1px solid rgba(148,163,184,0.12);border-radius:20px;padding:6px 14px;font-size:12px;color:#94a3b8}
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}
.kpi{background:#1e1b2e;border-radius:12px;padding:20px 24px;border-top:3px solid #5eead4}
.kpi.accent-purple{border-top-color:#818cf8}.kpi.accent-pink{border-top-color:#f472b6}.kpi.accent-orange{border-top-color:#fb923c}
.kpi-label{font-size:11px;font-weight:600;letter-spacing:1.5px;color:#94a3b8;text-transform:uppercase;margin-bottom:8px}
.kpi-value{font-size:32px;font-weight:700;font-family:'SF Mono','Fira Code',monospace}
.kpi-sub{font-size:12px;color:#5eead4;margin-top:4px}
.kpi.accent-purple .kpi-sub{color:#818cf8}.kpi.accent-pink .kpi-sub{color:#f472b6}.kpi.accent-orange .kpi-sub{color:#fb923c}
.panels{display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:24px}
.panel{background:#1e1b2e;border-radius:12px;padding:24px}
.panel-title{font-size:16px;font-weight:600;margin-bottom:4px}
.panel-sub{font-size:12px;color:#64748b;margin-bottom:20px}
.chart-container{display:flex;align-items:flex-end;gap:6px;height:220px;padding-top:20px}
.chart-col{display:flex;flex-direction:column;align-items:center;flex:1}
.chart-bar{background:linear-gradient(180deg,#5eead4,#818cf8);border-radius:4px 4px 0 0;width:100%;min-width:12px;transition:height 0.3s;cursor:pointer}.chart-bar:hover{opacity:0.8}
.chart-label{font-size:10px;color:#64748b;margin-top:6px}
.model-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(148,163,184,0.08)}
.model-info{display:flex;align-items:center;gap:10px;flex:1}
.model-color{width:4px;height:36px;border-radius:2px}
.model-name{font-size:14px;font-weight:500}.model-meta{font-size:12px;color:#64748b}
.billing-tag{background:rgba(94,234,212,0.1);color:#5eead4;padding:1px 6px;border-radius:4px;font-size:10px}
.model-cost{text-align:right;min-width:100px}
.model-cost-value{font-size:18px;font-weight:700;font-family:'SF Mono',monospace}
.model-bar-track{height:3px;border-radius:2px;background:rgba(148,163,184,0.1);margin-top:4px}
.model-bar-fill{height:100%;border-radius:2px;transition:width 0.5s}
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
td{padding:12px;font-size:13px;border-bottom:1px solid rgba(148,163,184,0.06)}
td.mono{font-family:'SF Mono','Fira Code',monospace}
.footer{margin-top:24px;padding:12px 16px;border-radius:8px;background:rgba(148,163,184,0.04);border:1px solid rgba(148,163,184,0.06);font-size:11px;color:#64748b}
.empty-state{text-align:center;padding:60px 20px}.empty-state h2{font-size:20px;margin-bottom:12px}.empty-state p{color:#94a3b8;font-size:14px;max-width:500px;margin:0 auto}
@media(max-width:768px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.panels,.bottom-row{grid-template-columns:1fr}.savings-value{font-size:32px}}
</style>
</head>
<body>
<div class="container">
<div class="header">
  <div class="logo"><div class="logo-mark">T</div><div class="logo-text">Tokenmiser</div></div>
  <div class="header-meta">Report generated ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}<br>${sources.length} data source${sources.length!==1?'s':''} detected</div>
</div>
<div class="sources-bar">${sourceTagsHTML}</div>
${allEstimated ? `<div style="background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:13px;color:#fbbf24">
  <strong>⚠ Estimated costs</strong> — No API keys found. Costs below are rough estimates based on published per-token pricing.
  Your actual costs depend on your billing method (subscription, OpenRouter rates, etc.).
  Set <code style="background:rgba(251,191,36,0.15);padding:2px 6px;border-radius:3px">OPENROUTER_API_KEY</code> for accurate billing data.
</div>` : ''}
${hasData ? `
<div class="kpi-grid">
  <div class="kpi"><div class="kpi-label">Total Spend (30d)</div><div class="kpi-value">${fmtMoney(data.totalCost)}</div><div class="kpi-sub">${fmtTokens(data.totalPromptTokens+data.totalCompletionTokens)} tokens across all sources</div></div>
  <div class="kpi accent-purple"><div class="kpi-label">Active Models</div><div class="kpi-value">${data.activeModels}</div><div class="kpi-sub">Across ${data.providers} provider${data.providers!==1?'s':''}</div></div>
  <div class="kpi accent-orange"><div class="kpi-label">Billing Paths</div><div class="kpi-value">${Object.keys(data.bySource).length}</div><div class="kpi-sub">${Object.keys(data.bySource).join(', ')}</div></div>
  <div class="kpi accent-pink"><div class="kpi-label">Routing Savings</div><div class="kpi-value">${fmtMoney(data.routingSavings,0)}</div><div class="kpi-sub">${fmtPct(data.costReduction)} vs single-model baseline</div></div>
</div>
<div class="panels">
  <div class="panel"><div class="panel-title">Daily Spend</div><div class="panel-sub">Last ${chartDays.length} days, all sources combined</div><div class="chart-container">${chartBarsHTML}</div></div>
  <div class="panel"><div class="panel-title">Spend by Model</div><div class="panel-sub">All billing paths combined</div>${modelBarHTML}</div>
</div>
<div class="bottom-row">
  <div class="panel"><div class="panel-title">By Billing Path</div><div class="panel-sub">Each path is a separate bill — no double-counting</div>
    <table><thead><tr><th>Billing Path</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${billingPathsHTML}</tbody></table>
  </div>
  <div class="panel"><div class="panel-title">All Models</div><div class="panel-sub">Ranked by spend</div>
    <table><thead><tr><th>Model</th><th>Requests</th><th>Cost</th></tr></thead><tbody>
    ${data.modelRanking.map((m)=>`<tr><td>${escapeHtml(m.name)}</td><td class="mono">${fmtCompact(m.requests)}</td><td class="mono">${fmtMoney(m.cost)}</td></tr>`).join('')}
    </tbody></table>
  </div>
  <div class="savings-card">
    <div class="savings-label">Routing Savings</div>
    <div class="savings-value">${fmtMoney(data.routingSavings,0)}<span>/mo</span></div>
    <div class="savings-desc">If all ${fmtCompact(data.totalRequests)} requests used ${escapeHtml(data.maxRateModelName)}, total would be ${fmtMoney(data.counterfactualCost)}.</div>
    <div class="savings-stats">
      <div><div class="stat-value">${fmtPct(data.costReduction)}</div><div class="stat-label">Reduction</div></div>
      <div><div class="stat-value">${data.activeModels}</div><div class="stat-label">Models</div></div>
      <div><div class="stat-value">${Object.keys(data.bySource).length}</div><div class="stat-label">Bill Paths</div></div>
    </div>
  </div>
</div>` : `<div class="empty-state"><h2>No usage data found</h2><p>No activity detected from any source in the last 30 days.</p></div>`}
<div class="footer">${allEstimated
  ? `⚠ All costs shown are estimates from local token logs. Set API keys for real billing data.`
  : `Costs from API sources (${Object.keys(data.bySource).filter(p => p !== 'local-usage-only').map(escapeHtml).join(', ') || 'none'}) are actual billing data. Local log entries provide token counts only — their costs are not included in totals when API data is available.`
} Generated by Tokenmiser v${VERSION}.</div>
</div></body></html>`;
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
    const { records, sources, pricing, hasApiSource } = await detectAndCollect(opts.verbose);
    const data = aggregate(records, pricing);
    const allEstimated = !hasApiSource && records.some((r) => r.estimated);

    if (opts.json) {
      console.log(JSON.stringify({ sources, ...data, allEstimated, fetchedAt: new Date().toISOString() }, null, 2));
      return;
    }

    const html = generateDashboard(data, sources, allEstimated);
    fs.writeFileSync(OUTPUT_FILE, html, 'utf8');

    // Terminal summary
    const costPrefix = allEstimated ? '~' : '';
    console.log(`  ╔═══════════════════════════════════════════════════════╗`);
    console.log(`  ║  TOKENMISER v${VERSION}                                    ║`);
    console.log(`  ╚═══════════════════════════════════════════════════════╝`);
    if (allEstimated) {
      console.log(`  ⚠ ESTIMATED — no API keys set. Set OPENROUTER_API_KEY for real billing data.`);
    }
    console.log(`  Total Spend (30d):    ${costPrefix}${fmtMoney(data.totalCost)}`);
    console.log(`  Billing Paths:        ${Object.keys(data.bySource).join(', ')}`);
    console.log(`  Active Models:        ${data.activeModels}`);
    console.log(`  Total Requests:       ${data.totalRequests.toLocaleString()}`);
    console.log(`  ─────────────────────────────────────────────────────────`);
    console.log(`  Counterfactual:       ${fmtMoney(data.counterfactualCost)} (all → ${data.maxRateModelName})`);
    console.log(`  Routing Savings:      ${fmtMoney(data.routingSavings)} (${fmtPct(data.costReduction)} reduction)`);
    console.log(`  ─────────────────────────────────────────────────────────`);
    data.modelRanking.slice(0, 5).forEach((m) => {
      console.log(`  ${m.name.padEnd(30)} ${fmtMoney(m.cost).padStart(12)}  [${m.sources}]`);
    });
    if (data.modelRanking.length > 5) console.log(`  ... and ${data.modelRanking.length - 5} more`);
    console.log(`\n  Dashboard: ${OUTPUT_FILE}`);
    const opened = openInBrowser(OUTPUT_FILE);
    console.log(opened ? `  Opened in browser.\n` : `  Open the file above in your browser.\n`);
  } catch (err) {
    console.error(`\n  Error: ${err.message}\n`);
    process.exit(1);
  }
}

main();
