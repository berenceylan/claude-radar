/**
 * SQLite database layer for Claude Radar.
 * Incrementally indexes ~/.claude/ JSONL data into a local SQLite database
 * for fast queries. Only re-parses new/changed files.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { calculateCost } = require('./pricing');
const { loadConfig, CONFIG_DIR } = require('./config');

const DB_PATH = path.join(CONFIG_DIR, 'radar.db');

// Generic parent dirs to skip when deriving project name
const GENERIC_DIRS = new Set([
  'src', 'app', 'projects', 'repos', 'code', 'dev', 'work', 'workspace',
  'htdocs', 'www', 'public_html', 'sites', 'codeBase', 'vibeCoding',
]);

function decodeProjectPath(encoded) {
  return encoded.replace(/^-/, '/').replace(/-/g, '/');
}

function getProjectName(encodedPath) {
  const decoded = decodeProjectPath(encodedPath);
  const parts = decoded.split('/').filter(Boolean);
  if (parts.length === 0) return encodedPath;
  const last = parts[parts.length - 1];
  if (parts.length >= 2) {
    const parent = parts[parts.length - 2];
    if (!GENERIC_DIRS.has(parent)) return `${parent}/${last}`;
  }
  return last;
}

function openDb() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = OFF');
  initSchema(db);
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY,
      encoded_path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      full_path TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id),
      first_timestamp TEXT,
      last_timestamp TEXT,
      message_count INTEGER DEFAULT 0,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cache_read INTEGER DEFAULT 0,
      total_cache_write INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      version TEXT,
      git_branch TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id),
      project_id INTEGER REFERENCES projects(id),
      parent_uuid TEXT,
      type TEXT NOT NULL,
      model TEXT,
      timestamp TEXT,
      date TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0,
      cache_write INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      has_tool_use INTEGER DEFAULT 0,
      content_preview TEXT,
      agent_id TEXT,
      agent_slug TEXT
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY,
      message_id TEXT REFERENCES messages(id),
      session_id TEXT,
      project_id INTEGER,
      tool_name TEXT NOT NULL,
      timestamp TEXT,
      date TEXT
    );

    CREATE TABLE IF NOT EXISTS subagents (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id),
      project_id INTEGER REFERENCES projects(id),
      agent_id TEXT NOT NULL,
      slug TEXT,
      parent_session_id TEXT,
      first_timestamp TEXT,
      last_timestamp TEXT,
      message_count INTEGER DEFAULT 0,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cache_read INTEGER DEFAULT 0,
      total_cache_write INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS indexed_files (
      file_path TEXT PRIMARY KEY,
      file_size INTEGER,
      mtime_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id);
    CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date);
    CREATE INDEX IF NOT EXISTS idx_messages_model ON messages(model);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_date ON tool_calls(date);
    CREATE INDEX IF NOT EXISTS idx_subagents_session ON subagents(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
  `);
}

async function readJsonlFile(filePath) {
  const entries = [];
  try {
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) {
        try { entries.push(JSON.parse(line)); } catch { }
      }
    }
  } catch { }
  return entries;
}

function findJsonlFiles(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findJsonlFiles(fullPath));
      } else if (entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  } catch { }
  return results;
}

function fileNeedsReindex(db, filePath) {
  try {
    const stat = fs.statSync(filePath);
    const row = db.prepare('SELECT file_size, mtime_ms FROM indexed_files WHERE file_path = ?').get(filePath);
    if (!row) return true;
    return row.file_size !== stat.size || row.mtime_ms !== Math.floor(stat.mtimeMs);
  } catch {
    return true;
  }
}

function markFileIndexed(db, filePath) {
  try {
    const stat = fs.statSync(filePath);
    db.prepare('INSERT OR REPLACE INTO indexed_files (file_path, file_size, mtime_ms) VALUES (?, ?, ?)')
      .run(filePath, stat.size, Math.floor(stat.mtimeMs));
  } catch { }
}

function getOrCreateProject(db, encodedPath) {
  const existing = db.prepare('SELECT id FROM projects WHERE encoded_path = ?').get(encodedPath);
  if (existing) return existing.id;

  const name = getProjectName(encodedPath);
  const fullPath = decodeProjectPath(encodedPath);
  const result = db.prepare('INSERT INTO projects (encoded_path, name, full_path) VALUES (?, ?, ?)')
    .run(encodedPath, name, fullPath);
  return result.lastInsertRowid;
}

// PII patterns for redaction
const PII_PATTERNS = [
  { re: /sk-ant-[a-zA-Z0-9_-]{20,}/g, label: '[ANTHROPIC_KEY]' },
  { re: /sk-[a-zA-Z0-9]{20,}/g, label: '[API_KEY]' },
  { re: /AKIA[0-9A-Z]{16}/g, label: '[AWS_KEY]' },
  { re: /ghp_[a-zA-Z0-9]{36,}/g, label: '[GITHUB_TOKEN]' },
  { re: /gho_[a-zA-Z0-9]{36,}/g, label: '[GITHUB_TOKEN]' },
  { re: /glpat-[a-zA-Z0-9_-]{20,}/g, label: '[GITLAB_TOKEN]' },
  { re: /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, label: '[JWT]' },
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, label: '[PRIVATE_KEY]' },
  { re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, label: '[EMAIL]' },
  { re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, label: '[IP]' },
  { re: /xox[bpras]-[a-zA-Z0-9-]{10,}/g, label: '[SLACK_TOKEN]' },
];

function redactPII(text) {
  if (!text) return text;
  for (const { re, label } of PII_PATTERNS) {
    text = text.replace(re, label);
  }
  return text;
}

function getContentPreview(content) {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      return redactPII(block.text.substring(0, 200));
    }
  }
  return null;
}

function extractToolCalls(content) {
  if (!Array.isArray(content)) return [];
  const tools = [];
  for (const block of content) {
    if (block.type === 'tool_use' && block.name) {
      tools.push(block.name);
    }
  }
  return tools;
}

async function indexFile(db, filePath, projectId, isSubagent = false) {
  const entries = await readJsonlFile(filePath);

  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages (id, session_id, project_id, parent_uuid, type, model, timestamp, date,
      input_tokens, output_tokens, cache_read, cache_write, cost, has_tool_use, content_preview, agent_id, agent_slug)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertToolCall = db.prepare(`
    INSERT INTO tool_calls (message_id, session_id, project_id, tool_name, timestamp, date)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, project_id, first_timestamp, last_timestamp, message_count,
      total_input_tokens, total_output_tokens, total_cache_read, total_cache_write, total_cost, version, git_branch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_timestamp = CASE WHEN excluded.last_timestamp > sessions.last_timestamp THEN excluded.last_timestamp ELSE sessions.last_timestamp END,
      message_count = sessions.message_count + excluded.message_count,
      total_input_tokens = sessions.total_input_tokens + excluded.total_input_tokens,
      total_output_tokens = sessions.total_output_tokens + excluded.total_output_tokens,
      total_cache_read = sessions.total_cache_read + excluded.total_cache_read,
      total_cache_write = sessions.total_cache_write + excluded.total_cache_write,
      total_cost = sessions.total_cost + excluded.total_cost
  `);

  const upsertSubagent = db.prepare(`
    INSERT INTO subagents (id, session_id, project_id, agent_id, slug, parent_session_id,
      first_timestamp, last_timestamp, message_count,
      total_input_tokens, total_output_tokens, total_cache_read, total_cache_write, total_cost)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_timestamp = CASE WHEN excluded.last_timestamp > subagents.last_timestamp THEN excluded.last_timestamp ELSE subagents.last_timestamp END,
      message_count = subagents.message_count + excluded.message_count,
      total_input_tokens = subagents.total_input_tokens + excluded.total_input_tokens,
      total_output_tokens = subagents.total_output_tokens + excluded.total_output_tokens,
      total_cache_read = subagents.total_cache_read + excluded.total_cache_read,
      total_cache_write = subagents.total_cache_write + excluded.total_cache_write,
      total_cost = subagents.total_cost + excluded.total_cost
  `);

  let sessionTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, count: 0 };
  let sessionId = null;
  let firstTs = null;
  let lastTs = null;
  let version = null;
  let gitBranch = null;

  // Subagent tracking
  let agentId = null;
  let agentSlug = null;

  for (const entry of entries) {
    if (entry.type === 'file-history-snapshot') continue;

    sessionId = sessionId || entry.sessionId;
    version = version || entry.version;
    gitBranch = gitBranch || entry.gitBranch;
    agentId = agentId || entry.agentId;
    agentSlug = agentSlug || entry.slug;

    const ts = entry.timestamp;
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }

    if (!entry.uuid) continue;

    const msgType = entry.type;
    const model = entry.message?.model || null;
    const date = ts ? ts.split('T')[0] : null;
    const usage = entry.message?.usage || {};
    const content = entry.message?.content;

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    const cost = model ? calculateCost(usage, model) : 0;

    const toolCalls = msgType === 'assistant' ? extractToolCalls(content) : [];
    const hasToolUse = toolCalls.length > 0 ? 1 : 0;
    const preview = getContentPreview(content);

    insertMessage.run(
      entry.uuid, sessionId, projectId, entry.parentUuid || null,
      msgType, model, ts, date,
      inputTokens, outputTokens, cacheRead, cacheWrite, cost,
      hasToolUse, preview, agentId, agentSlug
    );

    for (const toolName of toolCalls) {
      insertToolCall.run(entry.uuid, sessionId, projectId, toolName, ts, date);
    }

    if (msgType === 'assistant') {
      sessionTokens.input += inputTokens;
      sessionTokens.output += outputTokens;
      sessionTokens.cacheRead += cacheRead;
      sessionTokens.cacheWrite += cacheWrite;
      sessionTokens.cost += cost;
      sessionTokens.count++;
    }
  }

  // Upsert session
  if (sessionId) {
    upsertSession.run(
      sessionId, projectId, firstTs, lastTs, sessionTokens.count,
      sessionTokens.input, sessionTokens.output,
      sessionTokens.cacheRead, sessionTokens.cacheWrite, sessionTokens.cost,
      version, gitBranch
    );
  }

  // Upsert subagent if this is a subagent file
  if (isSubagent && agentId && sessionId) {
    const subagentId = `${sessionId}:${agentId}`;
    upsertSubagent.run(
      subagentId, sessionId, projectId, agentId, agentSlug, sessionId,
      firstTs, lastTs, sessionTokens.count,
      sessionTokens.input, sessionTokens.output,
      sessionTokens.cacheRead, sessionTokens.cacheWrite, sessionTokens.cost
    );
  }
}

/**
 * Full incremental index of all Claude Code data.
 * Returns { indexed, skipped, total } counts.
 */
async function indexAll(onProgress) {
  const config = loadConfig();
  const projectsDir = path.join(config.claudeDir, 'projects');
  const db = openDb();

  let indexed = 0;
  let skipped = 0;
  let total = 0;

  let projectDirs = [];
  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    projectDirs = entries.filter(e => e.isDirectory());
  } catch {
    db.close();
    return { indexed: 0, skipped: 0, total: 0, error: 'Could not read projects directory' };
  }

  for (const projEntry of projectDirs) {
    const projectId = getOrCreateProject(db, projEntry.name);
    const projPath = path.join(projectsDir, projEntry.name);
    const allFiles = findJsonlFiles(projPath);

    for (const filePath of allFiles) {
      total++;
      if (!fileNeedsReindex(db, filePath)) {
        skipped++;
        continue;
      }

      const isSubagent = filePath.includes('/subagents/');

      await indexFile(db, filePath, projectId, isSubagent);
      markFileIndexed(db, filePath);
      indexed++;

      if (onProgress) onProgress({ indexed, skipped, total: allFiles.length, project: projEntry.name });
    }
  }

  db.close();
  return { indexed, skipped, total };
}

/**
 * Query helpers — all return plain objects, open/close db per call.
 */

function query(fn) {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function getSummary() {
  return query(db => {
    const config = loadConfig();
    const stats = db.prepare(`
      SELECT
        COUNT(DISTINCT project_id) as total_projects,
        COUNT(DISTINCT session_id) as total_sessions,
        COUNT(*) as total_messages,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(cache_read) as total_cache_read,
        SUM(cache_write) as total_cache_write,
        SUM(cost) as total_cost,
        MIN(timestamp) as first_activity,
        MAX(timestamp) as last_activity
      FROM messages WHERE type = 'assistant'
    `).get();

    const firstDate = stats.first_activity ? new Date(stats.first_activity) : new Date();
    const monthsActive = Math.max(1, Math.ceil((Date.now() - firstDate) / (30.44 * 24 * 60 * 60 * 1000)));

    return {
      ...stats,
      total_tokens: (stats.total_input_tokens || 0) + (stats.total_output_tokens || 0) +
                    (stats.total_cache_read || 0) + (stats.total_cache_write || 0),
      api_equivalent_cost: Math.round((stats.total_cost || 0) * 100) / 100,
      subscription: {
        plan: config.plan,
        monthlyRate: config.monthlyRate,
        monthsActive,
        actualCost: monthsActive * config.monthlyRate,
      },
    };
  });
}

function getProjects(options = {}) {
  return query(db => {
    let sql = `
      SELECT
        p.id, p.name, p.full_path,
        COUNT(DISTINCT m.session_id) as session_count,
        COUNT(*) as total_messages,
        SUM(m.input_tokens) as total_input_tokens,
        SUM(m.output_tokens) as total_output_tokens,
        SUM(m.cache_read) as total_cache_read,
        SUM(m.cache_write) as total_cache_write,
        SUM(m.cost) as total_cost,
        MIN(m.timestamp) as first_activity,
        MAX(m.timestamp) as last_activity
      FROM messages m
      JOIN projects p ON m.project_id = p.id
      WHERE m.type = 'assistant'
    `;
    const params = [];
    if (options.startDate) { sql += ' AND m.date >= ?'; params.push(options.startDate); }
    if (options.endDate) { sql += ' AND m.date <= ?'; params.push(options.endDate); }
    sql += ' GROUP BY p.id ORDER BY total_cost DESC';

    return db.prepare(sql).all(...params);
  });
}

function getDailyUsage(options = {}) {
  return query(db => {
    let sql = `
      SELECT
        date,
        COUNT(*) as messages,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cache_read) as cache_read,
        SUM(cache_write) as cache_write,
        SUM(cost) as cost
      FROM messages
      WHERE type = 'assistant' AND date IS NOT NULL
    `;
    const params = [];
    if (options.startDate) { sql += ' AND date >= ?'; params.push(options.startDate); }
    if (options.endDate) { sql += ' AND date <= ?'; params.push(options.endDate); }
    if (options.projectId) { sql += ' AND project_id = ?'; params.push(options.projectId); }
    sql += ' GROUP BY date ORDER BY date';

    return db.prepare(sql).all(...params);
  });
}

function getModelUsage(options = {}) {
  return query(db => {
    let sql = `
      SELECT
        model,
        COUNT(*) as messages,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cache_read) as cache_read,
        SUM(cache_write) as cache_write,
        SUM(cost) as cost
      FROM messages
      WHERE type = 'assistant' AND model IS NOT NULL
    `;
    const params = [];
    if (options.startDate) { sql += ' AND date >= ?'; params.push(options.startDate); }
    if (options.endDate) { sql += ' AND date <= ?'; params.push(options.endDate); }
    if (options.projectId) { sql += ' AND project_id = ?'; params.push(options.projectId); }
    sql += ' GROUP BY model ORDER BY cost DESC';

    return db.prepare(sql).all(...params);
  });
}

function getSessions(options = {}) {
  return query(db => {
    let sql = `
      SELECT
        s.id, s.project_id, p.name as project_name,
        s.first_timestamp, s.last_timestamp,
        s.message_count, s.total_input_tokens, s.total_output_tokens,
        s.total_cache_read, s.total_cache_write, s.total_cost,
        s.version, s.git_branch
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      WHERE 1=1
    `;
    const params = [];
    if (options.projectId) { sql += ' AND s.project_id = ?'; params.push(options.projectId); }
    if (options.startDate) { sql += ' AND s.first_timestamp >= ?'; params.push(options.startDate); }
    if (options.endDate) { sql += ' AND s.last_timestamp <= ?'; params.push(options.endDate + 'T23:59:59Z'); }
    sql += ' ORDER BY s.last_timestamp DESC';
    if (options.limit) { sql += ' LIMIT ?'; params.push(options.limit); }
    if (options.offset) { sql += ' OFFSET ?'; params.push(options.offset); }

    return db.prepare(sql).all(...params);
  });
}

function getSessionDetail(sessionId) {
  return query(db => {
    const session = db.prepare(`
      SELECT s.*, p.name as project_name, p.full_path as project_path
      FROM sessions s JOIN projects p ON s.project_id = p.id
      WHERE s.id = ?
    `).get(sessionId);

    if (!session) return null;

    const messages = db.prepare(`
      SELECT id, type, model, timestamp, input_tokens, output_tokens,
        cache_read, cache_write, cost, has_tool_use, content_preview, agent_id, agent_slug
      FROM messages WHERE session_id = ? ORDER BY timestamp
    `).all(sessionId);

    const toolCalls = db.prepare(`
      SELECT tool_name, COUNT(*) as count
      FROM tool_calls WHERE session_id = ?
      GROUP BY tool_name ORDER BY count DESC
    `).all(sessionId);

    const subagents = db.prepare(`
      SELECT * FROM subagents WHERE session_id = ?
    `).all(sessionId);

    return { session, messages, toolCalls, subagents };
  });
}

function getToolStats(options = {}) {
  return query(db => {
    let sql = `
      SELECT tool_name, COUNT(*) as count,
        COUNT(DISTINCT session_id) as sessions,
        COUNT(DISTINCT project_id) as projects
      FROM tool_calls WHERE 1=1
    `;
    const params = [];
    if (options.startDate) { sql += ' AND date >= ?'; params.push(options.startDate); }
    if (options.endDate) { sql += ' AND date <= ?'; params.push(options.endDate); }
    if (options.projectId) { sql += ' AND project_id = ?'; params.push(options.projectId); }
    sql += ' GROUP BY tool_name ORDER BY count DESC';

    return db.prepare(sql).all(...params);
  });
}

function getSubagents(options = {}) {
  return query(db => {
    let sql = `
      SELECT sa.*, p.name as project_name
      FROM subagents sa
      JOIN projects p ON sa.project_id = p.id
      WHERE 1=1
    `;
    const params = [];
    if (options.sessionId) { sql += ' AND sa.session_id = ?'; params.push(options.sessionId); }
    if (options.projectId) { sql += ' AND sa.project_id = ?'; params.push(options.projectId); }
    sql += ' ORDER BY sa.last_timestamp DESC';

    return db.prepare(sql).all(...params);
  });
}

function getProjectDailyTokens(options = {}) {
  return query(db => {
    let sql = `
      SELECT p.name as project_name, m.date,
        SUM(m.input_tokens + m.output_tokens + m.cache_read + m.cache_write) as tokens
      FROM messages m
      JOIN projects p ON m.project_id = p.id
      WHERE m.type = 'assistant' AND m.date IS NOT NULL
    `;
    const params = [];
    if (options.startDate) { sql += ' AND m.date >= ?'; params.push(options.startDate); }
    if (options.endDate) { sql += ' AND m.date <= ?'; params.push(options.endDate); }
    sql += ' GROUP BY p.name, m.date ORDER BY m.date';

    return db.prepare(sql).all(...params);
  });
}

function getInsights() {
  return query(db => {
    const insights = [];

    // 1. Cost spike detection — days with cost > 3x average
    const dailyAvg = db.prepare(`
      SELECT AVG(daily_cost) as avg_cost FROM (
        SELECT SUM(cost) as daily_cost FROM messages WHERE type='assistant' AND date IS NOT NULL GROUP BY date
      )
    `).get();

    if (dailyAvg.avg_cost > 0) {
      const spikes = db.prepare(`
        SELECT date, SUM(cost) as daily_cost FROM messages
        WHERE type='assistant' AND date IS NOT NULL
        GROUP BY date HAVING daily_cost > ?
        ORDER BY daily_cost DESC LIMIT 5
      `).all(dailyAvg.avg_cost * 3);

      for (const spike of spikes) {
        insights.push({
          type: 'cost_spike',
          severity: 'warning',
          title: `Cost spike on ${spike.date}`,
          detail: `$${spike.daily_cost.toFixed(2)} API value — ${(spike.daily_cost / dailyAvg.avg_cost).toFixed(1)}x your daily average`,
          date: spike.date,
        });
      }
    }

    // 2. Cache efficiency drops — projects with low cache hit rate
    const projectCache = db.prepare(`
      SELECT p.name,
        SUM(m.cache_read) as cache_read,
        SUM(m.input_tokens) as input_tokens,
        SUM(m.cache_read + m.input_tokens) as total_input
      FROM messages m JOIN projects p ON m.project_id = p.id
      WHERE m.type = 'assistant'
      GROUP BY p.id
      HAVING total_input > 100000
    `).all();

    for (const proj of projectCache) {
      const hitRate = proj.total_input > 0 ? (proj.cache_read / proj.total_input) * 100 : 0;
      if (hitRate < 50) {
        insights.push({
          type: 'low_cache',
          severity: 'info',
          title: `Low cache efficiency: ${proj.name}`,
          detail: `Only ${hitRate.toFixed(1)}% cache hit rate — consider longer sessions for better caching`,
        });
      }
    }

    // 3. Heaviest project detection
    const heaviest = db.prepare(`
      SELECT p.name, SUM(m.cost) as total_cost,
        ROUND(SUM(m.cost) * 100.0 / (SELECT SUM(cost) FROM messages WHERE type='assistant'), 1) as pct
      FROM messages m JOIN projects p ON m.project_id = p.id
      WHERE m.type='assistant'
      GROUP BY p.id ORDER BY total_cost DESC LIMIT 1
    `).get();

    if (heaviest && heaviest.pct > 50) {
      insights.push({
        type: 'concentration',
        severity: 'info',
        title: `${heaviest.name} dominates usage`,
        detail: `${heaviest.pct}% of all API value — $${heaviest.total_cost.toFixed(2)}`,
      });
    }

    // 4. Model diversity
    const modelCount = db.prepare(`
      SELECT COUNT(DISTINCT model) as count FROM messages
      WHERE type='assistant' AND model IS NOT NULL AND model != '<synthetic>'
    `).get();

    if (modelCount.count === 1) {
      const singleModel = db.prepare(`
        SELECT model FROM messages WHERE type='assistant' AND model IS NOT NULL AND model != '<synthetic>' LIMIT 1
      `).get();
      insights.push({
        type: 'single_model',
        severity: 'info',
        title: 'Single model usage',
        detail: `Only using ${singleModel.model}. Haiku could save costs on simpler tasks.`,
      });
    }

    // 5. Inactive projects
    const inactive = db.prepare(`
      SELECT p.name, MAX(m.timestamp) as last_active, SUM(m.cost) as total_cost
      FROM messages m JOIN projects p ON m.project_id = p.id
      WHERE m.type='assistant'
      GROUP BY p.id
      HAVING last_active < datetime('now', '-30 days') AND total_cost > 10
      ORDER BY total_cost DESC LIMIT 3
    `).all();

    for (const proj of inactive) {
      insights.push({
        type: 'inactive',
        severity: 'info',
        title: `Inactive project: ${proj.name}`,
        detail: `$${proj.total_cost.toFixed(2)} API value, last active ${new Date(proj.last_active).toLocaleDateString()}`,
      });
    }

    // 6. Cost forecasting — project current month to month-end
    const now = new Date();
    const currentMonth = now.toISOString().slice(0, 7);
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    const thisMonthCost = db.prepare(`
      SELECT SUM(cost) as c FROM messages WHERE type='assistant' AND date LIKE ?
    `).get(currentMonth + '%');

    if (thisMonthCost.c > 0) {
      const projected = (thisMonthCost.c / dayOfMonth) * daysInMonth;
      insights.push({
        type: 'forecast',
        severity: 'info',
        title: `${currentMonth} forecast: $${projected.toFixed(2)} API value`,
        detail: `$${thisMonthCost.c.toFixed(2)} so far (${dayOfMonth}/${daysInMonth} days). On track for $${projected.toFixed(2)} by month-end.`,
      });
    }

    // 7. Cache optimization recommendations
    for (const proj of projectCache) {
      const hitRate = proj.total_input > 0 ? (proj.cache_read / proj.total_input) * 100 : 0;
      const writeRatio = proj.total_input > 0 ? ((proj.input_tokens - proj.cache_read) / proj.total_input) * 100 : 0;

      if (hitRate >= 50 && hitRate < 80) {
        insights.push({
          type: 'cache_tip',
          severity: 'info',
          title: `Cache tip: ${proj.name} (${hitRate.toFixed(0)}% hit rate)`,
          detail: `Good but improvable. Avoid switching between many files — Claude caches recent context. Longer sessions help.`,
        });
      }
      if (writeRatio > 40 && proj.total_input > 500000) {
        insights.push({
          type: 'cache_churn',
          severity: 'warning',
          title: `High cache churn: ${proj.name}`,
          detail: `Context is being recreated frequently (${writeRatio.toFixed(0)}% uncached input). Try keeping sessions open longer and avoid rapid task switching.`,
        });
      }
    }

    // 8. 5-hour billing window analysis
    const recentMessages = db.prepare(`
      SELECT timestamp FROM messages WHERE type='assistant' AND timestamp IS NOT NULL
      ORDER BY timestamp DESC LIMIT 1
    `).get();

    if (recentMessages?.timestamp) {
      const lastMsg = new Date(recentMessages.timestamp);
      const windowStart = new Date(lastMsg);
      windowStart.setHours(windowStart.getHours() - 5);

      const windowUsage = db.prepare(`
        SELECT COUNT(*) as msgs, SUM(cost) as cost,
          SUM(input_tokens + output_tokens + cache_read + cache_write) as tokens
        FROM messages WHERE type='assistant' AND timestamp >= ?
      `).get(windowStart.toISOString());

      // Count distinct 5-hour windows today
      const todayStr = now.toISOString().slice(0, 10);
      const todayMessages = db.prepare(`
        SELECT timestamp FROM messages WHERE type='assistant' AND date = ? ORDER BY timestamp
      `).all(todayStr);

      let windowCount = 0;
      let windowEnd = null;
      for (const m of todayMessages) {
        const t = new Date(m.timestamp);
        if (!windowEnd || t > windowEnd) {
          windowCount++;
          windowEnd = new Date(t.getTime() + 5 * 60 * 60 * 1000);
        }
      }

      const windowRemaining = Math.max(0, (windowStart.getTime() + 5 * 60 * 60 * 1000 - Date.now()) / 60000);

      insights.push({
        type: 'billing_window',
        severity: windowRemaining < 30 ? 'warning' : 'info',
        title: `Current 5-hour billing window`,
        detail: `${windowUsage.msgs} messages, ${(windowUsage.tokens / 1e6).toFixed(2)}M tokens, $${(windowUsage.cost || 0).toFixed(2)} API value. ${windowRemaining > 0 ? Math.floor(windowRemaining) + ' min remaining in window.' : 'Window expired.'} ${windowCount > 0 ? windowCount + ' window(s) used today.' : ''}`,
      });
    }

    // 9. Cost per message trend — is it increasing?
    const recentDays = db.prepare(`
      SELECT date, SUM(cost) as cost, COUNT(*) as msgs
      FROM messages WHERE type='assistant' AND date IS NOT NULL
      GROUP BY date ORDER BY date DESC LIMIT 7
    `).all();

    if (recentDays.length >= 4) {
      const recentAvg = recentDays.slice(0, 3).reduce((s, d) => s + d.cost / d.msgs, 0) / 3;
      const olderAvg = recentDays.slice(3).reduce((s, d) => s + d.cost / d.msgs, 0) / Math.min(recentDays.length - 3, 4);
      if (olderAvg > 0 && recentAvg > olderAvg * 1.5) {
        insights.push({
          type: 'cost_trend',
          severity: 'warning',
          title: 'Cost per message increasing',
          detail: `Recent average: $${recentAvg.toFixed(3)}/msg vs earlier: $${olderAvg.toFixed(3)}/msg. This could mean more complex prompts or less cache hits.`,
        });
      }
    }

    return insights.sort((a, b) => {
      const order = { warning: 0, info: 1 };
      return (order[a.severity] || 2) - (order[b.severity] || 2);
    });
  });
}

/**
 * Full re-index: clears DB and re-indexes everything from scratch.
 */
async function reindexAll(onProgress) {
  const db = openDb();
  db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM tool_calls; DELETE FROM subagents; DELETE FROM indexed_files;');
  db.close();
  return indexAll(onProgress);
}

module.exports = {
  openDb, indexAll, reindexAll,
  getSummary, getProjects, getDailyUsage, getModelUsage,
  getSessions, getSessionDetail, getToolStats, getSubagents,
  getProjectDailyTokens, getInsights,
};
