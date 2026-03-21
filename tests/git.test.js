const fs = require('fs');
const path = require('path');
const { createTestEnv, createMockConfig, writeTestJsonl, cleanupTestEnv } = require('./helpers');

const env = createTestEnv('git');
const mockConfig = createMockConfig(env);


// Create JSONL data
const projDir = path.join(env.claudeDir, 'projects', '-test-gitproj');
writeTestJsonl(projDir, 'git-sess.jsonl', [
  {
    uuid: 'gm-001', type: 'assistant', sessionId: 'git-sess',
    timestamp: '2026-03-15T10:00:00Z',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'test' }],
      usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000 },
    },
  },
]);

const db = require('../src/db');
const git = require('../src/git');

beforeAll(async () => {
  await db.reindexAll();
});

afterAll(() => cleanupTestEnv(env));

describe('git', () => {
  describe('indexGitData', () => {
    it('runs without error', () => {
      const r = git.indexGitData();
      expect(r).toHaveProperty('totalCommits');
      expect(r).toHaveProperty('linkedCommits');
      expect(typeof r.totalCommits).toBe('number');
    });
  });

  describe('getGitSummary', () => {
    it('returns summary object', () => {
      const s = git.getGitSummary();
      expect(s).toHaveProperty('totalCommits');
      expect(s).toHaveProperty('linkedCommits');
      expect(s).toHaveProperty('totalCost');
      expect(s).toHaveProperty('avgCostPerCommit');
      expect(s).toHaveProperty('costPerLine');
    });
  });

  describe('getGitByProject', () => {
    it('returns array', () => {
      expect(Array.isArray(git.getGitByProject())).toBe(true);
    });

    it('empty for future dates', () => {
      expect(git.getGitByProject({ startDate: '2099-01-01' }).length).toBe(0);
    });
  });

  describe('getGitByBranch', () => {
    it('returns array', () => {
      expect(Array.isArray(git.getGitByBranch())).toBe(true);
    });
  });

  describe('getGitCommits', () => {
    it('returns array with limit', () => {
      const c = git.getGitCommits({ limit: 5 });
      expect(Array.isArray(c)).toBe(true);
      expect(c.length).toBeLessThanOrEqual(5);
    });
  });

  describe('getGitTimeline', () => {
    it('returns array', () => {
      expect(Array.isArray(git.getGitTimeline())).toBe(true);
    });
  });

  describe('getMostExpensiveCommits', () => {
    it('returns sorted by cost desc', () => {
      const c = git.getMostExpensiveCommits(10);
      expect(Array.isArray(c)).toBe(true);
      for (let i = 1; i < c.length; i++) {
        expect(c[i - 1].estimated_cost).toBeGreaterThanOrEqual(c[i].estimated_cost);
      }
    });
  });
});
