import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const API_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

/* ------------------------------------------------------------------ */
/* env                                                                 */
/* ------------------------------------------------------------------ */
export function loadEnv(file = path.resolve('.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

export function token() {
  const t = process.env.TMDB_TOKEN || process.env.TMDB_BEARER || '';
  if (!t) throw new Error('TMDB_TOKEN missing — put it in .env or GitHub Secrets');
  return t;
}

/* ------------------------------------------------------------------ */
/* rate limiter: serialize requests, keep a steady gap                  */
/* ------------------------------------------------------------------ */
const GAP_MS = Number(process.env.TMDB_GAP_MS || 260); // ~4 req/s
let last = 0;
let queue = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function throttle() {
  queue = queue.then(async () => {
    const now = Date.now();
    const wait = last + GAP_MS - now;
    if (wait > 0) await sleep(wait);
    last = Date.now();
  });
  return queue;
}

/* ------------------------------------------------------------------ */
/* optional disk cache (CI restores it with actions/cache)             */
/* ------------------------------------------------------------------ */
const CACHE_DIR = process.env.TMDB_CACHE || path.resolve('.cache/tmdb');
const CACHE_TTL_MS = Number(process.env.TMDB_CACHE_TTL_HOURS || 6) * 3600 * 1000;

function cachePath(key) {
  return path.join(CACHE_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');
}

function readCache(key) {
  try {
    const f = cachePath(key);
    if (!fs.existsSync(f)) return null;
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Date.now() - raw.t > CACHE_TTL_MS) return null;
    return raw.d;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(key), JSON.stringify({ t: Date.now(), d: data }));
  } catch { /* cache is best effort */ }
}

export const stats = { requests: 0, cacheHits: 0, retries: 0, failures: 0, startedAt: Date.now() };

/* ------------------------------------------------------------------ */
/* api                                                                 */
/* ------------------------------------------------------------------ */
export async function api(endpoint, params = {}, opts = {}) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    search.set(k, String(v));
  }
  search.set('language', params.language || process.env.TMDB_LANG || 'zh-CN');
  const qs = search.toString();
  const key = endpoint + '?' + qs;

  const cached = readCache(key);
  if (cached) { stats.cacheHits++; return cached; }

  const url = `${API_BASE}${endpoint}?${qs}`;
  const attemptMax = opts.attempts || 4;
  let attempt = 0;
  while (true) {
    attempt++;
    await throttle();
    stats.requests++;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token()}`, accept: 'application/json' },
      });
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after') || 5) * 1000;
        stats.retries++;
        await sleep(Math.min(retry, 30000));
        if (attempt < attemptMax) continue;
        throw new Error(`429 rate limited: ${key}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status >= 500 && attempt < attemptMax) { stats.retries++; await sleep(1000 * attempt); continue; }
        throw new Error(`HTTP ${res.status} ${endpoint} ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      writeCache(key, data);
      return data;
    } catch (err) {
      if (attempt >= attemptMax) { stats.failures++; throw err; }
      stats.retries++;
      await sleep(800 * attempt);
    }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
export function img(posterPath, size = 'w342') {
  return posterPath ? `${IMAGE_BASE}/${size}${posterPath}` : '';
}

export function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso, delta) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function weekdayIndex(iso) {
  return new Date(iso + 'T00:00:00Z').getUTCDay();
}

export const sleepMs = sleep;
