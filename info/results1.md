# Adjacency Engine Testing - Round 1

## Date: 2026-02-07

## Test Setup
- Graph: 9,396 nodes, 18,124 edges, 503 episodes
- Normalization: lowercase + strip special chars (unicode-aware)
- BFS depth: 3 ranks
- Sampled 5 non-electronic tracks with ≥2 edges

## Samples Tested

### Cluster 2: Sébastien Forrester - Din
- **Genres:** alternative club, alternative pop, reggaeton, experimental, industrial
- **DJ:** Club Etiquette with Cisne and The Dance Pit
- Rank 1: XEXA — Oásis · Yalla Soundsystem x Cheb GPT — Transmission
- Rank 2: Indus Bonze — Björk - All is Full of Love (Gabber Bootleg) · K1RA — Far Away
- Rank 3: B E N N — 熵搖籃曲 Entropy's Lullaby · SUS1ER — Stress Exercise
- **Feedback:** Root song was different from usual listening, still a bit uncomfortable. Liked about half the recs. One rec was a strong hit — "really really liked."

### Cluster 3: Dj Rankng - Friki Friki (Meca Riddim)
- **Genres:** alternative club
- **DJ:** A Sound Place with Boo Lean
- Rank 1: Obeka — Chaka Zulu (feat. I Jahbar) · ben bondy — ayymos
- Rank 2: Iñigo Montoya! — Orchestre du vélo tout puissant (Nhyx Rework) · Toma Kami — Solo Use
- Rank 3: Jurango — Inner Seem · Toma Kami — Z53 - Solo Use
- **Feedback:** LOVED the root song. Loved Chaka Zulu (rank 1) — wouldn't have found it otherwise. ben bondy cool. Toma Kami Solo Use interesting but wouldn't replay. Iñigo Montoya not really the vibe. Jurango Inner Seem cool. Z53 couldn't find. Solo Use appeared twice (dedup bug).

### Cluster 4: Sanchez - I Can't Wait
- **Genres:** dub, dancehall
- **DJ:** POSITIVE REALITY with Queen Majesty
- Rank 1: Richie Stephens — Trying To Get To You · El General — Un Amor Que Puedas Sentir
- Rank 2: Nadine Sutherland — Baby Face · Major Worries — Sweet Little Rose
- Rank 3: Sugar Minott — Sprinter Stayer · Carl Meeks — Weh Dem Fah
- **Feedback:** Not the vibe overall. Interestingly rank 3 was closer to taste than rank 1/2, but still not a match.

### Cluster 5: Shakes & Les - Funk 55 (feat. Ceeka RSA, Chley)
- **Genres:** amapiano
- **DJ:** summer school radio with Saint Virgil
- Rank 1: Kabza De Small, Ami Faku — Abalele · Kabza De Small, Mthunzi — Imithandazo
- Rank 2: Sparklmami, William Corduroy & Eddie Burns — summer school radio with Lovie · Tebza De DJ — Ka Valungu
- Rank 3: Murumba Pitch, Mas Musiq, Daliwonga — Moet
- **Feedback:** Root song was smooth, a bit "Soulection lounge" — messed with it though. Rank 1 Kabza songs sleepy, Mthunzi better but too dramatic/theatric. Rank 2 a bit better. Rank 3 nah.

## Key Findings

### What's Working
- **The core thesis is validated.** DJ adjacency produces genuine discovery — Friki Friki → Chaka Zulu is the ideal outcome. Found music you loved that you'd never have encountered.
- **Even uncomfortable root songs produce hits.** The Sébastien Forrester cluster pushed outside comfort zone and still yielded a strong like — the genre-expanding effect works.
- **Misses are still interesting.** Even tracks that weren't a match exposed new genres/worlds. Not boring misses like typical algorithmic recs.

### Hit Rate
- Estimated ~30-50% across tested clusters (when root song was liked).
- Comparable to or better than Spotify Discover Weekly for *actual discovery* (not passive tolerance).
- Higher value per hit — these are genuinely novel finds, not "more of the same."

### Rank Observations
- With small data (avg ~2 edges per node), rank 1/2 had higher chance of being liked when root song was liked.
- Rank doesn't cleanly equal quality — cluster 4 had rank 3 closer to taste than rank 1.
- At current data size, rank 1 is often within one DJ's set. Rank 3 may jump to a different set/DJ entirely.
- Expect rank behavior to change at 100k nodes: rank 1 will pull from multiple DJs, rank 2/3 will branch more.

### Problems to Solve
- **Track findability:** Many tracks hard to find across Spotify/YouTube/SoundCloud. Some not on any platform. Need to pre-filter catalogue against Spotify API.
- **Dedup bug:** Same track (Toma Kami - Solo Use) appeared at both rank 2 and rank 3. BFS should deduplicate to closest rank only.
- **Rank presentation:** Showing rank 1/2/3 to users may set wrong expectations. Consider presenting as flat pool or not exposing rank numbers.

### Comparison to Existing Recommendation Engines
- Spotify "listeners also liked" optimizes for low skip rate (~70-80% non-skip) but serves familiar, safe recommendations. Not true discovery.
- Spotify Discover Weekly: users typically really like ~1 song per week out of 30. ~10-20% genuine hit rate.
- This engine: ~30-50% hit rate on genuinely unfamiliar music. Lower than "related artists" but higher than discovery playlists, with much higher novelty per hit.
