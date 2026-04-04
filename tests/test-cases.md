# Test Cases — Server API Migration

Reusable test cases for verifying API endpoints, data integrity, and frontend user flows
after moving graph logic server-side.

---

## A. API Data Verification (curl-based)

### A1. Server startup and data loading
- [ ] `npm run server` starts without errors
- [ ] Logs show node count (should be ~68,218)
- [ ] Logs show candidate count, artist count, DJ count, genre count
- [ ] Server binds to port 3001

### A2. GET /api/genres
- [ ] Returns JSON array
- [ ] Exactly 30 entries (displayGenres = top 30)
- [ ] Each entry has `{ name: string, count: number }`
- [ ] Sorted by count descending
- [ ] First genre has highest count
- [ ] No empty names
- [ ] Common genres present: "Electronic", "Ambient", "Hip Hop/Rap", "Soul"

### A3. GET /api/shuffle (no filters)
- [ ] Returns 200 with JSON
- [ ] Has `meta` object with: `root_id`, `found`, `not_found`, `totalR1`, `r1Shown`, `poolSize`
- [ ] Has `nodes` array (non-empty)
- [ ] Has `edges` array
- [ ] Root node (nodes[0]) has `rank: "root"`
- [ ] Each node has: `id`, `graphId`, `rank`, `title`, `artist`, `djs`
- [ ] Each node has audio fields: `source`, `scTrackUrl`, `artUrl`, `setUrl`, `setSource`, `setOffsetSec`
- [ ] Edges have `from` and `to` referencing valid node IDs
- [ ] `meta.poolSize` > 10000 (large unfiltered pool)
- [ ] Calling twice returns different root_id (randomness works)

### A4. GET /api/shuffle — source filter
- [ ] `?source=soundcloud` → all root nodes have `scTrackUrl` set
- [ ] `?source=soundcloud_set` → root has no `scTrackUrl`, source is `soundcloud_set`
- [ ] `?source=lotradio` → root has `setSource: "soundcloud"` and no `scTrackUrl`
- [ ] `?source=none` → same as no filter (all sources)
- [ ] Each filtered pool is smaller than unfiltered pool (check meta.poolSize)

### A5. GET /api/shuffle — genre filter
- [ ] `?genres=Electronic` → returns cluster, poolSize < unfiltered
- [ ] `?genres=Ambient` → returns cluster
- [ ] `?genres=Hip Hop/Rap` → returns cluster
- [ ] `?genres=Electronic,Ambient` → OR logic: poolSize >= either genre alone
- [ ] `?genres=NONEXISTENT` → returns 404 "No tracks match"
- [ ] Root node's graphId exists in the graph and has the filtered genre in its genres array

### A6. GET /api/shuffle — artist filter
- [ ] `?artists=Burial` → returns cluster where root or neighbors include Burial
- [ ] `?artists=Four Tet` → returns cluster
- [ ] `?artists=Aphex Twin` → returns cluster
- [ ] `?artists=NONEXISTENT_ARTIST_XYZ` → 404 "No tracks match"
- [ ] `?artists=Burial,Four Tet` → OR logic, pool >= either alone
- [ ] Verify poolSize is much smaller than unfiltered

### A7. GET /api/shuffle — DJ filter
- [ ] `?djs=Shy One` → returns cluster
- [ ] `?djs=Charlie Bones` → returns cluster (Lot Radio DJ)
- [ ] `?djs=NONEXISTENT_DJ_XYZ` → 404
- [ ] DJ filter uses djNameMap expansion (show title → DJ names)
- [ ] Pool includes tracks from edges where DJ played them

### A8. GET /api/shuffle — combined filters
- [ ] `?genres=Electronic&artists=Burial` → intersection of genre + artist
- [ ] `?genres=Hip Hop/Rap&djs=Shy One` → intersection of genre + DJ
- [ ] `?source=soundcloud&genres=Electronic` → both source and genre applied
- [ ] `?artists=Burial&djs=Charlie Bones` → OR within artist/DJ, then intersect with pool
- [ ] Pool sizes get progressively smaller as more filters are added

### A9. GET /api/shuffle — exclude parameter
- [ ] First call: get root_id X. Second call with `?exclude=X` → different root_id
- [ ] Excluding many IDs still returns results (falls back to full pool when all excluded)
- [ ] Empty exclude has no effect

### A10. GET /api/cluster/:id
- [ ] Valid ID returns cluster centered on that node
- [ ] Root node's `graphId` matches the requested ID
- [ ] Node count = 1 (root) + r1 + r2 nodes
- [ ] Default r1=4, r2=1 → max 1 + 4 + 4 = 9 nodes
- [ ] `?r1=2&r2=0` → only root + 2 r1 nodes (no r2)
- [ ] `?expand=1` → r1Limit=8, more nodes
- [ ] `?expand=2` → unlimited r1 and r2
- [ ] Invalid ID → 404 `Node "..." not found`
- [ ] ID with special chars (e.g., `artist:::title` with `&` or spaces) → works with encoding

### A11. GET /api/search/artists
- [ ] `?q=bur` → returns matches including "Burial"
- [ ] `?q=four` → returns "Four Tet"
- [ ] `?q=a` → returns many results (common prefix)
- [ ] `?q=` (empty) → returns first N artists alphabetically
- [ ] `?q=ZZZZNONEXIST` → returns empty array
- [ ] Each result has `{ display, trackCount, clusterCount }`
- [ ] `?limit=5` → at most 5 results
- [ ] Prefix matches appear before substring matches (e.g., "Burial" before "Pre-Burial")
- [ ] Case insensitive: `?q=BURIAL` works same as `?q=burial`

### A12. GET /api/search/djs
- [ ] `?q=shy` → returns "Shy One"
- [ ] `?q=charlie` → returns "Charlie Bones"
- [ ] `?q=` → returns first N DJs alphabetically
- [ ] `?q=ZZZZNONEXIST` → returns empty array
- [ ] Each result has `{ display, trackCount, clusterCount }`
- [ ] Prefix match priority same as artists

### A13. GET /api/crates
- [ ] `?seed=12345&page=0&count=12` → returns `{ clusters, hasMore }`
- [ ] Each cluster has: `seedKey`, `label`, `title`, `artist`, `count`, `artworks`, `artKeys`, `memberKeys`, `weight`
- [ ] `artworks` is array of URLs (strings)
- [ ] `count` is a positive integer
- [ ] Missing seed → 400 "seed parameter required"
- [ ] `?seed=0` → works (edge case: rng starts at 1)
- [ ] Same seed+page+count → deterministic (same clusters every time)
- [ ] Different seeds → different clusters
- [ ] `page=1` returns different clusters than `page=0` for same seed
- [ ] `page=51` → 400 "Max page depth is 50"
- [ ] `count=25` → clamped to 24 (max)
- [ ] No overlapping seedKeys between page 0 and page 1 (usedNodes tracking)

### A14. GET /api/crates — with filters
- [ ] `?seed=100&page=0&count=12&genres=Electronic` → clusters have electronic-adjacent tracks
- [ ] `?seed=100&page=0&count=12&artists=Burial` → filtered crates
- [ ] `?seed=100&page=0&count=12&djs=Charlie Bones` → filtered crates
- [ ] Filtered crates have fewer total clusters (hasMore becomes false sooner)
- [ ] Very narrow filter may return fewer than `count` clusters

---

## B. Data Integrity Checks

### B1. Node structure
- [ ] Every node in a cluster response has both `artist` and `title` (non-empty strings)
- [ ] `graphId` format is `artist:::title`
- [ ] No node has `source: undefined` (should be a valid source or "not_found")
- [ ] `rank` is one of: "root", "1", "2"

### B2. Edge structure
- [ ] Every edge's `from` and `to` reference existing node IDs in the same cluster
- [ ] Root node (id="root") appears in at least one edge's `from` field
- [ ] R2 nodes connect to R1 nodes (not directly to root)
- [ ] Edge contexts have `dj`, `episodeUrl`, `date` when present

### B3. Audio cache integrity
- [ ] Nodes with `source: "soundcloud"` have `scTrackUrl` set
- [ ] Nodes with `source: "soundcloud_set"` have `setUrl` set
- [ ] Nodes with `source: "mixcloud_set"` have `setUrl` set
- [ ] Nodes with `source: "not_found"` have null audio fields
- [ ] `artUrl` is a URL string or null (never undefined)

### B4. Genre data
- [ ] Genre list counts are positive integers
- [ ] Genre names are non-empty, no leading/trailing whitespace
- [ ] Top genres match expected values (Electronic, Hip Hop/Rap, Soul, etc.)

### B5. Search index integrity
- [ ] Artist search returns entries with trackCount > 0
- [ ] DJ search returns entries with trackCount > 0
- [ ] clusterCount <= trackCount for every entry
- [ ] Known multi-artist tracks are split: searching "Oklou" finds tracks where she's a featured artist

### B6. Crates determinism
- [ ] Two requests with identical seed/page/count return byte-identical JSON
- [ ] seed=0 and seed=2147483647 don't crash (boundary values)
- [ ] Page 0 clusters and page 1 clusters have no overlapping seedKeys
- [ ] memberKeys across clusters on the same page have limited overlap (<30% per the logic)

---

## C. Frontend User Flows — Tracks Mode

### C1. Initial load
- [ ] Page loads without console errors
- [ ] Initial shuffle happens automatically
- [ ] Root card displays with artist, title, shuffle button
- [ ] R1 and R2 cards render with connections
- [ ] Album art loads on cards (where available)
- [ ] Filter bar is visible with all controls

### C2. Shuffle (no filters)
- [ ] Click shuffle → new cluster appears
- [ ] Each shuffle shows different tracks
- [ ] URL hash updates to `#artist:::title`
- [ ] Pool size shown in UI (if applicable)
- [ ] Shuffle 10 times → no repeated root tracks (history exclusion works)

### C3. Genre filter → shuffle
- [ ] Select "Electronic" genre pill → pill highlights
- [ ] Shuffle → cluster root has Electronic genre
- [ ] Select "Hip Hop/Rap" additionally → both highlighted
- [ ] Shuffle → root has either Electronic OR Hip Hop/Rap
- [ ] Deselect both → back to unfiltered
- [ ] Pool size decreases with genre filter active

### C4. Artist search → filter → shuffle
- [ ] Type "Burial" in artist search → autocomplete dropdown appears
- [ ] Select "Burial" → chip appears in filter bar
- [ ] Shuffle → cluster includes Burial tracks
- [ ] Type "Four Tet" → add second artist filter
- [ ] Shuffle → cluster includes either Burial or Four Tet
- [ ] Remove one chip → only remaining artist filtered
- [ ] Remove all → back to unfiltered

### C5. DJ search → filter → shuffle
- [ ] Type "Shy" in DJ search → autocomplete shows "Shy One"
- [ ] Select → DJ chip appears
- [ ] Shuffle → cluster tracks are from sets played by Shy One
- [ ] Add "Charlie Bones" DJ → OR logic
- [ ] Remove DJ filters → back to unfiltered

### C6. Combined filters
- [ ] Genre "Electronic" + Artist "Burial" → very specific results
- [ ] Genre "Hip Hop/Rap" + DJ filter → intersection
- [ ] Source filter "SoundCloud" + Genre "Ambient" → both applied
- [ ] Multiple genres + artist + DJ → smallest pool
- [ ] Clear all → resets everything
- [ ] Pool size indicator reflects filter narrowing

### C7. Source filter
- [ ] Select "SoundCloud" → shuffle only returns SC-playable tracks
- [ ] Select "SoundCloud Sets" → tracks play from DJ sets
- [ ] Select "Lot Radio" → Lot Radio source tracks
- [ ] Select "All Sources" → back to unfiltered

### C8. Direct cluster load (URL hash)
- [ ] Navigate to `#Burial:::Archangel` (or known track) → loads specific cluster
- [ ] Root card shows "Burial - Archangel"
- [ ] Back button works (history navigation)
- [ ] Bookmark with hash → reloads correct cluster

### C9. Expand cluster
- [ ] Click "show more" on root card → cluster expands with more R1 nodes
- [ ] Click again → further expansion
- [ ] Expanded cluster maintains root
- [ ] Connections render correctly for expanded clusters

### C10. Card interactions
- [ ] Click track card → starts audio playback (if source available)
- [ ] DJ pills on cards are clickable → filter by that DJ
- [ ] Artist name clickable → filter by that artist
- [ ] Art URL loads correctly where available
- [ ] "not_found" tracks show appropriate state (no play button or disabled)

### C11. Clipboard / share
- [ ] Click link/share button on root card → copies URL to clipboard
- [ ] Copied URL contains the hash with current root track

---

## D. Frontend User Flows — Crates Mode

### D1. Enter crates mode
- [ ] Click "Crates" tab → crates view appears
- [ ] Initial page of crate tiles loads
- [ ] Each tile shows album art mosaic, label, track count
- [ ] Treemap layout fills viewport without gaps

### D2. Crates navigation
- [ ] Pan left/right → new pages load dynamically
- [ ] Pan up/down → additional pages
- [ ] Pages at edges load as they come into view
- [ ] Previously loaded pages are retained when panning back

### D3. Crate tile interaction
- [ ] Click a crate tile → loads that cluster in tracks mode
- [ ] Switches from crates view to tracks view
- [ ] Root of loaded cluster matches the crate's seed track

### D4. Crates with filters
- [ ] Activate genre filter "Electronic" → re-enter crates → filtered crates
- [ ] Crate tiles reflect filtered subset
- [ ] Artist filter active → crates contain matching artist tracks
- [ ] DJ filter active → crates from that DJ's track pool
- [ ] Clear filters → crates reset to unfiltered

### D5. Crates determinism
- [ ] Re-enter crates mode → same layout (seed doesn't change within session)
- [ ] Same crate tiles appear in same positions

### D6. Mode switching
- [ ] Crates → Tracks → Crates → state preserved
- [ ] Filters persist across mode switches
- [ ] Shuffle in tracks mode, switch to crates, switch back → different cluster

---

## E. Theme / Night Mode

### E1. Light mode (default)
- [ ] Background is light
- [ ] Text is dark and readable
- [ ] Cards have light background
- [ ] Genre pills are styled correctly
- [ ] Connections are visible

### E2. Dark mode
- [ ] Toggle night mode → background goes dark
- [ ] Text switches to light colors
- [ ] Cards have dark backgrounds
- [ ] Album art still visible
- [ ] Connections visible against dark background
- [ ] Genre pills styled correctly in dark mode
- [ ] Autocomplete dropdowns readable in dark mode
- [ ] Crates tiles visible in dark mode

### E3. Theme persistence
- [ ] Toggle to dark → refresh → stays dark (if persisted)
- [ ] All UI elements adapt (no hardcoded colors leaking)

---

## F. Edge Cases and Error Handling

### F1. Empty filter results
- [ ] Genre filter that matches nothing → appropriate error/message
- [ ] Artist that exists but has no candidates → graceful handling
- [ ] Combined filters that eliminate all tracks → shows "no results" not a crash

### F2. Special characters
- [ ] Artist names with `&` (e.g., "Simon & Garfunkel" style) → search works
- [ ] Track titles with quotes, apostrophes → display correctly
- [ ] DJ names with accents/diacritics → search and display work
- [ ] URL hash with special chars → encodes/decodes correctly

### F3. Rapid interactions
- [ ] Rapid shuffle clicks → no race conditions, last result shown
- [ ] Rapid filter toggling → UI stays consistent
- [ ] Type fast in search → autocomplete keeps up, no stale results

### F4. Network issues
- [ ] Kill server → shuffle attempt → shows error (not blank screen)
- [ ] Slow response → no duplicate requests piling up
- [ ] Server restart → next shuffle works

### F5. Boundary values
- [ ] Cluster with only 1 R1 node → renders correctly
- [ ] Cluster with 0 R2 nodes → still works
- [ ] Artist with 1 track → filter works but pool is tiny
- [ ] Crates page 0 with count=1 → single crate returned

---

## G. Specific Artist/DJ Queries to Verify

These are real names to test with, covering various patterns.

### G1. Artist searches
| Query | Expected matches (subset) |
|-------|--------------------------|
| `burial` | Burial |
| `four tet` | Four Tet |
| `aphex` | Aphex Twin |
| `radiohead` | Radiohead |
| `bjork` | Bjork / Bjork |
| `joy` | Joy Division, Joy Orbison, Joy Anonymous... |
| `dj` | DJ Shadow, DJ Rashad, DJ Koze... |
| `the` | The xx, The Bug, The Knife... |
| `mc` | MC Ride, various MC artists... |
| `a` | Large result set (common letter) |

### G2. DJ searches
| Query | Expected matches (subset) |
|-------|--------------------------|
| `charlie` | Charlie Bones |
| `shy` | Shy One |
| `nts` | Various NTS show hosts |
| `lot` | Lot Radio DJs |
| `b2b` | Any B2B show names |

### G3. Genre selections
| Genre | Expected behavior |
|-------|------------------|
| Electronic | Large pool, most common genre |
| Ambient | Moderate pool, capped at 20% by genreWeightCaps |
| Hip Hop/Rap | Moderate pool |
| Soul | Moderate pool, capped at 15% |
| Jazz | Moderate pool |
| Folk | Small pool, capped at 5% |
| Experimental | Moderate pool |

### G4. Multi-filter combos to verify
| Filters | Expected |
|---------|----------|
| Artist: Burial + Genre: Electronic | Small pool, all Electronic Burial tracks |
| Artist: Burial + Genre: Jazz | Very small or empty (Burial isn't jazz) |
| DJ: Charlie Bones + Source: Lot Radio | Lot Radio tracks from Charlie Bones shows |
| DJ: Shy One + Genre: Hip Hop/Rap | Tracks Shy One played that are hip hop |
| Genre: Electronic + Genre: Ambient | Union of both genres |
| Artist: Four Tet + Artist: Burial | Union of both artists |
| Artist: Burial + DJ: Charlie Bones | Tracks by Burial OR played by Charlie Bones (union within artist/DJ, then intersect with candidates) |

---

## H. Mobile-Specific Tests

### H1. Mobile layout
- [ ] Viewport < 768px → mobile layout active
- [ ] Mobile carousel for track cards
- [ ] Mobile shuffle button visible and functional
- [ ] Mobile filter UI (popover/drawer)

### H2. Mobile interactions
- [ ] Swipe carousel → navigate between cards
- [ ] Tap shuffle → new cluster
- [ ] Mobile search → autocomplete works
- [ ] Mobile genre pills → toggleable
- [ ] Mobile crates → touch pan works

### H3. Mobile <> Desktop no bleed
- [ ] Resize from desktop to mobile → layout switches cleanly
- [ ] Resize back to desktop → desktop layout intact
- [ ] No orphaned mobile elements visible on desktop
- [ ] No orphaned desktop elements visible on mobile

---

## I. Performance Checks

### I1. API response times
- [ ] /api/shuffle < 200ms (should be fast — data in memory)
- [ ] /api/cluster/:id < 100ms
- [ ] /api/search/artists < 50ms
- [ ] /api/search/djs < 50ms
- [ ] /api/genres < 10ms (static data)
- [ ] /api/crates page 0 < 200ms
- [ ] /api/crates page 10 < 1s (fast-forward cost)

### I2. Frontend rendering
- [ ] Cluster renders without visible lag
- [ ] Filter changes don't cause layout thrashing
- [ ] Crates mode panning is smooth (60fps)
- [ ] No memory leaks from repeated shuffles (check heap)

---

## Running the Tests

### API tests (curl)
```bash
# Start server
npm run server

# Genre list
curl -s http://localhost:3001/api/genres | jq length
curl -s http://localhost:3001/api/genres | jq '.[0]'

# Shuffle (no filter)
curl -s http://localhost:3001/api/shuffle | jq '.meta'

# Shuffle (genre filter)
curl -s "http://localhost:3001/api/shuffle?genres=Electronic" | jq '.meta.poolSize'

# Shuffle (artist filter)
curl -s "http://localhost:3001/api/shuffle?artists=Burial" | jq '.meta'

# Shuffle (DJ filter)
curl -s "http://localhost:3001/api/shuffle?djs=Charlie%20Bones" | jq '.meta'

# Cluster by ID
curl -s "http://localhost:3001/api/cluster/Burial:::Archangel" | jq '.meta'

# Artist search
curl -s "http://localhost:3001/api/search/artists?q=burial" | jq '.[0]'

# DJ search
curl -s "http://localhost:3001/api/search/djs?q=shy" | jq '.[0]'

# Crates
curl -s "http://localhost:3001/api/crates?seed=12345&page=0&count=12" | jq '.clusters | length'

# Crates determinism
HASH1=$(curl -s "http://localhost:3001/api/crates?seed=99&page=0&count=5" | md5)
HASH2=$(curl -s "http://localhost:3001/api/crates?seed=99&page=0&count=5" | md5)
[ "$HASH1" = "$HASH2" ] && echo "PASS: deterministic" || echo "FAIL: non-deterministic"

# Error cases
curl -s "http://localhost:3001/api/shuffle?genres=NONEXISTENT" | jq '.error'
curl -s "http://localhost:3001/api/cluster/NONEXISTENT:::TRACK" | jq '.error'
curl -s "http://localhost:3001/api/crates?page=0&count=12" | jq '.error'
```

### Frontend tests (browser)
1. Open http://localhost:8000
2. Open DevTools console
3. Run through sections C-H manually
4. Check console for errors after each action
