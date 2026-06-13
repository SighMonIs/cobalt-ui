const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const COBALT_URL = process.env.COBALT_URL || 'http://cobalt-api:9000';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/downloads';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/status', async (req, res) => {
  try {
    const data = await cobaltFetch('GET', '/');
    res.json({ ok: true, cobalt: data });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.get('/api/downloads', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR)
      .filter(f => !f.startsWith('.'))
      .map(f => {
        const stat = fs.statSync(path.join(DOWNLOAD_DIR, f));
        return { name: f, size: stat.size, date: stat.mtime };
      })
      .sort((a, b) => b.date - a.date);
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

app.post('/api/download', async (req, res) => {
  const { url, videoQuality = '1080', audioFormat = 'mp3', downloadMode = 'auto' } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const cobaltRes = await cobaltFetch('POST', '/', {
      url, videoQuality, audioFormat, downloadMode, filenameStyle: 'pretty',
    });

    if (cobaltRes.status === 'error') {
      return res.status(400).json({ error: cobaltRes.error?.code || 'Cobalt error' });
    }
    if (cobaltRes.status === 'picker') {
      return res.json({ status: 'picker', picker: cobaltRes.picker, audio: cobaltRes.audio });
    }
    if (cobaltRes.status === 'redirect' || cobaltRes.status === 'tunnel') {
      const filename = cobaltRes.filename || `download_${Date.now()}.mp4`;
      const filepath = path.join(DOWNLOAD_DIR, sanitize(filename));
      streamToFile(cobaltRes.url, filepath, res);
    } else {
      res.status(400).json({ error: `Unexpected cobalt status: ${cobaltRes.status}` });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/download-url', async (req, res) => {
  const { url, filename } = req.body;
  if (!url || !filename) return res.status(400).json({ error: 'url and filename required' });
  streamToFile(url, path.join(DOWNLOAD_DIR, sanitize(filename)), res);
});

function streamToFile(url, filepath, res) {
  const proto = url.startsWith('https') ? https : http;
  const file = fs.createWriteStream(filepath);
  proto.get(url, (stream) => {
    if (stream.statusCode !== 200) {
      fs.unlink(filepath, () => {});
      return res.status(400).json({ error: `Download failed: HTTP ${stream.statusCode}` });
    }
    stream.pipe(file);
    file.on('finish', () => {
      file.close();
      const stat = fs.statSync(filepath);
      res.json({ ok: true, filename: path.basename(filepath), size: stat.size });
    });
  }).on('error', (e) => {
    fs.unlink(filepath, () => {});
    res.status(500).json({ error: e.message });
  });
}

function cobaltFetch(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(COBALT_URL + endpoint);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname,
      method,
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    };
    const proto = urlObj.protocol === 'https:' ? https : http;
    const req = proto.request(options, (r) => {
      let data = '';
      r.on('data', chunk => data += chunk);
      r.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from cobalt')); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._\-() ]/g, '_').slice(0, 200);
}

app.listen(3000, () => console.log('Backend running on :3000'));
