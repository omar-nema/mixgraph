// ═══════════════════════════════════════════
// Data — loaded from combined_graph.json
// ═══════════════════════════════════════════
let graphNodes = {};    // full graph: { "artist:::title": { title, artist, edges: [...] } }
let audioCache = {};    // { "artist:::title": { source, scTrackUrl, setUrl, ... } }
let candidates = [];    // node IDs with 3+ edges
let currentRootId = null;
let frozen = false;
let maxR1 = 4;
let r2PerR1 = 1;
let searchFilters = [];  // [{ display, trackIds }] — artist filters (from search bar)
let djSearchFilters = []; // [{ display, trackIds }] — DJ filters (from search bar)
let clusterArtistFilters = []; // [{ display, trackIds }] — artist filters (from cluster pills)
let clusterDjFilters = [];     // [{ display, trackIds }] — DJ filters (from cluster pills)
let genreFilters = [];   // ['Soul', 'Jazz', ...]
let shuffleHistory = new Set();  // track seen root IDs to avoid repeats
let djIndex = {};        // lowercase DJ name → { display, trackIds: Set }
let episodeIndex = {};   // episode_url → Set<trackId>
let artistIndex = {};    // lowercase artist → { display, trackIds: [] }
let artistListAlpha = [];
let djListAlpha = [];
let djNameMap = {};
let nodes = [];
let edges = [];
let nodeMap = {};
let currentCluster = null;
let onClusterShown = null;  // hook called after showCluster renders

const cardWidths = { 'root': 280, '1': 180, '2': 155 };
// Measured heights per node id, populated after first render pass
let measuredHeights = {};
function cardDimFor(node) {
  return { w: cardWidths[node.rank], h: measuredHeights[node.id] || fallbackH(node.rank) };
}
function fallbackH(rank) { return rank === 'root' ? 310 : rank === '1' ? 260 : 240; }

// ═══════════════════════════════════════════
// SVG icons
// ═══════════════════════════════════════════
const PLAY_SVG = '<svg viewBox="0 0 24 24"><polygon points="6,3 20,12 6,21"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg>';
const EQ_BARS_HTML = '<span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span>';

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

function generateGradient(title, artist) {
  const h = simpleHash((title || '') + (artist || ''));
  const palette = gradientPalettes[h % gradientPalettes.length];
  // Layered radial gradients at pseudo-random positions to mimic mesh gradient
  const positions = [
    [h % 40 + 10, h % 30 + 10],
    [70 + (h >> 4) % 20, h % 25 + 5],
    [(h >> 8) % 30 + 10, 70 + (h >> 2) % 20],
    [60 + (h >> 6) % 30, 60 + (h >> 3) % 30],
    [40 + (h >> 5) % 20, 40 + (h >> 7) % 20],
  ];
  const layers = palette.map((c, i) => {
    const [x, y] = positions[i % positions.length];
    const size = 50 + ((h >> (i * 3)) % 40);
    return `radial-gradient(circle at ${x}% ${y}%, ${c} 0%, transparent ${size}%)`;
  });
  // Base color from the palette's darkest-looking color
  const base = palette[1];
  return `${layers.join(', ')}, ${base}`;
}
