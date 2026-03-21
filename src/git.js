/**
 * Git integration for Claude Radar.
 * Scans project repos, correlates commits with session costs.
 */

const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const { CONFIG_DIR } = require('./config');

const DB_PATH = path.join(CONFIG_DIR, 'radar.db');

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  return db;
}

function isGitRepo(dir) {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
}

function getGitLog(dir, since, until) {
  try {
    const args = ['-C', dir, 'log', '--format=%H|%ai|%an|%s'];
    if (since) args.push('--after=' + since);
    if (until) args.push('--before=' + until);
    const out = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean).map(line => {
      const [hash, date, author, ...msgParts] = line.split('|');
      return { hash, date, author, message: msgParts.join('|') };
    });
  } catch { return []; }
}

function getCommitStats(dir, hash) {
  try {
    const out = execFileSync('git', ['-C', dir, 'diff', '--shortstat', hash + '^..' + hash], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const files = (out.match(/(\d+) file/) || [, 0])[1];
    const insertions = (out.match(/(\d+) insertion/) || [, 0])[1];
    const deletions = (out.match(/(\d+) deletion/) || [, 0])[1];
    return { files_changed: Number(files), insertions: Number(insertions), deletions: Number(deletions) };
  } catch { return { files_changed: 0, insertions: 0, deletions: 0 }; }
}

function getBranches(dir, hash) {
  try {
    const out = execFileSync('git', ['-C', dir, 'branch', '--contains', hash, '--format=%(refname:short)'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return out.split('\n').filter(Boolean);
  } catch { return []; }
}

/**
 * Index git commits for all projects and correlate with sessions.
 */
function indexGitData() {
  const db = openDb();

  // Create git tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS git_commits (
      hash TEXT PRIMARY KEY,
      project_id INTEGER,
      session_id TEXT,
      date TEXT,
      author TEXT,
      message TEXT,
      branch TEXT,
      files_changed INTEGER DEFAULT 0,
      insertions INTEGER DEFAULT 0,
      deletions INTEGER DEFAULT 0,
      estimated_cost REAL DEFAULT 0,
      cost_share REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_git_project ON git_commits(project_id);
    CREATE INDEX IF NOT EXISTS idx_git_session ON git_commits(session_id);
    CREATE INDEX IF NOT EXISTS idx_git_date ON git_commits(date);
    CREATE INDEX IF NOT EXISTS idx_git_branch ON git_commits(branch);
  `);

  const projects = db.prepare('SELECT id, name, full_path FROM projects').all();
  const insertCommit = db.prepare(`
    INSERT OR REPLACE INTO git_commits (hash, project_id, session_id, date, author, message, branch, files_changed, insertions, deletions, estimated_cost, cost_share)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalCommits = 0;
  let linkedCommits = 0;

  for (const project of projects) {
    if (!isGitRepo(project.full_path)) continue;

    // Get all sessions for this project — use messages table for accurate costs
    const sessions = db.prepare(`
      SELECT s.id, s.first_timestamp, s.last_timestamp, s.message_count,
        COALESCE(m.actual_cost, 0) as total_cost
      FROM sessions s
      LEFT JOIN (
        SELECT session_id, SUM(cost) as actual_cost
        FROM messages WHERE type='assistant'
        GROUP BY session_id
      ) m ON m.session_id = s.id
      WHERE s.project_id = ? AND m.actual_cost > 0
      ORDER BY s.first_timestamp
    `).all(project.id);

    // Get all commits for this project
    const allCommits = getGitLog(project.full_path);

    for (const commit of allCommits) {
      totalCommits++;
      const commitDate = new Date(commit.date);

      // Find which session this commit belongs to (by timestamp overlap)
      let matchedSession = null;
      for (const s of sessions) {
        const sStart = new Date(s.first_timestamp);
        const sEnd = new Date(s.last_timestamp);
        // Add 5 min buffer on both sides
        sStart.setMinutes(sStart.getMinutes() - 5);
        sEnd.setMinutes(sEnd.getMinutes() + 5);

        if (commitDate >= sStart && commitDate <= sEnd) {
          matchedSession = s;
          break;
        }
      }

      // Get commit stats (lines changed)
      const stats = getCommitStats(project.full_path, commit.hash);

      // Get primary branch
      const branches = getBranches(project.full_path, commit.hash);
      const branch = branches[0] || 'unknown';

      // Calculate cost share
      let estimatedCost = 0;
      let costShare = 0;
      if (matchedSession) {
        linkedCommits++;
        // Count how many commits fall in this session
        const sessionCommits = allCommits.filter(c => {
          const cd = new Date(c.date);
          const sStart = new Date(matchedSession.first_timestamp);
          const sEnd = new Date(matchedSession.last_timestamp);
          sStart.setMinutes(sStart.getMinutes() - 5);
          sEnd.setMinutes(sEnd.getMinutes() + 5);
          return cd >= sStart && cd <= sEnd;
        });
        costShare = sessionCommits.length > 0 ? 1 / sessionCommits.length : 0;
        estimatedCost = (matchedSession.total_cost || 0) * costShare;
      }

      insertCommit.run(
        commit.hash, project.id, matchedSession?.id || null,
        commit.date, commit.author, commit.message, branch,
        stats.files_changed, stats.insertions, stats.deletions,
        estimatedCost, costShare
      );
    }
  }

  db.close();
  return { totalCommits, linkedCommits };
}

/**
 * Query functions for git data.
 */

function query(fn) {
  const db = openDb();
  try { return fn(db); } finally { db.close(); }
}

function getGitSummary() {
  return query(db => {
    try {
      const total = db.prepare('SELECT COUNT(*) as c FROM git_commits').get();
      const linked = db.prepare('SELECT COUNT(*) as c FROM git_commits WHERE session_id IS NOT NULL').get();
      const totalCost = db.prepare('SELECT SUM(estimated_cost) as c FROM git_commits WHERE session_id IS NOT NULL').get();
      const totalInsertions = db.prepare('SELECT SUM(insertions) as c FROM git_commits').get();
      const totalDeletions = db.prepare('SELECT SUM(deletions) as c FROM git_commits').get();
      const avgCostPerCommit = db.prepare('SELECT AVG(estimated_cost) as c FROM git_commits WHERE estimated_cost > 0').get();

      return {
        totalCommits: total.c,
        linkedCommits: linked.c,
        unlinkedCommits: total.c - linked.c,
        totalCost: totalCost.c || 0,
        totalInsertions: totalInsertions.c || 0,
        totalDeletions: totalDeletions.c || 0,
        avgCostPerCommit: avgCostPerCommit.c || 0,
        costPerLine: (totalCost.c || 0) / Math.max((totalInsertions.c || 0) + (totalDeletions.c || 0), 1),
      };
    } catch {
      return { totalCommits: 0, linkedCommits: 0, unlinkedCommits: 0, totalCost: 0, totalInsertions: 0, totalDeletions: 0, avgCostPerCommit: 0, costPerLine: 0 };
    }
  });
}

function getGitByProject(options = {}) {
  return query(db => {
    try {
      let sql = `
        SELECT p.name as project_name, p.id as project_id,
          COUNT(*) as commits,
          SUM(CASE WHEN g.session_id IS NOT NULL THEN 1 ELSE 0 END) as linked_commits,
          SUM(g.estimated_cost) as total_cost,
          SUM(g.insertions) as insertions,
          SUM(g.deletions) as deletions,
          SUM(g.files_changed) as files_changed,
          MIN(g.date) as first_commit,
          MAX(g.date) as last_commit
        FROM git_commits g
        JOIN projects p ON g.project_id = p.id
        WHERE 1=1
      `;
      const params = [];
      if (options.startDate) { sql += ' AND g.date >= ?'; params.push(options.startDate); }
      if (options.endDate) { sql += ' AND g.date <= ?'; params.push(options.endDate + 'T23:59:59'); }
      sql += ' GROUP BY p.id ORDER BY total_cost DESC';
      return db.prepare(sql).all(...params);
    } catch { return []; }
  });
}

function getGitByBranch(options = {}) {
  return query(db => {
    try {
      let sql = `
        SELECT branch, p.name as project_name,
          COUNT(*) as commits,
          SUM(g.estimated_cost) as total_cost,
          SUM(g.insertions) as insertions,
          SUM(g.deletions) as deletions,
          MIN(g.date) as first_commit,
          MAX(g.date) as last_commit
        FROM git_commits g
        JOIN projects p ON g.project_id = p.id
        WHERE g.estimated_cost > 0
      `;
      const params = [];
      if (options.projectId) { sql += ' AND g.project_id = ?'; params.push(options.projectId); }
      if (options.startDate) { sql += ' AND g.date >= ?'; params.push(options.startDate); }
      if (options.endDate) { sql += ' AND g.date <= ?'; params.push(options.endDate + 'T23:59:59'); }
      sql += ' GROUP BY branch, p.id ORDER BY total_cost DESC';
      return db.prepare(sql).all(...params);
    } catch { return []; }
  });
}

function getGitCommits(options = {}) {
  return query(db => {
    try {
      let sql = `
        SELECT g.*, p.name as project_name
        FROM git_commits g
        JOIN projects p ON g.project_id = p.id
        WHERE 1=1
      `;
      const params = [];
      if (options.projectId) { sql += ' AND g.project_id = ?'; params.push(options.projectId); }
      if (options.sessionId) { sql += ' AND g.session_id = ?'; params.push(options.sessionId); }
      if (options.branch) { sql += ' AND g.branch = ?'; params.push(options.branch); }
      if (options.startDate) { sql += ' AND g.date >= ?'; params.push(options.startDate); }
      if (options.endDate) { sql += ' AND g.date <= ?'; params.push(options.endDate + 'T23:59:59'); }
      sql += ' ORDER BY g.date DESC';
      if (options.limit) { sql += ' LIMIT ?'; params.push(options.limit); }
      return db.prepare(sql).all(...params);
    } catch { return []; }
  });
}

function getGitTimeline(options = {}) {
  return query(db => {
    try {
      let sql = `
        SELECT g.date, g.project_id, p.name as project_name,
          COUNT(*) as commits,
          SUM(g.estimated_cost) as cost,
          SUM(g.insertions) as insertions,
          SUM(g.deletions) as deletions
        FROM git_commits g
        JOIN projects p ON g.project_id = p.id
        WHERE 1=1
      `;
      const params = [];
      if (options.startDate) { sql += ' AND g.date >= ?'; params.push(options.startDate); }
      if (options.endDate) { sql += ' AND g.date <= ?'; params.push(options.endDate + 'T23:59:59'); }
      sql += ' GROUP BY substr(g.date, 1, 10), p.id ORDER BY g.date';
      return db.prepare(sql).all(...params);
    } catch { return []; }
  });
}

function getMostExpensiveCommits(limit = 20) {
  return query(db => {
    try {
      return db.prepare(`
        SELECT g.*, p.name as project_name
        FROM git_commits g
        JOIN projects p ON g.project_id = p.id
        WHERE g.estimated_cost > 0
        ORDER BY g.estimated_cost DESC
        LIMIT ?
      `).all(limit);
    } catch { return []; }
  });
}

module.exports = {
  indexGitData, getGitSummary, getGitByProject, getGitByBranch,
  getGitCommits, getGitTimeline, getMostExpensiveCommits,
};
