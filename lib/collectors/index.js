'use strict';

/**
 * Collector registry and orchestrator.
 *
 * Each collector follows the interface:
 *   { name, slug, type, detect(), collect(...), envVar? }
 *
 * Types: 'api' | 'csv' | 'local-log'
 */

const { fmtMoney } = require('../format');

// Import all collectors
const openrouterApi = require('./openrouter-api');
const openrouterCsv = require('./openrouter-csv');
const anthropicApi = require('./anthropic-api');
const openaiApi = require('./openai-api');
const claudeCodeLogs = require('./claude-code-logs');
const codexLogs = require('./codex-logs');
const clineLogs = require('./cline-logs');
const aiderLogs = require('./aider-logs');
const geminiCliLogs = require('./gemini-cli-logs');
const cursorLogs = require('./cursor-logs');

// Registry — order determines scan order in output
const API_COLLECTORS = [openrouterApi, anthropicApi, openaiApi];
const LOCAL_COLLECTORS = [claudeCodeLogs, codexLogs, clineLogs, aiderLogs, geminiCliLogs, cursorLogs];
const ALL_COLLECTORS = [...API_COLLECTORS, ...LOCAL_COLLECTORS];

/**
 * Detect and collect data from all available sources.
 *
 * @param {boolean} verbose - Show detailed detection info
 * @param {string|null} csvPath - Path to OpenRouter CSV file
 * @returns {{ records, sources, pricing, hasApiSource }}
 */
async function detectAndCollect(verbose, csvPath) {
  const log = verbose ? (msg) => process.stderr.write(`  ${msg}\n`) : () => {};
  process.stderr.write('\n  Tokenmiser — scanning for data sources...\n\n');

  const sources = [];
  const allRecords = [];
  let allPricing = {};

  // ── API Sources ────────────────────────────────────────────────

  for (const collector of API_COLLECTORS) {
    if (collector.detect()) {
      log(`Checking ${collector.name}...`);
      try {
        const isManagement = collector.isManagementKey ? collector.isManagementKey() : false;
        const result = await collector.collect(collector.envKey(), isManagement);
        if (result && result.records.length > 0) {
          const total = result.records.reduce((s, r) => s + r.cost, 0);
          process.stderr.write(
            `  ✓ ${collector.name.padEnd(28)} ${fmtMoney(total)} (30d)\n`
          );
          sources.push({ name: collector.name, records: result.records.length, cost: total, type: 'api' });
          allRecords.push(...result.records);
          allPricing = { ...allPricing, ...result.pricing };
        } else {
          process.stderr.write(
            `  ✓ ${collector.name.padEnd(28)} $0.00 (no activity)\n`
          );
        }
      } catch (e) {
        process.stderr.write(
          `  ✗ ${collector.name.padEnd(28)} failed (${e.message})\n`
        );
      }
    } else {
      process.stderr.write(
        `  – ${collector.name.padEnd(28)} ${collector.envVar ? 'no key found' : 'not detected'}\n`
      );
      if (collector.envVar) log(`  Set ${collector.envVar} to enable`);
    }
  }

  // ── CSV Import ─────────────────────────────────────────────────

  if (csvPath) {
    log(`Importing OpenRouter CSV: ${csvPath}`);
    try {
      const result = openrouterCsv.collect(csvPath);
      if (result && result.records.length > 0) {
        const total = result.records.reduce((s, r) => s + r.cost, 0);
        const gens = result.records.reduce((s, r) => s + r.requests, 0);
        process.stderr.write(
          `  ✓ OpenRouter CSV                 ${fmtMoney(total)} (${gens.toLocaleString()} generations)\n`
        );
        sources.push({ name: 'OpenRouter CSV', records: result.records.length, cost: total, type: 'csv' });
        allRecords.push(...result.records);
      }
    } catch (e) {
      process.stderr.write(
        `  ✗ OpenRouter CSV                 failed (${e.message})\n`
      );
    }
  }

  // ── Local Log Sources ──────────────────────────────────────────

  for (const collector of LOCAL_COLLECTORS) {
    log(`Scanning ${collector.logPath || collector.name}...`);
    try {
      if (!collector.detect()) {
        process.stderr.write(
          `  – ${collector.name.padEnd(28)} not found\n`
        );
        continue;
      }
      const result = collector.collect();
      if (result && result.records.length > 0) {
        const total = result.records.reduce((s, r) => s + r.cost, 0);
        const entries = result.records.length;
        process.stderr.write(
          `  ✓ ${collector.name.padEnd(28)} ~${fmtMoney(total)} (${entries} day/model entries)\n`
        );
        sources.push({ name: collector.name, records: entries, cost: total, type: 'local-log' });
        allRecords.push(...result.records);
      } else {
        process.stderr.write(
          `  – ${collector.name.padEnd(28)} no recent data\n`
        );
      }
    } catch {
      process.stderr.write(
        `  – ${collector.name.padEnd(28)} not found\n`
      );
    }
  }

  process.stderr.write('\n');

  // ── Reconciliation ─────────────────────────────────────────────
  const hasApiSource = allRecords.some((r) => !r.estimated);

  if (hasApiSource) {
    let suppressedEstimate = 0;
    allRecords.forEach((r) => {
      if (r.estimated) {
        suppressedEstimate += r.cost;
        r.cost = 0;
        // Preserve the real billing path (oauth, openrouter, etc.) —
        // only override if it was the generic 'local-estimate'
        if (r.billingPath === 'local-estimate') {
          r.billingPath = 'local-usage-only';
        }
      }
    });
    if (suppressedEstimate > 0) {
      process.stderr.write(
        `  ℹ Local log cost estimates (~${fmtMoney(suppressedEstimate)}) suppressed —\n`
      );
      process.stderr.write(
        `    API sources provide actual billing data.\n`
      );
      process.stderr.write(
        `    Local logs retained for token counts and usage patterns.\n\n`
      );
    }
  } else {
    const estTotal = allRecords.reduce((s, r) => s + (r.estimated ? r.cost : 0), 0);
    if (estTotal > 0) {
      process.stderr.write(
        `  ⚠ No API keys found. Showing estimated costs (~${fmtMoney(estTotal)}) from local logs.\n`
      );
      process.stderr.write(
        `    These are rough estimates based on published per-token pricing.\n`
      );
      process.stderr.write(
        `    Actual costs depend on your billing method (subscription, OpenRouter, etc.).\n`
      );
      process.stderr.write(
        `    Set OPENROUTER_API_KEY or ANTHROPIC_ADMIN_KEY for accurate billing data.\n`
      );
      process.stderr.write(
        `    Or use --quick-sub to track subscription costs (e.g. --quick-sub claude-pro).\n\n`
      );
    }
  }

  if (allRecords.length === 0) {
    process.stderr.write('  No data found from any source.\n');
    process.stderr.write(
      '  Set at least one API key or use a CLI tool to generate data.\n\n'
    );
  }

  return { records: allRecords, sources, pricing: allPricing, hasApiSource };
}

module.exports = {
  detectAndCollect,
  ALL_COLLECTORS,
  API_COLLECTORS,
  LOCAL_COLLECTORS,
};
