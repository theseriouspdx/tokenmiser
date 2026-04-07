'use strict';

/**
 * Config file management for ~/.tokenmiser/config.json
 *
 * Handles:
 *  - Reading/writing persistent config
 *  - Subscription management (add, list, remove, edit)
 *  - Budget alert thresholds
 *  - Billing rule preferences
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const CONFIG_DIR = path.join(os.homedir(), '.tokenmiser');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  version: 1,
  subscriptions: [],
  budgets: [],
  billingRules: {
    sourcePriority: ['api', 'csv', 'local-estimate'],
    dedupEnabled: true,
  },
  settings: {
    defaultPeriod: 30,
    defaultChartMode: 'bar',
  },
};

// ── Read / Write ─────────────────────────────────────────────────

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readConfig() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(raw);
    // Merge with defaults for forward-compatibility
    return {
      ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
      ...config,
      billingRules: { ...DEFAULT_CONFIG.billingRules, ...(config.billingRules || {}) },
      settings: { ...DEFAULT_CONFIG.settings, ...(config.settings || {}) },
    };
  } catch (e) {
    process.stderr.write(`  ⚠ Could not parse config: ${e.message}. Using defaults.\n`);
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function writeConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

// ── Subscription helpers ─────────────────────────────────────────

function generateId(provider, accountLabel) {
  const slug = `${provider}-${accountLabel}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
  const suffix = Date.now().toString(36).slice(-4);
  return `${slug}-${suffix}`;
}

function addSubscription(config, sub) {
  if (!sub.id) {
    sub.id = generateId(sub.provider, sub.accountLabel);
  }
  config.subscriptions.push(sub);
  writeConfig(config);
  return sub.id;
}

function removeSubscription(config, id) {
  const before = config.subscriptions.length;
  config.subscriptions = config.subscriptions.filter((s) => s.id !== id);
  if (config.subscriptions.length === before) {
    return false; // not found
  }
  writeConfig(config);
  return true;
}

function listSubscriptions(config) {
  return config.subscriptions;
}

// ── Budget helpers ───────────────────────────────────────────────

function addBudget(config, budget) {
  if (!budget.id) {
    budget.id = `budget-${Date.now().toString(36)}`;
  }
  config.budgets.push(budget);
  writeConfig(config);
  return budget.id;
}

function removeBudget(config, id) {
  const before = config.budgets.length;
  config.budgets = config.budgets.filter((b) => b.id !== id);
  if (config.budgets.length === before) return false;
  writeConfig(config);
  return true;
}

// ── Interactive CLI for subscription management ──────────────────

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

const KNOWN_PROVIDERS = {
  anthropic: {
    name: 'Anthropic (Claude)',
    plans: ['Free', 'Pro ($20/mo)', 'Max 5x ($100/mo)', 'Max 20x ($200/mo)', 'Team ($30/user/mo)', 'Enterprise (custom)'],
  },
  openai: {
    name: 'OpenAI (ChatGPT)',
    plans: ['Free', 'Plus ($20/mo)', 'Pro ($200/mo)', 'Team ($25/user/mo)', 'Enterprise (custom)'],
  },
  google: {
    name: 'Google (Gemini)',
    plans: ['Free', 'Advanced ($20/mo / Google One AI Premium)', 'Business ($14/user/mo)', 'Enterprise (custom)'],
  },
  github: {
    name: 'GitHub (Copilot)',
    plans: ['Free', 'Individual ($10/mo)', 'Business ($19/user/mo)', 'Enterprise ($39/user/mo)'],
  },
  cursor: {
    name: 'Cursor IDE',
    plans: ['Hobby (free)', 'Pro ($20/mo)', 'Business ($40/user/mo)'],
  },
  other: {
    name: 'Other',
    plans: [],
  },
};

/**
 * Quick-add subscription templates for common plans.
 * Maps a template name to a pre-filled subscription object.
 */
const SUBSCRIPTION_TEMPLATES = {
  'claude-pro':      { provider: 'anthropic', planName: 'Pro',         monthlyCost: 20 },
  'claude-max':      { provider: 'anthropic', planName: 'Max 5x',     monthlyCost: 100 },
  'claude-max-20x':  { provider: 'anthropic', planName: 'Max 20x',    monthlyCost: 200 },
  'chatgpt-plus':    { provider: 'openai',    planName: 'Plus',        monthlyCost: 20 },
  'chatgpt-pro':     { provider: 'openai',    planName: 'Pro',         monthlyCost: 200 },
  'gemini-advanced':  { provider: 'google',    planName: 'Advanced',    monthlyCost: 20 },
  'copilot-individual': { provider: 'github', planName: 'Individual',  monthlyCost: 10 },
  'copilot-business':   { provider: 'github', planName: 'Business',    monthlyCost: 19 },
  'copilot-enterprise': { provider: 'github', planName: 'Enterprise',  monthlyCost: 39 },
  'cursor-pro':      { provider: 'cursor',    planName: 'Pro',         monthlyCost: 20 },
  'cursor-business':  { provider: 'cursor',    planName: 'Business',    monthlyCost: 40 },
};

/**
 * Quick-add a subscription using a template name.
 * e.g. quickAddSubscription('claude-pro', 'Personal')
 */
function quickAddSubscription(templateName, accountLabel) {
  const template = SUBSCRIPTION_TEMPLATES[templateName];
  if (!template) {
    console.log(`  ✗ Unknown template: ${templateName}`);
    console.log(`  Available: ${Object.keys(SUBSCRIPTION_TEMPLATES).join(', ')}\n`);
    return null;
  }

  const cfg = readConfig();
  const today = new Date().toISOString().slice(0, 10);
  const sub = {
    provider: template.provider,
    accountLabel: accountLabel || 'Personal',
    plans: [{ name: template.planName, monthlyCost: template.monthlyCost, startDate: today, endDate: null }],
  };
  const id = addSubscription(cfg, sub);
  const provName = (KNOWN_PROVIDERS[template.provider] || KNOWN_PROVIDERS.other).name;
  console.log(`  ✓ Added: ${provName} — ${accountLabel || 'Personal'} — ${template.planName} ($${template.monthlyCost}/mo)`);
  console.log(`    ID: ${id}\n`);
  return id;
}

async function interactiveAddSubscription() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('\n  ── Add Subscription ──────────────────────────────────\n');

    // Show quick-add templates first
    console.log('  Quick-add templates:');
    const templateKeys = Object.keys(SUBSCRIPTION_TEMPLATES);
    templateKeys.forEach((k, i) => {
      const t = SUBSCRIPTION_TEMPLATES[k];
      const provName = (KNOWN_PROVIDERS[t.provider] || KNOWN_PROVIDERS.other).name;
      console.log(`    ${(i + 1).toString().padStart(2)}. ${k.padEnd(22)} ${provName} — ${t.planName} ($${t.monthlyCost}/mo)`);
    });
    console.log(`    ${(templateKeys.length + 1).toString().padStart(2)}. Custom (manual entry)\n`);

    const quickIdx = parseInt(await ask(rl, '  Select (number): ')) - 1;

    if (quickIdx >= 0 && quickIdx < templateKeys.length) {
      // Quick-add flow
      const templateName = templateKeys[quickIdx];
      const accountLabel = await ask(rl, '  Account label (e.g. "Personal", "Work"): ') || 'Personal';
      rl.close();
      return quickAddSubscription(templateName, accountLabel);
    }

    // Fall through to manual entry
    console.log();

    // Provider
    const providerKeys = Object.keys(KNOWN_PROVIDERS);
    providerKeys.forEach((k, i) => console.log(`    ${i + 1}. ${KNOWN_PROVIDERS[k].name}`));
    const provIdx = parseInt(await ask(rl, '\n  Provider (number): ')) - 1;
    const provider = providerKeys[provIdx] || 'other';
    const provInfo = KNOWN_PROVIDERS[provider];

    // Account label
    const accountLabel = await ask(rl, '  Account label (e.g. "Personal", "Work john@..."): ');
    if (!accountLabel) {
      console.log('  Cancelled — no account label provided.\n');
      return null;
    }

    // Plans (can have multiple for mid-month changes)
    const plans = [];
    let addingPlans = true;

    while (addingPlans) {
      console.log(`\n  ── Plan ${plans.length + 1} ──`);

      // Plan name
      let planName;
      if (provInfo.plans.length > 0) {
        console.log('  Known plans:');
        provInfo.plans.forEach((p, i) => console.log(`    ${i + 1}. ${p}`));
        console.log(`    ${provInfo.plans.length + 1}. Custom (type your own)`);
        const planIdx = parseInt(await ask(rl, '  Plan (number): ')) - 1;
        if (planIdx >= 0 && planIdx < provInfo.plans.length) {
          planName = provInfo.plans[planIdx].split(' (')[0]; // strip price hint
        } else {
          planName = await ask(rl, '  Custom plan name: ');
        }
      } else {
        planName = await ask(rl, '  Plan name: ');
      }

      // Monthly cost
      const costStr = await ask(rl, '  Monthly cost (USD, numbers only): $');
      const monthlyCost = parseFloat(costStr) || 0;

      // Start date
      const startDate = await ask(rl, '  Start date (YYYY-MM-DD): ');
      if (!startDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
        console.log('  ⚠ Invalid date format. Using today.');
      }
      const validStart = startDate.match(/^\d{4}-\d{2}-\d{2}$/) ? startDate : new Date().toISOString().slice(0, 10);

      // End date
      const endDateStr = await ask(rl, '  End date (YYYY-MM-DD, or blank if current): ');
      const endDate = endDateStr.match(/^\d{4}-\d{2}-\d{2}$/) ? endDateStr : null;

      plans.push({ name: planName, monthlyCost, startDate: validStart, endDate });

      const more = await ask(rl, '  Add another plan for this account? (e.g. plan change) [y/N]: ');
      addingPlans = more.toLowerCase() === 'y';
    }

    const sub = { provider, accountLabel, plans };
    const config = readConfig();
    const id = addSubscription(config, sub);

    console.log(`\n  ✓ Subscription added: ${id}`);
    console.log(`    ${provInfo.name} — ${accountLabel}`);
    plans.forEach((p) => {
      console.log(`    ${p.name}: $${p.monthlyCost}/mo (${p.startDate} → ${p.endDate || 'current'})`);
    });
    console.log();

    return id;
  } finally {
    rl.close();
  }
}

async function interactiveAddBudget() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('\n  ── Add Budget Alert ──────────────────────────────────\n');

    const scope = await ask(rl, '  Scope (total / per-source name): ') || 'total';
    const amountStr = await ask(rl, '  Monthly budget (USD): $');
    const monthly = parseFloat(amountStr) || 0;
    const warnPctStr = await ask(rl, '  Warning threshold % (default 80): ');
    const warnPct = parseInt(warnPctStr) || 80;

    const budget = { scope, monthly, warnPct };
    const config = readConfig();
    const id = addBudget(config, budget);

    console.log(`\n  ✓ Budget alert added: ${id}`);
    console.log(`    Scope: ${scope} — $${monthly}/mo — warn at ${warnPct}%\n`);

    return id;
  } finally {
    rl.close();
  }
}

function printSubscriptions() {
  const config = readConfig();
  const subs = config.subscriptions;

  if (subs.length === 0) {
    console.log('\n  No subscriptions configured.');
    console.log('  Run: tokenmiser config --add-sub\n');
    return;
  }

  console.log(`\n  ── Subscriptions (${subs.length}) ──────────────────────────────\n`);
  subs.forEach((s) => {
    const provName = (KNOWN_PROVIDERS[s.provider] || KNOWN_PROVIDERS.other).name;
    console.log(`  ${s.id}`);
    console.log(`    Provider: ${provName}`);
    console.log(`    Account:  ${s.accountLabel}`);
    (s.plans || []).forEach((p) => {
      console.log(`    Plan:     ${p.name} — $${p.monthlyCost}/mo (${p.startDate} → ${p.endDate || 'current'})`);
    });
    console.log();
  });
}

function printBudgets() {
  const config = readConfig();
  const budgets = config.budgets;

  if (budgets.length === 0) {
    console.log('\n  No budget alerts configured.');
    console.log('  Run: tokenmiser config --add-budget\n');
    return;
  }

  console.log(`\n  ── Budget Alerts (${budgets.length}) ──────────────────────────────\n`);
  budgets.forEach((b) => {
    console.log(`  ${b.id}: ${b.scope} — $${b.monthly}/mo — warn at ${b.warnPct}%`);
  });
  console.log();
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  readConfig,
  writeConfig,
  addSubscription,
  removeSubscription,
  listSubscriptions,
  addBudget,
  removeBudget,
  interactiveAddSubscription,
  interactiveAddBudget,
  quickAddSubscription,
  printSubscriptions,
  printBudgets,
  KNOWN_PROVIDERS,
  SUBSCRIPTION_TEMPLATES,
};
