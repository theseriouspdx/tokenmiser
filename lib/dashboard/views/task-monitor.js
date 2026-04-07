'use strict';

/**
 * Task Monitor view — recent activity from local logs.
 * Shows per-task/session detail: model, tokens, cost, project, recency.
 */

function generateHTML() {
  return `
  <div id="view-task-monitor" class="view-section">
    <div class="top-bar">
      <h1>Task Monitor</h1>
      <div style="display:flex;align-items:center;gap:8px">
        <select id="tm-source-filter" onchange="renderTaskMonitor()" style="background:#1e1b2e;color:#e2e8f0;border:1px solid rgba(148,163,184,0.2);border-radius:6px;padding:5px 10px;font-size:12px">
          <option value="all">All Sources</option>
        </select>
        <select id="tm-sort" onchange="renderTaskMonitor()" style="background:#1e1b2e;color:#e2e8f0;border:1px solid rgba(148,163,184,0.2);border-radius:6px;padding:5px 10px;font-size:12px">
          <option value="date">Most Recent</option>
          <option value="tokens">Most Tokens</option>
          <option value="cost">Highest Cost</option>
          <option value="requests">Most Requests</option>
        </select>
      </div>
    </div>
    <div id="tm-summary" class="kpi-grid" style="margin-bottom:16px"></div>
    <div class="panel">
      <div class="panel-title">Recent Activity</div>
      <div class="panel-sub">Aggregated by date and model from all detected sources</div>
      <div id="tm-table" style="max-height:600px;overflow-y:auto"></div>
    </div>
    <div class="panels" style="margin-top:14px">
      <div class="panel">
        <div class="panel-title">Activity by Source</div>
        <div id="tm-by-source"></div>
      </div>
      <div class="panel">
        <div class="panel-title">Daily Activity</div>
        <div id="tm-daily" style="height:200px"></div>
      </div>
    </div>
  </div>`;
}

function generateJS() {
  return `
function renderTaskMonitor() {
  var srcFilter = document.getElementById('tm-source-filter').value;
  var sortBy = document.getElementById('tm-sort').value;
  var filtered = filterByPeriod(RAW_RECORDS, currentPeriod);

  if (srcFilter !== 'all') {
    filtered = filtered.filter(function(r) { return r.s === srcFilter; });
  }

  // Populate source filter
  var srcs = {};
  RAW_RECORDS.forEach(function(r) { srcs[r.s] = 1; });
  var srcSelect = document.getElementById('tm-source-filter');
  var cur = srcSelect.value;
  srcSelect.innerHTML = '<option value="all">All Sources</option>';
  Object.keys(srcs).forEach(function(s) {
    srcSelect.innerHTML += '<option value="'+esc(s)+'"'+(s===cur?' selected':'')+'>'+esc(sourceNames[s]||s)+'</option>';
  });

  var data = aggregateRecords(filtered);

  // Summary
  var localCount = filtered.filter(function(r){return r.s==='claude-code'||r.s==='codex-cli'||r.s==='cline'||r.s==='aider'}).length;
  document.getElementById('tm-summary').innerHTML =
    '<div class="kpi"><div class="kpi-label">Total Records</div><div class="kpi-value">'+filtered.length+'</div><div class="kpi-sub">In current period</div></div>'+
    '<div class="kpi accent-purple"><div class="kpi-label">Local Log Entries</div><div class="kpi-value">'+localCount+'</div><div class="kpi-sub">From CLI tools</div></div>'+
    '<div class="kpi accent-orange"><div class="kpi-label">Total Requests</div><div class="kpi-value">'+fmtCompact(data.totalRequests)+'</div><div class="kpi-sub">Across all sources</div></div>'+
    '<div class="kpi accent-pink"><div class="kpi-label">Total Tokens</div><div class="kpi-value">'+fmtTokens(data.totalPromptTokens+data.totalCompletionTokens)+'</div><div class="kpi-sub">'+fmtTokens(data.totalPromptTokens)+' in / '+fmtTokens(data.totalCompletionTokens)+' out</div></div>';

  // Sort records for table
  var sortedRecords = filtered.slice().sort(function(a,b) {
    if (sortBy === 'date') return b.d.localeCompare(a.d);
    if (sortBy === 'tokens') return (b.pt+b.ct) - (a.pt+a.ct);
    if (sortBy === 'cost') return b.c - a.c;
    if (sortBy === 'requests') return b.rq - a.rq;
    return 0;
  });

  var tableHTML = '<table><thead><tr><th>Date</th><th>Source</th><th>Model</th><th>Requests</th><th>Input Tok</th><th>Output Tok</th><th>Cost</th></tr></thead><tbody>';
  sortedRecords.slice(0, 100).forEach(function(r) {
    var srcLabel = sourceNames[r.s] || r.s;
    tableHTML += '<tr><td>'+esc(r.d)+'</td><td><span class="billing-tag">'+esc(srcLabel)+'</span></td><td>'+esc(r.mn)+'</td><td class="mono">'+fmtCompact(r.rq)+'</td><td class="mono">'+fmtTokens(r.pt)+'</td><td class="mono">'+fmtTokens(r.ct)+'</td><td class="mono">'+(r.c > 0 ? fmtMoney(r.c) : '\\u2014')+'</td></tr>';
  });
  if (sortedRecords.length > 100) {
    tableHTML += '<tr><td colspan="7" style="color:#475569;text-align:center;padding:12px">... and '+(sortedRecords.length-100)+' more records</td></tr>';
  }
  tableHTML += '</tbody></table>';
  document.getElementById('tm-table').innerHTML = tableHTML;

  // By source
  var bySrc = {};
  filtered.forEach(function(r) {
    if (!bySrc[r.s]) bySrc[r.s] = { rq:0, tokens:0 };
    bySrc[r.s].rq += r.rq;
    bySrc[r.s].tokens += r.pt + r.ct;
  });
  var maxTok = Math.max.apply(null, Object.values(bySrc).map(function(d){return d.tokens}).concat([1]));
  var srcHTML = Object.keys(bySrc).map(function(s, i) {
    var d = bySrc[s];
    var w = Math.max(4, (d.tokens / maxTok) * 100);
    var c = COLORS[i % COLORS.length];
    return '<div class="model-row"><div class="model-info"><div class="model-color" style="background:'+c+'"></div><div><div class="model-name">'+esc(sourceNames[s]||s)+'</div><div class="model-meta">'+fmtCompact(d.rq)+' requests</div></div></div><div class="model-cost"><div class="model-cost-value">'+fmtTokens(d.tokens)+'</div><div class="model-bar-track"><div class="model-bar-fill" style="width:'+w+'%;background:'+c+'"></div></div></div></div>';
  }).join('');
  document.getElementById('tm-by-source').innerHTML = srcHTML || '<p style="color:#475569;font-size:12px">No data</p>';

  // Daily activity
  var byDate = {};
  filtered.forEach(function(r) {
    byDate[r.d] = (byDate[r.d] || 0) + r.rq;
  });
  var dates = Object.keys(byDate).sort().slice(-14);
  var maxDay = Math.max.apply(null, dates.map(function(d){return byDate[d]}).concat([1]));
  var dailyHTML = '<div class="chart-container" style="height:180px">' + dates.map(function(d) {
    var h = Math.max(2, (byDate[d] / maxDay) * 160);
    return '<div class="chart-col"><div class="chart-bar" style="height:'+h+'px" title="'+d+': '+byDate[d]+' req"></div><div class="chart-label">'+d.slice(5)+'</div></div>';
  }).join('') + '</div>';
  document.getElementById('tm-daily').innerHTML = dailyHTML;
}
`;
}

module.exports = { generateHTML, generateJS };
