# Platform Support Analysis

## Date: 2026-02-08

## Goal

Determine which music platforms (YouTube, Spotify, SoundCloud, Bandcamp) have the best coverage of tracks in our Lot Radio dataset, to decide the lookup order when fetching/rendering tracks for the recommendation engine.

## Method

Randomly sampled 40 tracks from the scraped dataset (9,596 tracks with artist+title). For each track, searched the web to determine availability on YouTube, Spotify, SoundCloud, and Bandcamp. Three batches: 10 + 10 + 20 tracks, each with a different random seed.

## Results

### Per-platform hit rates (n=40)

| Platform | Hits | Rate |
|----------|------|------|
| SoundCloud | 25/40 | 62.5% |
| Spotify | 24/40 | 60.0% |
| Bandcamp | 23/40 | 57.5% |
| YouTube | 6/40 | 15.0% |

### What each platform misses

- **Spotify**: vinyl-only dubs, DJ edits, unreleased tracks, very small label releases (Image System, Lavery, RANEE, Al Wootton, Anton Zap)
- **SoundCloud**: proper label releases that were never uploaded or got pulled (Passarani, Daniel Aged, Rochelle Jordan, Orchestra Of The Eighth Day)
- **Bandcamp**: major label artists (FSOL, Run The Jewels, Prince) and SoundCloud-only uploads
- **YouTube**: almost everything. Only 6/40 tracks found, and only 1 was YouTube-exclusive (a 1984 Polish experimental album uploaded by a fan)

### Combined coverage

| Strategy | Estimated coverage |
|----------|-------------------|
| Any single platform | ~60% |
| Spotify + SoundCloud | ~80% |
| Spotify + SoundCloud + Bandcamp | ~85% |
| Adding YouTube | negligible gain (~1 extra track in 40) |

### Unfindable tracks: 15% (6/40)

These tracks existed on zero platforms:
- Unknown -- Overwhelm (artist literally named "Unknown")
- Moonshine Jonny -- Rock Edit (vinyl-only DJ edit)
- Bird Peterson -- Mike And Charlie - I Get Live (vinyl-only remix from 1999)
- A Hank -- Lotta (extremely obscure)
- 2LATE -- Tek Time (unreleased/unfindable)
- Nick Morgan -- believe (Nick Morgan Edit) (unlisted DJ edit)
- John Bryars -- Leistung (not in any known discography)

Common thread: DJ edits, vinyl-only releases, and unreleased tracks. This is inherent to Lot Radio's catalogue -- DJs play tracks that don't exist digitally.

## Full Sample Data

### Batch 1 (seed=42)

| # | Track | YT | Spotify | SC | BC |
|---|-------|:--:|:-------:|:--:|:--:|
| 1 | Anton Zap -- Classic Dub | | | Y | |
| 2 | Moonshine Jonny -- Rock Edit | | | | |
| 3 | Franzini -- Prague Sunrise (Eusexua Edit) | | | Y | Y |
| 4 | A Hank -- Lotta | | | | |
| 5 | Prince -- Sign O The Times | Y | Y | Y | |
| 6 | Hyas -- Pressure ft. Unsho | | Y | Y | Y |
| 7 | Kassian -- Sun (Extended Club Mix) | | Y | Y | Y |
| 8 | Bird Peterson -- Mike And Charlie - I Get Live | | | | |
| 9 | Los Deakino -- Cumbia Con Arpa | | Y | Y | |
| 10 | Joeski -- Amanecer Caribeno | | Y | | |

### Batch 2 (seed=99)

| # | Track | YT | Spotify | SC | BC |
|---|-------|:--:|:-------:|:--:|:--:|
| 11 | Ojard -- Dormir | | Y | Y | Y |
| 12 | Bitchin Bajas -- Skylarking | Y | Y | Y | Y |
| 13 | Rochelle Jordan -- On 2 Something | | Y | | Y |
| 14 | Che X Don -- Surf Mas Que Nada | | | | Y |
| 15 | The Chimes -- Heaven (Physical Mix) | Y | Y | Y | Y |
| 16 | INVT -- 4PLAY | | Y | Y | Y |
| 17 | Username -- Been Thru (ft. Marsh Crane) | | Y | Y | Y |
| 18 | rkss -- (corrupted title) | | Y | Y | Y |
| 19 | Anunaku -- Teleported | | Y | Y | Y |
| 20 | Coffintexts & Jonny From Space -- TALK TO ME | | Y | | Y |

### Batch 3 (seed=777)

| # | Track | YT | Spotify | SC | BC |
|---|-------|:--:|:-------:|:--:|:--:|
| 21 | Image System -- Hull Integrity | | | Y | Y |
| 22 | FSOL -- Max (2006 Edit) | | Y | Y | |
| 23 | K.Hand -- On A Journey | | Y | Y | Y |
| 24 | Passarani -- Beyond Orion | | Y | | Y |
| 25 | Unknown -- Overwhelm | | | | |
| 26 | Arp -- New Pleasures | Y | Y | Y | Y |
| 27 | Run The Jewels -- goonies contra E.T. | | Y | Y | |
| 28 | Pz' -- HEDIS BUSSIN' | | Y | Y | |
| 29 | Lavery -- Bassline Ltd | | | Y | |
| 30 | Daniel Aged -- Worn with Iris | | Y | | Y |
| 31 | 2LATE -- Tek Time | | | | |
| 32 | John Beltran -- Em Trancoso | | Y | Y | Y |
| 33 | DJ Dennis -- I Love To Watch U Dance | | | | Y |
| 34 | Nick Morgan -- believe (Edit) | | | | |
| 35 | Nadia Struiwigh -- The Club That Wasn't There | | Y | Y | Y |
| 36 | John Bryars -- Leistung | | | | |
| 37 | RANEE -- DIET PEPS1 (RANEE'S EDIT) | | | Y | Y |
| 38 | Al Wootton -- Glorias (Drums Version) | | | Y | Y |
| 39 | RM47 -- GETTEK D | Y | Y | Y | Y |
| 40 | Orchestra Of The Eighth Day -- Dancing in the Wind | Y | | | |

## Decision

Waterfall lookup order:

```
Spotify -> SoundCloud -> Bandcamp
```

Skip YouTube. Accept ~15% of tracks will be unplayable and design a graceful "not available" state.
