# Data Model

## Graph (`combined_graph.json`)

Single-pass build from all episode tracklists. For every consecutive pair A→B in a DJ set, a bidirectional edge A↔B is created. The graph is both the track index and the adjacency map — there is no separate track list.

**Node** (keyed by `normalized_artist:::normalized_title`):
- `title`, `artist` — first-seen display names
- `first_episode_url`, `first_timestamp` — used by enrichment to locate the DJ set
- `genres` — from the episode(s) the track appeared in
- `edges[]` — `{node, contexts[]}`

**Edge context** (one per DJ set where the adjacency occurred):
- `dj`, `episode_url`, `date`, `position`, `timestamp_a`, `timestamp_b`

Multiple contexts on the same edge = stronger recommendation signal.

## Audio Cache (`audio_cache.json`)

Keyed by the same `artist:::title` ID. Waterfall per track:
1. SoundCloud individual track (`source: "soundcloud"`)
2. SoundCloud DJ set at timestamp (`source: "soundcloud_set"`)
3. Mixcloud DJ set at timestamp (`source: "mixcloud_set"`)

## Query Flow

Frontend loads the static graph, picks a seed track, runs client-side BFS to desired depth. No runtime search or join — just traversal.
