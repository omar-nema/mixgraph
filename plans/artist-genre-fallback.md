# Artist → Genre Fallback via MusicBrainz

## Context

When a user searches for an artist that isn't in the graph, the autocomplete silently closes with no results. We want to fall back to genre-based filtering: look up the artist's genres from an external API, map them to our taxonomy, and apply them as genre filters so the user still gets relevant music.

## API Choice: MusicBrainz

Tested MusicBrainz, Last.fm, and Discogs against 5 artists (Burial, Floating Points, Khruangbin, DJ Rashad, Cocteau Twins):

- **MusicBrainz** (winner): Free, no API key, curated `genres` field with vote counts. Many genres are already exact matches to our child genres ("footwork", "ghetto house", "dream pop", "shoegaze", "surf"). 2 API calls per lookup (search + detail). 1 req/sec rate limit.
- **Last.fm**: More tags per artist but noisier ("female vocalists", "80s", city names). Requires free API key. 1 call per lookup.
- **Discogs**: Great data but genre lives on releases, not artists — 3+ calls per lookup.

MusicBrainz's curated genres are the cleanest and map most directly to our taxonomy.

## Genre Mapping Strategy

**Step 1: Build a static mapping table** (`mb_genre_map.json`)

MusicBrainz has ~1,500 genre tags. Many map directly to our ~250 child genres. For the rest, use Claude to generate a one-shot mapping of the top ~500 MB genres → our 20 parents. At runtime it's just a JSON lookup.

Structure:
```json
{
  "future garage": "UK Dance / Grime",
  "dubstep": "UK Dance / Grime",
  "footwork": "New Club",
  "dream pop": "Alt Rock / Punk",
  "electronic": null
}
```

`null` = too vague, skip. Direct child genre matches auto-resolve to their parent.

**Step 2: Runtime lookup** — new Worker endpoint

## Implementation

### 1. New Worker endpoint: `GET /api/artist-genres?q=Burial`

In `worker/index.js`:
- Search MusicBrainz: `GET https://musicbrainz.org/ws/2/artist/?query=artist:{q}&limit=1&fmt=json`
- Get top match MBID, fetch genres: `GET https://musicbrainz.org/ws/2/artist/{mbid}?inc=genres&fmt=json`
- Map each genre through `mb_genre_map.json` (bundled in Worker or stored in KV)
- Return: `{ artist: "Burial", genres: ["UK Dance / Grime", "Electronica / Downtempo"], children: ["Dubstep", "Ambient"] }`
- Cache results in KV (key: `mb-genre:{normalized_artist}`) to avoid repeat lookups

### 2. Frontend fallback in artist search

In `js/filters.js`, modify the `createAc` flow for artist search:
- When `apiSearchArtists` returns empty, call new `apiArtistGenres(q)` endpoint
- Show a special autocomplete result: "No exact match — try genres for {artist}?" listing the matched genres
- On click, apply those genres as genre filters (reuse existing `addGenreSearchFilter`)

### 3. Build the mapping table

- Fetch MusicBrainz genre list (they publish it: `https://musicbrainz.org/genres`)
- Run through Claude once to map each → our 20 parents (or `null` to skip)
- Save as `worker/mb_genre_map.json`, bundle with Worker

## Files to modify

| File | Change |
|---|---|
| `worker/index.js` | Add `/api/artist-genres` endpoint with MB lookup + caching |
| `worker/mb_genre_map.json` | New — static mapping of MB genres → our parent genres |
| `js/api.js` | Add `apiArtistGenres(q)` function |
| `js/filters.js` | Modify artist search to show genre fallback when no results |

## Test results (2025-03-31)

### MusicBrainz genres (curated field)

| Artist | Genres |
|---|---|
| Burial | future garage, dubstep, ambient, electronic, 2-step, uk garage, dub |
| Floating Points | electronic, dubstep, house, microhouse, post-dubstep, progressive house, tech house |
| Khruangbin | psychedelic rock, surf, alternative rock, blues, dub, funk, indie rock, instrumental, neo-psychedelia, psychedelic soul |
| DJ Rashad | footwork, ghetto house, ghettotech |
| Cocteau Twins | dream pop, ethereal wave, shoegaze, post-punk, gothic rock, dark wave, ambient techno |

### Last.fm tags (for reference)

| Artist | Top Tags |
|---|---|
| Burial | dubstep, ambient, electronic, experimental, atmospheric, electronica, future garage, uk garage |
| Floating Points | house, electronic, jazz, downtempo, deep house, dubstep, chillout, post-minimalism, IDM |
| Khruangbin | funk, psychedelic, psychedelic rock, rock, ambient, dub, funk rock |
| DJ Rashad | footwork, juke, electronic, ghettotech, chicago, house |
| Cocteau Twins | dream pop, shoegaze, ethereal, post-punk, alternative, ethereal wave, female vocalists, 80s |

## Verification plan

1. Build `mb_genre_map.json` by fetching MB genre list and mapping via Claude
2. Test Worker endpoint locally with `wrangler dev`: query "Burial", "DJ Rashad", "Cocteau Twins"
3. Verify genre mapping covers the returned genres
4. Test frontend: search for artist not in graph → see genre suggestions → click → genres applied → shuffle works
5. Test both light/dark mode for the fallback UI
6. Test mobile layout for the fallback autocomplete items
