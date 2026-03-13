# Audio Enrichment Reference

How the audio enrichment pipeline works. All phases are implemented and complete.

## Waterfall Priority

```
1. SoundCloud individual track  (full song, best UX)
2. SoundCloud DJ set at timestamp (NTS SC accounts or thelotradio)
3. Mixcloud DJ set at timestamp  (NTS only, last resort fallback)
```

No Deezer — was evaluated but dropped (low hit rate, only 30s previews).

## NTS SoundCloud Accounts

- NTS Latest: `user-202286394-991268468` (~5,700 tracks)
- NTS 2024-2025: `user-643553014` (~16,000 tracks)
- NTS 2023: `user-612196404` (~4,900 tracks)
- NTS 2020: `nts-latest` (~1,400 tracks)

Search by show name (stripped of dates) with `filter.duration=epic`, match by user ID.

## Cache Schema (`audio_cache.json`)

```json
{
  "artist:::title": {
    "source": "soundcloud" | "soundcloud_set" | "mixcloud_set" | "not_found",
    "scTrackUrl": "https://soundcloud.com/artist/track",
    "artUrl": "https://...",
    "setUrl": "https://www.mixcloud.com/NTSRadio/...",
    "setSource": "mixcloud" | "soundcloud",
    "setTimestamp": "00:03:07",
    "setOffsetSec": 187
  }
}
```

Fields are filled based on what was found. A track found individually on SC will still have `setUrl`/`setTimestamp` populated as a fallback.

## Key Technical Details

- **SC client_id:** Extracted from SoundCloud JS bundles at runtime (no API key needed)
- **Rate limits:** SC 0.3s, NTS API 0.15s between requests
- **Episode-level caching:** Many tracks share the same episode, so set URLs are cached per episode to avoid redundant lookups
- **enrich.py is incremental:** Saves every 500 tracks, Ctrl-C safe, just re-run to resume

## Frontend Playback Quirks

- **SC set seek:** 800ms delay after READY event (seeking before buffer loaded fails silently)
- **Mixcloud seek:** 1.5s delay + 2s retry with `getPosition()` verification (~30% first-attempt success rate)
- **Mixcloud links:** No `#t=` suffix (Mixcloud doesn't support URL timestamps)
- **Album art for set-only tracks:** Grey placeholder gradient (no art available)

## Data Flow

```
combined_graph.json ──> enrich.py ──> audio_cache.json
  For each node:
    1. Search SoundCloud for individual track
    2. If miss: look up episode context -> get set URL + timestamp
       - NTS: /api/v2/shows/{show}/episodes/{ep} for mixcloud URL
       - Lot Radio: search SC for "thelotradio {show_name}" with filter.duration=epic
    3. Write findings to cache
```

## Coverage Breakdown

| Source | % |
|---|---|
| SoundCloud (individual track) | ~64% |
| SoundCloud (DJ set) | ~33% |
| Mixcloud (DJ set) | ~3% |
| Not found | <0.2% |
