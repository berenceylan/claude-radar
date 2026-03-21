# Claude Radar

Monitor and visualize your **Claude Code** token usage, costs, and ROI across all your projects.

See exactly how your subscription stacks up against API pricing, which projects consume the most tokens, and track your usage over time — all from a beautiful local dashboard.

![Dashboard Preview](https://img.shields.io/badge/status-beta-blue)

## Features

- **Executive Dashboard** — Total cost, tokens, messages, cache efficiency, ROI at a glance
- **Per-Project Breakdown** — See which projects consume the most, with sortable tables
- **Model Analytics** — Usage split across Opus, Sonnet, Haiku
- **Daily Trends** — Cost and token usage over time with interactive charts
- **Cache Insights** — Cache read/write efficiency and savings analysis
- **Subscription ROI** — Compare actual plan cost vs API equivalent value
- **MCP Server** — Let Claude answer questions about your usage inline
- **Zero Cloud** — All data stays local. Nothing is uploaded anywhere.

## Quick Start

```bash
npx claude-radar
```

This will:
1. Ask you to select your subscription plan (first run only)
2. Parse your local `~/.claude/` data
3. Open a dashboard at `http://localhost:3400`

## Installation

```bash
npm install -g claude-radar
```

## Commands

| Command | Description |
|---------|-------------|
| `claude-radar` | Start the dashboard (default) |
| `claude-radar setup` | Configure your subscription plan |
| `claude-radar serve` | Start dashboard server |
| `claude-radar serve -p 8080` | Use a custom port |
| `claude-radar generate` | Export data to `data.json` |
| `claude-radar mcp` | Start the MCP server |

## MCP Server Integration

Add Claude Radar as an MCP server so Claude can answer questions about your usage directly:

**In your Claude Code settings** (`~/.claude/settings.json`):

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

Then ask Claude things like:
- "How much have I spent on Claude Code?"
- "Which project uses the most tokens?"
- "What was my usage last week?"
- "Am I getting good value from my Max plan?"

### MCP Tools

| Tool | Description |
|------|-------------|
| `get_usage_summary` | Overall usage, costs, ROI |
| `get_project_cost` | Per-project breakdown or ranked list |
| `get_daily_usage` | Daily usage for a date range |
| `get_model_breakdown` | Token/cost split by model |
| `get_billing_estimate` | Subscription value analysis and projections |

## How It Works

Claude Code stores detailed usage data locally in `~/.claude/`:

- **Session logs** (`projects/*/session.jsonl`) — Per-message token counts, model used, timestamps
- **Stats cache** (`stats-cache.json`) — Aggregated daily activity
- **History** (`history.jsonl`) — Command history with project mapping

Claude Radar reads these files, calculates API-equivalent costs using published model pricing, and presents everything in an interactive dashboard.

**Your data never leaves your machine.**

## Subscription Plans

Claude Radar supports all Claude plans:

| Plan | Monthly Cost |
|------|-------------|
| Pro | $20/month |
| Max | $100/month |
| Max | $200/month |
| Team | Custom rate |

The dashboard shows your **actual subscription cost** alongside the **API equivalent value** of your token usage, so you can see your ROI.

## Configuration

Config is stored in `~/.claude-radar/config.json`:

```json
{
  "plan": "max_100",
  "monthlyRate": 100,
  "claudeDir": "/Users/you/.claude"
}
```

Run `claude-radar setup` to reconfigure interactively.

## Requirements

- Node.js 18+
- Claude Code installed (with usage data in `~/.claude/`)

## License

MIT
