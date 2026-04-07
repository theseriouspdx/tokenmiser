'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

/**
 * Cline VS Code extension log collector.
 *
 * Cline stores task data at:
 *   macOS:  ~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/
 *   Linux:  ~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/
 *   Windows: %APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/
 *
 * Structure:
 *   tasks/<task-id>/api_conversation_history.json
 *   tasks/<task-id>/task_metadata.json (may not exist)
 *   state/taskHistory.json
 *
 * Also checks ~/.cline/log/ for CLI variant.
 */

const CLINE_PRICING = {
  'claude-opus-4':   { prompt: 0.000015,  completion: 0.000075 },
  'claude-sonnet-4': { prompt: 0.000003,  completion: 0.000015 },
  'claude-3.5-sonnet': { prompt: 0.000003, completion: 0.000015 },
  'claude-3.5-haiku': { prompt: 0.0000008, completion: 0.000004 },
  'gpt-4o':          { prompt: 0.0000025, completion: 0.000010 },
  'gpt-4o-mini':     { prompt: 0.00000015, completion: 0.0000006 },
};

function getClineDir() {
  const platform = os.platform();
  if (platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
  } else if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
  } else {
    return path.join(HOME, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
  }
}

function collect() {
  const clineDir = getClineDir();
  const tasksDir = path.join(clineDir, 'tasks');

  if (!fs.existsSync(tasksDir)) {
    // Also try ~/.cline/log/
    const clineLogDir = path.join(HOME, '.cline', 'log');
    if (!fs.existsSync(clineLogDir)) return null;
  }

  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const dayModel = {};

  // Parse tasks directory
  if (fs.existsSync(tasksDir)) {
    try {
      const taskIds = fs.readdirSync(tasksDir).filter((d) => {
        const full = path.join(tasksDir, d);
        try {
          return fs.statSync(full).isDirectory();
        } catch { return false; }
      });

      for (const taskId of taskIds) {
        const historyFile = path.join(tasksDir, taskId, 'api_conversation_history.json');
        if (!fs.existsSync(historyFile)) continue;

        try {
          const stat = fs.statSync(historyFile);
          if (stat.mtimeMs < ninetyDaysAgo) continue;

          // Try to extract project name from task_metadata.json
          let project = '';
          const metaFile = path.join(tasksDir, taskId, 'task_metadata.json');
          try {
            if (fs.existsSync(metaFile)) {
              const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
              const cwd = meta.cwd || meta.workspaceFolder || meta.dirAbsolutePath || '';
              if (cwd) project = path.basename(cwd);
            }
          } catch { /* skip */ }

          const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
          if (!Array.isArray(history)) continue;

          // Each entry in the conversation may contain usage info
          for (const entry of history) {
            const usage = entry.usage || {};
            const model = entry.model || 'cline-unknown';
            const input = usage.input_tokens || 0;
            const output = usage.output_tokens || 0;
            if (input === 0 && output === 0) continue;

            const ts = entry.ts || entry.timestamp || stat.mtimeMs;
            const time = typeof ts === 'number' ? ts : new Date(ts).getTime();
            const date = new Date(time).toISOString().slice(0, 10);

            const key = `${date}|${model}|${project}`;
            if (!dayModel[key]) {
              dayModel[key] = { date, model, project, promptTokens: 0, completionTokens: 0, requests: 0 };
            }
            dayModel[key].promptTokens += input;
            dayModel[key].completionTokens += output;
            dayModel[key].requests += 1;
          }
        } catch { /* skip unreadable task */ }
      }
    } catch {}
  }

  // Also try taskHistory.json for aggregate data
  const taskHistoryFile = path.join(clineDir, 'state', 'taskHistory.json');
  if (fs.existsSync(taskHistoryFile)) {
    try {
      const taskHistory = JSON.parse(fs.readFileSync(taskHistoryFile, 'utf8'));
      if (Array.isArray(taskHistory)) {
        for (const task of taskHistory) {
          const totalCost = task.totalCost || task.apiCost || 0;
          const model = task.model || 'cline-unknown';
          const ts = task.ts || task.timestamp || task.createdAt;
          if (!ts) continue;
          const time = typeof ts === 'number' ? ts : new Date(ts).getTime();
          if (time < ninetyDaysAgo) continue;

          const date = new Date(time).toISOString().slice(0, 10);
          const input = task.totalTokensIn || task.inputTokens || 0;
          const output = task.totalTokensOut || task.outputTokens || 0;

          // Only use if we don't already have detail from conversation history
          const key = `${date}|${model}`;
          if (!dayModel[key] && (input > 0 || output > 0)) {
            dayModel[key] = { date, model, promptTokens: input, completionTokens: output, requests: 1 };
          }
        }
      }
    } catch {}
  }

  const records = Object.values(dayModel).map((agg) => {
    const pKey = Object.keys(CLINE_PRICING).find((k) =>
      agg.model.toLowerCase().includes(k)
    );
    const rates = pKey ? CLINE_PRICING[pKey] : { prompt: 0.000003, completion: 0.000015 };
    const estimatedCost = agg.promptTokens * rates.prompt + agg.completionTokens * rates.completion;
    const isOAuth = !agg.model.includes('/');

    return {
      source: 'cline',
      billingPath: isOAuth ? 'oauth' : 'openrouter',
      type: 'local-log',
      estimated: !isOAuth,
      date: agg.date,
      model: agg.model.includes('/') ? agg.model : `anthropic/${agg.model}`,
      modelName: agg.model,
      promptTokens: agg.promptTokens,
      completionTokens: agg.completionTokens,
      cost: isOAuth ? 0 : estimatedCost,
      requests: agg.requests,
      project: agg.project || '',
    };
  });

  return records.length > 0
    ? { records, pricing: CLINE_PRICING, sourceLabel: 'Cline (local logs)' }
    : null;
}

function detect() {
  return fs.existsSync(path.join(getClineDir(), 'tasks')) ||
         fs.existsSync(path.join(HOME, '.cline', 'log'));
}

module.exports = {
  name: 'Cline (local logs)',
  slug: 'cline',
  type: 'local-log',
  detect,
  collect,
  logPath: getClineDir(),
};
