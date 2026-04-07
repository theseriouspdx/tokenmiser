# Tokenmiser Session Handoff — v4.1.0 Testing & Bug Fixing

## What is Tokenmiser
Zero-dependency Node.js CLI tool (`node cli.js`) that tracks AI API spending across multiple billing sources. Refactored from 1 file to 26 modules (~4,768 lines). Generates a self-contained HTML dashboard (`tokenmiser-report.html`) with 7 interactive views.

## User Preferences (from CLAUDE.md + prior sessions)
- Always outline complete plan and get input before proceeding
- Always ask before making assumptions that edit files
- Think agnostically across all tools, not just Claude
- Don't propose solutions that require keys/credentials the user doesn't have
- Come up with plans instead of asking too many questions
- Don't re-discover information already in the handoff
- The user runs the tool from inside the tokenmiser directory: `node cli.js`
- The user has an `OPENROUTER_API_KEY` set (regular key, not management)
- The user does NOT have `ANTHROPIC_ADMIN_KEY` or `OPENAI_ADMIN_KEY`

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
    openrouter-api.js           # OpenRouter: regular key (/api/v1/key) or management key (/api/v1/activity)
    openrouter-csv.js           # CSV import with app_name, api_key_name columns
    anthropic-api.js            # Anthropic Admin Usage + Cost API
    openai-api.js               # OpenAI Usage + Cost API
    claude-code-logs.js         # ~/.claude/projects/ JSONL (infers billing from model name)
    codex-logs.js               # ~/.codex/sessions/ JSONL (has explicit model_provider)
    cline-logs.js               # VS Code globalStorage (Cline extension)
    aider-logs.js               # .aider.chat.history.md (per-project)
    gemini-cli-logs.js          # ~/.gemini/ (experimental, built from docs not real files)
    cursor-logs.js              # Cursor state.vscdb SQLite (experimental, needs sqlite3)
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

## What Was Done in Previous Sessions

### Phase 1-5 (v4.0.0 session): Major feature additions
- **OpenRouter API dual-mode**: Regular key uses `/api/v1/key` (summary), management key uses `/api/v1/activity` (per-model detail)
- **Gemini CLI collector**: New, reads `~/.gemini/`, parses JSONL/JSON for usageMetadata, experimental
- **Cursor collector**: New, reads SQLite DB via `sqlite3` CLI, tracks request volume (token counts often 0), experimental
- **Subscription templates**: 11 quick-add templates (claude-pro, chatgpt-plus, copilot-individual, cursor-pro, etc.)
- **Dedup rewrite**: Source priority (API 3 > CSV 2 > local 1), CSV self-dedup, subscription paths never deduped, OpenRouter summary records (`isSummary` flag) coexist with per-model records
- **Dashboard updates**: New billing path labels, subscription detection banner, all 7 views updated

### Phase 6 (v4.1.0-debug session): Code review + 3 bug fixes
All 26 modules were code-reviewed. Three bugs were found and fixed:

1. **Model × Billing Path matrix was broken** (model-analytics.js line 127)
   - `m.sources` contained human-readable names like "OpenRouter (per-token)" but the matrix compared against raw billing path keys like "openrouter"
   - **Fix**: Added `rawSources` field to `aggregateRecords()` output (dashboard/index.js line 243) and updated the matrix to use `m.rawSources.indexOf(p)` instead of `m.sources.includes(p)`

2. **`sourceNames` missing new sources** (dashboard/index.js line 146-151)
   - The `sourceNames` lookup didn't have entries for `gemini-cli` or `cursor`
   - **Fix**: Added `'gemini-cli': 'Gemini CLI', 'cursor': 'Cursor'` to the map

3. **Task Monitor local count underreported** (task-monitor.js line 68)
   - Local source filter only checked claude-code, codex-cli, cline, aider
   - **Fix**: Added `||r.s==='gemini-cli'||r.s==='cursor'` to the filter

### Browser testing completed (all 7 views verified with synthetic data)
- Dashboard/Overview: KPIs, charts, source toggles, subscription section, billing path table — all rendering
- Cost Explorer: Filters, sortable table, provider/billing breakdowns — working
- Model Analytics: Efficiency metrics, I/O ratios, usage frequency, matrix (fix confirmed with green dots)
- Task Monitor: Source labels, local count (fix confirmed), daily activity — working
- Budget Alerts: Budget bars with status indicators, projection chart, config table — working
- Optimization: Recommendations, cost comparison, subscription value analysis — working
- Settings: API keys (dual-mode note), subscriptions, local sources (Gemini CLI + Cursor shown) — working

### CLI smoke tests completed
- `--quick-sub` / `config --list` / `config --remove` — all working
- Subscription proration calculates correctly for partial months
- Invalid template name shows helpful error with available templates list

## What Still Needs Testing / Debugging

### Real-World Data Testing (highest priority)
The previous session tested with synthetic data only. The tool needs testing with actual data from the user's machine:
- **OpenRouter API with real `OPENROUTER_API_KEY`**: Does `/api/v1/key` return data? Does the summary record appear in the dashboard? Does the `isSummary` flag prevent dedup against CSV per-model records?
- **CSV import**: `node cli.js --csv test-data.csv` — does the existing test CSV work with the new dedup logic?
- **Combined sources**: API + CSV + local logs together — does dedup work correctly? Are costs accurate?

### New Collector Real-World Testing
- **Gemini CLI**: Does `~/.gemini/` exist on the user's machine? The collector was built from documentation, not actual files. Log format may need adjustment.
- **Cursor**: Does the user have Cursor installed? Does `sqlite3` work? Token counts may be 0 (expected).

### User-Reported Bugs
The user is about to test and report bugs. These take priority.

### Edge Cases Not Yet Tested
- Zero data (no sources at all) — should show "No data found" message ✓ (verified in sandbox)
- Subscriptions only (no usage data) — shows subscription costs in KPIs ✓ (verified in sandbox)
- Local logs only (no API keys) — should show estimated costs with warning banner
- Subscription detection banner — shows when OAuth usage detected but no subs configured
- Importing the same CSV twice — should trigger CSV dedup message

### Version Bump
- `VERSION` in cli.js is still `'4.0.0'` — bump to `'4.1.0'` after all bugs are fixed
- `package.json` version is still `"4.0.0"` — update to match

## Known Issues / Out of Scope
These are documented limitations, not bugs:
1. **GitHub Copilot usage API** — requires org admin token. Solution: subscription tracking only.
2. **Google Vertex AI / Cloud Monitoring** — requires GCP service account. Too complex for zero-dep CLI.
3. **Google AI Studio** — no programmatic usage API exists at all.
4. **Cursor token counts** — often 0 per Cursor devs. Collector tracks request volume regardless.
5. **Gemini CLI log format** — built from docs, may need adjustment for real files.

## File Counts
- 26 JS modules total
- ~4,768 lines total
- 0 external dependencies
- Node.js 18+ required

## Git State
```
3403d53 v4.0.0: Multi-file refactor, 7 dashboard views, subscription tracking, new collectors
```
14 files modified since last commit, +473/-104 lines (the 3 bug fixes + prior session work).
Uncommitted changes — commit when ready.

## Files Changed Since Last Commit
```
cli.js
lib/collectors/aider-logs.js
lib/collectors/claude-code-logs.js
lib/collectors/cline-logs.js
lib/collectors/codex-logs.js
lib/collectors/index.js
lib/collectors/openrouter-api.js
lib/collectors/openrouter-csv.js
lib/config.js
lib/dashboard/index.js
lib/dashboard/views/model-analytics.js
lib/dashboard/views/settings.js
lib/dashboard/views/task-monitor.js
lib/dedup.js
```

## Temp Files to Clean Up
These were created during testing and can be deleted:
- `tokenmiser-test-report.html` — synthetic data test dashboard
- `test-dashboard.js` — test data generator script
- `tokenmiser-report.html.bak` may or may not exist (backup of original report)
