// ═══════════════════════════════════════════
// API client — single source of truth for base URL
// ═══════════════════════════════════════════

function resolveApiBase() {
  // 1. ?api=<url> query param — for testing on real devices via local IP
  const param = new URLSearchParams(window.location.search).get('api');
  if (param) return param;
  // 2. Local dev — uncomment to use local server instead of Cloudflare
  // if (['localhost', '127.0.0.1'].includes(window.location.hostname) || /^192\.168\./.test(window.location.hostname)) {
  //   return `http://${window.location.hostname}:3001`;
  // }
  // 3. Default → production Worker URL
  return 'https://b2b-api.omarwnema.workers.dev';
}

const API_BASE = resolveApiBase();

async function apiFetch(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `API ${path} failed: ${resp.status}`);
  }
  return resp.json();
}

function apiShuffle(filters = {}) {
  const params = {};
  if (filters.source) params.source = filters.source;
  if (filters.genres && filters.genres.length) params.genres = filters.genres.join(',');
  if (filters.artists && filters.artists.length) params.artists = filters.artists.join(',');
  if (filters.djs && filters.djs.length) params.djs = filters.djs.join(',');
  if (filters.title) params.title = filters.title;
  if (filters.exclude && filters.exclude.length) params.exclude = filters.exclude.join(',');
  if (filters.r1) params.r1 = filters.r1;
  if (filters.r2) params.r2 = filters.r2;
  return apiFetch('/api/shuffle', params);
}

function apiLoadCluster(id, opts = {}) {
  const params = {};
  if (opts.r1) params.r1 = opts.r1;
  if (opts.r2) params.r2 = opts.r2;
  if (opts.expand !== undefined) params.expand = opts.expand;
  return apiFetch('/api/cluster/' + encodeURIComponent(id), params);
}

function apiSearchArtists(q, limit = 20) {
  return apiFetch('/api/search/artists', { q, limit });
}

function apiSearchDjs(q, limit = 20) {
  return apiFetch('/api/search/djs', { q, limit });
}

function apiSearchTracks(q, limit = 20) {
  return apiFetch('/api/search/tracks', { q, limit });
}

function apiGetGenres() {
  return apiFetch('/api/genres');
}

function apiGetCratesIndex() {
  return apiFetch('/api/crates-index', { v: 3 });
}

// ── Telemetry ──

function getAnonId() {
  let id = localStorage.getItem('_aid');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('_aid', id); }
  return id;
}

function trackEvent(event) {
  navigator.sendBeacon(API_BASE + '/api/event', JSON.stringify({ event, uid: getAnonId() }));
}

function apiGetCratesPage(opts = {}) {
  const params = { seed: opts.seed, page: opts.page, count: opts.count };
  if (opts.genres && opts.genres.length) params.genres = opts.genres.join(',');
  if (opts.artists && opts.artists.length) params.artists = opts.artists.join(',');
  if (opts.djs && opts.djs.length) params.djs = opts.djs.join(',');
  return apiFetch('/api/crates', params);
}
