#!/usr/bin/env python3
"""
Builds a bidirectional track adjacency graph from Lot Radio episode data.

Each unique track becomes a node. Consecutive tracks in a DJ set create
bidirectional edges. The graph supports BFS traversal to find rank 1/2/3
neighbors for music recommendations.

Input:  output/lot_radio_episodes.json
Output: output/lot_radio_graph.json
"""

import json
import re
import unicodedata
import argparse
import sys
from pathlib import Path
from datetime import datetime, timezone
from collections import deque
from typing import Dict, Any, List, Optional, Tuple


def normalize(text: str) -> str:
    """
    Normalize a string for use in track ID generation.

    Applies NFKD unicode normalization, lowercases, strips all
    non-alphanumeric/non-space characters, and collapses whitespace.
    """
    if not text:
        return ""
    text = unicodedata.normalize("NFKD", text)
    text = text.lower()
    # Keep alphanumeric (including unicode letters/digits) and spaces
    text = re.sub(r"[^\w\s]", "", text, flags=re.UNICODE)
    # Remove underscores (matched by \w but we don't want them)
    text = text.replace("_", "")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def make_track_id(artist: str, title: str) -> str:
    """
    Create a normalized track ID from artist and title.

    Format: normalized_artist:::normalized_title
    The ::: separator cannot appear in normalized text since all
    special characters are stripped.
    """
    return f"{normalize(artist)}:::{normalize(title)}"


def build_graph(episodes: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Build a bidirectional adjacency graph from episode tracklists.

    For each episode with a valid tracklist, creates bidirectional edges
    between consecutive tracks. Each edge stores the context (DJ, episode,
    date, position) of every set where that adjacency occurred.

    Args:
        episodes: List of episode objects from lot_radio_episodes.json

    Returns:
        Dict with 'meta' and 'nodes' keys. nodes is keyed by track ID.
    """
    # Internal node structure: {title, artist, timestamp, edges: {neighbor_id: [contexts]}}
    nodes: Dict[str, Dict[str, Any]] = {}
    episodes_processed = 0
    skip_counts = {
        "missing_artist": 0,
        "empty_title": 0,
    }

    for episode in episodes:
        if not isinstance(episode, dict):
            continue
        if not episode.get("has_tracklist", False):
            continue

        tracklist = episode.get("tracklist")
        if not tracklist or not isinstance(tracklist, list) or len(tracklist) < 2:
            continue

        episodes_processed += 1

        episode_url = episode.get("episode_url", "")
        dj = episode.get("artist_name", "")
        date = episode.get("date", "")

        # First pass: build list of valid tracks for this episode
        valid_tracks: List[Tuple[str, str, str, int, Optional[str]]] = []  # (track_id, title, artist, position, timestamp)

        for track in tracklist:
            if not isinstance(track, dict):
                continue

            artist_raw = track.get("artist")
            title_raw = track.get("title", "")
            position = track.get("position", 0)
            timestamp = track.get("timestamp")  # e.g. "00:03:07" or None

            # Handle None/missing artist
            if artist_raw is None or not str(artist_raw).strip():
                skip_counts["missing_artist"] += 1
                continue

            artist = str(artist_raw).strip()
            title = str(title_raw).strip() if title_raw else ""

            if not title:
                skip_counts["empty_title"] += 1
                continue

            # Skip placeholder/junk titles that break adjacency chains
            title_lower = title.lower().strip("[]() ")
            if title_lower in (
                "no title available", "no title", "untitled",
                "id", "id?", "unknown", "tba", "tbd", "n/a",
            ):
                skip_counts["empty_title"] += 1
                continue

            track_id = make_track_id(artist, title)

            # Skip if normalization produces empty components (e.g. "???" -> "")
            norm_artist = normalize(artist)
            norm_title = normalize(title)
            if not norm_artist or not norm_title:
                skip_counts["empty_title"] += 1
                continue

            # Register node with first-seen display name + timestamp
            if track_id not in nodes:
                nodes[track_id] = {
                    "title": title,
                    "artist": artist,
                    "first_episode_url": episode_url,
                    "first_timestamp": timestamp,
                    "edges": {},  # neighbor_id -> [context, ...]
                }

            valid_tracks.append((track_id, title, artist, position, timestamp))

        # Second pass: create bidirectional edges between consecutive tracks
        for i in range(len(valid_tracks) - 1):
            id_a, _, _, pos_a, ts_a = valid_tracks[i]
            id_b, _, _, _, ts_b = valid_tracks[i + 1]

            # Skip self-loops (same track played consecutively)
            if id_a == id_b:
                continue

            context = {
                "dj": dj,
                "episode_url": episode_url,
                "date": date,
                "position": pos_a,
                "timestamp_a": ts_a,
                "timestamp_b": ts_b,
            }

            # A -> B
            if id_b not in nodes[id_a]["edges"]:
                nodes[id_a]["edges"][id_b] = []
            nodes[id_a]["edges"][id_b].append(context)

            # B -> A
            if id_a not in nodes[id_b]["edges"]:
                nodes[id_b]["edges"][id_a] = []
            nodes[id_b]["edges"][id_a].append(context)

    # Convert internal edge dicts to output array format
    output_nodes = {}
    total_edges = 0

    for track_id, node in nodes.items():
        edge_list = []
        for neighbor_id, contexts in node["edges"].items():
            edge_list.append({
                "node": neighbor_id,
                "contexts": contexts,
            })
            total_edges += 1

        output_nodes[track_id] = {
            "title": node["title"],
            "artist": node["artist"],
            "first_episode_url": node.get("first_episode_url"),
            "first_timestamp": node.get("first_timestamp"),
            "edges": edge_list,
        }

    # Build output
    return {
        "meta": {
            "version": 1,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "total_nodes": len(output_nodes),
            "total_edges": total_edges,
            "episodes_processed": episodes_processed,
            "tracks_skipped": sum(skip_counts.values()),
            "skip_reasons": skip_counts,
        },
        "nodes": output_nodes,
    }


def bfs(
    graph_nodes: Dict[str, Any],
    start_id: str,
    max_depth: int = 3,
) -> Dict[int, List[str]]:
    """
    BFS from a start node to max_depth. Returns neighbors grouped by rank.

    Args:
        graph_nodes: The 'nodes' dict from the graph output
        start_id: Track ID to start from
        max_depth: Maximum traversal depth (default 3)

    Returns:
        Dict mapping rank (1, 2, 3) to list of track IDs at that rank
    """
    if start_id not in graph_nodes:
        return {}

    visited = {start_id: 0}
    queue = deque([(start_id, 0)])
    ranks: Dict[int, List[str]] = {i: [] for i in range(1, max_depth + 1)}

    while queue:
        current, depth = queue.popleft()
        if depth >= max_depth:
            continue

        node = graph_nodes.get(current)
        if not node:
            continue

        for edge in node.get("edges", []):
            neighbor = edge["node"]
            if neighbor not in visited:
                new_depth = depth + 1
                visited[neighbor] = new_depth
                ranks[new_depth].append(neighbor)
                queue.append((neighbor, new_depth))

    return ranks


def main(
    input_paths: List[str],
    output_path: str,
    pretty: bool = False,
    test_node: Optional[str] = None,
) -> int:
    """
    Main entry point: reads episodes from one or more files, builds graph, writes output.

    Args:
        input_paths: Paths to input episodes JSON files
        output_path: Path to output graph JSON file
        pretty: If True, write indented JSON
        test_node: Optional track ID to run BFS on after building

    Returns:
        0 on success, 1 on error
    """
    episodes = []
    for input_path in input_paths:
        print(f"Reading episodes from {input_path}...")
        try:
            with open(input_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            if not isinstance(data, list):
                print(f"Error: Episodes JSON root must be an array in {input_path}")
                return 1

            print(f"  Loaded {len(data)} episodes")
            episodes.extend(data)
        except FileNotFoundError:
            print(f"Error: File not found: {input_path}")
            return 1
        except json.JSONDecodeError as e:
            print(f"Error: Invalid JSON in {input_path}: {e}")
            return 1

    print(f"Total: {len(episodes)} episodes from {len(input_paths)} file(s)")

    print("Building adjacency graph...")
    graph = build_graph(episodes)
    meta = graph["meta"]

    print(f"  Nodes:              {meta['total_nodes']}")
    print(f"  Edges:              {meta['total_edges']}")
    print(f"  Episodes processed: {meta['episodes_processed']}")
    print(f"  Tracks skipped:     {meta['tracks_skipped']}")
    for reason, count in meta["skip_reasons"].items():
        print(f"    {reason}: {count}")

    # Write output
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    print(f"\nWriting graph to {output_path}...")
    try:
        indent = 2 if pretty else None
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(graph, f, indent=indent, ensure_ascii=False)

        file_size = Path(output_path).stat().st_size
        size_mb = file_size / (1024 * 1024)
        print(f"  Wrote {size_mb:.1f} MB")
    except Exception as e:
        print(f"Error: Failed to write graph: {e}")
        return 1

    # Optional: test BFS on a specific node
    if test_node:
        print(f"\n--- BFS test: {test_node} ---")
        if test_node not in graph["nodes"]:
            print(f"  Node not found. Try one of these:")
            # Show a few example node IDs
            example_ids = list(graph["nodes"].keys())[:10]
            for eid in example_ids:
                node = graph["nodes"][eid]
                print(f"    {eid}  ({node['artist']} - {node['title']})")
            return 0

        node = graph["nodes"][test_node]
        print(f"  Track: {node['artist']} - {node['title']}")
        print(f"  Direct edges: {len(node['edges'])}")

        ranks = bfs(graph["nodes"], test_node, max_depth=3)
        for rank, track_ids in ranks.items():
            print(f"\n  Rank {rank}: {len(track_ids)} tracks")
            for tid in track_ids[:5]:
                neighbor = graph["nodes"].get(tid, {})
                n_artist = neighbor.get("artist", "?")
                n_title = neighbor.get("title", "?")
                # Count how many contexts (sets) connect them
                edge_contexts = 0
                if rank == 1:
                    for edge in node["edges"]:
                        if edge["node"] == tid:
                            edge_contexts = len(edge["contexts"])
                            break
                ctx_str = f" (in {edge_contexts} sets)" if edge_contexts else ""
                print(f"    {n_artist} - {n_title}{ctx_str}")
            if len(track_ids) > 5:
                print(f"    ... and {len(track_ids) - 5} more")

    print("\nDone!")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Build a bidirectional track adjacency graph from episode data"
    )
    parser.add_argument(
        "--input",
        type=str,
        nargs="+",
        default=[
            "../scrapers/lot-radio/output/lot_radio_episodes.json",
            "../scrapers/nts/output/nts_episodes.json",
        ],
        help="Path(s) to input episodes JSON files",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="output/combined_graph.json",
        help="Path to output graph JSON file (default: output/combined_graph.json)",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Write indented JSON (larger file, human-readable)",
    )
    parser.add_argument(
        "--test",
        type=str,
        default=None,
        metavar="TRACK_ID",
        help='Run BFS on a track after building (e.g. "moodymann:::no")',
    )

    args = parser.parse_args()
    sys.exit(main(args.input, args.output, args.pretty, args.test))
