/**
 * Configuration management for Claude Radar.
 * Stores config in ~/.claude-radar/config.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { SUBSCRIPTION_PLANS } = require('./pricing');

const CONFIG_DIR = process.env.CLAUDE_RADAR_CONFIG_DIR || path.join(os.homedir(), '.claude-radar');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const DEFAULT_CONFIG = {
  plan: 'max_100',
  monthlyRate: 100,
  monthlyBudget: null,
  claudeDir: CLAUDE_DIR,
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function configExists() {
  return fs.existsSync(CONFIG_FILE);
}

async function interactiveSetup() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  console.log('\n  Claude Radar Setup\n');
  console.log('  Select your Claude subscription plan:\n');
  console.log('  1) Pro       - $20/month');
  console.log('  2) Max       - $100/month');
  console.log('  3) Max       - $200/month');
  console.log('  4) Team      - Enter custom rate');
  console.log('');

  const choice = await ask('  Your choice (1-4): ');

  let plan, monthlyRate;
  switch (choice.trim()) {
    case '1':
      plan = 'pro_20';
      monthlyRate = 20;
      break;
    case '2':
      plan = 'max_100';
      monthlyRate = 100;
      break;
    case '3':
      plan = 'max_200';
      monthlyRate = 200;
      break;
    case '4':
      plan = 'team';
      const rateStr = await ask('  Monthly rate per seat ($): ');
      monthlyRate = parseFloat(rateStr) || 0;
      break;
    default:
      console.log('  Invalid choice, defaulting to Max $100/month');
      plan = 'max_100';
      monthlyRate = 100;
  }

  // Check Claude dir
  let claudeDir = CLAUDE_DIR;
  if (!fs.existsSync(claudeDir)) {
    const customDir = await ask(`  Claude data directory not found at ${claudeDir}\n  Enter path: `);
    claudeDir = customDir.trim() || claudeDir;
  }

  rl.close();

  const config = { plan, monthlyRate, claudeDir };
  saveConfig(config);

  const planInfo = SUBSCRIPTION_PLANS[plan] || { name: plan };
  console.log(`\n  Saved! Plan: ${planInfo.name} ($${monthlyRate}/mo)`);
  console.log(`  Config: ${CONFIG_FILE}\n`);

  return config;
}

module.exports = { loadConfig, saveConfig, configExists, interactiveSetup, CONFIG_DIR, CONFIG_FILE };
