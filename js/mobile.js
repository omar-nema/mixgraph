function mobileArtHtml(node) {
  const url = node.artUrl;
  if (url) return `<img class="album-art" src="${url}" loading="lazy">`;
  const [gArtist, gTitle] = (node.graphId || '').split(':::');
  return `<img class="album-art no-art" src="${gradientArtUrl(gTitle || node.title, gArtist || node.artist)}" loading="lazy">`;
}

function showClusterMobile(cluster) {
  stopCurrentPlayback();
  nodes = cluster.nodes;
  edges = cluster.edges;
  nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);
  currentRootId = cluster.nodes[0].graphId;
  document.getElementById('cluster-id').textContent = currentRootId;
  const target = '/shuffle#' + encodeURIComponent(currentRootId);
  if (location.pathname + location.hash !== target) history.pushState(null, '', target);
  logCluster(cluster);

  // Shuffle button above carousel
  const shuffleArea = document.getElementById('mobile-shuffle-area');
  const gc = typeof genreFilters !== 'undefined' ? genreFilters.length : 0;
  const ac = typeof searchFilters !== 'undefined' ? searchFilters.length : 0;
  const dc = typeof djSearchFilters !== 'undefined' ? djSearchFilters.length : 0;
  const hasFilters = gc + ac + dc > 0;
  shuffleArea.innerHTML = `<div class="mobile-shuffle-inner"><button class="mobile-filter-pill${gc > 0 ? ' active' : ''}" id="mobile-pill-genre">Genre</button><button class="mobile-filter-pill${ac > 0 ? ' active' : ''}" id="mobile-pill-artist">Artist</button><button class="mobile-filter-pill${dc > 0 ? ' active' : ''}" id="mobile-pill-dj">DJ</button><button class="mobile-shuffle"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg></button></div>`;
  const shuffleBtn = shuffleArea.querySelector('.mobile-shuffle');
  shuffleBtn.addEventListener('click', () => {
    shuffleBtn.classList.add('shuffling');
    carousel.querySelectorAll('.mobile-carousel-item').forEach(el => {
      el.classList.add('mobile-animate-out');
    });
    const sourcesEl = document.getElementById('mobile-sources');
    sourcesEl.classList.add('mobile-animate-out');
    setTimeout(() => {
      shuffleBtn.classList.remove('shuffling');
      shuffle();
    }, 250);
  });
  // Filter pill clicks toggle individual popovers
  const popoverBackdrop = document.getElementById('popover-backdrop');
  const popovers = {
    genre: document.getElementById('genre-popover'),
    artist: document.getElementById('artist-popover'),
    dj: document.getElementById('dj-popover'),
  };
  function closePopovers(andReshuffle) {
    const anyOpen = Object.values(popovers).some(p => p && p.classList.contains('open'));
    Object.values(popovers).forEach(p => { if (p) p.classList.remove('open'); });
    popoverBackdrop.classList.remove('open');
    document.querySelectorAll('.mobile-filter-pill').forEach(p => p.classList.remove('semi-open'));
    if (andReshuffle && anyOpen && filtersDirty) {
      filtersDirty = false;
      shuffle();
    }
  }
  function openPopover(name, pillEl) {
    const popover = popovers[name];
    if (!popover) return;
    const already = popover.classList.contains('open');
    closePopovers(false);
    if (already) {
      if (filtersDirty) { filtersDirty = false; shuffle(); }
      return;
    }
    // Position popover below the pill row
    const rect = pillEl.getBoundingClientRect();
    popover.style.top = (rect.bottom + 8) + 'px';
    popover.classList.add('open');
    popoverBackdrop.classList.add('open');
    if (pillEl) pillEl.classList.add('semi-open');
  }
  // Backdrop click handler is wired once at init in app.js (see #popover-backdrop).
  document.getElementById('mobile-pill-genre').addEventListener('click', function() {
    openPopover('genre', this);
    setTimeout(() => document.getElementById('genre-search').focus(), 100);
  });
  document.getElementById('mobile-pill-artist').addEventListener('click', function() {
    openPopover('artist', this);
    setTimeout(() => document.getElementById('find-search').focus(), 100);
  });
  document.getElementById('mobile-pill-dj').addEventListener('click', function() {
    openPopover('dj', this);
    setTimeout(() => document.getElementById('dj-search').focus(), 100);
  });

  const root = cluster.nodes.find(n => n.rank === 'root');
  const r1Nodes = cluster.nodes.filter(n => n.rank === '1').slice(0, 2);
  const r2Nodes = cluster.nodes.filter(n => n.rank === '2').slice(0, 2);

  // Build carousel: root first, then rank 1, then rank 2 (capped for mobile)
  // Tag R1 nodes with their index for context labels
  r1Nodes.forEach((n, i) => { n._r1Index = i; });
  const allCards = [root, ...r1Nodes, ...r2Nodes];
  const carousel = document.getElementById('mobile-carousel');
  carousel.innerHTML = '';
  allCards.forEach((node, i) => {
    const item = makeCarouselCard(node);
    item.classList.add('mobile-animate-in');
    item.style.animationDelay = `${i * 0.06}s`;
    carousel.appendChild(item);
  });

  // Scroll to root (first card), then flag titles that need to marquee
  requestAnimationFrame(() => {
    carousel.scrollTo({ left: 0, behavior: 'instant' });
    carousel.querySelectorAll('.mobile-carousel-card').forEach(setupMobileCardMarquees);
  });

  // Hide back button when user scrolls carousel
  const backBtn = carousel.parentElement.querySelector('.mc-back');
  if (backBtn) {
    carousel.addEventListener('scroll', () => {
      backBtn.style.opacity = carousel.scrollLeft > 10 ? '0' : '';
      backBtn.style.pointerEvents = carousel.scrollLeft > 10 ? 'none' : '';
    }, { passive: true });
  }

  // Auto-load first track with audio into SC widget (also sets source pills)
  const firstWithAudio = allCards.find(n => n.scTrackUrl || n.setUrl);
  if (firstWithAudio) {
    requestAnimationFrame(() => selectMobileTrack(firstWithAudio.id));
  }

  if (onClusterShown) onClusterShown();
}

function updateMobileSources(graphId) {
  const sourcesEl = document.getElementById('mobile-sources');
  sourcesEl.innerHTML = '';
  sourcesEl.classList.remove('mobile-animate-out');
  // Find the node in the current cluster by graphId
  const node = Object.values(nodeMap).find(n => n.graphId === graphId);
  if (!node) return;

  let setLink = null;
  if (node.setUrl && node.setSource !== 'mixcloud') {
    setLink = node.setUrl;
    if (node.setOffsetSec) {
      const m = Math.floor(node.setOffsetSec / 60);
      const s = node.setOffsetSec % 60;
      setLink += `#t=${m}m${s}s`;
    }
  }
  const sources = new Map();
  for (const dj of (node.djs || [])) {
    const name = dj.name;
    const url = setLink || dj.episodeUrl || '';
    if (name && url) {
      const key = `${name}|${url}`;
      if (!sources.has(key)) sources.set(key, { dj: name, url });
    }
  }
  if (sources.size > 0) {
    const row = document.createElement('div');
    row.className = 'mobile-source-row';
    const srcArray = [...sources.values()];
    const djLabel = document.createElement('span');
    djLabel.className = 'mobile-source-label';
    djLabel.textContent = 'Mixed by';
    row.appendChild(djLabel);
    const djWrap = document.createElement('span');
    djWrap.className = 'mobile-source-pills dj-line';
    srcArray.forEach((src, i) => {
      if (i > 0) djWrap.appendChild(document.createTextNode(', '));
      const pill = document.createElement('a');
      pill.className = 'mobile-source-pill';
      pill.href = src.url;
      pill.target = '_blank';
      pill.rel = 'noopener';
      pill.dataset.dj = src.dj;
      pill.dataset.artist = node.artist;
      pill.dataset.setUrl = src.url;
      pill.textContent = src.dj;
      djWrap.appendChild(pill);
    });
    row.appendChild(djWrap);
    // Genre names
    const genres = node.genres || [];
    if (genres.length > 0) {
      const sep = document.createElement('span');
      sep.className = 'mobile-source-sep';
      sep.textContent = '•';
      row.appendChild(sep);
      const genreLabel = document.createElement('span');
      genreLabel.className = 'mobile-source-label';
      genreLabel.textContent = 'Genres';
      row.appendChild(genreLabel);
      const genreWrap = document.createElement('span');
      genreWrap.className = 'mobile-genre-pills';
      genres.forEach((g, i) => {
        if (i > 0) genreWrap.appendChild(document.createTextNode(', '));
        const pill = document.createElement('span');
        pill.className = 'mobile-genre-pill';
        pill.dataset.genre = g;
        pill.textContent = g;
        genreWrap.appendChild(pill);
      });
      row.appendChild(genreWrap);
    }
    sourcesEl.appendChild(row);
  }
}

// Polls the SC widget's real play/pause state so .playing (which gates the
// title/artist marquee) tracks what's actually audible. The SC widget's PAUSE
// event is unreliable on mobile, so we can't drive .playing off events alone.
let mobilePlayPoll = null;
function stopMobilePlayPoll() {
  if (mobilePlayPoll) { clearInterval(mobilePlayPoll); mobilePlayPoll = null; }
}
function startMobilePlayPoll(card) {
  stopMobilePlayPoll();
  if (!card) return;
  mobilePlayPoll = setInterval(() => {
    // Card gone or superseded by another selection → stop tracking it.
    if (!card.isConnected || !card.classList.contains('selected') || !scWidget) {
      stopMobilePlayPoll();
      return;
    }
    scWidget.isPaused(paused => {
      card.classList.toggle('playing', !paused);
    });
  }, 350);
}

// Mobile: select a card to load it into the SC widget. No play/pause
// on the card itself — user taps play in the SC widget below.
function selectMobileTrack(nodeId) {
  const node = nodeMap[nodeId];
  if (!node) return;
  const hasAudio = !!(node.scTrackUrl || node.setUrl);
  if (!hasAudio) return;

  const source = getSelectedAudioSource(nodeId);
  const useMix = source === 'mix';

  trackEvent('play');

  // Update source pills for this track
  updateMobileSources(node.graphId);

  // Deselect previous
  stopMobilePlayPoll();
  document.querySelectorAll('.mobile-carousel-card.selected, .mobile-carousel-card.playing').forEach(c => {
    c.classList.remove('selected', 'loading', 'playing');
  });

  const card = document.querySelector(`.mobile-carousel-card[data-node-id="${nodeId}"]`);
  if (card) {
    card.classList.add('selected', 'loading');
    card.dataset.selectedSource = source || '';
  }

  // Mixcloud sets can't load in the SC widget — route them to the MC player.
  if (useMix && node.setSource === 'mixcloud') {
    if (card) card.classList.remove('loading');
    stopCurrentPlayback();
    playMixcloud(nodeId, node.setUrl, node.setOffsetSec);
    return;
  }

  // Load into SC widget
  if (!initSCWidget()) return;
  showScPlayer();

  scWidgetReady = false;
  stopMobilePlayPoll();
  scWidget.unbind(SC.Widget.Events.READY);
  scWidget.unbind(SC.Widget.Events.PLAY);
  scWidget.unbind(SC.Widget.Events.PAUSE);

  const url = useMix ? node.setUrl : node.scTrackUrl;
  // For sets, jump past the intro (e.g. NTS sting) when the track starts at 0:00.
  const offsetSec = useMix ? (node.setOffsetSec || 7) : 0;
  let didSeek = false;

  scWidget.bind(SC.Widget.Events.READY, () => {
    scWidgetReady = true;
    if (card) card.classList.remove('loading');
    // Poll the widget's real play/pause state (mobile PAUSE events are flaky).
    startMobilePlayPoll(card);
  });

  // Sync the .playing treatment (border + glow, title marquee) to the SC widget's
  // own PLAY/PAUSE events so it flips the instant audio starts/stops. The 350ms
  // poll above is a fallback for mobile Safari's unreliable PAUSE event.
  scWidget.bind(SC.Widget.Events.PLAY, () => {
    if (card && card.classList.contains('selected')) card.classList.add('playing');
    // On mobile Safari, seekTo only works once the user presses play — seek here.
    if (offsetSec && !didSeek) { didSeek = true; setTimeout(() => scWidget.seekTo(offsetSec * 1000), 500); }
  });
  scWidget.bind(SC.Widget.Events.PAUSE, () => {
    if (card) card.classList.remove('playing');
  });

  scWidget.load(url, { auto_play: true, show_artwork: false, visual: false, show_teaser: false, sharing: false, buying: false, show_user: true, color: 'B5705A' });
}

// Mobile titles are already single-line + ellipsis. If cut off, record the
// scroll distance so CSS can marquee it while the card is selected (playing).
function setupMobileCardMarquees(card) {
  ['.mc-title', '.mc-artist'].forEach(sel => {
    const line = card.querySelector(sel);
    if (line) applyMarquee(line);   // shared wrap-around helper (graph.js)
  });
}

function makeCarouselCard(node) {
  const item = document.createElement('div');
  item.className = 'mobile-carousel-item';
  item.dataset.rank = node.rank || '';

  const card = document.createElement('div');
  card.className = 'mobile-carousel-card';
  card.dataset.nodeId = node.id;
  card.dataset.rank = node.rank || '';
  const hasAudio = !!(node.scTrackUrl || node.setUrl);

  card.innerHTML = `
    <div class="mc-art-wrap">
      ${mobileArtHtml(node)}
      ${renderSourceToggle(node)}
    </div>
    <div class="mc-info-row">
      <div class="mc-info-text">
        <div class="mc-title"><span class="tt-inner">${node.title}</span></div>
        <div class="mc-artist"><span class="tt-inner">${node.artist}</span></div>
      </div>
      <button class="card-dots" aria-label="More options" data-artist="${node.artist}" data-dj="${(node.djs && node.djs.length) ? node.djs[0].name : ''}" data-set-url="${node.setUrl || (node.djs && node.djs.length ? node.djs[0].episodeUrl || '' : '')}" data-track-url="${node.scTrackUrl || ''}"><svg viewBox="0 0 24 24" fill="currentColor"><circle class="dot dot-top" cx="12" cy="5" r="1.5"/><circle class="dot dot-mid" cx="12" cy="12" r="1.5"/><circle class="dot dot-bot" cx="12" cy="19" r="1.5"/><line class="x-line" x1="8" y1="8" x2="16" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line class="x-line" x1="16" y1="8" x2="8" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </div>`;

  initSourceToggle(card, node);

  card.addEventListener('click', (e) => {
    if (e.target.closest('.mc-close')) {
      // Switch back to Dig mode
      document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.mode-tab[data-mode="crates"]').forEach(t => t.classList.add('active'));
      document.getElementById('tracks-view').classList.add('hidden');
      document.getElementById('crates-view').classList.remove('hidden');
      document.body.classList.add('crates-mode');
      document.querySelectorAll('.crate-stack.fade-out').forEach(s => { s.classList.remove('fade-out'); s.style.opacity = ''; });
      history.pushState(null, '', '/dig');
      return;
    }
    if (e.target.closest('.card-dots, .source-toggle')) return;
    // Scroll item to center if not already centered
    const carousel = document.getElementById('mobile-carousel');
    const itemCenter = item.offsetLeft + item.offsetWidth / 2;
    const viewCenter = carousel.scrollLeft + carousel.clientWidth / 2;
    if (Math.abs(itemCenter - viewCenter) > 20) {
      carousel.scrollTo({ left: item.offsetLeft - (carousel.clientWidth - item.offsetWidth) / 2, behavior: 'smooth' });
    }
    if (card.classList.contains('selected')) return;
    if (hasAudio) selectMobileTrack(node.id);
    else updateMobileSources(node.graphId);
  });

  let contextText = '';
  if (node.rank === 'root') contextText = 'if you like this track, swipe \u2192';
  else if (node.rank === '1') contextText = node._r1Index === 0 ? 'played before in same set' : 'played after in same set';
  else if (node.rank === '2') contextText = 'played 2 tracks away';
  if (contextText) {
    const label = document.createElement('div');
    label.className = 'mc-context';
    label.textContent = contextText;
    item.appendChild(label);
  }

  // Back arrow for root card (only if user came from Dig, not on direct link)
  if (node.rank === 'root' && window._cameFromDig) {
    const backBtn = document.createElement('button');
    backBtn.className = 'mc-back';
    backBtn.setAttribute('aria-label', 'Back to Dig');
    backBtn.innerHTML = '<span class="mc-back-arrow">\u2190</span> Back to Dig';
    backBtn.addEventListener('click', () => {
      document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.mode-tab[data-mode="crates"]').forEach(t => t.classList.add('active'));
      document.getElementById('tracks-view').classList.add('hidden');
      document.getElementById('crates-view').classList.remove('hidden');
      document.body.classList.add('crates-mode');
      document.querySelectorAll('.crate-stack.fade-out').forEach(s => { s.classList.remove('fade-out'); s.style.opacity = ''; });
      history.pushState(null, '', '/dig');
    });
    item.appendChild(backBtn);
  }

  item.appendChild(card);

  return item;
}
