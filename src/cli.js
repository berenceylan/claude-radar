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
