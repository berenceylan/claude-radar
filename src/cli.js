/**
 * Claude Radar CLI - Monitor your Claude Code usage.
 */

const { program } = require('commander');
const path = require('path');
const fs = require('fs');
const pkg = require('../package.json');

program
  .name('claude-radar')
  .description('Monitor and visualize your Claude Code token usage')
  .version(pkg.version);

program
  .command('setup')
  .description('Configure your subscription plan')
  .action(async () => {
    const { interactiveSetup } = require('./config');
    await interactiveSetup();
  });

program
  .command('generate')
  .description('Parse Claude data and generate data.json')
  .option('-o, --output <path>', 'Output file path', path.join(process.cwd(), 'data.json'))
  .action(async (opts) => {
    const { loadConfig, configExists } = require('./config');
    const { parseAllData } = require('./parser');

    if (!configExists()) {
      console.log('  No config found. Running setup first...\n');
      const { interactiveSetup } = require('./config');
      await interactiveSetup();
    }

    const config = loadConfig();
    console.log('  Parsing Claude Code data...');
    const data = await parseAllData(config);

    fs.writeFileSync(opts.output, JSON.stringify(data, null, 2));
    console.log(`\n  Done! ${data.summary.totalProjects} projects, ${data.summary.totalMessages} messages`);
    console.log(`  API equivalent: $${data.summary.apiEquivalentCost.toFixed(2)}`);
    console.log(`  Actual cost: $${data.subscription.actualCost} (${data.subscription.plan} plan)`);
    console.log(`  Output: ${opts.output}\n`);
  });

program
  .command('serve')
  .description('Start the dashboard web server')
  .option('-p, --port <number>', 'Port number', '3400')
  .option('--no-open', 'Do not open browser automatically')
  .action(async (opts) => {
    const { configExists } = require('./config');

    if (!configExists()) {
      console.log('  No config found. Running setup first...\n');
      const { interactiveSetup } = require('./config');
      await interactiveSetup();
    }

    const { startServer } = require('./server');
    startServer({ port: parseInt(opts.port, 10), noOpen: !opts.open });
  });

program
  .command('mcp')
  .description('Start the MCP server for Claude Code integration')
  .action(async () => {
    const { startMcpServer } = require('./mcp');
    await startMcpServer();
  });

program
  .command('stats')
  .description('Print usage summary to terminal (no browser)')
  .option('--json', 'Output raw JSON instead of formatted text')
  .action(async (opts) => {
    const { loadConfig, configExists } = require('./config');
    const { SUBSCRIPTION_PLANS } = require('./pricing');
    const db = require('./db');

    if (!configExists()) {
      console.log('  No config found. Running setup first...\n');
      const { interactiveSetup } = require('./config');
      await interactiveSetup();
    }

    try {
      db.openDb();
      await db.indexAll((msg) => {
        if (!opts.json) process.stdout.write(`\r  ${msg}`);
      });
      if (!opts.json) process.stdout.write('\r' + ' '.repeat(60) + '\r');

      const summary = db.getSummary();
      const projects = db.getProjects();
      const config = loadConfig();

      if (opts.json) {
        const output = {
          summary,
          topProjects: projects.slice(0, 5),
          budget: config.monthlyBudget
            ? { limit: config.monthlyBudget, used: summary.api_equivalent_cost }
            : null,
        };
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      // Format helpers
      const fmtNum = (n) => {
        if (n == null || isNaN(n)) return '0';
        if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        return n.toLocaleString();
      };
      const fmtMoney = (n) => '$' + (n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      const pad = (label, width) => label + ' '.repeat(Math.max(0, width - label.length));

      const planInfo = SUBSCRIPTION_PLANS[summary.subscription.plan] || { name: summary.subscription.plan };
      const planLabel = `${planInfo.name} ($${summary.subscription.monthlyRate}/mo` +
        (summary.subscription.monthsActive > 1 ? ` x ${summary.subscription.monthsActive} months)` : ')');
      const actualCost = summary.subscription.actualCost;
      const apiValue = summary.api_equivalent_cost;
      const roi = actualCost > 0 ? (apiValue / actualCost).toFixed(1) + 'x' : 'N/A';

      const totalTokens = summary.total_tokens || 0;
      const cacheRead = summary.total_cache_read || 0;
      const cacheTotal = (summary.total_input_tokens || 0) + cacheRead;
      const cacheHit = cacheTotal > 0 ? ((cacheRead / cacheTotal) * 100).toFixed(1) + '%' : 'N/A';

      const topProjects = projects.slice(0, 5);

      const sep = '\u2550'.repeat(39);
      console.log('');
      console.log('Claude Radar \u2014 Usage Summary');
      console.log(sep);
      console.log('');
      console.log(`  Plan:           ${planLabel}`);
      console.log(`  You Paid:       ${fmtMoney(actualCost)}`);
      console.log(`  API Value:      ${fmtMoney(apiValue)}`);
      console.log(`  ROI:            ${roi}`);
      console.log('');
      console.log(`  Total Tokens:   ${fmtNum(totalTokens)}`);
      console.log(`  Messages:       ${fmtNum(summary.total_messages || 0)}`);
      console.log(`  Sessions:       ${fmtNum(summary.total_sessions || 0)}`);
      console.log(`  Projects:       ${summary.total_projects || 0}`);
      console.log(`  Cache Hit:      ${cacheHit}`);

      if (topProjects.length > 0) {
        console.log('');
        console.log('  Top Projects:');
        const nameWidth = Math.max(...topProjects.map(p => p.name.length), 10);
        for (const p of topProjects) {
          const cost = fmtMoney(p.total_cost || 0).padStart(10);
          const msgs = fmtNum(p.total_messages || 0).padStart(8) + ' msgs';
          console.log(`    ${pad(p.name, nameWidth)}  ${cost}  ${msgs}`);
        }
      }

      console.log('');
      if (config.monthlyBudget) {
        const used = apiValue;
        const pct = ((used / config.monthlyBudget) * 100).toFixed(1);
        console.log(`  Budget:         ${fmtMoney(used)} / ${fmtMoney(config.monthlyBudget)} (${pct}%)`);
      } else {
        console.log('  Budget:         not configured');
      }

      console.log('');
      console.log(sep);
      console.log('');
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      process.exit(1);
    }
  });

// Default command: serve
program
  .action(async () => {
    const { configExists } = require('./config');

    if (!configExists()) {
      console.log('  No config found. Running setup first...\n');
      const { interactiveSetup } = require('./config');
      await interactiveSetup();
    }

    const { startServer } = require('./server');
    startServer({ port: 3400 });
  });

program.parse();
