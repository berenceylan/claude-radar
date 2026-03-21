/**
 * MCP Server for Claude Radar.
 * Exposes Claude Code usage data as tools that Claude can query.
 * Uses the SQLite database (db.js) for consistent, fast queries.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const db = require('./db');
const git = require('./git');

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtCost(n) {
  return '$' + (n || 0).toFixed(2);
}

async function startMcpServer() {
  // Index data on startup
  await db.indexAll();
  try { git.indexGitData(); } catch {}

  const server = new McpServer({
    name: 'claude-radar',
    version: '1.0.0',
  });

  // Tool 1: Overall usage summary
  server.tool(
    'get_usage_summary',
    'Get overall Claude Code usage summary including total tokens, costs, ROI, and subscription info',
    {},
    async () => {
      const s = db.getSummary();
      const sub = s.subscription;
      const roi = sub.actualCost > 0 ? (s.api_equivalent_cost / sub.actualCost).toFixed(1) : 'N/A';
      const daily = db.getDailyUsage();

      const text = [
        `## Claude Code Usage Summary`,
        ``,
        `**Subscription:** ${sub.plan} plan (${fmtCost(sub.monthlyRate)}/mo, ${sub.monthsActive} months)`,
        `**Actual Cost:** ${fmtCost(sub.actualCost)}`,
        `**API Equivalent Value:** ${fmtCost(s.api_equivalent_cost)}`,
        `**ROI:** ${roi}x`,
        ``,
        `**Total Messages:** ${(s.total_messages || 0).toLocaleString()}`,
        `**Total Projects:** ${s.total_projects}`,
        `**Total Sessions:** ${s.total_sessions}`,
        `**Active Days:** ${daily.length}`,
        ``,
        `### Token Breakdown`,
        `- Input: ${fmtTokens(s.total_input_tokens)}`,
        `- Output: ${fmtTokens(s.total_output_tokens)}`,
        `- Cache Read: ${fmtTokens(s.total_cache_read)}`,
        `- Cache Write: ${fmtTokens(s.total_cache_write)}`,
        `- **Total: ${fmtTokens(s.total_tokens)}**`,
        ``,
        `Since: ${s.first_activity ? new Date(s.first_activity).toLocaleDateString() : 'Unknown'}`,
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    }
  );

  // Tool 2: Project costs
  server.tool(
    'get_project_cost',
    'Get cost and usage data for a specific project, or list all projects ranked by cost',
    {
      projectName: z.string().optional().describe('Project name to search for. Omit to list all projects ranked by API value.'),
    },
    async ({ projectName }) => {
      const projects = db.getProjects();

      if (projectName) {
        const search = projectName.toLowerCase();
        const project = projects.find(p =>
          p.name.toLowerCase().includes(search) ||
          p.full_path.toLowerCase().includes(search)
        );

        if (!project) {
          const names = projects.map(p => p.name).join(', ');
          return { content: [{ type: 'text', text: `Project "${projectName}" not found. Available: ${names}` }] };
        }

        const models = db.getModelUsage({ projectId: project.id });
        const text = [
          `## ${project.name}`,
          `**Path:** ${project.full_path}`,
          `**API Value:** ${fmtCost(project.total_cost)}`,
          `**Messages:** ${(project.total_messages || 0).toLocaleString()}`,
          `**Sessions:** ${project.session_count}`,
          ``,
          `### Tokens`,
          `- Input: ${fmtTokens(project.total_input_tokens)}`,
          `- Output: ${fmtTokens(project.total_output_tokens)}`,
          `- Cache Read: ${fmtTokens(project.total_cache_read)}`,
          `- Cache Write: ${fmtTokens(project.total_cache_write)}`,
          ``,
          `### Models Used`,
          ...models.map(m => `- ${m.model}: ${m.messages} msgs, ${fmtCost(m.cost)}`),
          ``,
          `**Active:** ${project.first_activity ? new Date(project.first_activity).toLocaleDateString() : '?'} — ${project.last_activity ? new Date(project.last_activity).toLocaleDateString() : '?'}`,
        ].join('\n');

        return { content: [{ type: 'text', text }] };
      }

      // All projects
      const s = db.getSummary();
      const lines = projects.map((p, i) => {
        const pct = s.api_equivalent_cost > 0
          ? ((p.total_cost / s.api_equivalent_cost) * 100).toFixed(1) : 0;
        return `${i + 1}. **${p.name}** — ${fmtCost(p.total_cost)} (${pct}%) | ${p.total_messages} msgs | ${p.session_count} sessions`;
      });

      const text = [`## All Projects (by API Value)\n`, ...lines].join('\n');
      return { content: [{ type: 'text', text }] };
    }
  );

  // Tool 3: Daily usage
  server.tool(
    'get_daily_usage',
    'Get daily usage data for a date range',
    {
      startDate: z.string().optional().describe('Start date (YYYY-MM-DD). Defaults to 30 days ago.'),
      endDate: z.string().optional().describe('End date (YYYY-MM-DD). Defaults to today.'),
    },
    async ({ startDate, endDate }) => {
      if (!startDate) {
        const d = new Date();
        d.setDate(d.getDate() - 30);
        startDate = d.toISOString().split('T')[0];
      }
      if (!endDate) {
        endDate = new Date().toISOString().split('T')[0];
      }

      const daily = db.getDailyUsage({ startDate, endDate });

      if (daily.length === 0) {
        return { content: [{ type: 'text', text: `No usage data found between ${startDate} and ${endDate}` }] };
      }

      const totalCost = daily.reduce((s, d) => s + (d.cost || 0), 0);
      const totalMsgs = daily.reduce((s, d) => s + (d.messages || 0), 0);

      const lines = daily.map(d =>
        `| ${d.date} | ${d.messages} | ${fmtTokens((d.input_tokens || 0) + (d.output_tokens || 0))} | ${fmtCost(d.cost)} |`
      );

      const text = [
        `## Daily Usage: ${startDate} to ${endDate}`,
        `**Total:** ${fmtCost(totalCost)} API value, ${totalMsgs} messages, ${daily.length} active days`,
        ``,
        `| Date | Messages | Tokens | API Value |`,
        `|------|----------|--------|-----------|`,
        ...lines,
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    }
  );

  // Tool 4: Model breakdown
  server.tool(
    'get_model_breakdown',
    'Get per-model token and cost breakdown',
    {
      projectName: z.string().optional().describe('Filter by project name. Omit for global breakdown.'),
    },
    async ({ projectName }) => {
      let models;
      let scope = 'All Projects';

      if (projectName) {
        const projects = db.getProjects();
        const search = projectName.toLowerCase();
        const project = projects.find(p =>
          p.name.toLowerCase().includes(search) ||
          p.full_path.toLowerCase().includes(search)
        );
        if (!project) {
          return { content: [{ type: 'text', text: `Project "${projectName}" not found.` }] };
        }
        models = db.getModelUsage({ projectId: project.id });
        scope = project.name;
      } else {
        models = db.getModelUsage();
      }

      const entries = models.filter(m => m.model !== '<synthetic>');

      const lines = entries.map(m => {
        const totalTokens = (m.input_tokens || 0) + (m.output_tokens || 0) + (m.cache_read || 0) + (m.cache_write || 0);
        return [
          `### ${m.model}`,
          `- Messages: ${(m.messages || 0).toLocaleString()}`,
          `- API Value: ${fmtCost(m.cost)}`,
          `- Input: ${fmtTokens(m.input_tokens)} | Output: ${fmtTokens(m.output_tokens)}`,
          `- Cache Read: ${fmtTokens(m.cache_read)} | Cache Write: ${fmtTokens(m.cache_write)}`,
          `- Total Tokens: ${fmtTokens(totalTokens)}`,
          ``,
        ].join('\n');
      });

      const text = [`## Model Breakdown — ${scope}\n`, ...lines].join('\n');
      return { content: [{ type: 'text', text }] };
    }
  );

  // Tool 5: Billing estimate
  server.tool(
    'get_billing_estimate',
    'Get subscription value analysis: actual cost vs API equivalent, ROI, and projected usage',
    {},
    async () => {
      const s = db.getSummary();
      const sub = s.subscription;
      const roi = sub.actualCost > 0 ? (s.api_equivalent_cost / sub.actualCost) : 0;
      const daily = db.getDailyUsage();

      const now = new Date();
      const currentMonth = now.toISOString().slice(0, 7);
      const thisMonthDays = daily.filter(d => d.date.startsWith(currentMonth));
      const thisMonthCost = thisMonthDays.reduce((sum, d) => sum + (d.cost || 0), 0);
      const thisMonthMsgs = thisMonthDays.reduce((sum, d) => sum + (d.messages || 0), 0);

      const dayOfMonth = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const projectedMonthCost = thisMonthDays.length > 0
        ? (thisMonthCost / dayOfMonth) * daysInMonth : 0;

      const avgDailyCost = daily.length > 0 ? s.api_equivalent_cost / daily.length : 0;

      // Git stats
      let gitLine = '';
      try {
        const gs = git.getGitSummary();
        if (gs.totalCommits > 0) {
          gitLine = `\n### Git Cost Analysis\n- Total Commits: ${gs.totalCommits}\n- Avg Cost/Commit: ${fmtCost(gs.avgCostPerCommit)}\n- Cost/Line of Code: ${fmtCost(gs.costPerLine)}`;
        }
      } catch {}

      const text = [
        `## Billing & Value Analysis`,
        ``,
        `**Plan:** ${sub.plan} (${fmtCost(sub.monthlyRate)}/month)`,
        `**Duration:** ${sub.monthsActive} month(s)`,
        `**Total Paid:** ${fmtCost(sub.actualCost)}`,
        `**API Equivalent Value:** ${fmtCost(s.api_equivalent_cost)}`,
        `**ROI:** ${roi.toFixed(1)}x — you got ${fmtCost(s.api_equivalent_cost - sub.actualCost)} more value than you paid`,
        ``,
        `### This Month (${currentMonth})`,
        `- API Value So Far: ${fmtCost(thisMonthCost)}`,
        `- Messages: ${thisMonthMsgs}`,
        `- Projected Month Total: ~${fmtCost(projectedMonthCost)} API value`,
        `- Active Days: ${thisMonthDays.length}`,
        ``,
        `### Averages`,
        `- Per Active Day: ${fmtCost(avgDailyCost)} API value`,
        `- Per Message: ${fmtCost(s.total_messages > 0 ? s.api_equivalent_cost / s.total_messages : 0)}`,
        `- Per Project: ${fmtCost(s.total_projects > 0 ? s.api_equivalent_cost / s.total_projects : 0)}`,
        gitLine,
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    }
  );

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

module.exports = { startMcpServer };
