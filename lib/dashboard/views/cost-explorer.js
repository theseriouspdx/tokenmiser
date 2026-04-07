'use strict';

/**
 * Cost Explorer view — detailed drill-down with filtering and sorting.
 */

function generateHTML() {
  return `
  <div id="view-cost-explorer" class="view-section">
    <div class="top-bar">
      <h1>Cost Explorer</h1>
      <div style="display:flex;align-items:center;gap:8px">
        <div class="period-selector">
          <button class="period-btn" data-days="1" onclick="setPeriod(1)">24h</button>
          <button class="period-btn" data-days="7" onclick="setPeriod(7)">7d</button>
          <button class="period-btn active" data-days="30" onclick="setPeriod(30)">30d</button>
          <button class="period-btn" data-days="90" onclick="setPeriod(90)">90d</button>
        </div>
        <select id="ce-provider-filter" onchange="renderCostExplorer()" style="background:#1e1b2e;color:#e2e8f0;border:1px solid rgba(148,163,184,0.2);border-radius:6px;padding:5px 10px;font-size:12px">
          <option value="all">All Providers</option>
        </select>
        <select id="ce-source-filter" onchange="renderCostExplorer()" style="background:#1e1b2e;color:#e2e8f0;border:1px solid rgba(148,163,184,0.2);border-radius:6px;padding:5px 10px;font-size:12px">
          <option value="all">All Sources</option>
        </select>
        <button onclick="exportCostExplorerJSON()" style="background:rgba(94,234,212,0.15);border:1px solid rgba(94,234,212,0.4);color:#5eead4;padding:5px 12px;border-radius:6px;font-size:11px;cursor:pointer">Export JSON</button>
      </div>
    </div>
    <div id="ce-summary" class="kpi-grid" style="margin-bottom:16px"></div>
    <div class="panel">
      <div class="panel-title">Detailed Records</div>
      <div class="panel-sub">Click column headers to sort</div>
      <div id="ce-table" style="max-height:500px;overflow-y:auto"></div>
    </div>
    <div class="panels" style="margin-top:14px">
      <div class="panel">
        <div class="panel-title">Cost by Provider</div>
        <div id="ce-provider-breakdown"></div>
      </div>
      <div class="panel">
        <div class="panel-title">Cost by Billing Path</div>
        <div id="ce-billing-breakdown"></div>
      </div>
    </div>
  </div>`;
}

function generateJS() {
  return `
var ceSortCol = 'cost';
var ceSortAsc = false;

function renderCostExplorer() {
  var provFilter = document.getElementById('ce-provider-filter').value;
  var srcFilter = document.getElementById('ce-source-filter').value;
  var filtered = filterByPeriod(RAW_RECORDS, currentPeriod);

  if (provFilter !== 'all') {
    filtered = filtered.filter(function(r) { return r.m.split('/')[0] === provFilter; });
  }
  if (srcFilter !== 'all') {
    filtered = filtered.filter(function(r) { return r.s === srcFilter; });
  }

  var data = aggregateRecords(filtered);

  // Populate provider filter options
  var provs = {};
  RAW_RECORDS.forEach(function(r) { provs[r.m.split('/')[0]] = 1; });
  var provSelect = document.getElementById('ce-provider-filter');
  var currentProv = provSelect.value;
  provSelect.innerHTML = '<option value="all">All Providers</option>';
  Object.keys(provs).sort().forEach(function(p) {
    provSelect.innerHTML += '<option value="'+esc(p)+'"'+(p===currentProv?' selected':'')+'>'+esc(p)+'</option>';
  });

  var srcs = {};
  RAW_RECORDS.forEach(function(r) { srcs[r.s] = 1; });
  var srcSelect = document.getElementById('ce-source-filter');
  var currentSrc = srcSelect.value;
  srcSelect.innerHTML = '<option value="all">All Sources</option>';
  Object.keys(srcs).forEach(function(s) {
    var label = sourceNames[s] || s;
    srcSelect.innerHTML += '<option value="'+esc(s)+'"'+(s===currentSrc?' selected':'')+'>'+esc(label)+'</option>';
  });

  // Summary KPIs
  document.getElementById('ce-summary').innerHTML =
    '<div class="kpi"><div class="kpi-label">Filtered Total</div><div class="kpi-value">'+fmtMoney(data.totalCost)+'</div><div class="kpi-sub">'+data.totalRequests.toLocaleString()+' requests</div></div>'+
    '<div class="kpi accent-purple"><div class="kpi-label">Models</div><div class="kpi-value">'+data.activeModels+'</div><div class="kpi-sub">'+data.providers+' providers</div></div>'+
    '<div class="kpi accent-orange"><div class="kpi-label">Avg Cost/Req</div><div class="kpi-value">'+fmtMoney(data.avgCostPerRequest,4)+'</div><div class="kpi-sub">'+fmtTokens(data.totalPromptTokens+data.totalCompletionTokens)+' tokens</div></div>'+
    '<div class="kpi accent-pink"><div class="kpi-label">Records</div><div class="kpi-value">'+filtered.length+'</div><div class="kpi-sub">Matching filters</div></div>';

  // Sortable table
  var sorted = data.modelRanking.slice().sort(function(a,b) {
    var va = a[ceSortCol] || 0, vb = b[ceSortCol] || 0;
    if (typeof va === 'string') return ceSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    return ceSortAsc ? va - vb : vb - va;
  });

  var tableHTML = '<table><thead><tr>';
  var cols = [{k:'name',l:'Model'},{k:'rq',l:'Requests'},{k:'pt',l:'Input Tokens'},{k:'ct',l:'Output Tokens'},{k:'cost',l:'Cost'},{k:'sources',l:'Source'}];
  cols.forEach(function(c) {
    var arrow = ceSortCol === c.k ? (ceSortAsc ? ' \\u25B2' : ' \\u25BC') : '';
    tableHTML += '<th style="cursor:pointer" onclick="ceSortCol=\\''+c.k+'\\';ceSortAsc=!ceSortAsc;renderCostExplorer()">'+c.l+arrow+'</th>';
  });
  tableHTML += '</tr></thead><tbody>';
  sorted.forEach(function(m) {
    tableHTML += '<tr><td>'+esc(m.name)+'</td><td class="mono">'+fmtCompact(m.rq)+'</td><td class="mono">'+fmtTokens(m.pt)+'</td><td class="mono">'+fmtTokens(m.ct)+'</td><td class="mono">'+fmtMoney(m.cost)+'</td><td>'+esc(m.sources)+'</td></tr>';
  });
  tableHTML += '</tbody></table>';
  document.getElementById('ce-table').innerHTML = tableHTML;

  // Provider breakdown
  var provCosts = {};
  filtered.forEach(function(r) {
    var p = r.m.split('/')[0];
    provCosts[p] = (provCosts[p] || 0) + r.c;
  });
  var provHTML = '';
  var provMax = Math.max.apply(null, Object.values(provCosts).concat([0.01]));
  Object.keys(provCosts).sort(function(a,b) { return provCosts[b] - provCosts[a]; }).forEach(function(p) {
    var w = Math.max(4, (provCosts[p] / provMax) * 100);
    provHTML += '<div class="model-row"><div class="model-info"><div><div class="model-name">'+esc(p)+'</div></div></div><div class="model-cost"><div class="model-cost-value">'+fmtMoney(provCosts[p])+'</div><div class="model-bar-track"><div class="model-bar-fill" style="width:'+w+'%;background:#818cf8"></div></div></div></div>';
  });
  document.getElementById('ce-provider-breakdown').innerHTML = provHTML || '<p style="color:#475569;font-size:12px">No data</p>';

  // Billing path breakdown
  var bpHTML = '';
  var bpMax = Math.max.apply(null, Object.values(data.bySource).map(function(d){return d.cost}).concat([0.01]));
  Object.keys(data.bySource).sort(function(a,b){return data.bySource[b].cost-data.bySource[a].cost}).forEach(function(p) {
    var d = data.bySource[p];
    var w = Math.max(4, (d.cost / bpMax) * 100);
    bpHTML += '<div class="model-row"><div class="model-info"><div><div class="model-name">'+esc(p)+'</div><div class="model-meta">'+fmtCompact(d.rq)+' req &middot; '+fmtTokens(d.tokens)+' tok</div></div></div><div class="model-cost"><div class="model-cost-value">'+fmtMoney(d.cost)+'</div><div class="model-bar-track"><div class="model-bar-fill" style="width:'+w+'%;background:#5eead4"></div></div></div></div>';
  });
  document.getElementById('ce-billing-breakdown').innerHTML = bpHTML || '<p style="color:#475569;font-size:12px">No data</p>';
}

function exportCostExplorerJSON() {
  var filtered = filterByPeriod(RAW_RECORDS, currentPeriod);
  var json = JSON.stringify(filtered, null, 2);
  var blob = new Blob([json], {type:'application/json'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tokenmiser-export-'+new Date().toISOString().slice(0,10)+'.json';
  a.click();
}
`;
}

module.exports = { generateHTML, generateJS };
