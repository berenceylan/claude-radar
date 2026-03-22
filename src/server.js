/**
 * Express server for the Claude Radar dashboard.
 */

const express = require('express');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const { loadConfig, saveConfig } = require('./config');
const { SUBSCRIPTION_PLANS } = require('./pricing');
const db = require('./db');
const git = require('./git');

function createServer(options = {}) {
  const app = express();
  const port = options.port || 3400;
  const config = loadConfig();

  app.use(express.json());

  // Security: restrict to localhost origins only
  app.use((req, res, next) => {
    const origin = req.headers.origin || '';
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // ── Index on startup ──────────────────────────────
  let indexReady = false;
  let indexPromise = db.indexAll((p) => {
    if (p.indexed % 20 === 0) {
      process.stdout.write(`\r  Indexing... ${p.indexed} files`);
    }
  }).then((result) => {
    if (result.indexed > 0) {
      console.log(`\r  Indexed ${result.indexed} files (${result.skipped} unchanged)`);
    }
    // Index git data after session data is ready
    try {
      const gitResult = git.indexGitData();
      if (gitResult.totalCommits > 0) {
        console.log(`  Git: ${gitResult.totalCommits} commits (${gitResult.linkedCommits} linked to sessions)`);
      }
    } catch (e) { /* git indexing optional */ }
    indexReady = true;
    return result;
  });

  function ensureReady(req, res, next) {
    if (indexReady) return next();
    indexPromise.then(() => next()).catch(err => res.status(500).json({ error: err.message }));
  }

  app.use('/api', ensureReady);

  // ── Core data API (now powered by SQLite) ─────────
  app.get('/api/data', (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const opts = {};
      if (startDate) opts.startDate = startDate;
      if (endDate) opts.endDate = endDate;

      const summary = db.getSummary();
      const projects = db.getProjects(opts);
      const dailyUsage = db.getDailyUsage(opts);
      const modelUsage = db.getModelUsage(opts);
      const projectDailyTokens = db.getProjectDailyTokens(opts);

      // Build project daily usage map for chart compatibility
      const projectsWithDaily = projects.map(p => ({
        ...p,
        name: p.name,
        path: p.full_path,
        totalCost: p.total_cost || 0,
        totalMessages: p.total_messages || 0,
        totalInputTokens: p.total_input_tokens || 0,
        totalOutputTokens: p.total_output_tokens || 0,
        totalCacheRead: p.total_cache_read || 0,
        totalCacheWrite: p.total_cache_write || 0,
        sessionCount: p.session_count || 0,
        firstActivity: p.first_activity,
        lastActivity: p.last_activity,
        dailyUsage: db.getDailyUsage({ ...opts, projectId: p.id }),
      }));

      // Model usage as object
      const modelUsageObj = {};
      for (const m of modelUsage) {
        modelUsageObj[m.model] = {
          inputTokens: m.input_tokens || 0,
          outputTokens: m.output_tokens || 0,
          cacheRead: m.cache_read || 0,
          cacheWrite: m.cache_write || 0,
          cost: m.cost || 0,
          messages: m.messages || 0,
        };
      }

      res.json({
        generated: new Date().toISOString(),
        subscription: summary.subscription,
        summary: {
          totalProjects: summary.total_projects,
          totalSessions: summary.total_sessions,
          totalMessages: summary.total_messages,
          totalInputTokens: summary.total_input_tokens || 0,
          totalOutputTokens: summary.total_output_tokens || 0,
          totalCacheRead: summary.total_cache_read || 0,
          totalCacheWrite: summary.total_cache_write || 0,
          totalTokens: summary.total_tokens || 0,
          apiEquivalentCost: summary.api_equivalent_cost,
          firstSessionDate: summary.first_activity,
        },
        modelUsage: modelUsageObj,
        dailyUsage: dailyUsage.map(d => ({
          date: d.date,
          messages: d.messages,
          inputTokens: d.input_tokens || 0,
          outputTokens: d.output_tokens || 0,
          cacheRead: d.cache_read || 0,
          cacheWrite: d.cache_write || 0,
          cost: d.cost || 0,
          tokens: (d.input_tokens || 0) + (d.output_tokens || 0),
        })),
        projects: projectsWithDaily,
        projectDailyTokens: projectDailyTokens,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Re-index ──────────────────────────────────────
  app.post('/api/regenerate', async (req, res) => {
    try {
      const result = await db.reindexAll();
      if (result.error) {
        return res.status(500).json({ error: result.error });
      }
      try { git.indexGitData(); } catch {}
      const summary = db.getSummary();
      broadcast({ type: 'refresh' });
      res.json({ ok: true, projects: summary.total_projects, messages: summary.total_messages, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Live stats (5h billing window) ──────────────────
  app.get('/api/live', (req, res) => {
    try {
      res.json(db.getWindowStats());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Project Detail ─────────────────────────────────
  app.get('/api/project/:id', (req, res) => {
    try {
      const projectId = Number(req.params.id);
      const { startDate, endDate } = req.query;
      const opts = { projectId, startDate, endDate };

      // Get project info
      const projects = db.getProjects(opts);
      const project = projects.find(p => p.id === projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      // Gather all project-specific data
      const dailyUsage = db.getDailyUsage(opts);
      const modelUsage = db.getModelUsage(opts);
      const sessions = db.getSessions({ ...opts, limit: 200 });
      const toolStats = db.getToolStats(opts);
      const subagents = db.getSubagents({ projectId });

      // Git data
      let gitCommits = [], gitSummary = {};
      try {
        gitCommits = git.getGitCommits({ projectId, startDate, endDate, limit: 500 });
        const byProj = git.getGitByProject({ startDate, endDate });
        gitSummary = byProj.find(p => p.project_id === projectId) || {};
      } catch {}

      // Cache analysis
      const totalInput = (project.total_input_tokens || 0) + (project.total_cache_read || 0);
      const cacheHitRate = totalInput > 0 ? ((project.total_cache_read || 0) / totalInput * 100) : 0;

      // Busiest day
      const busiestDay = dailyUsage.reduce((max, d) => d.cost > (max?.cost || 0) ? d : max, null);

      // Average session cost
      const avgSessionCost = sessions.length > 0
        ? sessions.reduce((s, x) => s + (x.total_cost || 0), 0) / sessions.length : 0;

      res.json({
        project,
        dailyUsage,
        modelUsage,
        sessions,
        toolStats,
        subagents,
        gitCommits,
        gitSummary,
        stats: {
          cacheHitRate: cacheHitRate.toFixed(1),
          busiestDay,
          avgSessionCost,
          totalSessions: sessions.length,
          totalSubagents: subagents.length,
          totalCommits: gitCommits.length,
          linkedCommits: gitCommits.filter(c => c.session_id).length,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Projects list ─────────────────────────────────
  app.get('/api/projects', (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      res.json(db.getProjects({ startDate, endDate }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Sessions ──────────────────────────────────────
  app.get('/api/sessions', (req, res) => {
    try {
      const { projectId, startDate, endDate, limit, offset } = req.query;
      const sessions = db.getSessions({
        projectId: projectId ? Number(projectId) : undefined,
        startDate, endDate,
        limit: Math.min(Number(limit) || 50, 1000),
        offset: Number(offset) || 0,
      });
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/sessions/:id', (req, res) => {
    try {
      const detail = db.getSessionDetail(req.params.id);
      if (!detail) return res.status(404).json({ error: 'Session not found' });
      res.json(detail);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Tools ─────────────────────────────────────────
  app.get('/api/tools', (req, res) => {
    try {
      const { startDate, endDate, projectId } = req.query;
      const tools = db.getToolStats({
        startDate, endDate,
        projectId: projectId ? Number(projectId) : undefined,
      });
      res.json(tools);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Subagents ─────────────────────────────────────
  app.get('/api/subagents', (req, res) => {
    try {
      const { sessionId, projectId } = req.query;
      const agents = db.getSubagents({
        sessionId,
        projectId: projectId ? Number(projectId) : undefined,
      });
      res.json(agents);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Insights ──────────────────────────────────────
  app.get('/api/insights', (req, res) => {
    try {
      res.json(db.getInsights());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Git-to-Cost ────────────────────────────────────
  app.get('/api/git/summary', (req, res) => {
    try { res.json(git.getGitSummary()); } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/git/projects', (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      res.json(git.getGitByProject({ startDate, endDate }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/git/branches', (req, res) => {
    try {
      const { projectId, startDate, endDate } = req.query;
      res.json(git.getGitByBranch({ projectId: projectId ? Number(projectId) : undefined, startDate, endDate }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/git/commits', (req, res) => {
    try {
      const { projectId, sessionId, branch, startDate, endDate, limit } = req.query;
      res.json(git.getGitCommits({
        projectId: projectId ? Number(projectId) : undefined,
        sessionId, branch, startDate, endDate,
        limit: Math.min(Number(limit) || 100, 1000),
      }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/git/timeline', (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      res.json(git.getGitTimeline({ startDate, endDate }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/git/expensive', (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 1000);
      res.json(git.getMostExpensiveCommits(limit));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/git/reindex', (req, res) => {
    try {
      const result = git.indexGitData();
      res.json({ ok: true, ...result });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Export ────────────────────────────────────────
  app.get('/api/export/json', (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const opts = {};
      if (startDate) opts.startDate = startDate;
      if (endDate) opts.endDate = endDate;

      const data = {
        exported: new Date().toISOString(),
        summary: db.getSummary(),
        projects: db.getProjects(opts),
        dailyUsage: db.getDailyUsage(opts),
        modelUsage: db.getModelUsage(opts),
        toolStats: db.getToolStats(opts),
      };
      res.setHeader('Content-Disposition', 'attachment; filename=claude-radar-export.json');
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/export/csv', (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const opts = {};
      if (startDate) opts.startDate = startDate;
      if (endDate) opts.endDate = endDate;

      const projects = db.getProjects(opts);
      const header = 'Project,Path,Sessions,Messages,Input Tokens,Output Tokens,Cache Read,Cache Write,API Value,First Active,Last Active\n';
      const csvEsc = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
      const rows = projects.map(p =>
        [csvEsc(p.name), csvEsc(p.full_path), p.session_count, p.total_messages,
         p.total_input_tokens, p.total_output_tokens, p.total_cache_read, p.total_cache_write,
         (p.total_cost || 0).toFixed(2), p.first_activity || '', p.last_activity || ''
        ].join(',')
      ).join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=claude-radar-export.csv');
      res.send(header + rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Config ────────────────────────────────────────
  app.get('/api/config', (req, res) => {
    const cfg = loadConfig();
    const plans = Object.entries(SUBSCRIPTION_PLANS).map(([key, val]) => ({ key, ...val }));
    res.json({ config: cfg, plans });
  });

  app.post('/api/config', (req, res) => {
    try {
      const { plan, monthlyRate } = req.body;
      const current = loadConfig();
      if (plan) current.plan = plan;
      if (monthlyRate !== undefined) current.monthlyRate = Number(monthlyRate);
      saveConfig(current);
      res.json({ ok: true, config: current });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Static files ──────────────────────────────────
  app.use(express.static(path.join(__dirname, '..', 'dashboard')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dashboard', 'index.html'));
  });

  // ── WebSocket for real-time updates ───────────────
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set();

  wss.on('connection', (ws, req) => {
    // Only allow localhost connections
    const origin = req.headers.origin || '';
    const isLocal = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (!isLocal) {
      ws.close(1008, 'Forbidden');
      return;
    }
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
  });

  function broadcast(data) {
    const msg = JSON.stringify(data);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  // ── File watcher for real-time ────────────────────
  if (!options.noWatch) {
    const watchDir = path.join(config.claudeDir, 'projects');
    try {
      let debounceTimer = null;
      fs.watch(watchDir, { recursive: true }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          const result = await db.indexAll();
          if (result.indexed > 0) {
            broadcast({ type: 'refresh', indexed: result.indexed });
          }
        }, 3000);
      });
    } catch { /* watcher optional */ }
  }

  return { server, app, port };
}

function startServer(options = {}) {
  const { server, port } = createServer(options);

  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  Claude Radar Dashboard`);
    console.log(`  ${url}\n`);

    if (!options.noOpen) {
      import('open').then(mod => mod.default(url)).catch(() => {});
    }
  });
}

module.exports = { createServer, startServer };
