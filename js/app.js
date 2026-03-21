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
    showMoreBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const prevLevel = currentCluster.meta.expandLevel || 0;
      try {
        const expanded = await apiLoadCluster(currentRootId, { expand: prevLevel + 1 });
        showCluster(expanded);
      } catch (err) { console.error('Expand failed:', err.message); }
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

  // Filter label above root card — will be restored by updateFilterUI() via onClusterShown

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
  if (onClusterShown) onClusterShown();
}

function getFilteredPoolSize() {
  return lastPoolSize;
}

function buildFilterParams() {
  const source = document.getElementById('source-filter')?.value || 'none';
  const artists = [
    ...searchFilters.map(f => f.display),
    ...clusterArtistFilters.map(f => f.display),
  ];
  const djs = [
    ...djSearchFilters.map(f => f.display),
    ...clusterDjFilters.map(f => f.display),
  ];
  return {
    source: source !== 'none' ? source : undefined,
    genres: genreFilters.length ? genreFilters : undefined,
    artists: artists.length ? artists : undefined,
    djs: djs.length ? djs : undefined,
    exclude: shuffleHistory.size ? [...shuffleHistory] : undefined,
    r1: maxR1,
    r2: r2PerR1,
  };
}

async function shuffle() {
  if (frozen) return;
  try {
    const cluster = await apiShuffle(buildFilterParams());
    if (cluster.meta.poolSize !== undefined) lastPoolSize = cluster.meta.poolSize;
    shuffleHistory.add(cluster.meta.root_id);
    showCluster(cluster);
  } catch (err) {
    console.warn('Shuffle failed:', err.message);
    if (err.message.includes('No tracks match')) {
      // Clear history and retry once
      shuffleHistory.clear();
      try {
        const cluster = await apiShuffle(buildFilterParams());
        if (cluster.meta.poolSize !== undefined) lastPoolSize = cluster.meta.poolSize;
        shuffleHistory.add(cluster.meta.root_id);
        showCluster(cluster);
      } catch (e) { console.error('Shuffle retry failed:', e.message); }
    }
  }
}

async function loadClusterById(id) {
  id = id.trim();
  try {
    const cluster = await apiLoadCluster(id);
    showCluster(cluster);
  } catch (err) {
    console.warn(`Cluster "${id}" not found:`, err.message);
  }
}

// ═══════════════════════════════════════════
// Init — wire up API-driven UI
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  console.log(`API base: ${API_BASE}`);

  // Init filters, search indexes, autocomplete, popovers
  const filterCtrl = await initFilters();

  // Register cluster pills hook before initial load
  onClusterShown = () => { filterCtrl.updateClusterPills(); filterCtrl.updateFilterUI(); };

  // Load cluster from URL hash, or shuffle for a random one
  const hashId = decodeURIComponent(window.location.hash.slice(1));
  if (hashId) {
    loadClusterById(hashId);
  } else {
    shuffle();
  }

  // Navigate to cluster on back/forward
  window.addEventListener('popstate', () => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id && id !== currentRootId) {
      loadClusterById(id);
    } else if (!id) {
      shuffle();
    }
  });

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
  const mobileHeaderShare = document.getElementById('mobile-header-share');
  mobileHeaderShare.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href);
    mobileHeaderShare.classList.add('copied');
    setTimeout(() => mobileHeaderShare.classList.remove('copied'), 1500);
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
  async function transitionToTracks(seedKey, stackEl) {
    let cluster;
    try {
      cluster = await apiLoadCluster(seedKey);
    } catch (err) { console.error('Failed to load cluster:', err.message); return; }

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
    document.body.classList.remove('crates-mode');
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

  function initCrates() {
    if (cratesInitialized) return;

    const cratesView = document.getElementById('crates-view');
    const surface = document.getElementById('crates-surface');
    const vw = cratesView.clientWidth || window.innerWidth;
    const vh = cratesView.clientHeight || (window.innerHeight - 60);

    // Don't init if dimensions are invalid (view not yet visible)
    if (vw < 100 || vh < 100) return;
    cratesInitialized = true;

    const cap = s => s.replace(/\b\w/g, c => c.toUpperCase());
    const gap = 25, pad = 0, STEP = 3;
    const CLUSTERS_PER_PAGE = isMobileView() ? 10 : 20;

    // Local RNG for placeholder colors
    let localSeed = Date.now() % 2147483647 || 1;
    function crateRand() {
      localSeed = (localSeed * 16807) % 2147483647;
      return (localSeed - 1) / 2147483646;
    }

    const crateSeed = Date.now() % 2147483647 || 1;
    const pendingPages = {};
    let pageIdCounter = 0;

    // Page grid: each page is viewport-sized, keyed by "col,row"
    const pages = {};       // "col,row" -> { clusters, el, stacks, artLoaded }
    const pendingPageKeys = new Set(); // pages requested but not yet received

    // Canvas bounds (grow dynamically)
    let minCol = 0, maxCol = 0, minRow = 0, maxRow = 0;

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
      // Use first artwork as top key (server already promotes best art)
      const topKey = artKeys.length > 0 ? artKeys[0] : null;
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

        const info = document.createElement('div');
        info.className = 'crate-info';
        info.innerHTML = `
          <div class="ci-title">${cap(item.title)}</div>
          <div class="ci-artist">${cap(item.artist)}</div>
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

    // Request a page from the API (non-blocking)
    function requestPage(col, row) {
      const key = `${col},${row}`;
      if (pages[key] || pendingPageKeys.has(key)) return;
      pendingPageKeys.add(key);
      const pageNum = pageIdCounter++;

      const filters = {};
      if (genreFilters.length) filters.genres = genreFilters;
      if (searchFilters.length) filters.artists = searchFilters.map(f => f.display);
      if (djSearchFilters.length) filters.djs = djSearchFilters.map(f => f.display);

      apiGetCratesPage({
        seed: crateSeed,
        page: pageNum,
        count: CLUSTERS_PER_PAGE,
        ...filters,
      }).then(result => {
        const clusters = result.clusters || [];
        // Run treemap layout client-side
        if (clusters.length > 0) {
          const items = clusters.map((c, i) => ({ ...c, idx: i }));
          cratesTreemap(items, pad, pad, vw - pad * 2, vh - pad * 2);
          receivePage(col, row, items);
        } else {
          receivePage(col, row, []);
        }
      }).catch(err => {
        console.error('Crates page failed:', err.message);
        pendingPageKeys.delete(key);
      });
    }

    // Client-side treemap layout
    function cratesTreemap(items, x, y, w, h) {
      if (items.length === 0) return items;
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

    // Handle page data from API — build DOM on main thread
    function receivePage(col, row, clusters) {
      const key = `${col},${row}`;
      pendingPageKeys.delete(key);
      if (pages[key] || clusters.length === 0) return;
      minCol = Math.min(minCol, col);
      maxCol = Math.max(maxCol, col);
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);

      const pageOffsetX = col * vw;
      const pageOffsetY = row * vh;
      const container = document.createElement('div');
      container.className = 'crate-page';

      const stacks = [];
      clusters.forEach(item => {
        const stackEl = renderStack(item, pageOffsetX, pageOffsetY);
        if (stackEl) {
          container.appendChild(stackEl);
          stacks.push({ el: stackEl, item });
          if (!isMobileView()) attachHover(stackEl);
        }
      });
      surface.appendChild(container);

      const page = { clusters, el: container, stacks, artLoaded: false };
      pages[key] = page;
      // Load art if page is near viewport
      updateVisibleForPage(key, page);
    }

    // Check if a single newly-added page should have art loaded
    function updateVisibleForPage(key, page) {
      const viewL = -panX, viewT = -panY;
      const colVis0 = Math.floor(viewL / vw);
      const colVis1 = Math.floor((viewL + vw / crateScale) / vw);
      const rowVis0 = Math.floor(viewT / vh);
      const rowVis1 = Math.floor((viewT + vh / crateScale) / vh);
      const [c, r] = key.split(',').map(Number);
      if (c >= colVis0 - 1 && c <= colVis1 + 1 && r >= rowVis0 - 1 && r <= rowVis1 + 1) {
        loadPageArt(page);
      }
    }

    // Load artwork images into a page's stacks
    function loadPageArt(page) {
      if (page.artLoaded) return;
      page.artLoaded = true;
      page.stacks.forEach(({ el: stackEl, item }) => {
        const cards = stackEl.querySelectorAll('.crate-card');
        const last = cards.length - 1;
        cards.forEach((card, i) => {
          // Top card uses first artwork; others cycle through the rest
          const topUrl = item.artworks.length > 0 ? item.artworks[0] : null;
          const otherArt = item.artworks.slice(1);
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

    let visibleTimer = null;
    function scheduleUpdateVisible() {
      if (visibleTimer) return;
      visibleTimer = setTimeout(() => {
        visibleTimer = null;
        updateVisible();
      }, isMobileView() ? 250 : 150);
    }

    function updateVisible() {
      // Viewport in canvas coords (account for scale)
      const viewL = -panX;
      const viewT = -panY;
      const viewR = viewL + vw / crateScale;
      const viewB = viewT + vh / crateScale;

      // Pages to build (visible viewport)
      const colMin = Math.floor(viewL / vw);
      const colMax = Math.floor(viewR / vw);
      const rowMin = Math.floor(viewT / vh);
      const rowMax = Math.floor(viewB / vh);

      // Request nearby pages (non-blocking)
      for (let c = colMin; c <= colMax; c++) {
        for (let r = rowMin; r <= rowMax; r++) {
          requestPage(c, r);
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
        } else if (c < colMin - 3 || c > colMax + 3 || r < rowMin - 3 || r > rowMax + 3) {
          unloadPageArt(page);
        }
      }
    }

    // Pan state
    let crateScale = isMobileView() ? 0.75 : 0.8;
    let panX = 0, panY = 0;
    surface.style.transform = `scale3d(${crateScale},${crateScale},1) translate3d(${panX}px,${panY}px,0)`;

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
        applyTransform();
        scheduleUpdateVisible();
      }
    };
    cratesView.onmouseup = () => {
      isDragging = false;
      cratesView.classList.remove('dragging');
    };
    cratesView.addEventListener('click', e => {
      if (didDrag) { e.stopPropagation(); didDrag = false; }
    }, true);
    cratesView.addEventListener('wheel', e => {
      panX -= e.deltaX; panY -= e.deltaY;
      applyTransform();
      scheduleUpdateVisible();
    }, { passive: true });

    // Touch pan + pinch-to-zoom (mobile)
    let touchDragging = false, touchDidDrag = false;
    let touchStartX, touchStartY, touchPanStartX, touchPanStartY;
    let pinchActive = false, lastPinchDist = 0, pinchStartScale = 0;

    function applyTransform() {
      surface.style.transform = `scale3d(${crateScale},${crateScale},1) translate3d(${panX}px,${panY}px,0)`;
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
        velX = 0; velY = 0;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        lastTouchX = touchStartX;
        lastTouchY = touchStartY;
        lastTouchTime = performance.now();
        touchPanStartX = panX;
        touchPanStartY = panY;
      }
    }, { passive: true });

    let lastTouchX = 0, lastTouchY = 0, lastTouchTime = 0;
    let velX = 0, velY = 0, momentumId = null;

    cratesView.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 2 && pinchActive) {
        const dist = Math.hypot(
          e.touches[1].clientX - e.touches[0].clientX,
          e.touches[1].clientY - e.touches[0].clientY
        );
        crateScale = Math.max(0.2, Math.min(2, pinchStartScale * (dist / lastPinchDist)));
        applyTransform();
        scheduleUpdateVisible();
      } else if (e.touches.length === 1 && touchDragging) {
        const now = performance.now();
        const cx = e.touches[0].clientX, cy = e.touches[0].clientY;
        const dx = cx - touchStartX;
        const dy = cy - touchStartY;
        if (!touchDidDrag && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
          touchDidDrag = true;
          cratesView.classList.add('dragging');
          if (momentumId) { cancelAnimationFrame(momentumId); momentumId = null; }
        }
        if (touchDidDrag) {
          const dt = now - lastTouchTime || 16;
          velX = (cx - lastTouchX) / dt * 16;
          velY = (cy - lastTouchY) / dt * 16;
          lastTouchX = cx; lastTouchY = cy; lastTouchTime = now;
          panX = touchPanStartX + dx;
          panY = touchPanStartY + dy;
          applyTransform();
          scheduleUpdateVisible();
        }
      }
    }, { passive: false });

    function momentumStep() {
      velX *= 0.92;
      velY *= 0.92;
      if (Math.abs(velX) < 0.5 && Math.abs(velY) < 0.5) {
        momentumId = null;
        updateVisible();
        return;
      }
      panX += velX;
      panY += velY;
      applyTransform();
      scheduleUpdateVisible();
      momentumId = requestAnimationFrame(momentumStep);
    }

    cratesView.addEventListener('touchend', e => {
      if (e.touches.length < 2) pinchActive = false;
      if (e.touches.length === 0) {
        touchDragging = false;
        cratesView.classList.remove('dragging');
        if (touchDidDrag && (Math.abs(velX) > 1 || Math.abs(velY) > 1)) {
          momentumId = requestAnimationFrame(momentumStep);
        }
      }
    });

    // Suppress click after touch drag
    cratesView.addEventListener('click', e => {
      if (touchDidDrag) { e.stopPropagation(); touchDidDrag = false; }
    }, true);

    // Initial render
    updateVisible();
    console.log('Crates: initialized');
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
