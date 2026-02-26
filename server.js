import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { runExtraction } from './src/extractor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Optional: simple per-IP rate limit (10 runs per minute)
const runCountByIp = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = runCountByIp.get(ip);
  if (!entry) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    runCountByIp.set(ip, entry);
  }
  if (now >= entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many scan requests; try again later.' });
  }
  next();
}

app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/run', rateLimit, async (req, res) => {
  const { url, key, email, password, token, fastDiscovery, exportSql } = req.body || {};
  if (!url || !key) {
    return res.status(400).json({ error: 'Missing required parameters: url and key' });
  }
  const config = {
    url: String(url).trim(),
    key: String(key).trim(),
    email: email ? String(email).trim() : undefined,
    password: password ? String(password) : undefined,
    token: token ? String(token).trim() : undefined,
    fastDiscovery: Boolean(fastDiscovery),
    exportSql: exportSql ? String(exportSql).trim() : undefined,
  };
  try {
    const result = await runExtraction(config, { echoToConsole: false });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Scan failed' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
