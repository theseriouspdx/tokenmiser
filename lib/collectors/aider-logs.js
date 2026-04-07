'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

/**
 * Aider chat history log collector.
 *
 * Aider stores chat logs and cost data in:
 *   - .aider.chat.history.md files (per-project, in project root)
 *   - .aider.input.history (readline history)
 *   - ~/.aider/analytics/ (if analytics enabled)
 *   - Aider tracks costs natively and writes summaries
 *
 * The chat history files contain model names, token counts, and cost
 * information embedded in the markdown output.
 *
 * We scan common project directories and HOME for .aider.chat.history.md files.
 */

const AIDER_PRICING = {
  'claude-opus-4':     { prompt: 0.000015,  completion: 0.000075 },
  'claude-sonnet-4':   { prompt: 0.000003,  completion: 0.000015 },
  'claude-3.5-sonnet': { prompt: 0.000003,  completion: 0.000015 },
  'gpt-4o':            { prompt: 0.0000025, completion: 0.000010 },
  'gpt-4-turbo':       { prompt: 0.000010,  completion: 0.000030 },
  'o3-mini':           { prompt: 0.0000011, completion: 0.0000044 },
};

function findAiderHistoryFiles() {
  const files = [];
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

  // Check HOME directory and common project directories
  const searchDirs = [HOME];

  // Add common code directories if they exist
  const codeDirs = ['Projects', 'Code', 'src', 'repos', 'dev', 'work', 'code'];
  for (const d of codeDirs) {
    const full = path.join(HOME, d);
    if (fs.existsSync(full)) searchDirs.push(full);
  }

  for (const dir of searchDirs) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name === '.aider.chat.history.md') {
          const full = path.join(dir, e.name);
          try {
            const stat = fs.statSync(full);
            if (stat.mtimeMs > ninetyDaysAgo) {
              files.push(full);
            }
          } catch {}
        }
        // Also look one level deep into subdirectories
        if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('node_modules')) {
          const subDir = path.join(dir, e.name);
          try {
            const subFile = path.join(subDir, '.aider.chat.history.md');
            if (fs.existsSync(subFile)) {
              const stat = fs.statSync(subFile);
              if (stat.mtimeMs > ninetyDaysAgo) {
                files.push(subFile);
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  return files;
}

/**
 * Parse aider chat history markdown for cost/token information.
 *
 * Aider outputs lines like:
 *   > Tokens: 12.3k sent, 2.1k received. Cost: $0.04 message, $1.23 session.
 *   > Model: claude-3.5-sonnet with diff edit format
 */
function parseAiderHistory(content) {
  const dayModel = {};
  const lines = content.split('\n');

  let currentModel = 'unknown';
  let currentDate = null;

  for (const line of lines) {
    // Detect date markers (aider uses "# aider chat started at YYYY-MM-DD HH:MM:SS")
    const dateMatch = line.match(/^# aider chat started at (\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      currentDate = dateMatch[1];
      continue;
    }

    // Detect model lines
    const modelMatch = line.match(/^> Model:\s*(\S+)/);
    if (modelMatch) {
      currentModel = modelMatch[1];
      continue;
    }

    // Detect cost/token lines
    const tokenMatch = line.match(
      /^> Tokens:\s*([\d.]+)k?\s*sent,\s*([\d.]+)k?\s*received.*?Cost:\s*\$([\d.]+)\s*message/
    );
    if (tokenMatch && currentDate) {
      let sent = parseFloat(tokenMatch[1]);
      let received = parseFloat(tokenMatch[2]);
      const messageCost = parseFloat(tokenMatch[3]);

      // If values have 'k' multiplier (common in aider output)
      if (line.includes('k sent')) sent *= 1000;
      if (line.includes('k received')) received *= 1000;

      const key = `${currentDate}|${currentModel}`;
      if (!dayModel[key]) {
        dayModel[key] = { date: currentDate, model: currentModel, promptTokens: 0, completionTokens: 0, cost: 0, requests: 0 };
      }
      dayModel[key].promptTokens += Math.round(sent);
      dayModel[key].completionTokens += Math.round(received);
      dayModel[key].cost += messageCost;
      dayModel[key].requests += 1;
    }
  }

  return dayModel;
}

function collect() {
  const historyFiles = findAiderHistoryFiles();
  if (historyFiles.length === 0) return null;

  const allDayModel = {};

  for (const filePath of historyFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const project = path.basename(path.dirname(filePath));
      const dayModel = parseAiderHistory(content);
      for (const [key, agg] of Object.entries(dayModel)) {
        const projKey = `${key}|${project}`;
        if (!allDayModel[projKey]) {
          allDayModel[projKey] = { ...agg, project };
        } else {
          allDayModel[projKey].promptTokens += agg.promptTokens;
          allDayModel[projKey].completionTokens += agg.completionTokens;
          allDayModel[projKey].cost += agg.cost;
          allDayModel[projKey].requests += agg.requests;
        }
      }
    } catch {}
  }

  const records = Object.values(allDayModel).map((agg) => {
    // Aider provides its own cost calculations — use them if available
    let cost = agg.cost;
    if (cost === 0) {
      const pKey = Object.keys(AIDER_PRICING).find((k) =>
        agg.model.toLowerCase().includes(k)
      );
      const rates = pKey ? AIDER_PRICING[pKey] : { prompt: 0.000003, completion: 0.000015 };
      cost = agg.promptTokens * rates.prompt + agg.completionTokens * rates.completion;
    }

    // Determine provider from model name
    let provider = 'unknown';
    if (agg.model.toLowerCase().includes('claude') || agg.model.toLowerCase().includes('anthropic')) {
      provider = 'anthropic';
    } else if (agg.model.toLowerCase().includes('gpt') || agg.model.toLowerCase().includes('o3') || agg.model.toLowerCase().includes('o4')) {
      provider = 'openai';
    } else if (agg.model.toLowerCase().includes('gemini')) {
      provider = 'google';
    }

    // Infer billing path: provider-prefixed models = per-token API, bare names = OAuth
    const isOAuth = !agg.model.includes('/');

    return {
      source: 'aider',
      billingPath: isOAuth ? 'oauth' : (provider !== 'unknown' ? provider : 'local-estimate'),
      type: 'local-log',
      estimated: isOAuth ? false : agg.cost === 0,
      date: agg.date,
      model: agg.model.includes('/') ? agg.model : `${provider}/${agg.model}`,
      modelName: agg.model,
      promptTokens: agg.promptTokens,
      completionTokens: agg.completionTokens,
      cost: isOAuth ? 0 : cost,
      requests: agg.requests,
      project: agg.project || '',
    };
  });

  return records.length > 0
    ? { records, pricing: AIDER_PRICING, sourceLabel: 'Aider (local logs)' }
    : null;
}

function detect() {
  // Quick check: does HOME have a .aider.chat.history.md?
  if (fs.existsSync(path.join(HOME, '.aider.chat.history.md'))) return true;
  // Check common project dirs
  const codeDirs = ['Projects', 'Code', 'src', 'repos', 'dev', 'work', 'code'];
  for (const d of codeDirs) {
    const full = path.join(HOME, d);
    if (fs.existsSync(full)) {
      try {
        const entries = fs.readdirSync(full);
        for (const e of entries) {
          if (fs.existsSync(path.join(full, e, '.aider.chat.history.md'))) return true;
        }
      } catch {}
    }
  }
  return false;
}

module.exports = {
  name: 'Aider (local logs)',
  slug: 'aider',
  type: 'local-log',
  detect,
  collect,
  logPath: '~/.aider.chat.history.md (per-project)',
};
