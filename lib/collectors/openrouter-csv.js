'use strict';

const fs = require('fs');
const { parseCSVLine } = require('../format');

/**
 * OpenRouter CSV import collector.
 * Parses OpenRouter activity CSV exports.
 */
function collect(csvPath) {
  if (!fs.existsSync(csvPath)) throw new Error(`CSV file not found: ${csvPath}`);
  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split('\n');
  if (lines.length < 2) return null;

  // Parse CSV header
  const header = parseCSVLine(lines[0]);
  const colIdx = {};
  header.forEach((h, i) => {
    colIdx[h.trim()] = i;
  });

  const needed = ['created_at', 'cost_total', 'model_permaslug', 'tokens_prompt', 'tokens_completion'];
  for (const col of needed) {
    if (colIdx[col] === undefined) throw new Error(`CSV missing required column: ${col}`);
  }

  // Aggregate by date+model to keep record count manageable
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
    type: 'per-token',
    date: agg.date,
    model: agg.model,
    modelName: agg.model.split('/').pop(),
    promptTokens: agg.promptTokens,
    completionTokens: agg.completionTokens,
    cost: agg.cost,
    requests: agg.requests,
  }));

  return records.length > 0 ? { records, pricing: {}, sourceLabel: 'OpenRouter CSV' } : null;
}

module.exports = {
  name: 'OpenRouter CSV',
  slug: 'openrouter-csv',
  type: 'csv',
  collect,
};
