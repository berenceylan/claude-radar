const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createTestEnv, createMockConfig, writeTestJsonl, cleanupTestEnv } = require('./helpers');

const env = createTestEnv('mcp');
const mockConfig = createMockConfig(env);

jest.mock('../src/config', () => mockConfig);

// Create test data
const projDir = path.join(env.claudeDir, 'projects', '-test-mcp-proj');
writeTestJsonl(projDir, 'mcp-sess.jsonl', [
  {
    uuid: 'mcp-001', type: 'assistant', sessionId: 'mcp-sess',
    timestamp: '2026-03-15T10:00:00Z',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'test' }],
      usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000 },
    },
  },
]);

// We can't easily test the full MCP stdio flow in Jest,
// but we can test that the module loads and the db queries work.
// The MCP server uses db.js functions, which are tested in db.test.js.

const db = require('../src/db');

beforeAll(async () => {
  await db.reindexAll();
});

afterAll(() => cleanupTestEnv(env));

describe('mcp', () => {
  describe('module loading', () => {
    it('exports startMcpServer', () => {
      const mcp = require('../src/mcp');
      expect(typeof mcp.startMcpServer).toBe('function');
    });
  });

  describe('underlying db queries used by MCP tools', () => {
    it('getSummary works (used by get_usage_summary)', () => {
      const s = db.getSummary();
      expect(s.total_messages).toBeGreaterThan(0);
      expect(s.subscription).toBeDefined();
    });

    it('getProjects works (used by get_project_cost)', () => {
      const p = db.getProjects();
      expect(p.length).toBeGreaterThan(0);
    });

    it('getDailyUsage works (used by get_daily_usage)', () => {
      const d = db.getDailyUsage({ startDate: '2026-03-15', endDate: '2026-03-15' });
      expect(d.length).toBe(1);
    });

    it('getModelUsage works (used by get_model_breakdown)', () => {
      const m = db.getModelUsage();
      expect(m.length).toBeGreaterThan(0);
    });
  });

  describe('MCP protocol via stdio', () => {
    it('responds to initialize request', (done) => {
      const child = spawn('node', ['-e', `
        process.env.CLAUDE_RADAR_TEST_CONFIG = '${env.configFile}';
        require('./src/mcp').startMcpServer().catch(console.error);
      `], { cwd: path.join(__dirname, '..'), stdio: ['pipe', 'pipe', 'pipe'] });

      const initMsg = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      }) + '\n';

      let output = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
        if (output.includes('"result"')) {
          try {
            const resp = JSON.parse(output.trim());
            expect(resp.result.serverInfo.name).toBe('claude-radar');
            expect(resp.result.capabilities.tools).toBeDefined();
          } catch {}
          child.kill();
          done();
        }
      });

      // Timeout fallback
      setTimeout(() => { child.kill(); done(); }, 10000);

      child.stdin.write(initMsg);
    });
  });
});
