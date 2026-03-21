# Claude Radar

Monitor and visualize your **Claude Code** token usage, costs, and ROI across all your projects. Track every token, every commit, every dollar.

**Your data never leaves your machine.**

## Quick Start

```bash
npx claude-radar
```

This will:
1. Ask your subscription plan (first run only)
2. Index your `~/.claude/` data into a local SQLite database
3. Scan your project git repos for commit-to-cost mapping
4. Open the dashboard at `http://localhost:3400`

## Features

### Executive Dashboard
- Total cost vs API equivalent value with ROI multiplier
- Token breakdown (input, output, cache read, cache write)
- Messages, sessions, and active days at a glance
- Cache efficiency percentage and savings analysis

### 15+ Interactive Charts
- Daily API value (bar chart)
- Cost by project (doughnut)
- Daily tokens — input vs output (stacked bar)
- Model distribution (doughnut)
- Cache read vs write (stacked bar)
- Messages per day (line)
- Cost per model (horizontal bar)
- Daily tokens by project (stacked bar)
- Project cost ranking (horizontal bar)
- Cumulative API value (area line)
- Git cost by project (horizontal bar)
- Git commit timeline by project (stacked bar)
- Tool usage distribution (doughnut + bar)

### Git-to-Cost Tracking
**Nobody else has this.** Every git commit mapped to its Claude Code session cost:
- Cost per commit, per branch, per line of code
- Most expensive commits ranked
- Project cost breakdown by git activity
- Timeline of commit costs over time
- Branch-level cost aggregation

### Session Browser with Gantt Timeline
- Visual Gantt chart showing sessions as time-range bars, colored by project
- Browse all sessions with project, branch, messages, cost
- Click any session to see full detail:
  - Message timeline with content previews
  - Tool usage breakdown per session
  - Subagent hierarchy with individual costs
  - Token and cost metrics

### Tool & Skill Analytics
- All Claude Code tools ranked by usage (Read, Bash, Edit, Grep, etc.)
- Per-tool session and project counts
- Subagent list with costs and message counts

### AI Insights Engine
10 automated detection rules:
- **Cost spike detection** — days exceeding 3x daily average
- **Cost forecasting** — project current month spend to month-end
- **5-hour billing window** — current window usage, remaining time, windows used today
- **Cache efficiency warnings** — projects with low hit rates
- **Cache optimization tips** — actionable recommendations per project
- **High cache churn** — warns when context is recreated too frequently
- **Usage concentration** — single project dominating spend
- **Model diversity** — suggests cheaper models for simpler tasks
- **Inactive projects** — high-spend projects with no recent activity
- **Cost trend** — warns if cost per message is increasing

### PII Redaction
Automatic detection and redaction in message previews:
- API keys (Anthropic, OpenAI, AWS)
- GitHub/GitLab tokens
- JWTs and private keys
- Email addresses and IP addresses
- Slack tokens

### Real-Time Updates
- WebSocket watches `~/.claude/projects/` for file changes
- Dashboard updates automatically as you code
- Browser notifications on new data (optional, click bell icon to enable)
- Live indicator in header

### Report Generator
- Click "Report" to download a self-contained HTML report
- Includes: KPI summary, project breakdown, model usage, git cost analysis
- Clean, printable format — share with your team or manager

### MCP Server
Let Claude answer questions about your usage directly in conversation:

**Add to** `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "claude-radar": {
      "command": "npx",
      "args": ["claude-radar", "mcp"]
    }
  }
}
```

Then ask Claude:
- "How much have I spent on Claude Code?"
- "Which project uses the most tokens?"
- "What was my usage last week?"
- "Am I getting good value from my Max plan?"

**MCP Tools:**

| Tool | Description |
|------|-------------|
| `get_usage_summary` | Overall usage, costs, ROI |
| `get_project_cost` | Per-project breakdown or ranked list |
| `get_daily_usage` | Daily usage for a date range |
| `get_model_breakdown` | Token/cost split by model |
| `get_billing_estimate` | Subscription value analysis and projections |

### Date Range Filtering
- All views and charts support start/end date filtering
- Filter from the header — applies globally to every tab and export

### Export
- **JSON** — Full data dump with all metrics
- **CSV** — Project breakdown spreadsheet
- **HTML Report** — Shareable formatted report with charts
- All exports respect current date filters

### Themes
- Dark (default)
- Light
- High Contrast

### Web UI Settings
- Change subscription plan from the dashboard
- Regenerate/re-index data without restarting
- No terminal needed after first launch

## Installation

```bash
# Run directly (no install needed)
npx claude-radar

# Or install globally
npm install -g claude-radar
claude-radar serve
```

## Commands

| Command | Description |
|---------|-------------|
| `claude-radar` | Start the dashboard (default) |
| `claude-radar setup` | Configure your subscription plan |
| `claude-radar serve` | Start dashboard server |
| `claude-radar serve -p 8080` | Use a custom port |
| `claude-radar serve --no-open` | Don't auto-open browser |
| `claude-radar generate` | Export data to `data.json` |
| `claude-radar mcp` | Start the MCP server (stdio) |

## How It Works

Claude Code stores detailed usage data locally in `~/.claude/`:

- **Session logs** (`projects/*/session.jsonl`) — Per-message token counts, model, timestamps
- **Stats cache** (`stats-cache.json`) — Aggregated daily activity
- **History** (`history.jsonl`) — Command history with project mapping

Claude Radar:
1. **Indexes** all JSONL files into a local SQLite database (incremental — first run ~5s, subsequent runs instant)
2. **Deduplicates** messages by UUID (other tools overcount by ~12%)
3. **Scans** git repos in your project directories for commit history
4. **Correlates** commit timestamps with session time ranges to calculate cost per commit
5. **Serves** everything via Express with 20 REST API endpoints + WebSocket
6. **Watches** for file changes and updates the dashboard in real-time

## Architecture

```
~/.claude/ (read-only)          Claude Radar
┌─────────────────────┐        ┌──────────────────────────────┐
│ projects/            │──────▶│ SQLite Indexer (incremental)  │
│   *.jsonl            │       │ Git Scanner (commit mapping)  │
│ stats-cache.json     │       │ Express Server (20 APIs)      │
│ history.jsonl        │       │ WebSocket (live updates)      │
└─────────────────────┘       │ MCP Server (5 tools, stdio)   │
                               └──────────┬───────────────────┘
Your project repos                        │
┌─────────────────────┐                   ▼
│ .git/ (commit logs)  │──────▶ Dashboard (localhost:3400)
└─────────────────────┘        5 tabs, 15+ charts, 3 themes
```

## Subscription Plans

| Plan | Monthly Cost |
|------|-------------|
| Pro | $20/month |
| Max | $100/month |
| Max | $200/month |
| Team | Custom rate |

The dashboard shows **actual subscription cost** alongside **API equivalent value**. For example, a Max $100/month user might see $5,000+ in API equivalent value — a 50x ROI.

## Configuration

Config is stored in `~/.claude-radar/config.json`:

```json
{
  "plan": "max_100",
  "monthlyRate": 100,
  "claudeDir": "/Users/you/.claude"
}
```

SQLite database at `~/.claude-radar/radar.db`. Run `claude-radar setup` to reconfigure, or use the Settings button in the dashboard.

## Requirements

- Node.js 18+
- Claude Code installed (with usage data in `~/.claude/`)
- Git (for git-to-cost tracking)

## License

MIT
