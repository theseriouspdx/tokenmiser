'use strict';

/**
 * Tokenmiser Dashboard Server
 *
 * Lightweight HTTP server for serving the dashboard and providing a REST API
 * for live config management (subscriptions, budgets, env keys).
 *
 * - Binds to 127.1.1.1 on a random port (port 0)
 * - Zero dependencies — uses Node built-in http module
 * - 30-minute idle auto-shutdown
 * - CORS enabled for local development
 * - Background process (non-blocking)
 *
 * REST API:
 *   GET  /                   → Serve the HTML dashboard
 *   GET  /api/health         → Health check
 *   GET  /api/config         → Get current config
 *   POST /api/config         → Update config (merge)
 *   GET  /api/env-keys       → List detected env key status
 *   POST /api/refresh        → Re-scan sources and regenerate dashboard
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const config = require('./config');

// Try 127.1.1.1 first (non-standard loopback, avoids conflicts),
// fall back to 127.0.0.2, then 127.0.0.1 as last resort.
const BIND_HOSTS = ['127.1.1.1', '127.0.0.2', '127.0.0.1'];
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

let idleTimer = null;
let cachedDashboardHTML = '';
let server = null;

/**
 * Reset the idle timer. Called on every request.
 */
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    process.stderr.write('  Tokenmiser server: idle timeout (30m), shutting down.\n');
    if (server) server.close();
    process.exit(0);
  }, IDLE_TIMEOUT_MS);
}

/**
 * Parse JSON body from an incoming request.
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString();
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Send a JSON response.
 */
function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

/**
 * Handle incoming HTTP requests.
 */
async function handleRequest(req, res) {
  resetIdleTimer();

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    // ── Dashboard HTML ──
    if (pathname === '/' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(cachedDashboardHTML || '<html><body>No dashboard data. Run tokenmiser first.</body></html>');
      return;
    }

    // ── Health check ──
    if (pathname === '/api/health' && req.method === 'GET') {
      jsonResponse(res, 200, { status: 'ok', uptime: process.uptime() });
      return;
    }

    // ── Get config ──
    if (pathname === '/api/config' && req.method === 'GET') {
      const cfg = config.readConfig();
      jsonResponse(res, 200, cfg);
      return;
    }

    // ── Update config (merge) ──
    if (pathname === '/api/config' && req.method === 'POST') {
      const body = await parseBody(req);
      const cfg = config.readConfig();

      // Merge subscriptions if provided
      if (body.subscriptions) {
        cfg.subscriptions = body.subscriptions;
      }
      if (body.budgets) {
        cfg.budgets = body.budgets;
      }
      if (body.settings) {
        cfg.settings = { ...cfg.settings, ...body.settings };
      }

      config.writeConfig(cfg);
      jsonResponse(res, 200, { status: 'updated', config: cfg });
      return;
    }

    // ── Env key status ──
    if (pathname === '/api/env-keys' && req.method === 'GET') {
      const keys = {
        OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
        OPENROUTER_MANAGEMENT_KEY: !!process.env.OPENROUTER_MANAGEMENT_KEY,
        ANTHROPIC_ADMIN_KEY: !!process.env.ANTHROPIC_ADMIN_KEY,
        OPENAI_ADMIN_KEY: !!process.env.OPENAI_ADMIN_KEY,
        OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      };
      jsonResponse(res, 200, keys);
      return;
    }

    // ── Refresh (placeholder — full refresh requires re-running collectors) ──
    if (pathname === '/api/refresh' && req.method === 'POST') {
      jsonResponse(res, 200, {
        status: 'refresh_requested',
        message: 'Dashboard refresh initiated. Re-run tokenmiser for a full data rescan.',
      });
      return;
    }

    // ── 404 ──
    jsonResponse(res, 404, { error: 'Not found' });

  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
}

/**
 * Start the dashboard server.
 *
 * @param {string} dashboardHTML - Pre-generated dashboard HTML to serve
 * @returns {Promise<{host: string, port: number, url: string}>}
 */
function tryBind(dashboardHTML, host) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handleRequest);
    srv.on('error', (err) => {
      srv.close();
      reject(err);
    });
    srv.listen(0, host, () => {
      server = srv;
      cachedDashboardHTML = dashboardHTML;
      const addr = srv.address();
      const url = `http://${addr.address}:${addr.port}`;
      resetIdleTimer();
      resolve({ host: addr.address, port: addr.port, url });
    });
  });
}

async function startServer(dashboardHTML) {
  // Try each bind address in order
  for (const host of BIND_HOSTS) {
    try {
      return await tryBind(dashboardHTML, host);
    } catch (err) {
      if (err.code === 'EADDRNOTAVAIL' || err.code === 'EADDRINUSE') {
        continue; // Try next address
      }
      throw err;
    }
  }
  throw new Error('Could not bind to any loopback address');
}

/**
 * Stop the server gracefully.
 */
function stopServer() {
  if (idleTimer) clearTimeout(idleTimer);
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = {
  startServer,
  stopServer,
  BIND_HOSTS,
};
