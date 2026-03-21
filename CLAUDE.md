# Claude Radar

## Project Overview

Claude Radar is a local-first web dashboard that monitors Claude Code token usage, costs, and ROI across all projects. It reads data from `~/.claude/` and presents it via a browser dashboard. No data leaves the machine.

## Tech Stack

- **Backend:** Node.js, Express, better-sqlite3, WebSocket (ws)
- **Frontend:** Single HTML file, vanilla JS, Chart.js (CDN)
- **Data:** SQLite with incremental indexing of `~/.claude/` JSONL files
- **Protocol:** MCP server via `@modelcontextprotocol/sdk` over stdio
- **No PHP.** User preference — use Node.js for all tooling.

## File Structure

```
bin/claude-radar.js     CLI entry point (shebang)
src/
  cli.js                Commander-based CLI: setup, generate, serve, mcp
  config.js             Reads/writes ~/.claude-radar/config.json
  db.js                 SQLite schema, incremental indexer, query functions, PII redaction, insights engine
  git.js                Git integration: scans repos, correlates commits with session costs
  mcp.js                MCP server with 5 tools (stdio transport)
  parser.js             Legacy JSONL parser (used by generate command)
  pricing.js            Model pricing tables and cost calculation
  server.js             Express server, 20 REST APIs, WebSocket, file watcher, git endpoints
dashboard/
  index.html            Full dashboard: 5 tabs, 15+ charts, 3 themes, Gantt timeline, report generator
```

## Key Conventions

- All source is CommonJS (`require`/`module.exports`), no ESM
- SQLite DB stored at `~/.claude-radar/radar.db` (WAL mode, foreign keys OFF)
- Config at `~/.claude-radar/config.json`
- Dashboard fetches all data from `/api/*` endpoints — no static data.json in serve mode
- Chart instances stored in `charts` object and destroyed before re-render
- Date filtering supported on all API endpoints via `startDate`/`endDate` query params
- PII redaction applied automatically to all message content previews in db.js

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/data` | GET | Main dashboard data (summary, projects, daily, models) |
| `/api/sessions` | GET | Session list with pagination |
| `/api/sessions/:id` | GET | Session detail (messages, tools, subagents) |
| `/api/tools` | GET | Tool usage statistics |
| `/api/subagents` | GET | Subagent list |
| `/api/insights` | GET | AI insights (9 detection rules) |
| `/api/git/summary` | GET | Git-to-cost summary |
| `/api/git/projects` | GET | Git cost by project |
| `/api/git/branches` | GET | Git cost by branch |
| `/api/git/commits` | GET | Commit list with costs |
| `/api/git/timeline` | GET | Daily commit cost timeline |
| `/api/git/expensive` | GET | Most expensive commits |
| `/api/git/reindex` | POST | Re-scan git repos |
| `/api/regenerate` | POST | Re-index all JSONL data |
| `/api/config` | GET/POST | Read/update subscription config |
| `/api/export/json` | GET | Export data as JSON |
| `/api/export/csv` | GET | Export data as CSV |

## Insight Engine Rules

The insights system (`db.js` `getInsights()`) runs 9 detection rules:

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
- IPv4 addresses
- Slack tokens (`xox*-*`)

## Running Locally

```bash
npm install
node bin/claude-radar.js serve
```

Dashboard opens at http://localhost:3400

## Important Notes

- The old `parser.js` overcounts messages (~12%) due to duplicate UUIDs across JSONL files. The SQLite `db.js` deduplicates correctly via `INSERT OR IGNORE` on UUID.
- Git indexing runs `git log` and `git diff --shortstat` on each project directory. It correlates commit timestamps with session time ranges (5-min buffer).
- The `chokidar` package was removed (ESM-only). File watching uses native `fs.watch` with `recursive: true`.
- Pricing is based on published API rates. Users on subscription plans see both actual cost and API equivalent value.
- Report generator creates a self-contained HTML file with all KPIs, project tables, model breakdown, and git cost data.
- Browser notifications require user permission (click bell icon). Notifications fire on WebSocket live update events.
