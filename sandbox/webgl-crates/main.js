'use strict';

// ══════════════════════════════════════════════════════
// Config
// ══════════════════════════════════════════════════════

const API_BASE        = 'https://b2b-api.omarwnema.workers.dev';
const STEP            = 3;     // px offset between stacked cards
const GAP             = 25;    // px gap between crate stacks
const MAX_CARDS       = 8;     // max cards per stack
const CLUSTERS_PER_PAGE = 20;  // clusters per viewport-sized page
const MIN_SCALE       = 0.12;
const MAX_SCALE       = 3.0;
const INITIAL_SCALE   = 0.85;
const DRAG_THRESHOLD  = 5;     // px before a mousedown counts as drag

// ── Colors ──────────────────────────────────────────
// Hardcoded from desktop.css tokens
const THEME = {
  light: { bg: 0xf5f5f7, bgHex: '#f5f5f7' },
  dark:  { bg: 0x1e2228, bgHex: '#1e2228' },
};

// Gradient palette colors for placeholder cards (from data.js)
const GRAD_PALETTES = [
  [0xEB4679, 0x051681, 0xEE7F7D, 0x265BC9, 0xC25EA5, 0x7961D3],
  [0xFF6B6B, 0x4ECDC4, 0x2C3E50, 0xF39C12, 0x8E44AD],
  [0xE44D90, 0x2B86C5, 0x784BA0, 0xF5AF19, 0xC850C0],
  [0x0F2027, 0x2C5364, 0x203A43, 0xE8775F, 0xF2A65A],
  [0xDA4453, 0x89216B, 0x2980B9, 0x6DD5FA, 0xFF512F],
  [0xA770EF, 0xCF8BF3, 0xFDB99B, 0x5B86E5, 0x36D1DC],
  [0x654EA3, 0xEAAFC8, 0xF093FB, 0xF5576C, 0x4FACFE],
  [0x1A2980, 0x26D0CE, 0x4776E6, 0x8E54E9, 0x00C9FF],
  [0xEC6F66, 0xF3A183, 0x2C3E50, 0x3498DB, 0x9B59B6],
  [0xC33764, 0x1D2671, 0xFDC830, 0xF37335, 0x6441A5],
  [0xE65C00, 0xF9D423, 0x2B5876, 0x4E4376, 0xC94B4B],
  [0xB24592, 0xF15F79, 0x00B4DB, 0x0083B0, 0x8360C3],
];

// ══════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function getCardColor(seedKey, cardIdx) {
  const h = simpleHash(seedKey);
  const palette = GRAD_PALETTES[h % GRAD_PALETTES.length];
  // Darken every-other card slightly so the stack is visually distinct
  return palette[(h + cardIdx * 2) % palette.length];
}

function capWords(s) {
  return (s || '').replace(/\b\w/g, c => c.toUpperCase());
}

// ══════════════════════════════════════════════════════
// Treemap layout — ported directly from app.js
// ══════════════════════════════════════════════════════

function cratesTreemap(items, x, y, w, h) {
  if (items.length === 0) return;
  if (items.length === 1) { items[0].rect = { x, y, w, h }; return; }

  const total = items.reduce((s, it) => s + it.weight, 0);
  const sorted = [...items].sort((a, b) => b.weight - a.weight);

  let bestDiff = Infinity, splitIdx = 1, runSum = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    runSum += sorted[i].weight;
    const diff = Math.abs(runSum - (total - runSum));
    if (diff < bestDiff) { bestDiff = diff; splitIdx = i + 1; }
  }

  const left  = sorted.slice(0, splitIdx);
  const right = sorted.slice(splitIdx);
  const ratio = left.reduce((s, it) => s + it.weight, 0) / total;
  const splitH = w >= h; // desktop: split along longest axis

  if (splitH) {
    const sw = w * ratio;
    cratesTreemap(left,  x,      y, sw,     h);
    cratesTreemap(right, x + sw, y, w - sw, h);
  } else {
    const sh = h * ratio;
    cratesTreemap(left,  x, y,      w, sh);
    cratesTreemap(right, x, y + sh, w, h - sh);
  }
}

// ══════════════════════════════════════════════════════
// TextureCache — load SoundCloud thumbnails, deduplicated
// ══════════════════════════════════════════════════════

class TextureCache {
  constructor() {
    this._cache = new Map(); // url -> Texture | Promise<Texture>
    this._refs  = new Map(); // url -> reference count
  }

  load(url) {
    this._refs.set(url, (this._refs.get(url) || 0) + 1);
    if (this._cache.has(url)) {
      const v = this._cache.get(url);
      return v instanceof Promise ? v : Promise.resolve(v);
    }
    const p = PIXI.Texture.fromURL(url)
      .then(tex => { this._cache.set(url, tex); return tex; })
      .catch(() => { this._cache.delete(url); this._refs.delete(url); return null; });
    this._cache.set(url, p);
    return p;
  }

  // Decrement ref count; destroy + evict GPU texture when no more references
  release(url) {
    const count = (this._refs.get(url) || 1) - 1;
    if (count <= 0) {
      const tex = this._cache.get(url);
      if (tex instanceof PIXI.Texture) tex.destroy(true);
      this._cache.delete(url);
      this._refs.delete(url);
    } else {
      this._refs.set(url, count);
    }
  }
}

// ══════════════════════════════════════════════════════
// CrateStack — one stack of layered cards in PixiJS
// ══════════════════════════════════════════════════════

class CrateStack {
  constructor(item, textureCache) {
    this.item = item;
    this.textureCache = textureCache;
    this.artLoaded = false;

    const r = item.rect;
    const x = r.x + GAP / 2;
    const y = r.y + GAP / 2;
    const w = r.w - GAP;
    const h = r.h - GAP;

    if (w < 20 || h < 20) { this.valid = false; return; }
    this.valid = true;

    this.w = w;
    this.numCards = Math.min(Math.max(item.artworks.length, 1), MAX_CARDS);
    const pileOffset = (this.numCards - 1) * STEP;
    this.cardW = w - pileOffset;
    this.cardH = h - pileOffset;

    // Root container placed at stack position within the page
    this.container = new PIXI.Container();
    this.container.x = x;
    this.container.y = y;
    this.container.sortableChildren = true;
    this.container.eventMode = 'static';
    this.container.hitArea = new PIXI.Rectangle(0, 0, w, h);
    this.container.cursor = 'pointer';

    this._cardContainers = []; // PIXI.Container per card
    this._bgs = [];            // PIXI.Graphics placeholder bg per card
    this._sprites = [];        // PIXI.Sprite artwork per card
    this._infoOverlay = null;  // lazy — created on first hover
    this._loadedUrls  = [];    // URLs currently loaded (for release on unload)

    this._buildCards();
    this._buildStackLabel();
    this._attachEvents();
  }

  // ── Build card display objects ──

  _buildCards() {
    for (let i = 0; i < this.numCards; i++) {
      const cc = new PIXI.Container();
      cc.x = i * STEP;
      cc.y = i * STEP;
      cc.zIndex = i;

      // Placeholder colored rectangle
      const color = getCardColor(this.item.seedKey, i);
      const bg = new PIXI.Graphics();
      bg.beginFill(color);
      bg.drawRect(0, 0, this.cardW, this.cardH);
      bg.endFill();
      cc.addChild(bg);

      // Artwork sprite — hidden until texture loaded
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sprite.visible = false;
      cc.addChild(sprite);

      // Mask so cover-scaled artwork doesn't bleed outside the card bounds
      const mask = new PIXI.Graphics();
      mask.beginFill(0xffffff);
      mask.drawRect(0, 0, this.cardW, this.cardH);
      mask.endFill();
      cc.addChild(mask);
      cc.mask = mask;

      this._bgs.push(bg);
      this._sprites.push(sprite);
      this._cardContainers.push(cc);
      this.container.addChild(cc);
    }
  }

  // ── Permanent label above the stack ──

  _buildStackLabel() {
    const pad = 6;
    const maxW = this.w - pad * 2;
    const fontSize = Math.max(9, Math.min(12, Math.round(this.w / 14)));

    const titleStyle = new PIXI.TextStyle({
      fontFamily: 'Space Grotesk, system-ui, sans-serif',
      fontSize,
      fontWeight: '600',
      fill: '#ffffff',
      wordWrap: true,
      wordWrapWidth: maxW,
    });
    const artistStyle = new PIXI.TextStyle({
      fontFamily: 'Space Grotesk, system-ui, sans-serif',
      fontSize: Math.max(8, fontSize - 2),
      fontWeight: '300',
      fill: 'rgba(255,255,255,0.65)',
      wordWrap: false,
    });

    const title  = new PIXI.Text(capWords(this.item.title),  titleStyle);
    const artist = new PIXI.Text(capWords(this.item.artist), artistStyle);

    title.x  = pad;
    artist.x = pad;

    // Position above the top card (account for the pile offset pushing the top card down)
    const labelH = title.height + artist.height + 2;
    title.y  = -labelH - 6;
    artist.y = title.y + title.height + 2;

    this.container.addChild(title);
    this.container.addChild(artist);
  }

  // ── Info overlay (title + artist) — created lazily on first hover ──

  _ensureInfoOverlay() {
    if (this._infoOverlay) return;

    const overlay = new PIXI.Container();
    const infoH = Math.round(Math.min(52, this.cardH * 0.38));
    const pad = 8;

    // Dark semi-transparent backing
    const bg = new PIXI.Graphics();
    bg.beginFill(0x1a1612, 0.62);
    bg.drawRect(0, this.cardH - infoH, this.cardW, infoH);
    bg.endFill();
    overlay.addChild(bg);

    // Title
    const fontSize = Math.max(9, Math.min(13, Math.round(this.cardW / 13)));
    const titleStyle = new PIXI.TextStyle({
      fontFamily: 'Space Grotesk, system-ui, sans-serif',
      fontSize,
      fontWeight: '600',
      fill: '#ffffff',
      wordWrap: true,
      wordWrapWidth: this.cardW - pad * 2,
    });
    const title = new PIXI.Text(capWords(this.item.title), titleStyle);
    title.x = pad;
    title.y = this.cardH - infoH + 7;
    overlay.addChild(title);

    // Artist
    const aFontSize = Math.max(8, Math.min(11, Math.round(this.cardW / 17)));
    const artistStyle = new PIXI.TextStyle({
      fontFamily: 'Space Grotesk, system-ui, sans-serif',
      fontSize: aFontSize,
      fontWeight: '300',
      fill: 'rgba(255,255,255,0.72)',
    });
    const artist = new PIXI.Text(capWords(this.item.artist), artistStyle);
    artist.x = pad;
    artist.y = title.y + title.height + 1;
    overlay.addChild(artist);

    overlay.visible = false;
    this._infoOverlay = overlay;
  }

  // ── Activate a card (bring to front, show/hide overlay) ──

  _setActive(idx, hovered) {
    // Reset all z-indices, bring active card to front
    this._cardContainers.forEach((cc, i) => { cc.zIndex = i; });
    this._cardContainers[idx].zIndex = this.numCards + 10;

    if (hovered) {
      this._ensureInfoOverlay();
      // Move overlay to active card container
      this._infoOverlay.parent?.removeChild(this._infoOverlay);
      this._cardContainers[idx].addChild(this._infoOverlay);
      this._infoOverlay.visible = true;
    } else {
      if (this._infoOverlay) this._infoOverlay.visible = false;
    }
  }

  // ── Pointer events matching DOM version's hover logic ──

  _attachEvents() {
    let activeIdx  = this.numCards - 1;
    let accum      = 0;
    let lastX      = 0, lastY = 0;
    let enterTime  = 0;
    const THRESHOLD = 24;
    const DEAD_ZONE = 150;

    this.container.on('pointerover', e => {
      const local = e.getLocalPosition(this.container);
      const ratio  = Math.max(0, Math.min(1, local.x / this.w));
      activeIdx    = Math.round(ratio * (this.numCards - 1));
      accum = 0;
      lastX = e.global.x; lastY = e.global.y;
      enterTime = Date.now();
      this._setActive(activeIdx, true);
    });

    this.container.on('pointermove', e => {
      if (Date.now() - enterTime < DEAD_ZONE) { lastX = e.global.x; lastY = e.global.y; return; }
      const dx = e.global.x - lastX;
      const dy = e.global.y - lastY;
      lastX = e.global.x; lastY = e.global.y;
      accum += dx + dy;
      if (accum > THRESHOLD && activeIdx < this.numCards - 1) {
        activeIdx++; accum = 0; this._setActive(activeIdx, true);
      } else if (accum < -THRESHOLD && activeIdx > 0) {
        activeIdx--; accum = 0; this._setActive(activeIdx, true);
      }
      accum = Math.max(-THRESHOLD, Math.min(THRESHOLD, accum));
    });

    this.container.on('pointerout', () => {
      activeIdx = this.numCards - 1; accum = 0;
      this._setActive(this.numCards - 1, false);
    });

    this.container.on('pointertap', () => {
      const { seedKey, title, artist } = this.item;
      console.log('[WebGL Crates] clicked:', seedKey, '|', title, '|', artist);
      showToast(`${capWords(title)} — ${capWords(artist)}`);
    });
  }

  // ── Artwork loading ──

  loadArtwork() {
    if (this.artLoaded) return;
    this.artLoaded = true;
    const last = this.numCards - 1;

    this._cardContainers.forEach((cc, i) => {
      // Top card = artworks[0] (seed), others = artworks[1+i] (neighbours)
      const rawUrl = i === last ? (this.item.artworks[0] || null)
                                : (this.item.artworks[1 + i] || null);
      if (!rawUrl) return;

      // Prefer the tiny 120×120 thumb — lower bandwidth, still sharp enough
      const url = rawUrl.replace(/-t(500|300)x\1/, '-t120x120');
      this._loadedUrls[i] = url;

      this.textureCache.load(url).then(tex => {
        if (!tex || !this._sprites[i]) return;
        const sprite = this._sprites[i];
        sprite.texture = tex;
        // Cover-fit: scale up so both axes fill the card, preserve aspect ratio
        const s = Math.max(this.cardW / tex.width, this.cardH / tex.height);
        sprite.width  = tex.width  * s;
        sprite.height = tex.height * s;
        // Center within card (excess gets clipped by the mask)
        sprite.x = (this.cardW - sprite.width)  / 2;
        sprite.y = (this.cardH - sprite.height) / 2;
        sprite.visible = true;
        this._bgs[i].visible = false;
      });
    });
  }

  unloadArtwork() {
    if (!this.artLoaded) return;
    this.artLoaded = false;
    this._sprites.forEach((s, i) => {
      s.visible  = false;
      s.texture  = PIXI.Texture.EMPTY;
      this._bgs[i].visible = true;
      if (this._loadedUrls[i]) {
        this.textureCache.release(this._loadedUrls[i]);
        this._loadedUrls[i] = null;
      }
    });
  }
}

// ══════════════════════════════════════════════════════
// CratesPage — one viewport-sized tile of crate stacks
// ══════════════════════════════════════════════════════

class CratesPage {
  constructor(col, row, items, vw, vh, textureCache) {
    this.col = col;
    this.row = row;
    this.artLoaded = false;
    this.stacks = [];

    this.container = new PIXI.Container();
    this.container.x = col * vw;
    this.container.y = row * vh;

    items.forEach(item => {
      const s = new CrateStack(item, textureCache);
      if (s.valid) {
        this.container.addChild(s.container);
        this.stacks.push(s);
      }
    });
  }

  loadArt() {
    if (this.artLoaded) return;
    this.artLoaded = true;
    this.stacks.forEach(s => s.loadArtwork());
  }

  unloadArt() {
    if (!this.artLoaded) return;
    this.artLoaded = false;
    this.stacks.forEach(s => s.unloadArtwork());
  }
}

// ══════════════════════════════════════════════════════
// Click toast helper
// ══════════════════════════════════════════════════════

let _toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('click-toast');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 2200);
}

// ══════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════

async function init() {
  // ── Theme ────────────────────────────────────────────
  let isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (isDark) document.body.classList.add('dark');
  const themeBtn = document.getElementById('theme-btn');
  themeBtn.textContent = isDark ? '🌙' : '☀️';

  // ── PixiJS app ───────────────────────────────────────
  const app = new PIXI.Application({
    resizeTo: window,
    backgroundColor: isDark ? THEME.dark.bg : THEME.light.bg,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });

  const wrap = document.getElementById('canvas-wrap');
  wrap.appendChild(app.view);
  app.view.style.cursor = 'grab';

  // ── World container (all pages live here) ────────────
  const world = new PIXI.Container();
  world.sortableChildren = false; // pages don't need sorting
  app.stage.addChild(world);
  app.stage.eventMode = 'static'; // allow pointer events on stage

  // ── Viewport state ───────────────────────────────────
  const TOOLBAR_H = 48;
  let panX  = 0;
  let panY  = TOOLBAR_H; // start below toolbar
  let scale = INITIAL_SCALE;

  function vw() { return window.innerWidth; }
  function vh() { return window.innerHeight - TOOLBAR_H; }

  function applyTransform() {
    world.x = panX;
    world.y = panY;
    world.scale.set(scale);
  }
  applyTransform();

  // ── Texture cache (shared across all pages) ──────────
  const texCache = new TextureCache();

  // ── Page grid ────────────────────────────────────────
  const pages   = {};               // "col,row" -> CratesPage
  const pending = new Set();        // page keys in-flight
  const pageNums = {};              // "col,row" -> stable page index
  let   pageCounter = 0;
  let   cratesPool        = null;   // resolved pool (set once, for status bar)
  let   cratesPoolPromise = null;   // in-flight or resolved promise (cached to prevent stampede)

  // Fetch and shuffle the crates index once. Caches the Promise so concurrent
  // callers share a single fetch instead of each firing their own.
  function getPool() {
    if (!cratesPoolPromise) cratesPoolPromise = fetch(`${API_BASE}/api/crates-index?v=3`)
      .then(r => r.json())
      .then(index => {
        // LCG shuffle — same algorithm as app.js for consistency
        let rng = (Date.now() % 2147483647) || 1;
        const rand = () => { rng = (rng * 16807) % 2147483647; return (rng - 1) / 2147483646; };
        const pool = [...index];
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        cratesPool = pool;
        return pool;
      });
    return cratesPoolPromise;
  }

  function requestPage(col, row) {
    const key = `${col},${row}`;
    if (pages[key] || pending.has(key)) return;
    pending.add(key);

    if (pageNums[key] === undefined) pageNums[key] = pageCounter++;
    const pageNum = pageNums[key];

    getPool().then(pool => {
      pending.delete(key);
      const slice = pool.slice(pageNum * CLUSTERS_PER_PAGE, (pageNum + 1) * CLUSTERS_PER_PAGE);
      if (slice.length === 0) return;

      const W = vw(), H = vh();
      const items = slice.map(c => {
        const sep   = (c.id || '').indexOf(':::');
        const artist = sep >= 0 ? c.id.slice(0, sep) : c.id;
        const title  = sep >= 0 ? c.id.slice(sep + 3) : '';
        return {
          seedKey:     c.id,
          artist,
          title,
          artworks:    c.artworks  || [],
          neighborIds: c.n         || [],
          weight:      c.weight    || 1,
          count:       c.count     || 1,
          rect:        null,
        };
      });

      cratesTreemap(items, 0, 0, W, H);

      const page = new CratesPage(col, row, items, W, H, texCache);
      pages[key] = page;
      world.addChild(page.container);

      // Hide loading spinner after first page
      document.getElementById('loading').classList.add('hidden');

      updateVisible(); // triggers art load + status update
    }).catch(err => {
      console.error('Page load failed:', err);
      pending.delete(key);
    });
  }

  // ── Visibility & art management ──────────────────────

  function viewBounds() {
    // Viewport bounds in world coordinates
    const W = vw(), H = vh();
    const vl = -panX / scale;
    const vt = (TOOLBAR_H - panY) / scale;
    const vr = (W - panX) / scale;
    const vb = (H + TOOLBAR_H - panY) / scale;
    return { vl, vt, vr, vb, W, H };
  }

  let visTimer = null;
  function scheduleVisible() {
    if (visTimer) return;
    visTimer = setTimeout(() => { visTimer = null; updateVisible(); }, 80);
  }

  function updateVisible() {
    const { vl, vt, vr, vb, W, H } = viewBounds();

    // Cols/rows to request (viewport + 1-page buffer)
    const colMin = Math.floor(vl / W) - 1;
    const colMax = Math.floor(vr / W) + 1;
    const rowMin = Math.floor(vt / H) - 1;
    const rowMax = Math.floor(vb / H) + 1;

    for (let c = colMin; c <= colMax; c++) {
      for (let r = rowMin; r <= rowMax; r++) {
        requestPage(c, r);
      }
    }

    // Art load/unload per page
    for (const [key, page] of Object.entries(pages)) {
      const [c, r] = key.split(',').map(Number);
      const near   = c >= colMin     && c <= colMax     && r >= rowMin     && r <= rowMax;
      const artFar = c < colMin - 2  || c > colMax + 2  || r < rowMin - 2  || r > rowMax + 2;
      const domFar = c < colMin - 5  || c > colMax + 5  || r < rowMin - 5  || r > rowMax + 5;

      if (domFar) {
        // Remove from world to free GPU memory (keep JS data for remounting)
        if (page.container.parent) world.removeChild(page.container);
        page.unloadArt();
      } else {
        if (!page.container.parent) world.addChild(page.container);
        if (near) page.loadArt();
        else if (artFar) page.unloadArt();
      }
    }

    updateStatus();
  }

  // ── Status bar ───────────────────────────────────────

  function updateStatus() {
    const totalStacks = Object.values(pages).reduce((n, p) => n + p.stacks.length, 0);
    const poolSize = cratesPool ? cratesPool.length : 0;
    document.getElementById('stack-count').textContent = poolSize ? `${poolSize.toLocaleString()} crates` : '';
    document.getElementById('status-bar').textContent =
      `${totalStacks} stacks rendered · ${Object.keys(pages).length} pages · scale ${scale.toFixed(2)}`;
  }

  app.ticker.add(() => {
    const fps = Math.round(app.ticker.FPS);
    document.getElementById('fps-display').textContent = `${fps} fps`;
  });

  // ══════════════════════════════════════════════════════
  // Pan & Zoom — Mouse
  // ══════════════════════════════════════════════════════

  let isDragging = false, didDrag = false;
  let dragStartX = 0, dragStartY = 0;
  let panStartX  = 0, panStartY  = 0;

  const canvas = app.view;

  canvas.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    isDragging = true; didDrag = false;
    dragStartX = e.clientX; dragStartY = e.clientY;
    panStartX  = panX;      panStartY  = panY;
  });

  window.addEventListener('mousemove', e => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (!didDrag && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
      didDrag = true;
      wrap.classList.add('dragging');
    }
    if (didDrag) {
      panX = panStartX + dx;
      panY = panStartY + dy;
      applyTransform();
      scheduleVisible();
    }
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    wrap.classList.remove('dragging');
  });

  // Wheel: Ctrl/Meta = zoom (pinch-to-zoom on trackpad), else pan
  canvas.addEventListener('wheel', e => {
    e.preventDefault();

    if (e.ctrlKey || e.metaKey) {
      // Zoom centred on cursor
      const mx = e.clientX;
      const my = e.clientY;
      const wx = (mx - panX) / scale;
      const wy = (my - panY) / scale;
      const factor    = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      const newScale  = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
      panX  = mx - wx * newScale;
      panY  = my - wy * newScale;
      scale = newScale;
    } else {
      // Scroll → pan
      panX -= e.deltaX;
      panY -= e.deltaY;
    }

    applyTransform();
    scheduleVisible();
  }, { passive: false });

  // ══════════════════════════════════════════════════════
  // Pan & Zoom — Touch (mobile)
  // ══════════════════════════════════════════════════════

  let tDragging    = false, tDidDrag = false;
  let tStartX      = 0, tStartY = 0;
  let tPanStartX   = 0, tPanStartY = 0;
  let tLastX       = 0, tLastY = 0, tLastTime = 0;
  let tVelX        = 0, tVelY = 0;
  let momentumId   = null;
  let pinchActive  = false, pinchStartScale = 1, pinchStartDist = 0;

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    if (e.touches.length === 2) {
      pinchActive = true; tDragging = false; tDidDrag = false;
      tVelX = tVelY = 0;
      if (momentumId) { cancelAnimationFrame(momentumId); momentumId = null; }
      pinchStartScale = scale;
      pinchStartDist  = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY,
      );
    } else if (e.touches.length === 1 && !pinchActive) {
      tDragging = true; tDidDrag = false;
      tStartX   = tLastX = e.touches[0].clientX;
      tStartY   = tLastY = e.touches[0].clientY;
      tLastTime = performance.now();
      tPanStartX = panX; tPanStartY = panY;
      tVelX = tVelY = 0;
      if (momentumId) { cancelAnimationFrame(momentumId); momentumId = null; }
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 2 && pinchActive) {
      const dist  = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY,
      );
      const cx    = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy    = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const wx    = (cx - panX) / scale;
      const wy    = (cy - panY) / scale;
      const newSc = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinchStartScale * (dist / pinchStartDist)));
      panX  = cx - wx * newSc;
      panY  = cy - wy * newSc;
      scale = newSc;
      applyTransform();
      scheduleVisible();
    } else if (e.touches.length === 1 && tDragging && !pinchActive) {
      const now = performance.now();
      const cx  = e.touches[0].clientX, cy = e.touches[0].clientY;
      const dx  = cx - tStartX, dy = cy - tStartY;
      if (!tDidDrag && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        tDidDrag = true;
        wrap.classList.add('dragging');
      }
      if (tDidDrag) {
        const dt = now - tLastTime || 16;
        tVelX  = (cx - tLastX) / dt * 16;
        tVelY  = (cy - tLastY) / dt * 16;
        tLastX = cx; tLastY = cy; tLastTime = now;
        panX   = tPanStartX + dx;
        panY   = tPanStartY + dy;
        applyTransform();
        scheduleVisible();
      }
    }
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    if (e.touches.length < 2) pinchActive = false;
    if (e.touches.length === 0) {
      tDragging = false;
      wrap.classList.remove('dragging');
      if (tDidDrag && (Math.abs(tVelX) > 1 || Math.abs(tVelY) > 1)) {
        momentumId = requestAnimationFrame(function step() {
          tVelX *= 0.92; tVelY *= 0.92;
          if (Math.abs(tVelX) < 0.5 && Math.abs(tVelY) < 0.5) {
            momentumId = null; updateVisible(); return;
          }
          panX += tVelX; panY += tVelY;
          applyTransform();
          scheduleVisible();
          momentumId = requestAnimationFrame(step);
        });
      }
    }
  });

  // ══════════════════════════════════════════════════════
  // Theme toggle
  // ══════════════════════════════════════════════════════

  themeBtn.addEventListener('click', () => {
    isDark = !isDark;
    document.body.classList.toggle('dark', isDark);
    themeBtn.textContent = isDark ? '🌙' : '☀️';
    // Update canvas background colour
    app.renderer.background.color = isDark ? THEME.dark.bg : THEME.light.bg;
    // Note: existing card placeholder colours stay — they're palette-based and look fine on both themes.
    // A full theme rebuild would require destroying & recreating all pages, which is out of scope
    // for this prototype.
  });

  // ══════════════════════════════════════════════════════
  // Keyboard shortcuts
  // ══════════════════════════════════════════════════════

  window.addEventListener('keydown', e => {
    if (e.key === 'd') themeBtn.click();
    if (e.key === '0' || e.key === '=') {
      // Reset zoom/pan
      panX = 0; panY = TOOLBAR_H; scale = INITIAL_SCALE;
      applyTransform(); scheduleVisible();
    }
    if (e.key === '+' || e.key === '-') {
      const factor = e.key === '+' ? 1.2 : 1 / 1.2;
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      const wx = (cx - panX) / scale, wy = (cy - panY) / scale;
      scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
      panX  = cx - wx * scale; panY  = cy - wy * scale;
      applyTransform(); scheduleVisible();
    }
  });

  // ══════════════════════════════════════════════════════
  // Kick off
  // ══════════════════════════════════════════════════════

  updateVisible();
  console.log('[WebGL Crates] Initialised. Drag to pan · Scroll/pinch to zoom · Click a crate to log it.');
}

init().catch(err => {
  console.error('[WebGL Crates] Init failed:', err);
  const loading = document.getElementById('loading');
  loading.querySelector('.loading-label').textContent = 'Failed to load — check console';
});
