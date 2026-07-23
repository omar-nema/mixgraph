function showCluster(cluster) {
  currentCluster = cluster;
  selectedAudioSources = {};
  if (isMobileView()) {
    showClusterMobile(cluster);
    return;
  }
  syncDesktopToolbarHeight();
  clearGraph();
  nodes = cluster.nodes;
  edges = cluster.edges;
  nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);
  currentRootId = cluster.nodes[0].graphId;
  document.getElementById('cluster-id').textContent = currentRootId;
  const target = '/shuffle' + location.search + '#' + encodeURIComponent(currentRootId);
  if (location.pathname + location.search + location.hash !== target) {
    history.pushState(null, '', target);
  }
  logCluster(cluster);

  // Two-pass layout: render cards offscreen, measure, then position
  // Pass 1: place cards at 0,0 so DOM can measure heights
  nodes.forEach(n => { n.x = -9999; n.y = -9999; });
  renderCards();

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
    if (el) {
      measuredHeights[n.id] = el.offsetHeight;
      setupCardMarquees(el);
    }
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

  // Zoom-to-fit: scale + center the whole network within the viewport
  fitGraphToViewport();

  // Desktop genre pills — primary track's genres, capped at 4
  const desktopGenres = document.getElementById('desktop-genres');
  const primaryNode = nodes.find(n => n.primary) || nodes[0];
  const commonGenres = primaryNode ? (primaryNode.genres || []) : [];
  desktopGenres.innerHTML = '';
  const showGenres = document.getElementById('show-genres')?.checked;
  if (showGenres && commonGenres.length > 0) {
    const label = document.createElement('span');
    label.className = 'desktop-genre-label';
    label.textContent = 'Genres';
    // Tooltip showing all genres on hover
    const tip = document.createElement('div');
    tip.className = 'genre-tooltip';
    commonGenres.forEach(g => {
      const pill = document.createElement('span');
      pill.className = 'desktop-genre-pill';
      pill.dataset.genre = g;
      pill.textContent = g;
      tip.appendChild(pill);
    });
    label.appendChild(tip);
    label.addEventListener('mouseenter', () => tip.classList.add('open'));
    label.addEventListener('mouseleave', () => tip.classList.remove('open'));
    desktopGenres.appendChild(label);
    // Prioritize active genre filters to the front
    const activeGenres = typeof genreFilters !== 'undefined' ? genreFilters : [];
    const sorted = [...commonGenres].sort((a, b) => {
      const aActive = activeGenres.includes(a) ? 0 : 1;
      const bActive = activeGenres.includes(b) ? 0 : 1;
      return aActive - bActive;
    });
    const CAP = 4;
    const visible = sorted.slice(0, CAP);
    const rest = sorted.slice(CAP);
    visible.forEach(g => {
      const pill = document.createElement('span');
      pill.className = 'desktop-genre-pill';
      pill.dataset.genre = g;
      pill.textContent = g;
      desktopGenres.appendChild(pill);
    });
    if (rest.length > 0) {
      const more = document.createElement('span');
      more.className = 'desktop-genre-pill genre-more';
      more.textContent = `+${rest.length}`;
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        more.remove();
        rest.forEach(g => {
          const pill = document.createElement('span');
          pill.className = 'desktop-genre-pill';
          pill.dataset.genre = g;
          pill.textContent = g;
          desktopGenres.appendChild(pill);
        });
      });
      desktopGenres.appendChild(more);
    }
    desktopGenres.classList.add('visible');
  } else {
    desktopGenres.classList.remove('visible');
  }

  if (onClusterShown) onClusterShown();
}

function getFilteredPoolSize() {
  return lastPoolSize;
}

function syncDesktopToolbarHeight() {
  const toolbar = document.getElementById('toolbar');
  const height = (!toolbar || isMobileView())
    ? 0
    : Math.ceil(toolbar.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--toolbar-height', `${height}px`);
}

// ── Loading / error overlay ──
function showStatus(message, isError) {
  const el = document.getElementById('app-status');
  if (!el) return;
  el.classList.remove('hidden', 'error');
  if (isError) el.classList.add('error');
  el.querySelector('.status-message').textContent = message;
  const retryBtn = el.querySelector('.status-retry');
  const isFilterEmpty = isError && message.toLowerCase().includes('no tracks match');
  retryBtn.textContent = isFilterEmpty ? 'clear filters' : 'try again';
  retryBtn.dataset.action = isFilterEmpty ? 'clear' : 'retry';
  retryBtn.classList.toggle('hidden', !isError);
}

function hideStatus() {
  const el = document.getElementById('app-status');
  if (el) el.classList.add('hidden');
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
    title: trackSearchFilter || undefined,
    exclude: shuffleHistory.size ? [...shuffleHistory] : undefined,
    r1: maxR1,
    r2: r2PerR1,
  };
}

async function shuffle() {
  if (frozen) return;
  // Crates mode: rebuild crates surface with current filters
  if (document.body.classList.contains('crates-mode')) {
    if (window._cratesResetFn) window._cratesResetFn();
    return;
  }
  trackEvent('shuffle');
  showStatus('');
  try {
    const cluster = await apiShuffle(buildFilterParams());
    if (cluster.meta.poolSize !== undefined) lastPoolSize = cluster.meta.poolSize;
    shuffleHistory.add(cluster.meta.root_id);
    hideStatus();
    showCluster(cluster);
  } catch (err) {
    console.warn('Shuffle failed:', err.message);
    if (err.message.includes('No tracks match')) {
      shuffleHistory.clear();
      try {
        const cluster = await apiShuffle(buildFilterParams());
        if (cluster.meta.poolSize !== undefined) lastPoolSize = cluster.meta.poolSize;
        shuffleHistory.add(cluster.meta.root_id);
        hideStatus();
        showCluster(cluster);
      } catch (e) {
        showStatus(e.message.includes('Failed to fetch') ? 'could not reach the server' : e.message, true);
      }
    } else {
      showStatus(err.message.includes('Failed to fetch') ? 'could not reach the server' : err.message, true);
    }
  }
}

async function loadClusterById(id) {
  id = id.trim();
  showStatus('');
  try {
    const cluster = await apiLoadCluster(id);
    hideStatus();
    showCluster(cluster);
  } catch (err) {
    console.warn(`Cluster "${id}" not found:`, err.message);
    showStatus(err.message.includes('Failed to fetch') ? 'could not reach the server' : `track not found`, true);
  }
}

// ═══════════════════════════════════════════
// Init — wire up API-driven UI
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  console.log(`API base: ${API_BASE}`);
  syncDesktopToolbarHeight();
  const toolbar = document.getElementById('toolbar');
  if (toolbar && 'ResizeObserver' in window) {
    const toolbarObserver = new ResizeObserver(() => syncDesktopToolbarHeight());
    toolbarObserver.observe(toolbar);
  }
  window.addEventListener('resize', syncDesktopToolbarHeight);

  // Init filters, search indexes, autocomplete, popovers
  const filterCtrl = await initFilters();

  // Wire retry button (needs filterCtrl for "clear filters" action)
  const retryBtn = document.querySelector('.status-retry');
  if (retryBtn) retryBtn.addEventListener('click', () => {
    if (retryBtn.dataset.action === 'clear') filterCtrl.clearAllFilters();
    shuffle();
  });

  // Register cluster pills hook before initial load
  onClusterShown = () => { filterCtrl.updateClusterPills(); filterCtrl.updateFilterUI(); };

  // Restore filters from URL (genre/artist/dj/track) before the first load so the
  // initial shuffle/cluster/crates query already reflects them.
  const hasRestoredFilters = filterCtrl.restoreFiltersFromUrl();

  // loadClusterById (hash links) doesn't compute the filter pool size, so a shared
  // filtered link (?g=...#cluster) would show "results (0)". Fetch the pool size
  // separately and refresh the label — without disturbing the displayed cluster.
  async function refreshFilteredPoolSize() {
    try {
      const c = await apiShuffle(buildFilterParams());
      if (c.meta.poolSize !== undefined) {
        lastPoolSize = c.meta.poolSize;
        filterCtrl.updateFilterUI();
      }
    } catch (_) { /* leave label uncounted if the pool can't be computed */ }
  }

  // Determine starting mode from URL path
  const startPath = location.pathname.replace(/\/$/, '');
  const startInShuffle = startPath === '/shuffle';
  const hashId = decodeURIComponent(window.location.hash.slice(1));

  if (startInShuffle || hashId) {
    // Switch to shuffle/tracks mode
    switchToMode('tracks');
    if (hashId) {
      await loadClusterById(hashId);
      if (hasRestoredFilters) refreshFilteredPoolSize();
    } else {
      shuffle();
    }
  } else {
    // Default: dig/crates mode — URL is / or /dig
    if (startPath !== '/dig' && startPath !== '' && startPath !== '/') {
      history.replaceState(null, '', '/dig' + location.search);
    }
  }

  // Navigate on back/forward
  window.addEventListener('popstate', () => {
    const path = location.pathname.replace(/\/$/, '');
    const id = decodeURIComponent(location.hash.slice(1));
    if (path === '/shuffle') {
      switchToMode('tracks');
      if (id && id !== currentRootId) loadClusterById(id);
      else if (!currentCluster) shuffle();
    } else {
      switchToMode('crates');
    }
  });

  // Wire onboarding — desktop "back2back?" opens a centered modal; mobile "?" slides a full panel down below the header.
  const mobileHelpBtn = document.getElementById('mobile-help-btn');
  const onboarding = (() => {
    const overlay = document.getElementById('onboarding-overlay');
    const track = document.getElementById('ob-track');
    const slides = [...track.children];
    const dotsWrap = document.getElementById('ob-dots');
    const prev = document.getElementById('ob-prev');
    const next = document.getElementById('ob-next');
    const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
    const NEXT_LABELS = ['How it works', 'Shuffle mode', 'Start exploring']; // per-slide label for the forward button
    let i = 0;

    const dots = slides.map((_, n) => {
      const d = document.createElement('button');
      d.className = 'ob-dot'; d.setAttribute('role', 'tab');
      d.setAttribute('aria-label', 'Go to slide ' + (n + 1));
      d.addEventListener('click', () => go(n));
      dotsWrap.appendChild(d);
      return d;
    });

    function render() {
      track.style.transform = `translateX(${-i * 100}%)`;
      slides.forEach((s, n) => s.toggleAttribute('data-active', n === i));
      dots.forEach((d, n) => d.setAttribute('aria-current', n === i ? 'true' : 'false'));
      prev.disabled = i === 0;
      next.innerHTML = (NEXT_LABELS[i] || 'Next') + ' ' + arrow;
    }
    function go(n) { i = Math.max(0, Math.min(slides.length - 1, n)); render(); }

    // Pick each screenshot to match the current viewport (mobile/desktop) and theme (light/night).
    function syncShots() {
      const mob = window.matchMedia('(max-width: 768px)').matches;
      const night = document.body.classList.contains('night');
      const key = (mob ? 'mob' : 'desk') + (night ? 'Dark' : '');
      overlay.querySelectorAll('.ob-shot').forEach(img => {
        const src = img.dataset[key] || img.dataset[mob ? 'mob' : 'desk'];
        if (src && !img.src.endsWith(src)) img.src = src;
      });
    }

    function open() {
      syncShots();
      // Collapse the header's filter chrome first (so it can't bleed over the panel),
      // then pin the sliding panel just below the resulting (variable-height) header.
      document.body.classList.add('ob-open');
      const mh = document.getElementById('mobile-header');
      // On mobile the dots ride in the app header, in the slot the Dig/Shuffle
      // tabs vacate — move them before measuring so --ob-top reflects the result.
      if (mh && window.matchMedia('(max-width: 768px)').matches) {
        mh.insertBefore(dotsWrap, document.getElementById('mobile-mode-tabs'));
      }
      if (mh) overlay.style.setProperty('--ob-top', mh.getBoundingClientRect().height + 'px');
      // Clear any live helper toast so it doesn't float over the panel
      document.querySelectorAll('.helper-toast.visible').forEach(t => t.classList.remove('visible'));
      overlay.classList.add('open');
      overlay.setAttribute('aria-hidden', 'false');
      mobileHelpBtn.classList.add('open');
      mobileHelpBtn.textContent = '✕';
      mobileHelpBtn.title = 'Close';
      go(0);
    }
    function close() {
      document.body.classList.remove('ob-open');
      overlay.querySelector('.ob-header').prepend(dotsWrap);   // back into the sheet (desktop's home for them)
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
      mobileHelpBtn.classList.remove('open');
      mobileHelpBtn.textContent = '?';
      mobileHelpBtn.title = 'How it works';
    }
    function toggle() { overlay.classList.contains('open') ? close() : open(); }

    next.addEventListener('click', () => i === slides.length - 1 ? close() : go(i + 1));
    prev.addEventListener('click', () => go(i - 1));
    overlay.querySelector('.ob-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => {
      if (!overlay.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') go(i + 1);
      else if (e.key === 'ArrowLeft') go(i - 1);
    });

    // swipe / drag
    let x0 = null, dx = 0, dragging = false;
    const down = x => { x0 = x; dx = 0; dragging = true; track.style.transition = 'none'; };
    const move = x => { if (!dragging) return; dx = x - x0; track.style.transform = `translateX(calc(${-i * 100}% + ${dx}px))`; };
    const up = () => {
      if (!dragging) return;
      dragging = false; track.style.transition = '';
      const threshold = Math.min(120, track.offsetWidth * 0.18);
      if (dx <= -threshold) go(i + 1); else if (dx >= threshold) go(i - 1); else render();
    };
    track.addEventListener('touchstart', e => down(e.touches[0].clientX), { passive: true });
    track.addEventListener('touchmove', e => move(e.touches[0].clientX), { passive: true });
    track.addEventListener('touchend', up);
    track.addEventListener('mousedown', e => { e.preventDefault(); down(e.clientX); });
    window.addEventListener('mousemove', e => move(e.clientX));
    window.addEventListener('mouseup', up);

    render();
    return { open, close, toggle };
  })();

  document.getElementById('help-btn').addEventListener('click', () => onboarding.open());
  mobileHelpBtn.addEventListener('click', () => onboarding.toggle());
  const mobileHeaderShare = document.getElementById('mobile-header-share');
  if (mobileHeaderShare) {
    mobileHeaderShare.addEventListener('click', () => {
      navigator.clipboard.writeText(window.location.href);
      mobileHeaderShare.classList.add('copied');
      setTimeout(() => mobileHeaderShare.classList.remove('copied'), 1500);
    });
  }
  // Wire filter toggle button — collapsed by default, auto-opens when filters active
  const filterToggle = document.getElementById('mobile-filter-toggle');
  const mobileFilterBar = document.getElementById('mobile-filter-bar');
  if (filterToggle && mobileFilterBar) {
    mobileFilterBar.classList.add('collapsed');
    filterToggle.addEventListener('click', () => {
      mobileFilterBar.classList.toggle('collapsed');
      filterToggle.classList.toggle('active', !mobileFilterBar.classList.contains('collapsed'));
    });
  }
  // Wire mobile filter bar pills (Dig/Crates mode only)
  const filterBarGenre = document.getElementById('mobile-bar-genre');
  const filterBarArtist = document.getElementById('mobile-bar-artist');
  const filterBarDj = document.getElementById('mobile-bar-dj');
  // Timestamp of the last popover open, so a close event that's really just the
  // tail end of the same long-press (iOS can re-target the release at the newly
  // shown backdrop, which now covers the pill) gets ignored instead of instantly
  // closing what the press just opened.
  let lastBarPopoverOpenAt = 0;
  // Mirror of the above for the opposite direction: a single tap on an already-open
  // pill can fire two click events, the first closing it (toggle-off) and a
  // duplicate immediately reopening it. Timestamp only set on an actual toggle-off
  // or backdrop close (not on a popover-to-popover switch), so legitimate rapid
  // switching between Genre/Artist/DJ never gets blocked by this guard.
  let lastBarPopoverCloseAt = 0;
  if (filterBarGenre) {
    const popoverBackdrop = document.getElementById('popover-backdrop');
    const popovers = {
      genre: document.getElementById('genre-popover'),
      artist: document.getElementById('artist-popover'),
      dj: document.getElementById('dj-popover'),
    };
    function closeBarPopovers(andReshuffle) {
      const anyOpen = Object.values(popovers).some(p => p && p.classList.contains('open'));
      Object.values(popovers).forEach(p => { if (p) p.classList.remove('open'); });
      popoverBackdrop.classList.remove('open');
      [filterBarGenre, filterBarArtist, filterBarDj].forEach(p => p.classList.remove('semi-open'));
      if (andReshuffle && anyOpen && typeof filtersDirty !== 'undefined' && filtersDirty) {
        filtersDirty = false;
        if (typeof shuffle === 'function') shuffle();
      }
    }
    function openBarPopover(name, pillEl) {
      const popover = popovers[name];
      if (!popover) return;
      // Same-gesture duplicate click can fire right after this same tap closed the
      // popover via the toggle-off branch below (or via the backdrop) — ignore the
      // reopen attempt instead of flickering closed-then-open.
      if (Date.now() - lastBarPopoverCloseAt < 300) return;
      const already = popover.classList.contains('open');
      closeBarPopovers(false);
      if (already) {
        lastBarPopoverCloseAt = Date.now();
        if (typeof filtersDirty !== 'undefined' && filtersDirty) { filtersDirty = false; if (typeof shuffle === 'function') shuffle(); }
        return;
      }
      const rect = pillEl.getBoundingClientRect();
      const top = rect.bottom + 8;
      popover.style.top = top + 'px';
      // Cap height to the space actually below the anchor instead of relying
      // solely on the CSS max-height:75vh — mobile browsers compute vh against
      // the largest possible viewport (as if their own chrome were hidden), and
      // Chrome on iOS reserves noticeably more screen for its toolbar than
      // Safari, so 75vh can overshoot the real visible area and get the
      // popover clipped at the bottom. window.innerHeight reflects what's
      // actually visible right now, in any mobile browser.
      popover.style.maxHeight = (window.innerHeight - top - 12) + 'px';
      popover.classList.add('open');
      popoverBackdrop.classList.add('open');
      pillEl.classList.add('semi-open');
      lastBarPopoverOpenAt = Date.now();
    }
    filterBarGenre.addEventListener('click', function(e) {
      e.stopPropagation();
      openBarPopover('genre', this);
      setTimeout(() => document.getElementById('genre-search')?.focus(), 100);
    });
    filterBarArtist.addEventListener('click', function(e) {
      e.stopPropagation();
      openBarPopover('artist', this);
      setTimeout(() => document.getElementById('find-search')?.focus(), 100);
    });
    filterBarDj.addEventListener('click', function(e) {
      e.stopPropagation();
      openBarPopover('dj', this);
      setTimeout(() => document.getElementById('dj-search')?.focus(), 100);
    });
  }

  // Wire popover backdrop once — works for both Dig-bar pills and Shuffle-area pills.
  // (Previously this was wired per-shuffle inside showClusterMobile, which meant Dig mode
  // had no close handler until you'd entered Shuffle, and also leaked listeners per cluster.)
  const sharedBackdrop = document.getElementById('popover-backdrop');
  if (sharedBackdrop) {
    // Close on the backdrop tap. On iOS, a plain `click` on a transparent div is
    // unreliable — especially while the popover's search input has focus and the
    // on-screen keyboard is up, where the first tap-outside gets swallowed as a
    // keyboard-dismiss. `pointerdown` fires regardless; preventDefault stops the
    // ghost click from retargeting to the pill underneath and reopening it.
    const closeFromBackdrop = (e) => {
      const popoverEls = [
        document.getElementById('genre-popover'),
        document.getElementById('artist-popover'),
        document.getElementById('dj-popover'),
      ].filter(Boolean);
      const anyOpen = popoverEls.some(p => p.classList.contains('open'));
      if (!anyOpen) return;
      // On a long press, iOS can fire the opening pill's release over the backdrop
      // it just revealed (which now covers the pill), producing a close event that's
      // really the tail of the same gesture. Swallow closes that land right after an
      // open rather than requiring a quicker release, which would make opening finicky.
      if (Date.now() - lastBarPopoverOpenAt < 350) return;
      if (e) e.preventDefault();
      lastBarPopoverCloseAt = Date.now();
      popoverEls.forEach(p => p.classList.remove('open'));
      sharedBackdrop.classList.remove('open');
      document.querySelectorAll('.mobile-filter-pill.semi-open').forEach(p => p.classList.remove('semi-open'));
      // Drop focus so the keyboard retracts with the popover.
      if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
      if (typeof filtersDirty !== 'undefined' && filtersDirty) {
        filtersDirty = false;
        if (typeof shuffle === 'function') shuffle();
      }
    };
    sharedBackdrop.addEventListener('pointerdown', closeFromBackdrop);
    sharedBackdrop.addEventListener('click', closeFromBackdrop);
  }

  // Wire theme toggle — follow system preference unless user has manually chosen
  const themeBtn = document.getElementById('theme-toggle');
  const savedTheme = localStorage.getItem('b2b-theme');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  const startNight = savedTheme ? savedTheme === 'night' : systemDark.matches;
  function applyTheme(isNight) {
    document.body.classList.toggle('night', isNight);
    document.documentElement.classList.toggle('night', isNight);
    themeBtn.querySelector('.theme-label').textContent = isNight ? 'Day' : 'Night';
    themeBtn.querySelectorAll('.sun-icon').forEach(el => el.style.display = isNight ? 'none' : '');
    themeBtn.querySelector('.moon-icon').style.display = isNight ? '' : 'none';
  }
  applyTheme(startNight);
  themeBtn.addEventListener('click', () => {
    const isNight = !document.body.classList.contains('night');
    applyTheme(isNight);
    localStorage.setItem('b2b-theme', isNight ? 'night' : 'day');
  });
  // Follow system theme changes when user hasn't manually overridden
  systemDark.addEventListener('change', (e) => {
    if (!localStorage.getItem('b2b-theme')) applyTheme(e.matches);
  });

  // ── Crates → Tracks fly-out transition ──
  async function transitionToTracks(seedKey, stackEl) {
    const cratesView = document.getElementById('crates-view');

    // Immediately fade out all other crate stacks
    cratesView.querySelectorAll('.crate-stack').forEach(s => {
      if (s !== stackEl) s.classList.add('fade-out');
    });

    // Quick loading pulse on clicked crate
    stackEl.classList.add('crate-loading');
    let cluster;
    try {
      cluster = await apiLoadCluster(seedKey);
    } catch (err) {
      stackEl.classList.remove('crate-loading');
      // Restore faded stacks on error
      cratesView.querySelectorAll('.crate-stack.fade-out').forEach(s => s.classList.remove('fade-out'));
      console.error('Failed to load cluster:', err.message);
      return;
    }
    stackEl.classList.remove('crate-loading');
    const tracksView = document.getElementById('tracks-view');

    if (isMobileView()) {
      window._cameFromDig = true;
      // ── Phase 1: Capture source geometry ──
      const crateCards = [...stackEl.querySelectorAll('.crate-card')].reverse(); // top card first
      const sources = crateCards.map(card => ({
        rect: card.getBoundingClientRect(),
        imgSrc: card.querySelector('img')?.src || null,
        bg: card.style.background,
      }));

      // Switch mode, build carousel invisibly
      document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.mode-tab[data-mode="tracks"]').forEach(t => t.classList.add('active'));
      document.body.classList.remove('crates-mode');
      tracksView.classList.remove('hidden');

      const carousel = document.getElementById('mobile-carousel');
      carousel.style.visibility = 'hidden';
      showClusterMobile(cluster);

      // Force selectMobileTrack synchronously so #mobile-sources is populated before measuring
      const allClusterCards = cluster.nodes.filter(n => n.rank === 'root' || n.rank === '1' || n.rank === '2');
      const firstWithAudio = allClusterCards.find(n => n.scTrackUrl || n.setUrl);
      if (firstWithAudio) selectMobileTrack(firstWithAudio.id);

      // Suppress default animate-in, hide text, and suppress selected border until flyers done
      carousel.classList.add('fly-transitioning');
      const carouselItems = carousel.querySelectorAll('.mobile-carousel-item');
      carouselItems.forEach(item => {
        item.classList.remove('mobile-animate-in');
        item.style.animation = 'none';
        item.style.opacity = '0';
        item.classList.add('fly-text-hidden');
      });
      const shuffleArea = document.getElementById('mobile-shuffle-area');
      shuffleArea.style.opacity = '0';
      shuffleArea.style.transition = 'opacity 0.2s ease';

      carousel.offsetHeight; // force reflow — measure destinations

      // Measure destination rects
      const destinations = [...carousel.querySelectorAll('.mobile-carousel-card')].map(card => ({
        cardRect: card.getBoundingClientRect(),
        artRect: card.querySelector('.mc-art-wrap').getBoundingClientRect(),
        item: card.closest('.mobile-carousel-item'),
      }));



      // ── Phase 2: Create flyers ──
      // Only root card flies — crate neighbors rarely match carousel R1/R2 tracks
      const flyers = [];
      for (let i = 0; i < destinations.length; i++) {
        const dst = destinations[i];

        if (i > 0) {
          // Non-root cards: fade in normally
          dst.item.style.opacity = '';
          dst.item.style.animation = '';
          dst.item.classList.add('mobile-animate-in');
          dst.item.style.animationDelay = `${0.15 + i * 0.06}s`;
          continue;
        }

        const src = sources[0];

        const fly = document.createElement('div');
        fly.className = 'mobile-flying-art';
        fly.style.width = src.rect.width + 'px';
        fly.style.height = src.rect.height + 'px';
        fly.style.left = src.rect.left + 'px';
        fly.style.top = src.rect.top + 'px';

        if (i > 0) fly.style.transitionDelay = '0.03s';

        // Extract image source: either from <img> or from gradient background URL
        let flySrc = src.imgSrc;
        if (!flySrc && src.bg) {
          const m = src.bg.match(/url\(["']?([^"')]+)/);
          if (m) flySrc = m[1];
        }
        if (flySrc) {
          const img = document.createElement('img');
          img.src = flySrc;
          img.style.width = src.rect.width + 'px';
          img.style.height = src.rect.height + 'px';
          if (i > 0) img.style.transitionDelay = '0.03s';
          fly.appendChild(img);
        } else {
          fly.style.background = src.bg || '#b0aaa4';
        }

        fly.style.transition = 'none';
        const flyImg = fly.querySelector('img');
        if (flyImg) flyImg.style.transition = 'none';
        document.body.appendChild(fly);
        dst.item._hasFlyer = true;
        flyers.push({ el: fly, img: flyImg, dst });
      }

      // Hide clicked crate immediately — must kill animation (fill-mode: both overrides inline opacity)
      stackEl.style.animation = 'none';
      stackEl.style.opacity = '0';

      // Force reflow so browser registers start positions before transition
      document.body.offsetHeight;

      // Fade out crates behind the flyers
      cratesView.classList.add('mobile-fading');

      // Enable transitions and set end states — animation starts immediately
      flyers.forEach(f => {
        f.el.style.transition = '';
        if (f.img) f.img.style.transition = '';

        const { cardRect, artRect } = f.dst;
        f.el.style.width = cardRect.width + 'px';
        f.el.style.height = cardRect.height + 'px';
        f.el.style.left = cardRect.left + 'px';
        f.el.style.top = cardRect.top + 'px';
        f.el.style.background = 'var(--card-bg)';
        f.el.style.border = '2px solid var(--card-border)';
        f.el.style.borderRadius = 'var(--card-radius)';
        f.el.style.boxShadow = 'var(--card-shadow)';

        if (f.img) {
          // Subtract flyer's border (2px) — absolute positioning is relative to padding edge
          f.img.style.left = (artRect.left - cardRect.left - 2) + 'px';
          f.img.style.top = (artRect.top - cardRect.top - 2) + 'px';
          f.img.style.width = artRect.width + 'px';
          f.img.style.height = artRect.height + 'px';
          f.img.style.borderRadius = 'var(--art-radius)';
        }
      });

      // ── Phase 3: Reveal non-flying carousel items (80% through flight) ──
      setTimeout(() => {
        carousel.style.visibility = '';
        carouselItems.forEach(item => {
          if (!item._hasFlyer) {
            // Non-flying items: show normally (they have mobile-animate-in)
            item.classList.remove('fly-text-hidden');
          }
          // Flying items stay hidden — flyer covers them
        });
      }, 360);

      // ── Phase 4: Swap flyers for real cards ──
      setTimeout(() => {
        // Reveal flying carousel items underneath, then fade flyers out
        carouselItems.forEach(item => {
          if (item._hasFlyer) {
            item.style.animation = 'none';
            item.style.opacity = '1';
            item.classList.remove('fly-text-hidden');
            delete item._hasFlyer;
          }
        });
        carousel.offsetHeight;

        flyers.forEach(f => {
          f.el.style.transition = 'opacity 0.15s ease';
          f.el.style.opacity = '0';
        });

        // After crossfade, clean up
        setTimeout(() => {
          flyers.forEach(f => f.el.remove());
          carousel.classList.remove('fly-transitioning');
          shuffleArea.style.opacity = '1';
          cratesView.classList.add('hidden');
          cratesView.classList.remove('mobile-fading');
          stackEl.style.opacity = '';
          stackEl.style.animation = '';
        }, 160);
      }, 550);

      return;
    }

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
    document.querySelectorAll('.mode-tab[data-mode="tracks"]').forEach(t => t.classList.add('active'));

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
        const startSize = Math.min(stackRect.width, stackRect.height) * 0.4;

        // Wrapper div — starts as small shape at stack center, morphs to card-sized
        const fly = document.createElement('div');
        fly.className = 'flying-art';
        fly.style.width = startSize + 'px';
        fly.style.height = startSize + 'px';
        fly.style.left = (srcX - startSize / 2) + 'px';
        fly.style.top = (srcY - startSize / 2) + 'px';
        const delay = n.rank === 'root' ? 0 : n.rank === '1' ? 0.05 : 0.12;
        fly.style.transitionDelay = `${delay + idx * 0.02}s`;

        // Image inside — starts filling wrapper, shrinks to art area within card
        const [fArtist, fTitle] = (n.graphId || '').split(':::');
        const flySrc = n.artUrl || gradientArtUrl(fTitle || n.title, fArtist || n.artist);
        const img = document.createElement('img');
        img.src = flySrc;
        img.style.width = startSize + 'px';
        img.style.height = startSize + 'px';
        img.style.transitionDelay = `${delay + idx * 0.02}s`;
        fly.appendChild(img);

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

  window._cratesResetFn = null;

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
    const gap = isMobileView() ? 19 : 25, pad = 0, STEP = 3;
    const CLUSTERS_PER_PAGE = isMobileView() ? 4 : 20;

    // Local RNG for placeholder colors
    let localSeed = Date.now() % 2147483647 || 1;
    function crateRand() {
      localSeed = (localSeed * 16807) % 2147483647;
      return (localSeed - 1) / 2147483646;
    }

    const crateSeed = Date.now() % 2147483647 || 1;
    let pageIdCounter = 0;
    const pageNums = {}; // "col,row" -> assigned page number (preserved across retries)

    // Page grid: each page is viewport-sized, keyed by "col,row"
    const pages = {};       // "col,row" -> { clusters, el, stacks, artLoaded }
    const pendingPageKeys = new Set(); // pages requested but not yet received

    // Canvas bounds (grow dynamically)
    let minCol = 0, maxCol = 0, minRow = 0, maxRow = 0;
    let poolExhausted = false;  // true once an empty page is received (no more data)

    function renderStack(item, pageOffsetX, pageOffsetY) {
      const r = item.rect;
      const x = pageOffsetX + r.x + gap / 2;
      const y = pageOffsetY + r.y + gap / 2;
      const w = r.w - gap, h = r.h - gap;
      if (w < 20 || h < 20) return null;
      const numCards = Math.min(Math.max(item.artworks.length, 1), 6);
      const pileOffset = (numCards - 1) * STEP;
      const cardW = w - pileOffset, cardH = h - pileOffset;

      const el = document.createElement('div');
      el.className = 'crate-stack';
      el.style.left = x + 'px'; el.style.top = y + 'px';
      el.style.width = w + 'px'; el.style.height = h + 'px';

      const artKeys = item.artKeys || [];
      const topKey = artKeys.length > 0 ? artKeys[0] : null;
      // Detect if seed track has its own artwork in the packed artworks array
      const seedHasArt = item.artworks.length > item.neighborIds.length;
      for (let i = 0; i < numCards; i++) {
        const card = document.createElement('div');
        card.className = 'crate-card placeholder';
        if (i === numCards - 1) card.classList.add('active');
        const offset = i * STEP;
        card.style.left = offset + 'px'; card.style.top = offset + 'px';
        card.style.width = cardW + 'px'; card.style.height = cardH + 'px';
        card.style.zIndex = i;

        // Determine which track this card represents
        let cardTitle = item.title, cardArtist = item.artist;
        const isTopCard = (i === numCards - 1);
        if (!isTopCard && item.neighborIds.length > 0) {
          const nId = item.neighborIds[i % item.neighborIds.length];
          const [nArtist, nTitle] = nId.split(':::');
          cardTitle = nTitle || item.title;
          cardArtist = nArtist || item.artist;
        }

        // Use gradient placeholder only for cards that won't get artwork
        let artIdx;
        if (isTopCard) artIdx = seedHasArt ? 0 : -1;
        else artIdx = seedHasArt ? 1 + i : i;
        const hasArt = artIdx >= 0 && !!item.artworks[artIdx];
        if (hasArt) {
          const base = 148 + Math.floor(crateRand() * 40) - 20;
          card.style.background = `rgb(${base}, ${base - 4}, ${base - 8})`;
        } else {
          card.style.background = generateGradient(cardTitle, cardArtist);
          card.classList.remove('placeholder');
        }
        const info = document.createElement('div');
        info.className = 'crate-info';
        info.innerHTML = `
          <div class="ci-title">${cap(cardTitle)}</div>
          <div class="ci-artist">${cap(cardArtist)}</div>
        `;
        card.appendChild(info);
        el.appendChild(card);
      }

      // Click → fly-out transition to Tracks view
      el._b2bItem = item;
      el.addEventListener('click', () => {
        // Force mouseleave so hover state resets (it won't fire naturally during transition)
        el.dispatchEvent(new MouseEvent('mouseleave'));
        transitionToTracks(item.seedKey, el);
      });

      return el;
    }

    // Track last known mouse position from outside any stack
    let lastOuterX = 0, lastOuterY = 0;
    document.getElementById('crates-view').addEventListener('mousemove', e => {
      if (isDragging) return;
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
      const threshold = 24;
      const deadZone = 150;
      function applyActive() {
        cards.forEach((card, i) => {
          card.classList.toggle('active', i === activeIdx);
          card.style.zIndex = i === activeIdx ? numCards + 1 : i;
        });
      }
      stack.addEventListener('mouseenter', e => {
        // Map cursor X position within crate to a card index
        const rect = stack.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        activeIdx = Math.round(ratio * (numCards - 1));
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

    // Crates index — cached per filter key, shuffled once per fetch
    let cratesPoolCache = {};  // filterKey -> shuffled array
    let cratesPoolPromise = null;
    let cratesFilterKey = '';
    let cratesGeneration = 0;  // bumped on each reset to discard stale async responses

    function getCratesPool() {
      const params = buildFilterParams();
      const key = [params.genres || '', params.artists || '', params.djs || ''].join('|');
      if (key !== cratesFilterKey) {
        cratesFilterKey = key;
        cratesPoolPromise = null;  // invalidate on filter change
      }
      if (cratesPoolCache[key]) return Promise.resolve(cratesPoolCache[key]);
      if (!cratesPoolPromise) {
        const q = { v: 3 };
        if (params.genres) q.genres = params.genres.join(',');
        if (params.artists) q.artists = params.artists.join(',');
        if (params.djs) q.djs = params.djs.join(',');
        cratesPoolPromise = apiFetch('/api/crates-index', q).then(index => {
          let rngState = crateSeed === 0 ? 1 : crateSeed;
          const rng = () => { rngState = (rngState * 16807) % 2147483647; return (rngState - 1) / 2147483646; };
          // Deduplicate by id
          const seen = new Set();
          let deduped = index.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
          // Keep only seed-direct matches (drop neighbor-only hits from server)
          if (params.genres) {
            const genres = params.genres.map(g => g.toLowerCase());
            deduped = deduped.filter(c => {
              const seedGenres = (c.g || []).map(g => g.toLowerCase());
              return genres.some(g => seedGenres.includes(g));
            });
          }
          if (params.artists) {
            const arts = params.artists.map(a => a.toLowerCase().trim());
            deduped = deduped.filter(c => {
              const raw = c.a || c.id.split(':::')[0] || '';
              // Use splitArtists so "feat"/"ft"/"x"/"&"/parenthesized credits
              // match the same way the worker's candidate-level filter does.
              const credits = splitArtists(raw).map(s => s.toLowerCase().trim());
              return arts.some(a => credits.includes(a));
            });
          }
          if (params.djs) {
            const djs = params.djs.map(d => d.toLowerCase().trim());
            deduped = deduped.filter(c => {
              const seedDjs = (c.d || []).map(d => d.toLowerCase());
              return djs.some(d => seedDjs.includes(d));
            });
          }
          // When there are many results, show artwork crates first for visual quality.
          // Small result sets show everything equally so no results feel buried.
          const ART_BIAS_THRESHOLD = CLUSTERS_PER_PAGE * 3;
          const withArt = deduped.filter(c => c.artworks && c.artworks.length > 0);
          const noArt = deduped.filter(c => !c.artworks || c.artworks.length === 0);
          let pool;
          if (withArt.length >= ART_BIAS_THRESHOLD) {
            for (let i = withArt.length - 1; i > 0; i--) {
              const j = Math.floor(rng() * (i + 1));
              [withArt[i], withArt[j]] = [withArt[j], withArt[i]];
            }
            for (let i = noArt.length - 1; i > 0; i--) {
              const j = Math.floor(rng() * (i + 1));
              [noArt[i], noArt[j]] = [noArt[j], noArt[i]];
            }
            pool = [...withArt, ...noArt];
          } else {
            pool = [...deduped];
            for (let i = pool.length - 1; i > 0; i--) {
              const j = Math.floor(rng() * (i + 1));
              [pool[i], pool[j]] = [pool[j], pool[i]];
            }
          }
          cratesPoolCache[key] = pool;
          return pool;
        });
      }
      return cratesPoolPromise;
    }

    // Request a page from the index (non-blocking, no worker call)
    function requestPage(col, row) {
      const key = `${col},${row}`;
      if (pages[key] || pendingPageKeys.has(key)) return;
      pendingPageKeys.add(key);

      // Assign a page number once per grid cell and reuse it on retry,
      // so a failed request doesn't skip clusters when it retries.
      if (pageNums[key] === undefined) pageNums[key] = pageIdCounter++;
      const pageNum = pageNums[key];
      const gen = cratesGeneration;  // capture generation at request time

      getCratesPool().then(pool => {
        // Discard if a reset happened since this request started
        if (gen !== cratesGeneration) { pendingPageKeys.delete(key); return; }
        const slice = pool.slice(pageNum * CLUSTERS_PER_PAGE, (pageNum + 1) * CLUSTERS_PER_PAGE);
        delete pageNums[key];
        if (slice.length > 0) {
          const items = slice.map(c => {
            const [artist, title] = c.id.split(':::');
            return { seedKey: c.id, artist: artist || '', title: title || '',
              artworks: c.artworks || [], neighborIds: c.n || [], artKeys: [], count: c.count, weight: c.weight };
          });
          if (isMobileView()) {
            items.forEach(it => { it.weight = Math.pow(it.weight, 2.2); });
            // Boost the largest cluster to ensure a hero crate
            if (items.length > 1) {
              const sorted = [...items].sort((a, b) => b.weight - a.weight);
              sorted[0].weight *= 1.6;
            }
          }
          cratesTreemap(items, pad, pad, vw - pad * 2, vh - pad * 2);
          receivePage(col, row, items);
        } else {
          receivePage(col, row, []);
        }
      }).catch(err => {
        console.error('Crates index failed:', err.message);
        pendingPageKeys.delete(key); // pageNums[key] kept — same number used on retry
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
      const mobile = isMobileView();
      let splitH = mobile ? (crateRand() > 0.5) : (w >= h);
      // On mobile, prevent splits that create children with extreme aspect ratios
      if (mobile) {
        const maxRatio = 2.5;
        if (splitH) {
          const minW = Math.min(w * ratio, w * (1 - ratio));
          if (h / minW > maxRatio) splitH = false;
        } else {
          const minH = Math.min(h * ratio, h * (1 - ratio));
          if (w / minH > maxRatio) splitH = true;
        }
      }
      if (splitH) {
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
      if (pages[key]) return;
      if (clusters.length === 0) {
        pages[key] = { col, row, el: null, stacks: [], artLoaded: false, mounted: false, empty: true };
        poolExhausted = true;
        return;
      }
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

      const page = { col, row, clusters, el: container, stacks, artLoaded: false, mounted: true };
      pages[key] = page;
      // Load art if page is near viewport
      updateVisibleForPage(key, page);

      // Hide loading spinner once first page renders
      const cratesLoading = document.getElementById('crates-loading');
      if (!cratesLoading.classList.contains('hidden')) {
        cratesLoading.classList.add('hidden');
      }
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
      if (!page.mounted || page.artLoaded) return;
      page.artLoaded = true;
      page.stacks.forEach(({ el: stackEl, item }) => {
        const cards = stackEl.querySelectorAll('.crate-card');
        const last = cards.length - 1;
        let pending = 0;
        const reveal = () => {
          if (--pending > 0) return;
          // All images loaded — reveal entire stack at once to prevent jitter
          cards.forEach(card => {
            if (card.querySelector('img')) {
              card.style.background = '';
              card.classList.remove('placeholder');
            }
          });
        };
        const seedHasArt = item.artworks.length > item.neighborIds.length;
        cards.forEach((card, i) => {
          // Correct index into packed artworks array
          let artIdx;
          if (i === last) artIdx = seedHasArt ? 0 : -1;
          else artIdx = seedHasArt ? 1 + i : i;
          const url = (artIdx >= 0 && item.artworks[artIdx]) || null;
          if (url) {
            pending++;
            const img = document.createElement('img');
            img.src = url.replace('-t500x500', '-t120x120');
            img.draggable = false;
            img.onload = reveal;
            img.onerror = reveal;
            card.insertBefore(img, card.firstChild);
          } else {
            // No artwork — show gradient, remove placeholder shimmer
            card.classList.remove('placeholder');
          }
        });
      });
    }

    // Strip artwork images from a page to free memory
    function unloadPageArt(page) {
      if (!page.mounted || !page.artLoaded) return;
      page.artLoaded = false;
      page.stacks.forEach(({ el: stackEl, item }) => {
        const cards = stackEl.querySelectorAll('.crate-card');
        cards.forEach((card, i) => {
          const img = card.querySelector('img');
          if (img) {
            img.remove();
            // Restore simple placeholder for cards that had artwork
            const base = 148 + ((i * 17 + 3) % 40) - 20;
            card.style.background = `rgb(${base}, ${base - 4}, ${base - 8})`;
            card.classList.add('placeholder');
          }
          // Cards without art keep their gradient — no change needed
        });
      });
    }

    function unmountPage(page) {
      if (!page.mounted) return;
      // Reset any stuck hover states before removing from DOM
      page.el.querySelectorAll('.crate-stack.hovered').forEach(s => {
        s.dispatchEvent(new MouseEvent('mouseleave'));
      });
      page.el.remove();
      page.mounted = false;
    }

    function mountPage(page) {
      if (page.mounted) return;
      surface.appendChild(page.el);
      page.mounted = true;
    }

    let visibleTimer = null;
    function scheduleUpdateVisible() {
      if (visibleTimer) return;
      visibleTimer = setTimeout(() => {
        visibleTimer = null;
        updateVisible();
      }, 200);
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

      for (const page of Object.values(pages)) {
        if (page.empty) continue;
        const c = page.col, r = page.row;
        const near = c >= colVis0 - 1 && c <= colVis1 + 1 && r >= rowVis0 - 1 && r <= rowVis1 + 1;
        const artFar = c < colMin - 3 || c > colMax + 3 || r < rowMin - 3 || r > rowMax + 3;
        const domFar = c < colMin - 5 || c > colMax + 5 || r < rowMin - 5 || r > rowMax + 5;
        if (domFar) {
          unloadPageArt(page);
          unmountPage(page);
        } else {
          if (!page.mounted) mountPage(page);
          if (near) loadPageArt(page);
          else if (artFar) unloadPageArt(page);
        }
      }
    }

    // Clamp pan so content stays visible when results are limited.
    // Computes bounds lazily from the pages dict — zero interference with rendering.
    function clampPan() {
      if (!poolExhausted) return;
      // Scan pages for content bounds
      let cMinCol = Infinity, cMaxCol = -Infinity, cMinRow = Infinity, cMaxRow = -Infinity;
      for (const p of Object.values(pages)) {
        if (p.empty) continue;
        cMinCol = Math.min(cMinCol, p.col);
        cMaxCol = Math.max(cMaxCol, p.col);
        cMinRow = Math.min(cMinRow, p.row);
        cMaxRow = Math.max(cMaxRow, p.row);
      }
      if (cMinCol === Infinity) return; // no content pages
      const viewW = vw / crateScale, viewH = vh / crateScale;
      const cMinX = cMinCol * vw, cMaxX = (cMaxCol + 1) * vw;
      const cMinY = cMinRow * vh, cMaxY = (cMaxRow + 1) * vh;
      const margin = vw * 0.08;
      const headerH = (document.getElementById('filter-row')?.offsetHeight || 0)
                    + (document.getElementById('mode-tabs')?.offsetHeight || 0);
      const topMargin = margin + headerH / crateScale;
      // Don't pan past content edges (+ margin)
      targetPanX = Math.min(targetPanX, -cMinX + margin);
      targetPanX = Math.max(targetPanX, -(cMaxX - viewW) - margin);
      targetPanY = Math.min(targetPanY, -cMinY + topMargin);
      targetPanY = Math.max(targetPanY, -(cMaxY - viewH) - margin);
    }

    // Pan state
    let crateScale = isMobileView() ? 0.75 : 0.8;
    let panX = 0, panY = 0;
    let targetPanX = 0, targetPanY = 0, targetScale = crateScale;
    let rafPanId = null;
    function requestPanFrame() {
      if (rafPanId) return;
      rafPanId = requestAnimationFrame(() => {
        rafPanId = null;
        if (cratesView.classList.contains('hidden')) return;
        panX = targetPanX; panY = targetPanY; crateScale = targetScale;
        applyTransform();
        scheduleUpdateVisible();
      });
    }
    surface.style.transform = `scale3d(${crateScale},${crateScale},1) translate3d(${panX}px,${panY}px,0)`;

    // Drag-to-pan
    let isDragging = false, didDrag = false, dragStartX, dragStartY, panStartX, panStartY;
    const DRAG_THRESHOLD = 5;
    cratesView.onmousedown = e => {
      isDragging = true; didDrag = false;
      dragStartX = e.clientX; dragStartY = e.clientY;
      // Use targetPan* not panX/panY — panX may lag behind targetPanX if a rAF is pending
      panStartX = targetPanX; panStartY = targetPanY;
    };
    cratesView.onmousemove = e => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
      if (!didDrag && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        didDrag = true;
        cratesView.classList.add('dragging');
      }
      if (didDrag) {
        targetPanX = panStartX + dx; targetPanY = panStartY + dy;
        clampPan();
        requestPanFrame();
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
      // Dampen small deltas (macOS trackpad inertial tail)
      const dx = Math.abs(e.deltaX) < 1 ? 0 : e.deltaX;
      const dy = Math.abs(e.deltaY) < 1 ? 0 : e.deltaY;
      if (dx === 0 && dy === 0) return;
      targetPanX -= dx; targetPanY -= dy;
      clampPan();
      requestPanFrame();
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
        // Cancel any running momentum — it would keep updating panX/panY while we pinch
        if (momentumId) { cancelAnimationFrame(momentumId); momentumId = null; }
        // Reset drag state so touchend doesn't restart momentum after the pinch ends
        touchDidDrag = false; velX = 0; velY = 0;
        // Use targetScale not crateScale — crateScale may lag if a rAF is still pending
        pinchStartScale = targetScale;
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
        // Use targetPan* not panX/panY — panX may lag behind targetPanX if a rAF is pending
        touchPanStartX = targetPanX;
        touchPanStartY = targetPanY;
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
        targetScale = Math.max(0.6, Math.min(2, pinchStartScale * (dist / lastPinchDist)));
        requestPanFrame();
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
          velX = (cx - lastTouchX) / dt * 22;
          velY = (cy - lastTouchY) / dt * 22;
          lastTouchX = cx; lastTouchY = cy; lastTouchTime = now;
          targetPanX = touchPanStartX + dx;
          targetPanY = touchPanStartY + dy;
          clampPan();
          requestPanFrame();
        }
      }
    }, { passive: false });

    function momentumStep() {
      // Stop if crates view was hidden (e.g. user switched to Tracks mid-momentum)
      if (cratesView.classList.contains('hidden')) { momentumId = null; return; }
      // Velocity-dependent friction: coast further at low speed, same feel at high speed
      const speed = Math.sqrt(velX * velX + velY * velY);
      const t = Math.min(speed / 12, 1); // 0 at low speed, 1 at ≥12px/frame
      const friction = 0.96 - 0.03 * t;  // 0.96 low-speed → 0.93 high-speed
      velX *= friction;
      velY *= friction;
      if (Math.abs(velX) < 0.5 && Math.abs(velY) < 0.5) {
        momentumId = null;
        updateVisible();
        return;
      }
      panX += velX;
      panY += velY;
      targetPanX = panX; targetPanY = panY;
      clampPan();
      panX = targetPanX; panY = targetPanY;
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
      } else if (e.touches.length === 1 && !touchDragging) {
        // One finger stayed down after pinch — re-arm single-finger pan
        touchDragging = true;
        touchDidDrag = false;
        velX = 0; velY = 0;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        lastTouchX = touchStartX;
        lastTouchY = touchStartY;
        lastTouchTime = performance.now();
        touchPanStartX = targetPanX;
        touchPanStartY = targetPanY;
      }
    });

    cratesView.addEventListener('touchcancel', () => {
      pinchActive = false;
      touchDragging = false;
      touchDidDrag = false;
      velX = 0; velY = 0;
      cratesView.classList.remove('dragging');
      if (momentumId) { cancelAnimationFrame(momentumId); momentumId = null; }
    });

    // Suppress click after touch drag
    cratesView.addEventListener('click', e => {
      if (touchDidDrag) { e.stopPropagation(); touchDidDrag = false; }
    }, true);

    // Expose reset for filter changes — clears everything and re-requests
    window._cratesResetFn = function() {
      cratesGeneration++;
      cratesPoolCache = {};
      cratesPoolPromise = null;
      cratesFilterKey = '';
      pendingPageKeys.clear();
      for (const k in pageNums) delete pageNums[k];
      pageIdCounter = 0;
      for (const k in pages) {
        if (pages[k].el) pages[k].el.remove();
        delete pages[k];
      }
      minCol = 0; maxCol = 0; minRow = 0; maxRow = 0;
      poolExhausted = false;
      panX = 0; panY = 0; targetPanX = 0; targetPanY = 0;
      crateScale = isMobileView() ? 0.75 : 0.8; targetScale = crateScale;
      applyTransform();
      const cl = document.getElementById('crates-loading');
      cl.classList.remove('hidden');
      cl.style.visibility = 'visible';
      updateVisible();
    };

    // Initial render
    updateVisible();
    console.log('Crates: initialized');
  }

  // Switch mode UI without side-effects (no shuffle, no reveal animation)
  function switchToMode(mode) {
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll(`.mode-tab[data-mode="${mode}"]`).forEach(t => t.classList.add('active'));
    document.getElementById('tracks-view').classList.toggle('hidden', mode !== 'tracks');
    document.getElementById('crates-view').classList.toggle('hidden', mode !== 'crates');
    document.body.classList.toggle('crates-mode', mode === 'crates');
    if (mode === 'crates') {
      requestAnimationFrame(() => initCrates());
      document.getElementById('tracks-helper-toast')?.classList.remove('visible');
      // Restore any faded-out crate stacks from a previous transition
      document.querySelectorAll('.crate-stack.fade-out').forEach(s => {
        s.classList.remove('fade-out');
        s.style.opacity = '';
      });
    }
    if (mode === 'tracks') {
      document.getElementById('crates-helper-toast')?.classList.remove('visible');
      window._tracksRevealed = true;
    }
  }

  // Mobile: move highlight immediately on touchstart (before 300ms click delay)
  document.querySelectorAll('#mobile-mode-tabs .mode-tab').forEach(tab => {
    tab.addEventListener('touchstart', () => {
      document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll(`.mode-tab[data-mode="${tab.dataset.mode}"]`).forEach(t => t.classList.add('active'));
    }, { passive: true });
  });

  // Wire mode tabs
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll(`.mode-tab[data-mode="${tab.dataset.mode}"]`).forEach(t => t.classList.add('active'));
      const mode = tab.dataset.mode;
      document.getElementById('tracks-view').classList.toggle('hidden', mode !== 'tracks');
      document.getElementById('crates-view').classList.toggle('hidden', mode !== 'crates');
      document.body.classList.toggle('crates-mode', mode === 'crates');
      // Push URL for mode change
      if (mode === 'crates') {
        history.pushState(null, '', '/dig' + location.search);
      } else {
        history.pushState(null, '', '/shuffle' + location.search + (currentRootId ? '#' + encodeURIComponent(currentRootId) : ''));
      }
      // Lazy init crates — defer so tab switch is instant
      if (mode === 'crates') {
        trackEvent('crates');
        // Show loading spinner if crates haven't initialized yet
        if (!cratesInitialized) {
          const cl = document.getElementById('crates-loading');
          cl.classList.remove('hidden');
          cl.style.visibility = 'visible';
        }
        requestAnimationFrame(() => initCrates());
        // Reset crates with current filters (may have changed in Shuffle)
        if (cratesInitialized && window._cratesResetFn) window._cratesResetFn();
        showHelper(cratesHelperToast, 'b2b-crates-helper-dismissed');
        // Restore any faded-out crate stacks from a previous transition
        document.querySelectorAll('.crate-stack.fade-out').forEach(s => {
          s.classList.remove('fade-out');
          s.style.opacity = '';
        });
      }
      // Hide the other mode's toast when switching
      if (mode === 'tracks') {
        cratesHelperToast.classList.remove('visible');
        // First visit: fade in after shuffle loads
        if (!window._tracksRevealed) {
          window._tracksRevealed = true;
          const tv = document.getElementById('tracks-view');
          tv.classList.add('reveal-loading');
          shuffle().then(() => {
            tv.classList.remove('reveal-loading');
            tv.classList.add('reveal-fade');
            setTimeout(() => tv.classList.remove('reveal-fade'), 500);
          });
        } else {
          // Subsequent: instant, no transition
          if (currentCluster) {
            requestAnimationFrame(() => showCluster(currentCluster));
          } else {
            shuffle();
          }
          document.querySelectorAll('.connection-path').forEach(p => {
            p.style.animation = 'none';
            p.style.strokeDasharray = 'none';
            p.style.strokeDashoffset = '0';
          });
        }
      }
      if (mode === 'crates') tracksHelperToast.classList.remove('visible');
      // Auto-open filter bar in Dig if filters are active
      if (mode === 'crates' && mobileFilterBar) {
        const hasFilters = genreFilters.length > 0 || searchFilters.length > 0 || djSearchFilters.length > 0 || clusterArtistFilters.length > 0 || clusterDjFilters.length > 0;
        if (hasFilters) {
          mobileFilterBar.classList.remove('collapsed');
          if (filterToggle) filterToggle.classList.add('active');
        }
      }
    });
  });

  // Genre pills toggle
  const showGenresCheckbox = document.getElementById('show-genres');
  showGenresCheckbox.checked = true;
  showGenresCheckbox.addEventListener('change', () => {
    if (currentCluster) showCluster(currentCluster);
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

  // Default to crates (Dig) mode — init crates on first load (unless URL says /shuffle)
  if (!startInShuffle && !hashId) {
    requestAnimationFrame(() => initCrates());
    showHelper(cratesHelperToast, 'b2b-crates-helper-dismissed');
  }

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

  // ── Accent color picker ──
  const accentPicker = document.getElementById('accent-picker');
  const accentHex = document.getElementById('accent-hex');
  const accentPresets = document.getElementById('accent-presets');
  const presetColors = [
    '#3c3cfa', '#4a95f8', '#e05252', '#e0529b',
    '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b',
    '#6366f1', '#ec4899', '#14b8a6', '#f97316',
  ];

  // Get hue (0-360) from a hex color
  function hexToHue(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === min) return 0;
    let h;
    const d = max - min;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return h * 360;
  }

  function applyAccent(hex) {
    document.documentElement.style.setProperty('--accent', hex);
    document.body.style.setProperty('--accent', hex);
    // Re-derive all color-mix tokens (needed because they were computed with old accent)
    const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim();
    const border = getComputedStyle(document.body).getPropertyValue('--card-border').trim();
    const mixes = {
      '--accent-wash': `color-mix(in oklch, ${hex} 10%, ${bg})`,
      '--accent-wash-hover': `color-mix(in oklch, ${hex} 16%, ${bg})`,
      '--accent-wash-active': `color-mix(in oklch, ${hex} 22%, ${bg})`,
      '--accent-wash-border': `color-mix(in oklch, ${hex} 20%, ${border})`,
      '--accent-bold': `color-mix(in oklch, ${hex} 80%, black)`,
      '--accent-border': `color-mix(in oklch, ${hex} 45%, transparent)`,
      '--accent-fill-soft': `color-mix(in oklch, ${hex} ${document.body.classList.contains('night') ? 40 : 30}%, white)`,
    };
    for (const [k, v] of Object.entries(mixes)) {
      document.body.style.setProperty(k, v);
    }

    // Update mobile SC widget hue-rotate to match new accent
    // SC player default is orange (#f50, hue ~14deg)
    const scWidget = document.getElementById('sc-widget');
    if (scWidget) {
      const accentHueVal = hexToHue(hex);
      const SC_DEFAULT_HUE = 14;
      const rotation = ((accentHueVal - SC_DEFAULT_HUE) + 360) % 360;
      if (document.body.classList.contains('night')) {
        scWidget.style.filter = `invert(0.88) hue-rotate(${rotation}deg) saturate(3)`;
      } else {
        scWidget.style.filter = `hue-rotate(${rotation}deg)`;
      }
    }

    accentPicker.value = hex;
    accentHex.textContent = hex;
  }

  // Sync picker on open with current accent
  const isNight = document.body.classList.contains('night');
  accentPicker.value = isNight ? '#4a95f8' : '#3c3cfa';
  accentHex.textContent = accentPicker.value;

  accentPicker.addEventListener('input', (e) => applyAccent(e.target.value));

  // Build preset swatches
  presetColors.forEach(c => {
    const swatch = document.createElement('button');
    swatch.style.cssText = `width:22px;height:22px;border-radius:50%;border:2px solid var(--card-border);background:${c};cursor:pointer;padding:0;`;
    swatch.title = c;
    swatch.addEventListener('click', () => applyAccent(c));
    accentPresets.appendChild(swatch);
  });

  // ── Card context menu (DJ name click) ──
  const ctxMenu = document.getElementById('card-context-menu');
  const ctxItems = {
    viewTrack: ctxMenu.querySelector('[data-action="view-track"]'),
    dj: ctxMenu.querySelector('[data-action="filter-dj"]'),
    artist: ctxMenu.querySelector('[data-action="filter-artist"]'),
    genre: ctxMenu.querySelector('[data-action="filter-genre"]'),
    sep: ctxMenu.querySelector('.ctx-separator'),
    viewSet: ctxMenu.querySelector('[data-action="view-set"]'),
  };
  let ctxData = {};
  let ctxActiveDots = null;

  const CTX_SELECTOR = '.dj-line a[data-dj], .dj-line .dj-ctx-trigger, .artist-ctx-trigger[data-artist], .track-ctx-trigger[data-artist], .card-dots[data-artist]';

  const allCtxEls = Object.values(ctxItems);

  function reorderCtxMenu(source) {
    allCtxEls.forEach(el => el.style.display = 'none');
    const frag = document.createDocumentFragment();
    let visible;
    if (source === 'genre') {
      visible = [ctxItems.genre];
    } else {
      // Every card / name trigger shows the same menu in the same order:
      // View set, View track, ── , Filter for artist, Filter for DJ.
      // The two View items only appear when their URL is available.
      const top = [];
      if (ctxData.set) top.push(ctxItems.viewSet);
      if (ctxData.track) top.push(ctxItems.viewTrack);
      visible = top.length
        ? [...top, ctxItems.sep, ctxItems.artist, ctxItems.dj]
        : [ctxItems.artist, ctxItems.dj];
    }
    visible.forEach(el => { el.style.display = ''; frag.append(el); });
    ctxMenu.append(frag);
  }

  function positionCtxMenu(x, y) {
    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top = y + 'px';
    ctxMenu.classList.add('open');
    requestAnimationFrame(() => {
      const rect = ctxMenu.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8)
        ctxMenu.style.left = (window.innerWidth - rect.width - 8) + 'px';
      if (rect.bottom > window.innerHeight - 8)
        ctxMenu.style.top = (window.innerHeight - rect.height - 8) + 'px';
    });
  }

  function getSource(trigger) {
    if (trigger.classList.contains('card-dots')) return 'card';
    if (trigger.classList.contains('track-ctx-trigger')) return 'track';
    if (trigger.classList.contains('artist-ctx-trigger')) return 'artist';
    return 'dj';
  }

  function openCtxMenu(e, trigger, source) {
    e.preventDefault();
    e.stopPropagation();

    // If clicking the same dots that's already open, close instead
    if (trigger.classList.contains('card-dots') && ctxActiveDots === trigger) {
      closeCtxMenu();
      return;
    }
    if (ctxActiveDots) ctxActiveDots.classList.remove('dots-open');
    ctxData = { dj: trigger.dataset.dj, artist: trigger.dataset.artist, set: trigger.dataset.setUrl || '', track: trigger.dataset.trackUrl || '' };
    reorderCtxMenu(source);
    if (trigger.classList.contains('card-dots')) {
      trigger.classList.add('dots-open');
      ctxActiveDots = trigger;
    }
    // Position below the card on mobile, at click point otherwise
    if (isMobileView() && trigger.classList.contains('card-dots')) {
      const card = trigger.closest('.mobile-carousel-card');
      if (card) {
        const rect = card.getBoundingClientRect();
        positionCtxMenu(16, rect.bottom + 6);
      } else {
        positionCtxMenu(e.clientX, e.clientY);
      }
    } else {
      positionCtxMenu(e.clientX, e.clientY);
    }
  }

  function closeCtxMenu() {
    ctxMenu.classList.remove('open');
    if (ctxActiveDots) { ctxActiveDots.classList.remove('dots-open'); ctxActiveDots = null; }
  }
  // Click handling (desktop + mobile)
  document.addEventListener('click', (e) => {
    // Genre pill click → open genre context menu
    const genrePill = e.target.closest('.mobile-genre-pill[data-genre], .desktop-genre-pill[data-genre]');
    if (genrePill) {
      e.preventDefault();
      e.stopPropagation();
  
      ctxData = { genre: genrePill.dataset.genre };
      ctxItems.genre.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg> Filter for ' + genrePill.dataset.genre;
      reorderCtxMenu('genre');
      if (isMobileView()) {
        const selCard = document.querySelector('.mobile-carousel-card.selected');
        if (selCard) {
          const rect = selCard.getBoundingClientRect();
          positionCtxMenu(16, rect.bottom + 6);
        } else {
          const rect = genrePill.getBoundingClientRect();
          positionCtxMenu(rect.left, rect.bottom + 6);
        }
      } else {
        const rect = genrePill.getBoundingClientRect();
        positionCtxMenu(rect.left, rect.top - 4);
      }
      return;
    }
    const trigger = e.target.closest(CTX_SELECTOR);
    if (trigger) {
      openCtxMenu(e, trigger, getSource(trigger));
      return;
    }
    if (!ctxMenu.contains(e.target)) closeCtxMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCtxMenu();
  });

  // Context menu actions
  ctxMenu.addEventListener('click', (e) => {
    if (e.target.closest('.ctx-close')) { closeCtxMenu(); return; }
    const item = e.target.closest('.ctx-item');
    if (!item) return;
    const action = item.dataset.action;

    if (action === 'view-track' && ctxData.track) {
      window.open(ctxData.track, '_blank', 'noopener');
    } else if (action === 'view-set' && ctxData.set) {
      window.open(ctxData.set, '_blank', 'noopener');
    } else if (action === 'filter-dj' && ctxData.dj) {
      filterCtrl.addDjFilter({ display: ctxData.dj });
    } else if (action === 'filter-artist' && ctxData.artist) {
      filterCtrl.addSearchFilter({ display: ctxData.artist });
    } else if (action === 'filter-genre' && ctxData.genre) {
      filterCtrl.toggleGenre(ctxData.genre);
    }

    closeCtxMenu();
  });

});
