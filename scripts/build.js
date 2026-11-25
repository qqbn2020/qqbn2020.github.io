/**
 * build.js — turn data/raw.json into a fully static site in dist/
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadEnv, isoDateInTZ, stampInTZ } from './tmdb.js';

loadEnv();

const CONFIG = JSON.parse(fs.readFileSync(path.resolve('site.config.json'), 'utf8'));
const RAW = JSON.parse(fs.readFileSync(path.resolve('data/raw.json'), 'utf8'));

// content-hashed asset query so a cached styles.css can never serve stale CSS
const ASSET_VER = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['styles.css', 'app.js']) h.update(fs.readFileSync(path.resolve('assets', f)));
  return h.digest('hex').slice(0, 8);
})();

const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const TZ = CONFIG.timezone || 'Asia/Shanghai';
const TODAY = RAW.window?.today || isoDateInTZ(TZ);
const DIST = path.resolve('dist');

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MONTH_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

/* ------------------------------------------------------------------ */
/* utils                                                               */
/* ------------------------------------------------------------------ */
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function slugify(s) {
  const out = String(s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return out || 'x';
}

const weekdayOf = (iso) => WEEK_CN[new Date(iso + 'T00:00:00Z').getUTCDay()];
const monthOf = (iso) => iso.slice(0, 7);
const dayOf = (iso) => iso.slice(8, 10);
const fmtCN = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${y}年${Number(m)}月${Number(d)}日`;
};
const fmtShort = (iso) => {
  const [, m, d] = iso.split('-');
  return `${Number(m)}月${Number(d)}日`;
};

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function relDay(iso) {
  const diff = daysBetween(TODAY, iso);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff === -1) return '昨天';
  return '';
}

// "S01E01–E08" for binge drops, "S01E01" for a single episode
function epRangeLabel(eps) {
  const pad = (n) => String(n).padStart(2, '0');
  if (!eps.length) return '';
  if (eps.length === 1) return `S${pad(eps[0].season)}E${pad(eps[0].episode)}`;
  const first = eps[0];
  const last = eps[eps.length - 1];
  if (first.season !== last.season) {
    return `S${pad(first.season)}E${pad(first.episode)}–S${pad(last.season)}E${pad(last.episode)}`;
  }
  const nums = eps.map((e) => e.episode);
  const contiguous = nums.every((v, i) => i === 0 || v === nums[i - 1] + 1);
  return contiguous
    ? `S${pad(first.season)}E${pad(nums[0])}–E${pad(nums[nums.length - 1])}`
    : `S${pad(first.season)}E${pad(nums[0])} 等${eps.length}集`;
}

function writePage(urlPath, html) {
  const file = urlPath.endsWith('/') ? path.join(DIST, urlPath, 'index.html') : path.join(DIST, urlPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
}

const pagesIndex = []; // for sitemap: {url, lastmod, priority}

/* ------------------------------------------------------------------ */
/* normalize                                                           */
/* ------------------------------------------------------------------ */
const entries = [];
const titles = new Map(); // key -> title object

for (const show of RAW.shows || []) {
  const key = `tv-${show.id}`;
  const title = show.name || show.original_name || '';
  const titleAlt = show.original_name && show.original_name !== title ? show.original_name : '';
  const url = `title/${key}-${slugify(show.original_name || show.name)}/`;
  const platform = show.networks?.[0]?.name || 'TV';
  titles.set(key, {
    key, type: 'tv', id: show.id, title, original: show.original_name, titleAlt,
    poster: show.poster, backdrop: show.backdrop, overview: show.overview,
    vote: show.vote, genres: show.genres || [], platform,
    networks: (show.networks || []).map((n) => n.name),
    status: show.status, first: show.first_air_date, url,
    episodes: [...show.episodes].sort((a, b) => a.air_date.localeCompare(b.air_date) || a.season - b.season || a.episode - b.episode),
    homepage: show.homepage,
  });
  // one entry per episode group per date — binge drops collapse into one card
  const byDateMap = new Map();
  for (const ep of show.episodes) {
    if (!byDateMap.has(ep.air_date)) byDateMap.set(ep.air_date, []);
    byDateMap.get(ep.air_date).push(ep);
  }
  for (const [date, eps] of byDateMap) {
    const sorted = eps.sort((a, b) => a.season - b.season || a.episode - b.episode);
    entries.push({
      id: `${key}-${date}`,
      type: 'tv', key,
      title, titleAlt,
      sub: epRangeLabel(sorted),
      epTitle: sorted.length > 1 ? `本日上线 ${sorted.length} 集` : (sorted[0].name || ''),
      date,
      platform,
      poster: show.poster,
      overview: sorted[0].overview || show.overview,
      url, vote: show.vote, genres: show.genres || [],
      season: sorted[0].season, episode: sorted[0].episode,
      count: sorted.length,
    });
  }
}

for (const movie of RAW.movies || []) {
  const key = `mv-${movie.id}`;
  const title = movie.title || movie.original_title || '';
  const titleAlt = movie.original_title && movie.original_title !== title ? movie.original_title : '';
  const url = `title/${key}-${slugify(movie.original_title || movie.title)}/`;
  const genreNames = (movie.genre_ids || []).map((id) => RAW.genres?.movie?.[id]).filter(Boolean);
  titles.set(key, {
    key, type: 'movie', id: movie.id, title, original: movie.original_title, titleAlt,
    poster: movie.poster, backdrop: movie.backdrop, overview: movie.overview,
    vote: movie.vote, genres: genreNames, platform: '院线',
    status: '院线上映', first: movie.release_date, url,
    episodes: [{ season: 0, episode: 0, name: '院线上映', air_date: movie.release_date, overview: movie.overview }],
    homepage: '',
  });
  entries.push({
    id: key, type: 'movie', key,
    title, titleAlt, sub: '院线上映', epTitle: '',
    date: movie.release_date, platform: '院线',
    poster: movie.poster, overview: movie.overview,
    url, vote: movie.vote, genres: genreNames,
    season: 0, episode: 0,
  });
}

entries.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || (b.vote || 0) - (a.vote || 0));

const byDate = new Map();
for (const e of entries) {
  if (!byDate.has(e.date)) byDate.set(e.date, []);
  byDate.get(e.date).push(e);
}
const dates = [...byDate.keys()].sort();
const months = [...new Set(dates.map(monthOf))].sort();

/* ------------------------------------------------------------------ */
/* layout                                                              */
/* ------------------------------------------------------------------ */
const NAV = [
  ['index.html', '首页', 'home'],
  [`calendar/${monthOf(TODAY)}/`, '月历', 'calendar'],
  ['tv/', '剧集', 'tv'],
  ['movie/', '电影', 'movie'],
  ['subscribe/', '订阅', 'subscribe'],
  ['about/', '关于', 'about'],
];

function activeKey(url = '') {
  if (!url || url === 'index.html') return 'home';
  if (url.startsWith('calendar') || url.startsWith('day')) return 'calendar';
  if (url.startsWith('tv/')) return 'tv';
  if (url.startsWith('movie/')) return 'movie';
  if (url.startsWith('subscribe') || url.startsWith('ics')) return 'subscribe';
  if (url.startsWith('about')) return 'about';
  return '';
}

const OG_FALLBACK = (entries.find((e) => e.poster && e.type === 'tv') || entries.find((e) => e.poster) || {}).poster || '';

function layout({ title, desc, url, root = './', body, cls = '', jsonld = null, image = '', type = 'website' }) {
  const fullTitle = title ? `${title} · ${CONFIG.name}` : `${CONFIG.name} · ${CONFIG.tagline}`;
  const canonical = SITE_URL ? `<link rel="canonical" href="${SITE_URL}/${url}">` : '';
  const ogImg = image || OG_FALLBACK;
  const active = activeKey(url);
  return `<!doctype html>
<html lang="${CONFIG.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
<meta name="theme-color" content="#f7f8fb">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="${esc(CONFIG.name)}">
<meta property="og:locale" content="zh_CN">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(desc)}">
${SITE_URL ? `<meta property="og:url" content="${SITE_URL}/${url}">` : ''}
${ogImg ? `<meta property="og:image" content="${esc(ogImg)}">
<meta property="og:image:alt" content="${esc(fullTitle)}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(fullTitle)}">
<meta name="twitter:description" content="${esc(desc)}">
${ogImg ? `<meta name="twitter:image" content="${esc(ogImg)}">` : ''}
${canonical}
<link rel="stylesheet" href="${root}assets/styles.css?v=${ASSET_VER}">
<link rel="alternate" type="application/rss+xml" title="${esc(CONFIG.name)}" href="${root}feed.xml">
<link rel="icon" href="${root}assets/favicon.svg" type="image/svg+xml">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
</head>
<body class="${cls}">
<header class="site-head">
  <div class="wrap head-inner">
    <a class="brand" href="${root}index.html"><span class="logo"></span>${esc(CONFIG.name)}</a>
    <nav class="nav">
      ${NAV.map(([href, label, key]) => `<a href="${root}${href}"${key === active ? ' class="is-on"' : ''}>${label}</a>`).join('')}
    </nav>
  </div>
</header>
<main class="wrap">
${body}
</main>
<footer class="site-foot">
  <div class="wrap foot-grid${promoOn ? '' : ' solo'}">
    <div class="foot-col">
      <p class="foot-brand"><span class="logo"></span>${esc(CONFIG.name)}</p>
      <p class="foot-note">数据定时更新，最近构建 <time datetime="${esc(RAW.generated_at)}">${esc(stampInTZ(TZ, new Date(RAW.generated_at)))}</time> 北京时间${RAW.demo ? ' · <strong>演示数据</strong>' : ''}</p>
      <p class="foot-note">日期按作品播出 / 上映当地日期记录，晚间档通常对应北京时间次日上午。</p>
      <p class="foot-note">${esc(CONFIG.attribution.tmdbZh)} <a href="https://www.themoviedb.org/" rel="noopener nofollow" target="_blank">TMDB</a></p>
    </div>
    ${promoOn ? `<div class="foot-col foot-promo">
      <img class="qr" src="${root}${PROMO.qr}" alt="${esc(PROMO.alt || PROMO.label || '二维码')}" width="104" height="104" decoding="async">
      <div class="promo-copy">
        <p class="promo-eyebrow">${esc(PROMO.label || '微信公众号')}</p>
        <p class="promo-line">${esc(PROMO.slogan || '')}</p>
      </div>
    </div>` : ''}
  </div>
</footer>
<script src="${root}assets/app.js?v=${ASSET_VER}" defer></script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* components                                                          */
/* ------------------------------------------------------------------ */
function posterBlock(item, root, size = '') {
  if (item.poster) {
    return `<img class="poster-img" src="${esc(item.poster)}" alt="${esc(item.title)} 海报" loading="lazy" decoding="async">`;
  }
  return `<div class="poster-img ph" aria-hidden="true"><span>${esc((item.title || '?').slice(0, 1))}</span></div>`;
}

function badge(e) {
  if (e.type === 'movie') return `<span class="badge movie">电影</span>`;
  return `<span class="badge">${esc(e.sub)}</span>`;
}

function card(e, root, { showDate = false } = {}) {
  const followed = false;
  return `<article class="card" data-item data-type="${e.type}" data-key="${e.key}" data-title="${esc((e.title + ' ' + (e.titleAlt || '') + ' ' + (e.epTitle || '')).toLowerCase())}">
  <a class="poster ${e.poster ? '' : 'empty'}" href="${root}${e.url}" aria-label="${esc(e.title)}">
    ${posterBlock(e, root)}
    ${badge(e)}
  </a>
  <div class="card-body">
    <h3><a href="${root}${e.url}">${esc(e.title)}</a></h3>
    ${e.epTitle ? `<p class="ep-title">${esc(e.epTitle)}</p>` : `<p class="ep-title muted">${e.type === 'movie' ? '院线上映' : ''}</p>`}
    <div class="meta">
      ${showDate ? `<span class="tag date">${fmtShort(e.date)} ${weekdayOf(e.date)}</span>` : ''}
      <span class="tag net">${esc(e.platform)}</span>
      ${e.vote ? `<span class="tag rate">★ ${Number(e.vote).toFixed(1)}</span>` : ''}
      <button class="star" data-follow="${e.key}" title="收藏" aria-label="收藏">☆</button>
    </div>
  </div>
</article>`;
}

function titleCard(t, root) {
  const next = entries.find((e) => e.key === t.key && e.date >= TODAY);
  const line2 = t.titleAlt || t.genres.slice(0, 3).join(' · ');
  return `<article class="card" data-item data-type="${t.type}" data-key="${t.key}" data-title="${esc((t.title + ' ' + (t.titleAlt || '')).toLowerCase())}">
  <a class="poster${t.poster ? '' : ' empty'}" href="${root}${t.url}" aria-label="${esc(t.title)}">
    ${posterBlock(t, root)}
    ${t.type === 'movie' ? '<span class="badge movie">电影</span>' : ''}
  </a>
  <div class="card-body">
    <h3><a href="${root}${t.url}">${esc(t.title)}</a></h3>
    <p class="ep-title${line2 ? '' : ' muted'}">${esc(line2)}</p>
    <div class="meta">
      ${next ? `<span class="tag date">${fmtShort(next.date)} ${weekdayOf(next.date)}</span>` : '<span class="tag">暂无排期</span>'}
      <span class="tag net">${esc(t.platform)}</span>
      ${t.vote ? `<span class="tag rate">★ ${Number(t.vote).toFixed(1)}</span>` : ''}
      <button class="star" data-follow="${t.key}" title="收藏" aria-label="收藏">☆</button>
    </div>
  </div>
</article>`;
}

function daySection(date, root, { showDate = true } = {}) {
  const list = byDate.get(date) || [];
  if (!list.length) return '';
  const rel = relDay(date);
  return `<section class="dayblock" id="${date}">
  <div class="dayhead">
    <a class="dlink" href="${root}day/${date}/">
      <span class="dnum">${fmtShort(date)}</span>
      <span class="dweek">${weekdayOf(date)}</span>
      ${rel ? `<span class="rel">${rel}</span>` : ''}
    </a>
    <span class="dcount">${list.length} 条</span>
  </div>
  <div class="cards">
    ${list.map((e) => card(e, root, { showDate: false })).join('')}
  </div>
</section>`;
}

function filterBar({ types = ['tv', 'movie'] } = {}) {
  const label = { all: '全部', tv: '剧集', movie: '电影', follow: '只看收藏' };
  const keys = ['all', ...types, 'follow'];
  return `<div class="filters" data-filterable>
  <div class="chips" role="group" aria-label="筛选">
    ${keys.map((k, i) => `<button class="chip${i === 0 ? ' is-on' : ''}" data-filter-value="${k}">${label[k]}</button>`).join('')}
  </div>
  <div class="search">
    <input type="search" placeholder="搜索剧名 / 电影 / 集名" data-search aria-label="搜索">
  </div>
</div>`;
}

function compareLine() {
  return `<div class="empty-hint" hidden data-empty>没有匹配的条目，换个关键词或切换筛选。</div>`;
}

const PROMO = CONFIG.promo || {};
const promoOn = PROMO.enabled !== false && !!PROMO.qr;

/* ------------------------------------------------------------------ */
/* pages                                                               */
/* ------------------------------------------------------------------ */
// index
function buildIndex() {
  const next7 = dates.filter((d) => d >= TODAY && d <= addDays(TODAY, 6));
  const todayList = byDate.get(TODAY) || [];
  const tvToday = todayList.filter((e) => e.type === 'tv').length;
  const mvToday = todayList.filter((e) => e.type === 'movie').length;
  const totalTv = [...titles.values()].filter((t) => t.type === 'tv').length;
  const totalMv = [...titles.values()].filter((t) => t.type === 'movie').length;

  const body = `
<section class="hero">
  <p class="kicker">${esc(CONFIG.tagline)}</p>
  <h1>今天看什么</h1>
  <p class="hero-date">${fmtCN(TODAY)} · ${weekdayOf(TODAY)} · 北京时间</p>
  <div class="stats">
    <div class="stat"><strong>${tvToday}</strong><span>今日剧集</span></div>
    <div class="stat"><strong>${mvToday}</strong><span>今日上映</span></div>
    <div class="stat"><strong>${totalTv}</strong><span>在播剧集</span></div>
    <div class="stat"><strong>${totalMv}</strong><span>新片</span></div>
  </div>
</section>

${filterBar()}
<div class="hint-row"><span class="hint">按播出日期排列，点击日期查看当天全部条目</span></div>

${todayList.length ? daySection(TODAY, './') : `<section class="dayblock"><div class="dayhead"><span class="dnum">今天没有排期</span></div><p class="muted">今天没有抓取到播出条目，可以看接下来的排期。</p></section>`}

<h2 class="section-title">接下来一周</h2>
${next7.filter((d) => d !== TODAY).map((d) => daySection(d, './')).join('') || '<p class="muted">暂无数据</p>'}

<p class="more-link"><a href="calendar/${monthOf(TODAY)}/">查看完整月历 →</a> <a href="tv/">全部剧集 →</a> <a href="movie/">全部电影 →</a></p>
${compareLine()}`;

  writePage('index.html', layout({
    title: '', url: '',
    desc: CONFIG.description,
    body,
    jsonld: {
      '@context': 'https://schema.org', '@type': 'WebSite',
      name: CONFIG.name, description: CONFIG.description,
      ...(SITE_URL ? { url: SITE_URL + '/' } : {}),
    },
  }));
  pagesIndex.push({ url: 'index.html', lastmod: RAW.generated_at.slice(0, 10), priority: '1.0' });
}

// calendar month
function buildMonths() {
  const monthsWithData = months;
  for (const m of monthsWithData) {
    const [y, mm] = m.split('-');
    const first = `${m}-01`;
    const pad = new Date(first + 'T00:00:00Z').getUTCDay();
    const daysInMonth = new Date(Date.UTC(Number(y), Number(mm), 0)).getUTCDate();
    const idx = monthsWithData.indexOf(m);
    const prev = monthsWithData[idx - 1];
    const next = monthsWithData[idx + 1];

    let cells = '';
    for (let i = 0; i < pad; i++) cells += `<div class="cell is-blank"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${m}-${String(d).padStart(2, '0')}`;
      const list = byDate.get(iso) || [];
      const isToday = iso === TODAY;
      const items = list.slice(0, 3).map((e) => `<li><a href="../../${e.url}" class="mini ${e.type}"><span class="mini-t">${esc(e.title)}</span><em>${esc(e.sub)}</em></a></li>`).join('');
      cells += `<div class="cell${isToday ? ' is-today' : ''}${list.length ? '' : ' is-empty'}">
  <a class="cell-d" href="../../day/${iso}/">${d}</a>
  <ul class="mini-list">${items}</ul>
  ${list.length ? `<span class="cell-count">${list.length}</span>` : ''}
  ${list.length > 3 ? `<span class="more">+${list.length - 3}</span>` : ''}
</div>`;
    }

    const body = `
<section class="page-head">
  <h1>${y} 年 ${Number(mm)} 月播出日历</h1>
  <p class="muted">本月共 ${entries.filter((e) => monthOf(e.date) === m).length} 条播出 / 上映记录</p>
</section>
<div class="month-nav">
  ${prev ? `<a href="../${prev}/">← ${prev}</a>` : '<span></span>'}
  <span class="month-title">${y} 年 ${Number(mm)} 月</span>
  ${next ? `<a href="../${next}/">${next} →</a>` : '<span></span>'}
</div>
<div class="month-grid">
  <div class="weekdays">${['日', '一', '二', '三', '四', '五', '六'].map((w) => `<span>${w}</span>`).join('')}</div>
  <div class="grid">${cells}</div>
</div>
<div class="legend"><span class="dot tv"></span>剧集 <span class="dot movie"></span>电影 <span class="dot today"></span>今天</div>
${compareLine()}`;

    writePage(`calendar/${m}/`, layout({
      title: `${y}年${Number(mm)}月播出日历`,
      desc: `${y}年${Number(mm)}月剧集播出与电影上映日历，每日更新。`,
      url: `calendar/${m}/`, root: '../../', body, cls: 'page-calendar',
    }));
    pagesIndex.push({ url: `calendar/${m}/`, lastmod: RAW.generated_at.slice(0, 10), priority: '0.8' });
  }
}

// day page
function buildDays() {
  for (const date of dates) {
    const list = byDate.get(date) || [];
    const prev = addDays(date, -1);
    const next = addDays(date, 1);
    const body = `
<section class="page-head">
  <p class="crumb"><a href="../../calendar/${monthOf(date)}/">月历</a> / ${fmtShort(date)}</p>
  <h1>${fmtCN(date)} ${weekdayOf(date)}</h1>
  <p class="muted">${list.length} 条播出 / 上映记录${relDay(date) ? ' · ' + relDay(date) : ''}</p>
</section>
<div class="day-nav">
  <a href="../../day/${prev}/">← 前一天</a>
  <a href="../../">回到今天</a>
  <a href="../../day/${next}/">后一天 →</a>
</div>
${filterBar()}
<div class="cards day-cards">${list.map((e) => card(e, '../../', { showDate: false })).join('')}</div>
${compareLine()}`;

    writePage(`day/${date}/`, layout({
      title: `${fmtShort(date)} ${weekdayOf(date)} 播出日历`,
      desc: `${fmtCN(date)}剧集播出与电影上映安排，共 ${list.length} 条。`,
      url: `day/${date}/`, root: '../../', body,
    }));
    pagesIndex.push({ url: `day/${date}/`, lastmod: RAW.generated_at.slice(0, 10), priority: '0.7' });
  }
}

// title page
function buildTitles() {
  for (const t of titles.values()) {
    const list = byDate.size ? entries.filter((e) => e.key === t.key) : [];
    if (!list.length) continue;
    const next = list.find((e) => e.date >= TODAY) || list[list.length - 1];
    const isMovie = t.type === 'movie';
    const jsonld = [{
      '@context': 'https://schema.org',
      '@type': isMovie ? 'Movie' : 'TVSeries',
      name: t.title,
      ...(t.titleAlt ? { alternateName: t.titleAlt } : {}),
      ...(t.overview ? { description: t.overview.slice(0, 300) } : {}),
      ...(t.poster ? { image: t.poster } : {}),
      ...(isMovie ? { dateCreated: t.first } : { startDate: t.first }),
      ...(t.vote ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: Number(t.vote).toFixed(1), bestRating: '10', ratingCount: 1 } } : {}),
    }, {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '首页', item: SITE_URL ? `${SITE_URL}/` : '/' },
        { '@type': 'ListItem', position: 2, name: isMovie ? '电影' : '剧集', item: SITE_URL ? `${SITE_URL}/${isMovie ? 'movie' : 'tv'}/` : `/${isMovie ? 'movie' : 'tv'}/` },
        { '@type': 'ListItem', position: 3, name: t.title },
      ],
    }];

    const body = `
<section class="title-hero">
  <div class="title-poster">${posterBlock(t, '../../')}</div>
  <div class="title-info">
    <p class="crumb"><a href="../../${isMovie ? 'movie' : 'tv'}/">${isMovie ? '电影' : '剧集'}</a> / ${esc(t.platform)}</p>
    <h1>${esc(t.title)}</h1>
    ${t.titleAlt ? `<p class="origin">${esc(t.titleAlt)}</p>` : ''}
    <div class="meta big">
      ${t.vote ? `<span class="tag rate">★ ${Number(t.vote).toFixed(1)}</span>` : ''}
      ${t.genres.map((g) => `<span class="tag">${esc(g)}</span>`).join('')}
      <span class="tag net">${esc(t.platform)}</span>
      ${t.status ? `<span class="tag">${esc(t.status)}</span>` : ''}
    </div>
    <p class="overview">${esc(t.overview || '暂无简介。')}</p>
    <div class="actions">
      <button class="star-btn" data-follow="${t.key}">☆ 收藏</button>
      <a class="btn" href="../../ics/${t.key}.ics" download>下载日历 (.ics)</a>
      ${t.homepage ? `<a class="btn ghost" href="${esc(t.homepage)}" target="_blank" rel="noopener nofollow">TMDB 页面</a>` : ''}
    </div>
  </div>
</section>

<h2 class="section-title">${isMovie ? '上映信息' : '播出记录'}</h2>
<div class="schedule">
  ${list.map((e) => `<div class="row" data-item data-type="${e.type}" data-title="${esc((e.title + ' ' + (e.epTitle || '')).toLowerCase())}">
    <a class="row-date" href="../../day/${e.date}/">${fmtShort(e.date)}<em>${weekdayOf(e.date)}</em></a>
    <div class="row-main">
      <span class="row-sub">${esc(e.type === 'movie' ? '院线上映' : e.sub)}</span>
      <span class="row-ep">${esc(e.type === 'movie' ? '' : e.epTitle)}</span>
    </div>
    <span class="row-rel">${relDay(e.date)}</span>
  </div>`).join('')}
</div>
${next ? `<p class="next-hint">${next.date >= TODAY ? '下一次：' : '最近一次：'}${fmtCN(next.date)}（${weekdayOf(next.date)}）</p>` : ''}`;

    writePage(t.url, layout({
      title: `${t.title}${isMovie ? '' : ' 播出时间表'}`,
      desc: `${t.title}${t.titleAlt ? '（' + t.titleAlt + '）' : ''}的${isMovie ? '上映日期' : '播出时间表'}，平台 ${t.platform}。${t.overview ? t.overview.slice(0, 120) : ''}`,
      url: t.url, root: '../../', body, jsonld, cls: 'page-title',
      image: t.poster || '', type: isMovie ? 'video.movie' : 'video.tv_show',
    }));
    pagesIndex.push({ url: t.url, lastmod: RAW.generated_at.slice(0, 10), priority: '0.7' });
  }
}

// index pages for tv / movie
function buildTypeIndex(type) {
  const list = [...titles.values()].filter((t) => t.type === type).sort((a, b) => {
    const na = (entries.find((e) => e.key === a.key && e.date >= TODAY) || {}).date || '9999';
    const nb = (entries.find((e) => e.key === b.key && e.date >= TODAY) || {}).date || '9999';
    return na.localeCompare(nb) || b.title.localeCompare(a.title);
  });

  const heading = type === 'tv' ? '在播剧集' : '新上映电影';
  const lead = type === 'tv'
    ? `共 ${list.length} 部在播与即将开播的剧集，按下一次播出时间排列，点进任意一部可看完整时间表。`
    : `共 ${list.length} 部正在上映与即将上映的电影，按上映时间排列，点进任意一部可看上映信息。`;

  const body = `
<section class="page-head">
  <h1>${heading}</h1>
  <p class="muted">${lead}</p>
</section>
${filterBar({ types: [type] })}
<div class="cards" data-filterable>
  ${list.map((t) => titleCard(t, '../')).join('')}
</div>
${compareLine()}
<p class="more-link"><a href="../calendar/${monthOf(TODAY)}/">按月查看 →</a></p>`;

  writePage(`${type}/`, layout({
    title: type === 'tv' ? '在播剧集列表' : '上映电影列表',
    desc: type === 'tv' ? '在播与即将开播的剧集列表，含每部剧的下次播出日期、平台与评分。' : '正在上映与即将上映的电影列表，含上映日期、发行与评分。',
    url: `${type}/`, root: '../', body, cls: 'page-index',
    jsonld: {
      '@context': 'https://schema.org', '@type': 'ItemList',
      name: heading,
      numberOfItems: list.length,
      itemListElement: list.slice(0, 50).map((t, i) => ({
        '@type': 'ListItem', position: i + 1, name: t.title,
        url: SITE_URL ? `${SITE_URL}/${t.url}` : t.url,
      })),
    },
  }));
  pagesIndex.push({ url: `${type}/`, lastmod: RAW.generated_at.slice(0, 10), priority: '0.8' });
}

// platform pages
function buildPlatforms() {
  const map = new Map();
  for (const e of entries) {
    const p = e.platform || '其他';
    if (!map.has(p)) map.set(p, []);
    map.get(p).push(e);
  }
  for (const [platform, list] of map) {
    if (list.length < 3) continue;
    const slug = slugify(platform);
    const url = `platform/${slug}/`;
    const body = `
<section class="page-head">
  <p class="crumb"><a href="../../">首页</a> / 平台</p>
  <h1>${esc(platform)} 播出日历</h1>
  <p class="muted">共 ${list.length} 条排期</p>
</section>
<div class="cards">
  ${dates.filter((d) => list.some((e) => e.date === d)).map((d) => `
    <h2 class="section-title small">${fmtShort(d)} ${weekdayOf(d)}</h2>
    <div class="cards tight">${list.filter((e) => e.date === d).map((e) => card(e, '../../')).join('')}</div>
  `).join('')}
</div>`;
    writePage(url, layout({
      title: `${platform} 播出日历`,
      desc: `${platform} 旗下剧集与电影的上映排期。`,
      url, root: '../../', body,
    }));
    pagesIndex.push({ url, lastmod: RAW.generated_at.slice(0, 10), priority: '0.5' });
  }
}

// subscribe page
function buildSubscribe() {
  const body = `
<section class="page-head">
  <h1>订阅播出日历</h1>
  <p class="muted">把排期加进你的日历应用，新集数自动出现。</p>
</section>
<div class="panel">
  <h2>整站日历</h2>
  <p>包含本站当前窗口内全部剧集与电影排期，全日期事件。</p>
  <p><a class="btn" href="../ics/all.ics" download>下载 all.ics</a> ${months.map((m) => `<a class="btn ghost" href="../ics/${m}.ics" download>${m}</a>`).join(' ')}</p>
  <p class="muted small">支持 Google Calendar、Apple 日历、Outlook。在日历应用中「订阅日历 / 通过 URL 添加」粘贴下方链接即可自动同步。</p>
  <pre class="code">${SITE_URL ? SITE_URL + '/ics/all.ics' : 'https://&lt;你的域名&gt;/ics/all.ics'}</pre>
</div>
<div class="panel">
  <h2>单部作品</h2>
  <p>在每部剧 / 电影的详情页点「下载日历 (.ics)」，只订阅这一部。</p>
  <div class="list compact">
    ${[...titles.values()].slice(0, 40).map((t) => `<a class="row mini-row" href="../${t.url}"><span class="row-name">${esc(t.title)}</span><span class="row-when">${esc(t.platform)}</span></a>`).join('')}
  </div>
</div>
<div class="panel">
  <h2>RSS</h2>
  <p><a class="btn ghost" href="../feed.xml">订阅更新源</a></p>
</div>`;
  writePage('subscribe/', layout({
    title: '订阅', desc: '通过 iCal / RSS 订阅剧集与电影的播出日历。', url: 'subscribe/', root: '../', body,
  }));
  pagesIndex.push({ url: 'subscribe/', lastmod: RAW.generated_at.slice(0, 10), priority: '0.6' });
}

// about
function buildAbout() {
  const body = `
<section class="page-head">
  <h1>关于本站</h1>
  <p class="muted">一个纯静态的剧集 / 电影播出日历，只做排期索引。</p>
</section>
<div class="panel prose">
  <h2>这个站做什么</h2>
  <p>把每周的剧集更新与院线新片排期整理成一张日历：今天有什么可看、接下来一周排了什么、每部剧下一次更新在哪天。全部页面预渲染成静态文件，打开即读，不需要登录。</p>
  <h2>数据来源</h2>
  <p>剧集与电影元数据、海报来自 <a href="https://www.themoviedb.org/" target="_blank" rel="noopener nofollow">TMDB</a>：剧集取每集首播日期，电影取院线上映日期。海报版权归各制片方与发行方所有。</p>
  <h2>更新方式</h2>
  <p>GitHub Actions 定时任务每天运行多次（北京时间 00:15 / 04:15 / 08:15 / 12:15 / 16:15 / 20:15），拉取最新排期后重新生成整站。</p>
  <h2>日期与时区</h2>
  <p>页面上的「今天」按北京时间计算；条目日期为作品播出 / 上映当地日期。晚间档（当地 20:00–22:00）通常对应北京时间次日上午。</p>
  <h2>收录范围</h2>
  <p>剧集收录在播与即将开播的常规剧集，特别篇（Season 0）不收录；电影收录院线上映条目，流媒体独播片不在日历内。脱口秀、新闻、肥皂剧与竞猜类节目默认排除。</p>
  <h2>标题语言</h2>
  <p>标题、简介与集名优先显示 TMDB 的简体中文译名；没有中文译名的作品回落显示英文原名，详情页同时保留原名，方便对照。</p>
  <h2>版权与声明</h2>
  <p>${esc(CONFIG.attribution.tmdbZh)}</p>
</div>`;
  writePage('about/', layout({
    title: '关于', desc: '本站数据来源、更新方式与时区说明。', url: 'about/', root: '../', body, cls: 'page-about',
  }));
  pagesIndex.push({ url: 'about/', lastmod: RAW.generated_at.slice(0, 10), priority: '0.4' });
}

/* ------------------------------------------------------------------ */
/* feeds                                                               */
/* ------------------------------------------------------------------ */
function icsDate(iso) { return iso.replace(/-/g, ''); }
function icsEscape(s = '') {
  return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

// RFC 5545 §3.1 — fold content lines longer than 75 octets
function foldLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, 'utf8') > 75) {
      out.push(cur);
      cur = ' ' + ch;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.join('\r\n');
}
const DTSTAMP = new Date(RAW.generated_at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function icsEvent(e, host) {
  const summary = e.type === 'movie' ? `[电影] ${e.title}` : `[剧] ${e.title} ${e.sub}${e.epTitle ? ' ' + e.epTitle : ''}`;
  return [
    'BEGIN:VEVENT',
    `UID:${e.id}@${host}`,
    `DTSTAMP:${DTSTAMP}`,
    `DTSTART;VALUE=DATE:${icsDate(e.date)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(`${e.platform}｜${e.overview || ''}`.slice(0, 300))}`,
    `CATEGORIES:${e.type === 'movie' ? '电影' : '剧集'}`,
    'END:VEVENT',
  ].map(foldLine).join('\r\n');
}

function buildIcs() {
  const host = (SITE_URL || 'tv-date.local').replace(/^https?:\/\//, '');
  const head = (name) => [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//tv-date//TV & Movie Calendar//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(name)}`,
    'X-WR-TIMEZONE:Asia/Shanghai',
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
  ].map(foldLine).join('\r\n');

  const writeIcs = (rel, content) => {
    const file = path.join(DIST, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content + '\r\nEND:VCALENDAR\r\n');
  };

  writeIcs('ics/all.ics', head(`${CONFIG.name} · 全部排期`) + '\r\n' + entries.map((e) => icsEvent(e, host)).join('\r\n'));

  for (const m of months) {
    const list = entries.filter((e) => monthOf(e.date) === m);
    writeIcs(`ics/${m}.ics`, head(`${CONFIG.name} · ${m}`) + '\r\n' + list.map((e) => icsEvent(e, host)).join('\r\n'));
  }

  for (const t of titles.values()) {
    const list = entries.filter((e) => e.key === t.key);
    if (!list.length) continue;
    writeIcs(`ics/${t.key}.ics`, head(`${CONFIG.name} · ${t.title}`) + '\r\n' + list.map((e) => icsEvent(e, host)).join('\r\n'));
  }
}

function buildFeed() {
  const base = SITE_URL || '';
  const items = dates
    .filter((d) => d >= TODAY && d <= addDays(TODAY, CONFIG.feeds.rssItemDays))
    .map((d) => {
      const list = byDate.get(d);
      const names = list.slice(0, 6).map((e) => `${e.title}${e.type === 'tv' ? ' ' + e.sub : ''}`).join('、');
      return `<item>
  <title>${esc(fmtCN(d))} 播出日历（${list.length} 条）</title>
  <link>${base}/day/${d}/</link>
  <guid isPermaLink="true">${base}/day/${d}/</guid>
  <pubDate>${new Date(d + 'T00:00:00+08:00').toUTCString()}</pubDate>
  <description>${esc(names)}</description>
</item>`;
    }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${esc(CONFIG.name)}</title>
<link>${base}/</link>
<description>${esc(CONFIG.description)}</description>
<language>zh-cn</language>
<lastBuildDate>${new Date(RAW.generated_at).toUTCString()}</lastBuildDate>
${items}
</channel></rss>`;
  fs.writeFileSync(path.join(DIST, 'feed.xml'), xml);
}

function buildSitemap() {
  const base = SITE_URL || '';
  const urls = pagesIndex
    .sort((a, b) => a.url.localeCompare(b.url))
    .map(({ url, lastmod, priority }) => `  <url><loc>${base}/${url}</loc><lastmod>${lastmod}</lastmod><priority>${priority}</priority></url>`)
    .join('\n');
  fs.writeFileSync(path.join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);

  fs.writeFileSync(path.join(DIST, 'robots.txt'),
    `User-agent: *\nAllow: /\n${base ? `Sitemap: ${base}/sitemap.xml\n` : ''}`);
}

/* ------------------------------------------------------------------ */
/* data + static assets                                                */
/* ------------------------------------------------------------------ */
function buildData() {
  const slim = entries.map((e) => ({
    id: e.id, type: e.type, key: e.key, title: e.title, title_alt: e.titleAlt || '', sub: e.sub, ep: e.epTitle,
    date: e.date, platform: e.platform, poster: e.poster || '', url: e.url,
  }));
  fs.mkdirSync(path.join(DIST, 'data'), { recursive: true });
  fs.writeFileSync(path.join(DIST, 'data/entries.json'), JSON.stringify({
    generated_at: RAW.generated_at,
    today: TODAY,
    count: slim.length,
    entries: slim,
  }));
}

function copyAssets() {
  const src = path.resolve('assets');
  const dst = path.join(DIST, 'assets');
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
}

function build404() {
  const body = `
<section class="page-head">
  <h1>页面不存在</h1>
  <p class="muted">可能是排期窗口已滚动，旧日期页面会被回收。</p>
  <p><a class="btn" href="../index.html">回到首页</a></p>
</section>`;
  fs.writeFileSync(path.join(DIST, '404.html'), layout({ title: '404', desc: '页面不存在', body, root: './' }));
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

copyAssets();
buildIndex();
buildMonths();
buildDays();
buildTitles();
buildTypeIndex('tv');
buildTypeIndex('movie');
buildPlatforms();
buildSubscribe();
buildAbout();
buildIcs();
buildFeed();
buildSitemap();
buildData();
build404();
fs.writeFileSync(path.join(DIST, '.nojekyll'), '');

console.log(`built ${entries.length} entries · ${titles.size} titles · ${months.length} months · ${pagesIndex.length} pages → dist/`);
if (RAW.demo) console.log('NOTE: demo data in use — real data comes from the GitHub Actions run.');
