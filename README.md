# tokenmiser

See where your AI API money goes. Zero dependencies, one command, self-contained HTML dashboard.

tokenmiser auto-detects every AI billing source on your machine — API keys, local CLI logs, CSV exports — and generates an interactive dashboard that breaks down spending by tool, model, project, and time period. Subscriptions (Claude Pro, Gemini Advanced, ChatGPT Plus, Cursor Pro) are auto-detected from usage data or can be configured manually.

## Requirements

- Node.js 18+
- No other dependencies

## Installation

```bash
npm install -g tokenmiser
```

Or run directly from the repo:

```bash
git clone https://github.com/jserious/tokenmiser.git
cd tokenmiser
node cli.js
```
## Quick start

```bash
# Run with defaults — auto-detects everything, opens dashboard in browser
tokenmiser

# Output raw JSON instead of dashboard
tokenmiser --json

# Import an OpenRouter CSV export
tokenmiser --csv ~/Downloads/openrouter-activity.csv

# Skip the live server, just write the HTML file
tokenmiser --no-server
```

## Supported data sources

tokenmiser collects usage data from 10 sources across 3 categories:

### API billing (requires API keys)

| Source | Key | What it reads |
|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY` | Generation stats via `/api/v1/activity` |
| Anthropic | `ANTHROPIC_ADMIN_KEY` | Cost API via admin endpoint |
| OpenAI | `OPENAI_ADMIN_KEY` or `OPENAI_API_KEY` | Usage + Cost API |
Set keys as environment variables or add them through the dashboard settings view.

### Local CLI logs (auto-detected, no keys needed)

| Tool | Log location | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/` | JSONL conversation logs |
| Gemini CLI | `~/.gemini/tmp/*/chats/` | Session JSON files |
| Codex CLI | `~/.codex/` | Session logs with token counts |
| Cline | VS Code extension storage | Task-level usage from globalStorage |
| Cursor | `~/Library/Application Support/Cursor/` | SQLite usage database |
| Aider | Per-project `.aider.chat.history.md` | Markdown chat history files |

Local collectors use a 90-day lookback window.

### CSV import

| Source | Flag | Notes |
|---|---|---|
| OpenRouter CSV | `--csv FILE` | Activity export from openrouter.ai — no time filter, all rows imported |

## CLI reference

```
tokenmiser                          Run with auto-detection, open dashboard
tokenmiser --json                   Output raw JSON to stdout
tokenmiser --verbose                Show detailed source detection info
tokenmiser --csv FILE               Import OpenRouter activity CSV export
tokenmiser --no-server              Write HTML file only, don't start server
tokenmiser --help                   Show help
tokenmiser --version                Show version
```
### Config subcommands

```
tokenmiser config --add-sub         Add a subscription (interactive, with templates)
tokenmiser config --add-budget      Add a budget alert (interactive)
tokenmiser config --list             List subscriptions and budgets
tokenmiser config --remove ID       Remove a subscription or budget by ID
tokenmiser config --quick-sub NAME  Quick-add a subscription by template name
```

Config is stored at `~/.tokenmiser/config.json`.

## Dashboard

The dashboard is a self-contained HTML file with no external dependencies. Running `tokenmiser` starts a local HTTP server and opens the dashboard in your default browser. The server auto-shuts down after 30 minutes of inactivity.

### Views

- **Overview** — KPI cards (total spend, tokens, requests, active models), spending chart, per-tool breakdown. Filter by time period (24h / 7d / 30d / 90d) and project.
- **Cost Explorer** — Stacked bar chart of daily spend by model, with period selector and model legend.
- **Model Analytics** — Per-model breakdown: tokens, cost, efficiency metrics, cost-per-1K-token rates.
- **Task Monitor** — Session-level view of AI tool usage across projects.
- **Budget Alerts** — Track spending against configured budgets with progress bars and alerts.
- **Optimization** — Suggestions for reducing cost based on model usage patterns.
- **Settings** — Manage API keys, view detected sources, configure subscriptions.
- **Help** — Command reference, supported sources table, about info.
## Subscription tracking

tokenmiser tracks fixed monthly subscription costs separately from per-token API billing.

### Auto-detection

Subscriptions are automatically inferred from usage data. If tokenmiser sees local logs from a tool that uses OAuth or subscription billing, it adds the subscription cost automatically:

| Billing path | Detected subscription | Default cost |
|---|---|---|
| `oauth` | Claude Pro | $20/mo |
| `google-subscription` | Gemini Advanced | $20/mo |
| `chatgpt-subscription` | ChatGPT Plus | $20/mo |
| `cursor-subscription` | Cursor Pro | $20/mo |

Auto-detected subscriptions show usage (tokens and requests) with $0 per-token cost, since usage is covered by the subscription.

### Manual configuration

Add subscriptions manually for tools that can't be auto-detected:

```bash
# Interactive — walks you through name, cost, billing cycle
tokenmiser config --add-sub

# Quick-add from built-in templates
tokenmiser config --quick-sub "Claude Pro"
tokenmiser config --quick-sub "ChatGPT Plus"
```

Manual subscriptions take precedence over auto-detected ones.
## How billing paths work

Every usage record is tagged with a billing path that identifies where the cost is charged. Records from different billing paths are never merged, even if they use the same model. This means you can see exactly how much you're spending through each tool and account.

Examples of billing paths: `openrouter-api`, `anthropic-api`, `openai-api`, `claude-code/oauth`, `gemini-cli/google-subscription`, `codex/chatgpt-subscription`, `cline/anthropic-api`, `cursor/cursor-subscription`.

## Project tracking

Where possible, tokenmiser extracts the project name from local logs so you can filter the dashboard by project. Project detection works for Claude Code, Gemini CLI, Codex, Cline, and Aider. Use the project dropdown in the Overview to filter.

## Architecture

```
cli.js                    Entry point, arg parsing, orchestration
lib/
  collectors/             One module per data source
    index.js              Auto-detection and parallel collection
    openrouter-api.js     OpenRouter API collector
    anthropic-api.js      Anthropic Admin API collector
    openai-api.js         OpenAI Usage API collector
    claude-code-logs.js   Claude Code log parser
    gemini-cli-logs.js    Gemini CLI session parser
    codex-logs.js         Codex CLI log parser
    cline-logs.js         Cline extension log parser
    cursor-logs.js        Cursor SQLite reader
    aider-logs.js         Aider chat history parser
    openrouter-csv.js     OpenRouter CSV importer  aggregate.js            Group records by date/model/tool
  auto-subscriptions.js   Infer subscriptions from billing paths
  config.js               Read/write ~/.tokenmiser/config.json
  dedup.js                Cross-source deduplication
  format.js               Number/currency/token formatting
  server.js               Zero-dep HTTP server with REST API
  subscriptions.js        Manual subscription record generation
  dashboard/
    index.js              Dashboard HTML generator
    styles.js             CSS
    views/                One module per dashboard view
```

The server binds to a loopback address (tries 127.1.1.1, then 127.0.0.2, then 127.0.0.1) on a random port. It serves the dashboard HTML, exposes a REST API for config and refresh, and shuts itself down after 30 minutes idle.

## License

MIT