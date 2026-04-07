'use strict';

/**
 * Dashboard Overview view — the main landing page.
 * KPIs, daily spend chart, model ranking, billing paths, savings card.
 */

function generateHTML() {
  return `
  <div id="view-dashboard" class="view-section active">
    <div class="top-bar">
      <h1>Cost Overview</h1>
      <div style="display:flex;align-items:center;gap:8px">
        <select id="project-filter" onchange="setProject(this.value)" style="background:#1e1b2e;color:#e2e8f0;border:1px solid rgba(148,163,184,0.2);border-radius:6px;padding:5px 10px;font-size:12px">
          <option value="all">All Projects</option>
        </select>
        <div class="period-selector">
          <button class="period-btn" data-days="1" onclick="setPeriod(1)">24h</button>
          <button class="period-btn" data-days="7" onclick="setPeriod(7)">7d</button>
          <button class="period-btn active" data-days="30" onclick="setPeriod(30)">30d</button>
          <button class="period-btn" data-days="90" onclick="setPeriod(90)">90d</button>
        </div>
        <div class="live-dot">Live</div>
      </div>
    </div>
    <div id="source-toggles" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px"></div>
    <div id="warning-banner"></div>
    <div id="kpi-grid" class="kpi-grid"></div>
    <div id="sub-section"></div>
    <div class="panels">
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">Daily Spend by Model</div>
          <div class="chart-toggle">
            <button class="toggle-btn active" id="bar-btn" onclick="setChartMode('bar')">&#9646; Bar</button>
            <button class="toggle-btn" id="line-btn" onclick="setChartMode('line')">&#9473; Line</button>
          </div>
        </div>
        <div id="chart-sub" class="panel-sub"></div>
        <div id="bar-chart" class="chart-container"></div>
        <div id="line-chart" class="svg-container"></div>
      </div>
      <div class="panel">
        <div class="panel-title">Spend by Model</div>
        <div class="panel-sub">Current billing period</div>
        <div id="model-ranking"></div>
      </div>
    </div>
    <div class="bottom-row">
      <div class="panel">
        <div class="panel-title">By Billing Path</div>
        <div class="panel-sub">Each path is a separate bill</div>
        <div id="billing-table"></div>
      </div>
      <div class="panel">
        <div class="panel-title">All Models</div>
        <div class="panel-sub">Ranked by spend</div>
        <div id="all-models-table"></div>
      </div>
      <div id="savings-card" class="savings-card"></div>
    </div>
    <div id="footer" class="footer"></div>
  </div>`;
}

module.exports = { generateHTML };
