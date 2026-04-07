'use strict';

/**
 * Settings view — API Keys status, Subscriptions overview, Billing Rules.
 */

function generateHTML() {
  return `
  <div id="view-settings" class="view-section">
    <div class="top-bar">
      <h1>Settings</h1>
    </div>

    <div class="panel" style="margin-bottom:14px">
      <div class="panel-title">API Keys</div>
      <div class="panel-sub">Status of configured API keys for per-token billing sources</div>
      <div id="settings-api-keys"></div>
    </div>

    <div class="panel" style="margin-bottom:14px">
      <div class="panel-title">Subscriptions</div>
      <div class="panel-sub">Fixed-cost subscription plans</div>
      <div id="settings-subscriptions"></div>
      <div style="margin-top:10px;font-size:11px;color:#64748b">
        Manage subscriptions: <code style="background:rgba(94,234,212,0.1);color:#5eead4;padding:2px 6px;border-radius:3px">tokenmiser config --add-sub</code> &nbsp;
        <code style="background:rgba(94,234,212,0.1);color:#5eead4;padding:2px 6px;border-radius:3px">tokenmiser config --list</code> &nbsp;
        <code style="background:rgba(94,234,212,0.1);color:#5eead4;padding:2px 6px;border-radius:3px">tokenmiser config --remove ID</code>
      </div>
    </div>

    <div class="panel" style="margin-bottom:14px">
      <div class="panel-title">Detected Local Sources</div>
      <div class="panel-sub">CLI tools and local log files found on this machine</div>
      <div id="settings-local-sources"></div>
    </div>

    <div class="panel" style="margin-bottom:14px">
      <div class="panel-title">Billing Rules</div>
      <div class="panel-sub">How sources are prioritized and deduplicated</div>
      <div id="settings-billing-rules"></div>
    </div>

    <div class="panel">
      <div class="panel-title">Config File</div>
      <div class="panel-sub">Persistent settings stored at <code style="background:rgba(94,234,212,0.1);color:#5eead4;padding:2px 6px;border-radius:3px">~/.tokenmiser/config.json</code></div>
      <div id="settings-config-path"></div>
    </div>
  </div>`;
}

function generateJS() {
  return `
function renderSettings() {
  // API Keys
  var apiHTML = '<table><thead><tr><th>Source</th><th>Env Variable</th><th>Status</th></tr></thead><tbody>';
  var apiSources = [
    {name:'OpenRouter', env:'OPENROUTER_API_KEY (or OPENROUTER_MANAGEMENT_KEY for full activity)'},
    {name:'Anthropic Admin', env:'ANTHROPIC_ADMIN_KEY'},
    {name:'OpenAI', env:'OPENAI_ADMIN_KEY / OPENAI_API_KEY'},
    {name:'Gemini / Google', env:'(auto-detected from ~/.gemini/oauth_creds.json)'},
    {name:'GitHub Copilot', env:'(auto-detected from local usage)'},
    {name:'Windsurf', env:'(auto-detected from local usage)'},
  ];
  apiSources.forEach(function(s) {
    // Check if this source has data
    var hasData = SOURCES.some(function(src) { return src.name.toLowerCase().includes(s.name.toLowerCase().split(' ')[0]); });
    var status = hasData
      ? '<span style="color:#5eead4">\\u2713 Connected</span>'
      : '<span style="color:#64748b">\\u2014 Not configured</span>';
    apiHTML += '<tr><td>'+esc(s.name)+'</td><td><code style="font-size:11px">'+esc(s.env)+'</code></td><td>'+status+'</td></tr>';
  });
  apiHTML += '</tbody></table>';
  document.getElementById('settings-api-keys').innerHTML = apiHTML;

  // Subscriptions
  var subHTML = '';
  if (RAW_SUBSCRIPTIONS.length > 0) {
    subHTML = '<table><thead><tr><th>Provider</th><th>Account</th><th>Plan</th><th>Monthly Cost</th><th>Status</th></tr></thead><tbody>';
    RAW_SUBSCRIPTIONS.forEach(function(s) {
      subHTML += '<tr><td>'+esc(s.prov)+'</td><td>'+esc(s.pn)+'</td><td><span class="sub-badge">'+esc(s.plan)+'</span></td><td class="mono">'+fmtMoney(s.mc)+'/mo</td><td>'+(s.partial ? 'Partial month' : 'Active')+'</td></tr>';
    });
    subHTML += '</tbody></table>';
  } else {
    subHTML = '<p style="color:#475569;font-size:12px;padding:10px">No subscriptions configured.</p>';
  }
  document.getElementById('settings-subscriptions').innerHTML = subHTML;

  // Local sources
  var localSources = [
    {name:'Claude Code', path:'~/.claude/projects/', slug:'claude-code'},
    {name:'Codex CLI', path:'~/.codex/sessions/', slug:'codex-cli'},
    {name:'Cline', path:'VS Code globalStorage', slug:'cline'},
    {name:'Aider', path:'~/.aider.chat.history.md', slug:'aider'},
    {name:'Gemini CLI', path:'~/.gemini/', slug:'gemini-cli'},
    {name:'Cursor', path:'Cursor state.vscdb', slug:'cursor'},
  ];
  var localHTML = '<table><thead><tr><th>Tool</th><th>Log Path</th><th>Status</th></tr></thead><tbody>';
  localSources.forEach(function(s) {
    var hasData = SOURCES.some(function(src) { return src.name.toLowerCase().includes(s.name.toLowerCase()); });
    var detected = RAW_RECORDS.some(function(r) { return r.s === s.slug; });
    var status = detected
      ? '<span style="color:#5eead4">\\u2713 Data found</span>'
      : hasData
        ? '<span style="color:#fbbf24">\\u25CB Detected, no recent data</span>'
        : '<span style="color:#64748b">\\u2014 Not found</span>';
    localHTML += '<tr><td>'+esc(s.name)+'</td><td><code style="font-size:11px">'+esc(s.path)+'</code></td><td>'+status+'</td></tr>';
  });
  localHTML += '</tbody></table>';
  document.getElementById('settings-local-sources').innerHTML = localHTML;

  // Billing rules
  document.getElementById('settings-billing-rules').innerHTML =
    '<div style="padding:8px 0"><p style="font-size:12px;color:#94a3b8;line-height:1.6">'+
    '<strong style="color:#e2e8f0">Source Priority:</strong> API sources (actual billing) > CSV imports > Local log estimates<br>'+
    '<strong style="color:#e2e8f0">Deduplication:</strong> When API data exists for a model+date, local log cost estimates are suppressed. Token counts are retained.<br>'+
    '<strong style="color:#e2e8f0">Subscriptions:</strong> Fixed monthly costs are tracked separately and not deduplicated against per-token usage.'+
    '</p></div>';

  // Config path
  document.getElementById('settings-config-path').innerHTML =
    '<p style="font-size:12px;color:#94a3b8;padding:8px 0">Edit directly: <code style="background:rgba(94,234,212,0.1);color:#5eead4;padding:2px 6px;border-radius:3px">~/.tokenmiser/config.json</code></p>';
}
`;
}

module.exports = { generateHTML, generateJS };
