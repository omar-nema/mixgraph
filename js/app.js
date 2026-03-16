function showCluster(cluster) {
  if (isMobileView()) {
    showClusterMobile(cluster);
    return;
  }
  clearGraph();
  currentCluster = cluster;
  nodes = cluster.nodes;
  edges = cluster.edges;
  nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);
  currentRootId = cluster.nodes[0].graphId;
  document.getElementById('cluster-id').textContent = currentRootId;
  const newHash = '#' + encodeURIComponent(currentRootId);
  if (window.location.hash !== newHash) {
    history.pushState(null, '', newHash);
  }
  logCluster(cluster);

  // Two-pass layout: render cards offscreen, measure, then position
  // Pass 1: place cards at 0,0 so DOM can measure heights
  nodes.forEach(n => { n.x = -9999; n.y = -9999; });
  renderCards();

  // Detect DJ line overflow — truncate with inline "(more)" that expands
  document.querySelectorAll('.dj-line').forEach(line => {
    if (line.scrollHeight <= line.clientHeight + 1) return;
    const fullHTML = line.innerHTML;
    const moreBtn = document.createElement('button');
    moreBtn.className = 'dj-more';
    moreBtn.textContent = '(more)';
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      line.innerHTML = fullHTML;
      line.classList.add('expanded');
    });
    // Use plain text truncation with binary search to fit "… (more)" in 2 lines
    const fullText = line.textContent;
    let lo = 0, hi = fullText.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      line.textContent = fullText.slice(0, mid) + '… ';
      line.appendChild(moreBtn.cloneNode(true));
      if (line.scrollHeight <= line.clientHeight + 1) lo = mid;
      else hi = mid - 1;
    }
    line.textContent = fullText.slice(0, lo) + '… ';
    line.appendChild(moreBtn);
  });

  // Wire shuffle button (recreated each render inside root card)
  const shuffleBtn = document.getElementById('shuffle-btn');
  if (shuffleBtn) shuffleBtn.addEventListener('click', shuffle);
  const cardLinkBtn = document.getElementById('card-link-btn');
  if (cardLinkBtn) cardLinkBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href);
    cardLinkBtn.classList.add('copied');
    setTimeout(() => { cardLinkBtn.classList.remove('copied'); }, 1500);
  });
  const showMoreBtn = document.getElementById('show-more-btn');
  if (showMoreBtn) {
    showMoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const prevLevel = currentCluster.meta.expandLevel;
      const limit = prevLevel === 0 ? 8 : Infinity;
      const r2Limit = prevLevel === 0 ? r2PerR1 : Infinity;
      const expanded = selectCluster(currentRootId, limit, r2Limit);
      expanded.meta.expandLevel = prevLevel + 1;
      showCluster(expanded);
    });
  }

  // Measure actual card heights from DOM
  measuredHeights = {};
  nodes.forEach(n => {
    const el = document.querySelector(`.node-card[data-node-id="${n.id}"]`);
    if (el) measuredHeights[n.id] = el.offsetHeight;
  });

  // Pass 2: compute layout with real heights, reposition
  computeLayout();
  nodes.forEach(n => {
    const el = document.querySelector(`.node-card[data-node-id="${n.id}"]`);
    if (el) {
      el.style.left = n.x + 'px';
      el.style.top = n.y + 'px';
    }
  });

  // Filter label above root card
  const filterLabel = document.getElementById('filter-label');
  const activeFilter = artistFilter || djFilter;
  if (activeFilter) {
    const rootNode = nodes.find(n => n.rank === 'root');
    const rootEl = document.querySelector('.node-card[data-node-id="root"]');
    if (rootNode && rootEl) {
      filterLabel.innerHTML = `filtering for "${escHtml(activeFilter.display)}" <button id="filter-clear">clear</button>`;
      filterLabel.style.left = rootNode.x + 'px';
      filterLabel.style.top = (rootNode.y - 28) + 'px';
      filterLabel.style.width = rootEl.offsetWidth + 'px';
      filterLabel.style.textAlign = 'center';
      document.getElementById('filter-clear').addEventListener('click', () => {
        clearArtistFilter();
        clearDjFilter();
        const tbInput = document.getElementById('toolbar-artist-search');
        tbInput.value = '';
        tbInput.classList.remove('filtered');
        document.getElementById('search-btn-wrap').classList.remove('active');
        shuffle();
      });
    }
  } else {
    filterLabel.textContent = '';
  }

  renderConnections();
  setupHovers();

  // Zoom-to-fit: scale graph container to fit within viewport
  const container = document.getElementById('graph-container');
  const viewport = document.getElementById('graph-viewport');
  const contentW = parseFloat(container.style.width) || 1200;
  const contentH = parseFloat(container.style.height) || 900;
  const vpW = viewport.clientWidth;
  const vpH = viewport.clientHeight;
  const insetX = vpW > 800 ? 80 : 0;
  const insetY = 20;
  const scaleX = (vpW - insetX) / contentW;
  const scaleY = (vpH - insetY) / contentH;
  const scale = Math.min(1, scaleX, scaleY);
  container.style.transform = `scale(${scale})`;
  container.style.width = contentW + 'px';

  // Center vertically within viewport
  const scaledH = contentH * scale;
  const topOffset = Math.max(0, (vpH - scaledH) / 2);
  container.style.marginTop = topOffset + 'px';
}

function matchesFilter(nodeId, filter) {
  if (filter === 'none') return true;
  const cached = audioCache[nodeId];
  if (!cached) return false;
  // Filter by what will actually play (respecting the waterfall)
  const hasScTrack = !!cached.scTrackUrl;
  if (filter === 'soundcloud') return hasScTrack;
  if (filter === 'soundcloud_set') return !hasScTrack && cached.source === 'soundcloud_set';
  if (filter === 'lotradio') return !hasScTrack && cached.setSource === 'soundcloud';
  return true;
}

function shuffle() {
  if (frozen || candidates.length === 0) return;
  const filter = document.getElementById('source-filter').value;
  let pool = candidates.filter(id => matchesFilter(id, filter));

  // If an artist is selected, restrict to their tracks
  if (artistFilter) {
    const artistSet = new Set(artistFilter.trackIds);
    pool = pool.filter(id => artistSet.has(id));
    if (pool.length === 0) {
      pool = artistFilter.trackIds.filter(id => graphNodes[id] && matchesFilter(id, filter));
    }
  }

  // If a DJ is selected, restrict to their tracks
  if (djFilter) {
    const djSet = new Set(djFilter.trackIds);
    pool = pool.filter(id => djSet.has(id));
    if (pool.length === 0) {
      pool = djFilter.trackIds.filter(id => graphNodes[id] && matchesFilter(id, filter));
    }
  }

  if (pool.length === 0) {
    const activeFilter = artistFilter || djFilter;
    console.warn(activeFilter
      ? `No tracks found for "${activeFilter.display}" with current filter`
      : `No candidates match filter "${filter}"`);
    return;
  }
  const rootId = pool[Math.floor(Math.random() * pool.length)];
  const cluster = selectCluster(rootId);
  showCluster(cluster);
}

function loadClusterById(id) {
  id = id.trim();
  if (!graphNodes[id]) {
    console.warn(`Node "${id}" not found in graph`);
    return;
  }
  const cluster = selectCluster(id);
  showCluster(cluster);
}

// ═══════════════════════════════════════════
// Init — fetch graph + cache, then render
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  // Load graph (required)
  try {
    const resp = await fetch('web-app/output/combined_graph.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    graphNodes = data.nodes;
    const nodeCount = Object.keys(graphNodes).length;
    console.log(`Graph loaded: ${nodeCount} nodes`);
  } catch (err) {
    console.error('Failed to load combined_graph.json:', err);
    return;
  }

  // Load audio cache (optional — fail silently)
  try {
    const resp = await fetch('web-app/output/audio_cache.json');
    if (resp.ok) {
      audioCache = await resp.json();
      console.log(`Audio cache loaded: ${Object.keys(audioCache).length} entries`);
    }
  } catch (e) {
    // No cache — all nodes will show grey placeholders
  }

  // Load DJ name map (optional — falls back to raw show titles)
  let djNameMap = {};
  try {
    const resp = await fetch('pipeline/output/dj_name_map.json');
    if (resp.ok) {
      djNameMap = await resp.json();
      console.log(`DJ name map loaded: ${Object.keys(djNameMap).length} entries`);
    }
  } catch (e) {}

  // Compute candidates (3+ edges, no mixcloud-only neighbors)
  const mcNodes = new Set(
    Object.keys(audioCache).filter(nid => audioCache[nid].source === 'mixcloud_set')
  );
  candidates = Object.keys(graphNodes).filter(nid => {
    const edges = graphNodes[nid].edges || [];
    if (edges.length < 3) return false;
    if (mcNodes.has(nid)) return false;
    return !edges.some(e => mcNodes.has(e.node));
  });
  console.log(`${candidates.length} candidates (3+ edges, no mixcloud)`);

  if (candidates.length === 0) {
    console.error('No candidates found in graph');
    return;
  }

  // Load cluster from URL hash, or shuffle for a random one
  const hashId = decodeURIComponent(window.location.hash.slice(1));
  if (hashId && graphNodes[hashId]) {
    loadClusterById(hashId);
  } else {
    shuffle();
  }

  // Navigate to cluster on back/forward
  window.addEventListener('popstate', () => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id && graphNodes[id] && id !== currentRootId) {
      loadClusterById(id);
    } else if (!id) {
      shuffle();
    }
  });

  // Wire share button
  document.getElementById('share-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href);
    const btn = document.getElementById('share-btn');
    const label = btn.querySelector('.share-label');
    btn.classList.add('copied');
    label.textContent = 'copied!';
    setTimeout(() => { btn.classList.remove('copied'); label.textContent = 'Share'; }, 1500);
  });

  // Wire mobile shuffle button
  document.getElementById('mobile-shuffle-btn').addEventListener('click', shuffle);

  // Wire help modal
  const helpOverlay = document.getElementById('help-overlay');
  document.getElementById('help-btn').addEventListener('click', () => helpOverlay.classList.add('open'));
  const mobileHelpBtn = document.getElementById('mobile-help-btn');
  const mobileHelpPanel = document.getElementById('mobile-help-panel');
  mobileHelpBtn.addEventListener('click', () => {
    const isOpen = mobileHelpPanel.classList.toggle('visible');
    mobileHelpBtn.textContent = isOpen ? '×' : '?';
    mobileHelpBtn.classList.toggle('open', isOpen);
  });
  helpOverlay.addEventListener('click', (e) => { if (e.target === helpOverlay) helpOverlay.classList.remove('open'); });
  helpOverlay.querySelector('.help-close').addEventListener('click', () => helpOverlay.classList.remove('open'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') helpOverlay.classList.remove('open'); });

  // Wire theme toggle
  const themeBtn = document.getElementById('theme-toggle');
  const savedTheme = localStorage.getItem('b2b-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const startNight = savedTheme ? savedTheme === 'night' : prefersDark;
  function applyTheme(isNight) {
    document.body.classList.toggle('night', isNight);
    document.documentElement.classList.toggle('night', isNight);
    themeBtn.querySelector('.theme-label').textContent = isNight ? 'day' : 'night';
    themeBtn.querySelectorAll('.sun-icon').forEach(el => el.style.display = isNight ? 'none' : '');
    themeBtn.querySelector('.moon-icon').style.display = isNight ? '' : 'none';
  }
  if (startNight) applyTheme(true);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (localStorage.getItem('b2b-theme')) return;
    applyTheme(e.matches);
  });
  themeBtn.addEventListener('click', () => {
    const isNight = !document.body.classList.contains('night');
    applyTheme(isNight);
    localStorage.setItem('b2b-theme', isNight ? 'night' : 'day');
  });

  // ── Crates → Tracks fly-out transition ──
  function transitionToTracks(seedKey, stackEl) {
    const cluster = selectCluster(seedKey);
    const cratesView = document.getElementById('crates-view');
    const tracksView = document.getElementById('tracks-view');

    if (isMobileView()) {
      document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
      document.querySelector('.mode-tab[data-mode="tracks"]').classList.add('active');
      document.body.classList.remove('crates-mode');
      tracksView.classList.remove('hidden');
      cratesView.classList.add('hidden');
      showClusterMobile(cluster);
      return;
    }

    // Fade out all other crate stacks, keep clicked one visible
    const allStacks = cratesView.querySelectorAll('.crate-stack');
    allStacks.forEach(s => { if (s !== stackEl) s.classList.add('fade-out'); });

    // Capture stack position before anything moves
    const stackRect = stackEl.getBoundingClientRect();
    const srcX = stackRect.left + stackRect.width / 2;
    const srcY = stackRect.top + stackRect.height / 2;

    // Brief pause for other stacks to vanish, then begin fly-out
    setTimeout(() => {
    // Fade out crates
    cratesView.classList.add('fading');

    // Show tracks view (but cards will be hidden)
    tracksView.classList.remove('hidden');
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.mode-tab[data-mode="tracks"]').classList.add('active');

    const graphContainer = document.getElementById('graph-container');

    // Build cluster using normal showCluster (renders cards, layouts, zoom-to-fit)
    showCluster(cluster);

    // Kill the CSS transition AFTER showCluster (so clearGraph can't undo it),
    // then re-apply the current transform instantly so positions are final
    graphContainer.style.transition = 'none';
    const currentTransform = graphContainer.style.transform;
    graphContainer.style.transform = 'none';
    graphContainer.offsetHeight; // force reflow
    graphContainer.style.transform = currentTransform;
    graphContainer.offsetHeight; // force reflow at final scale

    // Immediately hide all cards and suppress their fadeInUp
    const allCards = document.querySelectorAll('#nodes-layer .node-card');
    allCards.forEach(card => card.classList.add('fly-hidden'));

    // Suppress connection animations
    const allPaths = document.querySelectorAll('#connections-layer .connection-path');
    allPaths.forEach(p => p.classList.add('fly-waiting'));

    // Create flyers: divs that morph from bare image → card shape
    const flyingEls = [];
    requestAnimationFrame(() => {
      nodes.forEach((n, idx) => {
        const card = document.querySelector(`.node-card[data-node-id="${n.id}"]`);
        if (!card) return;
        const cardRect = card.getBoundingClientRect();
        const artWrap = card.querySelector('.art-wrap');
        const artRect = artWrap ? artWrap.getBoundingClientRect() : null;
        const hasArt = artWrap && n.artUrl;

        const startSize = Math.min(stackRect.width, stackRect.height) * 0.4;

        // Wrapper div — starts as small shape at stack center, morphs to card-sized
        const fly = document.createElement('div');
        fly.className = 'flying-art';
        fly.style.width = startSize + 'px';
        fly.style.height = startSize + 'px';
        fly.style.left = (srcX - startSize / 2) + 'px';
        fly.style.top = (srcY - startSize / 2) + 'px';
        fly.style.opacity = hasArt ? '' : '0.6';
        const delay = n.rank === 'root' ? 0 : n.rank === '1' ? 0.05 : 0.12;
        fly.style.transitionDelay = `${delay + idx * 0.02}s`;

        let img = null;
        if (hasArt) {
          // Image inside — starts filling wrapper, shrinks to art area within card
          img = document.createElement('img');
          img.src = n.artUrl;
          img.style.width = startSize + 'px';
          img.style.height = startSize + 'px';
          img.style.transitionDelay = `${delay + idx * 0.02}s`;
          fly.appendChild(img);
        }

        document.body.appendChild(fly);
        flyingEls.push({
          el: fly, img,
          cardRect, artRect,
        });
      });

      // Trigger morph: image → card shape
      requestAnimationFrame(() => {
        flyingEls.forEach(f => {
          // Wrapper grows to card size with card styling
          f.el.style.width = f.cardRect.width + 'px';
          f.el.style.height = f.cardRect.height + 'px';
          f.el.style.left = f.cardRect.left + 'px';
          f.el.style.top = f.cardRect.top + 'px';
          f.el.style.opacity = '1';
          f.el.style.background = 'var(--card-bg)';
          f.el.style.border = '1px solid var(--card-border)';
          f.el.style.borderRadius = 'var(--card-radius)';
          f.el.style.boxShadow = 'var(--card-shadow)';

          // Image settles into art position within the card
          if (f.img && f.artRect) {
            const artOffX = f.artRect.left - f.cardRect.left;
            const artOffY = f.artRect.top - f.cardRect.top;
            f.img.style.left = artOffX + 'px';
            f.img.style.top = artOffY + 'px';
            f.img.style.width = f.artRect.width + 'px';
            f.img.style.height = f.artRect.height + 'px';
            f.img.style.borderRadius = 'var(--art-radius)';
          }
        });
      });
    });

    // After morph lands (~800ms): reveal cards with text hidden, remove flyers, fade text in
    setTimeout(() => {
      // Show cards with text hidden, remove flyers
      allCards.forEach(card => {
        card.style.animation = 'none';
        card.style.opacity = '1';
        card.classList.remove('fly-hidden');
        card.classList.add('fly-text-hidden');
        card.classList.add('settled');
      });
      flyingEls.forEach(f => f.el.remove());

      // Fade text in
      requestAnimationFrame(() => {
        allCards.forEach(card => card.classList.remove('fly-text-hidden'));
      });

      // Draw connections after text starts appearing
      setTimeout(() => {
        allPaths.forEach((path, i) => {
          path.classList.remove('fly-waiting');
          path.style.opacity = '';
          const len = path.getTotalLength();
          path.style.strokeDasharray = len;
          path.style.strokeDashoffset = len;
          path.style.animation = `drawLine 1s ease forwards`;
          path.style.animationDelay = `${i * 0.03}s`;
        });
      }, 150);

      // Restore graph-container transition, hide crates
      graphContainer.style.transition = '';
      cratesView.classList.add('hidden');
      cratesView.classList.remove('fading');
      allStacks.forEach(s => s.classList.remove('fade-out'));
    }, 800);
    }, 150); // end setTimeout for fade-out pause
  }

  // ── Crates view (infinite canvas) ──
  let cratesInitialized = false;

  function cratesTreemap(items, x, y, w, h) {
    if (items.length === 0) return [];
    if (items.length === 1) { items[0].rect = { x, y, w, h }; return items; }
    const total = items.reduce((s, it) => s + it.weight, 0);
    const sorted = [...items].sort((a, b) => b.weight - a.weight);
    let bestDiff = Infinity, splitIdx = 1, runSum = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      runSum += sorted[i].weight;
      const diff = Math.abs(runSum - (total - runSum));
      if (diff < bestDiff) { bestDiff = diff; splitIdx = i + 1; }
    }
    const left = sorted.slice(0, splitIdx);
    const right = sorted.slice(splitIdx);
    const ratio = left.reduce((s, it) => s + it.weight, 0) / total;
    if (w >= h) {
      const sw = w * ratio;
      cratesTreemap(left, x, y, sw, h);
      cratesTreemap(right, x + sw, y, w - sw, h);
    } else {
      const sh = h * ratio;
      cratesTreemap(left, x, y, w, sh);
      cratesTreemap(right, x, y + sh, w, h - sh);
    }
    return sorted;
  }

  function cratesBfs(startKey, maxNodes) {
    const visited = new Set();
    const queue = [startKey];
    visited.add(startKey);
    while (queue.length && visited.size < maxNodes) {
      const key = queue.shift();
      const node = graphNodes[key];
      if (!node || !node.edges) continue;
      for (const edge of node.edges) {
        if (visited.size >= maxNodes) break;
        if (!visited.has(edge.node) && graphNodes[edge.node]) {
          visited.add(edge.node);
          queue.push(edge.node);
        }
      }
    }
    return [...visited];
  }

  function initCrates() {
    if (cratesInitialized) return;
    cratesInitialized = true;

    const cap = s => s.replace(/\b\w/g, c => c.toUpperCase());
    const gap = 25, pad = 0, STEP = 3;
    const CLUSTERS_PER_PAGE = isMobileView() ? 10 : 20;

    const cratesView = document.getElementById('crates-view');
    const surface = document.getElementById('crates-surface');
    const vw = cratesView.clientWidth || window.innerWidth;
    const vh = cratesView.clientHeight || (window.innerHeight - 60);

    // Seeded random — random each session (testing)
    let crateSeed = Date.now() % 2147483647 || 1;
    function crateRand() {
      crateSeed = (crateSeed * 16807) % 2147483647;
      return (crateSeed - 1) / 2147483646;
    }

    // Build shuffled seed pool (nodes with 4+ edges)
    const allKeys = Object.keys(graphNodes);
    const seedPool = allKeys.filter(k => graphNodes[k].edges && graphNodes[k].edges.length >= 4);
    for (let i = seedPool.length - 1; i > 0; i--) {
      const j = Math.floor(crateRand() * (i + 1));
      [seedPool[i], seedPool[j]] = [seedPool[j], seedPool[i]];
    }
    let seedIdx = 0;
    const usedNodes = new Set();

    // Page grid: each page is viewport-sized, keyed by "col,row"
    const pages = {};       // "col,row" -> { clusters, el, stacks, artLoaded }

    // Canvas bounds (grow dynamically)
    let minCol = 0, maxCol = 0, minRow = 0, maxRow = 0;

    // Estimate how many nodes selectCluster will produce for a seed
    function estimateClusterSize(seedKey) {
      const root = graphNodes[seedKey];
      if (!root || !root.edges) return 1;
      const used = new Set([seedKey]);
      const r1Ids = root.edges.map(e => e.node).filter(id => id in graphNodes && !used.has(id));
      r1Ids.forEach(id => used.add(id));
      let total = 1 + r1Ids.length; // root + R1
      for (const r1Id of r1Ids) {
        const r1Node = graphNodes[r1Id];
        if (!r1Node || !r1Node.edges) continue;
        const r2 = r1Node.edges.map(e => e.node).filter(id => id in graphNodes && !used.has(id));
        const r2Count = Math.min(2, r2.length);
        total += r2Count;
        for (let i = 0; i < r2Count; i++) used.add(r2[i]);
      }
      return total;
    }

    function generateClusters(count) {
      const clusters = [];
      while (clusters.length < count && seedIdx < seedPool.length) {
        const seedKey = seedPool[seedIdx++];
        if (usedNodes.has(seedKey)) continue;
        const size = 15 + Math.floor(crateRand() * 40);
        const members = cratesBfs(seedKey, size);
        const overlap = members.filter(m => usedNodes.has(m)).length;
        if (overlap > members.length * 0.3) continue;
        members.forEach(m => usedNodes.add(m));

        const artworks = [], artKeys = [];
        for (const key of members) {
          const cached = audioCache[key];
          if (cached && cached.artUrl) { artworks.push(cached.artUrl); artKeys.push(key); }
        }
        const [artist, title] = seedKey.split(':::');
        const displayCount = estimateClusterSize(seedKey);
        clusters.push({
          seedKey, label: artist || 'unknown',
          title: title || '', artist: artist || '',
          count: displayCount, artworks, artKeys,
          memberKeys: members, weight: members.length,
        });
      }
      return clusters;
    }

    function renderStack(item, pageOffsetX, pageOffsetY) {
      const r = item.rect;
      const x = pageOffsetX + r.x + gap / 2;
      const y = pageOffsetY + r.y + gap / 2;
      const w = r.w - gap, h = r.h - gap;
      if (w < 20 || h < 20) return null;
      const numCards = Math.min(item.count, 6);
      const pileOffset = (numCards - 1) * STEP;
      const cardW = w - pileOffset, cardH = h - pileOffset;

      const el = document.createElement('div');
      el.className = 'crate-stack';
      el.style.left = x + 'px'; el.style.top = y + 'px';
      el.style.width = w + 'px'; el.style.height = h + 'px';

      const artKeys = item.artKeys || [];
      // If seed has no art, promote a member with art to the top
      const seedCached = audioCache[item.seedKey];
      const seedHasArt = seedCached && seedCached.artUrl;
      const topKey = seedHasArt ? item.seedKey
        : artKeys.length > 0 ? artKeys[0] : item.seedKey;
      for (let i = 0; i < numCards; i++) {
        const card = document.createElement('div');
        card.className = 'crate-card placeholder';
        if (i === numCards - 1) card.classList.add('active');
        const offset = i * STEP;
        card.style.left = offset + 'px'; card.style.top = offset + 'px';
        card.style.width = cardW + 'px'; card.style.height = cardH + 'px';
        card.style.zIndex = i;

        // Start as placeholder — artwork loads after
        const base = 148 + Math.floor(crateRand() * 40) - 20;
        card.style.background = `rgb(${base}, ${base - 4}, ${base - 8})`;

        // Top card shows seed track; others cycle through remaining members
        const otherKeys = artKeys.filter(k => k !== topKey);
        const mKey = (i === numCards - 1) ? topKey
          : otherKeys.length > 0 ? otherKeys[i % otherKeys.length] : null;
        const mNode = mKey && graphNodes[mKey];
        const info = document.createElement('div');
        info.className = 'crate-info';
        info.innerHTML = `
          <div class="ci-title">${cap(mNode ? mNode.title : item.title)}</div>
          <div class="ci-artist">${cap(mNode ? mNode.artist : item.artist)}</div>
          <div class="ci-count">${item.count} tracks</div>
        `;
        card.appendChild(info);
        el.appendChild(card);
      }

      // Click → fly-out transition to Tracks view
      el.addEventListener('click', () => {
        transitionToTracks(item.seedKey, el);
      });

      return el;
    }

    // Track last known mouse position from outside any stack
    let lastOuterX = 0, lastOuterY = 0;
    document.getElementById('crates-view').addEventListener('mousemove', e => {
      // Only update if target is NOT inside a crate-stack
      if (!e.target.closest('.crate-stack')) {
        lastOuterX = e.clientX;
        lastOuterY = e.clientY;
      }
    });

    function attachHover(stack) {
      const cards = [...stack.querySelectorAll('.crate-card')];
      const numCards = cards.length;
      let activeIdx = numCards - 1, lastX = 0, lastY = 0, accum = 0, enterTime = 0;
      const threshold = 30;
      const deadZone = 150;
      function applyActive() {
        cards.forEach((card, i) => {
          card.classList.toggle('active', i === activeIdx);
          card.style.zIndex = i === activeIdx ? numCards + 1 : i;
        });
      }
      stack.addEventListener('mouseenter', e => {
        // Direction from last position outside any stack
        const dx = e.clientX - lastOuterX;
        const dy = e.clientY - lastOuterY;
        // Moving right/down → entering from left/top → back of stack
        const fromBack = (dx + dy) > 0;
        activeIdx = fromBack ? 0 : numCards - 1;
        accum = 0; lastX = e.clientX; lastY = e.clientY;
        enterTime = Date.now();
        applyActive(); surface.classList.add('has-hover'); stack.classList.add('hovered');
      });
      stack.addEventListener('mousemove', e => {
        if (Date.now() - enterTime < deadZone) { lastX = e.clientX; lastY = e.clientY; return; }
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        accum += (dx + dy);
        if (accum > threshold && activeIdx < numCards - 1) { activeIdx++; accum = 0; applyActive(); }
        else if (accum < -threshold && activeIdx > 0) { activeIdx--; accum = 0; applyActive(); }
        accum = Math.max(-threshold, Math.min(threshold, accum));
      });
      stack.addEventListener('mouseleave', () => {
        activeIdx = numCards - 1; accum = 0; applyActive();
        surface.classList.remove('has-hover'); stack.classList.remove('hovered');
      });
    }

    // Build a page: generate data, create placeholder DOM, add to surface permanently
    function buildPage(col, row) {
      const key = `${col},${row}`;
      if (pages[key]) return pages[key];
      const clusters = generateClusters(CLUSTERS_PER_PAGE);
      if (clusters.length === 0) return null;
      const items = clusters.map((c, i) => ({ ...c, idx: i }));
      cratesTreemap(items, pad, pad, vw - pad * 2, vh - pad * 2);
      minCol = Math.min(minCol, col);
      maxCol = Math.max(maxCol, col);
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);

      // Create DOM (placeholders) and append permanently
      const pageOffsetX = col * vw;
      const pageOffsetY = row * vh;
      const container = document.createElement('div');
      container.className = 'crate-page';

      const stacks = [];
      items.forEach(item => {
        const stackEl = renderStack(item, pageOffsetX, pageOffsetY);
        if (stackEl) {
          container.appendChild(stackEl);
          stacks.push({ el: stackEl, item });
          if (!isMobileView()) attachHover(stackEl);
        }
      });
      surface.appendChild(container);

      const page = { clusters: items, el: container, stacks, artLoaded: false };
      pages[key] = page;
      return page;
    }

    // Load artwork images into a page's stacks
    function loadPageArt(page) {
      if (page.artLoaded) return;
      page.artLoaded = true;
      page.stacks.forEach(({ el: stackEl, item }) => {
        const cards = stackEl.querySelectorAll('.crate-card');
        const last = cards.length - 1;
        cards.forEach((card, i) => {
          // Top card uses best available artwork; others cycle
          const seedCached = audioCache[item.seedKey];
          const seedHasArt = seedCached && seedCached.artUrl;
          const topUrl = seedHasArt ? seedCached.artUrl
            : item.artworks.length > 0 ? item.artworks[0] : null;
          const otherArt = item.artworks.filter(u => u !== topUrl);
          const url = (i === last) ? topUrl
            : otherArt.length > 0 ? otherArt[i % otherArt.length] : null;
          if (url) {
            const img = document.createElement('img');
            img.src = url.replace('-t500x500', '-t120x120');
            img.loading = 'lazy'; img.draggable = false;
            img.onload = () => {
              card.style.background = '';
              card.classList.remove('placeholder');
            };
            card.insertBefore(img, card.firstChild);
          }
        });
      });
    }

    // Strip artwork images from a page to free memory
    function unloadPageArt(page) {
      if (!page.artLoaded) return;
      page.artLoaded = false;
      page.stacks.forEach(({ el: stackEl, item }) => {
        const cards = stackEl.querySelectorAll('.crate-card');
        cards.forEach((card, i) => {
          const img = card.querySelector('img');
          if (img) img.remove();
          const base = 148 + ((i * 17 + 3) % 40) - 20;
          card.style.background = `rgb(${base}, ${base - 4}, ${base - 8})`;
          card.classList.add('placeholder');
        });
      });
    }

    function updateVisible() {
      // Viewport in canvas coords (account for scale)
      const viewL = -panX;
      const viewT = -panY;
      const viewR = viewL + vw / crateScale;
      const viewB = viewT + vh / crateScale;

      // Pages to build (visible + 1 buffer for placeholders)
      const colMin = Math.floor(viewL / vw) - 1;
      const colMax = Math.floor(viewR / vw) + 1;
      const rowMin = Math.floor(viewT / vh) - 1;
      const rowMax = Math.floor(viewB / vh) + 1;

      // Build placeholder DOM for all nearby pages
      for (let c = colMin; c <= colMax; c++) {
        for (let r = rowMin; r <= rowMax; r++) {
          buildPage(c, r);
        }
      }

      // Load artwork only for pages overlapping the viewport
      const colVis0 = Math.floor(viewL / vw);
      const colVis1 = Math.floor(viewR / vw);
      const rowVis0 = Math.floor(viewT / vh);
      const rowVis1 = Math.floor(viewB / vh);

      for (const [key, page] of Object.entries(pages)) {
        const [c, r] = key.split(',').map(Number);
        const near = c >= colVis0 - 1 && c <= colVis1 + 1 && r >= rowVis0 - 1 && r <= rowVis1 + 1;
        if (near) {
          loadPageArt(page);
        } else if (c < colMin - 2 || c > colMax + 2 || r < rowMin - 2 || r > rowMax + 2) {
          unloadPageArt(page);
        }
      }
    }

    // Pan state
    let crateScale = isMobileView() ? 0.75 : 0.8;
    let panX = 0, panY = 0;
    surface.style.transform = `scale(${crateScale}) translate(${panX}px, ${panY}px)`;

    // Drag-to-pan
    let isDragging = false, didDrag = false, dragStartX, dragStartY, panStartX, panStartY;
    const DRAG_THRESHOLD = 5;
    cratesView.onmousedown = e => {
      isDragging = true; didDrag = false;
      dragStartX = e.clientX; dragStartY = e.clientY;
      panStartX = panX; panStartY = panY;
    };
    cratesView.onmousemove = e => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
      if (!didDrag && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        didDrag = true;
        cratesView.classList.add('dragging');
      }
      if (didDrag) {
        panX = panStartX + dx; panY = panStartY + dy;
        surface.style.transform = `scale(${crateScale}) translate(${panX}px, ${panY}px)`;
        updateVisible();
      }
    };
    cratesView.onmouseup = () => {
      isDragging = false;
      cratesView.classList.remove('dragging');
    };
    cratesView.addEventListener('click', e => {
      if (didDrag) { e.stopPropagation(); didDrag = false; }
    }, true);
    cratesView.onwheel = e => {
      e.preventDefault();
      panX -= e.deltaX; panY -= e.deltaY;
      surface.style.transform = `scale(${crateScale}) translate(${panX}px, ${panY}px)`;
      updateVisible();
    };

    // Touch pan + pinch-to-zoom (mobile)
    let touchDragging = false, touchDidDrag = false;
    let touchStartX, touchStartY, touchPanStartX, touchPanStartY;
    let pinchActive = false, lastPinchDist = 0, pinchStartScale = 0;

    function applyTransform() {
      surface.style.transform = `scale(${crateScale}) translate(${panX}px, ${panY}px)`;
    }

    cratesView.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        pinchActive = true;
        touchDragging = false;
        pinchStartScale = crateScale;
        lastPinchDist = Math.hypot(
          e.touches[1].clientX - e.touches[0].clientX,
          e.touches[1].clientY - e.touches[0].clientY
        );
      } else if (e.touches.length === 1 && !pinchActive) {
        touchDragging = true;
        touchDidDrag = false;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchPanStartX = panX;
        touchPanStartY = panY;
      }
    }, { passive: true });

    cratesView.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 2 && pinchActive) {
        const dist = Math.hypot(
          e.touches[1].clientX - e.touches[0].clientX,
          e.touches[1].clientY - e.touches[0].clientY
        );
        crateScale = Math.max(0.2, Math.min(2, pinchStartScale * (dist / lastPinchDist)));
        applyTransform();
        updateVisible();
      } else if (e.touches.length === 1 && touchDragging) {
        const dx = e.touches[0].clientX - touchStartX;
        const dy = e.touches[0].clientY - touchStartY;
        if (!touchDidDrag && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
          touchDidDrag = true;
          cratesView.classList.add('dragging');
        }
        if (touchDidDrag) {
          panX = touchPanStartX + dx;
          panY = touchPanStartY + dy;
          applyTransform();
          updateVisible();
        }
      }
    }, { passive: false });

    cratesView.addEventListener('touchend', e => {
      if (e.touches.length < 2) pinchActive = false;
      if (e.touches.length === 0) {
        touchDragging = false;
        cratesView.classList.remove('dragging');
      }
    });

    // Suppress click after touch drag
    cratesView.addEventListener('click', e => {
      if (touchDidDrag) { e.stopPropagation(); touchDidDrag = false; }
    }, true);

    // Initial render: center page + neighbors
    buildPage(0, 0);
    updateVisible();
    console.log(`Crates: infinite canvas initialized (${seedPool.length} seeds available)`);
  }

  // Wire mode tabs
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const mode = tab.dataset.mode;
      document.getElementById('tracks-view').classList.toggle('hidden', mode !== 'tracks');
      document.getElementById('crates-view').classList.toggle('hidden', mode !== 'crates');
      document.body.classList.toggle('crates-mode', mode === 'crates');
      // Lazy init crates — defer so tab switch is instant
      if (mode === 'crates') {
        requestAnimationFrame(() => initCrates());
        showHelper(cratesHelperToast, 'b2b-crates-helper-dismissed');
      }
      // Hide the other mode's toast when switching
      if (mode === 'tracks') {
        cratesHelperToast.classList.remove('visible');
        // Prevent connection arrows from replaying draw animation
        document.querySelectorAll('.connection-path').forEach(p => {
          p.style.animation = 'none';
          p.style.strokeDasharray = 'none';
          p.style.strokeDashoffset = '0';
        });
      }
      if (mode === 'crates') tracksHelperToast.classList.remove('visible');
    });
  });

  // Helper toast logic
  const helpersCheckbox = document.getElementById('show-helpers');
  const tracksHelperToast = document.getElementById('tracks-helper-toast');
  const cratesHelperToast = document.getElementById('crates-helper-toast');
  helpersCheckbox.checked = false;

  function showHelper(toast, storageKey) {
    if (window.innerWidth < 768) return;
    if (!helpersCheckbox.checked && localStorage.getItem(storageKey)) return;
    toast.classList.add('visible');
  }

  function dismissHelper(toast, storageKey) {
    toast.classList.remove('visible');
    localStorage.setItem(storageKey, '1');
  }

  tracksHelperToast.querySelector('.toast-close').addEventListener('click', () => {
    dismissHelper(tracksHelperToast, 'b2b-tracks-helper-dismissed');
  });

  cratesHelperToast.querySelector('.toast-close').addEventListener('click', () => {
    dismissHelper(cratesHelperToast, 'b2b-crates-helper-dismissed');
  });

  helpersCheckbox.addEventListener('change', () => {
    if (helpersCheckbox.checked) {
      const isCrates = !document.getElementById('crates-view').classList.contains('hidden');
      if (isCrates) showHelper(cratesHelperToast, 'b2b-crates-helper-dismissed');
      else showHelper(tracksHelperToast, 'b2b-tracks-helper-dismissed');
    } else {
      tracksHelperToast.classList.remove('visible');
      cratesHelperToast.classList.remove('visible');
    }
  });

  // Show tracks helper on first load
  showHelper(tracksHelperToast, 'b2b-tracks-helper-dismissed');

  // Dev panel controls
  document.getElementById('freeze-btn').addEventListener('click', () => {
    frozen = !frozen;
    const btn = document.getElementById('freeze-btn');
    btn.textContent = frozen ? 'frozen' : 'freeze';
    btn.classList.toggle('frozen', frozen);
    const sBtn = document.getElementById('shuffle-btn');
    if (sBtn) { sBtn.style.opacity = frozen ? '0.3' : '1'; sBtn.style.pointerEvents = frozen ? 'none' : ''; }
  });

  document.getElementById('cluster-id').addEventListener('click', () => {
    if (currentRootId) navigator.clipboard.writeText(currentRootId);
  });

  document.getElementById('max-r1').addEventListener('change', (e) => {
    maxR1 = parseInt(e.target.value);
    if (currentRootId) shuffle();
  });
  document.getElementById('r2-per-r1').addEventListener('change', (e) => {
    r2PerR1 = parseInt(e.target.value);
    if (currentRootId) shuffle();
  });

  document.getElementById('cluster-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      loadClusterById(e.target.value);
      e.target.value = '';
    }
  });

  // Wire Mixcloud close button
  document.querySelector('#mc-player .mc-close').addEventListener('click', () => {
    stopCurrentPlayback();
  });

  // ── Artist search ──
  // Build index: artist name -> list of graph node IDs
  const artistIndex = {}; // { lowercase name -> { display, trackIds: [id, ...] } }
  for (const [id, node] of Object.entries(graphNodes)) {
    const artist = (node.artist || '').trim();
    if (!artist) continue;
    const key = artist.toLowerCase();
    if (!artistIndex[key]) artistIndex[key] = { display: artist, trackIds: [] };
    artistIndex[key].trackIds.push(id);
  }
  // Pre-sorted by track count for autocomplete
  const artistList = Object.values(artistIndex).sort((a, b) => b.trackIds.length - a.trackIds.length);
  const artistListAlpha = [...artistList].sort((a, b) => a.display.localeCompare(b.display));
  console.log(`Artist index: ${artistList.length} unique artists`);

  const searchInput = document.getElementById('artist-search');
  const clearBtn = document.getElementById('artist-clear');
  const acDropdown = document.getElementById('artist-autocomplete');
  let acItems = [];
  let acActiveIdx = -1;

  function closeAc() {
    acDropdown.classList.remove('open');
    acDropdown.innerHTML = '';
    acItems = [];
    acActiveIdx = -1;
  }

  function setArtistFilter(entry) {
    artistFilter = entry;
    searchInput.value = entry.display;
    searchInput.classList.add('filtered');
    // Immediately shuffle to one of this artist's tracks
    shuffle();
  }

  function clearArtistFilter() {
    artistFilter = null;
    searchInput.value = '';
    searchInput.classList.remove('filtered');
  }

  function showAc(query) {
    const q = query.toLowerCase().trim();

    let results;
    if (!q) {
      results = artistListAlpha.slice(0, 50);
    } else {
      const starts = [];
      const contains = [];
      for (const entry of artistListAlpha) {
        const name = entry.display.toLowerCase();
        if (name.startsWith(q)) starts.push(entry);
        else if (name.includes(q)) contains.push(entry);
        if (starts.length + contains.length >= 30) break;
      }
      results = [...starts, ...contains].slice(0, 30);
    }
    if (results.length === 0) { closeAc(); return; }

    acDropdown.innerHTML = '';
    acItems = [];
    acActiveIdx = -1;

    results.forEach((entry, i) => {
      const div = document.createElement('div');
      div.className = 'ac-item';
      const count = entry.trackIds.length;
      div.innerHTML = `<span class="ac-name">${escHtml(entry.display)}</span><span class="ac-count">${count} track${count !== 1 ? 's' : ''}</span>`;
      div.addEventListener('click', () => {
        closeAc();
        setArtistFilter(entry);
      });
      div.addEventListener('mouseenter', () => {
        acItems.forEach(el => el.classList.remove('active'));
        div.classList.add('active');
        acActiveIdx = i;
      });
      acDropdown.appendChild(div);
      acItems.push(div);
    });

    acDropdown.classList.add('open');
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  searchInput.addEventListener('input', () => {
    if (artistFilter && searchInput.value !== artistFilter.display) {
      artistFilter = null;
      searchInput.classList.remove('filtered');
    }
    showAc(searchInput.value);
  });

  searchInput.addEventListener('focus', () => {
    if (!artistFilter) showAc(searchInput.value);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (!acDropdown.classList.contains('open')) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      acActiveIdx = Math.min(acActiveIdx + 1, acItems.length - 1);
      acItems.forEach((el, i) => el.classList.toggle('active', i === acActiveIdx));
      acItems[acActiveIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      acActiveIdx = Math.max(acActiveIdx - 1, 0);
      acItems.forEach((el, i) => el.classList.toggle('active', i === acActiveIdx));
      acItems[acActiveIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (acActiveIdx >= 0 && acActiveIdx < acItems.length) {
        acItems[acActiveIdx].click();
      }
    } else if (e.key === 'Escape') {
      closeAc();
      searchInput.blur();
    }
  });

  clearBtn.addEventListener('click', () => {
    clearArtistFilter();
    closeAc();
  });

  // Close autocomplete when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#artist-search-wrap')) {
      closeAc();
    }
    if (!e.target.closest('#dj-search-wrap')) {
      closeDjAc();
    }
    if (!e.target.closest('#search-btn-wrap')) {
      searchWrap.classList.remove('open');
      closeTbAc();
      searchWrap.classList.toggle('active', !!(artistFilter || djFilter));
    }
  });

  // ── Toolbar artist search (popover) ──
  // search-btn removed — input expands inline
  // searchPopover removed — using inline expanding search
  const tbSearchInput = document.getElementById('toolbar-artist-search');
  const tbClearBtn = document.getElementById('toolbar-artist-clear');
  const tbAcDropdown = document.getElementById('toolbar-artist-ac');
  let tbAcItems = [], tbAcActiveIdx = -1;

  const activeSearchFilter = () => artistFilter || djFilter;
  let djListAlpha = []; // populated after DJ index is built

  const searchWrap = document.getElementById('search-btn-wrap');
  tbSearchInput.addEventListener('focus', () => {
    searchWrap.classList.add('open');
    if (!activeSearchFilter()) showTbAc(tbSearchInput.value);
  });

  function closeTbAc() {
    tbAcDropdown.classList.remove('open');
    tbAcDropdown.innerHTML = '';
    tbAcItems = [];
    tbAcActiveIdx = -1;
  }

  function searchIndex(list, q, max) {
    if (!q) return list.slice(0, max);
    const starts = [], contains = [];
    for (const entry of list) {
      const name = entry.display.toLowerCase();
      if (name.startsWith(q)) starts.push(entry);
      else if (name.includes(q)) contains.push(entry);
      if (starts.length + contains.length >= max) break;
    }
    return [...starts, ...contains].slice(0, max);
  }

  function showTbAc(query) {
    const q = query.toLowerCase().trim();
    const artistResults = searchIndex(artistListAlpha, q, q ? 15 : 30);
    const djResults = searchIndex(djListAlpha, q, q ? 15 : 20);
    if (artistResults.length === 0 && djResults.length === 0) { closeTbAc(); return; }

    tbAcDropdown.innerHTML = '';
    tbAcItems = [];
    tbAcActiveIdx = -1;
    let idx = 0;

    function addSection(label, results, type) {
      if (results.length === 0) return;
      const header = document.createElement('div');
      header.className = 'ac-section-header';
      header.textContent = label;
      tbAcDropdown.appendChild(header);
      results.forEach(entry => {
        const div = document.createElement('div');
        div.className = 'ac-item';
        const count = entry.trackIds.length;
        const countLabel = type === 'dj' ? `${count} track${count !== 1 ? 's' : ''} mixed` : `${count} track${count !== 1 ? 's' : ''}`;
        div.innerHTML = `<span class="ac-name">${escHtml(entry.display)}</span><span class="ac-count">${countLabel}</span>`;
        const myIdx = idx++;
        div.addEventListener('click', () => {
          closeTbAc();
          if (type === 'artist') {
            clearDjFilter();
            setArtistFilter(entry);
          } else {
            clearArtistFilter();
            setDjFilter(entry);
          }
          tbSearchInput.value = entry.display;
          tbSearchInput.classList.add('filtered');
          searchWrap.classList.add('active');
        });
        div.addEventListener('mouseenter', () => {
          tbAcItems.forEach(el => el.classList.remove('active'));
          div.classList.add('active');
          tbAcActiveIdx = myIdx;
        });
        tbAcDropdown.appendChild(div);
        tbAcItems.push(div);
      });
    }

    addSection('Artists', artistResults, 'artist');
    addSection('DJs', djResults, 'dj');
    tbAcDropdown.classList.add('open');
  }

  tbSearchInput.addEventListener('input', () => {
    const active = activeSearchFilter();
    if (active && tbSearchInput.value !== active.display) {
      clearArtistFilter();
      clearDjFilter();
      tbSearchInput.classList.remove('filtered');
      searchWrap.classList.remove('active');
    }
    showTbAc(tbSearchInput.value);
  });
  tbSearchInput.addEventListener('keydown', (e) => {
    if (!tbAcDropdown.classList.contains('open')) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      tbAcActiveIdx = Math.min(tbAcActiveIdx + 1, tbAcItems.length - 1);
      tbAcItems.forEach((el, i) => el.classList.toggle('active', i === tbAcActiveIdx));
      tbAcItems[tbAcActiveIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      tbAcActiveIdx = Math.max(tbAcActiveIdx - 1, 0);
      tbAcItems.forEach((el, i) => el.classList.toggle('active', i === tbAcActiveIdx));
      tbAcItems[tbAcActiveIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (tbAcActiveIdx >= 0 && tbAcActiveIdx < tbAcItems.length) tbAcItems[tbAcActiveIdx].click();
    } else if (e.key === 'Escape') {
      closeTbAc();
      searchWrap.classList.remove('open');
    }
  });
  tbClearBtn.addEventListener('click', () => {
    clearArtistFilter();
    clearDjFilter();
    tbSearchInput.value = '';
    tbSearchInput.classList.remove('filtered');
    searchWrap.classList.remove('active');
    closeTbAc();
    shuffle();
  });

  // ── Mobile search ──
  const mobileSearchInput = document.getElementById('mobile-search-input');
  const mobileSearchClear = document.getElementById('mobile-search-clear');
  const mobileSearchAc = document.getElementById('mobile-search-ac');
  let mobileAcItems = [], mobileAcActiveIdx = -1;

  function closeMobileAc() {
    mobileSearchAc.classList.remove('open');
    mobileSearchAc.innerHTML = '';
    mobileAcItems = [];
    mobileAcActiveIdx = -1;
  }

  function showMobileAc(query) {
    const q = query.toLowerCase().trim();
    const artistResults = searchIndex(artistListAlpha, q, q ? 15 : 30);
    const djResults = searchIndex(djListAlpha, q, q ? 15 : 20);
    if (artistResults.length === 0 && djResults.length === 0) { closeMobileAc(); return; }
    mobileSearchAc.innerHTML = '';
    mobileAcItems = [];
    mobileAcActiveIdx = -1;
    let idx = 0;
    function addSection(label, results, type) {
      if (results.length === 0) return;
      const header = document.createElement('div');
      header.className = 'ac-section-header';
      header.textContent = label;
      mobileSearchAc.appendChild(header);
      results.forEach(entry => {
        const div = document.createElement('div');
        div.className = 'ac-item';
        const count = entry.trackIds.length;
        const countLabel = type === 'dj' ? `${count} track${count !== 1 ? 's' : ''} mixed` : `${count} track${count !== 1 ? 's' : ''}`;
        div.innerHTML = `<span class="ac-name">${escHtml(entry.display)}</span><span class="ac-count">${countLabel}</span>`;
        const myIdx = idx++;
        div.addEventListener('click', () => {
          closeMobileAc();
          if (type === 'artist') { clearDjFilter(); setArtistFilter(entry); }
          else { clearArtistFilter(); setDjFilter(entry); }
          mobileSearchInput.value = entry.display;
          mobileSearchInput.classList.add('filtered');
          mobileSearchInput.blur();
          mobileSearchWrap.classList.remove('open');
        });
        mobileSearchAc.appendChild(div);
        mobileAcItems.push(div);
      });
    }
    addSection('Artists', artistResults, 'artist');
    addSection('DJs', djResults, 'dj');
    mobileSearchAc.classList.add('open');
  }

  const mobileSearchWrap = document.getElementById('mobile-search-wrap');
  mobileSearchInput.addEventListener('focus', () => {
    mobileSearchWrap.classList.add('open');
    if (!activeSearchFilter()) showMobileAc(mobileSearchInput.value);
  });
  mobileSearchInput.addEventListener('input', () => {
    const active = activeSearchFilter();
    if (active && mobileSearchInput.value !== active.display) {
      clearArtistFilter();
      clearDjFilter();
      mobileSearchInput.classList.remove('filtered');
    }
    showMobileAc(mobileSearchInput.value);
  });
  mobileSearchInput.addEventListener('keydown', (e) => {
    if (!mobileSearchAc.classList.contains('open')) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mobileAcActiveIdx = Math.min(mobileAcActiveIdx + 1, mobileAcItems.length - 1);
      mobileAcItems.forEach((el, i) => el.classList.toggle('active', i === mobileAcActiveIdx));
      mobileAcItems[mobileAcActiveIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      mobileAcActiveIdx = Math.max(mobileAcActiveIdx - 1, 0);
      mobileAcItems.forEach((el, i) => el.classList.toggle('active', i === mobileAcActiveIdx));
      mobileAcItems[mobileAcActiveIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (mobileAcActiveIdx >= 0) mobileAcItems[mobileAcActiveIdx].click();
    } else if (e.key === 'Escape') {
      closeMobileAc();
      mobileSearchInput.blur();
    }
  });
  mobileSearchClear.addEventListener('click', () => {
    clearArtistFilter();
    clearDjFilter();
    mobileSearchInput.value = '';
    mobileSearchInput.classList.remove('filtered');
    closeMobileAc();
    shuffle();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#mobile-search-wrap')) {
      closeMobileAc();
      mobileSearchWrap.classList.remove('open');
    }
  });

  // ── DJ search ──
  // Build index: DJ name -> list of track node IDs they played
  // Uses djNameMap to extract clean DJ names from show titles
  const djIndex = {}; // { lowercase name -> { display, trackIds: Set } }
  for (const [id, node] of Object.entries(graphNodes)) {
    for (const edge of (node.edges || [])) {
      for (const ctx of (edge.contexts || [])) {
        const rawDj = (ctx.dj || '').trim();
        if (!rawDj) continue;
        const names = djNameMap[rawDj] || [rawDj];
        for (const name of names) {
          const key = name.toLowerCase();
          if (!djIndex[key]) djIndex[key] = { display: name, trackIds: new Set() };
          djIndex[key].trackIds.add(id);
          djIndex[key].trackIds.add(edge.node);
        }
      }
    }
  }
  // Convert Sets to arrays, sort by track count
  const djList = Object.values(djIndex).map(e => ({ display: e.display, trackIds: [...e.trackIds] }))
    .sort((a, b) => b.trackIds.length - a.trackIds.length);
  console.log(`DJ index: ${djList.length} unique DJs`);
  djListAlpha = [...djList].sort((a, b) => a.display.localeCompare(b.display));

  const djSearchInput = document.getElementById('dj-search');
  const djClearBtn = document.getElementById('dj-clear');
  const djAcDropdown = document.getElementById('dj-autocomplete');
  let djAcItems = [];
  let djAcActiveIdx = -1;

  function closeDjAc() {
    djAcDropdown.classList.remove('open');
    djAcDropdown.innerHTML = '';
    djAcItems = [];
    djAcActiveIdx = -1;
  }

  function setDjFilter(entry) {
    djFilter = entry;
    djSearchInput.value = entry.display;
    djSearchInput.classList.add('filtered');
    shuffle();
  }

  function clearDjFilter() {
    djFilter = null;
    djSearchInput.value = '';
    djSearchInput.classList.remove('filtered');
  }

  function showDjAc(query) {
    const q = query.toLowerCase().trim();

    let results;
    if (!q) {
      results = djList.slice(0, 50);
    } else {
      const starts = [];
      const contains = [];
      for (const entry of djList) {
        const name = entry.display.toLowerCase();
        if (name.startsWith(q)) starts.push(entry);
        else if (name.includes(q)) contains.push(entry);
        if (starts.length + contains.length >= 30) break;
      }
      results = [...starts, ...contains].slice(0, 30);
    }
    if (results.length === 0) { closeDjAc(); return; }

    djAcDropdown.innerHTML = '';
    djAcItems = [];
    djAcActiveIdx = -1;

    results.forEach((entry, i) => {
      const div = document.createElement('div');
      div.className = 'ac-item';
      const count = entry.trackIds.length;
      div.innerHTML = `<span class="ac-name">${escHtml(entry.display)}</span><span class="ac-count">${count} track${count !== 1 ? 's' : ''}</span>`;
      div.addEventListener('click', () => {
        closeDjAc();
        setDjFilter(entry);
      });
      div.addEventListener('mouseenter', () => {
        djAcItems.forEach(el => el.classList.remove('active'));
        div.classList.add('active');
        djAcActiveIdx = i;
      });
      djAcDropdown.appendChild(div);
      djAcItems.push(div);
    });

    djAcDropdown.classList.add('open');
  }

  djSearchInput.addEventListener('input', () => {
    if (djFilter && djSearchInput.value !== djFilter.display) {
      djFilter = null;
      djSearchInput.classList.remove('filtered');
    }
    showDjAc(djSearchInput.value);
  });

  djSearchInput.addEventListener('focus', () => {
    if (!djFilter) showDjAc(djSearchInput.value);
  });

  djSearchInput.addEventListener('keydown', (e) => {
    if (!djAcDropdown.classList.contains('open')) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      djAcActiveIdx = Math.min(djAcActiveIdx + 1, djAcItems.length - 1);
      djAcItems.forEach((el, i) => el.classList.toggle('active', i === djAcActiveIdx));
      djAcItems[djAcActiveIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      djAcActiveIdx = Math.max(djAcActiveIdx - 1, 0);
      djAcItems.forEach((el, i) => el.classList.toggle('active', i === djAcActiveIdx));
      djAcItems[djAcActiveIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (djAcActiveIdx >= 0 && djAcActiveIdx < djAcItems.length) {
        djAcItems[djAcActiveIdx].click();
      }
    } else if (e.key === 'Escape') {
      closeDjAc();
      djSearchInput.blur();
    }
  });

  djClearBtn.addEventListener('click', () => {
    clearDjFilter();
    closeDjAc();
  });

  // ── Dev panel toggle ──
  document.getElementById('dev-toggle').addEventListener('click', () => {
    document.getElementById('dev-panel').classList.toggle('open');
  });

  // ── Gradient art knobs ──
  const ftTurb = document.getElementById('ft-turb');
  const ftDisplace = document.getElementById('ft-displace');
  const ftBlur = document.getElementById('ft-blur');
  const ftGrainMix = document.getElementById('ft-grain-mix');

  function updateGradientFilter() {
    const warp = document.getElementById('tune-warp').value;
    const freq = document.getElementById('tune-freq').value / 1000;
    const blur = document.getElementById('tune-blur').value;
    const grain = document.getElementById('tune-grain').value / 100;
    const sat = document.getElementById('tune-saturate').value;
    const hue = document.getElementById('tune-hue').value;

    ftTurb.setAttribute('baseFrequency', freq);
    ftDisplace.setAttribute('scale', warp);
    ftBlur.setAttribute('stdDeviation', blur);
    // Grain mix: k2 = (1-grain) for original, k3 = grain for grained
    ftGrainMix.setAttribute('k2', 1 - grain);
    ftGrainMix.setAttribute('k3', grain);

    // CSS filters (saturation + hue) applied via style override
    const cssFilter = `url(#gradient-distort) saturate(${sat}%) hue-rotate(${hue}deg)`;
    document.querySelectorAll('.album-art.no-art').forEach(el => {
      el.style.filter = cssFilter;
    });
    // Store for newly created cards
    window._gradientFilter = cssFilter;
  }

  ['tune-warp','tune-freq','tune-blur','tune-grain','tune-saturate','tune-hue'].forEach(id => {
    const input = document.getElementById(id);
    const valSpan = input.parentElement.querySelector('.tune-val');
    input.addEventListener('input', () => {
      // Update display label
      if (id === 'tune-freq') valSpan.textContent = (input.value / 1000).toFixed(3);
      else if (id === 'tune-grain') valSpan.textContent = input.value + '%';
      else if (id === 'tune-saturate') valSpan.textContent = input.value + '%';
      else if (id === 'tune-hue') valSpan.textContent = input.value + '\u00B0';
      else if (id === 'tune-blur') valSpan.textContent = input.value;
      else valSpan.textContent = input.value;
      updateGradientFilter();
    });
  });

});
