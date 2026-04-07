'use strict';

const { normalizeModelName } = require('./format');

/**
 * Deduplication engine.
 *
 * Priority order: Provider API > OpenRouter API/CSV > Local logs
 *
 * Rules:
 *  1. API records always win for cost data
 *  2. When API data exists for a model+date, local log estimated costs are zeroed
 *     but records are kept for token counts and usage context
 *  3. CSV self-dedup: identical (date, model, appName) records are merged
 *  4. OpenRouter account-total summary records don't dedup against per-model records
 *  5. Subscription billing paths (oauth, cursor-subscription, google-subscription)
 *     are never deduplicated — they represent usage volume, not competing cost sources
 */

/**
 * Source priority — higher number = more authoritative for cost.
 */
const SOURCE_PRIORITY = {
  'api': 3,          // Provider API (Anthropic, OpenAI)
  'openrouter': 2,   // OpenRouter API or CSV
  'csv': 2,          // CSV import
  'local-log': 1,    // Local log files
};

function getSourcePriority(record) {
  if (record.type === 'api') return 3;
  if (record.source === 'openrouter-csv') return 2;
  return SOURCE_PRIORITY[record.type] || 1;
}

/**
 * Billing paths that represent subscription-based usage (no per-token cost).
 * These should NOT be deduplicated against per-token sources.
 */
const SUBSCRIPTION_BILLING_PATHS = new Set([
  'oauth',
  'cursor-subscription',
  'google-subscription',
]);

function deduplicateRecords(records) {
  // ── Step 1: CSV self-dedup ──
  // If the same CSV is imported multiple times, we get duplicate records.
  // Deduplicate by (date, model, appName, source=openrouter-csv)
  const csvSeen = new Set();
  let csvDupCount = 0;

  records.forEach((r) => {
    if (r.source === 'openrouter-csv') {
      const key = `${r.date}|${r.model}|${r.appName || ''}`;
      if (csvSeen.has(key)) {
        r.deduplicated = true;
        csvDupCount++;
      } else {
        csvSeen.add(key);
      }
    }
  });

  if (csvDupCount > 0) {
    process.stderr.write(
      `  ℹ CSV dedup: ${csvDupCount} duplicate CSV entries removed.\n`
    );
  }

  // ── Step 2: Build authoritative cost keys from API/CSV sources ──
  // These are per-model, per-date keys from non-estimated, non-summary records
  const authoritativeKeys = new Map(); // key → priority

  records.forEach((r) => {
    if (r.deduplicated) return;
    if (r.isSummary) return; // Account-total summaries don't dedup per-model records
    if (SUBSCRIPTION_BILLING_PATHS.has(r.billingPath)) return; // Skip subscription paths

    if (!r.estimated) {
      const normalizedModel = normalizeModelName(r.model);
      const key = `${r.date}|${normalizedModel}`;
      const priority = getSourcePriority(r);
      const existing = authoritativeKeys.get(key) || 0;
      if (priority > existing) {
        authoritativeKeys.set(key, priority);
      }
    }
  });

  if (authoritativeKeys.size === 0) return records;

  // ── Step 3: Mark lower-priority records as deduplicated ──
  let dupCount = 0;

  records.forEach((r) => {
    if (r.deduplicated) return;
    if (r.isSummary) return;
    if (SUBSCRIPTION_BILLING_PATHS.has(r.billingPath)) return;

    const normalizedModel = normalizeModelName(r.model);
    const key = `${r.date}|${normalizedModel}`;
    const authPriority = authoritativeKeys.get(key);

    if (authPriority && r.estimated) {
      // This is a local estimate that has an authoritative source — mark as deduped
      r.deduplicated = true;
      r.cost = 0;
      if (r.billingPath === 'local-estimate') {
        r.billingPath = 'local-usage-only';
      }
      dupCount++;
    }
  });

  if (dupCount > 0) {
    process.stderr.write(
      `  ℹ Dedup: ${dupCount} local log entries matched to API/CSV records.\n`
    );
    process.stderr.write(
      `    API/CSV source is authoritative for cost; local logs retained for context.\n\n`
    );
  }

  return records;
}

module.exports = { deduplicateRecords };
