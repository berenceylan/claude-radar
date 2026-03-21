/**
 * Express server for the Claude Radar dashboard.
 */

const express = require('express');
const path = require('path');
const { parseAllData } = require('./parser');
const { loadConfig, saveConfig } = require('./config');
const { SUBSCRIPTION_PLANS } = require('./pricing');

function createServer(options = {}) {
  const app = express();
  const port = options.port || 3400;

  app.use(express.json());

  // Cache parsed data for 30 seconds to avoid re-parsing on every request
  let cachedData = null;
  let cacheTime = 0;
  const CACHE_TTL = 30_000;

  async function getData(force = false) {
    const now = Date.now();
    if (!force && cachedData && (now - cacheTime) < CACHE_TTL) return cachedData;
    const config = loadConfig();
    cachedData = await parseAllData(config);
    cacheTime = now;
    return cachedData;
  }

  // Get usage data
  app.get('/api/data', async (req, res) => {
    try {
      const force = req.query.force === '1';
      const data = await getData(force);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Force regenerate
  app.post('/api/regenerate', async (req, res) => {
    try {
      const data = await getData(true);
      res.json({ ok: true, projects: data.summary.totalProjects, messages: data.summary.totalMessages });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get current config
  app.get('/api/config', (req, res) => {
    const config = loadConfig();
    const plans = Object.entries(SUBSCRIPTION_PLANS).map(([key, val]) => ({ key, ...val }));
    res.json({ config, plans });
  });

  // Update config
  app.post('/api/config', (req, res) => {
    try {
      const { plan, monthlyRate } = req.body;
      const current = loadConfig();
      if (plan) current.plan = plan;
      if (monthlyRate !== undefined) current.monthlyRate = Number(monthlyRate);
      saveConfig(current);
      // Bust cache so next data fetch uses new config
      cachedData = null;
      cacheTime = 0;
      res.json({ ok: true, config: current });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve dashboard static files
  app.use(express.static(path.join(__dirname, '..', 'dashboard')));

  // Fallback to index.html
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dashboard', 'index.html'));
  });

  return { app, port };
}

function startServer(options = {}) {
  const { app, port } = createServer(options);

  app.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  Claude Radar Dashboard`);
    console.log(`  ${url}\n`);

    // Try to open browser
    if (!options.noOpen) {
      import('open').then(mod => mod.default(url)).catch(() => {});
    }
  });
}

module.exports = { createServer, startServer };
