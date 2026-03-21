function mobileArtHtml(node) {
  const cached = audioCache[node.graphId];
  const url = cached && cached.artUrl;
  if (url) return `<img class="album-art" src="${url}" loading="lazy">`;
  return `<div class="album-art no-art" style="background: ${generateGradient(node.title, node.artist)}"></div>`;
}

function showClusterMobile(cluster) {
  stopCurrentPlayback();
  clusterArtistFilters = [];
  clusterDjFilters = [];
  nodes = cluster.nodes;
  edges = cluster.edges;
  nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);
  currentRootId = cluster.nodes[0].graphId;
  document.getElementById('cluster-id').textContent = currentRootId;
  const newHash = '#' + encodeURIComponent(currentRootId);
  if (window.location.hash !== newHash) history.pushState(null, '', newHash);
  logCluster(cluster);

  // Shuffle button above carousel
  const shuffleArea = document.getElementById('mobile-shuffle-area');
  const gc = typeof genreFilters !== 'undefined' ? genreFilters.length : 0;
  const ac = typeof searchFilters !== 'undefined' ? searchFilters.length : 0;
  const dc = typeof djSearchFilters !== 'undefined' ? djSearchFilters.length : 0;
  const hasFilters = gc + ac + dc > 0;
  shuffleArea.innerHTML = `<button class="mobile-filter-pill${gc > 0 ? ' active' : ''}" id="mobile-pill-genre">Genre</button><button class="mobile-filter-pill${ac > 0 ? ' active' : ''}" id="mobile-pill-artist">Artist</button><button class="mobile-filter-pill${dc > 0 ? ' active' : ''}" id="mobile-pill-dj">DJ</button><button class="mobile-shuffle"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg></button>`;
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
  const mobileBackdrop = document.getElementById('mobile-popover-backdrop');
  const mobilePopovers = {
    genre: document.getElementById('mobile-genre-popover'),
    artist: document.getElementById('mobile-artist-popover'),
    dj: document.getElementById('mobile-dj-popover'),
  };
  function closeMobilePopovers() {
    Object.values(mobilePopovers).forEach(p => p.classList.remove('open'));
    mobileBackdrop.classList.remove('open');
  }
  function openMobilePopover(name, pillEl) {
    const already = mobilePopovers[name].classList.contains('open');
    closeMobilePopovers();
    if (already) return;
    // Position popover below the pill row
    const rect = pillEl.getBoundingClientRect();
    mobilePopovers[name].style.top = (rect.bottom + 8) + 'px';
    mobilePopovers[name].classList.add('open');
    mobileBackdrop.classList.add('open');
  }
  mobileBackdrop.addEventListener('click', closeMobilePopovers);
  document.getElementById('mobile-pill-genre').addEventListener('click', function() {
    openMobilePopover('genre', this);
  });
  document.getElementById('mobile-pill-artist').addEventListener('click', function() {
    openMobilePopover('artist', this);
    setTimeout(() => document.getElementById('mobile-find-search').focus(), 100);
  });
  document.getElementById('mobile-pill-dj').addEventListener('click', function() {
    openMobilePopover('dj', this);
    setTimeout(() => document.getElementById('mobile-dj-search').focus(), 100);
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

  // Scroll to root (first card)
  requestAnimationFrame(() => {
    carousel.scrollTo({ left: 0, behavior: 'instant' });
  });

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
  const gn = graphNodes[graphId];
  if (!gn || !gn.edges) return;
  const cached = audioCache[graphId];
  let setLink = null;
  if (cached && cached.setUrl && cached.setSource !== 'mixcloud') {
    setLink = cached.setUrl;
    if (cached.setOffsetSec) {
      const m = Math.floor(cached.setOffsetSec / 60);
      const s = cached.setOffsetSec % 60;
      setLink += `#t=${m}m${s}s`;
    }
  }
  const sources = new Map();
  for (const edge of gn.edges) {
    for (const ctx of (edge.contexts || [])) {
      const dj = (ctx.dj || '').trim();
      const url = setLink || ctx.episode_url || '';
      if (dj && url) {
        const key = `${dj}|${url}`;
        if (!sources.has(key)) sources.set(key, { dj, url });
      }
    }
  }
  if (sources.size > 0) {
    const row = document.createElement('div');
    row.className = 'mobile-source-row';
    const srcArray = [...sources.values()];
    const textSpan = document.createElement('span');
    textSpan.className = 'mobile-source-text';
    textSpan.innerHTML = 'Mixed by ' + srcArray.map(src =>
      `<a href="${src.url}" target="_blank" rel="noopener">${src.dj}</a>`
    ).join(', ');
    row.appendChild(textSpan);
    sourcesEl.appendChild(row);
  }
}

// Mobile: select a card to load it into the SC widget. No play/pause
// on the card itself — user taps play in the SC widget below.
function selectMobileTrack(nodeId) {
  const node = nodeMap[nodeId];
  if (!node) return;
  const hasAudio = !!(node.scTrackUrl || node.setUrl);
  if (!hasAudio) return;

  // Update source pills for this track
  updateMobileSources(node.graphId);

  // Deselect previous
  document.querySelectorAll('.mobile-carousel-card.selected').forEach(c => {
    c.classList.remove('selected', 'loading');
  });

  const card = document.querySelector(`.mobile-carousel-card[data-node-id="${nodeId}"]`);
  if (card) {
    card.classList.add('selected', 'loading');
  }

  // Load into SC widget
  if (!initSCWidget()) return;
  showScPlayer();

  scWidgetReady = false;
  scWidget.unbind(SC.Widget.Events.READY);

  // Prefer individual track, fall back to set
  const url = node.scTrackUrl || node.setUrl;
  const offsetSec = !node.scTrackUrl && node.setOffsetSec ? node.setOffsetSec : 0;

  scWidget.bind(SC.Widget.Events.READY, () => {
    scWidgetReady = true;
    if (card) card.classList.remove('loading');
  });

  // On mobile Safari, seekTo doesn't work until the user presses play.
  // Seek after PLAY event fires instead of after READY.
  if (offsetSec) {
    scWidget.unbind(SC.Widget.Events.PLAY);
    scWidget.bind(SC.Widget.Events.PLAY, () => {
      setTimeout(() => scWidget.seekTo(offsetSec * 1000), 500);
      scWidget.unbind(SC.Widget.Events.PLAY);
    });
  }

  scWidget.load(url, { auto_play: true, show_artwork: false, visual: false, show_teaser: false, sharing: false, buying: false, show_user: true, color: 'B5705A' });
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
    </div>
    <div class="mc-title">${node.title}</div>
    <div class="mc-artist">${node.artist}</div>`;

  card.addEventListener('click', () => {
    // Scroll item to center if not already centered
    const carousel = document.getElementById('mobile-carousel');
    const itemCenter = item.offsetLeft + item.offsetWidth / 2;
    const viewCenter = carousel.scrollLeft + carousel.clientWidth / 2;
    if (Math.abs(itemCenter - viewCenter) > 20) {
      carousel.scrollTo({ left: item.offsetLeft - (carousel.clientWidth - item.offsetWidth) / 2, behavior: 'smooth' });
    }
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

  item.appendChild(card);

  return item;
}
