/**
 * Shared test helpers — creates isolated test environments.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function createTestEnv(prefix) {
  const dir = path.join(os.tmpdir(), `claude-radar-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const claudeDir = path.join(dir, '.claude');
  const configDir = path.join(dir, '.claude-radar');
  const configFile = path.join(configDir, 'config.json');

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });

  fs.writeFileSync(configFile, JSON.stringify({
    plan: 'max_100', monthlyRate: 100, claudeDir,
  }));

  return { dir, claudeDir, configDir, configFile };
}

function createMockConfig(env) {
  return {
    CONFIG_DIR: env.configDir,
    CONFIG_FILE: env.configFile,
    loadConfig: () => {
      try { return JSON.parse(fs.readFileSync(env.configFile, 'utf8')); }
      catch { return { plan: 'max_100', monthlyRate: 100, claudeDir: env.claudeDir }; }
    },
    saveConfig: (cfg) => { fs.writeFileSync(env.configFile, JSON.stringify(cfg)); },
    configExists: () => fs.existsSync(env.configFile),
  };
}

function writeTestJsonl(dir, filename, entries) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), entries.map(e => JSON.stringify(e)).join('\n'));
}

function cleanupTestEnv(env) {
  fs.rmSync(env.dir, { recursive: true, force: true });
}

module.exports = { createTestEnv, createMockConfig, writeTestJsonl, cleanupTestEnv };
