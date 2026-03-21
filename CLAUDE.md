# Claude Radar

## Project Overview

Claude Radar is a local-first web dashboard that monitors Claude Code token usage, costs, and ROI across all projects. It reads data from `~/.claude/` and presents it via a browser dashboard. No data leaves the machine.

**npm:** `npx claude-radar` | **Version:** 2.0.0 | **License:** MIT

## Tech Stack

- **Backend:** Node.js, Express, better-sqlite3, WebSocket (ws)
- **Frontend:** Single HTML file, vanilla JS, Chart.js (CDN with SRI)
- **Data:** SQLite with incremental indexing of `~/.claude/` JSONL files
- **Protocol:** MCP server via `@modelcontextprotocol/sdk` over stdio
- **Testing:** Jest (86 tests, 72% line coverage)
- **No PHP.** User preference — use Node.js for all tooling.

## File Structure

```
bin/claude-radar.js     CLI entry point (shebang)
src/
  cli.js                Commander-based CLI: setup, generate, serve, mcp
  config.js             Reads/writes ~/.claude-radar/config.json
  db.js                 SQLite schema, incremental indexer, query functions, PII redaction, insights engine
  git.js                Git integration: scans repos, correlates commits with session costs (uses execFileSync)
  mcp.js                MCP server with 5 tools (stdio transport, uses db.js)
  parser.js             Legacy JSONL parser (used by generate command only)
  pricing.js            Model pricing tables and cost calculation
  server.js             Express server, 20 REST APIs, WebSocket, file watcher, git endpoints
dashboard/
  index.html            Full dashboard: 5 tabs, 15+ charts, 3 themes, Gantt timeline, report generator
tests/
  helpers.js            Shared test utilities (isolated temp environments, mock config)
  pricing.test.js       100% coverage
  parser.test.js        96% coverage
  db.test.js            92% coverage
  server.test.js        76% coverage — all 20 endpoints + security
  git.test.js           56% coverage
  config.test.js        29% coverage
  mcp.test.js           Protocol init + underlying queries
jest.config.js          Test configuration
```

## Key Conventions

- All source is CommonJS (`require`/`module.exports`), no ESM
- SQLite DB stored at `~/.claude-radar/radar.db` (WAL mode, foreign keys OFF)
- Config at `~/.claude-radar/config.json`
- Dashboard fetches all data from `/api/*` endpoints — no static data.json in serve mode
- Chart instances stored in `charts` object and destroyed before re-render
- Date filtering supported on all API endpoints via `startDate`/`endDate` query params
- PII redaction applied automatically to all message content previews in db.js
- All dynamic HTML content escaped via `escHtml()`/`escAttr()` helpers

## Security

- Server binds to `127.0.0.1` only (not accessible from LAN)
- Origin checking on all HTTP requests and WebSocket connections (localhost only)
- Security headers: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`
- Chart.js loaded with SRI integrity hash
- All API `limit` parameters capped at 1000
- Git commands use `execFileSync` (array args, no shell injection)
- All SQLite queries use parameterized `?` placeholders
- All HTML output escaped — no raw interpolation of user data
- PII auto-redacted in message previews (API keys, emails, IPs, tokens, JWTs)
- `npm audit`: 0 vulnerabilities in dependency tree

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/data` | GET | Main dashboard data (summary, projects, daily, models) |
| `/api/sessions` | GET | Session list with pagination |
| `/api/sessions/:id` | GET | Session detail (messages, tools, subagents) |
| `/api/tools` | GET | Tool usage statistics |
| `/api/subagents` | GET | Subagent list |
| `/api/insights` | GET | AI insights (10 detection rules) |
| `/api/git/summary` | GET | Git-to-cost summary |
| `/api/git/projects` | GET | Git cost by project |
| `/api/git/branches` | GET | Git cost by branch |
| `/api/git/commits` | GET | Commit list with costs |
| `/api/git/timeline` | GET | Daily commit cost timeline |
| `/api/git/expensive` | GET | Most expensive commits |
| `/api/git/reindex` | POST | Re-scan git repos |
| `/api/regenerate` | POST | Clear DB and re-index all data + git |
| `/api/config` | GET/POST | Read/update subscription config |
| `/api/export/json` | GET | Export data as JSON |
| `/api/export/csv` | GET | Export data as CSV |

## Insight Engine Rules

The insights system (`db.js` `getInsights()`) runs 10 detection rules:

1. **Cost spike detection** — days with cost > 3x daily average
2. **Low cache efficiency** — projects with < 50% cache hit rate
3. **Usage concentration** — single project > 50% of total spend
4. **Model diversity** — warns if only one model is being used
5. **Inactive projects** — projects with > $10 spend but no activity in 30 days
6. **Cost forecasting** — projects current month to month-end based on daily average
7. **Cache optimization** — actionable tips for projects with improvable hit rates
8. **High cache churn** — warns when context is being recreated too frequently
9. **5-hour billing window** — tracks current window usage, remaining time, windows used today
10. **Cost trend** — warns if cost per message is increasing vs recent history

## PII Redaction

Applied in `db.js` `getContentPreview()` before storing message previews. Patterns detected:

- Anthropic API keys (`sk-ant-*`)
- OpenAI API keys (`sk-*`)
- AWS access keys (`AKIA*`)
- GitHub tokens (`ghp_*`, `gho_*`)
- GitLab tokens (`glpat-*`)
- JWTs (`eyJ*.*.*`)
- Private key headers (`-----BEGIN * PRIVATE KEY-----`)
- Email addresses
- Valid IPv4 addresses (0.0.0.0–255.255.255.255, won't match version numbers)
- Slack tokens (`xox*-*`)

## Running Locally

```bash
npm install
node bin/claude-radar.js serve
```

Dashboard opens at http://localhost:3400

## Running Tests

```bash
npm test              # Run all 86 tests with coverage
npx jest --watch      # Watch mode for development
```

## Important Notes

- The old `parser.js` overcounts messages (~12%) due to duplicate UUIDs across JSONL files. The SQLite `db.js` deduplicates correctly via `INSERT OR IGNORE` on UUID.
- MCP server uses `db.js` (not `parser.js`) for consistent results with the dashboard.
- Git indexing uses `execFileSync` (not `execSync`) to prevent shell injection. It reads session costs from the messages table (not the sessions table which can accumulate).
- `POST /api/regenerate` clears the entire DB before re-indexing (`reindexAll`), preventing session cost accumulation.
- The `chokidar` package was removed (ESM-only). File watching uses native `fs.watch` with `recursive: true` (macOS/Windows only).
- Pricing is based on published API rates. Users on subscription plans see both actual cost and API equivalent value.
- Report generator creates a self-contained HTML file with all KPIs, project tables, model breakdown, and git cost data.
- Browser notifications require user permission (click bell icon). Notifications fire on WebSocket live update events.
