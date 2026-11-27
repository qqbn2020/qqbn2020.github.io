/**
 * indexnow.js — submit site URLs to IndexNow (api.indexnow.org, shared by
 * Bing / Yandex / Naver / Seznam / Yep and friends) so new day & title pages
 * get crawled quickly.
 *
 * Runs in CI *after* deployment: it fetches the live sitemap and verifies the
 * key file is reachable before submitting. Intentionally never exits non-zero —
 * a push failure must not fail the deploy job.
 *
 *   node scripts/indexnow.js
 *
 * Env:
 *   SITE_URL      required — e.g. https://qqbn2020.github.io
 *   INDEXNOW_KEY  optional override; falls back to site.config.json indexNow.key
 */
import fs from 'node:fs';
import path from 'node:path';

const CONFIG = JSON.parse(fs.readFileSync(path.resolve('site.config.json'), 'utf8'));
const KEY = (process.env.INDEXNOW_KEY || CONFIG.indexNow?.key || '').trim();
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');

const warn = (...a) => console.log('::warning::indexnow', ...a);
const log = (...a) => console.log('indexnow:', ...a);

if (!KEY) { warn('no key configured (site.config.json indexNow.key) — skipped'); process.exit(0); }
if (!SITE_URL) { warn('SITE_URL missing — skipped'); process.exit(0); }

const host = new URL(SITE_URL).host;
const keyLocation = `${SITE_URL}/${KEY}.txt`;

// IndexNow validates ownership by fetching keyLocation — check it first
const check = await fetch(keyLocation);
if (!check.ok || !(await check.text()).trim().startsWith(KEY)) {
  warn(`key file not live yet at ${keyLocation} — skipped, will retry next run`);
  process.exit(0);
}
log(`key file verified: ${keyLocation}`);

const res = await fetch(`${SITE_URL}/sitemap.xml`);
if (!res.ok) { warn(`sitemap fetch failed HTTP ${res.status} — skipped`); process.exit(0); }
const urls = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (!urls.length) { warn('sitemap has no <loc> entries — skipped'); process.exit(0); }

// protocol limit: 10,000 URLs per submission
const urlList = urls.slice(0, 10000);
const submit = await fetch('https://api.indexnow.org/IndexNow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host, key, keyLocation, urlList }),
});

if (submit.status === 200 || submit.status === 202) {
  log(`submitted ${urlList.length} urls to ${host} → HTTP ${submit.status}`);
} else {
  warn(`submission rejected HTTP ${submit.status}: ${(await submit.text().catch(() => '')).slice(0, 200)}`);
}
process.exit(0);
