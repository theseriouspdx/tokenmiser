'use strict';

/**
 * Help / About view — quick reference for commands, supported sources, and version info.
 */

function generateHTML() {
  return `
  <div id="view-help" class="view-section">
    <div class="top-bar">
      <h1>Help &amp; About</h1>
    </div>

    <div class="panel" style="margin-bottom:14px">
      <div class="panel-title">Quick Start</div>
      <div class="panel-sub">Common commands</div>
      <div id="help-commands"></div>
    </div>

    <div class="panels">
      <div class="panel">
        <div class="panel-title">Supported Data Sources</div>
        <div class="panel-sub">All sources are auto-detected from your local machine</div>
        <div id="help-sources"></div>
      </div>
      <div class="panel">
        <div class="panel-title">About Tokenmiser</div>
        <div id="help-about"></div>
      </div>
    </div>
  </div>`;
}

function generateJS() {
  return `
function renderHelp() {
  // Commands
  var cmds = [
    { cmd: 'tokenmiser', desc: 'Generate HTML dashboard and open in browser' },
    { cmd: 'tokenmiser --json', desc: 'Output JSON data to stdout' },
    { cmd: 'tokenmiser --csv FILE', desc: 'Import OpenRouter CSV export' },
    { cmd: 'tokenmiser --verbose', desc: 'Show detailed detection info' },
    { cmd: 'tokenmiser config --add-sub', desc: 'Add a subscription plan' },
    { cmd: 'tokenmiser config --add-budget', desc: 'Add a budget alert' },
    { cmd: 'tokenmiser config --list', desc: 'List all subscriptions and budgets' },
    { cmd: 'tokenmiser config --remove ID', desc: 'Remove a subscription or budget' },
    { cmd: 'tokenmiser --quick-sub claude-pro', desc: 'Quick-add Claude Pro subscription' },
  ];
  var cmdHTML = '<table><thead><tr><th>Command</th><th>Description</th></tr></thead><tbody>';
  cmds.forEach(function(c) {
    cmdHTML += '<tr><td><code style="background:rgba(94,234,212,0.1);color:#5eead4;padding:2px 6px;border-radius:3px;font-size:11px">'+esc(c.cmd)+'</code></td><td style="color:#94a3b8;font-size:12px">'+esc(c.desc)+'</td></tr>';
  });
  cmdHTML += '</tbody></table>';
  document.getElementById('help-commands').innerHTML = cmdHTML;

  // Sources
  var sources = [
    { name: 'Claude Code', type: 'Local logs', path: '~/.claude/projects/' },
    { name: 'Codex CLI', type: 'Local logs', path: '~/.codex/sessions/' },
    { name: 'Gemini CLI', type: 'Local logs', path: '~/.gemini/tmp/' },
    { name: 'Cline', type: 'Local logs', path: 'VS Code globalStorage' },
    { name: 'Aider', type: 'Local logs', path: '.aider.chat.history.md' },
    { name: 'Cursor', type: 'Local logs', path: 'Cursor state.vscdb' },
    { name: 'OpenRouter', type: 'API / CSV', path: 'OPENROUTER_API_KEY' },
    { name: 'Anthropic', type: 'API', path: 'ANTHROPIC_ADMIN_KEY' },
    { name: 'OpenAI', type: 'API', path: 'OPENAI_ADMIN_KEY' },
  ];
  var srcHTML = '<table><thead><tr><th>Source</th><th>Type</th><th>Path / Key</th></tr></thead><tbody>';
  sources.forEach(function(s) {
    srcHTML += '<tr><td>'+esc(s.name)+'</td><td><span class="billing-tag">'+esc(s.type)+'</span></td><td><code style="font-size:11px">'+esc(s.path)+'</code></td></tr>';
  });
  srcHTML += '</tbody></table>';
  document.getElementById('help-sources').innerHTML = srcHTML;

  // About
  document.getElementById('help-about').innerHTML =
    '<div style="padding:12px 0;font-size:12px;color:#94a3b8;line-height:1.6">'+
    '<p><strong style="color:#e2e8f0">Tokenmiser v'+VERSION+'</strong></p>'+
    '<p style="margin-top:8px">Zero-dependency Node.js CLI that shows where your AI API money goes. '+
    'Auto-detects every data source on your machine and generates a self-contained HTML dashboard.</p>'+
    '<p style="margin-top:8px"><strong style="color:#e2e8f0">How it works:</strong> Tokenmiser scans local log files from your AI coding tools, '+
    'checks for API keys to pull actual billing data, and imports CSV exports. All data stays local.</p>'+
    '<p style="margin-top:8px"><strong style="color:#e2e8f0">Billing paths:</strong> Each record is tagged with its billing path (e.g. OpenRouter, OAuth subscription, Google API). '+
    'When API data exists for a billing path, local log cost estimates are suppressed but token counts are retained.</p>'+
    '</div>';
}
`;
}

module.exports = { generateHTML, generateJS };
