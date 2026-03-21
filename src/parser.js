/**
 * Claude Code usage data parser.
 * Reads ~/.claude/ data files and returns structured usage data.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { calculateCost, SUBSCRIPTION_PLANS } = require('./pricing');

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
    if (!GENERIC_DIRS.has(parent)) {
      return `${parent}/${last}`;
    }
  }
  return last;
}

async function readJsonlFile(filePath) {
  const entries = [];
  try {
    const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) {
        try { entries.push(JSON.parse(line)); } catch { /* skip */ }
      }
    }
  } catch { /* file might not exist */ }
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
  } catch { /* skip inaccessible */ }
  return results;
}

/**
 * Parse all Claude Code usage data.
 * @param {object} config - { claudeDir, plan, monthlyRate }
 * @returns {object} Full usage data structure
 */
async function parseAllData(config) {
  const claudeDir = config.claudeDir;
  const projectsDir = path.join(claudeDir, 'projects');
  const historyFile = path.join(claudeDir, 'history.jsonl');
  const statsFile = path.join(claudeDir, 'stats-cache.json');

  // Read stats cache
  let statsCache = {};
  try { statsCache = JSON.parse(fs.readFileSync(statsFile, 'utf8')); } catch { }

  // Read history for session mapping
  const historyEntries = await readJsonlFile(historyFile);

  // Scan project directories
  let projectDirs = [];
  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    projectDirs = entries.filter(e => e.isDirectory()).map(e => ({
      encoded: e.name,
      path: path.join(projectsDir, e.name),
    }));
  } catch {
    return { error: 'Could not read Claude projects directory' };
  }

  const projects = {};
  const dailyData = {};
  const modelTotals = {};
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;
  let totalMessages = 0;

  for (const projectDir of projectDirs) {
    const projectName = getProjectName(projectDir.encoded);
    const projectPath = decodeProjectPath(projectDir.encoded);
    const jsonlFiles = findJsonlFiles(projectDir.path);

    if (!projects[projectName]) {
      projects[projectName] = {
        name: projectName,
        path: projectPath,
        totalInputTokens: 0, totalOutputTokens: 0,
        totalCacheRead: 0, totalCacheWrite: 0,
        totalCost: 0, totalMessages: 0, sessionCount: 0,
        models: {}, dailyUsage: {},
        firstActivity: null, lastActivity: null,
      };
    }

    const project = projects[projectName];
    const seenSessions = new Set();

    for (const jsonlFile of jsonlFiles) {
      const entries = await readJsonlFile(jsonlFile);

      for (const entry of entries) {
        if (entry.type !== 'assistant' || !entry.message?.usage) continue;

        const usage = entry.message.usage;
        const model = entry.message.model || 'unknown';
        const timestamp = entry.timestamp;
        const date = timestamp ? timestamp.split('T')[0] : null;
        const sessionId = entry.sessionId;

        if (sessionId && !seenSessions.has(sessionId)) {
          seenSessions.add(sessionId);
          project.sessionCount++;
        }

        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const cacheRead = usage.cache_read_input_tokens || 0;
        const cacheWrite = usage.cache_creation_input_tokens || 0;
        const cost = calculateCost(usage, model);

        // Project totals
        project.totalInputTokens += inputTokens;
        project.totalOutputTokens += outputTokens;
        project.totalCacheRead += cacheRead;
        project.totalCacheWrite += cacheWrite;
        project.totalCost += cost;
        project.totalMessages++;

        // Project model breakdown
        if (!project.models[model]) {
          project.models[model] = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0 };
        }
        project.models[model].inputTokens += inputTokens;
        project.models[model].outputTokens += outputTokens;
        project.models[model].cacheRead += cacheRead;
        project.models[model].cacheWrite += cacheWrite;
        project.models[model].cost += cost;
        project.models[model].messages++;

        // Project daily
        if (date) {
          if (!project.dailyUsage[date]) project.dailyUsage[date] = { tokens: 0, cost: 0, messages: 0 };
          project.dailyUsage[date].tokens += inputTokens + outputTokens;
          project.dailyUsage[date].cost += cost;
          project.dailyUsage[date].messages++;
        }

        // Activity timestamps
        if (timestamp) {
          if (!project.firstActivity || timestamp < project.firstActivity) project.firstActivity = timestamp;
          if (!project.lastActivity || timestamp > project.lastActivity) project.lastActivity = timestamp;
        }

        // Global totals
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        totalCacheRead += cacheRead;
        totalCacheWrite += cacheWrite;
        totalCost += cost;
        totalMessages++;

        // Global model totals
        if (!modelTotals[model]) {
          modelTotals[model] = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0 };
        }
        modelTotals[model].inputTokens += inputTokens;
        modelTotals[model].outputTokens += outputTokens;
        modelTotals[model].cacheRead += cacheRead;
        modelTotals[model].cacheWrite += cacheWrite;
        modelTotals[model].cost += cost;
        modelTotals[model].messages++;

        // Global daily
        if (date) {
          if (!dailyData[date]) {
            dailyData[date] = { tokens: 0, cost: 0, messages: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
          }
          dailyData[date].tokens += inputTokens + outputTokens;
          dailyData[date].cost += cost;
          dailyData[date].messages++;
          dailyData[date].inputTokens += inputTokens;
          dailyData[date].outputTokens += outputTokens;
          dailyData[date].cacheRead += cacheRead;
          dailyData[date].cacheWrite += cacheWrite;
        }
      }
    }
  }

  // Sort and format
  const sortedDailyData = Object.entries(dailyData)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, ...d }));

  const sortedProjects = Object.values(projects)
    .filter(p => p.totalMessages > 0)
    .sort((a, b) => b.totalCost - a.totalCost)
    .map(p => ({
      ...p,
      dailyUsage: Object.entries(p.dailyUsage)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, d]) => ({ date, ...d })),
    }));

  // Subscription calculations
  const firstDate = statsCache.firstSessionDate ? new Date(statsCache.firstSessionDate) : new Date();
  const monthsActive = Math.max(1, Math.ceil((Date.now() - firstDate) / (30.44 * 24 * 60 * 60 * 1000)));
  const planInfo = SUBSCRIPTION_PLANS[config.plan] || { name: config.plan };

  return {
    generated: new Date().toISOString(),
    subscription: {
      plan: planInfo.name || config.plan,
      monthlyRate: config.monthlyRate,
      monthsActive,
      actualCost: monthsActive * config.monthlyRate,
    },
    summary: {
      totalProjects: sortedProjects.length,
      totalSessions: statsCache.totalSessions || 0,
      totalMessages,
      totalInputTokens, totalOutputTokens,
      totalCacheRead, totalCacheWrite,
      totalTokens: totalInputTokens + totalOutputTokens + totalCacheRead + totalCacheWrite,
      apiEquivalentCost: Math.round(totalCost * 100) / 100,
      firstSessionDate: statsCache.firstSessionDate || null,
    },
    modelUsage: modelTotals,
    dailyUsage: sortedDailyData,
    projects: sortedProjects,
    hourlyActivity: statsCache.hourCounts || {},
  };
}

/**
 * Get summary for a specific project.
 */
async function getProjectSummary(config, projectName) {
  const data = await parseAllData(config);
  const searchName = projectName.toLowerCase();
  const project = data.projects.find(p =>
    p.name.toLowerCase().includes(searchName) ||
    p.path.toLowerCase().includes(searchName)
  );
  return project || null;
}

/**
 * Get daily usage for a date range.
 */
async function getDailyRange(config, startDate, endDate) {
  const data = await parseAllData(config);
  return data.dailyUsage.filter(d => {
    if (startDate && d.date < startDate) return false;
    if (endDate && d.date > endDate) return false;
    return true;
  });
}

module.exports = { parseAllData, getProjectSummary, getDailyRange };
