#!/usr/bin/env node
/**
 * Matthew's Badge Vault — web server
 * Serves the collection website. Badge data is read from GitHub on each request
 * (60s cache) so the site updates automatically when new badges are pushed.
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT         = process.env.PORT || 3000;
const GITHUB_RAW   = 'https://raw.githubusercontent.com/ClawSpivak/matthew-badges/main';
const COLLECTION_URL = `${GITHUB_RAW}/state/badge-collection.json`;
const CACHE_TTL    = 60000;

let _cache = null;
let _cacheAt = 0;

function fetchCollection() {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL) return Promise.resolve(_cache);
  return new Promise((resolve, reject) => {
    https.get(COLLECTION_URL, { timeout: 8000 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          _cache = JSON.parse(body);
          _cacheAt = Date.now();
          resolve(_cache);
        } catch(e) { reject(new Error('Bad JSON from GitHub')); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('GitHub timeout')));
  });
}

function send(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    send(res, 200, 'text/html; charset=utf-8', html);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/badges') {
    try {
      const data = await fetchCollection();
      send(res, 200, 'application/json', JSON.stringify(data));
    } catch(e) {
      send(res, 502, 'application/json', JSON.stringify({ error: e.message }));
    }
    return;
  }

  send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }));

}).listen(PORT, () => {
  console.log(`Matthew's Badge Vault → http://localhost:${PORT}`);
});
