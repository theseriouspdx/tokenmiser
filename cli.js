#!/usr/bin/env node
/**
 * tokenmiser CLI — see where your AI API money goes.
 *
 * Usage:
 *   npx tokenmiser                          # prompts for API key
 *   OPENROUTER_API_KEY=sk-... npx tokenmiser # uses env var
 *   npx tokenmiser --key sk-or-v1-...       # pass key directly
 *   npx tokenmiser --json                   # output raw JSON instead of dashboard
 *
 * Zero dependencies. Just Node.js 18+.
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

// ═══════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════
const VERSION = '1.0.0';
const OUTPUT_FILE = path.join(process.cwd(), 'tokenmiser-report.html');

// ═══════════════════════════════════════════════════════════════════
// CLI ARGUMENT PARSING
// ═══════════════════════════════════════════════════════════════════
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { key: null, json: false, help: false, version: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--key' || args[i] === '-k') { opts.key = args[++i]; }
    else if (args[i] === '--json') { opts.json = true; }
    else if (args[i] === '--help' || args[i] === '-h') { opts.help = true; }
    else if (args[i] === '--version' || args[i] === '-v') { opts.version = true; }
  }
  return opts;
}

function printHelp() {
  console.log(`
  tokenmiser v${VERSION}
  See where your AI API money goes.

  Usage:
    npx tokenmiser                    Interactive — prompts for API key
    npx tokenmiser --key sk-or-...    Pass key directly
    npx tokenmiser --json             Output raw JSON instead of HTML dashboard

  Environment:
    OPENROUTER_API_KEY                Used if --key not provided

  The tool fetches your last 30 days of OpenRouter usage,
  analyzes cost by model, and shows you how much you'd save
  with smarter model routing. Opens an HTML report in your browser.
`);
}

// ═══════════════════════════════════════════════════════════════════
// PROMPT FOR API KEY
// ═══════════════════════════════════════════════════════════════════
function promptForKey() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question('\n  Enter your OpenRouter API key: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// HTTPS FETCH (zero-dep)
// ═══════════════════════════════════════════════════════════════════
function fetch(urlPath, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openrouter.ai',
      port: 443,
      path: urlPath,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error('Invalid API key. Check your key at https://openrouter.ai/settings/keys'));
        }
        if (res.statusCode >= 400) {
          return reject(new Error(`API returned ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse API response: ${e.message}`)); }
      });
    });
    req.on('error', (e) => reject(new Error(`Network error: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out (15s)')); });
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════
// DATA COLLECTION
// ═══════════════════════════════════════════════════════════════════
async function collectData(apiKey) {
  process.stderr.write('\n  Fetching your OpenRouter data...\n');

  // Fetch in parallel: account info, activity, and model pricing
  const [keyInfo, activity, models] = await Promise.all([
    fetch('/api/v1/auth/key', apiKey).catch(() => null),
    fetch('/api/v1/activity', apiKey).catch(() => null),
    fetch('/api/v1/models', apiKey).catch(() => null),
  ]);

  // Build pricing lookup from models endpoint
  const pricing = {};
  if (models && models.data && Array.isArray(models.data)) {
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

  // Parse account info
  const account = {
    label: keyInfo?.data?.label || 'Unknown',
    usage: keyInfo?.data?.usage || 0,
    limit: keyInfo?.data?.limit || null,
    limitRemaining: keyInfo?.data?.limit_remaining || null,
  };

  // Parse activity data
  const activityData = Array.isArray(activity?.data) ? activity.data : [];

  // Aggregate by model
  const byModel = {};
  let totalCost = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalRequests = 0;

  // Aggregate by date for chart
  const byDate = {};

  activityData.forEach((entry) => {
    const model = entry.model || entry.model_permaslug || 'unknown';
    const cost = parseFloat(entry.usage) || 0;
    const prompts = parseInt(entry.prompt_tokens) || 0;
    const completions = parseInt(entry.completion_tokens) || 0;
    const requests = parseInt(entry.requests) || 0;
    const date = entry.date || 'unknown';

    if (!byModel[model]) {
      byModel[model] = { cost: 0, promptTokens: 0, completionTokens: 0, requests: 0, name: pricing[model]?.name || model };
    }
    byModel[model].cost += cost;
    byModel[model].promptTokens += prompts;
    byModel[model].completionTokens += completions;
    byModel[model].requests += requests;

    if (!byDate[date]) byDate[date] = {};
    if (!byDate[date][model]) byDate[date][model] = 0;
    byDate[date][model] += cost;

    totalCost += cost;
    totalPromptTokens += prompts;
    totalCompletionTokens += completions;
    totalRequests += requests;
  });

  // Sort models by cost descending
  const modelRanking = Object.entries(byModel)
    .map(([id, data]) => ({ id, ...data, totalTokens: data.promptTokens + data.completionTokens }))
    .sort((a, b) => b.cost - a.cost);

  // Find the most expensive model by UNIT RATE
  let maxUnitRate = 0;
  let maxRateModel = 'unknown';
  modelRanking.forEach((m) => {
    const pricingEntry = pricing[m.id];
    if (pricingEntry) {
      // Use completion rate as the primary cost driver
      const rate = pricingEntry.completion || pricingEntry.prompt || 0;
      if (rate > maxUnitRate) {
        maxUnitRate = rate;
        maxRateModel = m.id;
      }
    }
  });

  // Counterfactual: what if EVERY call used the most expensive model?
  let counterfactualCost = 0;
  if (maxUnitRate > 0 && pricing[maxRateModel]) {
    const expensiveRate = pricing[maxRateModel];
    modelRanking.forEach((m) => {
      counterfactualCost += m.promptTokens * expensiveRate.prompt + m.completionTokens * expensiveRate.completion;
    });
  }

  // If counterfactual is less than actual (all traffic is already on expensive model), use actual
  if (counterfactualCost < totalCost) counterfactualCost = totalCost;

  const routingSavings = counterfactualCost - totalCost;
  const costReduction = counterfactualCost > 0 ? routingSavings / counterfactualCost : 0;

  // Sort dates for chart
  const sortedDates = Object.keys(byDate).sort();
  const chartData = sortedDates.map((date) => ({
    date,
    models: byDate[date],
    total: Object.values(byDate[date]).reduce((s, v) => s + v, 0),
  }));

  // Average cost per request
  const avgCostPerRequest = totalRequests > 0 ? totalCost / totalRequests : 0;

  return {
    account,
    totalCost,
    totalPromptTokens,
    totalCompletionTokens,
    totalRequests,
    modelRanking,
    chartData,
    counterfactualCost,
    routingSavings,
    costReduction,
    maxRateModel,
    maxRateModelName: pricing[maxRateModel]?.name || maxRateModel,
    avgCostPerRequest,
    activeModels: modelRanking.filter((m) => m.requests > 0).length,
    providers: [...new Set(modelRanking.map((m) => m.id.split('/')[0]))].length,
    fetchedAt: new Date().toISOString(),
    pricing,
  };
}

// ═══════════════════════════════════════════════════════════════════
// HTML DASHBOARD GENERATOR
// ═══════════════════════════════════════════════════════════════════
function generateDashboard(data) {
  const fmt = (v, d = 2) => `$${v.toFixed(d)}`;
  const fmtTokens = (v) => {
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
    return v.toString();
  };
  const fmtPct = (v) => `${(v * 100).toFixed(1)}%`;
  const fmtCompact = (v) => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toLocaleString();

  const modelColors = [
    '#c084fc', '#60a5fa', '#34d399', '#f472b6', '#fbbf24', '#fb923c',
    '#a78bfa', '#38bdf8', '#4ade80', '#f87171', '#facc15', '#e879f9',
  ];

  const top6 = data.modelRanking.slice(0, 6);
  const maxCost = top6[0]?.cost || 1;

  // Chart: build SVG inline (no dependencies)
  const chartDays = data.chartData.slice(-14); // last 14 days
  const maxDayTotal = Math.max(...chartDays.map((d) => d.total), 0.01);

  const modelBarHTML = top6.map((m, i) => {
    const color = modelColors[i % modelColors.length];
    const barWidth = Math.max(4, (m.cost / maxCost) * 100);
    return `
      <div class="model-row">
        <div class="model-info">
          <div class="model-color" style="background:${color}"></div>
          <div>
            <div class="model-name">${escapeHtml(m.name)}</div>
            <div class="model-meta">${fmtCompact(m.requests)} requests &middot; ${fmtTokens(m.totalTokens)} tokens</div>
          </div>
        </div>
        <div class="model-cost">
          <div class="model-cost-value">${fmt(m.cost)}</div>
          <div class="model-bar-track"><div class="model-bar-fill" style="width:${barWidth}%;background:${color}"></div></div>
        </div>
      </div>`;
  }).join('');

  // Chart bars
  const chartBarsHTML = chartDays.map((day) => {
    const height = Math.max(2, (day.total / maxDayTotal) * 200);
    const label = day.date.slice(5); // MM-DD
    return `
      <div class="chart-col">
        <div class="chart-bar" style="height:${height}px" title="${day.date}: ${fmt(day.total)}"></div>
        <div class="chart-label">${label}</div>
      </div>`;
  }).join('');

  const hasData = data.totalRequests > 0;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tokenmiser — Cost Report</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0f0d1a; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }

  .container { max-width:1200px; margin:0 auto; padding:32px 24px; }

  .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:28px; }
  .logo { display:flex; align-items:center; gap:12px; }
  .logo-mark { width:36px; height:36px; border-radius:10px; background:linear-gradient(135deg,#5eead4,#818cf8);
    display:flex; align-items:center; justify-content:center; font-size:18px; font-weight:800; color:#0f0d1a; }
  .logo-text { font-size:22px; font-weight:700; }
  .header-meta { font-size:12px; color:#64748b; text-align:right; }

  .kpi-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; margin-bottom:24px; }
  .kpi { background:#1e1b2e; border-radius:12px; padding:20px 24px; border-top:3px solid #5eead4; }
  .kpi.accent-purple { border-top-color:#818cf8; }
  .kpi.accent-pink { border-top-color:#f472b6; }
  .kpi-label { font-size:11px; font-weight:600; letter-spacing:1.5px; color:#94a3b8; text-transform:uppercase; margin-bottom:8px; }
  .kpi-value { font-size:32px; font-weight:700; font-family:'SF Mono','Fira Code',monospace; }
  .kpi-sub { font-size:12px; color:#5eead4; margin-top:4px; }
  .kpi.accent-purple .kpi-sub { color:#818cf8; }
  .kpi.accent-pink .kpi-sub { color:#f472b6; }

  .panels { display:grid; grid-template-columns:2fr 1fr; gap:16px; margin-bottom:24px; }
  .panel { background:#1e1b2e; border-radius:12px; padding:24px; }
  .panel-title { font-size:16px; font-weight:600; margin-bottom:4px; }
  .panel-sub { font-size:12px; color:#64748b; margin-bottom:20px; }

  .chart-container { display:flex; align-items:flex-end; gap:6px; height:220px; padding-top:20px; }
  .chart-col { display:flex; flex-direction:column; align-items:center; flex:1; }
  .chart-bar { background:linear-gradient(180deg,#5eead4 0%,#818cf8 100%); border-radius:4px 4px 0 0;
    width:100%; min-width:12px; transition:height 0.3s; cursor:pointer; }
  .chart-bar:hover { opacity:0.8; }
  .chart-label { font-size:10px; color:#64748b; margin-top:6px; }

  .model-row { display:flex; align-items:center; justify-content:space-between; padding:12px 0;
    border-bottom:1px solid rgba(148,163,184,0.08); }
  .model-info { display:flex; align-items:center; gap:10px; flex:1; }
  .model-color { width:4px; height:36px; border-radius:2px; }
  .model-name { font-size:14px; font-weight:500; }
  .model-meta { font-size:12px; color:#64748b; }
  .model-cost { text-align:right; min-width:100px; }
  .model-cost-value { font-size:18px; font-weight:700; font-family:'SF Mono',monospace; }
  .model-bar-track { height:3px; border-radius:2px; background:rgba(148,163,184,0.1); margin-top:4px; }
  .model-bar-fill { height:100%; border-radius:2px; transition:width 0.5s; }

  .bottom-row { display:grid; grid-template-columns:2fr 1fr; gap:16px; }
  .savings-card { background:linear-gradient(135deg,#1a2e2a,#162028); border-radius:12px; padding:28px;
    display:flex; flex-direction:column; justify-content:center; }
  .savings-label { font-size:12px; font-weight:700; letter-spacing:2px; color:#5eead4; text-transform:uppercase; margin-bottom:8px; }
  .savings-value { font-size:48px; font-weight:800; line-height:1.1; margin-bottom:12px; font-family:'SF Mono',monospace; }
  .savings-value span { font-size:24px; color:#94a3b8; }
  .savings-desc { font-size:13px; color:#94a3b8; line-height:1.5; margin-bottom:24px; }
  .savings-stats { display:flex; gap:24px; }
  .stat-value { font-size:22px; font-weight:700; }
  .stat-label { font-size:9px; font-weight:600; letter-spacing:1.5px; color:#64748b; text-transform:uppercase; margin-top:2px; }

  table { width:100%; border-collapse:collapse; }
  th { text-align:left; padding:8px 12px; font-size:11px; font-weight:600; letter-spacing:1px; color:#64748b;
    text-transform:uppercase; border-bottom:1px solid rgba(148,163,184,0.1); }
  td { padding:12px; font-size:13px; border-bottom:1px solid rgba(148,163,184,0.06); }
  td.mono { font-family:'SF Mono','Fira Code',monospace; }

  .footer { margin-top:24px; padding:12px 16px; border-radius:8px; background:rgba(148,163,184,0.04);
    border:1px solid rgba(148,163,184,0.06); font-size:11px; color:#64748b; display:flex; align-items:center; gap:8px; }

  .empty-state { text-align:center; padding:60px 20px; }
  .empty-state h2 { font-size:20px; margin-bottom:12px; }
  .empty-state p { color:#94a3b8; font-size:14px; max-width:500px; margin:0 auto; }

  @media (max-width:768px) {
    .kpi-grid { grid-template-columns:repeat(2,1fr); }
    .panels, .bottom-row { grid-template-columns:1fr; }
    .savings-value { font-size:36px; }
  }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <div class="logo">
      <div class="logo-mark">T</div>
      <div class="logo-text">Tokenmiser</div>
    </div>
    <div class="header-meta">
      Report generated ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}<br>
      Data: last 30 days via OpenRouter API
    </div>
  </div>

  ${hasData ? `
  <!-- KPI Cards -->
  <div class="kpi-grid">
    <div class="kpi">
      <div class="kpi-label">Total Spend (30d)</div>
      <div class="kpi-value">${fmt(data.totalCost)}</div>
      <div class="kpi-sub">${fmtTokens(data.totalPromptTokens + data.totalCompletionTokens)} tokens</div>
    </div>
    <div class="kpi accent-purple">
      <div class="kpi-label">Active Models</div>
      <div class="kpi-value">${data.activeModels}</div>
      <div class="kpi-sub">Across ${data.providers} provider${data.providers !== 1 ? 's' : ''}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Avg Cost / Request</div>
      <div class="kpi-value">$${data.avgCostPerRequest.toFixed(4)}</div>
      <div class="kpi-sub">${fmtCompact(data.totalRequests)} total requests</div>
    </div>
    <div class="kpi accent-pink">
      <div class="kpi-label">Potential Savings</div>
      <div class="kpi-value">${fmt(data.routingSavings, 0)}</div>
      <div class="kpi-sub">${fmtPct(data.costReduction)} via routing optimization</div>
    </div>
  </div>

  <!-- Chart + Model Breakdown -->
  <div class="panels">
    <div class="panel">
      <div class="panel-title">Daily Spend</div>
      <div class="panel-sub">Last ${chartDays.length} days, all providers</div>
      <div class="chart-container">${chartBarsHTML}</div>
    </div>
    <div class="panel">
      <div class="panel-title">Spend by Model</div>
      <div class="panel-sub">Current billing period</div>
      ${modelBarHTML}
    </div>
  </div>

  <!-- Detail Table + Savings -->
  <div class="bottom-row">
    <div class="panel">
      <div class="panel-title">All Models</div>
      <div class="panel-sub">Ranked by spend</div>
      <table>
        <thead><tr><th>Model</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead>
        <tbody>
          ${data.modelRanking.map((m) => `
          <tr>
            <td>${escapeHtml(m.name)}</td>
            <td class="mono">${fmtCompact(m.requests)}</td>
            <td class="mono">${fmtTokens(m.totalTokens)}</td>
            <td class="mono">${fmt(m.cost)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="savings-card">
      <div class="savings-label">Routing Savings Opportunity</div>
      <div class="savings-value">${fmt(data.routingSavings, 0)}<span>/mo</span></div>
      <div class="savings-desc">
        If all ${fmtCompact(data.totalRequests)} requests had been routed to
        ${escapeHtml(data.maxRateModelName)}, your bill would have been ${fmt(data.counterfactualCost)}.
        Smart model routing saved (or could save) you ${fmtPct(data.costReduction)}.
      </div>
      <div class="savings-stats">
        <div>
          <div class="stat-value">${data.activeModels}</div>
          <div class="stat-label">Models Used</div>
        </div>
        <div>
          <div class="stat-value">${fmtPct(data.costReduction)}</div>
          <div class="stat-label">Cost Reduction</div>
        </div>
        <div>
          <div class="stat-value">${fmtCompact(data.totalRequests)}</div>
          <div class="stat-label">Total Requests</div>
        </div>
      </div>
    </div>
  </div>
  ` : `
  <div class="empty-state">
    <h2>No usage data found</h2>
    <p>Your OpenRouter account has no activity in the last 30 days. Make some API calls and run tokenmiser again to see your cost breakdown.</p>
  </div>
  `}

  <div class="footer">
    &#128065; All costs from OpenRouter API. Counterfactual = all tokens repriced at
    ${escapeHtml(data.maxRateModelName)} rates (${data.pricing[data.maxRateModel] ?
      `$${(data.pricing[data.maxRateModel].prompt * 1e6).toFixed(2)}/$${(data.pricing[data.maxRateModel].completion * 1e6).toFixed(2)} per MTok` :
      'highest unit rate'}).
    Generated by Tokenmiser v${VERSION}.
  </div>
</div>
</body>
</html>`;

  return html;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════════
// OPEN IN BROWSER
// ═══════════════════════════════════════════════════════════════════
function openInBrowser(filepath) {
  const platform = process.platform;
  try {
    if (platform === 'darwin') execSync(`open "${filepath}"`);
    else if (platform === 'win32') execSync(`start "" "${filepath}"`);
    else execSync(`xdg-open "${filepath}"`);
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  const opts = parseArgs();

  if (opts.version) { console.log(`tokenmiser v${VERSION}`); process.exit(0); }
  if (opts.help) { printHelp(); process.exit(0); }

  // Resolve API key: --key flag > env var > interactive prompt
  let apiKey = opts.key || process.env.OPENROUTER_API_KEY || null;
  if (!apiKey) {
    console.log('\n  Tokenmiser — See where your AI API money goes.\n');
    console.log('  No API key found. Get yours at https://openrouter.ai/settings/keys');
    apiKey = await promptForKey();
  }

  if (!apiKey) {
    console.error('\n  Error: No API key provided. Exiting.\n');
    process.exit(1);
  }

  try {
    const data = await collectData(apiKey);

    if (opts.json) {
      // Raw JSON output for piping
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    // Generate and save HTML dashboard
    const html = generateDashboard(data);
    fs.writeFileSync(OUTPUT_FILE, html, 'utf8');

    // Summary to terminal
    console.log(`\n  ╔═══════════════════════════════════════════════════════╗`);
    console.log(`  ║  TOKENMISER REPORT                                    ║`);
    console.log(`  ╚═══════════════════════════════════════════════════════╝`);
    console.log(`  Total Spend (30d):    $${data.totalCost.toFixed(2)}`);
    console.log(`  Active Models:        ${data.activeModels}`);
    console.log(`  Total Requests:       ${data.totalRequests.toLocaleString()}`);
    console.log(`  Avg Cost/Request:     $${data.avgCostPerRequest.toFixed(4)}`);
    console.log(`  ─────────────────────────────────────────────────────────`);
    console.log(`  Counterfactual:       $${data.counterfactualCost.toFixed(2)} (all → ${data.maxRateModelName})`);
    console.log(`  Routing Savings:      $${data.routingSavings.toFixed(2)} (${(data.costReduction * 100).toFixed(1)}% reduction)`);
    console.log(`  ─────────────────────────────────────────────────────────`);

    data.modelRanking.slice(0, 5).forEach((m) => {
      console.log(`  ${m.name.padEnd(35)} $${m.cost.toFixed(2).padStart(10)}`);
    });
    if (data.modelRanking.length > 5) {
      console.log(`  ... and ${data.modelRanking.length - 5} more`);
    }

    console.log(`\n  Dashboard saved to: ${OUTPUT_FILE}`);

    const opened = openInBrowser(OUTPUT_FILE);
    if (opened) {
      console.log(`  Opened in your browser.\n`);
    } else {
      console.log(`  Open the file above in your browser to see the full dashboard.\n`);
    }
  } catch (err) {
    console.error(`\n  Error: ${err.message}\n`);
    process.exit(1);
  }
}

main();
