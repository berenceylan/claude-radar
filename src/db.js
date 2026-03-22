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

  // Bookmarks table (v2.2)
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY,
      session_id TEXT UNIQUE,
      label TEXT,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Schema migrations for v2.2 — new JSONL fields
  try { db.exec('ALTER TABLE messages ADD COLUMN speed TEXT'); } catch {}
  try { db.exec('ALTER TABLE messages ADD COLUMN web_search_count INTEGER DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE messages ADD COLUMN web_fetch_count INTEGER DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE messages ADD COLUMN is_sidechain INTEGER DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE sessions ADD COLUMN permission_mode TEXT'); } catch {}
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
  { re: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, label: '[IP]' },
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
      input_tokens, output_tokens, cache_read, cache_write, cost, has_tool_use, content_preview, agent_id, agent_slug,
      speed, web_search_count, web_fetch_count, is_sidechain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  const updateSessionPermission = db.prepare(`
    UPDATE sessions SET permission_mode = ? WHERE id = ?
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

    // Extract new v2.2 fields
    const speed = usage.speed || null;
    const serverToolUse = usage.server_tool_use || {};
    const webSearchCount = serverToolUse.web_search_requests || 0;
    const webFetchCount = serverToolUse.web_fetch_requests || 0;
    const isSidechain = entry.isSidechain ? 1 : 0;

    insertMessage.run(
      entry.uuid, sessionId, projectId, entry.parentUuid || null,
      msgType, model, ts, date,
      inputTokens, outputTokens, cacheRead, cacheWrite, cost,
      hasToolUse, preview, agentId, agentSlug,
      speed, webSearchCount, webFetchCount, isSidechain
    );

    for (const toolName of toolCalls) {
      insertToolCall.run(entry.uuid, sessionId, projectId, toolName, ts, date);
    }

    // Extract permission mode from user messages
    if (msgType === 'user' && entry.permissionMode && sessionId) {
      updateSessionPermission.run(entry.permissionMode, sessionId);
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
        s.version, s.git_branch, s.permission_mode,
        ROUND((julianday(s.last_timestamp) - julianday(s.first_timestamp)) * 24 * 60, 1) as duration_minutes
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

    const rows = db.prepare(sql).all(...params);
    return rows.map(row => {
      const durationHours = (row.duration_minutes || 0) / 60;
      return {
        ...row,
        cost_per_hour: durationHours > 0 ? row.total_cost / durationHours : 0,
        messages_per_hour: durationHours > 0 ? row.message_count / durationHours : 0,
      };
    });
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
 * Validates that the Claude data directory exists before clearing.
 */
async function reindexAll(onProgress) {
  const config = loadConfig();
  const projectsDir = path.join(config.claudeDir, 'projects');

  // Safety: don't clear DB if source directory doesn't exist
  if (!fs.existsSync(projectsDir)) {
    return { indexed: 0, skipped: 0, total: 0, error: 'Claude projects directory not found: ' + projectsDir };
  }

  const db = openDb();
  db.exec('DELETE FROM messages; DELETE FROM sessions; DELETE FROM tool_calls; DELETE FROM subagents; DELETE FROM indexed_files;');
  db.close();
  return indexAll(onProgress);
}

function getWindowStats() {
  return query(db => {
    const result = { billingWindow: null };
    const now = new Date();
    const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);

    // Get usage in the rolling 5h window
    const usage = db.prepare(`
      SELECT COUNT(*) as msgs, COALESCE(SUM(cost),0) as cost,
        COALESCE(SUM(input_tokens),0) as input_tokens,
        COALESCE(SUM(output_tokens),0) as output_tokens,
        COALESCE(SUM(cache_read),0) as cache_read,
        COALESCE(SUM(cache_write),0) as cache_write
      FROM messages WHERE type='assistant' AND timestamp >= ?
    `).get(fiveHoursAgo.toISOString());

    if (!usage || usage.msgs === 0) return result;

    // Find first and last activity in this window
    const firstMsg = db.prepare(`
      SELECT timestamp FROM messages WHERE type='assistant' AND timestamp >= ?
      ORDER BY timestamp ASC LIMIT 1
    `).get(fiveHoursAgo.toISOString());

    const lastMsg = db.prepare(`
      SELECT timestamp FROM messages WHERE type='assistant' AND timestamp >= ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(fiveHoursAgo.toISOString());

    const firstTime = new Date(firstMsg.timestamp);
    const lastTime = new Date(lastMsg.timestamp);

    // "Resets at" = when the first message in this window ages out of the 5h window
    const resetsAt = new Date(firstTime.getTime() + 5 * 60 * 60 * 1000);
    const resetsInMin = Math.max(0, Math.floor((resetsAt.getTime() - now.getTime()) / 60000));

    // Time elapsed since first activity in this window
    const elapsedMin = Math.floor((now.getTime() - firstTime.getTime()) / 60000);

    // Active time span (first msg to last msg)
    const activeSpanMin = Math.floor((lastTime.getTime() - firstTime.getTime()) / 60000);

    const outputTokens = usage.output_tokens || 0;
    const inputTokens = usage.input_tokens || 0;

    result.billingWindow = {
      msgs: usage.msgs,
      inputTokens,
      outputTokens,
      cacheRead: usage.cache_read || 0,
      cost: usage.cost,
      // Timing
      firstActivity: firstTime.toISOString(),
      lastActivity: lastTime.toISOString(),
      elapsedMin,
      activeSpanMin,
      resetsAt: resetsAt.toISOString(),
      resetsInMin,
    };
    return result;
  });
}

function calculateEfficiency(session) {
  const inputTok = session.total_input_tokens || 0;
  const outputTok = session.total_output_tokens || 0;
  const cacheRead = session.total_cache_read || 0;

  // Factor 1: Output/Input ratio (30% weight)
  const ioRatio = outputTok / Math.max(inputTok, 1);
  const ioScore = Math.min(ioRatio / 0.5, 1);

  // Factor 2: Cache hit rate (40% weight)
  const totalInput = inputTok + cacheRead;
  const cacheRate = totalInput > 0 ? cacheRead / totalInput : 0;
  const cacheScore = cacheRate;

  // Factor 3: Cost per message (30% weight)
  const costPerMsg = session.message_count > 0 ? (session.total_cost || 0) / session.message_count : 1;
  const costScore = Math.max(0, 1 - costPerMsg / 0.5);

  const score = ioScore * 0.3 + cacheScore * 0.4 + costScore * 0.3;
  const grades = ['F', 'D', 'C', 'B', 'A'];
  const grade = grades[Math.min(Math.floor(score * 5), 4)];
  return { score: Math.round(score * 100), grade };
}

function getBudgetStatus() {
  return query(db => {
    const config = loadConfig();
    const budget = config.monthlyBudget;
    if (!budget) return { enabled: false };

    const now = new Date();
    const monthPrefix = now.toISOString().slice(0, 7); // "2026-03"

    const usage = db.prepare(`
      SELECT COALESCE(SUM(cost), 0) as month_cost,
             COUNT(*) as month_msgs
      FROM messages WHERE type = 'assistant' AND date LIKE ?
    `).get(monthPrefix + '%');

    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const dailyRate = dayOfMonth > 0 ? usage.month_cost / dayOfMonth : 0;
    const projected = dailyRate * daysInMonth;

    return {
      enabled: true,
      budget,
      spent: usage.month_cost,
      remaining: Math.max(0, budget - usage.month_cost),
      pct: Math.min(100, (usage.month_cost / budget) * 100),
      dailyRate,
      projected,
      daysLeft: daysInMonth - dayOfMonth,
    };
  });
}

function getHourlyActivity(options = {}) {
  return query(db => {
    let where = "WHERE type = 'assistant' AND timestamp IS NOT NULL";
    const params = [];
    if (options.startDate) { where += ' AND date >= ?'; params.push(options.startDate); }
    if (options.endDate) { where += ' AND date <= ?'; params.push(options.endDate); }

    return db.prepare(`
      SELECT
        CAST(strftime('%w', timestamp) AS INTEGER) as day_of_week,
        CAST(strftime('%H', timestamp) AS INTEGER) as hour,
        COUNT(*) as messages,
        COALESCE(SUM(cost), 0) as cost
      FROM messages ${where}
      GROUP BY day_of_week, hour
      ORDER BY day_of_week, hour
    `).all(...params);
  });
}

function getPeriodComparison(currentStart, currentEnd, prevStart, prevEnd) {
  return query(db => {
    const q = `SELECT COALESCE(SUM(cost),0) as cost, COUNT(*) as msgs,
      COUNT(DISTINCT session_id) as sessions,
      COALESCE(SUM(input_tokens),0) as input_tokens,
      COALESCE(SUM(output_tokens),0) as output_tokens
      FROM messages WHERE type='assistant' AND date BETWEEN ? AND ?`;
    const current = db.prepare(q).get(currentStart, currentEnd);
    const previous = db.prepare(q).get(prevStart, prevEnd);
    return { current, previous };
  });
}

// ── Feature 9: Model Recommendation Engine ──────────────
function getModelRecommendations() {
  return query(db => {
    const pricing = require('./pricing');
    const haikuPricing = pricing.getPricing('claude-haiku-4-5-20251001');

    // Find sessions using expensive models with simple patterns
    const sessions = db.prepare(`
      SELECT s.id as session_id, s.message_count, s.total_cost,
        s.total_input_tokens, s.total_output_tokens,
        s.total_cache_read, s.total_cache_write,
        p.name as project_name
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      WHERE s.message_count < 10 AND s.total_cost > 0
    `).all();

    const recommendations = [];
    let totalSavings = 0;

    for (const sess of sessions) {
      // Get the dominant model for this session
      const modelRow = db.prepare(`
        SELECT model, COUNT(*) as cnt FROM messages
        WHERE session_id = ? AND type = 'assistant' AND model IS NOT NULL
        GROUP BY model ORDER BY cnt DESC LIMIT 1
      `).get(sess.session_id);

      if (!modelRow || !modelRow.model) continue;
      const model = modelRow.model;

      // Only recommend for expensive models (opus/sonnet)
      if (!model.includes('opus') && !model.includes('sonnet')) continue;

      // Check tool usage — only simple tools (Read, Grep, Glob)
      const tools = db.prepare(`
        SELECT tool_name, COUNT(*) as cnt FROM tool_calls
        WHERE session_id = ?
        GROUP BY tool_name
      `).all(sess.session_id);

      const simpleTools = new Set(['Read', 'Grep', 'Glob']);
      const hasComplexTools = tools.some(t => !simpleTools.has(t.tool_name));
      if (hasComplexTools) continue;

      // Check output tokens are low (< 5000)
      if (sess.total_output_tokens > 5000) continue;

      // Calculate projected cost with haiku
      const projectedCost =
        (sess.total_input_tokens / 1_000_000) * haikuPricing.input +
        (sess.total_output_tokens / 1_000_000) * haikuPricing.output +
        (sess.total_cache_read / 1_000_000) * haikuPricing.cacheRead +
        (sess.total_cache_write / 1_000_000) * haikuPricing.cacheWrite;

      const savings = sess.total_cost - projectedCost;
      if (savings <= 0) continue;

      totalSavings += savings;
      recommendations.push({
        sessionId: sess.session_id,
        projectName: sess.project_name,
        currentModel: model,
        suggestedModel: 'claude-haiku-4-5-20251001',
        currentCost: sess.total_cost,
        projectedCost,
        savings,
        reason: `Simple session (${sess.message_count} messages, read-only tools, low output) — Haiku would suffice`,
      });
    }

    recommendations.sort((a, b) => b.savings - a.savings);
    return { recommendations, totalSavings };
  });
}

// ── Feature 10: Session Clustering ──────────────────────
function getSessionClusters() {
  return query(db => {
    // Get tool usage per session
    const sessionTools = db.prepare(`
      SELECT tc.session_id, tc.tool_name, COUNT(*) as cnt
      FROM tool_calls tc
      GROUP BY tc.session_id, tc.tool_name
    `).all();

    // Group tools by session
    const toolsBySession = {};
    for (const row of sessionTools) {
      if (!toolsBySession[row.session_id]) toolsBySession[row.session_id] = {};
      toolsBySession[row.session_id][row.tool_name] = row.cnt;
    }

    // Get session metadata
    const sessions = db.prepare(`
      SELECT s.id, s.message_count, s.total_cost, p.name as project_name
      FROM sessions s JOIN projects p ON s.project_id = p.id
      WHERE s.total_cost > 0
    `).all();

    // Classify each session
    const clusters = {};
    const clusterTypes = ['bug-fixing', 'exploration', 'greenfield', 'refactoring', 'testing', 'review', 'other'];
    for (const type of clusterTypes) {
      clusters[type] = { type, sessions: 0, totalCost: 0, totalMessages: 0 };
    }

    for (const sess of sessions) {
      const tools = toolsBySession[sess.id] || {};
      const total = Object.values(tools).reduce((s, v) => s + v, 0) || 1;

      const grep = (tools['Grep'] || 0) / total;
      const read = (tools['Read'] || 0) / total;
      const edit = (tools['Edit'] || 0) / total;
      const write = (tools['Write'] || 0) / total;
      const bash = (tools['Bash'] || 0) / total;

      let type;
      if (grep > 0.2 && read > 0.2 && edit > 0.15) {
        type = 'bug-fixing';
      } else if (read > 0.3 && grep > 0.2 && edit < 0.1) {
        type = 'exploration';
      } else if (write > 0.2 && bash > 0.15) {
        type = 'greenfield';
      } else if (edit > 0.3 && read > 0.2) {
        type = 'refactoring';
      } else if (bash > 0.4) {
        type = 'testing';
      } else if (read > 0.5 && edit < 0.05) {
        type = 'review';
      } else {
        type = 'other';
      }

      clusters[type].sessions++;
      clusters[type].totalCost += sess.total_cost || 0;
      clusters[type].totalMessages += sess.message_count || 0;
    }

    // Calculate averages and filter empty clusters
    const result = Object.values(clusters)
      .filter(c => c.sessions > 0)
      .map(c => ({
        ...c,
        avgCostPerSession: c.sessions > 0 ? c.totalCost / c.sessions : 0,
      }));

    return { clusters: result };
  });
}

// ── Feature 15: Subagent Cost Tree ──────────────────────
function getSubagentTree() {
  return query(db => {
    // Get sessions that have subagents
    const sessionsWithSubs = db.prepare(`
      SELECT DISTINCT sa.session_id, s.total_cost as session_cost, p.name as project_name
      FROM subagents sa
      JOIN sessions s ON sa.session_id = s.id
      JOIN projects p ON s.project_id = p.id
      ORDER BY s.last_timestamp DESC
    `).all();

    const result = [];
    for (const sess of sessionsWithSubs) {
      const subs = db.prepare(`
        SELECT slug, total_cost as cost, message_count as messages
        FROM subagents WHERE session_id = ?
        ORDER BY total_cost DESC
      `).all(sess.session_id);

      result.push({
        sessionId: sess.session_id,
        projectName: sess.project_name,
        sessionCost: sess.session_cost || 0,
        subagents: subs,
      });
    }

    return { sessions: result };
  });
}

// ── Feature 16: Session Bookmarks ───────────────────────
function addBookmark(sessionId, label, note) {
  return query(db => {
    db.prepare(`
      INSERT OR REPLACE INTO bookmarks (session_id, label, note, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(sessionId, label || null, note || null);
    return { ok: true };
  });
}

function removeBookmark(sessionId) {
  return query(db => {
    db.prepare('DELETE FROM bookmarks WHERE session_id = ?').run(sessionId);
    return { ok: true };
  });
}

function getBookmarks() {
  return query(db => {
    return db.prepare(`
      SELECT b.*, s.message_count, s.total_cost, s.first_timestamp, s.last_timestamp,
        p.name as project_name
      FROM bookmarks b
      LEFT JOIN sessions s ON b.session_id = s.id
      LEFT JOIN projects p ON s.project_id = p.id
      ORDER BY b.created_at DESC
    `).all();
  });
}

// ── Feature 18: Streak/Achievement System ───────────────
function getAchievements() {
  return query(db => {
    const achievements = [];

    // Helper to get earned date from a query
    const totalSessions = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
    const totalTokens = db.prepare(`
      SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read + cache_write), 0) as c
      FROM messages WHERE type = 'assistant'
    `).get().c;

    // Cache hit rate
    const cacheStats = db.prepare(`
      SELECT COALESCE(SUM(cache_read), 0) as cache_read,
        COALESCE(SUM(input_tokens + cache_read), 0) as total_input
      FROM messages WHERE type = 'assistant'
    `).get();
    const cacheHitRate = cacheStats.total_input > 0 ? (cacheStats.cache_read / cacheStats.total_input) * 100 : 0;

    // Longest session duration
    const longestSession = db.prepare(`
      SELECT id, ROUND((julianday(last_timestamp) - julianday(first_timestamp)) * 24, 2) as hours
      FROM sessions WHERE first_timestamp IS NOT NULL AND last_timestamp IS NOT NULL
      ORDER BY hours DESC LIMIT 1
    `).get();

    // Most messages in a single session
    const maxMessages = db.prepare(`
      SELECT id, message_count FROM sessions ORDER BY message_count DESC LIMIT 1
    `).get();

    // Model count
    const modelCount = db.prepare(`
      SELECT COUNT(DISTINCT model) as c FROM messages
      WHERE type = 'assistant' AND model IS NOT NULL AND model != '<synthetic>'
    `).get().c;

    // Consecutive active days (streak)
    const activeDays = db.prepare(`
      SELECT DISTINCT date FROM messages
      WHERE type = 'assistant' AND date IS NOT NULL
      ORDER BY date
    `).all().map(r => r.date);

    let maxStreak = 0;
    let currentStreak = 0;
    for (let i = 0; i < activeDays.length; i++) {
      if (i === 0) {
        currentStreak = 1;
      } else {
        const prev = new Date(activeDays[i - 1]);
        const curr = new Date(activeDays[i]);
        const diff = (curr - prev) / (24 * 60 * 60 * 1000);
        if (diff === 1) {
          currentStreak++;
        } else {
          currentStreak = 1;
        }
      }
      if (currentStreak > maxStreak) maxStreak = currentStreak;
    }

    // Budget hawk — check if stayed under budget for full previous month
    const config = loadConfig();
    const now = new Date();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthStr = prevMonth.toISOString().slice(0, 7);
    const prevMonthCost = db.prepare(`
      SELECT COALESCE(SUM(cost), 0) as c FROM messages WHERE type = 'assistant' AND date LIKE ?
    `).get(prevMonthStr + '%').c;
    const budgetHawk = config.monthlyBudget && prevMonthCost > 0 && prevMonthCost <= config.monthlyBudget;

    // ROI calculation
    const summary = db.prepare(`
      SELECT COALESCE(SUM(cost), 0) as total_cost FROM messages WHERE type = 'assistant'
    `).get();
    const monthsActive = Math.max(1, activeDays.length / 30);
    const actualCost = monthsActive * (config.monthlyRate || 0);
    const roi = actualCost > 0 ? summary.total_cost / actualCost : 0;

    // First session date
    const firstSession = db.prepare(`
      SELECT first_timestamp FROM sessions ORDER BY first_timestamp ASC LIMIT 1
    `).get();

    // Build achievements list
    achievements.push({
      id: 'first_session', name: 'First Session', icon: '🎯',
      description: 'Complete your first Claude Code session',
      earned: totalSessions >= 1,
      earnedDate: firstSession?.first_timestamp || null,
    });

    achievements.push({
      id: 'power_user', name: 'Power User', icon: '🚀',
      description: 'Complete 100+ sessions',
      earned: totalSessions >= 100,
      earnedDate: totalSessions >= 100 ? (db.prepare('SELECT first_timestamp FROM sessions ORDER BY first_timestamp ASC LIMIT 1 OFFSET 99').get()?.first_timestamp || null) : null,
    });

    achievements.push({
      id: 'token_millionaire', name: 'Token Millionaire', icon: '💰',
      description: 'Use 1M+ total tokens',
      earned: totalTokens >= 1_000_000,
      earnedDate: totalTokens >= 1_000_000 ? (firstSession?.first_timestamp || null) : null,
    });

    achievements.push({
      id: 'token_billionaire', name: 'Token Billionaire', icon: '💎',
      description: 'Use 1B+ total tokens',
      earned: totalTokens >= 1_000_000_000,
      earnedDate: null,
    });

    achievements.push({
      id: 'cache_master', name: 'Cache Master', icon: '🧠',
      description: 'Achieve 80%+ cache hit rate',
      earned: cacheHitRate >= 80,
      earnedDate: null,
    });

    achievements.push({
      id: 'marathon', name: 'Marathon', icon: '🏆',
      description: 'Have a session longer than 2 hours',
      earned: (longestSession?.hours || 0) >= 2,
      earnedDate: null,
    });

    achievements.push({
      id: 'speed_demon', name: 'Speed Demon', icon: '⚡',
      description: '50+ messages in a single session',
      earned: (maxMessages?.message_count || 0) >= 50,
      earnedDate: null,
    });

    achievements.push({
      id: 'polyglot', name: 'Polyglot', icon: '🌟',
      description: 'Use 3+ different models',
      earned: modelCount >= 3,
      earnedDate: null,
    });

    achievements.push({
      id: 'week_streak', name: 'Week Streak', icon: '🔥',
      description: '7 consecutive active days',
      earned: maxStreak >= 7,
      earnedDate: null,
    });

    achievements.push({
      id: 'month_streak', name: 'Month Streak', icon: '🎖️',
      description: '30 consecutive active days',
      earned: maxStreak >= 30,
      earnedDate: null,
    });

    achievements.push({
      id: 'budget_hawk', name: 'Budget Hawk', icon: '🎯',
      description: 'Stay under budget for a full month',
      earned: !!budgetHawk,
      earnedDate: budgetHawk ? prevMonthStr + '-28' : null,
    });

    achievements.push({
      id: 'roi_king', name: 'ROI King', icon: '🚀',
      description: '10x+ ROI (API value vs subscription cost)',
      earned: roi >= 10,
      earnedDate: null,
    });

    return { achievements };
  });
}

module.exports = {
  openDb, indexAll, reindexAll,
  getSummary, getProjects, getDailyUsage, getModelUsage,
  getSessions, getSessionDetail, getToolStats, getSubagents,
  getProjectDailyTokens, getInsights, getWindowStats,
  calculateEfficiency, getBudgetStatus, getHourlyActivity, getPeriodComparison,
  getModelRecommendations, getSessionClusters, getSubagentTree,
  addBookmark, removeBookmark, getBookmarks, getAchievements,
};
