// ═══════════════════════════════════════════
// Bezier path computation
// ═══════════════════════════════════════════
const EDGE_PAD = 10;

function getNodeCenter(node) {
  const dims = cardDimFor(node);
  return {
    x: node.x + dims.w / 2,
    y: node.y + dims.h / 2,
  };
}

function getEdgePoint(center, target, halfW, halfH, pad) {
  const dx = target.x - center.x;
  const dy = target.y - center.y;

  if (dx === 0 && dy === 0) return { x: center.x, y: center.y };

  let t = Infinity;

  if (dx !== 0) {
    const tx = (dx > 0 ? halfW : -halfW) / dx;
    if (tx > 0) t = Math.min(t, tx);
  }
  if (dy !== 0) {
    const ty = (dy > 0 ? halfH : -halfH) / dy;
    if (ty > 0) t = Math.min(t, ty);
  }

  const edgeX = center.x + dx * t;
  const edgeY = center.y + dy * t;

  const dist = Math.sqrt(dx * dx + dy * dy);
  return {
    x: edgeX + (dx / dist) * pad,
    y: edgeY + (dy / dist) * pad,
  };
}

function computePath(fromNode, toNode, edgeIndex) {
  const cA = getNodeCenter(fromNode);
  const cB = getNodeCenter(toNode);
  const dA = cardDimFor(fromNode);
  const dB = cardDimFor(toNode);

  // Determine exit side: leave horizontally toward the other node
  const goRight = cB.x >= cA.x;
  const a = {
    x: goRight ? fromNode.x + dA.w + EDGE_PAD : fromNode.x - EDGE_PAD,
    y: cA.y,
  };
  const b = {
    x: goRight ? toNode.x - EDGE_PAD : toNode.x + dB.w + EDGE_PAD,
    y: cB.y,
  };

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return `M${a.x},${a.y} L${b.x},${b.y}`;

  // Horizontal stub length: ~40% of horizontal distance, clamped
  const stubLen = Math.min(Math.max(Math.abs(dx) * 0.4, 20), 80);
  const dirA = goRight ? 1 : -1;
  const dirB = -dirA;

  const cp1x = a.x + dirA * stubLen;
  const cp1y = a.y;
  const cp2x = b.x + dirB * stubLen;
  const cp2y = b.y;

  return `M${a.x},${a.y} C${cp1x},${cp1y} ${cp2x},${cp2y} ${b.x},${b.y}`;
}

// ═══════════════════════════════════════════
// Render
// ═══════════════════════════════════════════
function renderCards() {
  const layer = document.getElementById('nodes-layer');

  nodes.forEach(node => {
    const card = document.createElement('div');
    card.className = 'node-card';
    card.dataset.rank = node.rank;
    card.dataset.nodeId = node.id;
    card.style.left = node.x + 'px';
    card.style.top = node.y + 'px';

    const hasArt = node.artUrl && node.source !== 'not_found';
    const hasAudio = !!(node.scTrackUrl || node.setUrl);
    const artClass = hasArt ? 'album-art' : 'album-art no-art';
    const imgTag = hasArt
      ? `<img class="${artClass}" src="${node.artUrl}" alt="${node.title} by ${node.artist}" loading="lazy">`
      : (() => { const [gA, gT] = (node.graphId || '').split(':::'); return `<img class="${artClass}" src="${gradientArtUrl(gT || node.title, gA || node.artist)}">`; })();

    const playBtn = hasAudio
      ? `<button class="play-btn" aria-label="Play">${PLAY_SVG}</button>`
      : '';

    const sourceBadge = `<span class="source-badge">${EQ_BARS_HTML}</span>`;

    const rootTitle = nodes.find(n => n.rank === 'root')?.title || '';
    let rankLabel;
    if (node.rank === 'root') {
      rankLabel = '';
    } else if (node.rank === '1') {
      rankLabel = `Played next to '${rootTitle}'`;
    } else {
      rankLabel = `2 tracks from '${rootTitle}'`;
    }

    // Track link (individual SC track, or the set with a timestamp) — used by
    // the title link and the "View track" context-menu option on every trigger.
    let trackLink = node.scTrackUrl || node.setUrl || null;
    if (trackLink && trackLink === node.setUrl && node.setOffsetSec && node.setSource !== 'mixcloud') {
      const m = Math.floor(node.setOffsetSec / 60);
      const s = node.setOffsetSec % 60;
      trackLink += `#t=${m}m${s}s`;
    }

    // DJ line: link to SC set with timestamp if available, else episode URL
    const allDjs = node.djs || [];
    let djLine = '';
    if (allDjs.length > 0) {
      let setLink = null;
      if (node.setUrl && node.setSource !== 'mixcloud') {
        setLink = node.setUrl;
        if (node.setOffsetSec) {
          const m = Math.floor(node.setOffsetSec / 60);
          const s = node.setOffsetSec % 60;
          setLink += `#t=${m}m${s}s`;
        }
      }
      const links = allDjs.map(d => {
        const href = setLink || d.episodeUrl;
        return href
          ? `<a href="${href}" target="_blank" rel="noopener" data-dj="${d.name}" data-artist="${node.artist}" data-set-url="${d.episodeUrl || ''}" data-track-url="${trackLink || ''}">${d.name}</a>`
          : `<span data-dj="${d.name}" data-artist="${node.artist}" data-set-url="${d.episodeUrl || ''}" data-track-url="${trackLink || ''}" class="dj-ctx-trigger">${d.name}</span>`;
      }).join(', ');
      djLine = `<span class="dj-line"><span class="tt-inner">Mixed by ${links}</span></span>`;
    }
    const titleData = `data-artist="${node.artist}" data-dj="${allDjs.length ? allDjs[0].name : ''}" data-set-url="${allDjs.length ? (allDjs[0].episodeUrl || '') : ''}" data-track-url="${trackLink || ''}"`;
    const titleTag = trackLink
      ? `<a href="${trackLink}" class="track-title track-ctx-trigger" target="_blank" rel="noopener" ${titleData}><span class="tt-inner">${node.title}</span></a>`
      : `<span class="track-title track-ctx-trigger" ${titleData}><span class="tt-inner">${node.title}</span></span>`;

    const cardToolbar = node.rank === 'root' ? `
      <div class="card-toolbar">
        <button id="shuffle-btn" title="Shuffle">
          <svg viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>
          Shuffle
        </button>
      </div>` : '';

    let showMoreFooter = '';
    if (node.rank === 'root' && currentCluster && !isMobileView()) {
      const m = currentCluster.meta;
      if (m.expandLevel >= 2 || (m.expandLevel === 1 && m.totalR1 <= m.r1Shown)) {
        showMoreFooter = `<div class="card-footer"><span class="all-shown">all connections shown</span></div>`;
      } else if (m.totalR1 > maxR1) {
        showMoreFooter = `<div class="card-footer"><button id="show-more-btn">show more connections</button></div>`;
      }
    }

    card.innerHTML = `
      ${cardToolbar}
      ${rankLabel ? `<span class="rank-tooltip">${rankLabel}</span>` : ''}
      <div class="art-wrap">
        ${imgTag}
        ${playBtn}
        ${sourceBadge}
        ${renderSourceToggle(node)}
        <div class="progress-bar"><div class="bar-track"><div class="bar-fill"></div></div></div>
      </div>
      ${titleTag}
      <span class="artist-name"><span class="tt-inner"><span class="artist-ctx-trigger" data-artist="${node.artist}" data-dj="${allDjs.length ? allDjs[0].name : ''}" data-set-url="${allDjs.length ? (allDjs[0].episodeUrl || '') : ''}" data-track-url="${trackLink || ''}">${node.artist}</span></span></span>
      <button class="card-dots" aria-label="More options" data-artist="${node.artist}" data-dj="${allDjs.length ? allDjs[0].name : ''}" data-set-url="${allDjs.length ? (allDjs[0].episodeUrl || '') : ''}" data-track-url="${trackLink || ''}"><svg viewBox="0 0 24 24" fill="currentColor"><circle class="dot dot-top" cx="12" cy="5" r="1.5"/><circle class="dot dot-mid" cx="12" cy="12" r="1.5"/><circle class="dot dot-bot" cx="12" cy="19" r="1.5"/><line class="x-line" x1="8" y1="8" x2="16" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line class="x-line" x1="16" y1="8" x2="8" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      ${djLine}
      ${showMoreFooter}
    `;

    initSourceToggle(card, node);

    // Tooltips for overflow text
    card.querySelectorAll('.track-title, .artist-name, .dj-line').forEach(el => {
      el.setAttribute('title', el.textContent);
    });

    // Wire up play button
    if (hasAudio) {
      const btn = card.querySelector('.play-btn');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePlay(node.id);
      });
      initProgressBarInteraction(card);
    }

    card.addEventListener('animationend', () => card.classList.add('settled'), { once: true });
    layer.appendChild(card);
  });
}

// If a single line (title/artist/dj) overflows, mark it and set up a seamless
// wrap-around marquee: a duplicate copy of the content is appended after a gap,
// and CSS scrolls the pair by exactly one copy+gap so the text loops around
// (Spotify-style) instead of ping-ponging. Shared by desktop + mobile.
function applyMarquee(line) {
  const inner = line.querySelector('.tt-inner');
  if (!inner) return;
  line.classList.remove('has-marquee');
  line.style.removeProperty('--marquee-shift');
  line.style.removeProperty('--marquee-duration');
  inner.querySelector('.tt-dup')?.remove();
  if (line.scrollWidth - line.clientWidth <= 2) return;   // fits — no marquee
  const dup = document.createElement('span');
  dup.className = 'tt-dup';
  dup.setAttribute('aria-hidden', 'true');
  dup.innerHTML = inner.innerHTML;                        // second copy
  inner.appendChild(dup);
  // Distance to scroll = first copy width + gap = where the duplicate begins.
  const shift = Math.round(dup.getBoundingClientRect().left - inner.getBoundingClientRect().left);
  line.style.setProperty('--marquee-shift', `-${shift}px`);
  // ~11.25px/s so long titles scroll gently.
  line.style.setProperty('--marquee-duration', Math.max(24, Math.round(shift / 11.25 * 10) / 10) + 's');
  line.classList.add('has-marquee');
}

// Set up wrap-around marquees on all three of a card's lines.
function setupCardMarquees(card) {
  ['.track-title', '.artist-name', '.dj-line'].forEach(sel => {
    const line = card.querySelector(sel);
    if (line) applyMarquee(line);
  });
}

function renderConnections() {
  const svg = document.getElementById('connections-layer');

  edges.forEach((edge, i) => {
    const fromNode = nodeMap[edge.from];
    const toNode = nodeMap[edge.to];
    if (!fromNode || !toNode) return;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', computePath(fromNode, toNode, i));
    path.setAttribute('class', 'connection-path');
    path.dataset.from = edge.from;
    path.dataset.to = edge.to;

    svg.appendChild(path);
    const len = path.getTotalLength();
    path.style.strokeDasharray = len;
    path.style.strokeDashoffset = len;
  });
}

function setupHovers() {
  document.querySelectorAll('.node-card').forEach(card => {
    const nodeId = card.dataset.nodeId;

    card.addEventListener('mouseenter', () => {
      document.querySelectorAll(
        `.connection-path[data-from="${nodeId}"], .connection-path[data-to="${nodeId}"]`
      ).forEach(p => p.classList.add('highlighted'));
    });

    card.addEventListener('mouseleave', () => {
      document.querySelectorAll('.connection-path.highlighted')
        .forEach(p => p.classList.remove('highlighted'));
    });
  });
}

// ═══════════════════════════════════════════
// Auto-layout engine
// ═══════════════════════════════════════════
function computeLayout() {
  const root = nodes.find(n => n.rank === 'root');
  if (!root) return;
  const r1Nodes = nodes.filter(n => n.rank === '1');

  // Build adjacency: for each node, collect its children (from edges)
  const childrenOf = {};
  nodes.forEach(n => childrenOf[n.id] = []);
  edges.forEach(e => {
    const child = nodes.find(n => n.id === e.to);
    if (child && childrenOf[e.from] !== undefined) {
      childrenOf[e.from].push(child);
    }
  });

  function collectLeaves(nodeId) {
    const leaves = [];
    for (const ch of (childrenOf[nodeId] || [])) {
      leaves.push(ch);
      collectLeaves(ch.id).forEach(l => leaves.push(l));
    }
    return leaves;
  }

  function dimOf(n) { return cardDimFor(n); }

  const rootD = dimOf(root);
  const pad = 36;

  // Split r1 into left/right, grouping by episode so tracks from
  // the same DJ set stay on the same side
  const leftR1 = [], rightR1 = [];
  const edgeMap = new Map(); // r1 localId -> edge context
  for (const e of edges) {
    if (e.from === 'root') edgeMap.set(e.to, e.context || {});
  }
  // Group R1 nodes by episode URL
  const episodeGroups = new Map(); // episodeUrl -> [node, ...]
  const noEpisode = [];
  for (const n of r1Nodes) {
    const ctx = edgeMap.get(n.id);
    const ep = ctx && ctx.episodeUrl;
    if (ep) {
      if (!episodeGroups.has(ep)) episodeGroups.set(ep, []);
      episodeGroups.get(ep).push(n);
    } else {
      noEpisode.push(n);
    }
  }
  // Flatten all R1 nodes into a single pool, then alternate sides
  const allR1 = [];
  for (const [, group] of episodeGroups) allR1.push(...group);
  allR1.push(...noEpisode);
  for (const n of allR1) {
    (leftR1.length <= rightR1.length ? leftR1 : rightR1).push(n);
  }

  // Slot height = max(r1 card height, total r2 children stacked)
  function slotHeight(r1) {
    const r1H = dimOf(r1).h;
    const leaves = collectLeaves(r1.id);
    if (leaves.length === 0) return r1H;
    const r2BlockH = leaves.reduce((sum, l) => sum + dimOf(l).h + pad, 0) - pad;
    return Math.max(r1H, r2BlockH);
  }

  function sideHeight(r1List) {
    let total = 0;
    for (const r1 of r1List) total += slotHeight(r1) + pad;
    return total > 0 ? total - pad : 0;
  }

  // Use viewport dimensions to compute layout width
  const vpEl = document.getElementById('graph-viewport');
  const vpW = vpEl ? vpEl.clientWidth : window.innerWidth;
  const vpH = document.getElementById('graph-viewport').clientHeight || (window.innerHeight - 60);

  // Compute horizontal gaps to fill available width
  // Layout columns: R2-left | gap | R1-left | gap | ROOT | gap | R1-right | gap | R2-right
  const r1W = cardWidths['1'];
  const r2W = cardWidths['2'];
  const fixedW = r2W + r1W + rootD.w + r1W + r2W; // total card widths
  const availGap = vpW - fixedW - 40; // 40px edge margins
  const hGap = Math.max(30, availGap / 4); // distribute across 4 gaps

  const neededH = Math.max(sideHeight(leftR1), sideHeight(rightR1), rootD.h + 60);
  const H = Math.max(vpH, neededH + 80);
  const W = Math.max(vpW, fixedW + hGap * 4 + 40);

  const container = document.getElementById('graph-container');
  container.style.height = H + 'px';

  // Root — center
  root.x = (W - rootD.w) / 2;
  root.y = (H - rootD.h) / 2;

  // Place an R1 column — sequential top-to-bottom
  function placeR1Column(r1List, x) {
    const slots = r1List.map(r1 => slotHeight(r1));
    const totalH = slots.reduce((s, h) => s + h, 0) + (slots.length - 1) * pad;
    let y = (H - totalH) / 2;

    r1List.forEach((r1, i) => {
      const sH = slots[i];
      const r1H = dimOf(r1).h;
      r1.x = x;
      r1.y = y + (sH - r1H) / 2;

      const leaves = collectLeaves(r1.id);
      const isLeft = leftR1.includes(r1);
      const leafW = leaves.length > 0 ? dimOf(leaves[0]).w : r2W;
      const r2X = isLeft
        ? Math.max(5, x - hGap - leafW)
        : Math.min(W - leafW - 5, x + dimOf(r1).w + hGap);

      // Stack R2 children sequentially within their slot
      const r2BlockH = leaves.length > 0
        ? leaves.reduce((sum, l) => sum + dimOf(l).h + pad, 0) - pad : 0;
      const r2StartY = y + (sH - r2BlockH) / 2;
      let r2Y = r2StartY;
      leaves.forEach(n => {
        n.x = r2X;
        n.y = r2Y;
        r2Y += dimOf(n).h + pad;
      });

      y += sH + pad;
    });
  }

  const leftR1X = root.x - hGap - r1W;
  const rightR1X = root.x + rootD.w + hGap;
  placeR1Column(leftR1, leftR1X);
  placeR1Column(rightR1, rightR1X);

  // Column sweep: sort each column by y, push down any overlaps
  function sweepColumn(colNodes) {
    if (colNodes.length < 2) return;
    colNodes.sort((a, b) => a.y - b.y);
    for (let i = 1; i < colNodes.length; i++) {
      const prev = colNodes[i - 1], curr = colNodes[i];
      const minY = prev.y + dimOf(prev).h + pad;
      if (curr.y < minY) curr.y = minY;
    }
  }

  // Group non-root nodes by x-column and sweep each
  const columns = {};
  nodes.forEach(n => {
    if (n.rank === 'root') return;
    const key = Math.round(n.x);
    if (!columns[key]) columns[key] = [];
    columns[key].push(n);
  });
  Object.values(columns).forEach(col => sweepColumn(col));

  // Grow container if nodes extend beyond bounds
  let maxBottom = H;
  let maxRight = W;
  nodes.forEach(n => {
    const d = dimOf(n);
    maxBottom = Math.max(maxBottom, n.y + d.h + 20);
    maxRight = Math.max(maxRight, n.x + d.w + 20);
  });
  container.style.height = maxBottom + 'px';
  container.style.width = maxRight + 'px';
}

// Scale + center the graph container so the entire network fits the viewport.
// Called after every layout (initial render AND resize) — the whole graph must
// always be visible, shrinking as needed.
function fitGraphToViewport() {
  const container = document.getElementById('graph-container');
  const viewport = document.getElementById('graph-viewport');
  if (!container || !viewport) return;

  const contentW = parseFloat(container.style.width) || 1200;
  const contentH = parseFloat(container.style.height) || 900;
  const vpW = viewport.clientWidth;
  const vpH = viewport.clientHeight;
  const insetX = vpW > 800 ? 80 : 0;
  const insetY = 20;
  const scale = Math.min(1, (vpW - insetX) / contentW, (vpH - insetY) / contentH);
  container.style.transform = `scale(${scale})`;
  container.style.width = contentW + 'px';

  // Center vertically within viewport
  const scaledH = contentH * scale;
  container.style.marginTop = Math.max(0, (vpH - scaledH) / 2) + 'px';

  // Center horizontally — done explicitly (not via flex) because the unscaled
  // container is often wider than the viewport, which makes flexbox pin it left.
  // Center the actual card bounding box (not the raw container width) so the
  // left/right margins stay symmetric even when the layout pads unevenly.
  let minCardX = Infinity, maxCardX = -Infinity;
  nodes.forEach(n => {
    const d = cardDimFor(n);
    minCardX = Math.min(minCardX, n.x);
    maxCardX = Math.max(maxCardX, n.x + d.w);
  });
  if (!isFinite(minCardX)) { minCardX = 0; maxCardX = contentW; }
  container.style.marginLeft = Math.max(0, (vpW - (minCardX + maxCardX) * scale) / 2) + 'px';
}

// ═══════════════════════════════════════════
// Clear & show cluster
// ═══════════════════════════════════════════
function clearGraph() {
  stopCurrentPlayback();

  // Remove cards and connections
  document.getElementById('nodes-layer').innerHTML = '';
  document.getElementById('connections-layer').innerHTML = '';
  const dg = document.getElementById('desktop-genres');
  if (dg) { dg.innerHTML = ''; dg.classList.remove('visible'); }

  // Reset transform
  const container = document.getElementById('graph-container');
  container.style.transform = '';
  container.style.marginTop = '';
  container.style.marginLeft = '';
}

function logCluster(cluster) {
  const root = cluster.nodes.find(n => n.rank === 'root');
  // Find the DJ set context from the first edge (root -> r1)
  const rootEdge = cluster.edges.find(e => e.from === 'root');
  const ctx = rootEdge && rootEdge.context;

  console.group(`%c${root.artist} — ${root.title}`, 'font-weight:bold;font-size:13px');
  if (ctx) {
    console.log(`DJ: ${ctx.dj}`);
    console.log(`Set: ${ctx.episodeUrl}`);
    console.log(`Date: ${ctx.date}`);
  }
  console.log(`Root ID: ${cluster.meta.root_id}`);
  const sc = cluster.meta.soundcloud || 0;
  console.log(`Enriched: ${cluster.meta.found}/${cluster.nodes.length} tracks (SC:${sc})`);
  console.log('');
  console.log('Nodes:');
  cluster.nodes.forEach(n => {
    const rank = n.rank === 'root' ? 'root' : `rank ${n.rank}`;
    const src = n.source === 'not_found' ? '(no art)' : `[${n.source}]`;
    const audio = (n.scTrackUrl || n.setUrl) ? '' : '(no audio)';
    const flags = [src, audio].filter(Boolean).join(' ');
    console.log(`  [${rank}] ${n.artist} — ${n.title} ${flags}`);
  });
  console.log('');
  console.log('Edges:');
  cluster.edges.forEach(e => {
    const from = cluster.nodes.find(n => n.id === e.from);
    const to = cluster.nodes.find(n => n.id === e.to);
    const dj = e.context ? `  (${e.context.dj})` : '';
    console.log(`  ${from.artist} → ${to.artist}${dj}`);
  });
  console.groupEnd();
}

function isMobileView() {
  return window.innerWidth <= 768;
}

// Recompute layout on window resize (debounced)
let _resizeTimer, _wasMobile = isMobileView();
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (!currentCluster) return;
    const nowMobile = isMobileView();
    // Crossed breakpoint — full re-render via showCluster
    if (nowMobile !== _wasMobile) {
      _wasMobile = nowMobile;
      showCluster(currentCluster);
      return;
    }
    if (nowMobile) return;
    // Desktop resize — reposition existing cards
    computeLayout();
    const layer = document.getElementById('nodes-layer');
    if (layer) {
      nodes.forEach(node => {
        const card = layer.querySelector(`[data-node-id="${node.id}"]`);
        if (card) {
          card.style.left = node.x + 'px';
          card.style.top = node.y + 'px';
        }
      });
    }
    const svg = document.getElementById('connections-layer');
    if (svg) svg.innerHTML = '';
    renderConnections();
    // Re-fit: the whole network must stay visible at the new viewport size
    fitGraphToViewport();
  }, 200);
});
