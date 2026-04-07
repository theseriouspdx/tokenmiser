# Tokenmiser Session Handoff — v4.0.0 → v4.1.0 Debug & Polish

## What is Tokenmiser

Zero-dependency Node.js CLI tool (`node cli.js`) that tracks AI API spending across multiple billing sources. Refactored from 1 file to 26 modules (now ~4,500 lines). Generates a self-contained HTML dashboard (`tokenmiser-report.html`).

The user's CLAUDE.md requires: **always outline complete plan and get input before proceeding. Always ask before making assumptions that edit files.**

## Architecture

```
cli.js                          # Entry point (shebang, arg parsing, main flow)
lib/
  format.js                     # Shared formatters (money, tokens, CSV parser, normalizeModelName)
  http.js                       # Zero-dep HTTPS GET helper
  config.js                     # ~/.tokenmiser/config.json management, subscription templates
  subscriptions.js              # Subscription cost calculation with proration
  aggregate.js                  # Data aggregation for dashboard
  dedup.js                      # Deduplication engine (API > CSV > local logs)
  collectors/
    index.js                    # Registry + orchestrator (detectAndCollect)
    openrouter-api.js           # OpenRouter /api/v1/key (regular) or /api/v1/activity (management)
    openrouter-csv.js           # CSV import with app_name, api_key_name columns
    anthropic-api.js            # Anthropic Admin Usage + Cost API
    openai-api.js               # OpenAI Usage + Cost API
    claude-code-logs.js         # ~/.claude/projects/ JSONL (infers billing from model name)
    codex-logs.js               # ~/.codex/sessions/ JSONL (has explicit model_provider)
    cline-logs.js               # VS Code globalStorage (Cline extension)
    aider-logs.js               # .aider.chat.history.md (per-project)
    gemini-cli-logs.js          # ~/.gemini/ (NEW, experimental)
    cursor-logs.js              # Cursor state.vscdb SQLite (NEW, experimental, needs sqlite3)
  dashboard/
    index.js                    # HTML generator (embeds data as JSON, client-side JS)
    styles.js                   # CSS generation
    views/
      overview.js               # Main dashboard (KPIs, charts, model ranking, billing paths)
      cost-explorer.js          # Cost breakdown by date/model/source
      model-analytics.js        # Per-model deep dive
      task-monitor.js           # Individual task/session tracking
      budget-alerts.js          # Budget threshold alerts
      optimization.js           # Routing savings analysis
      settings.js               # API key status, local sources, subscriptions, billing rules
```

## What Was Done This Session

### Phase 1: OpenRouter API Fix
- **Before**: Required `OPENROUTER_MANAGEMENT_KEY` (nobody has one) for `/api/v1/activity`
- **After**: Uses regular `OPENROUTER_API_KEY` with `/api/v1/key` endpoint for per-key usage summary. Management key still supported as optional upgrade for full per-model activity.
- **File**: `lib/collectors/openrouter-api.js` — complete rewrite with dual-mode (regular vs management key)
- **File**: `lib/collectors/index.js` — passes `isManagement` flag to collector

### Phase 2: Gemini CLI Collector (NEW)
- **File**: `lib/collectors/gemini-cli-logs.js` — brand new collector
- Reads from `~/.gemini/` (logs/sessions/, history/, sessions/)
- Parses JSONL and JSON formats for usageMetadata (promptTokenCount, candidatesTokenCount)
- Pricing table for gemini-2.5-pro, 2.5-flash, 2.0-flash, 1.5-pro, 1.5-flash
- Billing path inference: `google-api` (default) or `vertex-ai` (if model name indicates)
- Flagged as `experimental: true`

### Phase 3: Cursor Collector (NEW)
- **File**: `lib/collectors/cursor-logs.js` — brand new collector
- Reads Cursor's SQLite DB at platform-specific paths (macOS, Linux, Windows)
- Requires `sqlite3` CLI tool (pre-installed on macOS)
- Extracts from `cursorDiskKV` (composerData) and `ItemTable` (chat data)
- Token counts are "best-effort" (often 0 per Cursor devs) — primarily tracks request volume
- All records marked `billingPath: 'cursor-subscription'`, `cost: 0`
- Flagged as `experimental: true`

### Phase 4: Subscription Config Extensions
- **File**: `lib/config.js` — major additions
- Added 2 new providers: `github` (Copilot), `cursor` (Cursor IDE)
- Added 11 quick-add templates: claude-pro, claude-max, claude-max-20x, chatgpt-plus, chatgpt-pro, gemini-advanced, copilot-individual, copilot-business, copilot-enterprise, cursor-pro, cursor-business
- New `quickAddSubscription(templateName, accountLabel)` function
- Interactive `--add-sub` now shows templates first, manual entry as fallback
- **File**: `cli.js` — added `--quick-sub TEMPLATE --account LABEL` CLI args
- Help text updated with all new sources, templates, and documented limitations

### Phase 5: Dedup + Dashboard Updates
- **File**: `lib/dedup.js` — complete rewrite
  - CSV self-dedup: handles duplicate CSV imports via (date, model, appName) key
  - Source priority system: API (3) > CSV/OpenRouter (2) > Local logs (1)
  - Subscription billing paths (oauth, cursor-subscription, google-subscription) are NEVER deduplicated
  - OpenRouter summary records (isSummary flag) don't dedup against per-model records
- **File**: `lib/dashboard/index.js` — billing path label improvements
  - New labels: "OpenRouter (per-token)", "Subscription (Pro/Max/Plus)", "Cursor (subscription)", "Google AI (per-token)", "Vertex AI (per-token)", etc.
  - Subscription detection banner: when OAuth/subscription usage exists but no subscriptions configured, shows a warning with quick-sub command hint
- **File**: `lib/dashboard/views/settings.js` — added Gemini CLI and Cursor to local sources table

## What Needs Testing (Next Session)

### Browser Testing — All 7 Dashboard Views
None of the 7 dashboard views have been tested in an actual browser. This is the highest priority.

1. **Overview** — KPI cards, daily spend chart (bar + line), model ranking, billing path table, savings card, subscription section, source toggles, subscription detection banner
2. **Cost Explorer** — date range filtering, cost breakdown by model/source/date
3. **Model Analytics** — per-model token breakdown, 24h period button (added this session)
4. **Task Monitor** — individual task/session rows with `recordSourceLabel(r)`
5. **Budget Alerts** — threshold visualization, budget vs actual
6. **Optimization** — routing savings, model efficiency comparisons
7. **Settings** — API key status table (now includes OpenRouter dual-mode), local sources table (now includes Gemini CLI + Cursor), subscription list, billing rules

### New Collector Testing
- **Gemini CLI**: Does `~/.gemini/` exist on the user's machine? What format are the files? The log format was inferred from documentation — may need adjustment based on actual files.
- **Cursor**: Does the user have Cursor installed? Is `sqlite3` available? Test the DB queries work with actual Cursor data. Token counts may all be 0 (expected — Cursor is "best-effort").

### OpenRouter API Testing
- Test with regular `OPENROUTER_API_KEY` — should hit `/api/v1/key` and return usage summary
- Verify the summary record shows in the dashboard but doesn't interfere with CSV per-model records
- The `isSummary` flag prevents the account-total from deduping per-model records

### Subscription Flow Testing
- `tokenmiser --quick-sub claude-pro` — should create subscription in ~/.tokenmiser/config.json
- `tokenmiser --quick-sub copilot-individual --account "Work"` — with account label
- `tokenmiser config --add-sub` — interactive flow now shows templates first
- `tokenmiser config --list` — verify new providers show up correctly
- `tokenmiser config --remove ID` — verify removal works

### Dedup Testing
- Import same CSV twice → should see CSV dedup message, no double-counting
- Have both CSV and local logs for same model/date → local log cost should be zeroed, tokens retained
- OAuth usage should NOT be deduplicated against anything
- OpenRouter account-total summary should coexist with per-model CSV records

### Edge Cases
- Zero data (no sources at all) — should show "No data found" message
- Subscriptions only (no usage data) — should show subscription costs in KPIs
- Local logs only (no API keys) — should show estimated costs with warning banner
- Subscription detection banner — shows when OAuth usage detected but no subs configured

## Known Issues / Out of Scope for Next Session

These are documented limitations, not bugs:

1. **GitHub Copilot usage API** — exists (`GET /orgs/{ORG}/copilot/metrics`) but requires org admin token with `manage_billing:copilot` scope. Most individual users won't have this. Solution: subscription tracking only.

2. **Google Vertex AI / Cloud Monitoring** — Cloud Monitoring API (`GET /v3/projects/{ID}/timeSeries`) can get Vertex AI metrics, but requires GCP service account + OAuth2 setup. Too complex for a zero-dependency CLI. Solution: Gemini CLI local logs + subscription tracking for Gemini Advanced.

3. **Google AI Studio** — No programmatic usage API exists at all. Dashboard-only.

4. **Cursor token counts** — Cursor devs confirmed `tokenCount` fields are "best-effort" and often show 0. The collector tracks request volume regardless. Accurate token counts would require Cursor's backend API (which doesn't have a public endpoint).

5. **Gemini CLI log format** — The collector was built from documentation, not from actual log files on the user's machine. The log format may differ from what's documented. Needs real-world testing.

## User Preferences (from CLAUDE.md + conversation)

- **Always outline complete plan and get input before proceeding**
- **Always ask before making assumptions that edit files**
- Think agnostically across all tools, not just Claude
- Don't propose solutions that require keys/credentials the user doesn't have
- Come up with plans instead of asking too many questions
- Don't re-discover information already in the handoff
- The user runs the tool from inside the tokenmiser directory: `node cli.js`
- The user has the folder mounted via DC (Desktop Commander) at the standard path
- The user has an `OPENROUTER_API_KEY` set (regular key, not management)
- The user does NOT have `ANTHROPIC_ADMIN_KEY` or `OPENAI_ADMIN_KEY`

## File Counts
- 26 JS modules total (was 24, added gemini-cli-logs.js and cursor-logs.js)
- ~4,500 lines total
- 0 external dependencies
- Node.js 18+ required
