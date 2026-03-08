# Audio Enrichment Plan

## Goal

Pre-build a cache of playable audio URLs for all ~45K tracks in the combined graph, achieving 100% audio coverage through a waterfall of sources.

## Research Findings (2026-03-07)

### Individual Track Lookup (SoundCloud + Deezer)

Tested across 3 random samples (n=100, 50, 100):

| Source | Candidates (3+ edges) | All nodes | NTS-only |
|---|---|---|---|
| SoundCloud (full track) | 77% | 51-60% | 62% |
| Deezer (30s preview) | 14% | 10-19% | 18% |
| Nothing | 8% | 30% | 20% |
| **Any audio** | **91%** | **70%** | **80%** |

- SoundCloud search via `api-v2.soundcloud.com/search/tracks` with extracted `client_id`
- Deezer search via `api.deezer.com/search` (no auth needed)
- Well-connected nodes (candidates) have better coverage than obscure leaf nodes
- Misses are typically: DJ edits, unreleased tracks, field recordings, non-Latin titles

### DJ Set Fallback

| Platform | Source | Hit Rate | Sample |
|---|---|---|---|
| **NTS** | Mixcloud (`mixcloud.com/NTSRadio/...`) | **100%** (98/98 episodes) | n=100 tracks across 98 unique episodes |
| **Lot Radio** | SoundCloud (`soundcloud.com/thelotradio/...`) | **100%** (50/50 episodes) | n=50 episodes with tracklists |

- NTS: every episode has a `mixcloud` field in the API response (`GET /api/v2/shows/{show}/episodes/{ep}`)
- Lot Radio: every set is uploaded to the `thelotradio` SoundCloud account. Findable via SC search API with `filter.duration=epic` (>10min)
- Both platforms' embeddable widgets support seeking to a specific offset

### Combined Coverage

With the full waterfall, **100% of tracks get some form of audio**:
1. ~60% get the individual track (full song via SoundCloud)
2. ~15% get a 30-second Deezer preview + album art
3. ~25% fall back to the DJ set at the correct timestamp

## Architecture

### Waterfall Priority

```
1. SoundCloud individual track  (full song, best UX)
2. SoundCloud DJ set at timestamp (NTS SC accounts or thelotradio)
3. Mixcloud DJ set at timestamp  (NTS only, last resort fallback)
```

### NTS SoundCloud Accounts
- NTS Latest: user-202286394-991268468 (5,727 tracks)
- NTS 2024-2025: user-643553014 (16,176 tracks)
- NTS 2023: user-612196404 (4,922 tracks)
- NTS 2020: nts-latest (1,368 tracks)
- Search by show name (stripped of dates) with `filter.duration=epic`, match by user ID

### Cache Schema: `output/audio_cache.json`

```json
{
  "artist:::title": {
    "source": "soundcloud" | "deezer" | "mixcloud_set" | "soundcloud_set" | "not_found",

    "scTrackUrl": "https://soundcloud.com/artist/track",

    "artUrl": "https://e-cdns-images.dzcdn.net/images/cover/...",
    "previewUrl": "https://cdns-preview-X.dzcdn.net/stream/...",

    "setUrl": "https://www.mixcloud.com/NTSRadio/...",
    "setSource": "mixcloud" | "soundcloud",
    "setTimestamp": "00:03:07",
    "setOffsetSec": 187
  }
}
```

Fields are filled based on what was found. A track found on SoundCloud individually will still have `setUrl`/`setTimestamp` populated for the DJ set fallback (useful if the SC track gets taken down).

### What needs to change in the graph

The current `combined_graph.json` edge contexts have `episode_url` and `dj` but **no timestamps**. The timestamps exist in the episode JSONs (`lot_radio_episodes.json`, `nts_episodes.json`) but were dropped during graph generation.

**Fix:** Update `graph.py` to carry `timestamp` and `position` through to the graph contexts. This is needed so the frontend knows where to seek in the DJ set.

### Data flow

```
Phase 1: Rebuild graph with timestamps
  lot_radio_episodes.json  ─┐
  nts_episodes.json        ─┤──> graph.py (updated) ──> combined_graph.json (with timestamps)
                             │
Phase 2: Build audio cache
  combined_graph.json ──> enrich.py (rewritten) ──> audio_cache.json
    For each node:
      1. Search SoundCloud for individual track
      2. If miss: search Deezer
      3. Look up episode context -> get set URL + timestamp
         - NTS: hit /api/v2/shows/{show}/episodes/{ep} for mixcloud URL
         - Lot Radio: search SC for "thelotradio {artist_name}"
      4. Write all findings to cache

Phase 3: Frontend uses cache
  index.html loads audio_cache.json
  On cluster display, looks up each track in cache
  Plays via: SC widget > HTML5 audio (Deezer) > SC/Mixcloud widget (set)
```

## Implementation Details

### Phase 1: Add timestamps to graph

**File:** `lot-radio-scraper/graph.py`

The adjacency pairs are generated from consecutive tracks in a tracklist. Each track already has a `timestamp` field (e.g. `"00:03:07"`). Pass this through to the edge context:

```python
# Current context
{"dj": "...", "episode_url": "...", "date": "...", "position": 1}

# Updated context
{"dj": "...", "episode_url": "...", "date": "...", "position": 1, "timestamp": "00:03:07"}
```

Also add `timestamp` to the **node** level (from the first context where this track appears), so the frontend can seek directly without traversing edges.

### Phase 2: Rewrite enrich.py

**File:** `lot-radio-scraper/enrich.py`

Rewrite to produce the new `audio_cache.json` format:

1. Load `combined_graph.json`
2. Load existing cache (incremental/resumable)
3. For each uncached node:
   - Search SoundCloud individual track (reuse `search_soundcloud` from cluster.py)
   - If miss, search Deezer (reuse `search_deezer`)
   - Extract episode URL from node's edge contexts
   - For NTS episodes: fetch Mixcloud URL from API (cache per episode)
   - For Lot Radio episodes: search SC for set (cache per episode)
   - Compute `setOffsetSec` from timestamp string
4. Save progress every 500 tracks
5. Ctrl-C safe (saves on interrupt)

**Rate limiting:**
- SoundCloud: 0.3s between requests, retry on 429
- Deezer: 0.25s between requests
- NTS API: 0.15s between requests
- Estimated runtime for 45K nodes: ~4-5 hours

**Episode-level caching:** Since many tracks share the same episode, cache Mixcloud/SC set URLs per episode URL to avoid redundant lookups. ~1500 Lot Radio episodes + ~3500 NTS episodes = ~5000 episode lookups total.

### Phase 3: Frontend changes

**File:** `lot-radio-scraper/index.html`

1. Load `audio_cache.json` instead of `deezer_cache.json`
2. Update `enrichFromCache()` to populate `scTrackUrl`, `previewUrl`, `setUrl`, `setSource`, `setOffsetSec`
3. Update `togglePlay()` waterfall:
   - If `scTrackUrl` exists: play via SC widget (current behavior)
   - Else if `previewUrl` exists: play via HTML5 audio (current behavior)
   - Else if `setUrl` exists:
     - If `setSource === "mixcloud"`: load Mixcloud widget, seek to `setOffsetSec`
     - If `setSource === "soundcloud"`: load SC widget with set URL, seek to `setOffsetSec`
4. Add Mixcloud widget support:
   - Add `<script src="https://widget.mixcloud.com/media/js/widgetApi.js"></script>`
   - Add hidden Mixcloud iframe (similar to existing SC iframe)
   - Implement `playMixcloud(nodeId, mixcloudUrl, offsetSec)` function
5. Visual indicator for playback source:
   - SC individual track: SoundCloud badge (existing)
   - Deezer preview: small "30s" badge
   - DJ set: "from set" badge + DJ name

### UX Considerations

- **DJ set playback:** When playing from a set, show a subtle indicator like "Playing from {DJ name}'s set" so the user understands why the audio might include a mix/transition
- **Seek accuracy:** Timestamps from tracklists are approximate. The actual track may start a few seconds before/after. This is fine.
- **Set loading time:** Mixcloud/SC widgets for full sets take 2-3s to load vs instant for individual tracks. Show a loading spinner on the play button.
- **Crossfade/bleed:** In a DJ mix, tracks blend into each other. The user will hear the previous track fading out. This is actually a feature, not a bug — it's how the DJ intended the transition.

## File Changes Summary

| File | Change | Status |
|---|---|---|
| `graph.py` | Add `timestamp` to edge contexts | Done |
| `enrich.py` | Rewrite: SC track + SC/MC set lookup, output `audio_cache.json` | Done |
| `index.html` | Load new cache, SC/Mixcloud widget playback, source filters | Done |
| `cluster.py` | No changes (search functions reused as-is) | N/A |

## Implementation Status (2026-03-08)

- **Phase 1 (graph):** Complete — 68,218 nodes, 140,884 edges with timestamps
- **Phase 2 (enrichment):** Running — ~32K/68K cached so far
  - Deezer reprocessing: Done (0 entries, already cleaned up)
  - Mixcloud→SC upgrade: Done (3,508 entries processed)
  - Full enrichment: In progress (~39K remaining)
- **Phase 3 (frontend):** Complete
  - SC widget + Mixcloud widget playback working
  - SC set seek fix (800ms delay after READY)
  - Mixcloud seek fix (1.5s delay + 2s retry verification)
  - Source filter dropdown: soundcloud, soundcloud — full set, lot radio set, mixcloud set
  - Mixcloud links don't get `#t=` suffix (not supported by Mixcloud)

## Current Cache Breakdown

| Source | Count | % |
|---|---|---|
| SoundCloud (individual track) | ~20,900 | 65% |
| SoundCloud (DJ set) | ~10,400 | 33% |
| Mixcloud (DJ set) | ~670 | 2% |
| Not found | ~75 | <1% |

## Resolved Questions

1. **Cache size:** ~32K entries so far, manageable as single JSON
2. **SC client_id stability:** Works fine, extracted from JS bundles at runtime
3. **Mixcloud widget limitations:** `seek()` works but unreliable (~30% success) due to autoplay policy. No URL timestamp support.
4. **Album art for set-only tracks:** Left blank (grey placeholder)
