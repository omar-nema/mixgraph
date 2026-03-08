#!/usr/bin/env python3
"""
Generates track adjacency pairs from scraped Lot Radio episode data.

This module reads episode data from JSON and produces adjacency pairs for use in
a music recommendation engine. It also generates comprehensive statistics about
the processed data.

Input: output/lot_radio_episodes.json
Output: output/lot_radio_adjacencies.json, output/lot_radio_stats.json
"""

import json
import argparse
import sys
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any, Optional, Set, Tuple


def generate_adjacencies(episodes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Generate track adjacency pairs from episodes.

    For each episode with a valid tracklist (has_tracklist=True and len >= 2),
    creates N-1 adjacency pairs from N tracks where each pair consists of
    consecutive tracks.

    Args:
        episodes: List of episode objects with tracklist data

    Returns:
        List of adjacency pair objects
    """
    adjacencies = []
    skipped_count = 0

    for episode_idx, episode in enumerate(episodes, 1):
        try:
            # Validate episode structure
            if not isinstance(episode, dict):
                print(f"  Warning: Episode {episode_idx} is not a dict, skipping")
                skipped_count += 1
                continue

            # Check if episode has tracklist data
            has_tracklist = episode.get("has_tracklist", False)
            if not has_tracklist:
                continue

            tracklist = episode.get("tracklist")
            if not tracklist or not isinstance(tracklist, list):
                continue

            # Need at least 2 tracks to create an adjacency pair
            if len(tracklist) < 2:
                continue

            episode_url = episode.get("episode_url", "")
            dj = episode.get("artist_name", "")

            # Generate N-1 adjacency pairs from N tracks
            for i in range(len(tracklist) - 1):
                track_a = tracklist[i]
                track_b = tracklist[i + 1]

                # Validate track structure
                if not isinstance(track_a, dict) or not isinstance(track_b, dict):
                    continue

                # Extract track information with defaults
                track_a_title = track_a.get("title", "").strip()
                track_a_artist = track_a.get("artist", "").strip()
                track_a_pos = track_a.get("position")

                track_b_title = track_b.get("title", "").strip()
                track_b_artist = track_b.get("artist", "").strip()
                track_b_pos = track_b.get("position")

                # Skip if essential data is missing
                if not track_a_title or not track_a_artist or not track_b_title or not track_b_artist:
                    continue

                # Create adjacency pair
                pair = {
                    "track_a": {
                        "title": track_a_title,
                        "artist": track_a_artist,
                    },
                    "track_b": {
                        "title": track_b_title,
                        "artist": track_b_artist,
                    },
                    "episode_url": episode_url,
                    "dj": dj,
                    "position_a": track_a_pos,
                    "position_b": track_b_pos,
                }

                adjacencies.append(pair)

        except Exception as e:
            print(f"  Warning: Error processing episode {episode_idx}: {e}")
            skipped_count += 1
            continue

    if skipped_count > 0:
        print(f"  Skipped {skipped_count} malformed episodes")

    return adjacencies


def generate_stats(
    episodes: List[Dict[str, Any]],
    adjacencies: List[Dict[str, Any]],
    errors: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    Generate comprehensive statistics about episodes and adjacencies.

    Calculates counts for episodes, tracks, unique artists, and unique tracks.

    Args:
        episodes: List of episode objects
        adjacencies: List of adjacency pairs
        errors: Optional list of error messages

    Returns:
        Dictionary containing statistics
    """
    if errors is None:
        errors = []

    total_episodes = len(episodes)
    episodes_with_tracklist = 0
    episodes_without_tracklist = 0
    total_tracks = 0

    unique_artists: Set[str] = set()
    unique_tracks: Set[Tuple[str, str]] = set()

    for episode in episodes:
        if not isinstance(episode, dict):
            continue

        has_tracklist = episode.get("has_tracklist", False)

        if has_tracklist:
            episodes_with_tracklist += 1
            tracklist = episode.get("tracklist", [])

            if isinstance(tracklist, list):
                total_tracks += len(tracklist)

                for track in tracklist:
                    if isinstance(track, dict):
                        title = track.get("title", "").strip()
                        artist = track.get("artist", "").strip()

                        if title and artist:
                            unique_artists.add(artist.lower())
                            unique_tracks.add((title.lower(), artist.lower()))
        else:
            episodes_without_tracklist += 1

    stats = {
        "total_episodes_found": total_episodes,
        "episodes_with_tracklist": episodes_with_tracklist,
        "episodes_without_tracklist": episodes_without_tracklist,
        "total_tracks": total_tracks,
        "total_adjacency_pairs": len(adjacencies),
        "unique_artists": len(unique_artists),
        "unique_tracks": len(unique_tracks),
        "scrape_date": datetime.now().strftime("%Y-%m-%d"),
        "errors": errors,
    }

    return stats


def main(
    episodes_path: str,
    adjacencies_output: str,
    stats_output: str,
) -> int:
    """
    Main entry point: reads episodes, generates adjacencies and stats, writes output.

    Args:
        episodes_path: Path to input episodes JSON file
        adjacencies_output: Path to output adjacencies JSON file
        stats_output: Path to output stats JSON file

    Returns:
        0 on success, 1 on error
    """
    errors: List[str] = []

    print(f"Reading episodes from {episodes_path}...")
    try:
        with open(episodes_path, "r", encoding="utf-8") as f:
            episodes = json.load(f)

        if not isinstance(episodes, list):
            print("Error: Episodes JSON root must be an array")
            return 1

        print(f"Loaded {len(episodes)} episodes")
    except FileNotFoundError:
        print(f"Error: File not found: {episodes_path}")
        return 1
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in {episodes_path}: {e}")
        return 1
    except Exception as e:
        print(f"Error: Failed to read episodes: {e}")
        return 1

    print("Generating adjacency pairs...")
    try:
        adjacencies = generate_adjacencies(episodes)
        print(f"Generated {len(adjacencies)} adjacency pairs")
    except Exception as e:
        print(f"Error: Failed to generate adjacencies: {e}")
        errors.append(f"Adjacency generation failed: {e}")
        adjacencies = []

    print("Generating statistics...")
    try:
        stats = generate_stats(episodes, adjacencies, errors)
        print(f"  Total episodes found: {stats['total_episodes_found']}")
        print(f"  Episodes with tracklist: {stats['episodes_with_tracklist']}")
        print(f"  Episodes without tracklist: {stats['episodes_without_tracklist']}")
        print(f"  Total tracks: {stats['total_tracks']}")
        print(f"  Total adjacency pairs: {stats['total_adjacency_pairs']}")
        print(f"  Unique artists: {stats['unique_artists']}")
        print(f"  Unique tracks: {stats['unique_tracks']}")
    except Exception as e:
        print(f"Error: Failed to generate stats: {e}")
        errors.append(f"Stats generation failed: {e}")
        stats = {}

    # Create output directories if they don't exist
    Path(adjacencies_output).parent.mkdir(parents=True, exist_ok=True)
    Path(stats_output).parent.mkdir(parents=True, exist_ok=True)

    # Write adjacencies output
    print(f"\nWriting adjacencies to {adjacencies_output}...")
    try:
        with open(adjacencies_output, "w", encoding="utf-8") as f:
            json.dump(adjacencies, f, indent=2, ensure_ascii=False)
        print(f"Successfully wrote {len(adjacencies)} adjacency pairs")
    except Exception as e:
        print(f"Error: Failed to write adjacencies: {e}")
        errors.append(f"Adjacencies write failed: {e}")
        return 1

    # Write stats output
    print(f"Writing stats to {stats_output}...")
    try:
        with open(stats_output, "w", encoding="utf-8") as f:
            json.dump(stats, f, indent=2, ensure_ascii=False)
        print("Successfully wrote statistics")
    except Exception as e:
        print(f"Error: Failed to write stats: {e}")
        errors.append(f"Stats write failed: {e}")
        return 1

    print("\nDone!")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Generate track adjacency pairs from Lot Radio episode data"
    )
    parser.add_argument(
        "--input",
        type=str,
        default="output/lot_radio_episodes.json",
        help="Path to input episodes JSON file (default: output/lot_radio_episodes.json)",
    )
    parser.add_argument(
        "--adjacencies-output",
        type=str,
        default="output/lot_radio_adjacencies.json",
        help="Path to output adjacencies JSON file (default: output/lot_radio_adjacencies.json)",
    )
    parser.add_argument(
        "--stats-output",
        type=str,
        default="output/lot_radio_stats.json",
        help="Path to output stats JSON file (default: output/lot_radio_stats.json)",
    )

    args = parser.parse_args()

    sys.exit(
        main(
            args.input,
            args.adjacencies_output,
            args.stats_output,
        )
    )
