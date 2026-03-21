/**
 * MCP Server for Claude Radar.
 * Exposes Claude Code usage data as tools that Claude can query.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { parseAllData, getProjectSummary, getDailyRange } = require('./parser');
const { loadConfig } = require('./config');

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function fmtCost(n) {
  return '$' + n.toFixed(2);
}

async function startMcpServer() {
  const server = new McpServer({
    name: 'claude-radar',
    version: '1.0.0',
  });

  const config = loadConfig();

  // Tool 1: Overall usage summary
  server.tool(
    'get_usage_summary',
    'Get overall Claude Code usage summary including total tokens, costs, ROI, and subscription info',
    {},
    async () => {
      const data = await parseAllData(config);
      const s = data.summary;
      const sub = data.subscription;
      const roi = sub.actualCost > 0 ? (s.apiEquivalentCost / sub.actualCost).toFixed(1) : 'N/A';

      const text = [
        `## Claude Code Usage Summary`,
        ``,
        `**Subscription:** ${sub.plan} plan (${fmtCost(sub.monthlyRate)}/mo, ${sub.monthsActive} months)`,
        `**Actual Cost:** ${fmtCost(sub.actualCost)}`,
        `**API Equivalent Value:** ${fmtCost(s.apiEquivalentCost)}`,
        `**ROI:** ${roi}x`,
        ``,
        `**Total Messages:** ${s.totalMessages.toLocaleString()}`,
        `**Total Projects:** ${s.totalProjects}`,
        `**Active Days:** ${data.dailyUsage.length}`,
        ``,
        `### Token Breakdown`,
        `- Input: ${fmtTokens(s.totalInputTokens)}`,
        `- Output: ${fmtTokens(s.totalOutputTokens)}`,
        `- Cache Read: ${fmtTokens(s.totalCacheRead)}`,
        `- Cache Write: ${fmtTokens(s.totalCacheWrite)}`,
        `- **Total: ${fmtTokens(s.totalTokens)}**`,
        ``,
        `Since: ${s.firstSessionDate ? new Date(s.firstSessionDate).toLocaleDateString() : 'Unknown'}`,
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
      const data = await parseAllData(config);

      if (projectName) {
        const search = projectName.toLowerCase();
        const project = data.projects.find(p =>
          p.name.toLowerCase().includes(search) ||
          p.path.toLowerCase().includes(search)
        );

        if (!project) {
          const names = data.projects.map(p => p.name).join(', ');
          return { content: [{ type: 'text', text: `Project "${projectName}" not found. Available: ${names}` }] };
        }

        const text = [
          `## ${project.name}`,
          `**Path:** ${project.path}`,
          `**API Value:** ${fmtCost(project.totalCost)}`,
          `**Messages:** ${project.totalMessages.toLocaleString()}`,
          `**Sessions:** ${project.sessionCount}`,
          ``,
          `### Tokens`,
          `- Input: ${fmtTokens(project.totalInputTokens)}`,
          `- Output: ${fmtTokens(project.totalOutputTokens)}`,
          `- Cache Read: ${fmtTokens(project.totalCacheRead)}`,
          `- Cache Write: ${fmtTokens(project.totalCacheWrite)}`,
          ``,
          `### Models Used`,
          ...Object.entries(project.models)
            .filter(([k]) => k !== '<synthetic>')
            .map(([name, m]) => `- ${name}: ${m.messages} msgs, ${fmtCost(m.cost)}`),
          ``,
          `**Active:** ${project.firstActivity ? new Date(project.firstActivity).toLocaleDateString() : '?'} — ${project.lastActivity ? new Date(project.lastActivity).toLocaleDateString() : '?'}`,
        ].join('\n');

        return { content: [{ type: 'text', text }] };
      }

      // All projects
      const lines = data.projects.map((p, i) => {
        const pct = data.summary.apiEquivalentCost > 0
          ? ((p.totalCost / data.summary.apiEquivalentCost) * 100).toFixed(1) : 0;
        return `${i + 1}. **${p.name}** — ${fmtCost(p.totalCost)} (${pct}%) | ${p.totalMessages} msgs | ${p.sessionCount} sessions`;
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

      const daily = await getDailyRange(config, startDate, endDate);

      if (daily.length === 0) {
        return { content: [{ type: 'text', text: `No usage data found between ${startDate} and ${endDate}` }] };
      }

      const totalCost = daily.reduce((s, d) => s + d.cost, 0);
      const totalMsgs = daily.reduce((s, d) => s + d.messages, 0);

      const lines = daily.map(d =>
        `| ${d.date} | ${d.messages} | ${fmtTokens(d.inputTokens + d.outputTokens)} | ${fmtCost(d.cost)} |`
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
      const data = await parseAllData(config);

      let models;
      let scope = 'All Projects';

      if (projectName) {
        const search = projectName.toLowerCase();
        const project = data.projects.find(p =>
          p.name.toLowerCase().includes(search) ||
          p.path.toLowerCase().includes(search)
        );
        if (!project) {
          return { content: [{ type: 'text', text: `Project "${projectName}" not found.` }] };
        }
        models = project.models;
        scope = project.name;
      } else {
        models = data.modelUsage;
      }

      const entries = Object.entries(models)
        .filter(([k]) => k !== '<synthetic>')
        .sort(([, a], [, b]) => b.cost - a.cost);

      const lines = entries.map(([name, m]) => {
        const totalModelTokens = m.inputTokens + m.outputTokens + m.cacheRead + m.cacheWrite;
        return [
          `### ${name}`,
          `- Messages: ${m.messages.toLocaleString()}`,
          `- API Value: ${fmtCost(m.cost)}`,
          `- Input: ${fmtTokens(m.inputTokens)} | Output: ${fmtTokens(m.outputTokens)}`,
          `- Cache Read: ${fmtTokens(m.cacheRead)} | Cache Write: ${fmtTokens(m.cacheWrite)}`,
          `- Total Tokens: ${fmtTokens(totalModelTokens)}`,
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
      const data = await parseAllData(config);
      const s = data.summary;
      const sub = data.subscription;
      const roi = sub.actualCost > 0 ? (s.apiEquivalentCost / sub.actualCost) : 0;

      // Current month usage
      const now = new Date();
      const currentMonth = now.toISOString().slice(0, 7);
      const thisMonthDays = data.dailyUsage.filter(d => d.date.startsWith(currentMonth));
      const thisMonthCost = thisMonthDays.reduce((s, d) => s + d.cost, 0);
      const thisMonthMsgs = thisMonthDays.reduce((s, d) => s + d.messages, 0);

      // Projection
      const dayOfMonth = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const projectedMonthCost = thisMonthDays.length > 0
        ? (thisMonthCost / dayOfMonth) * daysInMonth
        : 0;

      // Average daily
      const avgDailyCost = data.dailyUsage.length > 0
        ? s.apiEquivalentCost / data.dailyUsage.length
        : 0;

      const text = [
        `## Billing & Value Analysis`,
        ``,
        `**Plan:** ${sub.plan} (${fmtCost(sub.monthlyRate)}/month)`,
        `**Duration:** ${sub.monthsActive} month(s)`,
        `**Total Paid:** ${fmtCost(sub.actualCost)}`,
        `**API Equivalent Value:** ${fmtCost(s.apiEquivalentCost)}`,
        `**ROI:** ${roi.toFixed(1)}x — you got ${fmtCost(s.apiEquivalentCost - sub.actualCost)} more value than you paid`,
        ``,
        `### This Month (${currentMonth})`,
        `- API Value So Far: ${fmtCost(thisMonthCost)}`,
        `- Messages: ${thisMonthMsgs}`,
        `- Projected Month Total: ~${fmtCost(projectedMonthCost)} API value`,
        `- Active Days: ${thisMonthDays.length}`,
        ``,
        `### Averages`,
        `- Per Active Day: ${fmtCost(avgDailyCost)} API value`,
        `- Per Message: ${fmtCost(s.totalMessages > 0 ? s.apiEquivalentCost / s.totalMessages : 0)}`,
        `- Per Project: ${fmtCost(s.totalProjects > 0 ? s.apiEquivalentCost / s.totalProjects : 0)}`,
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    }
  );

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

module.exports = { startMcpServer };
