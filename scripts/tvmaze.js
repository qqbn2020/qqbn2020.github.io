/**
 * tvmaze.js — minimal TVMaze API client.
 *
 * Role in the pipeline: schedule SUPPLEMENT only. It feeds air-date evidence for
 * US linear-TV shows; all metadata (names, zh translations, posters) still comes
 * from TMDB, keyed by TMDB ids — TVMaze ids never create site pages of their own.
 *
 * Rate limit: 20 requests / 10 seconds → keep a 550ms gap (~18 req/10s).
 * No auth required.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sleepMs } from './tmdb.js';

const API_BASE = 'https://api.tvmaze.com';
const GAP_MS = Number(process.env.TVMAZE_GAP_MS || 550);

let last = 0;
let queue = Promise.resolve();

function throttle() {
  queue = queue.then(async () => {
    const now = Date.now();
    const wait = last + GAP_MS - now;
    if (wait > 0) await sleepMs(wait);
    last = Date.now();
  });
  return queue;
}

/* disk cache, same shape as the TMDB one so CI's actions/cache can hold both */
const CACHE_DIR = process.env.TVMAZE_CACHE || path.resolve('.cache/tvmaze');
const CACHE_TTL_MS = Number(process.env.TVMAZE_CACHE_TTL_HOURS || 6) * 3600 * 1000;

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

export const tvmazeStats = { requests: 0, cacheHits: 0, retries: 0, failures: 0 };

export async function tvmazeApi(endpoint, params = {}, opts = {}) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    search.set(k, String(v));
  }
  const qs = search.toString();
  const key = 'GET ' + endpoint + '?' + qs;

  const cached = readCache(key);
  if (cached) { tvmazeStats.cacheHits++; return cached; }

  const url = `${API_BASE}${endpoint}${qs ? '?' + qs : ''}`;
  const attemptMax = opts.attempts || 4;
  let attempt = 0;
  while (true) {
    attempt++;
    await throttle();
    tvmazeStats.requests++;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after') || 5) * 1000;
        tvmazeStats.retries++;
        await sleepMs(Math.min(retry, 30000));
        if (attempt < attemptMax) continue;
        throw new Error(`429 rate limited: ${key}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status >= 500 && attempt < attemptMax) { tvmazeStats.retries++; await sleepMs(1000 * attempt); continue; }
        throw new Error(`HTTP ${res.status} ${endpoint} ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      writeCache(key, data);
      return data;
    } catch (err) {
      if (attempt >= attemptMax) { tvmazeStats.failures++; throw err; }
      tvmazeStats.retries++;
      await sleepMs(800 * attempt);
    }
  }
}
