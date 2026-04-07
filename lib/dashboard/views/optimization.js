'use strict';

/**
 * Optimization view — data-driven recommendations for cost savings.
 */

function generateHTML() {
  return `
  <div id="view-optimization" class="view-section">
    <div class="top-bar">
      <h1>Optimization</h1>
    </div>
    <div id="opt-summary" class="kpi-grid" style="margin-bottom:16px"></div>
    <div id="opt-recommendations"></div>
    <div class="panels" style="margin-top:14px">
      <div class="panel">
        <div class="panel-title">Model Cost Comparison</div>
        <div class="panel-sub">What if you used a different model?</div>
        <div id="opt-comparison"></div>
      </div>
      <div class="panel">
        <div class="panel-title">Subscription Value Analysis</div>
        <div class="panel-sub">Are your subscriptions worth it?</div>
        <div id="opt-sub-value"></div>
      </div>
    </div>
  </div>`;
}

function generateJS() {
  return `
function renderOptimization() {
  var filtered = filterByPeriod(RAW_RECORDS, 30);
  var data = aggregateRecords(filtered);

  // Summary
  document.getElementById('opt-summary').innerHTML =
    '<div class="kpi"><div class="kpi-label">Current Spend</div><div class="kpi-value">'+fmtMoney(data.totalCost)+'</div><div class="kpi-sub">Per-token costs (30d)</div></div>'+
    '<div class="kpi accent-purple"><div class="kpi-label">Potential Savings</div><div class="kpi-value">'+fmtMoney(data.routingSavings, 0)+'</div><div class="kpi-sub">vs single-model baseline</div></div>'+
    '<div class="kpi accent-orange"><div class="kpi-label">Cost Efficiency</div><div class="kpi-value">'+fmtPct(data.costReduction)+'</div><div class="kpi-sub">Reduction from model routing</div></div>'+
    '<div class="kpi accent-pink"><div class="kpi-label">Models Used</div><div class="kpi-value">'+data.activeModels+'</div><div class="kpi-sub">Across '+data.providers+' providers</div></div>';

  // Generate recommendations
  var recs = [];

  // Rec 1: Expensive model usage
  var expensiveModels = data.modelRanking.filter(function(m) {
    return m.totalTokens > 0 && m.cost > 0 && (m.cost / (m.totalTokens/1000)) > 0.01;
  });
  if (expensiveModels.length > 0) {
    var cheapest = data.modelRanking.filter(function(m){return m.cost > 0 && m.totalTokens > 0}).sort(function(a,b) {
      return (a.cost/(a.totalTokens/1000)) - (b.cost/(b.totalTokens/1000));
    })[0];
    if (cheapest && expensiveModels[0].name !== cheapest.name) {
      var expRate = expensiveModels[0].cost / (expensiveModels[0].totalTokens / 1000);
      var cheapRate = cheapest.cost / (cheapest.totalTokens / 1000);
      var potentialSave = (expRate - cheapRate) * (expensiveModels[0].totalTokens / 1000);
      recs.push({
        title: 'Consider cheaper model for simple tasks',
        desc: esc(expensiveModels[0].name) + ' costs ' + fmtMoney(expRate, 4) + '/1K tokens. ' + esc(cheapest.name) + ' costs ' + fmtMoney(cheapRate, 4) + '/1K tokens. If some of those requests could use the cheaper model, you could save up to ' + fmtMoney(potentialSave) + '/mo.',
        amount: potentialSave,
      });
    }
  }

  // Rec 2: High output ratio
  data.modelRanking.forEach(function(m) {
    if (m.ct > 0 && m.pt > 0) {
      var outRatio = m.ct / (m.pt + m.ct);
      if (outRatio > 0.6 && m.cost > 5) {
        recs.push({
          title: 'High output ratio on ' + m.name,
          desc: Math.round(outRatio * 100) + '% of tokens are output (which costs more per token). Consider using prompts that request more concise responses, or use streaming with early termination.',
          amount: m.cost * 0.15,
        });
      }
    }
  });

  // Rec 3: Routing savings
  if (data.routingSavings > 10) {
    recs.push({
      title: 'Smart model routing is saving you money',
      desc: 'By using ' + data.activeModels + ' different models instead of routing everything through ' + esc(data.maxRateModelName) + ', you\\'re already saving ' + fmtMoney(data.routingSavings) + '/mo (' + fmtPct(data.costReduction) + ' reduction). Keep it up!',
      amount: data.routingSavings,
    });
  }

  // Rec 4: Subscription value
  if (RAW_SUBSCRIPTIONS.length > 0 && data.totalCost > 0) {
    recs.push({
      title: 'Review subscription vs. per-token balance',
      desc: 'You\\'re spending ' + fmtMoney(totalSubCost) + '/mo on subscriptions and ' + fmtMoney(data.totalCost) + '/mo on per-token API usage. See the Subscription Value Analysis below for detailed breakdowns.',
      amount: 0,
    });
  }

  var recsHTML = recs.length > 0 ? recs.map(function(r) {
    return '<div class="opt-card"><h4>'+r.title+'</h4><p>'+r.desc+'</p>'+(r.amount > 0 ? '<div class="opt-amount" style="margin-top:6px">'+fmtMoney(r.amount, 0)+' potential savings</div>' : '')+'</div>';
  }).join('') : '<div class="panel" style="text-align:center;padding:30px"><p style="color:#94a3b8">Not enough data to generate recommendations. Use more sources or wait for more usage data.</p></div>';
  document.getElementById('opt-recommendations').innerHTML = recsHTML;

  // Model cost comparison
  var compModels = data.modelRanking.filter(function(m){return m.cost > 0}).slice(0, 8);
  var compHTML = '<table><thead><tr><th>Model</th><th>$/1K Tok</th><th>Total Cost</th><th>Tokens</th><th>If All Used This</th></tr></thead><tbody>';
  var totalTok = data.totalPromptTokens + data.totalCompletionTokens;
  compModels.forEach(function(m) {
    var rate = m.totalTokens > 0 ? m.cost / (m.totalTokens/1000) : 0;
    var ifAll = rate * (totalTok / 1000);
    compHTML += '<tr><td>'+esc(m.name)+'</td><td class="mono">'+fmtMoney(rate,4)+'</td><td class="mono">'+fmtMoney(m.cost)+'</td><td class="mono">'+fmtTokens(m.totalTokens)+'</td><td class="mono">'+fmtMoney(ifAll)+'</td></tr>';
  });
  compHTML += '</tbody></table>';
  document.getElementById('opt-comparison').innerHTML = compHTML;

  // Subscription value analysis
  var subValHTML = '';
  if (RAW_SUBSCRIPTIONS.length > 0) {
    subValHTML = '<table><thead><tr><th>Subscription</th><th>Monthly Cost</th><th>Status</th></tr></thead><tbody>';
    RAW_SUBSCRIPTIONS.forEach(function(s) {
      subValHTML += '<tr><td>'+esc(s.pn)+' — '+esc(s.prov)+'</td><td class="mono">'+fmtMoney(s.mc)+'/mo</td><td><span class="sub-badge">'+esc(s.plan)+'</span></td></tr>';
    });
    subValHTML += '</tbody></table>';
    subValHTML += '<p style="color:#94a3b8;font-size:11px;margin-top:10px">Compare subscription costs against what per-token pricing would be for equivalent usage to determine if subscriptions are cost-effective.</p>';
  } else {
    subValHTML = '<p style="color:#475569;font-size:12px;padding:10px">No subscriptions configured. Run <code style="background:rgba(94,234,212,0.1);color:#5eead4;padding:2px 6px;border-radius:3px">tokenmiser config --add-sub</code> to add.</p>';
  }
  document.getElementById('opt-sub-value').innerHTML = subValHTML;
}
`;
}

module.exports = { generateHTML, generateJS };
