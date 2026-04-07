'use strict';

/**
 * Dashboard CSS — dark theme, sidebar navigation, responsive layout.
 */

function generateCSS() {
  return `
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f0d1a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;overflow-x:hidden}
.layout{display:flex;min-height:100vh}

/* ── Sidebar ── */
.sidebar{width:220px;min-width:220px;background:#161326;padding:24px 0;display:flex;flex-direction:column;border-right:1px solid rgba(148,163,184,0.08);position:fixed;top:0;left:0;height:100vh;overflow-y:auto;z-index:10}
.sidebar .logo{display:flex;align-items:center;gap:10px;padding:0 20px;margin-bottom:32px}
.logo-mark{width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#5eead4,#818cf8);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;color:#0f0d1a}
.logo-text{font-size:18px;font-weight:700}
.nav-section{margin-bottom:20px}
.nav-label{font-size:9px;font-weight:700;letter-spacing:2px;color:#475569;text-transform:uppercase;padding:0 20px;margin-bottom:8px}
.nav-item{display:flex;align-items:center;gap:8px;padding:8px 20px;font-size:13px;color:#94a3b8;text-decoration:none;cursor:pointer;transition:all 0.15s;border-left:3px solid transparent}
.nav-item:hover{background:rgba(94,234,212,0.05);color:#e2e8f0}
.nav-item.active{color:#5eead4;border-left-color:#5eead4;background:rgba(94,234,212,0.08)}
.nav-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:0.5}
.nav-item.active .nav-dot{opacity:1}

/* ── Main content ── */
.main-content{flex:1;padding:28px 32px;margin-left:220px}
.top-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.top-bar h1{font-size:22px;font-weight:700}
.period-selector{display:flex;gap:4px;margin-right:12px}
.period-btn{background:rgba(148,163,184,0.08);border:1px solid rgba(148,163,184,0.12);color:#94a3b8;padding:5px 14px;border-radius:6px;font-size:12px;cursor:pointer;transition:all 0.15s}
.period-btn:hover{background:rgba(94,234,212,0.1);color:#e2e8f0}
.period-btn.active{background:rgba(94,234,212,0.15);border-color:rgba(94,234,212,0.4);color:#5eead4}
.live-dot{display:flex;align-items:center;gap:6px;font-size:11px;color:#5eead4;font-weight:600}
.live-dot::before{content:'';width:6px;height:6px;border-radius:50%;background:#5eead4;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}

/* ── View sections (hidden by default, shown when active) ── */
.view-section{display:none}
.view-section.active{display:block}

/* ── KPI Grid ── */
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}
.kpi{background:#1e1b2e;border-radius:12px;padding:18px 22px;border-top:3px solid #5eead4}
.kpi.accent-purple{border-top-color:#818cf8}.kpi.accent-pink{border-top-color:#f472b6}.kpi.accent-orange{border-top-color:#fb923c}.kpi.accent-magenta{border-top-color:#e879f9}
.kpi-label{font-size:10px;font-weight:600;letter-spacing:1.5px;color:#94a3b8;text-transform:uppercase;margin-bottom:6px}
.kpi-value{font-size:28px;font-weight:700;font-family:'SF Mono','Fira Code',monospace}
.kpi-sub{font-size:11px;color:#5eead4;margin-top:3px}
.kpi.accent-purple .kpi-sub{color:#818cf8}.kpi.accent-pink .kpi-sub{color:#f472b6}.kpi.accent-orange .kpi-sub{color:#fb923c}.kpi.accent-magenta .kpi-sub{color:#e879f9}

/* ── Panels ── */
.panels{display:grid;grid-template-columns:2fr 1fr;gap:14px;margin-bottom:20px}
.panel{background:#1e1b2e;border-radius:12px;padding:22px}
.panel-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.panel-title{font-size:15px;font-weight:600}
.panel-sub{font-size:11px;color:#64748b;margin-bottom:16px}

/* ── Chart ── */
.chart-container{display:flex;align-items:flex-end;gap:4px;height:220px;padding-top:20px}
.chart-col{display:flex;flex-direction:column;align-items:center;flex:1}
.chart-bar{background:linear-gradient(180deg,#5eead4,#818cf8);border-radius:4px 4px 0 0;width:100%;min-width:8px;transition:height 0.3s;cursor:pointer}
.chart-bar:hover{opacity:0.8}
.chart-bar.subscription-bar{background:linear-gradient(180deg,#f472b6,#a855f7);opacity:0.6}
.chart-label{font-size:9px;color:#64748b;margin-top:4px}
.chart-toggle{display:flex;gap:4px}
.toggle-btn{background:rgba(148,163,184,0.08);border:1px solid rgba(148,163,184,0.12);color:#94a3b8;padding:4px 10px;border-radius:4px;font-size:11px;cursor:pointer;transition:all 0.15s}
.toggle-btn:hover{color:#e2e8f0}
.toggle-btn.active{background:rgba(94,234,212,0.15);border-color:rgba(94,234,212,0.4);color:#5eead4}
.svg-container{display:none;width:100%;max-height:280px}
.svg-container.active{display:block}
.chart-empty{display:flex;align-items:center;justify-content:center;height:200px;color:#475569;font-size:13px}

/* ── Model Rows ── */
.model-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(148,163,184,0.08)}
.model-info{display:flex;align-items:center;gap:10px;flex:1}
.model-color{width:4px;height:32px;border-radius:2px}
.model-name{font-size:13px;font-weight:500}.model-meta{font-size:11px;color:#64748b}
.billing-tag{background:rgba(94,234,212,0.1);color:#5eead4;padding:1px 6px;border-radius:4px;font-size:10px}
.model-cost{text-align:right;min-width:90px}
.model-cost-value{font-size:16px;font-weight:700;font-family:'SF Mono',monospace}
.model-bar-track{height:3px;border-radius:2px;background:rgba(148,163,184,0.1);margin-top:3px}
.model-bar-fill{height:100%;border-radius:2px;transition:width 0.5s}

/* ── Bottom Row ── */
.bottom-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:20px}
.savings-card{background:linear-gradient(135deg,#1a2e2a,#162028);border-radius:12px;padding:24px;display:flex;flex-direction:column;justify-content:center}
.savings-label{font-size:11px;font-weight:700;letter-spacing:2px;color:#5eead4;text-transform:uppercase;margin-bottom:6px}
.savings-value{font-size:36px;font-weight:800;line-height:1.1;margin-bottom:10px;font-family:'SF Mono',monospace}
.savings-value span{font-size:18px;color:#94a3b8}
.savings-desc{font-size:12px;color:#94a3b8;line-height:1.4;margin-bottom:16px}
.savings-stats{display:flex;gap:16px}
.stat-value{font-size:18px;font-weight:700}.stat-label{font-size:8px;font-weight:600;letter-spacing:1.5px;color:#64748b;text-transform:uppercase;margin-top:2px}

/* ── Subscription Section ── */
.sub-section{background:#1e1b2e;border-radius:12px;padding:22px;margin-bottom:20px}
.sub-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(148,163,184,0.06)}
.sub-badge{background:rgba(244,114,182,0.15);color:#f472b6;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600}
.sub-provider{font-size:13px;font-weight:500}
.sub-account{font-size:11px;color:#64748b}
.sub-cost{font-size:16px;font-weight:700;font-family:'SF Mono',monospace}
.sub-plan{font-size:11px;color:#94a3b8}

/* ── Tables ── */
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:8px 10px;font-size:10px;font-weight:600;letter-spacing:1px;color:#64748b;text-transform:uppercase;border-bottom:1px solid rgba(148,163,184,0.1)}
td{padding:10px;font-size:12px;border-bottom:1px solid rgba(148,163,184,0.06)}
td.mono{font-family:'SF Mono','Fira Code',monospace}
tr:hover{background:rgba(94,234,212,0.03)}

/* ── Warning Banner ── */
.warning-banner{background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:12px;color:#fbbf24}
.warning-banner code{background:rgba(251,191,36,0.15);padding:2px 6px;border-radius:3px}

/* ── Budget Alert Bars ── */
.budget-bar-track{height:12px;background:rgba(148,163,184,0.1);border-radius:6px;overflow:hidden;margin:6px 0}
.budget-bar-fill{height:100%;border-radius:6px;transition:width 0.5s}
.budget-green{background:linear-gradient(90deg,#34d399,#5eead4)}
.budget-yellow{background:linear-gradient(90deg,#fbbf24,#fb923c)}
.budget-red{background:linear-gradient(90deg,#f87171,#ef4444)}

/* ── Optimization Cards ── */
.opt-card{background:rgba(94,234,212,0.05);border:1px solid rgba(94,234,212,0.1);border-radius:8px;padding:14px 18px;margin-bottom:10px}
.opt-card h4{font-size:13px;font-weight:600;color:#5eead4;margin-bottom:4px}
.opt-card p{font-size:12px;color:#94a3b8;line-height:1.4}
.opt-card .opt-amount{font-size:20px;font-weight:700;font-family:'SF Mono',monospace;color:#5eead4}

/* ── Footer ── */
.footer{margin-top:20px;padding:10px 14px;border-radius:8px;background:rgba(148,163,184,0.04);border:1px solid rgba(148,163,184,0.06);font-size:10px;color:#64748b}

/* ── Source Toggle Buttons ── */
.source-toggle{border-radius:20px;padding:5px 14px;font-size:11px;cursor:pointer;font-weight:500;transition:all 0.15s;border:1px solid}
.source-toggle.on{background:rgba(94,234,212,0.15);border-color:rgba(94,234,212,0.4);color:#5eead4}
.source-toggle.off{background:rgba(148,163,184,0.05);border-color:rgba(148,163,184,0.15);color:#64748b;text-decoration:line-through}
.source-toggle.sub-on{background:rgba(244,114,182,0.15);border-color:rgba(244,114,182,0.4);color:#f472b6}

/* ── Responsive ── */
@media(max-width:1100px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.bottom-row{grid-template-columns:1fr 1fr}}
@media(max-width:900px){.sidebar{display:none}.main-content{margin-left:0}.panels,.bottom-row{grid-template-columns:1fr}.savings-value{font-size:28px}}
`;
}

module.exports = { generateCSS };
