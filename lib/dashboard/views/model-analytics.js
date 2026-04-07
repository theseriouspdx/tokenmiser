'use strict';

/**
 * Model Analytics view — per-model deep dive with efficiency metrics and trends.
 */

function generateHTML() {
  return `
  <div id="view-model-analytics" class="view-section">
    <div class="top-bar">
      <h1>Model Analytics</h1>
      <div class="period-selector">
        <button class="period-btn" data-days="1" onclick="setPeriod(1)">24h</button>
        <button class="period-btn" data-days="7" onclick="setPeriod(7)">7d</button>
        <button class="period-btn active" data-days="30" onclick="setPeriod(30)">30d</button>
        <button class="period-btn" data-days="90" onclick="setPeriod(90)">90d</button>
      </div>
    </div>
    <div id="ma-efficiency" class="kpi-grid" style="margin-bottom:16px"></div>
    <div class="panels">
      <div class="panel">
        <div class="panel-title">Cost Efficiency by Model</div>
        <div class="panel-sub">Cost per 1K tokens (lower is better)</div>
        <div id="ma-efficiency-chart"></div>
      </div>
      <div class="panel">
        <div class="panel-title">Input / Output Ratio</div>
        <div class="panel-sub">Token balance by model</div>
        <div id="ma-io-ratio"></div>
      </div>
    </div>
    <div class="panels" style="margin-top:14px">
      <div class="panel">
        <div class="panel-title">Usage Frequency</div>
        <div class="panel-sub">Requests per model over time</div>
        <div id="ma-frequency" style="height:220px"></div>
      </div>
      <div class="panel">
        <div class="panel-title">Model × Billing Path Matrix</div>
        <div class="panel-sub">Which models are billed through which paths</div>
        <div id="ma-matrix"></div>
      </div>
    </div>
  </div>`;
}

function generateJS() {
  return `
function renderModelAnalytics() {
  var filtered = filterByPeriod(RAW_RECORDS, currentPeriod);
  var data = aggregateRecords(filtered);

  // Efficiency KPIs
  var totalTokens = data.totalPromptTokens + data.totalCompletionTokens;
  var costPer1K = totalTokens > 0 ? (data.totalCost / (totalTokens / 1000)) : 0;
  var mostEfficient = data.modelRanking.filter(function(m){return m.cost > 0}).sort(function(a,b) {
    var aE = a.totalTokens > 0 ? a.cost / (a.totalTokens/1000) : 999;
    var bE = b.totalTokens > 0 ? b.cost / (b.totalTokens/1000) : 999;
    return aE - bE;
  })[0];
  var leastEfficient = data.modelRanking.filter(function(m){return m.cost > 0}).sort(function(a,b) {
    var aE = a.totalTokens > 0 ? a.cost / (a.totalTokens/1000) : 0;
    var bE = b.totalTokens > 0 ? b.cost / (b.totalTokens/1000) : 0;
    return bE - aE;
  })[0];

  document.getElementById('ma-efficiency').innerHTML =
    '<div class="kpi"><div class="kpi-label">Avg Cost / 1K Tokens</div><div class="kpi-value">'+fmtMoney(costPer1K,4)+'</div><div class="kpi-sub">Across all models</div></div>'+
    '<div class="kpi accent-purple"><div class="kpi-label">Most Efficient</div><div class="kpi-value" style="font-size:18px">'+esc(mostEfficient ? mostEfficient.name : '—')+'</div><div class="kpi-sub">'+(mostEfficient ? fmtMoney(mostEfficient.totalTokens > 0 ? mostEfficient.cost/(mostEfficient.totalTokens/1000) : 0,4)+'/1K tok' : '')+'</div></div>'+
    '<div class="kpi accent-orange"><div class="kpi-label">Least Efficient</div><div class="kpi-value" style="font-size:18px">'+esc(leastEfficient ? leastEfficient.name : '—')+'</div><div class="kpi-sub">'+(leastEfficient ? fmtMoney(leastEfficient.totalTokens > 0 ? leastEfficient.cost/(leastEfficient.totalTokens/1000) : 0,4)+'/1K tok' : '')+'</div></div>'+
    '<div class="kpi accent-pink"><div class="kpi-label">Total Tokens</div><div class="kpi-value">'+fmtTokens(totalTokens)+'</div><div class="kpi-sub">'+fmtTokens(data.totalPromptTokens)+' in / '+fmtTokens(data.totalCompletionTokens)+' out</div></div>';

  // Efficiency chart (cost per 1K tokens by model)
  var models = data.modelRanking.filter(function(m){return m.totalTokens > 0 && m.cost > 0}).slice(0,10);
  var maxEff = 0;
  models.forEach(function(m) { var e = m.cost/(m.totalTokens/1000); if (e > maxEff) maxEff = e; });
  var effHTML = models.map(function(m, i) {
    var eff = m.cost / (m.totalTokens / 1000);
    var w = Math.max(4, (eff / Math.max(maxEff, 0.001)) * 100);
    var c = COLORS[i % COLORS.length];
    return '<div class="model-row"><div class="model-info"><div class="model-color" style="background:'+c+'"></div><div><div class="model-name">'+esc(m.name)+'</div><div class="model-meta">'+fmtTokens(m.totalTokens)+' total tokens</div></div></div><div class="model-cost"><div class="model-cost-value">'+fmtMoney(eff,4)+'</div><div class="model-bar-track"><div class="model-bar-fill" style="width:'+w+'%;background:'+c+'"></div></div></div></div>';
  }).join('');
  document.getElementById('ma-efficiency-chart').innerHTML = effHTML || '<p style="color:#475569;font-size:12px;padding:20px">No cost data available</p>';

  // I/O ratio
  var ioHTML = models.map(function(m, i) {
    var total = m.pt + m.ct;
    var inPct = total > 0 ? (m.pt / total * 100) : 50;
    var c = COLORS[i % COLORS.length];
    return '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span>'+esc(m.name)+'</span><span style="color:#64748b">'+Math.round(inPct)+'% in / '+Math.round(100-inPct)+'% out</span></div><div style="display:flex;height:8px;border-radius:4px;overflow:hidden"><div style="width:'+inPct+'%;background:'+c+';opacity:0.8"></div><div style="width:'+(100-inPct)+'%;background:'+c+';opacity:0.3"></div></div></div>';
  }).join('');
  document.getElementById('ma-io-ratio').innerHTML = ioHTML || '<p style="color:#475569;font-size:12px;padding:20px">No data</p>';

  // Usage frequency by date
  var byDateModel = {};
  filtered.forEach(function(r) {
    if (!byDateModel[r.d]) byDateModel[r.d] = {};
    byDateModel[r.d][r.mn] = (byDateModel[r.d][r.mn] || 0) + r.rq;
  });
  var dates = Object.keys(byDateModel).sort().slice(-14);
  var maxReq = 1;
  dates.forEach(function(d) {
    var total = 0;
    for (var k in byDateModel[d]) total += byDateModel[d][k];
    if (total > maxReq) maxReq = total;
  });
  var freqHTML = '<div class="chart-container" style="height:200px">' + dates.map(function(d) {
    var total = 0;
    for (var k in byDateModel[d]) total += byDateModel[d][k];
    var h = Math.max(2, (total / maxReq) * 180);
    return '<div class="chart-col"><div class="chart-bar" style="height:'+h+'px" title="'+d+': '+total+' requests"></div><div class="chart-label">'+d.slice(5)+'</div></div>';
  }).join('') + '</div>';
  document.getElementById('ma-frequency').innerHTML = freqHTML;

  // Model × Billing Path matrix
  var matrixModels = data.modelRanking.slice(0, 8);
  var allPaths = {};
  filtered.forEach(function(r) { allPaths[r.bp] = 1; });
  var paths = Object.keys(allPaths);

  var matHTML = '<table><thead><tr><th>Model</th>';
  paths.forEach(function(p) { matHTML += '<th>'+esc(p)+'</th>'; });
  matHTML += '</tr></thead><tbody>';
  matrixModels.forEach(function(m) {
    matHTML += '<tr><td>'+esc(m.name)+'</td>';
    paths.forEach(function(p) {
      var has = m.rawSources && m.rawSources.indexOf(p) !== -1;
      matHTML += '<td style="text-align:center">'+(has ? '<span style="color:#5eead4">\\u25CF</span>' : '<span style="color:#334155">\\u25CB</span>')+'</td>';
    });
    matHTML += '</tr>';
  });
  matHTML += '</tbody></table>';
  document.getElementById('ma-matrix').innerHTML = matHTML;
}
`;
}

module.exports = { generateHTML, generateJS };
