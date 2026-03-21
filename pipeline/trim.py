#!/usr/bin/env python3
"""
Trim episode lists by capping over-represented parent genres.

Drops entire episodes (sets) from over-represented genres, prioritizing
sets that ONLY belong to capped genres. Sets with boosted genres or
protected DJs are strongly preserved.

After trimming, re-run graph.py on the filtered episode files to rebuild
the graph.

Usage:
    python trim.py                  # Dry run (show what would be dropped)
    python trim.py --apply          # Write filtered episode files
    python trim.py --apply --rebuild  # Write + rebuild graph
"""

import json
import sys
import subprocess
from pathlib import Path
from collections import Counter
from typing import Dict, List, Set, Tuple

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Parent genre caps: max % of total sets that can belong to this genre
GENRE_CAPS = {
    "Rock":                 10,
    "Ambient / New Age":    12,
    "Disco / Boogie":        4,
    "Post Punk / New Wave": 10,
    "Alt Rock / Punk":      11,
}

# Boosted genres: sets with these are strongly preserved (weight -3)
BOOSTED_GENRES = {
    "Latin / Brazilian",
    "African / Middle Eastern",
    "Caribbean",
}

# Protected DJs: sets from these DJs are strongly preserved
# Matched case-insensitively against episode artist_name
PROTECTED_DJS = {
    "ben ufo",
    "powder",
    "david august",
    "tim reaper",
    "kelman duran",
    "zack fox",
    "avalon emerson",
    "zeemuffin",
}

BOOST_WEIGHT = 3  # how strongly boosted genres/DJs resist dropping

# ---------------------------------------------------------------------------
# Genre mapping
# ---------------------------------------------------------------------------

def load_genre_map(path: str = "genre_map.json") -> Dict[str, str]:
    """Build child genre -> parent genre lookup from genre_map.json."""
    raw = json.load(open(path, "r", encoding="utf-8"))
    taxonomy = raw.get("_nts_taxonomy", {})
    overrides = raw.get("overrides", {})

    child_to_parent = {}
    for parent, children in taxonomy.items():
        for child in children:
            child_to_parent[child] = parent
    for child, parent in overrides.items():
        if parent is not None:
            child_to_parent[child] = parent
    return child_to_parent


def get_parent_genres(episode: dict, child_to_parent: Dict[str, str]) -> Set[str]:
    """Get the set of parent genres for an episode."""
    parents = set()
    for g in episode.get("genres", []):
        p = child_to_parent.get(g)
        if p:
            parents.add(p)
    return parents


# ---------------------------------------------------------------------------
# Scoring + trimming
# ---------------------------------------------------------------------------

def compute_drop_score(
    parent_genres: Set[str],
    dj_name: str,
    over_cap_genres: Set[str],
) -> float:
    """
    Score how droppable an episode is. Higher = better candidate to drop.

    +1 for each parent genre that's over cap
    -BOOST_WEIGHT for each boosted parent genre
    -BOOST_WEIGHT if DJ is protected
    -1 for each neutral (under cap, not boosted) parent genre
    """
    score = 0.0
    for pg in parent_genres:
        if pg in over_cap_genres:
            score += 1
        elif pg in BOOSTED_GENRES:
            score -= BOOST_WEIGHT
        else:
            score -= 1
    # DJ protection
    if dj_name and dj_name.lower().strip() in PROTECTED_DJS:
        score -= BOOST_WEIGHT
    return score


def track_count(episode: dict) -> int:
    """Count valid tracks in an episode's tracklist."""
    tl = episode.get("tracklist", [])
    return len([t for t in tl if isinstance(t, dict) and t.get("artist") and t.get("title")])


def trim_episodes(
    episodes: List[dict],
    child_to_parent: Dict[str, str],
) -> Tuple[List[dict], dict]:
    """
    Trim episodes to meet genre caps (track-weighted).

    Caps are expressed as % of total tracks. We drop entire sets,
    prioritizing sets whose tracks mostly belong to over-capped genres.

    Returns (surviving_episodes, stats_dict).
    """
    total = len(episodes)

    # Precompute per-episode: parent genres, track count
    ep_parents = []
    ep_tracks = []
    for ep in episodes:
        ep_parents.append(get_parent_genres(ep, child_to_parent))
        ep_tracks.append(track_count(ep))

    total_tracks = sum(ep_tracks)

    # Track-weighted genre counts (how many tracks belong to each genre)
    genre_track_counts = Counter()
    for i, parents in enumerate(ep_parents):
        for p in parents:
            genre_track_counts[p] += ep_tracks[i]

    surviving_tracks = total_tracks

    def over_cap_genres() -> Dict[str, int]:
        """Returns {genre: excess_tracks} for genres over their track cap."""
        over = {}
        for genre, cap_pct in GENRE_CAPS.items():
            max_tracks = int(surviving_tracks * cap_pct / 100)
            current = genre_track_counts.get(genre, 0)
            if current > max_tracks:
                over[genre] = current - max_tracks
        return over

    dropped = [False] * len(episodes)
    drop_order = []

    iteration = 0
    while True:
        over = over_cap_genres()
        if not over:
            break

        iteration += 1
        worst_genre = max(over, key=over.get)

        # Score all non-dropped episodes that have this genre
        candidates = []
        for i, ep in enumerate(episodes):
            if dropped[i]:
                continue
            if worst_genre not in ep_parents[i]:
                continue
            score = compute_drop_score(
                ep_parents[i],
                ep.get("artist_name", ""),
                set(over.keys()),
            )
            # Tiebreak: prefer dropping larger sets (removes more excess tracks)
            candidates.append((score, -ep_tracks[i], i))

        if not candidates:
            print(f"  Warning: no droppable candidates for {worst_genre}, skipping")
            break

        # Drop the highest-scored (most droppable) episode
        candidates.sort(key=lambda x: (-x[0], x[1], x[2]))
        _, _, drop_idx = candidates[0]

        dropped[drop_idx] = True
        drop_order.append((episodes[drop_idx].get("episode_url", "?"), worst_genre, ep_tracks[drop_idx]))

        # Update track counts
        for p in ep_parents[drop_idx]:
            genre_track_counts[p] -= ep_tracks[drop_idx]
        surviving_tracks -= ep_tracks[drop_idx]

        if iteration % 100 == 0:
            surviving_sets = sum(1 for d in dropped if not d)
            print(f"  ... dropped {iteration} sets, {total_tracks - surviving_tracks:,} tracks removed ({surviving_sets} sets, {surviving_tracks:,} tracks remaining)")
            for g, excess in sorted(over.items(), key=lambda x: -x[1]):
                print(f"      {g}: {excess:,} tracks over cap")

    # Build results
    surviving = [ep for i, ep in enumerate(episodes) if not dropped[i]]
    dropped_count = sum(dropped)
    dropped_tracks = total_tracks - surviving_tracks

    # Final track-weighted genre distribution
    final_counts = Counter()
    for i, parents in enumerate(ep_parents):
        if not dropped[i]:
            for p in parents:
                final_counts[p] += ep_tracks[i]

    stats = {
        "total_sets_before": total,
        "total_sets_after": len(surviving),
        "sets_dropped": dropped_count,
        "total_tracks_before": total_tracks,
        "total_tracks_after": surviving_tracks,
        "tracks_dropped": dropped_tracks,
        "tracks_dropped_pct": f"{dropped_tracks / total_tracks * 100:.1f}%",
        "final_genre_distribution": {
            g: {"tracks": c, "pct": f"{c / surviving_tracks * 100:.1f}%"}
            for g, c in final_counts.most_common()
        },
        "caps_applied": GENRE_CAPS,
        "first_10_dropped": [
            {"url": url, "reason": genre, "tracks": tc} for url, genre, tc in drop_order[:10]
        ],
    }
    return surviving, stats


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Trim episodes by genre caps")
    parser.add_argument("--apply", action="store_true", help="Write filtered files")
    parser.add_argument("--rebuild", action="store_true", help="Re-run graph.py after trimming")
    args = parser.parse_args()

    child_to_parent = load_genre_map()

    # Load all episodes
    nts_path = Path("../scrapers/nts/output/nts_episodes.json")
    lot_path = Path("../scrapers/lot-radio/output/lot_radio_episodes.json")

    nts_episodes = json.load(open(nts_path, "r", encoding="utf-8"))
    lot_episodes = json.load(open(lot_path, "r", encoding="utf-8"))
    all_episodes = nts_episodes + lot_episodes

    print(f"Loaded {len(nts_episodes)} NTS + {len(lot_episodes)} Lot Radio = {len(all_episodes)} total episodes")

    # Only trim episodes with tracklists (others don't contribute to graph)
    has_tracklist = [e for e in all_episodes if e.get("has_tracklist")]
    no_tracklist = [e for e in all_episodes if not e.get("has_tracklist")]
    print(f"  With tracklists: {len(has_tracklist)}")
    print(f"  Without tracklists: {len(no_tracklist)} (kept as-is)")

    # Show before distribution (track-weighted)
    genre_before = Counter()
    total_tracks_before = 0
    for ep in has_tracklist:
        tc = track_count(ep)
        total_tracks_before += tc
        for p in get_parent_genres(ep, child_to_parent):
            genre_before[p] += tc
    print(f"\nBefore trimming ({len(has_tracklist)} sets, {total_tracks_before:,} tracks):")
    for g, c in genre_before.most_common():
        pct = c / total_tracks_before * 100
        cap_str = f"  (cap: {GENRE_CAPS[g]}%)" if g in GENRE_CAPS else ""
        boost_str = "  [BOOSTED]" if g in BOOSTED_GENRES else ""
        print(f"  {g}: {c:,} tracks ({pct:.1f}%){cap_str}{boost_str}")

    # Trim
    print(f"\nTrimming...")
    surviving, stats = trim_episodes(has_tracklist, child_to_parent)

    print(f"\nResults:")
    print(f"  Sets:   {stats['total_sets_before']} -> {stats['total_sets_after']} ({stats['sets_dropped']} dropped)")
    print(f"  Tracks: {stats['total_tracks_before']:,} -> {stats['total_tracks_after']:,} ({stats['tracks_dropped']:,} dropped, {stats['tracks_dropped_pct']})")

    print(f"\nAfter trimming ({stats['total_sets_after']} sets, {stats['total_tracks_after']:,} tracks):")
    for g, info in stats["final_genre_distribution"].items():
        cap_str = f"  (cap: {GENRE_CAPS[g]}%)" if g in GENRE_CAPS else ""
        boost_str = "  [BOOSTED]" if g in BOOSTED_GENRES else ""
        print(f"  {g}: {info['tracks']:,} tracks ({info['pct']}){cap_str}{boost_str}")

    if not args.apply:
        print(f"\nDry run — pass --apply to write filtered files.")
        return

    # Write filtered episode files
    # Split surviving back into NTS and Lot Radio by source
    nts_surviving = [e for e in surviving if e.get("source") == "nts"]
    lot_surviving = [e for e in surviving if e.get("source") != "nts"]
    # Also include non-tracklist episodes (they don't affect the graph but keep the file complete)
    nts_no_tl = [e for e in no_tracklist if e.get("source") == "nts"]
    lot_no_tl = [e for e in no_tracklist if e.get("source") != "nts"]

    nts_out = Path("../scrapers/nts/output/nts_episodes_trimmed.json")
    lot_out = Path("../scrapers/lot-radio/output/lot_radio_episodes_trimmed.json")

    nts_final = nts_surviving + nts_no_tl
    lot_final = lot_surviving + lot_no_tl

    with open(nts_out, "w", encoding="utf-8") as f:
        json.dump(nts_final, f, ensure_ascii=False)
    print(f"\nWrote {len(nts_final)} NTS episodes to {nts_out}")

    with open(lot_out, "w", encoding="utf-8") as f:
        json.dump(lot_final, f, ensure_ascii=False)
    print(f"Wrote {len(lot_final)} Lot Radio episodes to {lot_out}")

    if args.rebuild:
        print(f"\nRebuilding graph from trimmed episodes...")
        result = subprocess.run(
            ["python3", "graph.py",
             "--input", str(nts_out), str(lot_out),
             "--output", "output/combined_graph.json"],
            cwd=str(Path(__file__).parent),
        )
        if result.returncode != 0:
            print("Error: graph.py failed")
            sys.exit(1)


if __name__ == "__main__":
    main()
