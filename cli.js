#!/usr/bin/env node
/**
 * tokenmiser CLI v4.1.0 — see where your AI API money goes.
 *
 * Auto-detects every data source on your machine:
 *   - OpenRouter API (via OPENROUTER_API_KEY)
 *   - Anthropic Admin API with Cost API (via ANTHROPIC_ADMIN_KEY)
 *   - OpenAI Usage + Cost API (via OPENAI_ADMIN_KEY or OPENAI_API_KEY)
 *   - Claude Code local logs (~/.claude/)
 *   - Codex CLI local logs (~/.codex/)
 *   - Cline local logs (VS Code extension)
 *   - Aider chat history logs
 *   - OpenRouter CSV import (--csv FILE)
 *   - Subscription tracking (~/.tokenmiser/config.json)
 *
 * Each source is a separate billing path — tagged on every record, never merged.
 * Subscriptions are fixed monthly costs, tracked separately from per-token billing.
 *
 * Zero dependencies. Node.js 18+.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { fmtMoney, fmtTokens, fmtPct, fmtCompact } = require('./lib/format');
const { detectAndCollect } = require('./lib/collectors');
const { deduplicateRecords } = require('./lib/dedup');
const { aggregate } = require('./lib/aggregate');
const { getSubscriptionRecords, getTotalSubscriptionCost } = require('./lib/subscriptions');
const { generateDashboard } = require('./lib/dashboard');
const config = require('./lib/config');
const { detectSubscriptions } = require('./lib/auto-subscriptions');
const { startServer } = require('./lib/server');

const VERSION = '4.1.0';
const OUTPUT_FILE = path.join(process.cwd(), 'tokenmiser-report.html');

// ═══════════════════════════════════════════════════════════════════
// CLI ARGS
// ═══════════════════════════════════════════════════════════════════
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    json: false,
    help: false,
    version: false,
    verbose: false,
    csv: null,
    // Config subcommands
    config: false,
    addSub: false,
    addBudget: false,
    list: false,
    remove: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') opts.json = true;
    else if (args[i] === '--help' || args[i] === '-h') opts.help = true;
    else if (args[i] === '--version' || args[i] === '-v') opts.version = true;
    else if (args[i] === '--verbose') opts.verbose = true;
    else if (args[i] === '--csv' && args[i + 1]) opts.csv = args[++i];
    else if (args[i] === 'config') opts.config = true;
    else if (args[i] === '--add-sub') opts.addSub = true;
    else if (args[i] === '--add-budget') opts.addBudget = true;
    else if (args[i] === '--list') opts.list = true;
    else if (args[i] === '--remove' && args[i + 1]) opts.remove = args[++i];
    else if (args[i] === '--quick-sub' && args[i + 1]) { opts.quickSub = args[++i]; opts.config = true; }
    else if (args[i] === '--account' && args[i + 1]) opts.account = args[++i];
    else if (args[i] === '--no-server') opts.noServer = true;
  }
  return opts;
}

function printHelp() {
  console.log(`
  tokenmiser v${VERSION}
  See where your AI API money goes.

  Usage:
    tokenmiser                        Auto-detect all sources, generate dashboard
    tokenmiser --json                 Output raw JSON instead of dashboard
    tokenmiser --verbose              Show detailed source detection info
    tokenmiser --csv FILE             Import OpenRouter activity CSV export

  Config (persistent settings):
    tokenmiser config --add-sub       Add a subscription (interactive, with templates)
    tokenmiser config --add-budget    Add a budget alert (interactive)
    tokenmiser config --list          List subscriptions and budgets
    tokenmiser config --remove ID     Remove a subscription or budget by ID
    tokenmiser --quick-sub TEMPLATE   Quick-add subscription (e.g. claude-pro, copilot-individual)
    tokenmiser --quick-sub TEMPLATE --account "Work"  Quick-add with account label

  Quick-add templates:
    claude-pro, claude-max, claude-max-20x, chatgpt-plus, chatgpt-pro,
    gemini-advanced, copilot-individual, copilot-business, copilot-enterprise,
    cursor-pro, cursor-business

  Auto-detected sources (via environment variables):
    OPENROUTER_API_KEY                OpenRouter key usage summary
    OPENROUTER_MANAGEMENT_KEY         OpenRouter full activity (optional upgrade)
    ANTHROPIC_ADMIN_KEY               Anthropic Usage + Cost API (org admin key)
    OPENAI_ADMIN_KEY / OPENAI_API_KEY OpenAI Usage + Cost API (admin key)

  Auto-detected sources (local files):
    ~/.claude/projects/               Claude Code session logs
    ~/.codex/sessions/                Codex CLI session transcripts
    VS Code globalStorage             Cline extension task history
    ~/.aider.chat.history.md          Aider chat logs (per-project)
    ~/.gemini/                        Gemini CLI session logs (experimental)
    Cursor state.vscdb                Cursor IDE usage (experimental, needs sqlite3)

  Subscription tracking (~/.tokenmiser/config.json):
    Claude Pro, Max 5x, Max 20x      Fixed monthly cost
    ChatGPT Plus, Pro, Team           Fixed monthly cost
    Gemini Advanced                   Fixed monthly cost
    GitHub Copilot Individual/Biz/Ent Fixed monthly cost
    Cursor Pro, Business              Fixed monthly cost
    Any custom plan                   Manual entry

  Unsupported sources (documented limitations):
    GitHub Copilot usage API          Requires org admin token (most users don't have)
    Google Vertex AI                  Requires GCP service account + Cloud Monitoring
    Google AI Studio                  No programmatic usage API exists

  Each source is a separate billing path. Using Claude Desktop
  (OAuth) and Claude via OpenRouter are two different bills —
  both get tracked, nothing is double-counted.

  Config: ~/.tokenmiser/config.json
  Docs:   https://github.com/tokenmiser/tokenmiser
`);
}

// ═══════════════════════════════════════════════════════════════════
// OPEN BROWSER
// ═══════════════════════════════════════════════════════════════════
function openInBrowser(filepath) {
  try {
    if (process.platform === 'darwin') execSync(`open "${filepath}"`);
    else if (process.platform === 'win32') execSync(`start "" "${filepath}"`);
    else execSync(`xdg-open "${filepath}"`);
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  const opts = parseArgs();

  if (opts.version) {
    console.log(`tokenmiser v${VERSION}`);
    process.exit(0);
  }
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // ── Config subcommands ──
  if (opts.config || opts.addSub || opts.addBudget || opts.list || opts.remove || opts.quickSub) {
    if (opts.quickSub) {
      config.quickAddSubscription(opts.quickSub, opts.account || 'Personal');
    } else if (opts.addSub) {
      await config.interactiveAddSubscription();
    } else if (opts.addBudget) {
      await config.interactiveAddBudget();
    } else if (opts.list) {
      config.printSubscriptions();
      config.printBudgets();
    } else if (opts.remove) {
      const cfg = config.readConfig();
      const removedSub = config.removeSubscription(cfg, opts.remove);
      const removedBudget = config.removeBudget(cfg, opts.remove);
      if (removedSub) console.log(`  ✓ Removed subscription: ${opts.remove}\n`);
      else if (removedBudget) console.log(`  ✓ Removed budget: ${opts.remove}\n`);
      else console.log(`  ✗ Not found: ${opts.remove}\n`);
    } else {
      // Just "tokenmiser config" — show current config
      config.printSubscriptions();
      config.printBudgets();
    }
    process.exit(0);
  }

  // ── Main flow: detect, collect, aggregate, dashboard ──
  try {
    const { records, sources, pricing, hasApiSource } = await detectAndCollect(opts.verbose, opts.csv);

    // Deduplication
    deduplicateRecords(records);

    // Aggregation
    const data = aggregate(records, pricing);
    const localOnly = !hasApiSource && records.some((r) => r.estimated);

    // Subscription data — use manual config if available, otherwise auto-detect
    const cfg = config.readConfig();
    const budgets = cfg.budgets || [];
    let subRecords = getSubscriptionRecords(30);
    let totalSubCost = getTotalSubscriptionCost(30);
    let subsAutoDetected = false;

    if (subRecords.length === 0) {
      // No manual subscriptions — try auto-detection from usage data
      subRecords = detectSubscriptions(records);
      totalSubCost = subRecords.reduce((s, r) => s + r.proratedCost, 0);
      subsAutoDetected = subRecords.length > 0;
    }

    if (subRecords.length > 0) {
      const label = subsAutoDetected ? 'Subscriptions (auto-detected)' : 'Subscriptions';
      process.stderr.write(`  ✓ ${label.padEnd(28)} ${fmtMoney(totalSubCost)} (${subRecords.length} active plans)\n\n`);
    }

    if (records.length === 0 && subRecords.length === 0) {
      process.stderr.write('  No data found from any source.\n');
      process.stderr.write('  Set at least one API key, use a CLI tool, or add subscriptions.\n\n');
      process.exit(0);
    }

    // ── JSON output ──
    if (opts.json) {
      console.log(JSON.stringify({
        sources,
        ...data,
        subscriptions: subRecords,
        totalSubCost,
        budgets,
        localOnly,
        fetchedAt: new Date().toISOString(),
      }, null, 2));
      return;
    }

    // ── HTML Dashboard ──
    const html = generateDashboard(records, sources, localOnly, subRecords, budgets, VERSION);
    fs.writeFileSync(OUTPUT_FILE, html, 'utf8');

    // ── Terminal summary ──
    console.log(`  ╔═══════════════════════════════════════════════════════╗`);
    console.log(`  ║  TOKENMISER v${VERSION}                                   ║`);
    console.log(`  ╚═══════════════════════════════════════════════════════╝`);

    if (localOnly) {
      console.log(`  ⚠ LOCAL USAGE ONLY — no API keys set`);
      console.log(`  Set OPENROUTER_API_KEY or ANTHROPIC_ADMIN_KEY for real billing data.`);
    }

    const totalWithSubs = data.totalCost + totalSubCost;

    console.log(`  ─────────────────────────────────────────────────────────`);
    console.log(`  Per-Token Spend (30d): ${localOnly ? '—' : fmtMoney(data.totalCost)}`);
    if (totalSubCost > 0) {
      console.log(`  Subscriptions:         ${fmtMoney(totalSubCost)}`);
    }
    console.log(`  Total Monthly Spend:   ${localOnly ? '—' : fmtMoney(totalWithSubs)}`);
    console.log(`  Active Models:         ${data.activeModels}`);
    console.log(`  Total Requests:        ${data.totalRequests.toLocaleString()}`);

    if (!localOnly) {
      console.log(`  ─────────────────────────────────────────────────────────`);
      console.log(`  Counterfactual:        ${fmtMoney(data.counterfactualCost)} (all → ${data.maxRateModelName})`);
      console.log(`  Routing Savings:       ${fmtMoney(data.routingSavings)} (${fmtPct(data.costReduction)} reduction)`);
    }

    console.log(`  ─────────────────────────────────────────────────────────`);
    data.modelRanking.slice(0, 5).forEach((m) => {
      const costStr = m.sources === 'local-usage-only'
        ? '—'.padStart(12)
        : fmtMoney(m.cost).padStart(12);
      console.log(`  ${m.name.padEnd(30)} ${costStr}  [${m.sources}]`);
    });
    if (data.modelRanking.length > 5) {
      console.log(`  ... and ${data.modelRanking.length - 5} more`);
    }

    if (subRecords.length > 0) {
      console.log(`  ─────────────────────────────────────────────────────────`);
      console.log(`  Subscriptions:`);
      subRecords.forEach((s) => {
        const partial = s.isPartial ? ' (partial)' : '';
        console.log(`  ${(s.providerName + ' / ' + s.accountLabel).padEnd(30)} ${fmtMoney(s.proratedCost).padStart(12)}  [${s.planName}${partial}]`);
      });
    }

    console.log(`\n  Dashboard: ${OUTPUT_FILE}`);

    // Start the dashboard server (non-blocking)
    if (!opts.noServer) {
      try {
        const { url } = await startServer(html);
        console.log(`  Server:    ${url} (auto-stops after 30m idle)`);
        const opened = openInBrowser(url);
        console.log(opened ? `  Opened in browser.\n` : `  Open the URL above in your browser.\n`);
      } catch (serverErr) {
        // Server failed to start — fall back to file-based dashboard
        const opened = openInBrowser(OUTPUT_FILE);
        console.log(opened ? `  Opened in browser.\n` : `  Open the file above in your browser.\n`);
      }
    } else {
      const opened = openInBrowser(OUTPUT_FILE);
      console.log(opened ? `  Opened in browser.\n` : `  Open the file above in your browser.\n`);
    }
  } catch (err) {
    console.error(`\n  Error: ${err.message}\n`);
    if (process.env.TOKENMISER_DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
