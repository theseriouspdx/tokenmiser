'use strict';

/**
 * Zero-dependency HTTPS helpers.
 */

const https = require('https');

function httpGet(hostname, urlPath, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        port: 443,
        path: urlPath,
        method: 'GET',
        headers: { 'Content-Type': 'application/json', ...headers },
        timeout,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403)
            return reject(new Error('auth_failed'));
          if (res.statusCode >= 400)
            return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('parse_failed'));
          }
        });
      }
    );
    req.on('error', (e) => reject(e));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

module.exports = { httpGet };
