// ═══════════════════════════════════════════
// Data — client-side state (graph data now lives on the server)
// ═══════════════════════════════════════════
let currentRootId = null;
let frozen = false;
let maxR1 = 4;
let r2PerR1 = 1;
let searchFilters = [];  // [{ display }] — artist filters (from search bar)
let djSearchFilters = []; // [{ display }] — DJ filters (from search bar)
let clusterArtistFilters = []; // [{ display }] — artist filters (from cluster pills)
let clusterDjFilters = [];     // [{ display }] — DJ filters (from cluster pills)
let genreFilters = [];   // ['Soul', 'Jazz', ...] — DERIVED from genreSearchFilters + manualGenreToggles by filters.js
let genreSearchFilters = []; // [{display, names}] — genre search chips (parent chips carry expanded child names)
let trackSearchFilter = null; // lowercase title string — silent song search filter (no chip)
let manualGenreToggles = new Set(); // names toggled directly via the genre pills (not via chips)
let filtersDirty = false; // true when filters changed inside an open popover
let shuffleHistory = new Set();  // track seen root IDs to avoid repeats
let lastPoolSize = 0;    // pool size from last shuffle response
let nodes = [];
let edges = [];
let nodeMap = {};
let currentCluster = null;
let onClusterShown = null;  // hook called after showCluster renders
let selectedAudioSources = {};  // nodeId -> 'track' | 'mix' (user's per-card source choice)

const cardWidths = { 'root': 252, '1': 169, '2': 169 };
// Measured heights per node id, populated after first render pass
let measuredHeights = {};
function cardDimFor(node) {
  return { w: cardWidths[node.rank], h: measuredHeights[node.id] || fallbackH(node.rank) };
}
function fallbackH(rank) { return rank === 'root' ? 279 : 230; }

// ═══════════════════════════════════════════
// SVG icons
// ═══════════════════════════════════════════
const PLAY_SVG = '<svg viewBox="0 0 24 24"><polygon points="6,3 20,12 6,21"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg>';
const EQ_BARS_HTML = '<span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span>';
// Source-toggle icons: a single music note (track) and a vinyl disc (DJ mix)
const TRACK_ICON = '<svg class="src-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3" fill="currentColor" stroke="none"/><circle cx="18" cy="16" r="3" fill="currentColor" stroke="none"/></svg>';
// Vinyl record — mirrors the back2back favicon (disc, label ring, hole, glint)
const MIX_ICON = '<svg class="src-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.3"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><line x1="18.4" y1="5.6" x2="15.2" y2="8.8"/></svg>';

// ═══════════════════════════════════════════
// Glow palettes
// ═══════════════════════════════════════════
const glowPalettes = [
  { a: '#e8a87c', b: '#d4726a', c: '#f4c694', dark: '#b8584a' },
  { a: '#1a1a3e', b: '#c7883a', c: '#4a3060', dark: '#1a1a3e' },
  { a: '#2d4a3e', b: '#c9a96e', c: '#5c7a6a', dark: '#2d4a3e' },
  { a: '#c4868b', b: '#e8c4c8', c: '#8a6070', dark: '#8a6070' },
  { a: '#9a8cbe', b: '#d4cce8', c: '#7a6a9a', dark: '#6a5a8a' },
  { a: '#e6c4a8', b: '#d4928a', c: '#f0dcc8', dark: '#c07a6a' },
  { a: '#5a8a8c', b: '#b8c4c0', c: '#3a6068', dark: '#3a6068' },
  { a: '#b8864e', b: '#d4b896', c: '#8a6030', dark: '#7a5020' },
  { a: '#6a7a9a', b: '#c4a0a8', c: '#4a5a7a', dark: '#4a5a7a' },
  { a: '#d4a060', b: '#e8d0a0', c: '#c07848', dark: '#a06030' },
  { a: '#8a9aaa', b: '#c0ccb8', c: '#6a7a88', dark: '#5a6a78' },
  { a: '#c4a480', b: '#a07060', c: '#dcc4a0', dark: '#8a5848' },
];
let lastPaletteIndex = -1;

function randomGlow() {
  let idx;
  do { idx = Math.floor(Math.random() * glowPalettes.length); } while (idx === lastPaletteIndex);
  lastPaletteIndex = idx;
  return glowPalettes[idx];
}

function applyGlow(card) {
  const g = randomGlow();
  card.style.setProperty('--glow-a', g.a);
  card.style.setProperty('--glow-b', g.b);
  card.style.setProperty('--glow-dark', g.dark);
}

function clearGlow(card) {
  card.style.removeProperty('--glow-a');
  card.style.removeProperty('--glow-b');
  card.style.removeProperty('--glow-dark');
}

// ═══════════════════════════════════════════
// "from track" / "from mix" source selector
// ═══════════════════════════════════════════
// Every enriched node can have an isolated track (scTrackUrl) and/or the DJ
// set it appeared in (setUrl at setOffsetSec). This toggle lets the user pick
// which one plays. Default is the isolated track when both exist.
const MIX_UNAVAILABLE_TOOLTIP = "This song is only available as its own track";

// Tooltip shown when "from track" is disabled — names the DJ set the song lives in.
function trackUnavailableTooltip(node) {
  const djNames = (node.djs || []).map(d => d.name).filter(Boolean);
  const djLabel = djNames.length ? djNames.join(' & ') : (node.setDj || '');
  return djLabel
    ? `This song is available only mixed through ${djLabel}’s set`
    : 'This song is available only mixed through a DJ set';
}

function getDefaultAudioSource(node) {
  if (node && node.scTrackUrl) return 'track';
  if (node && node.setUrl) return 'mix';
  return null;
}

// Resolve the effective source for a node, falling back if the stored choice
// points at a source the node doesn't actually have.
function getSelectedAudioSource(nodeId) {
  const node = nodeMap[nodeId];
  if (!node) return null;
  const sel = selectedAudioSources[nodeId];
  if (sel === 'track' && node.scTrackUrl) return 'track';
  if (sel === 'mix' && node.setUrl) return 'mix';
  const def = getDefaultAudioSource(node);
  if (def) selectedAudioSources[nodeId] = def;
  return def;
}

function setSelectedAudioSource(nodeId, source) {
  const node = nodeMap[nodeId];
  if (!node) return null;
  if (source === 'track' && !node.scTrackUrl) return getSelectedAudioSource(nodeId);
  if (source === 'mix' && !node.setUrl) return getSelectedAudioSource(nodeId);
  selectedAudioSources[nodeId] = source;
  syncSourceToggleUI(nodeId);
  return source;
}

// Keep every rendered toggle for this node in sync with the stored choice.
function syncSourceToggleUI(nodeId) {
  const selected = getSelectedAudioSource(nodeId);
  document.querySelectorAll('.source-toggle').forEach(toggle => {
    if (toggle.dataset.nodeId !== String(nodeId)) return;
    toggle.dataset.selected = selected || '';
    toggle.querySelectorAll('.src-opt').forEach(btn => {
      const active = btn.dataset.source === selected;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  });
}

function renderSourceToggle(node) {
  if (!node || !(node.scTrackUrl || node.setUrl)) return '';
  const selected = selectedAudioSources[node.id] || getDefaultAudioSource(node);
  selectedAudioSources[node.id] = selected;
  const trackTip = trackUnavailableTooltip(node);
  const opt = (src, label, available) => {
    const active = selected === src;
    const tip = available ? '' : (src === 'track' ? trackTip : MIX_UNAVAILABLE_TOOLTIP);
    const icon = src === 'track' ? TRACK_ICON : MIX_ICON;
    return `<button type="button" class="src-opt${active ? ' active' : ''}${available ? '' : ' disabled'}"`
      + ` data-source="${src}" aria-pressed="${active ? 'true' : 'false'}" aria-disabled="${available ? 'false' : 'true'}"`
      + (tip ? ` data-tip="${tip}"` : '') + `>${icon}<span class="src-label">${label}</span></button>`;
  };
  const disabledTip = !node.scTrackUrl ? trackTip : (!node.setUrl ? MIX_UNAVAILABLE_TOOLTIP : '');
  return `<div class="source-toggle" data-node-id="${node.id}" data-selected="${selected}"${disabledTip ? ` data-disabled-tip="${disabledTip}"` : ''} role="group" aria-label="Play from track or mix">`
    + opt('track', 'track', !!node.scTrackUrl)
    + opt('mix', 'mix', !!node.setUrl)
    + `</div>`;
}

// Wire clicks on a freshly-rendered toggle. Switching source while the track is
// live restarts playback from the newly chosen source (mixes at their timestamp).
function initSourceToggle(card, node) {
  const toggle = card.querySelector('.source-toggle');
  if (!toggle) return;
  toggle.querySelectorAll('.src-opt').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.getAttribute('aria-disabled') === 'true') return;
      const prev = getSelectedAudioSource(node.id);
      const next = setSelectedAudioSource(node.id, btn.dataset.source);
      if (!next || next === prev) return;
      if (isMobileView()) {
        if (card.classList.contains('selected')) selectMobileTrack(node.id);
      } else if (currentlyPlayingId === node.id) {
        stopCurrentPlayback();
        trackEvent('play');
        playSelectedAudioSource(node.id);
      }
    });
  });
}

// ═══════════════════════════════════════════
// Gradient artwork for tracks without covers
// ═══════════════════════════════════════════
const gradientPalettes = [
  ['#EB4679','#051681','#EE7F7D','#265BC9','#C25EA5','#7961D3'], // photogradient original
  ['#FF6B6B','#4ECDC4','#2C3E50','#F39C12','#8E44AD'],          // sunset reef
  ['#E44D90','#2B86C5','#784BA0','#F5AF19','#C850C0'],          // neon dusk
  ['#0F2027','#2C5364','#203A43','#E8775F','#F2A65A'],          // deep ocean ember
  ['#DA4453','#89216B','#2980B9','#6DD5FA','#FF512F'],          // berry voltage
  ['#A770EF','#CF8BF3','#FDB99B','#5B86E5','#36D1DC'],         // lavender dream
  ['#654EA3','#EAAFC8','#F093FB','#F5576C','#4FACFE'],         // soft plasma
  ['#1A2980','#26D0CE','#4776E6','#8E54E9','#00C9FF'],         // arctic aurora
  ['#EC6F66','#F3A183','#2C3E50','#3498DB','#9B59B6'],         // warm twilight
  ['#C33764','#1D2671','#FDC830','#F37335','#6441A5'],         // golden violet
  ['#E65C00','#F9D423','#2B5876','#4E4376','#C94B4B'],         // amber cosmos
  ['#B24592','#F15F79','#00B4DB','#0083B0','#8360C3'],         // fuchsia tide
];

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const GRADIENT_COUNT = 40;
function gradientArtUrl(title, artist) {
  const h = simpleHash(((title || '') + (artist || '')).toLowerCase());
  return `/gradients/${h % GRADIENT_COUNT}.jpg`;
}
function generateGradient(title, artist) {
  return `url(${gradientArtUrl(title, artist)}) center/cover`;
}
