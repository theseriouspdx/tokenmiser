'use strict';

const { normalizeModelName } = require('./format');

/**
 * Deduplication engine.
 *
 * Matches local log records to API records by normalized model+date.
 * When a match is found, the local record is tagged as a duplicate
 * and its cost stays 0 (API source is authoritative for cost).
 *
 * Rules:
 *  1. API records always win for cost data
 *  2. Local log records are kept for token counts and usage context
 *  3. Model names are normalized (strip provider prefix, lowercase)
 *  4. Matching is by date + normalized model name
 */
function deduplicateRecords(records) {
  // Build a set of model+date keys from API sources (non-estimated records)
  const apiKeys = new Set();
  records.forEach((r) => {
    if (!r.estimated) {
      const normalizedModel = normalizeModelName(r.model);
      apiKeys.add(`${r.date}|${normalizedModel}`);
    }
  });

  if (apiKeys.size === 0) return records;

  let dupCount = 0;
  records.forEach((r) => {
    if (r.estimated) {
      const normalizedModel = normalizeModelName(r.model);
      const key = `${r.date}|${normalizedModel}`;
      if (apiKeys.has(key)) {
        r.deduplicated = true;
        r.billingPath = 'local-usage (covered by API)';
        dupCount++;
      }
    }
  });

  if (dupCount > 0) {
    process.stderr.write(
      `  ℹ Dedup: ${dupCount} local log entries matched to API records.\n`
    );
    process.stderr.write(
      `    API source is authoritative for cost; local logs retained for context.\n\n`
    );
  }

  return records;
}

module.exports = { deduplicateRecords };
