'use strict';

/**
 * Dashboard generator — produces a self-contained interactive HTML file.
 *
 * Architecture:
 *  - All data embedded as JSON in <script> tags
 *  - Client-side JS handles: view routing, filtering, aggregation, charting
 *  - Each sidebar nav item routes to a real view section
 *  - Per-token records and subscription records are separate data arrays
 */

const { escapeHtml } = require('../format');
const { generateCSS } = require('./styles');
const overviewView = require('./views/overview');
const costExplorerView = require('./views/cost-explorer');
const modelAnalyticsView = require('./views/model-analytics');
const taskMonitorView = require('./views/task-monitor');
const budgetAlertsView = require('./views/budget-alerts');
const optimizationView = require('./views/optimization');
const settingsView = require('./views/settings');

/**
 * Compact a record for embedding (minimize JSON size).
 */
function compactRecord(r) {
  return {
    s: r.source,
    bp: r.billingPath,
    d: r.date,
    m: r.model,
    mn: r.modelName,
    pt: r.promptTokens,
    ct: r.completionTokens,
    c: r.cost,
    rq: r.requests,
    est: r.estimated || false,
    dup: r.deduplicated || false,
    app: r.appName || '',
    ep: r.entrypoint || '',
  };
}

/**
 * Compact a subscription record for embedding.
 */
function compactSubscription(s) {
  return {
    prov: s.providerName || s.provider,
    pn: s.accountLabel,
    plan: s.planName,
    mc: s.monthlyCost,
    pc: s.proratedCost,
    partial: s.isPartial,
    month: s.month,
  };
}

/**
 * Generate the full HTML dashboard.
 *
 * @param {Array} records - All per-token records
 * @param {Array} sources - Source summary objects
 * @param {boolean} allEstimated - True if no API sources found
 * @param {Array} subscriptionRecords - Subscription cost records
 * @param {Array} budgets - Budget alert configs
 * @param {string} version - Version string
 */
function generateDashboard(records, sources, allEstimated, subscriptionRecords = [], budgets = [], version = '4.0.0') {
  const embedRecords = records.map(compactRecord);
  const embedSubs = subscriptionRecords.map(compactSubscription);
  const COLORS = "['#c084fc','#60a5fa','#34d399','#f472b6','#fbbf24','#fb923c','#a78bfa','#38bdf8']";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tokenmiser — AI Spend Dashboard</title>
<style>
${generateCSS()}
</style>
</head>
<body>
<div class="layout">
<!-- ── Sidebar ── -->
<aside class="sidebar">
  <div class="logo"><div class="logo-mark">T</div><div class="logo-text">Tokenmiser</div></div>
  <div class="nav-section">
    <div class="nav-label">Overview</div>
    <a class="nav-item active" data-view="dashboard" onclick="switchView('dashboard')"><span class="nav-dot"></span> Dashboard</a>
    <a class="nav-item" data-view="cost-explorer" onclick="switchView('cost-explorer')"><span class="nav-dot"></span> Cost Explorer</a>
    <a class="nav-item" data-view="model-analytics" onclick="switchView('model-analytics')"><span class="nav-dot"></span> Model Analytics</a>
  </div>
  <div class="nav-section">
    <div class="nav-label">Operations</div>
    <a class="nav-item" data-view="task-monitor" onclick="switchView('task-monitor')"><span class="nav-dot"></span> Task Monitor</a>
    <a class="nav-item" data-view="budget-alerts" onclick="switchView('budget-alerts')"><span class="nav-dot"></span> Budget Alerts</a>
    <a class="nav-item" data-view="optimization" onclick="switchView('optimization')"><span class="nav-dot"></span> Optimization</a>
  </div>
  <div class="nav-section">
    <div class="nav-label">Settings</div>
    <a class="nav-item" data-view="settings" onclick="switchView('settings')"><span class="nav-dot"></span> Settings</a>
  </div>
</aside>
<!-- ── Main Content ── -->
<main class="main-content">
${overviewView.generateHTML()}
${costExplorerView.generateHTML()}
${modelAnalyticsView.generateHTML()}
${taskMonitorView.generateHTML()}
${budgetAlertsView.generateHTML()}
${optimizationView.generateHTML()}
${settingsView.generateHTML()}
</main>
</div>

<script>
// ── Embedded data ──
var RAW_RECORDS = ${JSON.stringify(embedRecords).replace(/<\//g, '<\\/')};
var RAW_SUBSCRIPTIONS = ${JSON.stringify(embedSubs).replace(/<\//g, '<\\/')};
var SOURCES = ${JSON.stringify(sources).replace(/<\//g, '<\\/')};
var BUDGETS = ${JSON.stringify(budgets).replace(/<\//g, '<\\/')};
var ALL_ESTIMATED = ${allEstimated};
var VERSION = '${escapeHtml(version)}';
var COLORS = ${COLORS};

var currentPeriod = 30;
var chartMode = 'bar';
var currentView = 'dashboard';

// Build source list from data for toggle UI — use billingPath for grouping
var sourcesInData = {};
RAW_RECORDS.forEach(function(r) { sourcesInData[r.bp] = true; });
var enabledSources = Object.assign({}, sourcesInData);

// Total subscription cost
var totalSubCost = RAW_SUBSCRIPTIONS.reduce(function(s, r) { return s + r.pc; }, 0);

// ── Format helpers ──
function fmtMoney(v, d) { d = d !== undefined ? d : 2; return '$' + v.toFixed(d); }
function fmtTokens(v) { if (v >= 1e6) return (v/1e6).toFixed(1)+'M'; if (v >= 1e3) return Math.round(v/1e3)+'K'; return ''+v; }
function fmtPct(v) { return (v*100).toFixed(1)+'%'; }
function fmtCompact(v) { return v >= 1000 ? (v/1000).toFixed(1)+'K' : v.toLocaleString(); }
function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

var sourceNames = {
  'openrouter': 'OpenRouter API', 'openrouter-csv': 'OpenRouter CSV',
  'anthropic': 'Anthropic API', 'openai': 'OpenAI API',
  'claude-code': 'Claude Code', 'codex-cli': 'Codex CLI',
  'cline': 'Cline', 'aider': 'Aider',
  'gemini-cli': 'Gemini CLI', 'cursor': 'Cursor'
};

var billingPathNames = {
  'openrouter': 'OpenRouter (per-token)', 'oauth': 'Subscription (Pro/Max/Plus)',
  'anthropic': 'Anthropic API (per-token)', 'openai': 'OpenAI API (per-token)',
  'google-api': 'Google AI (per-token)', 'google-subscription': 'Gemini Advanced (subscription)',
  'vertex-ai': 'Vertex AI (per-token)', 'cursor-subscription': 'Cursor (subscription)',
  'local-estimate': 'Local Estimate', 'local-usage-only': 'Usage Only (no cost data)',
  'local-usage (covered by API)': 'Covered by API', 'unknown': 'Unknown'
};

// Build a label for a record showing its actual source
function recordSourceLabel(r) {
  var parts = [];
  if (r.bp) parts.push(billingPathNames[r.bp] || r.bp);
  if (r.app) parts.push(r.app);
  else if (r.ep) parts.push(r.ep);
  return parts.join(' / ') || sourceNames[r.s] || r.s;
}

// ── View routing ──
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view-section').forEach(function(s) { s.classList.remove('active'); });
  document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });

  var viewEl = document.getElementById('view-' + view);
  if (viewEl) viewEl.classList.add('active');

  var navEl = document.querySelector('[data-view="' + view + '"]');
  if (navEl) navEl.classList.add('active');

  // Render the view
  if (view === 'dashboard') renderOverview();
  else if (view === 'cost-explorer') renderCostExplorer();
  else if (view === 'model-analytics') renderModelAnalytics();
  else if (view === 'task-monitor') renderTaskMonitor();
  else if (view === 'budget-alerts') renderBudgetAlerts();
  else if (view === 'optimization') renderOptimization();
  else if (view === 'settings') renderSettings();
}

// ── Filter + Aggregate ──
function filterByPeriod(records, days) {
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  var cutoffStr = cutoff.toISOString().slice(0,10);
  return records.filter(function(r) {
    return r.d >= cutoffStr && enabledSources[r.bp] && !r.dup;
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
      totalTokens:d.pt+d.ct, sources:Object.keys(d.sources).map(function(k){return billingPathNames[k]||k}).join(', '),
      rawSources:Object.keys(d.sources) };
  }).sort(function(a,b) { return (b.cost - a.cost) || (b.rq - a.rq); });

  var sortedDates = Object.keys(byDate).sort();
  var chartData = sortedDates.map(function(date) {
    var models = byDate[date];
    var total = 0; for (var k in models) total += models[k];
    return { date:date, models:models, total:total };
  });

  var activeModels = modelRanking.filter(function(m){return m.rq>0}).length;
  var provSet = {}; modelRanking.forEach(function(m){ provSet[m.id.split('/')[0]]=1; });

  // Counterfactual savings (approximate)
  var routingSavings = 0, costReduction = 0, counterfactualCost = totalCost, maxRateModelName = 'unknown';
  if (modelRanking.length > 1) {
    var maxRate = 0;
    modelRanking.forEach(function(m) {
      if (m.totalTokens > 0) {
        var rate = m.cost / m.totalTokens;
        if (rate > maxRate) { maxRate = rate; maxRateModelName = m.name; }
      }
    });
    if (maxRate > 0) {
      counterfactualCost = 0;
      modelRanking.forEach(function(m) { counterfactualCost += m.totalTokens * maxRate; });
      if (counterfactualCost < totalCost) counterfactualCost = totalCost;
      routingSavings = counterfactualCost - totalCost;
      costReduction = counterfactualCost > 0 ? routingSavings / counterfactualCost : 0;
    }
  }

  return {
    totalCost:totalCost, totalPromptTokens:totalPrompt, totalCompletionTokens:totalCompletion,
    totalRequests:totalRequests, modelRanking:modelRanking, chartData:chartData, bySource:bySource,
    avgCostPerRequest: totalRequests > 0 ? totalCost/totalRequests : 0,
    activeModels:activeModels, providers:Object.keys(provSet).length,
    routingSavings:routingSavings, costReduction:costReduction,
    counterfactualCost:counterfactualCost, maxRateModelName:maxRateModelName,
  };
}

// ── Period + Chart mode ──
function setPeriod(days) {
  currentPeriod = days;
  document.querySelectorAll('.period-btn').forEach(function(b){
    b.classList.toggle('active', parseInt(b.getAttribute('data-days'))===days);
  });
  renderAll();
}

function setChartMode(mode) {
  chartMode = mode;
  var barEl = document.getElementById('bar-chart');
  var lineEl = document.getElementById('line-chart');
  var barBtn = document.getElementById('bar-btn');
  var lineBtn = document.getElementById('line-btn');
  if (barBtn) barBtn.classList.toggle('active', mode==='bar');
  if (lineBtn) lineBtn.classList.toggle('active', mode==='line');
  if (barEl) barEl.style.display = mode==='bar' ? 'flex' : 'none';
  if (lineEl) {
    lineEl.style.display = mode==='line' ? 'block' : 'none';
    if (mode==='line') lineEl.classList.add('active');
    else lineEl.classList.remove('active');
  }
}

// ── Overview rendering ──
function renderOverview() {
  var filtered = filterByPeriod(RAW_RECORDS, currentPeriod);
  var data = aggregateRecords(filtered);
  var localOnly = ALL_ESTIMATED;
  var periodLabel = currentPeriod === 1 ? '24h' : currentPeriod + 'd';

  // Source toggles — grouped by billing path
  var stHTML = '';
  var allSrcs = Object.keys(sourcesInData);
  if (allSrcs.length > 0) {
    allSrcs.forEach(function(src) {
      var on = !!enabledSources[src];
      var label = billingPathNames[src] || src;
      var cls = on ? 'source-toggle on' : 'source-toggle off';
      if (src === 'oauth') cls = on ? 'source-toggle sub-on' : 'source-toggle off';
      stHTML += '<button class="'+cls+'" onclick="toggleSource(\\''+src+'\\')\">' + esc(label) + '</button>';
    });
    // Add subscription toggles if any
    if (RAW_SUBSCRIPTIONS.length > 0) {
      stHTML += '<button class="source-toggle sub-on" style="cursor:default">Subscriptions: '+fmtMoney(totalSubCost)+'</button>';
    }
  }
  document.getElementById('source-toggles').innerHTML = stHTML;

  // Warning
  var wb = document.getElementById('warning-banner');
  var warnings = [];
  if (localOnly) {
    warnings.push('<div class="warning-banner"><strong>\\u26a0 Estimated costs</strong> \\u2014 No API keys found. Costs are rough estimates. Set <code>OPENROUTER_API_KEY</code> or <code>ANTHROPIC_ADMIN_KEY</code> for actual billing data.</div>');
  }
  // Subscription detection banner
  var subBillingPaths = ['oauth', 'cursor-subscription', 'google-subscription'];
  var hasSubUsage = RAW_RECORDS.some(function(r) { return subBillingPaths.indexOf(r.bp) !== -1; });
  if (hasSubUsage && RAW_SUBSCRIPTIONS.length === 0) {
    warnings.push('<div class="warning-banner" style="border-color:#fbbf24;background:rgba(251,191,36,0.06)"><strong>\\u26a0 Subscription usage detected</strong> \\u2014 You have usage billed through a subscription plan, but no subscriptions are configured. Run <code>tokenmiser config --add-sub</code> or <code>tokenmiser --quick-sub claude-pro</code> to track your plan cost.</div>');
  }
  wb.innerHTML = warnings.join('');

  // KPIs (include subscription cost in total)
  var totalWithSubs = data.totalCost + totalSubCost;
  document.getElementById('kpi-grid').innerHTML =
    '<div class="kpi"><div class="kpi-label">Total Spend (' + periodLabel + ')</div><div class="kpi-value">' +
      (localOnly ? 'Usage only' : fmtMoney(totalWithSubs)) +
    '</div><div class="kpi-sub">' + fmtTokens(data.totalPromptTokens+data.totalCompletionTokens) + ' tokens' + (totalSubCost > 0 ? ' + '+fmtMoney(totalSubCost)+' subscriptions' : '') + '</div></div>' +
    '<div class="kpi accent-purple"><div class="kpi-label">Active Models</div><div class="kpi-value">' + data.activeModels +
    '</div><div class="kpi-sub">Across ' + data.providers + ' provider' + (data.providers!==1?'s':'') + '</div></div>' +
    '<div class="kpi accent-orange"><div class="kpi-label">Avg Cost / Request</div><div class="kpi-value">' +
      (localOnly ? '\\u2014' : fmtMoney(data.avgCostPerRequest, 4)) +
    '</div><div class="kpi-sub">' + fmtCompact(data.totalRequests) + ' total requests</div></div>' +
    '<div class="kpi accent-pink"><div class="kpi-label">Routing Savings</div><div class="kpi-value">' +
      (localOnly ? '\\u2014' : fmtMoney(data.routingSavings, 0)) +
    '</div><div class="kpi-sub">' + (localOnly ? 'Connect API keys' : fmtPct(data.costReduction) + ' vs single-model') + '</div></div>';

  // Subscription section
  var subEl = document.getElementById('sub-section');
  if (RAW_SUBSCRIPTIONS.length > 0) {
    var subHTML = '<div class="sub-section"><div class="panel-header"><div class="panel-title">Subscriptions</div><div class="sub-badge">Fixed Cost</div></div><div class="panel-sub">Monthly subscription plans (prorated for partial months)</div>';
    RAW_SUBSCRIPTIONS.forEach(function(s) {
      subHTML += '<div class="sub-row"><div><div class="sub-provider">'+esc(s.prov)+' — '+esc(s.pn)+'</div><div class="sub-account"><span class="sub-badge">'+esc(s.plan)+'</span>'+(s.partial ? ' <span style="color:#fbbf24;font-size:10px">Partial month</span>' : '')+'</div></div><div class="sub-cost">'+fmtMoney(s.pc)+'<div class="sub-plan">'+(s.partial ? 'of '+fmtMoney(s.mc)+'/mo' : '/mo')+'</div></div></div>';
    });
    subHTML += '</div>';
    subEl.innerHTML = subHTML;
  } else {
    subEl.innerHTML = '';
  }

  // Chart subtitle
  document.getElementById('chart-sub').textContent = 'Last ' + currentPeriod + ' days, all providers';

  // Charts
  var chartDays = data.chartData;
  var maxDayTotal = Math.max.apply(null, chartDays.map(function(d){return d.total}).concat([0.01]));

  if (localOnly || chartDays.length === 0) {
    document.getElementById('bar-chart').innerHTML = '<div class="chart-empty">Connect an API key to see cost trends</div>';
    document.getElementById('line-chart').innerHTML = '';
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
    for (var yi=0;yi<=4;yi++) {
      var val=(maxDayTotal/4)*yi, yt=P+pH-(val/maxDayTotal)*pH;
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

  // Fix chart mode display
  setChartMode(chartMode);

  // Model ranking (top 6)
  var top6 = data.modelRanking.slice(0, 6);
  var maxModelCost = top6.length > 0 ? Math.max(top6[0].cost, 0.01) : 1;
  var mrHTML = top6.map(function(m, i) {
    var c = COLORS[i % COLORS.length];
    var w = Math.max(4, (m.cost / maxModelCost) * 100);
    var costDisplay = (m.sources === 'Usage Only' || m.sources === 'OAuth (Subscription)') ? '\\u2014' : fmtMoney(m.cost);
    return '<div class="model-row"><div class="model-info"><div class="model-color" style="background:'+c+'"></div><div><div class="model-name">'+esc(m.name)+'</div><div class="model-meta">'+fmtCompact(m.rq)+' req &middot; '+fmtTokens(m.totalTokens)+' tok &middot; <span class="billing-tag">'+esc(m.sources)+'</span></div></div></div><div class="model-cost"><div class="model-cost-value">'+costDisplay+'</div><div class="model-bar-track"><div class="model-bar-fill" style="width:'+w+'%;background:'+c+'"></div></div></div></div>';
  }).join('');
  document.getElementById('model-ranking').innerHTML = mrHTML;

  // Billing path table
  var bpKeys = Object.keys(data.bySource);
  var bpHTML = '<table><thead><tr><th>Billing Path</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>';
  bpKeys.forEach(function(p) {
    var d = data.bySource[p];
    bpHTML += '<tr><td>'+esc(p)+'</td><td class="mono">'+fmtCompact(d.rq)+'</td><td class="mono">'+fmtTokens(d.tokens)+'</td><td class="mono">'+fmtMoney(d.cost)+'</td></tr>';
  });
  // Add subscription rows
  if (RAW_SUBSCRIPTIONS.length > 0) {
    RAW_SUBSCRIPTIONS.forEach(function(s) {
      bpHTML += '<tr><td>'+esc(s.prov+' / '+s.pn)+' <span class="sub-badge">'+esc(s.plan)+'</span></td><td class="mono">\\u2014</td><td class="mono">\\u2014</td><td class="mono">'+fmtMoney(s.pc)+'</td></tr>';
    });
  }
  bpHTML += '</tbody></table>';
  document.getElementById('billing-table').innerHTML = bpHTML;

  // All models table
  var amHTML = '<table><thead><tr><th>Model</th><th>Requests</th><th>Cost</th></tr></thead><tbody>';
  data.modelRanking.forEach(function(m) {
    var costDisplay = (m.sources === 'Usage Only' || m.sources === 'OAuth (Subscription)') ? '\\u2014' : fmtMoney(m.cost);
    amHTML += '<tr><td>'+esc(m.name)+'</td><td class="mono">'+fmtCompact(m.rq)+'</td><td class="mono">'+costDisplay+'</td></tr>';
  });
  amHTML += '</tbody></table>';
  document.getElementById('all-models-table').innerHTML = amHTML;

  // Savings card
  var sc = document.getElementById('savings-card');
  if (localOnly) {
    sc.innerHTML = '<div class="savings-label">Routing Savings</div><div class="savings-value">\\u2014</div><div class="savings-desc">Connect API keys to unlock savings analysis.</div>';
  } else {
    sc.innerHTML = '<div class="savings-label">Routing Savings</div><div class="savings-value">' + fmtMoney(data.routingSavings,0) + '<span>/mo</span></div>' +
      '<div class="savings-desc">Savings from using ' + data.activeModels + ' models instead of only ' + esc(data.maxRateModelName) + '.</div>' +
      '<div class="savings-stats"><div><div class="stat-value">' + fmtPct(data.costReduction) + '</div><div class="stat-label">Reduction</div></div>' +
      '<div><div class="stat-value">' + data.activeModels + '</div><div class="stat-label">Models</div></div>' +
      '<div><div class="stat-value">' + bpKeys.length + '</div><div class="stat-label">Bill Paths</div></div></div>';
  }

  // Footer
  var dupCount = RAW_RECORDS.filter(function(r){return r.dup}).length;
  var apiPaths = bpKeys.filter(function(p){return p!=='local-usage-only'});
  var dupNote = dupCount > 0 ? ' ' + dupCount + ' local log entries deduplicated.' : '';
  document.getElementById('footer').innerHTML = localOnly
    ? '\\u26a0 Estimated costs from local logs. Set API keys for billing data. Tokenmiser v' + VERSION
    : 'Costs from: ' + apiPaths.map(esc).join(', ') + '.' + dupNote + (totalSubCost > 0 ? ' Subscriptions: '+fmtMoney(totalSubCost)+'/mo.' : '') + ' Tokenmiser v' + VERSION;
}

// ── View-specific JS ──
${costExplorerView.generateJS()}
${modelAnalyticsView.generateJS()}
${taskMonitorView.generateJS()}
${budgetAlertsView.generateJS()}
${optimizationView.generateJS()}
${settingsView.generateJS()}

// ── Render all (for current view) ──
function renderAll() {
  switchView(currentView);
}

// ── Init ──
renderOverview();
</script>
</body>
</html>`;
}

module.exports = { generateDashboard };
