const fs = require('fs');
const path = require('path');
const { createTestEnv, createMockConfig, writeTestJsonl, cleanupTestEnv } = require('./helpers');

const env = createTestEnv('parser');
const mockConfig = createMockConfig(env);


// Create test data
const projDir = path.join(env.claudeDir, 'projects', '-test-parser-proj');
writeTestJsonl(projDir, 'ps-001.jsonl', [
  {
    uuid: 'p-001', type: 'assistant', sessionId: 'ps-001',
    timestamp: '2026-03-15T10:00:00Z',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'Response' }],
      usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000 },
    },
  },
  {
    uuid: 'p-002', type: 'assistant', sessionId: 'ps-001',
    timestamp: '2026-03-15T10:01:00Z',
    message: {
      model: 'claude-haiku-4-5-20251001', role: 'assistant',
      content: [{ type: 'text', text: 'Fast response' }],
      usage: { input_tokens: 50, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
    },
  },
]);

const { parseAllData, getProjectSummary, getDailyRange } = require('../src/parser');

afterAll(() => cleanupTestEnv(env));

describe('parser', () => {
  describe('parseAllData', () => {
    it('returns full data structure', async () => {
      const config = mockConfig.loadConfig();
      const data = await parseAllData(config);
      expect(data).toHaveProperty('generated');
      expect(data).toHaveProperty('subscription');
      expect(data).toHaveProperty('summary');
      expect(data).toHaveProperty('modelUsage');
      expect(data).toHaveProperty('dailyUsage');
      expect(data).toHaveProperty('projects');
    });

    it('finds test project', async () => {
      const config = mockConfig.loadConfig();
      const data = await parseAllData(config);
      expect(data.summary.totalProjects).toBe(1);
      expect(data.summary.totalMessages).toBe(2);
    });

    it('calculates correct token totals', async () => {
      const config = mockConfig.loadConfig();
      const data = await parseAllData(config);
      expect(data.summary.totalInputTokens).toBe(150);
      expect(data.summary.totalOutputTokens).toBe(300);
    });

    it('includes subscription data', async () => {
      const config = mockConfig.loadConfig();
      const data = await parseAllData(config);
      expect(data.subscription.plan).toBe('Max');
      expect(data.subscription.monthlyRate).toBe(100);
    });

    it('includes model usage', async () => {
      const config = mockConfig.loadConfig();
      const data = await parseAllData(config);
      expect(data.modelUsage['claude-opus-4-6']).toBeDefined();
      expect(data.modelUsage['claude-haiku-4-5-20251001']).toBeDefined();
    });
  });

  describe('getProjectSummary', () => {
    it('finds project by name', async () => {
      const config = mockConfig.loadConfig();
      const proj = await getProjectSummary(config, 'parser');
      expect(proj).not.toBeNull();
      expect(proj.totalMessages).toBe(2);
    });

    it('returns null for unknown project', async () => {
      const config = mockConfig.loadConfig();
      expect(await getProjectSummary(config, 'nonexistent-xyz')).toBeNull();
    });
  });

  describe('getDailyRange', () => {
    it('returns daily data', async () => {
      const config = mockConfig.loadConfig();
      const daily = await getDailyRange(config, '2026-03-15', '2026-03-15');
      expect(daily.length).toBe(1);
      expect(daily[0].date).toBe('2026-03-15');
    });

    it('returns empty for no-match range', async () => {
      const config = mockConfig.loadConfig();
      expect((await getDailyRange(config, '2099-01-01', '2099-01-02')).length).toBe(0);
    });
  });
});
