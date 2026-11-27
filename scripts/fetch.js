/**
 * fetch.js — pull US TV episodes + US theatrical releases from TMDB.
 *
 *   node scripts/fetch.js            # live
 *   node scripts/fetch.js --demo     # offline sample data (layout preview)
 *
 * Output: data/raw.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { api, loadEnv, img, isoDate, isoDateInTZ, addDays, weekdayIndex, stats } from './tmdb.js';

loadEnv();

const argv = process.argv.slice(2);
const DEMO = argv.includes('--demo');

const CONFIG = JSON.parse(fs.readFileSync(path.resolve('site.config.json'), 'utf8'));
const BACK = Number(process.env.WINDOW_BACK || CONFIG.window.back);
const FORWARD = Number(process.env.WINDOW_FORWARD || CONFIG.window.forward);
const MAX_SHOWS = Number(process.env.MAX_SHOWS || 280);
const GENRE_BLOCK = new Set((CONFIG.genreBlock || []).map((g) => g.toLowerCase()));
// genre names are localized now, so blocking has to work off TMDB genre ids resolved from the English list
let GENRE_BLOCK_IDS = new Set();
// a daily strip occupies ~40+ distinct days inside the window; a binge drop of any size
// lands on 1–3 days. Judge by occupied days, not raw episode count.
const STRIP_MAX_DAYS = Number(process.env.STRIP_MAX_DAYS || CONFIG.maxDaysPerWindow || 18);

// TMDB network ids: broadcast + premium cable + streamers most relevant to a US calendar
const US_NETWORKS = [2, 3, 6, 16, 19, 24, 30, 32, 34, 41, 43, 47, 49, 64, 65, 67, 71, 74, 76, 77, 88, 174, 213, 318, 453, 1024, 2739, 3353, 4330, 2552];

const TODAY = process.env.FETCH_TODAY || isoDateInTZ(CONFIG.timezone || 'Asia/Shanghai');
const START = addDays(TODAY, -BACK);
const END = addDays(TODAY, FORWARD);

const inWindow = (d) => !!d && d >= START && d <= END;

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

/* ------------------------------------------------------------------ */
/* TV                                                                  */
/* ------------------------------------------------------------------ */
async function tvCandidates() {
  const seen = new Map();
  // windowHit: the candidate came from a discover query already scoped to the air-date
  // window, so a missing/stale next_episode_to_air later must not veto it
  const add = (list = [], windowHit = false) => {
    for (const s of list) {
      if (!s || !s.id) continue;
      const cur = seen.get(s.id);
      if (!cur) seen.set(s.id, { id: s.id, popularity: s.popularity || 0, name: s.name, windowHit });
      else if (windowHit) cur.windowHit = true;
    }
  };

  // 1) shows airing in the next 7 days / today — highest signal
  for (let page = 1; page <= 3; page++) {
    try { add((await api('/tv/on_the_air', { page })).results); }
    catch (e) { log('on_the_air p' + page, e.message); }
  }
  for (let page = 1; page <= 2; page++) {
    try { add((await api('/tv/airing_today', { page })).results); }
    catch (e) { log('airing_today p' + page, e.message); }
  }

  // 2) currently popular shows (covers returning series outside the 7-day window)
  for (let page = 1; page <= 4; page++) {
    try { add((await api('/tv/popular', { page })).results); }
    catch (e) { log('popular p' + page, e.message); }
  }

  // 3) discover by air-date window, scoped to major US networks
  for (const network of US_NETWORKS) {
    for (let page = 1; page <= 3; page++) {
      try {
        const r = await api('/discover/tv', {
          with_networks: network,
          with_origin_country: 'US',
          with_original_language: 'en',
          'air_date.gte': START,
          'air_date.lte': END,
          sort_by: 'popularity.desc',
          page,
        });
        add(r.results, true);
        if (page >= (r.total_pages || 1)) break;
      } catch (e) {
        log('discover/tv net' + network, e.message);
        break;
      }
    }
  }

  return [...seen.values()].sort((a, b) => b.popularity - a.popularity).slice(0, MAX_SHOWS);
}

async function collectShows(candidates) {
  const shows = [];
  for (const [i, c] of candidates.entries()) {
    try {
      const detail = await api(`/tv/${c.id}`);
      // Chinese-first: fall back to the English synopsis only when the zh translation is empty
      let overviewFallback = '';
      if (!detail.overview && detail.original_language === 'en') {
        try { overviewFallback = (await api(`/tv/${c.id}`, { language: 'en-US' })).overview || ''; } catch { /* optional */ }
      }
      const countries = detail.origin_country || [];
      // US-produced, English-language scripted / reality only
      if (!countries.includes('US')) continue;
      if (detail.original_language !== 'en') continue;
      if (GENRE_BLOCK.size && (detail.genres || []).some((g) => (GENRE_BLOCK_IDS.size ? GENRE_BLOCK_IDS.has(g.id) : GENRE_BLOCK.has(g.name.toLowerCase())))) continue;

      // pre-filter with TMDB's episode pointers so we skip season requests for idle shows.
      // Skip the check for shows discovered via a window-scoped query: TMDB's
      // next_episode_to_air can lag behind reality, and discover already proved the show
      // has an episode airing inside the window.
      if (!c.windowHit) {
        const hints = [detail.next_episode_to_air?.air_date, detail.last_episode_to_air?.air_date, detail.last_air_date]
          .filter(Boolean);
        if (!hints.some(inWindow)) continue;
      }

      // keep the seasons most likely to hold in-window episodes: the two newest aired
      // seasons plus any season TMDB's episode pointers reference (covers upcoming
      // seasons whose season-level air_date TMDB hasn't filled in yet)
      const hintSeasons = new Set(
        [detail.next_episode_to_air?.season_number, detail.last_episode_to_air?.season_number].filter((v) => v != null)
      );
      const seasons = (detail.seasons || [])
        .filter((s) => s.season_number > 0 && ((s.air_date && s.air_date <= END) || hintSeasons.has(s.season_number)))
        .sort((a, b) => b.season_number - a.season_number)
        .slice(0, 3);

      const episodes = [];
      for (const s of seasons) {
        const data = await api(`/tv/${c.id}/season/${s.season_number}`);
        for (const ep of data.episodes || []) {
          if (!inWindow(ep.air_date)) continue;
          episodes.push({
            season: ep.season_number,
            episode: ep.episode_number,
            name: ep.name && ep.name.trim().toUpperCase() !== 'TBA' ? ep.name : '',
            air_date: ep.air_date,
            overview: ep.overview || '',
            still: img(ep.still_path, 'w300'),
            runtime: ep.runtime || null,
            vote: ep.vote_average || null,
          });
        }
      }
      if (!episodes.length) continue;
      // daily strips (game shows, daytime soaps) would flood the calendar, but a
      // full-season binge drop is legit — compare distinct days, not episode count
      const occupiedDays = new Set(episodes.map((e) => e.air_date)).size;
      if (occupiedDays > STRIP_MAX_DAYS) continue;

      shows.push({
        id: detail.id,
        name: detail.name,
        original_name: detail.original_name,
        overview: detail.overview || overviewFallback || '',
        poster: img(detail.poster_path, 'w342'),
        backdrop: img(detail.backdrop_path, 'w780'),
        first_air_date: detail.first_air_date || '',
        status: detail.status || '',
        vote: detail.vote_average || null,
        popularity: detail.popularity || c.popularity,
        genres: (detail.genres || []).map((g) => g.name),
        networks: (detail.networks || []).map((n) => ({ id: n.id, name: n.name })),
        homepage: detail.homepage || '',
        seasons: detail.number_of_seasons || 0,
        episodes,
      });
    } catch (e) {
      log(`show ${c.id} failed:`, e.message);
    }
    if ((i + 1) % 20 === 0) log(`shows ${i + 1}/${candidates.length} → kept ${shows.length}`);
  }
  return shows;
}

/* ------------------------------------------------------------------ */
/* Movies                                                              */
/* ------------------------------------------------------------------ */
async function collectMovies() {
  const seen = new Map();
  const add = (list = []) => {
    for (const m of list) {
      if (!m || !m.id) continue;
      if (inWindow(m.release_date) && !seen.has(m.id)) seen.set(m.id, m);
    }
  };

  for (let page = 1; page <= 8; page++) {
    try {
      const r = await api('/discover/movie', {
        region: 'US',
        with_release_type: '2|3',
        'release_date.gte': START,
        'release_date.lte': END,
        sort_by: 'popularity.desc',
        page,
        'vote_count.gte': 0,
      });
      add(r.results);
      if (page >= (r.total_pages || 1)) break;
    } catch (e) { log('discover/movie p' + page, e.message); }
  }
  for (const list of ['/movie/now_playing', '/movie/upcoming']) {
    for (let page = 1; page <= 2; page++) {
      try { add((await api(list, { region: 'US', page })).results); }
      catch (e) { log(list, e.message); }
    }
  }

  return [...seen.values()]
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
    .slice(0, 120)
    .map((m) => ({
      id: m.id,
      title: m.title,
      original_title: m.original_title,
      overview: m.overview || '',
      poster: img(m.poster_path, 'w342'),
      backdrop: img(m.backdrop_path, 'w780'),
      release_date: m.release_date,
      vote: m.vote_average || null,
      popularity: m.popularity || 0,
      genre_ids: m.genre_ids || [],
      adult: !!m.adult,
    }));
}

/* ------------------------------------------------------------------ */
/* demo data                                                           */
/* ------------------------------------------------------------------ */
function demoRaw() {
  const day = (n) => addDays(TODAY, n);
  const mk = (id, name, net, episodes, extra = {}) => ({
    id, name, original_name: name, overview: extra.overview || '演示数据条目，用于检查页面布局，不代表真实播出安排。',
    poster: '', backdrop: '', first_air_date: '2023-01-01', status: 'Returning Series',
    vote: extra.vote ?? 7.6, popularity: extra.popularity ?? 100,
    genres: extra.genres || ['剧情'], networks: net ? [{ id: 1, name: net }] : [],
    homepage: '', seasons: 3,
    episodes: episodes.map(([s, e, d, n]) => ({ season: s, episode: e, name: n, air_date: d, overview: '', still: '', runtime: 45, vote: null })),
  });
  const shows = [
    mk(1001, 'The Night Shift', 'NBC', [[9, 8, day(-1), 'Signal Lost'], [9, 9, day(2), 'Cold Open'], [9, 10, day(9), 'Blue Hour']], { genres: ['剧情', '悬疑'] }),
    mk(1002, 'Harbor Lights', 'HBO', [[2, 1, day(0), 'Pilot'], [2, 2, day(7), 'The Ferry']], { genres: ['剧情'] }),
    mk(1003, 'Kitchen Wars', 'Fox', [[5, 12, day(1), 'Finale Night'], [5, 13, day(8), 'Reunion']], { genres: ['真人秀'] }),
    mk(1004, 'Neon Precinct', 'CBS', [[1, 3, day(3), 'Third Rail'], [1, 4, day(10), 'Underpass']], { genres: ['犯罪'] }),
    mk(1005, 'Deep Field', 'Netflix', [[3, 1, day(5), 'Launch Window']], { genres: ['科幻'] }),
    mk(1006, 'The Long Table', 'Hulu', [[4, 6, day(6), 'Harvest']], { genres: ['剧情'] }),
    mk(1007, 'Static', 'AMC', [[2, 4, day(11), 'White Noise']], { genres: ['惊悚'] }),
    mk(1008, 'After School', 'Disney+', [[1, 8, day(12), 'Last Bell']], { genres: ['家庭'] }),
  ];
  const movies = [
    { id: 2001, title: 'Silent Harbor', original_title: 'Silent Harbor', overview: '演示数据。', poster: '', backdrop: '', release_date: day(0), vote: 7.2, popularity: 500, genre_ids: [18] },
    { id: 2002, title: 'Orbit 9', original_title: 'Orbit 9', overview: '演示数据。', poster: '', backdrop: '', release_date: day(4), vote: 6.8, popularity: 420, genre_ids: [878] },
    { id: 2003, title: 'Paper Tigers', original_title: 'Paper Tigers', overview: '演示数据。', poster: '', backdrop: '', release_date: day(6), vote: 7.9, popularity: 380, genre_ids: [35] },
    { id: 2004, title: 'The Quiet Year', original_title: 'The Quiet Year', overview: '演示数据。', poster: '', backdrop: '', release_date: day(13), vote: 8.1, popularity: 300, genre_ids: [18] },
  ];
  return {
    generated_at: new Date().toISOString(),
    demo: true,
    window: { start: START, end: END, today: TODAY },
    shows, movies,
    genres: { tv: {}, movie: {} },
  };
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */
async function main() {
  log(`window ${START} .. ${END} (today ${TODAY})${DEMO ? ' [DEMO]' : ''}`);

  let raw;
  if (DEMO) {
    raw = demoRaw();
  } else {
    const genreTV = await api('/genre/tv/list');
    const genreTVen = await api('/genre/tv/list', { language: 'en-US' });
    GENRE_BLOCK_IDS = new Set((genreTVen.genres || []).filter((g) => GENRE_BLOCK.has(g.name.toLowerCase())).map((g) => g.id));
    log('genre block ids: ' + [...GENRE_BLOCK_IDS].join(','));
    const genreMovie = await api('/genre/movie/list');
    const genres = {
      tv: Object.fromEntries((genreTV.genres || []).map((g) => [g.id, g.name])),
      movie: Object.fromEntries((genreMovie.genres || []).map((g) => [g.id, g.name])),
    };
    const candidates = await tvCandidates();
    log(`tv candidates: ${candidates.length}`);
    const shows = await collectShows(candidates);
    log(`shows kept: ${shows.length}`);
    const movies = await collectMovies();
    log(`movies kept: ${movies.length}`);
    raw = {
      generated_at: new Date().toISOString(),
      demo: false,
      window: { start: START, end: END, today: TODAY },
      genres,
      shows,
      movies,
    };
  }

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/raw.json', JSON.stringify(raw));

  const epCount = raw.shows.reduce((n, s) => n + s.episodes.length, 0);
  log(`done → data/raw.json  shows=${raw.shows.length} episodes=${epCount} movies=${raw.movies.length}`);
  if (!DEMO) log(`api requests=${stats.requests} cache=${stats.cacheHits} retries=${stats.retries} failures=${stats.failures}`);

  // give the workflow a machine-readable status (used by the freshness badge)
  fs.writeFileSync('data/status.json', JSON.stringify({
    generated_at: raw.generated_at,
    demo: raw.demo,
    window: raw.window,
    shows: raw.shows.length,
    episodes: epCount,
    movies: raw.movies.length,
    api: DEMO ? null : { requests: stats.requests, cacheHits: stats.cacheHits, failures: stats.failures },
  }, null, 2));
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
