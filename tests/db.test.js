const fs = require('fs');
const path = require('path');
const { createTestEnv, createMockConfig, writeTestJsonl, cleanupTestEnv } = require('./helpers');

const env = createTestEnv('db');
const mockConfig = createMockConfig(env);


// Create test data
const projDir = path.join(env.claudeDir, 'projects', '-test-project');
writeTestJsonl(projDir, 'session-001.jsonl', [
  {
    uuid: 'msg-001', type: 'user', sessionId: 'session-001',
    timestamp: '2026-03-15T10:00:00Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
  },
  {
    uuid: 'msg-002', type: 'assistant', sessionId: 'session-001',
    timestamp: '2026-03-15T10:00:05Z',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'Hello!' }, { type: 'tool_use', name: 'Read', id: 't1' }],
      usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000 },
    },
  },
  {
    uuid: 'msg-003', type: 'assistant', sessionId: 'session-001',
    timestamp: '2026-03-15T10:01:00Z',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }, { type: 'tool_use', name: 'Edit', id: 't2' }, { type: 'tool_use', name: 'Bash', id: 't3' }],
      usage: { input_tokens: 150, output_tokens: 300, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500 },
    },
  },
]);

const proj2Dir = path.join(env.claudeDir, 'projects', '-test-project2');
writeTestJsonl(proj2Dir, 'session-002.jsonl', [
  {
    uuid: 'msg-004', type: 'assistant', sessionId: 'session-002',
    timestamp: '2026-03-16T14:00:00Z',
    message: {
      model: 'claude-haiku-4-5-20251001', role: 'assistant',
      content: [{ type: 'text', text: 'Email test@example.com key sk-ant-abcdef1234567890abcdef1234' }],
      usage: { input_tokens: 50, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
    },
  },
]);

const subDir = path.join(projDir, 'session-001', 'subagents');
writeTestJsonl(subDir, 'agent-test123.jsonl', [
  {
    uuid: 'msg-sub-001', type: 'assistant', sessionId: 'session-001',
    agentId: 'test123', slug: 'test-agent',
    timestamp: '2026-03-15T10:02:00Z',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'Subagent' }],
      usage: { input_tokens: 50, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300 },
    },
  },
]);

const db = require('../src/db');

afterAll(() => cleanupTestEnv(env));

describe('db', () => {
  describe('indexAll', () => {
    it('indexes test JSONL files', async () => {
      const result = await db.indexAll();
      expect(result.indexed).toBeGreaterThan(0);
      expect(result.total).toBeGreaterThan(0);
    });

    it('second run skips already indexed files', async () => {
      const result = await db.indexAll();
      expect(result.indexed).toBe(0);
      expect(result.skipped).toBeGreaterThan(0);
    });
  });

  describe('getSummary', () => {
    it('returns correct totals', () => {
      const s = db.getSummary();
      expect(s.total_projects).toBe(2);
      expect(s.total_messages).toBeGreaterThanOrEqual(3);
      expect(s.total_input_tokens).toBeGreaterThan(0);
      expect(s.total_output_tokens).toBeGreaterThan(0);
      expect(s.api_equivalent_cost).toBeGreaterThan(0);
    });

    it('includes subscription info', () => {
      const s = db.getSummary();
      expect(s.subscription).toBeDefined();
      expect(s.subscription.plan).toBe('max_100');
      expect(s.subscription.monthlyRate).toBe(100);
    });
  });

  describe('getProjects', () => {
    it('returns all projects', () => {
      const p = db.getProjects();
      expect(p.length).toBe(2);
      expect(p[0]).toHaveProperty('name');
      expect(p[0]).toHaveProperty('total_cost');
    });

    it('supports date filtering', () => {
      const p = db.getProjects({ startDate: '2026-03-16' });
      expect(p.length).toBe(1);
    });

    it('returns empty for future dates', () => {
      expect(db.getProjects({ startDate: '2099-01-01' }).length).toBe(0);
    });
  });

  describe('getDailyUsage', () => {
    it('returns daily breakdown', () => {
      const d = db.getDailyUsage();
      expect(d.length).toBeGreaterThanOrEqual(2);
      expect(d[0]).toHaveProperty('date');
      expect(d[0]).toHaveProperty('messages');
      expect(d[0]).toHaveProperty('cost');
    });

    it('supports date filtering', () => {
      const d = db.getDailyUsage({ startDate: '2026-03-16', endDate: '2026-03-16' });
      expect(d.length).toBe(1);
    });
  });

  describe('getModelUsage', () => {
    it('returns per-model breakdown', () => {
      const m = db.getModelUsage();
      expect(m.length).toBeGreaterThanOrEqual(2);
      expect(m.find(x => x.model.includes('opus'))).toBeDefined();
      expect(m.find(x => x.model.includes('haiku'))).toBeDefined();
    });
  });

  describe('getSessions', () => {
    it('returns sessions', () => {
      const s = db.getSessions({ limit: 10 });
      expect(s.length).toBeGreaterThanOrEqual(2);
      expect(s[0]).toHaveProperty('project_name');
    });

    it('respects limit', () => {
      expect(db.getSessions({ limit: 1 }).length).toBe(1);
    });
  });

  describe('getSessionDetail', () => {
    it('returns full detail', () => {
      const d = db.getSessionDetail('session-001');
      expect(d).not.toBeNull();
      expect(d.messages.length).toBeGreaterThanOrEqual(2);
      expect(d.toolCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('returns null for unknown', () => {
      expect(db.getSessionDetail('nonexistent')).toBeNull();
    });

    it('includes subagents', () => {
      const d = db.getSessionDetail('session-001');
      expect(d.subagents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getToolStats', () => {
    it('returns tool counts', () => {
      const t = db.getToolStats();
      expect(t.length).toBeGreaterThanOrEqual(1);
      expect(t.find(x => x.tool_name === 'Read')).toBeDefined();
    });
  });

  describe('getSubagents', () => {
    it('returns subagents', () => {
      const a = db.getSubagents();
      expect(a.length).toBeGreaterThanOrEqual(1);
      expect(a[0]).toHaveProperty('slug');
    });
  });

  describe('getInsights', () => {
    it('returns insights array', () => {
      const i = db.getInsights();
      expect(Array.isArray(i)).toBe(true);
      for (const x of i) {
        expect(x).toHaveProperty('type');
        expect(x).toHaveProperty('severity');
        expect(['warning', 'info']).toContain(x.severity);
      }
    });
  });

  describe('getProjectDailyTokens', () => {
    it('returns data', () => {
      const d = db.getProjectDailyTokens();
      expect(d.length).toBeGreaterThanOrEqual(1);
      expect(d[0]).toHaveProperty('project_name');
      expect(d[0]).toHaveProperty('tokens');
    });
  });

  describe('PII redaction', () => {
    it('redacts API keys and emails', () => {
      const d = db.getSessionDetail('session-002');
      const msg = d.messages.find(m => m.content_preview);
      if (msg) {
        expect(msg.content_preview).not.toContain('sk-ant-');
        expect(msg.content_preview).toContain('[ANTHROPIC_KEY]');
        expect(msg.content_preview).toContain('[EMAIL]');
      }
    });
  });

  describe('reindexAll', () => {
    it('clears and re-indexes', async () => {
      const r = await db.reindexAll();
      expect(r.indexed).toBeGreaterThan(0);
      expect(r.skipped).toBe(0);
    });
  });
});
