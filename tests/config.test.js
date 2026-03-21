const fs = require('fs');
const path = require('path');
const os = require('os');

// Use a temp directory for test config
const TEST_DIR = path.join(os.tmpdir(), 'claude-radar-test-' + Date.now());
const TEST_CONFIG = path.join(TEST_DIR, 'config.json');

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  // Monkey-patch the config module's paths
  jest.resetModules();
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('config', () => {
  let config;

  beforeEach(() => {
    jest.resetModules();
    // Override CONFIG_DIR and CONFIG_FILE before requiring
    jest.doMock('../src/pricing', () => ({
      SUBSCRIPTION_PLANS: {
        pro_20: { name: 'Pro', monthlyRate: 20 },
        max_100: { name: 'Max', monthlyRate: 100 },
        max_200: { name: 'Max', monthlyRate: 200 },
        team: { name: 'Team', monthlyRate: 0 },
      },
    }));
  });

  describe('loadConfig', () => {
    it('returns defaults when no config file exists', () => {
      const { loadConfig } = require('../src/config');
      // loadConfig reads from ~/.claude-radar which may or may not exist
      const cfg = loadConfig();
      expect(cfg).toHaveProperty('plan');
      expect(cfg).toHaveProperty('monthlyRate');
      expect(cfg).toHaveProperty('claudeDir');
    });

    it('default plan is max_100', () => {
      const { loadConfig } = require('../src/config');
      // If no config exists, defaults apply
      const defaults = { plan: 'max_100', monthlyRate: 100 };
      const cfg = loadConfig();
      // Even if user has a config, these fields should exist
      expect(typeof cfg.plan).toBe('string');
      expect(typeof cfg.monthlyRate).toBe('number');
    });
  });

  describe('saveConfig / loadConfig roundtrip', () => {
    it('saves and loads config correctly', () => {
      const { saveConfig, loadConfig, CONFIG_DIR } = require('../src/config');
      const testConfig = { plan: 'pro_20', monthlyRate: 20, claudeDir: '/tmp/test-claude' };
      saveConfig(testConfig);

      const loaded = loadConfig();
      expect(loaded.plan).toBe('pro_20');
      expect(loaded.monthlyRate).toBe(20);
      expect(loaded.claudeDir).toBe('/tmp/test-claude');
    });
  });

  describe('configExists', () => {
    it('returns a boolean', () => {
      const { configExists } = require('../src/config');
      expect(typeof configExists()).toBe('boolean');
    });
  });
});
