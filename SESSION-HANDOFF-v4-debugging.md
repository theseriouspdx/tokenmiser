# Tokenmiser Session Handoff — v4.0.0 Debugging

## What Is Tokenmiser
A zero-dependency Node.js CLI tool (`~/tokenmiser/cli.js`) that auto-detects AI API spending across multiple billing sources and generates an interactive HTML dashboard. Git repo at `~/tokenmiser/` with 5 commits on main. Current version: v4.0.0.

## What Just Happened (v3.0 → v4.0)
A major refactor and feature build in a single session. The tool went from a single 1270-line file to 24 modules (3,846 lines) with multi-file architecture. Here's everything that changed:

### Architecture Change
The tool was refactored from a monolithic `cli.js` into:
```
tokenmiser/
├── cli.js                           (270 lines — entry point, arg parsing, main)
├── lib/
│   ├── format.js                    (formatting helpers, CSV parser, model name normalizer)
│   ├── http.js                      (zero-dep HTTPS client)
│   ├── config.js                    (config file mgmt, interactive CLI for subs/budgets)
│   ├── dedup.js                     (dedup engine — matches local logs to API records)
│   ├── aggregate.js                 (data aggregation for dashboard)
│   ├── subscriptions.js             (proration math, subscription cost records)
│   ├── collectors/
│   │   ├── index.js                 (registry + detectAndCollect orchestrator)
│   │   ├── openrouter-api.js        (OpenRouter API — existing, extracted)
│   │   ├── openrouter-csv.js        (OpenRouter CSV import — existing, extracted)
│   │   ├── anthropic-api.js         (Anthropic Usage + Cost API — UPGRADED)
│   │   ├── openai-api.js            (OpenAI Usage + Cost API — UPGRADED)
│   │   ├── claude-code-logs.js      (Claude Code local logs — existing, extracted)
│   │   ├── codex-logs.js            (Codex CLI sessions — NEW)
│   │   ├── cline-logs.js            (Cline VS Code extension — NEW)
│   │   └── aider-logs.js            (Aider chat history — NEW)
│   └── dashboard/
│       ├── index.js                 (main dashboard generator, client-side JS)
│       ├── styles.js                (full CSS)
│       └── views/
│           ├── overview.js          (Dashboard main view)
│           ├── cost-explorer.js     (filterable/sortable/exportable drill-down)
│           ├── model-analytics.js   (efficiency metrics, I/O ratios, frequency)
│           ├── task-monitor.js      (recent activity from all sources)
│           ├── budget-alerts.js     (budget tracking with projections)
│           ├── optimization.js      (cost-saving recommendations)
│           └── settings.js          (API keys, subs, local sources, billing rules)
```

### Bugs Fixed
1. **Sidebar nav** — Was `onclick="return false"` on all items. Now each routes to a real view via `switchView('view-name')`.
2. **Bar/Line chart toggle** — Old code used inconsistent display logic (inline `display` for bar, CSS class for line). Now both use `style.display` consistently.

### API Collectors Upgraded
- **Anthropic**: Now attempts the documented Cost API (`/v1/organizations/cost_report`) for actual USD costs, with Usage API (`/v1/organizations/usage_report/messages`) for token counts. Falls back gracefully to token-based estimation.
- **OpenAI**: Now attempts Cost API (`/v1/organization/costs`) for USD, with Usage API (`/v1/organization/usage/completions`) for tokens. Same fallback pattern.

### New Features Built
- **Config system**: `~/.tokenmiser/config.json` with interactive CLI (`config --add-sub`, `--add-budget`, `--list`, `--remove ID`)
- **Subscription tracking**: Multiple accounts per provider, mid-month plan changes, proration math
- **3 new log collectors**: Codex CLI, Cline, Aider
- **7 dashboard views**: All functional, not placeholders
- **Budget alerts**: Progress bars, projected month-end spend
- **Optimization**: Data-driven recommendations, model comparison table, subscription value analysis

## Current State (Working)
* `node cli.js --version` → `tokenmiser v4.0.0`
* `node cli.js --csv test-data.csv` → $671.70 from OpenRouter (correct, unchanged from v3)
* `node cli.js --json` → full JSON output including subscriptions/budgets
* `node cli.js config --list` → shows configured subscriptions/budgets
* All 24 modules load without errors
* Dashboard HTML generates with all 7 views

## What Needs Debugging / Testing
This build was done in a sandbox environment without access to a real browser for visual testing. The next session should focus on:

### 1. Visual Dashboard Testing
Generate the dashboard with real data (`node cli.js --csv test-data.csv`) and open `tokenmiser-report.html` in a browser. Check:
- Does the sidebar navigation actually switch between all 7 views?
- Does the bar/line chart toggle work?
- Do the source toggle buttons filter data correctly?
- Does the period selector (24h/7d/30d/90d) re-render all views?
- Is the layout responsive at different window widths?
- Are there any JS console errors?

### 2. Subscription Flow Testing
Add actual subscriptions and verify:
```bash
node cli.js config --add-sub    # Walk through adding Claude Max 20x, etc.
node cli.js config --list       # Verify they show
node cli.js                     # Verify dashboard includes subscription costs
node cli.js config --remove ID  # Verify removal
```

### 3. View-Specific Testing
Each view generates its content client-side from embedded JSON. Check:
- **Cost Explorer**: Do the provider/source filter dropdowns populate? Does sorting work? Does JSON export download?
- **Model Analytics**: Do efficiency metrics calculate correctly? Does the I/O ratio chart render?
- **Task Monitor**: Does the source filter work? Does sorting by date/tokens/cost/requests work?
- **Budget Alerts**: After adding a budget (`config --add-budget`), do the progress bars show? Does the projection chart render?
- **Optimization**: Do recommendations generate based on actual data? Does the model comparison table populate?
- **Settings**: Does it correctly show which API keys are connected vs not? Does it show detected local sources?

### 4. API Collector Testing (if keys available)
If the user has API keys set:
```bash
export ANTHROPIC_ADMIN_KEY=sk-ant-admin-...
export OPENAI_ADMIN_KEY=sk-admin-...
node cli.js --verbose
```
Check that the upgraded collectors (Anthropic Cost API, OpenAI Cost API) work with real endpoints.

### 5. Local Log Collector Testing
The new collectors (Codex, Cline, Aider) need testing against real log files:
- Does the Codex collector find `~/.codex/sessions/` correctly?
- Does the Cline collector find VS Code globalStorage?
- Does the Aider collector parse `.aider.chat.history.md` files?

### 6. Edge Cases to Watch For
- What happens with zero data (no API keys, no local logs, no subscriptions)?
- What happens with only subscriptions and zero per-token data?
- What happens with only local logs and zero API data?
- Escaping in embedded JSON (model names with special chars?)
- Subscription proration across month boundaries

## The User's Actual Spending Picture
Source | Type | Billing | Status
--- | --- | --- | ---
OpenRouter API | Per-token | CSV import | Working
Claude Code local logs | Token counts only | No cost (dedup against API) | Working
Claude OAuth (Account 1) | Fixed subscription | Pro → Max 20x mid-month | Config system built, needs data entry
Claude OAuth (Account 2) | Fixed subscription | Regular plan | Config system built, needs data entry
Gemini OAuth (Account 1) | Fixed subscription | Dashboard shows billing | Config system built, needs data entry
Gemini OAuth (Account 2) | Fixed subscription | Dashboard shows billing | Config system built, needs data entry
Direct Anthropic API | Per-token | Anthropic console (~$9) | Collector upgraded, needs ANTHROPIC_ADMIN_KEY

## Original Design Spec
The original specification that drove this build is in the conversation history from the v3→v4 session. Key design principles from that spec:

- **Think beyond one user's edge cases** — The architecture handles multiple providers, multiple accounts per provider, CLI tools beyond just Claude Code, and both per-token and subscription billing models.
- **Zero dependencies** — Only Node.js built-in modules.
- **Each source is a separate billing path** — Tagged on every record, never merged.
- **Subscriptions are fundamentally different** from per-token billing — fixed monthly cost regardless of token usage.
- **Config file at `~/.tokenmiser/config.json`** — Persistent settings for subscriptions, budgets, billing rules.
- **Dashboard represents both billing models** — Per-token (cost per model/day) and subscription (plan cost per account per month).

## Key Files
* `~/tokenmiser/cli.js` — entry point (270 lines)
* `~/tokenmiser/lib/` — all modules (24 files, 3,576 lines)
* `~/tokenmiser/package.json` — v4.0.0
* `~/tokenmiser/test-data.csv` — OpenRouter activity CSV (16,160 rows, untracked in git)
* `~/.tokenmiser/config.json` — user config (created on first `config` command)
* Workspace mount: `/Users/johnserious/Claude/Projects/SUCCESS/tokenmiser-cli/`

## Git Log
```
3403d53 v4.0.0: Multi-file refactor, 7 dashboard views, subscription tracking, new collectors
2537fe5 v3.0.0: CSV import, dedup engine, interactive dashboard
68f4e6a v2.0.1: Fix local log parsing and add cost estimation warnings
370893d v2.0: Multi-source auto-detection
68a4570 Initial commit: tokenmiser CLI v1.0.0
```

## User Preferences
* Always outline the complete plan and get input before proceeding
* Don't defer features that are in the spec — build what was asked for
* User will provide screenshots as needed for dashboard verification
* Keep it zero-dependency Node.js
* Think through ALL edge cases up front, not just the current user's setup
* Use the no-mistakes protocol for non-trivial tasks
