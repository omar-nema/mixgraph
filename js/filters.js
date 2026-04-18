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

// Genre taxonomy: parent → children mapping (from NTS classification)
const GENRE_TAXONOMY = {
  "Ambient / New Age": ["Ambient", "Fourth World", "Kosmische", "New Age", "Vaporwave"],
  "Electronica / Downtempo": ["Beats", "Electronica", "Glitch", "Trip Hop", "Witch House"],
  "Hip-Hop / R&B": ["Chopped N Screwed", "Classic Hip Hop", "Cloud Rap", "Dirty South", "Drill", "Emo Rap", "Experimental Hip Hop", "G-Funk", "Gangsta Rap", "Hip Hop", "Memphis", "New Jack Swing", "RNB", "Rap", "Trap"],
  "New Club": ["Afro House", "Afrobeats", "Amapiano", "Baile Funk", "Ballroom", "Baltimore Club", "Bass", "Batida", "Brega", "Club", "Coupé-Décalé", "Footwork", "Forró Piseiro", "Gengetone", "Gqom", "Hyperpop", "Jersey Club", "Kuduro", "Kwaito", "Reggaeton", "Raptor House", "Singeli"],
  "UK Dance / Grime": ["Bassline", "Breakbeat Hardcore", "Breakcore", "Donk", "Drum & Bass", "Dubstep", "Garage", "Grime", "Jungle", "Speed Garage", "UK Funky"],
  "House / Techno": ["Acid", "Ambient Techno", "Balearic House", "Breaks", "Broken Beat", "Chicago House", "Deep House", "Detroit House", "Detroit Techno", "Dub Techno", "Electro", "Euro House", "Gabber", "Ghetto House", "Ghettotech", "Happy Hardcore", "Hardstyle", "Hip-House", "House", "Leftfield House", "Leftfield Techno", "Minimal", "Tech House", "Techno", "Trance"],
  "Post Punk / New Wave": ["EBM", "Electroclash", "Goth Rock", "Industrial", "Minimal Synth", "New Beat", "New Wave", "No Wave", "Post Punk", "Synth Pop"],
  "Alt Rock / Punk": ["Art Rock", "Dream Pop", "Emo", "Garage Rock", "Grunge", "Hardcore Punk", "Indie Rock", "Math Rock", "Noise Rock", "Post Hardcore", "Post Rock", "Punk", "Shoegaze", "Space Rock"],
  "Rock": ["American Primitivism", "Bluegrass", "Classic Rock", "Country", "Folk", "Hard Rock", "Krautrock", "Power Pop", "Prog Rock", "Psychedelic Folk", "Psychedelic Rock", "Rock N Roll", "Rockabilly", "Soft Rock", "Surf", "Yacht Rock"],
  "Metal": ["Black Metal", "Death Metal", "Doom", "Grindcore", "Heavy Metal", "Metalcore", "Nu Metal", "Sludge", "Thrash"],
  "Avant Garde": ["Dark Ambient", "Drone", "Experimental", "Freak Folk", "Musique Concrete", "Noise"],
  "Caribbean": ["Bashment", "Beguine", "Bouyon", "Bubbling", "Calypso", "Chutney", "Dancehall", "Dembow", "Dennery Segment", "Digi Dub", "Dub", "Kaseko", "Lovers Rock", "Mento", "Reggae", "Rocksteady", "Shatta", "Ska", "Soca", "Zouk"],
  "Latin / Brazilian": ["Bachata", "Bolero", "Bossa Nova", "Champeta", "Chicha", "Corrido", "Cumbia", "Flamenco", "Forró", "Freestyle", "Guaracha", "Joropo", "Latin Jazz", "Latin Soul", "Merengue", "Norteño", "Rancheras", "Salsa", "Samba", "Tango", "Vallenato"],
  "Jazz": ["Afro Cuban Jazz", "Ambient Jazz", "Bebop", "Contemporary Jazz", "Free Jazz", "Hard Bop", "Jazz Fusion", "Jazz Rock", "Modal", "Post Bop", "Soul Jazz", "Spiritual Jazz", "Straight Jazz", "Swing"],
  "Soul / R&B": ["Blues", "Doo Wop", "Funk", "Gospel", "P Funk", "Psychedelic Soul", "Rare Groove", "Rhythm & Blues", "Slow Jams", "Soul", "Street Soul", "Sweet Soul"],
  "Disco / Boogie": ["Boogie", "Bubblegum", "Classic Disco", "Cosmic Disco", "Italo", "Leftfield Disco"],
  "African / Middle Eastern": ["Afro Disco", "Afrobeat", "Anatolian Rock", "Arabic Pop", "Arabic Traditional", "Benga", "Chaabi", "Dabke", "Ethiopiques", "Funaná", "Gnawa", "Griot", "Highlife", "Juju", "Kizomba", "Mahraganat", "Makossa", "Maloya", "Mbalax", "Raï", "Rumba", "Sahara Blues", "Salegy", "Sega", "Soukous", "South African Jazz", "Taarab", "Turkish Disco", "Turkish Rock", "Zamrock"],
  "Asia": ["Bengali Pop", "Bhangra", "Bollywood", "C-Pop", "Chinese Traditional", "City Pop", "Dangdut", "Gamelan", "Indian Classical", "J-Pop", "Japanese Traditional", "K-Pop", "Khmer Pop", "Korean Traditional", "Molam", "Tamil Film Music", "Thai Classical", "V-Pop"],
  "Classical / Opera": ["Baroque", "Choral Music", "Classical", "Minimalism", "Modern Classical", "Opera"],
  "Other": ["Celtic Folk", "Chanson", "Chip Tune", "Dungeon Synth", "Field Recordings", "Irish Traditional", "Leftfield Pop", "Library", "Nordic Folk", "Pop", "Soundtrack", "Spoken Word", "Video Game Music"]
};

// Build flat genre search index: [{display, parent, isParent}]
const GENRE_SEARCH_INDEX = [];
for (const [parent, children] of Object.entries(GENRE_TAXONOMY)) {
  GENRE_SEARCH_INDEX.push({ display: parent, parent: parent, isParent: true });
  for (const child of children) {
    GENRE_SEARCH_INDEX.push({ display: child, parent: parent, isParent: false });
  }
}

function searchGenresLocal(query, limit = 500) {
  const q = query.trim().toLowerCase();
  if (!q) return GENRE_SEARCH_INDEX;
  // Prefix matches first, then substring matches
  const prefix = [], substring = [];
  for (const entry of GENRE_SEARCH_INDEX) {
    const lower = entry.display.toLowerCase();
    if (lower.startsWith(q)) prefix.push(entry);
    else if (lower.includes(q)) substring.push(entry);
  }
  return [...prefix, ...substring].slice(0, limit);
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
  //
  // Every filter mutation funnels through applyFilterChange. It runs the
  // full post-change pipeline (rebuild derived genre list, render all chip
  // surfaces, update pills, reshuffle if needed) so individual call sites
  // only contain the actual state change.
  //
  // Reshuffle rule: in tracks mode, only reshuffle if no currently-visible
  // node matches the new filter set. In crates mode, always reset the grid.

  function genreFilterNames(entry) {
    if (entry.isParent) return GENRE_TAXONOMY[entry.display] || [entry.display];
    return [entry.display];
  }

  // Rebuild the flat genreFilters array from genreSearchFilters +
  // manual pill toggles (stored separately so parent-chip expansion and
  // individual pill toggles can coexist without drift).
  function rebuildGenreFilters() {
    const next = new Set();
    for (const f of genreSearchFilters) (f.names || []).forEach(n => next.add(n));
    for (const n of manualGenreToggles) next.add(n);
    // Mutate in place so existing consumers keep working
    genreFilters.length = 0;
    next.forEach(n => genreFilters.push(n));
  }

  // Node match — mirrors worker/index.js filter logic (AND across categories, OR within).
  function nodeMatchesFilters(node) {
    if (!node) return false;
    if (genreFilters.length) {
      const ng = node.genres || [];
      if (!genreFilters.some(g => ng.includes(g))) return false;
    }
    const artistWords = [...searchFilters, ...clusterArtistFilters].map(f => f.display.toLowerCase());
    if (artistWords.length) {
      const na = (node.artist ? splitArtists(node.artist) : []).map(a => a.toLowerCase());
      if (!artistWords.some(a => na.includes(a))) return false;
    }
    const djWords = [...djSearchFilters, ...clusterDjFilters].map(f => f.display.toLowerCase());
    if (djWords.length) {
      const nd = (node.djs || []).map(d => (d.name || '').toLowerCase());
      if (!djWords.some(d => nd.includes(d))) return false;
    }
    return true;
  }

  function anyVisibleNodeMatchesFilters() {
    if (!nodes || !nodes.length) return true; // nothing on screen yet → don't reshuffle
    return nodes.some(nodeMatchesFilters);
  }

  function applyFilterChange(mutate, { deferReshuffle = false } = {}) {
    mutate();
    filtersDirty = true;
    shuffleHistory.clear();

    // Derived + rendered surfaces (run them all every time; idempotent).
    rebuildGenreFilters();
    syncGenrePillHighlights();
    renderAllChips();
    if (window._renderSearchBarChips) window._renderSearchBarChips();
    updateFilterUI();
    updateClusterPills();

    if (document.body.classList.contains('crates-mode')) {
      if (window._cratesResetFn) window._cratesResetFn();
      return;
    }
    if (deferReshuffle) return;

    // Tracks mode: only reshuffle if nothing on screen matches the new filter set.
    if (!anyVisibleNodeMatchesFilters()) {
      filtersDirty = false;
      shuffle();
    }
  }

  function addSearchFilter(entry) {
    if (searchFilters.some(f => f.display === entry.display)) return;
    trackEvent('filter_artist');
    applyFilterChange(() => searchFilters.push({ display: entry.display }));
  }

  function removeSearchFilter(index) {
    applyFilterChange(() => searchFilters.splice(index, 1));
  }

  function addDjFilter(entry) {
    if (djSearchFilters.some(f => f.display === entry.display)) return;
    trackEvent('filter_dj');
    applyFilterChange(() => djSearchFilters.push({ display: entry.display }));
  }

  function removeDjFilter(index) {
    applyFilterChange(() => djSearchFilters.splice(index, 1));
  }

  function addGenreSearchFilter(entry) {
    if (genreSearchFilters.some(f => f.display === entry.display)) return;
    trackEvent('filter_genre');
    const names = genreFilterNames(entry);
    applyFilterChange(() => genreSearchFilters.push({ display: entry.display, names }));
  }

  function removeGenreSearchFilter(index) {
    applyFilterChange(() => { genreSearchFilters.splice(index, 1); });
  }

  function syncGenrePillHighlights() {
    document.querySelectorAll('.genre-pill').forEach(p => {
      p.classList.toggle('selected', genreFilters.includes(p.dataset.genre));
    });
  }

  // Toggle a single genre via a pill click.
  // Option (c) from audit: if the name is only present because of a parent chip,
  // remove the whole parent chip (so visible chips always reflect active filters).
  function toggleGenre(name) {
    applyFilterChange(() => {
      const hadManual = manualGenreToggles.has(name);
      if (hadManual) {
        manualGenreToggles.delete(name);
        return;
      }
      // Covered by a parent chip? Remove that parent chip entirely.
      const parentChip = genreSearchFilters.find(f => (f.names || []).includes(name));
      if (parentChip) {
        const idx = genreSearchFilters.indexOf(parentChip);
        if (idx >= 0) genreSearchFilters.splice(idx, 1);
        return;
      }
      trackEvent('filter_genre');
      manualGenreToggles.add(name);
    });
  }

  function clearAllFilters() {
    applyFilterChange(() => {
      searchFilters.length = 0;
      djSearchFilters.length = 0;
      clusterArtistFilters.length = 0;
      clusterDjFilters.length = 0;
      genreSearchFilters.length = 0;
      manualGenreToggles.clear();
    });
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

    // Mobile pills (shuffle area)
    updatePillState('mobile-pill-genre', null, 'mobile-genre-clear-btn', gc);
    updatePillState('mobile-pill-artist', null, 'mobile-artist-clear-btn', totalArtist);
    updatePillState('mobile-pill-dj', null, 'mobile-dj-clear-btn', totalDj);

    // Mobile header filter bar pills (Dig mode)
    const barGenre = document.getElementById('mobile-bar-genre');
    if (barGenre) barGenre.classList.toggle('active', gc > 0);
    const barArtist = document.getElementById('mobile-bar-artist');
    if (barArtist) barArtist.classList.toggle('active', totalArtist > 0);
    const barDj = document.getElementById('mobile-bar-dj');
    if (barDj) barDj.classList.toggle('active', totalDj > 0);

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
  function renderGenreChips() { renderChips('genre-chips-input', 'genre-search', genreSearchFilters, removeGenreSearchFilter, 'Search genres'); }
  function renderAllChips() { renderFindChips(); renderDjChips(); renderGenreChips(); }

  // ── Filter row pill handlers ──
  const findSearchInput = document.getElementById('find-search');
  const findChipsInput = document.getElementById('find-chips-input');
  const findAc = document.getElementById('find-ac');
  const djSearchInput = document.getElementById('dj-search');
  const djChipsInput = document.getElementById('dj-chips-input');
  const djAc = document.getElementById('dj-ac');
  const genreSearchInput = document.getElementById('genre-search');
  const genreChipsInput = document.getElementById('genre-chips-input');
  const genreAc = document.getElementById('genre-ac');
  const genrePopover = document.getElementById('genre-popover');
  const artistPopover = document.getElementById('artist-popover');
  const djPopover = document.getElementById('dj-popover');

  // Filter row shuffle button (removed from UI, kept as guard)
  const filterShuffleBtn = document.getElementById('filter-shuffle-btn');
  if (filterShuffleBtn) {
    filterShuffleBtn.addEventListener('click', () => {
      filterShuffleBtn.classList.remove('squish');
      void filterShuffleBtn.offsetWidth;
      filterShuffleBtn.classList.add('squish');
      shuffle();
    });
    filterShuffleBtn.addEventListener('animationend', () => filterShuffleBtn.classList.remove('squish'));
  }

  // Filter row share button
  const filterShareBtn = document.getElementById('filter-share-btn');
  if (filterShareBtn) {
    filterShareBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(window.location.href);
      filterShareBtn.classList.add('copied');
      setTimeout(() => filterShareBtn.classList.remove('copied'), 1500);
    });
  }

  // Position a popover below its anchor pill, clamped to viewport
  function positionPopover(popover, anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const top = rect.bottom + 8;
    let left = rect.left;
    // Clamp so popover doesn't overflow right edge
    const pw = popover.offsetWidth || 540;
    const maxLeft = window.innerWidth - pw - 12;
    if (left > maxLeft) left = maxLeft;
    if (left < 12) left = 12;
    popover.style.top = top + 'px';
    popover.style.left = left + 'px';
  }

  // Close all popovers (desktop AND mobile — both pill classes)
  function closeAllPopovers() {
    genrePopover.classList.remove('open');
    artistPopover.classList.remove('open');
    djPopover.classList.remove('open');
    const backdrop = document.getElementById('popover-backdrop');
    if (backdrop) backdrop.classList.remove('open');
    document.querySelectorAll('.filter-pill.semi-open, .mobile-filter-pill.semi-open').forEach(p => p.classList.remove('semi-open'));
    closeFindAc();
    closeDjAc();
    closeGenreAc();
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
      setTimeout(() => genreSearchInput.focus(), 50);
    } else {
      reshuffleIfFiltered();
    }
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
    } else {
      reshuffleIfFiltered();
    }
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
    } else {
      reshuffleIfFiltered();
    }
  });

  // Re-shuffle when any popover closes (filters apply on close).
  // Same "stay if any visible node matches" rule as the funnel.
  function reshuffleIfFiltered() {
    if (!filtersDirty) return;
    filtersDirty = false;
    if (document.body.classList.contains('crates-mode')) return;
    if (!anyVisibleNodeMatchesFilters()) shuffle();
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

  // Clear filter handlers (shared across desktop + mobile). All go through the funnel.
  function clearGenreFilters(e) {
    e.stopPropagation();
    applyFilterChange(() => { genreSearchFilters.length = 0; manualGenreToggles.clear(); });
  }
  function clearArtistFilters(e) {
    e.stopPropagation();
    applyFilterChange(() => { searchFilters.length = 0; clusterArtistFilters.length = 0; });
  }
  function clearDjFilters(e) {
    e.stopPropagation();
    applyFilterChange(() => { djSearchFilters.length = 0; clusterDjFilters.length = 0; });
  }

  // Wire clear buttons
  document.getElementById('genre-clear-btn')?.addEventListener('click', clearGenreFilters);
  document.getElementById('artist-clear-btn')?.addEventListener('click', clearArtistFilters);
  document.getElementById('dj-clear-btn')?.addEventListener('click', clearDjFilters);

  // Pill icon X click — capture phase so it fires before the button's handler
  document.addEventListener('click', (e) => {
    const icon = e.target.closest('.pill-icon');
    if (!icon) return;
    const pill = icon.closest('.filter-pill');
    if (!pill || !pill.classList.contains('active')) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const type = icon.dataset.filter;
    if (type === 'genre') clearGenreFilters(e);
    else if (type === 'artist') clearArtistFilters(e);
    else if (type === 'dj') clearDjFilters(e);
    closeAllPopovers();
  }, true);

  // chips-input click-to-focus is handled by createAc()

  // ── Autocomplete (shared for artist + DJ, desktop + mobile) ──
  function buildAcItems(container, results, onSelect, onHover, labelFn) {
    container.innerHTML = '';
    results.forEach((entry, idx) => {
      const div = document.createElement('div');
      div.className = 'ac-item';
      if (labelFn) {
        div.innerHTML = labelFn(entry);
      } else {
        const cc = entry.clusterCount || 0;
        const countLabel = `${cc} cluster${cc !== 1 ? 's' : ''}`;
        div.innerHTML = `<span class="ac-name">${escHtml(entry.display)}</span><span class="ac-count">${countLabel}</span>`;
      }
      div.addEventListener('click', (e) => { e.stopPropagation(); onSelect(entry); });
      if (onHover) div.addEventListener('mouseenter', () => onHover(idx));
      container.appendChild(div);
    });
    container.classList.add('open');
  }

  // Autocomplete factory (keyboard nav + API search)
  function createAc(acEl, searchInput, chipsId, searchFn, addFn, filters, removeFn, opts = {}) {
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
      if (!q && !opts.showAllOnFocus) { close(); return; }
      try {
        const results = await searchFn(q, 15);
        if (results.length === 0) {
          acEl.innerHTML = '<div class="ac-item ac-no-results">No results, try different artist, DJ or genre</div>';
          acEl.classList.add('open');
          items = []; activeIdx = -1;
          return;
        }
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
        }, opts.labelFn);
        items = [...acEl.children];
      } catch (e) { console.warn('Autocomplete error:', e.message); }
    }

    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      if (searchInput.value.trim()) {
        debounceTimer = setTimeout(() => show(searchInput.value), 150);
      } else if (opts.showAllOnFocus) {
        debounceTimer = setTimeout(() => show(''), 150);
      } else {
        close();
      }
    });
    searchInput.addEventListener('focus', () => {
      if (searchInput.value.trim()) show(searchInput.value);
    });
    if (opts.showAllOnFocus) {
      searchInput.addEventListener('mousedown', (e) => {
        // Show on next tick so any pending close from document click resolves first
        setTimeout(() => {
          if (!acEl.classList.contains('open')) show(searchInput.value);
        }, 0);
      });
      document.addEventListener('mousedown', (e) => {
        const wrap = searchInput.closest('.popover-search-wrap');
        if (wrap && !wrap.contains(e.target)) {
          if (acEl.classList.contains('open') && !searchInput.value.trim()) close();
        }
      });
    }
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
  const genreAcCtrl = createAc(genreAc, genreSearchInput, 'genre-chips-input',
    (q) => searchGenresLocal(q), addGenreSearchFilter, genreSearchFilters, removeGenreSearchFilter,
    { showAllOnFocus: true, labelFn: (entry) => {
      const cls = entry.isParent ? 'ac-name ac-parent' : 'ac-name';
      const name = `<span class="${cls}">${escHtml(entry.display)}</span>`;
      const label = entry.isParent ? '' : `<span class="ac-count">${escHtml(entry.parent)}</span>`;
      return name + label;
    }}
  );
  const closeGenreAc = genreAcCtrl.close;

  // ── Unified search (searches across artist, DJ, genre) ──
  const filterSearchInput = document.getElementById('filter-search');
  const filterSearchAc = document.getElementById('filter-search-ac');
  const filterSearchClear = document.getElementById('filter-search-clear');
  const filterSearchWrap = filterSearchInput?.closest('.filter-search-wrap');
  if (filterSearchInput && filterSearchAc) {
    let uniItems = [], uniActiveIdx = -1, uniDebounce = null;

    const searchChipsContainer = document.getElementById('filter-search-chips');

    window._renderSearchBarChips = renderSearchBarChips;
    function renderSearchBarChips() {
      searchChipsContainer.querySelectorAll('.find-chip').forEach(c => c.remove());
      const allChips = [
        ...searchFilters.map((f, i) => ({ label: f.display, type: 'artist', remove: () => removeSearchFilter(i) })),
        ...djSearchFilters.map((f, i) => ({ label: f.display, type: 'dj', remove: () => removeDjFilter(i) })),
        ...genreSearchFilters.map((f, i) => ({ label: f.display, type: 'genre', remove: () => removeGenreSearchFilter(i) })),
      ];
      for (const { label, remove } of allChips) {
        const chip = document.createElement('span');
        chip.className = 'find-chip';
        chip.innerHTML = `${escHtml(label)} <button class="chip-remove">&times;</button>`;
        chip.querySelector('.chip-remove').addEventListener('click', (e) => {
          e.stopPropagation();
          remove();
        });
        searchChipsContainer.appendChild(chip);
      }
      const hasChips = allChips.length > 0;
      filterSearchWrap.classList.toggle('has-chips', hasChips);
      filterSearchClear.style.display = hasChips ? 'flex' : 'none';
      filterSearchInput.placeholder = hasChips ? '' : 'Search by artist, DJ, or genre';
    }

    function addSearchBarChip(type, entry) {
      if (type === 'artist') addSearchFilter(entry);
      else if (type === 'dj') addDjFilter(entry);
      else if (type === 'genre') addGenreSearchFilter(entry);
      renderSearchBarChips();
      filterSearchInput.value = '';
      closeUnifiedAc();
      filterSearchInput.focus();
    }

    function clearAllSearchChips() {
      clearTimeout(uniDebounce);
      closeUnifiedAc();
      filterSearchInput.value = '';
      applyFilterChange(() => {
        searchFilters.length = 0;
        djSearchFilters.length = 0;
        genreSearchFilters.length = 0;
      });
    }

    function removeLastSearchChip() {
      applyFilterChange(() => {
        if (genreSearchFilters.length) genreSearchFilters.pop();
        else if (djSearchFilters.length) djSearchFilters.pop();
        else if (searchFilters.length) searchFilters.pop();
      });
    }

    filterSearchClear.addEventListener('click', (e) => {
      e.stopPropagation();
      clearAllSearchChips();
      filterSearchInput.focus();
    });

    function closeUnifiedAc() {
      filterSearchAc.classList.remove('open');
      filterSearchAc.innerHTML = '';
      uniItems = [];
      uniActiveIdx = -1;
    }

    async function showUnifiedAc(query) {
      const q = query.trim();
      if (!q) { closeUnifiedAc(); return; }
      try {
        const [artists, djs, genres] = await Promise.all([
          apiSearchArtists(q, 5),
          apiSearchDjs(q, 5),
          Promise.resolve(searchGenresLocal(q, 8)),
        ]);
        const all = [];
        for (const g of genres) all.push({ entry: g, type: 'genre', label: g.isParent ? g.display : `${g.display} (${g.parent})` });
        for (const a of artists) all.push({ entry: a, type: 'artist', label: a.display });
        for (const d of djs) all.push({ entry: d, type: 'dj', label: d.display });
        if (all.length === 0) {
          filterSearchAc.innerHTML = '<div class="ac-item ac-no-results">No results, try different artist, DJ or genre</div>';
          filterSearchAc.classList.add('open');
          uniItems = []; uniActiveIdx = -1;
          return;
        }
        filterSearchAc.innerHTML = '';
        uniItems = [];
        uniActiveIdx = -1;
        for (let i = 0; i < all.length; i++) {
          const { entry, type, label } = all[i];
          const div = document.createElement('div');
          div.className = 'ac-item';
          div.innerHTML = `<span class="ac-name">${escHtml(label)}</span><span class="ac-type">${type}</span>`;
          div.addEventListener('click', (e) => {
            e.stopPropagation();
            // addSearchBarChip -> addSearchFilter/addDjFilter/addGenreSearchFilter
            // all route through applyFilterChange, which handles the reshuffle.
            addSearchBarChip(type, entry);
          });
          div.addEventListener('mouseenter', () => {
            uniItems.forEach(el => el.classList.remove('active'));
            div.classList.add('active');
            uniActiveIdx = i;
          });
          filterSearchAc.appendChild(div);
        }
        uniItems = [...filterSearchAc.children];
        filterSearchAc.classList.add('open');
      } catch (e) { console.warn('Unified search error:', e.message); }
    }

    filterSearchInput.addEventListener('input', () => {
      clearTimeout(uniDebounce);
      if (filterSearchInput.value.trim()) {
        uniDebounce = setTimeout(() => showUnifiedAc(filterSearchInput.value), 150);
      } else {
        closeUnifiedAc();
      }
    });
    filterSearchInput.addEventListener('focus', () => {
      if (filterSearchInput.value.trim()) showUnifiedAc(filterSearchInput.value);
    });
    filterSearchInput.addEventListener('keydown', (e) => {
      // Backspace on empty input removes the last chip
      if (e.key === 'Backspace' && !filterSearchInput.value && filterSearchWrap.classList.contains('has-chips')) {
        e.preventDefault();
        removeLastSearchChip();
        return;
      }
      if (!filterSearchAc.classList.contains('open')) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        uniActiveIdx = Math.min(uniActiveIdx + 1, uniItems.length - 1);
        uniItems.forEach((el, i) => el.classList.toggle('active', i === uniActiveIdx));
        uniItems[uniActiveIdx]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        uniActiveIdx = Math.max(uniActiveIdx - 1, 0);
        uniItems.forEach((el, i) => el.classList.toggle('active', i === uniActiveIdx));
        uniItems[uniActiveIdx]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (uniActiveIdx >= 0 && uniActiveIdx < uniItems.length) uniItems[uniActiveIdx].click();
      } else if (e.key === 'Escape') {
        closeUnifiedAc();
      }
    });
    // Close when clicking outside
    document.addEventListener('mousedown', (e) => {
      if (!filterSearchInput.closest('.filter-search-wrap').contains(e.target)) {
        closeUnifiedAc();
      }
    });
  }

  // ── Cluster context pills ──
  function toggleClusterFilter(filtersArr, entry) {
    applyFilterChange(() => {
      const idx = filtersArr.findIndex(f => f.display === entry.display);
      if (idx >= 0) filtersArr.splice(idx, 1);
      else filtersArr.push({ display: entry.display, trackIds: entry.trackIds });
    });
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

  return { updateClusterPills, updateFilterUI, closeFindAc, closeDjAc, closeGenreAc, clearAllFilters, addDjFilter, addSearchFilter, toggleGenre };
}
