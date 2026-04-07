'use strict';

/**
 * Budget Alerts view — config-driven budget tracking with projections.
 */

function generateHTML() {
  return `
  <div id="view-budget-alerts" class="view-section">
    <div class="top-bar">
      <h1>Budget Alerts</h1>
    </div>
    <div id="ba-summary" class="kpi-grid" style="margin-bottom:16px"></div>
    <div id="ba-alerts"></div>
    <div class="panel" style="margin-top:14px">
      <div class="panel-title">Spending Projection</div>
      <div class="panel-sub">Projected month-end spend based on current daily rate</div>
      <div id="ba-projection"></div>
    </div>
    <div class="panel" style="margin-top:14px">
      <div class="panel-title">Configure Budgets</div>
      <div class="panel-sub">Run <code style="background:rgba(94,234,212,0.1);color:#5eead4;padding:2px 6px;border-radius:3px">tokenmiser config --add-budget</code> to add budget alerts</div>
      <div id="ba-config-list"></div>
    </div>
  </div>`;
}

function generateJS() {
  return `
function renderBudgetAlerts() {
  var filtered = filterByPeriod(RAW_RECORDS, 30);
  var data = aggregateRecords(filtered);

  // Calculate daily rate and projection
  var uniqueDays = {};
  filtered.forEach(function(r) { if (r.d) uniqueDays[r.d] = 1; });
  var numDays = Math.max(Object.keys(uniqueDays).length, 1);
  var dailyRate = data.totalCost / numDays;
  var now = new Date();
  var daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  var dayOfMonth = now.getDate();
  var projectedMonthly = dailyRate * daysInMonth;
  var totalWithSubs = data.totalCost + totalSubCost;

  // Summary KPIs
  document.getElementById('ba-summary').innerHTML =
    '<div class="kpi"><div class="kpi-label">Current Month Spend</div><div class="kpi-value">'+fmtMoney(totalWithSubs)+'</div><div class="kpi-sub">Day '+dayOfMonth+' of '+daysInMonth+'</div></div>'+
    '<div class="kpi accent-purple"><div class="kpi-label">Daily Rate</div><div class="kpi-value">'+fmtMoney(dailyRate)+'</div><div class="kpi-sub">Per-token average</div></div>'+
    '<div class="kpi accent-orange"><div class="kpi-label">Projected Month-End</div><div class="kpi-value">'+fmtMoney(projectedMonthly + totalSubCost)+'</div><div class="kpi-sub">At current pace + subscriptions</div></div>'+
    '<div class="kpi accent-pink"><div class="kpi-label">Subscriptions</div><div class="kpi-value">'+fmtMoney(totalSubCost)+'</div><div class="kpi-sub">Fixed monthly costs</div></div>';

  // Budget alert bars
  var alertsHTML = '';
  if (BUDGETS.length === 0) {
    alertsHTML = '<div class="panel" style="text-align:center;padding:30px"><p style="color:#94a3b8;font-size:13px">No budget alerts configured.</p><p style="color:#64748b;font-size:12px;margin-top:6px">Run <code style="background:rgba(94,234,212,0.1);color:#5eead4;padding:2px 6px;border-radius:3px">tokenmiser config --add-budget</code> to set spending limits.</p></div>';
  } else {
    BUDGETS.forEach(function(b) {
      var spent = b.scope === 'total' ? totalWithSubs : 0;
      if (b.scope !== 'total') {
        // Match against source names
        filtered.forEach(function(r) {
          if (r.s === b.scope || r.bp === b.scope) spent += r.c;
        });
      }
      var pct = b.monthly > 0 ? (spent / b.monthly * 100) : 0;
      var projected = b.monthly > 0 ? ((dailyRate * daysInMonth + totalSubCost) / b.monthly * 100) : 0;
      var barClass = pct >= 100 ? 'budget-red' : pct >= (b.warnPct || 80) ? 'budget-yellow' : 'budget-green';
      var status = pct >= 100 ? '\\u26D4 Over budget' : pct >= (b.warnPct || 80) ? '\\u26A0 Warning' : '\\u2705 On track';

      alertsHTML += '<div class="panel" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><div><span style="font-weight:600;font-size:14px">'+esc(b.scope)+'</span><span style="color:#64748b;font-size:12px;margin-left:8px">'+status+'</span></div><div style="font-family:monospace;font-size:14px">'+fmtMoney(spent)+' / '+fmtMoney(b.monthly)+'</div></div><div class="budget-bar-track"><div class="budget-bar-fill '+barClass+'" style="width:'+Math.min(pct,100)+'%"></div></div><div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-top:4px"><span>'+Math.round(pct)+'% used</span><span>Projected: '+Math.round(projected)+'% by month end</span></div></div>';
    });
  }
  document.getElementById('ba-alerts').innerHTML = alertsHTML;

  // Projection chart (daily cumulative)
  var cumDays = Object.keys(uniqueDays).sort();
  var cumTotal = 0;
  var cumData = cumDays.map(function(d) {
    filtered.forEach(function(r) { if (r.d === d) cumTotal += r.c; });
    return { date: d, total: cumTotal };
  });

  if (cumData.length > 0) {
    var projMax = Math.max(projectedMonthly + totalSubCost, cumTotal, 1);
    var W=700,H=200,P=50,pW=W-2*P,pH=H-2*P;
    var pts = cumData.map(function(d,i) {
      return { x: P+(i/Math.max(cumData.length-1,1))*pW, y: P+pH-(d.total/projMax)*pH, d:d };
    });
    var linePath = pts.map(function(p,i){return (i===0?'M':'L')+' '+p.x.toFixed(1)+' '+p.y.toFixed(1)}).join(' ');

    // Budget line
    var budgetLineY = BUDGETS.length > 0 ? P+pH-(BUDGETS[0].monthly/projMax)*pH : -10;

    document.getElementById('ba-projection').innerHTML =
      '<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto;max-height:220px">'+
      '<line x1="'+P+'" y1="'+budgetLineY.toFixed(1)+'" x2="'+(W-P)+'" y2="'+budgetLineY.toFixed(1)+'" stroke="#f87171" stroke-width="1" stroke-dasharray="4,4"/>'+
      '<text x="'+(W-P+4)+'" y="'+(budgetLineY+4).toFixed(1)+'" font-size="10" fill="#f87171">Budget</text>'+
      '<path d="'+linePath+'" fill="none" stroke="#5eead4" stroke-width="2" stroke-linecap="round"/>'+
      pts.map(function(p){return '<circle cx="'+p.x.toFixed(1)+'" cy="'+p.y.toFixed(1)+'" r="2" fill="#5eead4"/>'}).join('')+
      '</svg>';
  } else {
    document.getElementById('ba-projection').innerHTML = '<p style="color:#475569;font-size:12px;padding:20px;text-align:center">No spending data yet this period</p>';
  }

  // Config list
  var configHTML = '<table><thead><tr><th>ID</th><th>Scope</th><th>Budget</th><th>Warn At</th></tr></thead><tbody>';
  BUDGETS.forEach(function(b) {
    configHTML += '<tr><td>'+esc(b.id || '—')+'</td><td>'+esc(b.scope)+'</td><td class="mono">'+fmtMoney(b.monthly)+'</td><td>'+b.warnPct+'%</td></tr>';
  });
  configHTML += '</tbody></table>';
  document.getElementById('ba-config-list').innerHTML = BUDGETS.length > 0 ? configHTML : '<p style="color:#475569;font-size:12px;padding:10px">No budgets configured</p>';
}
`;
}

module.exports = { generateHTML, generateJS };
