const fs = require('fs');
const path = require('path');
const { createTestEnv, createMockConfig, writeTestJsonl, cleanupTestEnv } = require('./helpers');

const env = createTestEnv('srv');
const mockConfig = createMockConfig(env);


// Create minimal test data
const projDir = path.join(env.claudeDir, 'projects', '-test-srv');
writeTestJsonl(projDir, 'sess-srv.jsonl', [
  {
    uuid: 'srv-001', type: 'assistant', sessionId: 'sess-srv',
    timestamp: '2026-03-15T10:00:00Z',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'test response' }],
      usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 },
    },
  },
]);

const { createServer } = require('../src/server');
let server, baseUrl;

beforeAll(async () => {
  const result = createServer({ port: 0, noWatch: true });
  server = result.server;
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  // Wait for indexing
  await new Promise(r => setTimeout(r, 3000));
});

afterAll(() => {
  server.close();
  cleanupTestEnv(env);
});

describe('server', () => {
  describe('GET /api/data', () => {
    it('returns dashboard data', async () => {
      const r = await fetch(baseUrl + '/api/data');
      expect(r.status).toBe(200);
      const d = await r.json();
      expect(d).toHaveProperty('summary');
      expect(d).toHaveProperty('subscription');
      expect(d).toHaveProperty('projects');
      expect(d).toHaveProperty('dailyUsage');
      expect(d).toHaveProperty('modelUsage');
    });

    it('supports date filtering', async () => {
      const r = await fetch(baseUrl + '/api/data?startDate=2026-03-15&endDate=2026-03-15');
      expect(r.status).toBe(200);
    });
  });

  describe('GET /api/sessions', () => {
    it('returns sessions', async () => {
      const r = await fetch(baseUrl + '/api/sessions');
      expect(r.status).toBe(200);
      expect(Array.isArray(await r.json())).toBe(true);
    });

    it('respects limit', async () => {
      const d = await (await fetch(baseUrl + '/api/sessions?limit=1')).json();
      expect(d.length).toBeLessThanOrEqual(1);
    });
  });

  describe('GET /api/sessions/:id', () => {
    it('returns 404 for unknown', async () => {
      expect((await fetch(baseUrl + '/api/sessions/nonexistent')).status).toBe(404);
    });

    it('returns detail for known session', async () => {
      const r = await fetch(baseUrl + '/api/sessions/sess-srv');
      expect(r.status).toBe(200);
      const d = await r.json();
      expect(d.session).toBeDefined();
      expect(d.messages).toBeDefined();
    });
  });

  describe('GET /api/tools', () => {
    it('returns array', async () => {
      const r = await fetch(baseUrl + '/api/tools');
      expect(r.status).toBe(200);
      expect(Array.isArray(await r.json())).toBe(true);
    });
  });

  describe('GET /api/subagents', () => {
    it('returns array', async () => {
      expect(Array.isArray(await (await fetch(baseUrl + '/api/subagents')).json())).toBe(true);
    });
  });

  describe('GET /api/insights', () => {
    it('returns array', async () => {
      expect(Array.isArray(await (await fetch(baseUrl + '/api/insights')).json())).toBe(true);
    });
  });

  describe('config endpoints', () => {
    it('GET /api/config returns config', async () => {
      const d = await (await fetch(baseUrl + '/api/config')).json();
      expect(d.config).toHaveProperty('plan');
      expect(d.plans.length).toBeGreaterThanOrEqual(4);
    });

    it('POST /api/config updates config', async () => {
      // Save original, restore after test to prevent corrupting real config
      const origConfig = fs.readFileSync(env.configFile, 'utf8');
      const r = await fetch(baseUrl + '/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'pro_20', monthlyRate: 20 }),
      });
      const d = await r.json();
      expect(d.ok).toBe(true);
      expect(d.config.plan).toBe('pro_20');
      // Restore original config
      fs.writeFileSync(env.configFile, origConfig);
    });
  });

  describe('export endpoints', () => {
    it('GET /api/export/json returns attachment', async () => {
      const r = await fetch(baseUrl + '/api/export/json');
      expect(r.status).toBe(200);
      expect(r.headers.get('content-disposition')).toContain('claude-radar-export.json');
    });

    it('GET /api/export/csv returns CSV', async () => {
      const r = await fetch(baseUrl + '/api/export/csv');
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/csv');
      expect(await r.text()).toContain('Project,Path');
    });
  });

  describe('git endpoints', () => {
    it('GET /api/git/summary', async () => {
      const d = await (await fetch(baseUrl + '/api/git/summary')).json();
      expect(d).toHaveProperty('totalCommits');
    });

    it('GET /api/git/projects', async () => {
      expect(Array.isArray(await (await fetch(baseUrl + '/api/git/projects')).json())).toBe(true);
    });

    it('GET /api/git/branches', async () => {
      expect(Array.isArray(await (await fetch(baseUrl + '/api/git/branches')).json())).toBe(true);
    });

    it('GET /api/git/commits', async () => {
      expect(Array.isArray(await (await fetch(baseUrl + '/api/git/commits')).json())).toBe(true);
    });

    it('GET /api/git/timeline', async () => {
      expect(Array.isArray(await (await fetch(baseUrl + '/api/git/timeline')).json())).toBe(true);
    });

    it('GET /api/git/expensive', async () => {
      expect(Array.isArray(await (await fetch(baseUrl + '/api/git/expensive')).json())).toBe(true);
    });
  });

  describe('security', () => {
    it('blocks cross-origin', async () => {
      expect((await fetch(baseUrl + '/api/data', { headers: { Origin: 'http://evil.com' } })).status).toBe(403);
    });

    it('allows localhost origin', async () => {
      expect((await fetch(baseUrl + '/api/data', { headers: { Origin: 'http://localhost:3400' } })).status).toBe(200);
    });

    it('sets security headers', async () => {
      const r = await fetch(baseUrl + '/api/data');
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('caps limit parameter', async () => {
      const d = await (await fetch(baseUrl + '/api/sessions?limit=999999')).json();
      expect(d.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('static files', () => {
    it('serves dashboard', async () => {
      const t = await (await fetch(baseUrl + '/')).text();
      expect(t).toContain('Claude Radar');
    });
  });

  describe('POST /api/regenerate', () => {
    it('re-indexes', async () => {
      const d = await (await fetch(baseUrl + '/api/regenerate', { method: 'POST' })).json();
      expect(d.ok).toBe(true);
    });
  });
});
