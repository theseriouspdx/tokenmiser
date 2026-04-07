'use strict';

/**
 * Shared formatting helpers — used by CLI output, dashboard generation, and aggregation.
 * Zero dependencies.
 */

function fmtMoney(v, d = 2) {
  return `$${v.toFixed(d)}`;
}

function fmtTokens(v) {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}K`;
  return v.toString();
}

function fmtPct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtCompact(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toLocaleString();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Simple CSV line parser — handles quoted fields with commas and embedded quotes.
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Normalize a model name for matching across providers.
 * Strips provider prefixes and lowercases.
 * e.g. "anthropic/claude-3.5-sonnet" → "claude-3.5-sonnet"
 *      "claude-3-5-sonnet" → "claude-3-5-sonnet"
 */
function normalizeModelName(model) {
  return model.split('/').pop().toLowerCase().trim();
}

module.exports = {
  fmtMoney,
  fmtTokens,
  fmtPct,
  fmtCompact,
  escapeHtml,
  parseCSVLine,
  normalizeModelName,
};
