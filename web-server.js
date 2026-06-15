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

const PORT           = process.env.PORT || 3000;
const GITHUB_RAW     = 'https://raw.githubusercontent.com/ClawSpivak/matthew-badges/main';
const COLLECTION_URL = `${GITHUB_RAW}/state/badge-collection.json`;
const HTML_URL       = `${GITHUB_RAW}/public/index.html`;
const CACHE_TTL      = 60000;

let _dataCache = null, _dataCacheAt = 0;
let _htmlCache = null, _htmlCacheAt = 0;

function fetchGithub(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 8000 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    }).on('error', reject).on('timeout', () => reject(new Error('GitHub timeout')));
  });
}

async function fetchCollection() {
  if (_dataCache && Date.now() - _dataCacheAt < CACHE_TTL) return _dataCache;
  const body = await fetchGithub(COLLECTION_URL);
  _dataCache = JSON.parse(body);
  _dataCacheAt = Date.now();
  return _dataCache;
}

async function fetchHtml() {
  if (_htmlCache && Date.now() - _htmlCacheAt < CACHE_TTL) return _htmlCache;
  _htmlCache = await fetchGithub(HTML_URL);
  _htmlCacheAt = Date.now();
  return _htmlCache;
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
    try {
      const html = await fetchHtml();
      send(res, 200, 'text/html; charset=utf-8', html);
    } catch(e) {
      send(res, 502, 'text/plain', 'Could not load page. Try refreshing.');
    }
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
