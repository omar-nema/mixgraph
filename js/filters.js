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

async function initFilters() {
  // ── Load genres from API ──
  let displayGenres = [];
  try {
    displayGenres = await apiGetGenres();
    console.log(`Genres loaded: ${displayGenres.length}`);
  } catch (e) { console.warn('Failed to load genres:', e.message); }

  // ── Shared helpers ──
  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Filter state management ──
  function modifyFilter(arr, action, renderFn) {
    action(arr);
    shuffleHistory.clear();
    renderFn();
    updateFilterUI();
    updateClusterPills();
  }

  function addSearchFilter(entry) {
    if (searchFilters.some(f => f.display === entry.display)) return;
    modifyFilter(searchFilters, a => a.push({ display: entry.display }), renderFindChips);
  }

  function removeSearchFilter(index) {
    modifyFilter(searchFilters, a => a.splice(index, 1), renderFindChips);
  }

  function addDjFilter(entry) {
    if (djSearchFilters.some(f => f.display === entry.display)) return;
    modifyFilter(djSearchFilters, a => a.push({ display: entry.display }), renderDjChips);
  }

  function removeDjFilter(index) {
    modifyFilter(djSearchFilters, a => a.splice(index, 1), renderDjChips);
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
    if (pillGenre) pillGenre.classList.toggle('active', gc > 0);
    updatePillState('pill-artist', null, 'artist-clear-btn', totalArtist);
    updatePillState('pill-dj', null, 'dj-clear-btn', totalDj);
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
  function renderDjChips() { renderChips('dj-chips-input', 'dj-search', djSearchFilters, removeDjFilter, 'Search DJs'); }
  function renderAllChips() { renderFindChips(); renderDjChips(); }

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

  // Position a popover below its anchor pill
  function positionPopover(popover, anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    popover.style.top = (rect.bottom + 8) + 'px';
    popover.style.left = rect.left + 'px';
  }

  // Close all popovers
  function closeAllPopovers() {
    genrePopover.classList.remove('open');
    artistPopover.classList.remove('open');
    djPopover.classList.remove('open');
    document.querySelectorAll('.filter-pill.semi-open').forEach(p => p.classList.remove('semi-open'));
    closeFindAc();
    closeDjAc();
  }

  // Genre popover
  const pillGenreEl = document.getElementById('pill-genre');
  pillGenreEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = genrePopover.classList.contains('open');
    closeAllPopovers();
    if (!wasOpen) {
      positionPopover(genrePopover, pillGenreEl);
      genrePopover.classList.add('open');
      pillGenreEl.classList.add('semi-open');
    }
    reshuffleIfFiltered();
  });

  // Artist popover
  const pillArtistEl = document.getElementById('pill-artist');
  pillArtistEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = artistPopover.classList.contains('open');
    closeAllPopovers();
    if (!wasOpen) {
      positionPopover(artistPopover, pillArtistEl);
      artistPopover.classList.add('open');
      pillArtistEl.classList.add('semi-open');
      setTimeout(() => findSearchInput.focus(), 50);
    }
    reshuffleIfFiltered();
  });

  // DJ popover
  const pillDjEl = document.getElementById('pill-dj');
  pillDjEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = djPopover.classList.contains('open');
    closeAllPopovers();
    if (!wasOpen) {
      positionPopover(djPopover, pillDjEl);
      djPopover.classList.add('open');
      pillDjEl.classList.add('semi-open');
      setTimeout(() => djSearchInput.focus(), 50);
    }
    reshuffleIfFiltered();
  });

  // Re-shuffle when any popover closes (filters apply on close)
  function reshuffleIfFiltered() {
    const hasFilters = genreFilters.length > 0 || searchFilters.length > 0 || djSearchFilters.length > 0 || clusterArtistFilters.length > 0 || clusterDjFilters.length > 0;
    if (hasFilters) shuffle();
  }

  // Close popovers on outside click (desktop only — mobile uses backdrop)
  document.addEventListener('click', (e) => {
    if (isMobileView()) return;
    // Ignore clicks inside popovers or on pill buttons
    if (e.target.closest('.filter-popover') || e.target.closest('.filter-pill')) return;
    const anyOpen = genrePopover.classList.contains('open') || artistPopover.classList.contains('open') || djPopover.classList.contains('open');
    if (anyOpen) {
      closeAllPopovers();
      reshuffleIfFiltered();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const anyOpen = genrePopover.classList.contains('open') || artistPopover.classList.contains('open') || djPopover.classList.contains('open');
      closeAllPopovers();
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
    renderFindChips();
    updateFilterUI();
    updateClusterPills();
  }
  function clearDjFilters(e) {
    e.stopPropagation();
    djSearchFilters = [];
    clusterDjFilters = [];
    shuffleHistory.clear();
    renderDjChips();
    updateFilterUI();
    updateClusterPills();
  }

  // Wire clear buttons
  document.getElementById('genre-clear-btn')?.addEventListener('click', clearGenreFilters);
  document.getElementById('artist-clear-btn')?.addEventListener('click', clearArtistFilters);
  document.getElementById('dj-clear-btn')?.addEventListener('click', clearDjFilters);

  // chips-input click-to-focus is handled by createAc()

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

  // Autocomplete factory (keyboard nav + API search)
  function createAc(acEl, searchInput, chipsId, searchFn, addFn, filters, removeFn) {
    let items = [], activeIdx = -1;
    let debounceTimer = null;

    function close() {
      acEl.classList.remove('open');
      acEl.innerHTML = '';
      items = [];
      activeIdx = -1;
    }

    async function show(query) {
      const q = query.trim();
      if (!q) { close(); return; }
      try {
        const results = await searchFn(q, 15);
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
      } catch (e) { console.warn('Autocomplete error:', e.message); }
    }

    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      if (searchInput.value.trim()) {
        debounceTimer = setTimeout(() => show(searchInput.value), 150);
      } else {
        close();
      }
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
    document.getElementById(chipsId)?.addEventListener('click', () => searchInput.focus());

    return { close, show };
  }

  const findAcCtrl = createAc(findAc, findSearchInput, 'find-chips-input', apiSearchArtists, addSearchFilter, searchFilters, removeSearchFilter);
  const closeFindAc = findAcCtrl.close;
  const djAcCtrl = createAc(djAc, djSearchInput, 'dj-chips-input', apiSearchDjs, addDjFilter, djSearchFilters, removeDjFilter);
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
    const djContainer = document.getElementById('dj-cluster-pills');

    if (artistContainer) artistContainer.innerHTML = '';
    if (djContainer) djContainer.innerHTML = '';

    if (nodes.length === 0) return;

    // Collect unique artists from cluster nodes
    const seenArtists = new Set();
    for (const node of nodes) {
      const raw = (node.artist || '').trim();
      if (!raw) continue;
      for (const name of splitArtists(raw)) {
        const key = name.toLowerCase();
        if (seenArtists.has(key)) continue;
        seenArtists.add(key);
        const entry = { display: name };
        const isActive = clusterArtistFilters.some(f => f.display.toLowerCase() === key);
        if (artistContainer) {
          const pill = document.createElement('button');
          pill.className = 'cluster-pill' + (isActive ? ' added' : '');
          pill.textContent = name;
          pill.addEventListener('click', (e) => { e.stopPropagation(); toggleClusterFilter(clusterArtistFilters, entry); });
          artistContainer.appendChild(pill);
        }
      }
    }

    // Collect unique DJs from cluster nodes
    const seenDjs = new Set();
    for (const node of nodes) {
      for (const dj of (node.djs || [])) {
        const name = dj.name;
        const key = name.toLowerCase();
        if (seenDjs.has(key)) continue;
        seenDjs.add(key);
        const entry = { display: name };
        const isActive = clusterDjFilters.some(f => f.display.toLowerCase() === key);
        if (djContainer) {
          const pill = document.createElement('button');
          pill.className = 'cluster-pill' + (isActive ? ' added' : '');
          pill.textContent = name;
          pill.addEventListener('click', (e) => { e.stopPropagation(); toggleClusterFilter(clusterDjFilters, entry); });
          djContainer.appendChild(pill);
        }
      }
    }
  }

  // Populate cluster pills now that indexes are built
  updateClusterPills();

  return { updateClusterPills, updateFilterUI, closeFindAc, closeDjAc, clearAllFilters };
}
