const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const app = express();
app.use(express.json());

const COBALT_URL = process.env.COBALT_URL || 'http://cobalt-api:9000';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/media/downloads/cobalt';
const MEDIA_ROOT = process.env.MEDIA_ROOT || '/media';
const COOKIE_PATH = process.env.COOKIE_PATH || '/app/cookies.json';
const TWITTER_AUTH_TOKEN = process.env.TWITTER_AUTH_TOKEN || '';
const TWITTER_CT0 = process.env.TWITTER_CT0 || '';
const TWITTER_COOKIE_EXPIRY = process.env.TWITTER_COOKIE_EXPIRY || '';

// --- yt-dlp fallback config -------------------------------------------------
// Domains that should always go straight to yt-dlp, skipping cobalt entirely.
const YTDLP_DOMAINS = (process.env.YTDLP_DOMAINS || 'thisvid.com')
  .split(',')
  .map(d => d.trim().toLowerCase())
  .filter(Boolean);

const jobs = new Map(); // jobId -> { status, percent, eta, speed, filename, error, url }
const jobEvents = new EventEmitter();

// --- Per-domain folder settings ---------------------------------------------
const SETTINGS_PATH = path.join(MEDIA_ROOT, '.cobalt-settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
  catch { return { defaultDir: DOWNLOAD_DIR, rules: [] }; }
}

function saveSettings(settings) {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2)); return true; }
  catch (e) { console.error('Failed to save settings:', e.message); return false; }
}

function getDownloadDir(url) {
  const settings = loadSettings();
  let dir = settings.defaultDir || DOWNLOAD_DIR;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    for (const rule of (settings.rules || [])) {
      const domain = (rule.domain || '').replace(/^www\./, '').toLowerCase();
      if (domain && (host === domain || host.endsWith('.' + domain))) {
        dir = rule.dir;
        break;
      }
    }
  } catch {}
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
// ---------------------------------------------------------------------------

// --- Download history -------------------------------------------------------
const HISTORY_PATH = path.join(DOWNLOAD_DIR, '.history.json');
const HISTORY_MAX = 500;

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch { return []; }
}

function appendHistory(entry) {
  const history = loadHistory();
  history.unshift({ id: crypto.randomUUID(), date: new Date().toISOString(), ...entry });
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history));
  } catch (e) {
    console.error('Failed to write history:', e.message);
  }
}
// ---------------------------------------------------------------------------

function shouldUseYtdlp(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return YTDLP_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

function startYtdlpJob(url) {
  const jobId = crypto.randomUUID();
  const downloadDir = getDownloadDir(url);
  const job = {
    status: 'starting',
    percent: '0%',
    eta: '',
    speed: '',
    filename: null,
    error: null,
    url,
    downloadDir,
    proc: null,
  };
  jobs.set(jobId, job);

  const proc = spawn('yt-dlp', [
    url,
    '-P', downloadDir,
    '-o', '%(title)s.%(ext)s',
    '--no-playlist',
    '--newline',
    '--progress-template', 'download:PROGRESS %(progress._percent_str)s|%(progress._eta_str)s|%(progress._speed_str)s',
    '--print', 'after_move:FILENAME %(filepath)s',
  ]);

  job.proc = proc;

  let stdoutBuffer = '';
  let stderrTail = '';

  proc.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // keep any incomplete trailing line for next chunk

    for (const raw of lines) {
      const line = raw.trim();
      const job = jobs.get(jobId);
      if (!job) continue;

      if (line.startsWith('PROGRESS ')) {
        const [pct, eta, speed] = line.slice('PROGRESS '.length).split('|');
        job.status = 'downloading';
        job.percent = (pct || '').trim();
        job.eta = (eta || '').trim();
        job.speed = (speed || '').trim();
        jobEvents.emit(jobId, { ...job });
      } else if (line.startsWith('FILENAME ')) {
        job.filename = path.basename(line.slice('FILENAME '.length).trim());
        jobEvents.emit(jobId, { ...job });
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    stderrTail += chunk.toString();
    // keep only the last ~2000 chars so it doesn't grow unbounded
    if (stderrTail.length > 2000) stderrTail = stderrTail.slice(-2000);
  });

  proc.on('close', (code) => {
    const job = jobs.get(jobId);
    if (!job) return;
    if (code === 0) {
      job.status = 'done';
      job.percent = '100%';
      let size = null;
      if (job.filename) {
        try { size = fs.statSync(path.join(job.downloadDir || DOWNLOAD_DIR, job.filename)).size; } catch {}
      }
      appendHistory({ url: job.url, filename: job.filename, status: 'done', error: null, size });
    } else {
      job.status = 'error';
      job.error = stderrTail.trim().split('\n').filter(Boolean).pop() || `yt-dlp exited with code ${code}`;
      appendHistory({ url: job.url, filename: null, status: 'error', error: job.error, size: null });
    }
    jobEvents.emit(jobId, { ...job });
    // Clean up finished job state after a while
    setTimeout(() => jobs.delete(jobId), 5 * 60 * 1000);
  });

  proc.on('error', (e) => {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = 'error';
    job.error = e.message;
    appendHistory({ url: job.url, filename: null, status: 'error', error: e.message, size: null });
    jobEvents.emit(jobId, { ...job });
  });

  return jobId;
}
// -----------------------------------------------------------------------------

// Write cookies.json on startup from env vars
if (TWITTER_AUTH_TOKEN && TWITTER_CT0) {
  try {
    const cookies = {
      twitter: [`auth_token=${TWITTER_AUTH_TOKEN}; ct0=${TWITTER_CT0}`]
    };
    fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
    console.log(`Cookies written to ${COOKIE_PATH}`);
  } catch (e) {
    console.error('Failed to write cookies file:', e.message);
  }
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/status', async (req, res) => {
  try {
    const data = await cobaltFetch('GET', '/');
    res.json({ ok: true, cobalt: data, cookieExpiry: TWITTER_COOKIE_EXPIRY || null });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message, cookieExpiry: TWITTER_COOKIE_EXPIRY || null });
  }
});

function publicJob(job) {
  const { proc, _req, _stream, _file, ...safe } = job;
  return safe;
}

// All currently in-flight/recently-finished jobs — lets the UI pick up jobs
// started elsewhere (e.g. the iOS Shortcut hitting /api/download directly).
app.get('/api/jobs', (req, res) => {
  res.json([...jobs.entries()].map(([jobId, job]) => ({ jobId, ...publicJob(job) })));
});

// Plain-JSON snapshot of one job, for polling from clients that can't use SSE
// (e.g. iOS Shortcuts).
app.get('/api/job/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ jobId: req.params.jobId, ...publicJob(job) });
});

app.get('/api/history', (req, res) => res.json(loadHistory()));

app.delete('/api/history', (req, res) => {
  try { fs.writeFileSync(HISTORY_PATH, '[]'); } catch {}
  res.json({ ok: true });
});

app.delete('/api/history/:id', (req, res) => {
  const history = loadHistory().filter(e => e.id !== req.params.id);
  try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(history)); } catch {}
  res.json({ ok: true });
});

app.delete('/api/job/:jobId', (req, res) => {
  const { jobId } = req.params;
  const deleteFile = req.query.deleteFile === 'true';
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  // Kill yt-dlp process
  if (job.proc) { try { job.proc.kill(); } catch {} }

  // Destroy cobalt streams
  if (job._stream) { try { job._stream.destroy(); } catch {} }
  if (job._file) { try { job._file.destroy(); } catch {} }
  if (job._req) { try { job._req.destroy(); } catch {} }

  if (deleteFile) {
    // Cobalt: known filepath
    if (job.filepath) { try { fs.unlinkSync(job.filepath); } catch {} }
    // yt-dlp: delete any .part/.ytdl files in download dir (best effort)
    if (job.downloadDir) {
      try {
        const files = fs.readdirSync(job.downloadDir);
        for (const f of files.filter(f => f.endsWith('.part') || f.endsWith('.ytdl'))) {
          try { fs.unlinkSync(path.join(job.downloadDir, f)); } catch {}
        }
      } catch {}
    }
  }

  job.status = 'cancelled';
  job.error = 'Download cancelled';
  jobEvents.emit(jobId, { ...job });
  setTimeout(() => jobs.delete(jobId), 5 * 60 * 1000);
  res.json({ ok: true });
});

app.get('/api/settings', (req, res) => res.json(loadSettings()));

app.post('/api/settings', (req, res) => {
  const { defaultDir, rules } = req.body;
  if (!defaultDir) return res.status(400).json({ error: 'defaultDir is required' });
  const ok = saveSettings({ defaultDir, rules: rules || [] });
  res.json({ ok });
});

// --- yt-dlp progress stream (SSE) --------------------------------------------
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders?.();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send(job);

  if (job.status === 'done' || job.status === 'error') {
    return res.end();
  }

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 25000);

  const listener = (data) => {
    send(data);
    if (data.status === 'done' || data.status === 'error' || data.status === 'cancelled') {
      clearInterval(heartbeat);
      jobEvents.off(jobId, listener);
      res.end();
    }
  };
  jobEvents.on(jobId, listener);

  req.on('close', () => {
    clearInterval(heartbeat);
    jobEvents.off(jobId, listener);
  });
});
// -----------------------------------------------------------------------------

app.post('/api/download', async (req, res) => {
  const { url, videoQuality = '1080', audioFormat = 'mp3', downloadMode = 'auto' } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: 'URL is required' });

  // Domain allowlist: skip cobalt entirely for known yt-dlp-only sites
  if (shouldUseYtdlp(url)) {
    const jobId = startYtdlpJob(url);
    return res.json({ ok: true, status: 'ytdlp', jobId, message: 'Queued (yt-dlp)' });
  }

  try {
    const cobaltRes = await cobaltFetch('POST', '/', {
      url, videoQuality, audioFormat, downloadMode, filenameStyle: 'pretty',
    });

    if (cobaltRes.status === 'error') {
      // Generic fallback: cobalt doesn't recognise this site at all
      if (cobaltRes.error?.code === 'error.api.link.invalid') {
        const jobId = startYtdlpJob(url);
        return res.json({ ok: true, status: 'ytdlp', jobId, message: 'Queued (yt-dlp)' });
      }
      const errMsg = cobaltRes.error?.code || 'Cobalt error';
      appendHistory({ url, filename: null, status: 'error', error: errMsg, size: null });
      return res.status(400).json({ ok: false, error: errMsg });
    }
    if (cobaltRes.status === 'picker') {
      return res.json({ ok: true, status: 'picker', picker: cobaltRes.picker, audio: cobaltRes.audio, message: 'Multiple items found' });
    }
    if (cobaltRes.status === 'redirect' || cobaltRes.status === 'tunnel') {
      const ext = path.extname(cobaltRes.filename || '').replace('.', '') || 'mp4';
      const filename = twitterFilename(url, ext) || cobaltRes.filename || `download_${Date.now()}.mp4`;
      const filepath = path.join(getDownloadDir(url), sanitize(filename));
      const jobId = startCobaltJob(cobaltRes.url, filepath, url);
      return res.json({ ok: true, status: 'cobalt-job', jobId, message: 'Queued' });
    } else {
      const errMsg = `Unexpected cobalt status: ${cobaltRes.status}`;
      appendHistory({ url, filename: null, status: 'error', error: errMsg, size: null });
      res.status(400).json({ ok: false, error: errMsg });
    }
  } catch (e) {
    appendHistory({ url, filename: null, status: 'error', error: e.message, size: null });
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/download-url', async (req, res) => {
  const { url, filename, originalUrl } = req.body;
  if (!url || !filename) return res.status(400).json({ error: 'url and filename required' });
  const filepath = path.join(getDownloadDir(originalUrl || url), sanitize(filename));
  const jobId = startCobaltJob(url, filepath, originalUrl || url);
  res.json({ status: 'cobalt-job', jobId });
});

function startCobaltJob(cdnUrl, filepath, originalUrl) {
  const jobId = crypto.randomUUID();
  const filename = path.basename(filepath);
  const job = {
    status: 'starting',
    percent: null,
    downloaded: 0,
    total: null,
    filename,
    error: null,
    url: originalUrl || cdnUrl,
    filepath,
    _req: null,
    _stream: null,
    _file: null,
  };
  jobs.set(jobId, job);

  let lastEmit = 0;

  const cobaltReq = (cdnUrl.startsWith('https') ? https : http).get(cdnUrl, (stream) => {
    const j = jobs.get(jobId);
    if (!j) return;
    j._stream = stream;

    if (stream.statusCode !== 200) {
      const errMsg = `Download failed: HTTP ${stream.statusCode}`;
      j.status = 'error';
      j.error = errMsg;
      jobEvents.emit(jobId, { ...j });
      appendHistory({ url: j.url, filename: null, status: 'error', error: errMsg, size: null });
      setTimeout(() => jobs.delete(jobId), 5 * 60 * 1000);
      return;
    }

    const contentLength = parseInt(stream.headers['content-length'], 10);
    j.total = isNaN(contentLength) ? null : contentLength;
    j.status = 'downloading';
    jobEvents.emit(jobId, { ...j });

    const file = fs.createWriteStream(filepath);
    j._file = file;

    stream.on('data', (chunk) => {
      const jj = jobs.get(jobId);
      if (!jj) return;
      jj.downloaded += chunk.length;
      if (jj.total) jj.percent = (jj.downloaded / jj.total * 100).toFixed(1);
      const now = Date.now();
      if (now - lastEmit > 250) { lastEmit = now; jobEvents.emit(jobId, { ...jj }); }
    });

    stream.pipe(file);

    file.on('finish', () => {
      file.close();
      const jj = jobs.get(jobId);
      if (!jj || jj.status === 'cancelled') return;
      let size = null;
      try { size = fs.statSync(filepath).size; } catch {}
      jj.status = 'done';
      jj.percent = '100';
      jobEvents.emit(jobId, { ...jj });
      appendHistory({ url: jj.url, filename, status: 'done', error: null, size });
      setTimeout(() => jobs.delete(jobId), 5 * 60 * 1000);
    });

    file.on('error', (e) => {
      const jj = jobs.get(jobId);
      if (!jj || jj.status === 'cancelled') return;
      jj.status = 'error';
      jj.error = e.message;
      jobEvents.emit(jobId, { ...jj });
      appendHistory({ url: jj.url, filename: null, status: 'error', error: e.message, size: null });
      fs.unlink(filepath, () => {});
      setTimeout(() => jobs.delete(jobId), 5 * 60 * 1000);
    });
  });
  job._req = cobaltReq;

  cobaltReq.on('error', (e) => {
    const j = jobs.get(jobId);
    if (!j || j.status === 'cancelled') return;
    j.status = 'error';
    j.error = e.message;
    jobEvents.emit(jobId, { ...j });
    appendHistory({ url: j.url, filename: null, status: 'error', error: e.message, size: null });
    fs.unlink(filepath, () => {});
    setTimeout(() => jobs.delete(jobId), 5 * 60 * 1000);
  });

  return jobId;
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

// Extract date from Twitter snowflake ID
function tweetIdToDate(id) {
  try {
    const twitterEpoch = 1288834974657n;
    const ms = (BigInt(id) >> 22n) + twitterEpoch;
    return new Date(Number(ms));
  } catch {
    return null;
  }
}

function twitterFilename(url, ext) {
  try {
    const match = url.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/);
    if (!match) return null;
    const username = match[1];
    const tweetId = match[2];
    const date = tweetIdToDate(tweetId);
    if (!date) return null;
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `X.com - ${username}, ${day} ${month} ${year}.${ext}`;
  } catch {
    return null;
  }
}

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._\-() ]/g, '_').slice(0, 200);
}

app.listen(3000, () => console.log('Backend running on :3000'));
