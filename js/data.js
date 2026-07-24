// ═══════════════════════════════════════════
// Data — client-side state (graph data now lives on the server)
// ═══════════════════════════════════════════
let currentRootId = null;
let frozen = false;

// Build a /shuffle URL carrying the current root as a ?node= query param,
// merging (not clobbering) any existing query params (filters, ?noplay, etc.).
// Query param — not #hash — so crawlers/the Worker can read it server-side for
// per-track link previews.
function buildShuffleUrl(rootId) {
  const params = new URLSearchParams(location.search);
  if (rootId) params.set('node', rootId); else params.delete('node');
  const qs = params.toString();
  return '/shuffle' + (qs ? '?' + qs : '');
}

// Build a /dig URL, preserving filters but dropping any stale ?node=.
function buildDigUrl() {
  const params = new URLSearchParams(location.search);
  params.delete('node');
  const qs = params.toString();
  return '/dig' + (qs ? '?' + qs : '');
}

// Read the current node id from the URL: ?node= wins, #hash is the legacy fallback.
function readNodeFromUrl() {
  return new URLSearchParams(location.search).get('node') || decodeURIComponent(location.hash.slice(1));
}
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
// SoundCloud logo — shown as a small badge on the playing card (desktop only)
const SOUNDCLOUD_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.999 14.165c-.052 1.796-1.612 3.169-3.4 3.169h-8.18a.68.68 0 0 1-.675-.683V7.862a.747.747 0 0 1 .452-.724s.75-.513 2.333-.513a5.364 5.364 0 0 1 2.763.755 5.433 5.433 0 0 1 2.57 3.54c.282-.08.574-.121.868-.12.884 0 1.73.358 2.347.992s.948 1.49.922 2.373ZM10.721 8.421c.247 2.98.427 5.697 0 8.672a.264.264 0 0 1-.53 0c-.395-2.946-.22-5.718 0-8.672a.264.264 0 0 1 .53 0ZM9.072 9.448c.285 2.659.37 4.986-.006 7.655a.277.277 0 0 1-.55 0c-.331-2.63-.256-5.02 0-7.655a.277.277 0 0 1 .556 0Zm-1.663-.257c.27 2.726.39 5.171 0 7.904a.266.266 0 0 1-.532 0c-.38-2.69-.257-5.21 0-7.904a.266.266 0 0 1 .532 0Zm-1.647.77a26.108 26.108 0 0 1-.008 7.147.272.272 0 0 1-.542 0 27.955 27.955 0 0 1 0-7.147.275.275 0 0 1 .55 0Zm-1.67 1.769c.421 1.865.228 3.5-.029 5.388a.257.257 0 0 1-.514 0c-.21-1.858-.398-3.549 0-5.389a.272.272 0 0 1 .543 0Zm-1.655-.273c.388 1.897.26 3.508-.01 5.412-.026.28-.514.283-.54 0-.244-1.878-.347-3.54-.01-5.412a.283.283 0 0 1 .56 0Zm-1.668.911c.4 1.268.257 2.292-.026 3.572a.257.257 0 0 1-.514 0c-.241-1.262-.354-2.312-.023-3.572a.283.283 0 0 1 .563 0Z"/></svg>';
// Source-toggle icons: a single music note (track) and a vinyl disc (DJ mix)
const TRACK_ICON = '<svg class="src-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3" fill="currentColor" stroke="none"/><circle cx="18" cy="16" r="3" fill="currentColor" stroke="none"/></svg>';
// Vinyl record — mirrors the back2back favicon (disc, label ring, hole, glint)
const MIX_ICON = '<svg class="src-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.3"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><line x1="18.4" y1="5.6" x2="15.2" y2="8.8"/></svg>';
// Deny/block icon shown in place of the track or mix icon when that source isn't available
const BLOCKED_ICON = '<svg class="src-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="5.5" y1="18.5" x2="18.5" y2="5.5"/></svg>';

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
const MIX_UNAVAILABLE_TOOLTIP = "Set not available via soundcloud player, use dot menu for mixcloud set";

// Tooltip shown when "from track" is disabled — names the DJ set the song lives in.
function trackUnavailableTooltip(node) {
  const djNames = (node.djs || []).map(d => d.name).filter(Boolean);
  const djLabel = djNames.length ? djNames.join(' & ') : (node.setDj || '');
  return djLabel
    ? `This song is available only mixed through ${djLabel}’s set`
    : 'This song is available only mixed through a DJ set';
}

// The mixed view is only offered for SoundCloud sets — Mixcloud-only sets are
// intentionally not playable, even when the track has its own SC audio.
function mixPlayable(node) {
  return !!(node && node.setUrl) && node.setSource !== 'mixcloud';
}

function getDefaultAudioSource(node) {
  if (node && node.scTrackUrl) return 'track';
  if (mixPlayable(node)) return 'mix';
  return null;
}

// Resolve the effective source for a node, falling back if the stored choice
// points at a source the node doesn't actually have.
function getSelectedAudioSource(nodeId) {
  const node = nodeMap[nodeId];
  if (!node) return null;
  const sel = selectedAudioSources[nodeId];
  if (sel === 'track' && node.scTrackUrl) return 'track';
  if (sel === 'mix' && mixPlayable(node)) return 'mix';
  const def = getDefaultAudioSource(node);
  if (def) selectedAudioSources[nodeId] = def;
  return def;
}

function setSelectedAudioSource(nodeId, source) {
  const node = nodeMap[nodeId];
  if (!node) return null;
  if (source === 'track' && !node.scTrackUrl) return getSelectedAudioSource(nodeId);
  if (source === 'mix' && !mixPlayable(node)) return getSelectedAudioSource(nodeId);
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
  const mixAvailable = mixPlayable(node);
  const opt = (src, label, available) => {
    const active = selected === src;
    const tip = available ? '' : (src === 'track' ? trackTip : MIX_UNAVAILABLE_TOOLTIP);
    const icon = !available ? BLOCKED_ICON : (src === 'track' ? TRACK_ICON : MIX_ICON);
    return `<button type="button" class="src-opt${active ? ' active' : ''}${available ? '' : ' disabled'}"`
      + ` data-source="${src}" aria-pressed="${active ? 'true' : 'false'}" aria-disabled="${available ? 'false' : 'true'}"`
      + (tip ? ` data-tip="${tip}"` : '') + `>${icon}<span class="src-label">${label}</span></button>`;
  };
  const disabledTip = !node.scTrackUrl ? trackTip : (!mixAvailable ? MIX_UNAVAILABLE_TOOLTIP : '');
  return `<div class="source-toggle" data-node-id="${node.id}" data-selected="${selected}"${disabledTip ? ` data-disabled-tip="${disabledTip}"` : ''} role="group" aria-label="Play from track or mix">`
    + opt('track', 'track', !!node.scTrackUrl)
    + opt('mix', 'mixed', mixAvailable)
    + `</div>`;
}

// Wire clicks on a freshly-rendered toggle. Switching source while the track is
// live restarts playback from the newly chosen source (mixes at their timestamp).
function initSourceToggle(card, node) {
  const toggle = card.querySelector('.source-toggle');
  if (!toggle) return;
  // A single physical tap can fire two click events on iOS (same cause as the
  // mobile filter popovers). Against a naive classList.toggle() that nets out
  // to a no-op — open-then-closed on the first tap, requiring a second tap to
  // actually see it. Guard so only the first click of a same-gesture pair flips
  // the tooltip; a genuine follow-up tap well after this window still works.
  let lastTipToggleAt = 0;
  toggle.querySelectorAll('.src-opt').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.getAttribute('aria-disabled') === 'true') {
        const now = Date.now();
        if (now - lastTipToggleAt < 350) return;
        lastTipToggleAt = now;
        // Toggle the "unavailable" tooltip so a second tap dismisses it (touch
        // devices have no hover to fall back on).
        toggle.classList.toggle('tip-open');
        return;
      }
      toggle.classList.remove('tip-open');
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
  // Desktop hover tooltip for a disabled (unavailable) option. Driven via the
  // .tip-open class rather than CSS :has(:hover): the toggle slides in/out on a
  // transform, so a pure :hover selector gets "stuck" when the bar slides back
  // under a stationary cursor. Force-clear on card mouseleave so it always
  // resets when the pointer leaves the card.
  toggle.querySelectorAll('.src-opt.disabled').forEach(btn => {
    btn.addEventListener('mouseenter', () => toggle.classList.add('tip-open'));
    btn.addEventListener('mouseleave', () => toggle.classList.remove('tip-open'));
  });
  card.addEventListener('mouseleave', () => toggle.classList.remove('tip-open'));
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
