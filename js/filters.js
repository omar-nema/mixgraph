// ═══════════════════════════════════════════
// Filter & search — indexes, autocomplete, UI
// ═══════════════════════════════════════════

function splitArtists(raw) {
  // Split multi-artist strings: "A, B" "A Feat B" "A Ft. B" "A X B" "A & B" "A (B)" → [A, B]
  // First extract parenthetical artists like "Faro (Oklou & Malibu)" → ["Faro", "Oklou", "Malibu"]
  let names = [];
  const parenMatch = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    names.push(parenMatch[1].trim());
    raw = parenMatch[2].trim();
  }
  // Split on feat/ft./x/,/&/+
  const parts = raw.split(/\s*,\s*|\s+[Ff]eat\.?\s+|\s+[Ff]t\.?\s+|\s+[Xx]\s+|\s*[&+]\s*|\s+and\s+/);
  for (const p of parts) {
    const trimmed = p.trim();
    if (trimmed) names.push(trimmed);
  }
  return names.length ? names : [raw];
}

function initFilters() {
  // ── Build search indexes ──
  // Collect all artist name variants and count occurrences to pick canonical casing
  const caseCounts = {};
  artistIndex = {};
  for (const [id, node] of Object.entries(graphNodes)) {
    const artist = (node.artist || '').trim();
    if (!artist) continue;
    for (const name of splitArtists(artist)) {
      const key = name.toLowerCase();
      caseCounts[key] = caseCounts[key] || {};
      caseCounts[key][name] = (caseCounts[key][name] || 0) + 1;
      if (!artistIndex[key]) artistIndex[key] = { display: name, trackIds: [] };
      artistIndex[key].trackIds.push(id);
    }
  }
  // Normalize display name to most frequent casing
  for (const [key, variants] of Object.entries(caseCounts)) {
    let best = '', bestCount = 0;
    for (const [name, count] of Object.entries(variants)) {
      if (count > bestCount) { best = name; bestCount = count; }
    }
    if (artistIndex[key]) artistIndex[key].display = best;
  }
  const candidateSet = new Set(candidates);
  artistListAlpha = Object.values(artistIndex)
    .map(e => ({ ...e, clusterCount: e.trackIds.filter(id => candidateSet.has(id)).length }))
    .sort((a, b) => b.trackIds.length - a.trackIds.length)
    .sort((a, b) => a.display.localeCompare(b.display));
  console.log(`Artist index: ${Object.keys(artistIndex).length} unique artists`);

  djIndex = {};
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
  djListAlpha = Object.values(djIndex)
    .map(e => {
      const ids = [...e.trackIds];
      return { display: e.display, trackIds: ids, clusterCount: ids.filter(id => candidateSet.has(id)).length };
    })
    .sort((a, b) => b.trackIds.length - a.trackIds.length)
    .sort((a, b) => a.display.localeCompare(b.display));
  console.log(`DJ index: ${Object.keys(djIndex).length} unique DJs`);

  // ── Build episode index ──
  episodeIndex = {};
  for (const [id, node] of Object.entries(graphNodes)) {
    for (const edge of (node.edges || [])) {
      for (const ctx of (edge.contexts || [])) {
        const url = (ctx.episode_url || '').trim();
        if (!url) continue;
        if (!episodeIndex[url]) episodeIndex[url] = new Set();
        episodeIndex[url].add(id);
        episodeIndex[url].add(edge.node);
      }
    }
  }
  console.log(`Episode index: ${Object.keys(episodeIndex).length} unique episodes`);

  // ── Build genre index ──
  const genreIndex = {};
  for (const [id, node] of Object.entries(graphNodes)) {
    for (const g of (node.genres || [])) {
      if (!genreIndex[g]) genreIndex[g] = 0;
      genreIndex[g]++;
    }
  }
  const genreList = Object.entries(genreIndex)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const displayGenres = genreList.slice(0, 30);
  console.log(`Genre index: ${genreList.length} genres, showing top ${displayGenres.length}`);

  // ── Shared helpers ──
  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

  // ── Filter state management ──
  function modifyFilter(arr, action, renderDesktop, renderMobile) {
    action(arr);
    shuffleHistory.clear();
    renderDesktop();
    renderMobile();
    updateFilterUI();
    updateClusterPills();
  }

  function addSearchFilter(entry) {
    if (searchFilters.some(f => f.display === entry.display)) return;
    modifyFilter(searchFilters, a => a.push({ display: entry.display, trackIds: entry.trackIds }), renderFindChips, renderMobileFindChips);
  }

  function removeSearchFilter(index) {
    modifyFilter(searchFilters, a => a.splice(index, 1), renderFindChips, renderMobileFindChips);
  }

  function addDjFilter(entry) {
    if (djSearchFilters.some(f => f.display === entry.display)) return;
    modifyFilter(djSearchFilters, a => a.push({ display: entry.display, trackIds: entry.trackIds }), renderDjChips, renderMobileDjChips);
  }

  function removeDjFilter(index) {
    modifyFilter(djSearchFilters, a => a.splice(index, 1), renderDjChips, renderMobileDjChips);
  }

  function toggleGenre(name) {
    const idx = genreFilters.indexOf(name);
    if (idx >= 0) {
      genreFilters.splice(idx, 1);
    } else {
      genreFilters.push(name);
    }
    shuffleHistory.clear();
    document.querySelectorAll('.genre-pill').forEach(p => {
      p.classList.toggle('selected', genreFilters.includes(p.dataset.genre));
    });
    updateFilterUI();
  }

  function clearAllFilters() {
    searchFilters = [];
    djSearchFilters = [];
    clusterArtistFilters = [];
    clusterDjFilters = [];
    genreFilters = [];
    shuffleHistory.clear();
    document.querySelectorAll('.genre-pill.selected').forEach(p => p.classList.remove('selected'));
    renderAllChips();
    updateFilterUI();
    updateClusterPills();
  }

  // Shared helper: update a pill's active state, count, and clear button
  function updatePillState(pillId, countId, clearId, count) {
    const pill = document.getElementById(pillId);
    if (pill) {
      pill.classList.toggle('active', count > 0);
      if (countId) {
        const el = document.getElementById(countId);
        if (el) el.textContent = count;
      }
    }
    const clear = document.getElementById(clearId);
    if (clear) clear.disabled = count === 0;
  }

  function updateFilterUI() {
    const totalArtist = searchFilters.length + clusterArtistFilters.length;
    const totalDj = djSearchFilters.length + clusterDjFilters.length;
    const gc = genreFilters.length;

    // Desktop pills
    const pillGenre = document.getElementById('pill-genre');
    if (pillGenre) {
      pillGenre.querySelector('.pill-count').textContent = gc;
      pillGenre.classList.toggle('active', gc > 0);
    }
    updatePillState('pill-artist', 'artist-pill-count', 'artist-clear-btn', totalArtist);
    updatePillState('pill-dj', 'dj-pill-count', 'dj-clear-btn', totalDj);
    updatePillState(null, null, 'genre-clear-btn', gc);

    // Mobile pills
    updatePillState('mobile-pill-genre', null, 'mobile-genre-clear-btn', gc);
    updatePillState('mobile-pill-artist', null, 'mobile-artist-clear-btn', totalArtist);
    updatePillState('mobile-pill-dj', null, 'mobile-dj-clear-btn', totalDj);

    // Desktop filter label above root card
    const filterLabel = document.getElementById('filter-label');
    if (filterLabel) {
      const hasFilters = gc > 0 || searchFilters.length > 0 || djSearchFilters.length > 0 || clusterArtistFilters.length > 0 || clusterDjFilters.length > 0;
      filterLabel.textContent = hasFilters ? `showing filtered results (${getFilteredPoolSize()})` : '';
      if (hasFilters) {
        const rootCard = document.querySelector('.node-card[data-rank="root"]');
        if (rootCard) {
          const cardLeft = parseFloat(rootCard.style.left) || 0;
          const cardTop = parseFloat(rootCard.style.top) || 0;
          const cardW = rootCard.offsetWidth;
          filterLabel.style.left = cardLeft + 'px';
          filterLabel.style.top = (cardTop - 29) + 'px';
          filterLabel.style.width = cardW + 'px';
          filterLabel.style.textAlign = 'center';
        }
      }
    }
  }

  // ── Render genre pills ──
  function renderGenrePills(container) {
    container.innerHTML = '';
    for (const g of displayGenres) {
      const pill = document.createElement('button');
      pill.className = 'genre-pill' + (genreFilters.includes(g.name) ? ' selected' : '');
      pill.textContent = g.name;
      pill.dataset.genre = g.name;
      pill.addEventListener('click', () => toggleGenre(g.name));
      container.appendChild(pill);
    }
  }
  renderGenrePills(document.getElementById('genre-pills'));
  renderGenrePills(document.getElementById('mobile-genre-pills'));

  // ── Render chips (shared for desktop + mobile, artist + DJ) ──
  function renderChips(containerId, inputId, filters, removeFn, placeholder) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('.find-chip').forEach(c => c.remove());
    const input = document.getElementById(inputId);
    filters.forEach((f, i) => {
      const chip = document.createElement('span');
      chip.className = 'find-chip';
      chip.innerHTML = `${escHtml(f.display)} <button class="chip-remove">&times;</button>`;
      chip.querySelector('.chip-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        removeFn(i);
      });
      container.insertBefore(chip, input);
    });
    if (placeholder) input.placeholder = filters.length ? '' : placeholder;
  }

  function renderFindChips() { renderChips('find-chips-input', 'find-search', searchFilters, removeSearchFilter, 'Search artists'); }
  function renderMobileFindChips() { renderChips('mobile-find-chips-input', 'mobile-find-search', searchFilters, removeSearchFilter); }
  function renderDjChips() { renderChips('dj-chips-input', 'dj-search', djSearchFilters, removeDjFilter, 'Search DJs'); }
  function renderMobileDjChips() { renderChips('mobile-dj-chips-input', 'mobile-dj-search', djSearchFilters, removeDjFilter); }
  function renderAllChips() { renderFindChips(); renderMobileFindChips(); renderDjChips(); renderMobileDjChips(); }

  // ── Filter row pill handlers ──
  const findSearchInput = document.getElementById('find-search');
  const findChipsInput = document.getElementById('find-chips-input');
  const findAc = document.getElementById('find-ac');
  const djSearchInput = document.getElementById('dj-search');
  const djChipsInput = document.getElementById('dj-chips-input');
  const djAc = document.getElementById('dj-ac');
  const genrePopover = document.getElementById('genre-popover');
  const artistPopover = document.getElementById('artist-popover');
  const djPopover = document.getElementById('dj-popover');

  // Filter row shuffle button
  document.getElementById('filter-shuffle-btn').addEventListener('click', shuffle);

  // Filter row share button
  const filterShareBtn = document.getElementById('filter-share-btn');
  if (filterShareBtn) {
    filterShareBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(window.location.href);
      filterShareBtn.classList.add('copied');
      setTimeout(() => filterShareBtn.classList.remove('copied'), 1500);
    });
  }

  // Genre popover
  document.getElementById('pill-genre').addEventListener('click', (e) => {
    e.stopPropagation();
    const wasArtistOpen = artistPopover.classList.contains('open');
    const wasDjOpen = djPopover.classList.contains('open');
    artistPopover.classList.remove('open');
    djPopover.classList.remove('open');
    closeFindAc();
    closeDjAc();
    genrePopover.classList.toggle('open');
    if (!genrePopover.classList.contains('open') || wasArtistOpen || wasDjOpen) reshuffleIfFiltered();
  });

  // Artist popover
  document.getElementById('pill-artist').addEventListener('click', (e) => {
    e.stopPropagation();
    const wasGenreOpen = genrePopover.classList.contains('open');
    const wasDjOpen = djPopover.classList.contains('open');
    genrePopover.classList.remove('open');
    djPopover.classList.remove('open');
    closeDjAc();
    artistPopover.classList.toggle('open');
    if (artistPopover.classList.contains('open')) {
      setTimeout(() => findSearchInput.focus(), 50);
      if (wasGenreOpen || wasDjOpen) reshuffleIfFiltered();
    } else {
      closeFindAc();
      reshuffleIfFiltered();
    }
  });

  // DJ popover
  document.getElementById('pill-dj').addEventListener('click', (e) => {
    e.stopPropagation();
    const wasGenreOpen = genrePopover.classList.contains('open');
    const wasArtistOpen = artistPopover.classList.contains('open');
    genrePopover.classList.remove('open');
    artistPopover.classList.remove('open');
    closeFindAc();
    djPopover.classList.toggle('open');
    if (djPopover.classList.contains('open')) {
      setTimeout(() => djSearchInput.focus(), 50);
      if (wasGenreOpen || wasArtistOpen) reshuffleIfFiltered();
    } else {
      closeDjAc();
      reshuffleIfFiltered();
    }
  });

  // Re-shuffle when any popover closes (filters apply on close)
  function reshuffleIfFiltered() {
    const hasFilters = genreFilters.length > 0 || searchFilters.length > 0 || djSearchFilters.length > 0 || clusterArtistFilters.length > 0 || clusterDjFilters.length > 0;
    if (hasFilters) shuffle();
  }

  // Close popovers on outside click
  document.addEventListener('click', (e) => {
    let anyClosed = false;
    if (!e.target.closest('#genre-pill-anchor') && genrePopover.classList.contains('open')) {
      genrePopover.classList.remove('open');
      anyClosed = true;
    }
    if (!e.target.closest('#artist-pill-anchor') && artistPopover.classList.contains('open')) {
      artistPopover.classList.remove('open');
      closeFindAc();
      anyClosed = true;
    } else if (e.target.closest('#artist-popover') && !e.target.closest('#find-ac') && !e.target.closest('#find-chips-input')) {
      closeFindAc();
    }
    if (!e.target.closest('#dj-pill-anchor') && djPopover.classList.contains('open')) {
      djPopover.classList.remove('open');
      closeDjAc();
      anyClosed = true;
    } else if (e.target.closest('#dj-popover') && !e.target.closest('#dj-ac') && !e.target.closest('#dj-chips-input')) {
      closeDjAc();
    }
    if (anyClosed) reshuffleIfFiltered();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const anyOpen = genrePopover.classList.contains('open') || artistPopover.classList.contains('open') || djPopover.classList.contains('open');
      genrePopover.classList.remove('open');
      artistPopover.classList.remove('open');
      djPopover.classList.remove('open');
      closeFindAc();
      closeDjAc();
      if (anyOpen) reshuffleIfFiltered();
    }
  });

  // Clear filter handlers (shared across desktop + mobile)
  function clearGenreFilters(e) {
    e.stopPropagation();
    genreFilters = [];
    shuffleHistory.clear();
    document.querySelectorAll('.genre-pill.selected').forEach(p => p.classList.remove('selected'));
    updateFilterUI();
  }
  function clearArtistFilters(e) {
    e.stopPropagation();
    searchFilters = [];
    clusterArtistFilters = [];
    shuffleHistory.clear();
    renderFindChips(); renderMobileFindChips();
    updateFilterUI();
    updateClusterPills();
  }
  function clearDjFilters(e) {
    e.stopPropagation();
    djSearchFilters = [];
    clusterDjFilters = [];
    shuffleHistory.clear();
    renderDjChips(); renderMobileDjChips();
    updateFilterUI();
    updateClusterPills();
  }

  // Wire desktop + mobile clear buttons to shared handlers
  ['genre-clear-btn', 'mobile-genre-clear-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', clearGenreFilters);
  });
  ['artist-clear-btn', 'mobile-artist-clear-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', clearArtistFilters);
  });
  ['dj-clear-btn', 'mobile-dj-clear-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', clearDjFilters);
  });

  // Click chips-input area to focus the text input
  findChipsInput.addEventListener('click', () => findSearchInput.focus());
  djChipsInput.addEventListener('click', () => djSearchInput.focus());

  // ── Autocomplete (shared for artist + DJ, desktop + mobile) ──
  function buildAcItems(container, results, onSelect, onHover) {
    container.innerHTML = '';
    results.forEach((entry, idx) => {
      const div = document.createElement('div');
      div.className = 'ac-item';
      const cc = entry.clusterCount || 0;
      const countLabel = `${cc} cluster${cc !== 1 ? 's' : ''}`;
      div.innerHTML = `<span class="ac-name">${escHtml(entry.display)}</span><span class="ac-count">${countLabel}</span>`;
      div.addEventListener('click', (e) => { e.stopPropagation(); onSelect(entry); });
      if (onHover) div.addEventListener('mouseenter', () => onHover(idx));
      container.appendChild(div);
    });
    container.classList.add('open');
  }

  // Desktop autocomplete factory (with keyboard nav)
  function createDesktopAc(acEl, searchInput, list, addFn, closeFn, filters, removeFn) {
    let items = [], activeIdx = -1;

    function close() {
      acEl.classList.remove('open');
      acEl.innerHTML = '';
      items = [];
      activeIdx = -1;
    }

    function show(query) {
      const q = query.toLowerCase().trim();
      const results = searchIndex(list, q, q ? 15 : 20);
      if (results.length === 0) { close(); return; }
      items = [];
      activeIdx = -1;
      buildAcItems(acEl, results, (entry) => {
        addFn(entry);
        searchInput.value = '';
        close();
        setTimeout(() => searchInput.focus(), 0);
      }, (idx) => {
        items.forEach(el => el.classList.remove('active'));
        acEl.children[idx]?.classList.add('active');
        activeIdx = idx;
      });
      items = [...acEl.children];
    }

    searchInput.addEventListener('input', () => {
      if (searchInput.value.trim()) show(searchInput.value);
      else close();
    });
    searchInput.addEventListener('focus', () => {
      if (searchInput.value.trim()) show(searchInput.value);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && searchInput.value === '' && filters.length > 0) {
        removeFn(filters.length - 1);
        return;
      }
      if (!acEl.classList.contains('open')) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
        items[activeIdx]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
        items[activeIdx]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIdx >= 0 && activeIdx < items.length) items[activeIdx].click();
      } else if (e.key === 'Escape') {
        close();
      }
    });

    return { close, show };
  }

  const findAcCtrl = createDesktopAc(findAc, findSearchInput, artistListAlpha, addSearchFilter, null, searchFilters, removeSearchFilter);
  const closeFindAc = findAcCtrl.close;
  const djAcCtrl = createDesktopAc(djAc, djSearchInput, djListAlpha, addDjFilter, null, djSearchFilters, removeDjFilter);
  const closeDjAc = djAcCtrl.close;

  // ── Cluster context pills ──
  function toggleClusterFilter(filtersArr, entry) {
    const idx = filtersArr.findIndex(f => f.display === entry.display);
    if (idx >= 0) {
      filtersArr.splice(idx, 1);
    } else {
      filtersArr.push({ display: entry.display, trackIds: entry.trackIds });
    }
    shuffleHistory.clear();
    updateFilterUI();
    updateClusterPills();
  }

  function updateClusterPills() {
    const artistContainer = document.getElementById('artist-cluster-pills');
    const mobileArtistContainer = document.getElementById('mobile-artist-cluster-pills');
    const djContainer = document.getElementById('dj-cluster-pills');
    const mobileDjContainer = document.getElementById('mobile-dj-cluster-pills');

    [artistContainer, mobileArtistContainer].forEach(c => { if (c) c.innerHTML = ''; });
    [djContainer, mobileDjContainer].forEach(c => { if (c) c.innerHTML = ''; });

    if (nodes.length === 0) return;

    // Collect unique artists from cluster
    const seenArtists = new Set();
    for (const node of nodes) {
      const raw = (node.artist || '').trim();
      if (!raw) continue;
      for (const name of splitArtists(raw)) {
        const key = name.toLowerCase();
        if (seenArtists.has(key)) continue;
        seenArtists.add(key);
        const entry = artistIndex[key];
        if (!entry) continue;
        const isActive = clusterArtistFilters.some(f => f.display === entry.display);
        [artistContainer, mobileArtistContainer].forEach(container => {
          if (!container) return;
          const pill = document.createElement('button');
          pill.className = 'cluster-pill' + (isActive ? ' added' : '');
          pill.textContent = entry.display;
          pill.addEventListener('click', (e) => { e.stopPropagation(); toggleClusterFilter(clusterArtistFilters, entry); });
          container.appendChild(pill);
        });
      }
    }

    // Collect unique DJs from cluster
    const seenDjs = new Set();
    for (const node of nodes) {
      for (const dj of (node.djs || [])) {
        const names = djNameMap[dj.name] || [dj.name];
        for (const name of names) {
          const key = name.toLowerCase();
          if (seenDjs.has(key)) continue;
          seenDjs.add(key);
          const entry = djIndex[key];
          if (!entry) continue;
          const isActive = clusterDjFilters.some(f => f.display === entry.display);
          [djContainer, mobileDjContainer].forEach(container => {
            if (!container) return;
            const pill = document.createElement('button');
            pill.className = 'cluster-pill' + (isActive ? ' added' : '');
            pill.textContent = entry.display;
            pill.addEventListener('click', (e) => { e.stopPropagation(); toggleClusterFilter(clusterDjFilters, entry); });
            container.appendChild(pill);
          });
        }
      }
    }
  }

  // ── Mobile search autocomplete ──
  function createMobileAc(acEl, searchInput, chipsId, list, addFn, filters, removeFn, limit) {
    function close() { acEl.classList.remove('open'); acEl.innerHTML = ''; }
    function show(query) {
      const q = query.toLowerCase().trim();
      const results = searchIndex(list, q, q ? 15 : (limit || 20));
      if (results.length === 0) { close(); return; }
      buildAcItems(acEl, results, (entry) => {
        close();
        addFn(entry);
        searchInput.value = '';
      });
    }
    searchInput.addEventListener('input', () => {
      if (searchInput.value.trim()) show(searchInput.value);
      else close();
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && searchInput.value === '' && filters.length > 0) {
        removeFn(filters.length - 1);
      }
    });
    document.getElementById(chipsId).addEventListener('click', () => searchInput.focus());
    return { close, show };
  }

  createMobileAc(document.getElementById('mobile-find-ac'), document.getElementById('mobile-find-search'),
    'mobile-find-chips-input', artistListAlpha, addSearchFilter, searchFilters, removeSearchFilter, 30);
  createMobileAc(document.getElementById('mobile-dj-ac'), document.getElementById('mobile-dj-search'),
    'mobile-dj-chips-input', djListAlpha, addDjFilter, djSearchFilters, removeDjFilter);

  // Populate cluster pills now that indexes are built
  updateClusterPills();

  return { updateClusterPills, updateFilterUI, closeFindAc, closeDjAc, clearAllFilters };
}
