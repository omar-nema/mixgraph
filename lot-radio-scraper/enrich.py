#!/usr/bin/env python3
"""
Builds output/audio_cache.json with playable audio URLs for every track in the graph.

Waterfall: SoundCloud individual track -> Deezer 30s preview -> DJ set at timestamp.
Incremental and Ctrl-C safe — progress saved every 500 tracks and on interrupt.

Usage:
    python enrich.py                                    # enrich all nodes
    python enrich.py --graph output/combined_graph.json
    python enrich.py --skip-sets                        # skip DJ set lookups (faster)
"""

import json
import re
import sys
import time
import signal
import argparse
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path
from typing import Dict, Any, Optional, List

from cluster import (
    search_deezer,
    search_soundcloud,
    get_soundcloud_client_id,
    load_graph,
    _BROWSER_UA,
)


def timestamp_to_seconds(ts: Optional[str]) -> Optional[int]:
    """Convert 'HH:MM:SS' or 'MM:SS' timestamp to seconds."""
    if not ts:
        return None
    parts = ts.split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        elif len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
    except (ValueError, IndexError):
        return None
    return None


def get_nts_mixcloud_url(episode_url: str, episode_cache: Dict[str, Any]) -> Optional[str]:
    """Fetch Mixcloud URL for an NTS episode from their API."""
    if episode_url in episode_cache:
        return episode_cache[episode_url].get("mixcloud")

    # Extract show/episode from URL: https://www.nts.live/shows/{show}/episodes/{episode}
    m = re.search(r"nts\.live/shows/([^/]+)/episodes/([^/?#]+)", episode_url)
    if not m:
        episode_cache[episode_url] = {"mixcloud": None}
        return None

    show_slug, ep_slug = m.group(1), m.group(2)
    api_url = f"https://www.nts.live/api/v2/shows/{show_slug}/episodes/{ep_slug}"

    try:
        req = urllib.request.Request(api_url, headers={"User-Agent": _BROWSER_UA})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        episode_cache[episode_url] = {"mixcloud": None}
        return None

    mixcloud_url = data.get("mixcloud")
    episode_cache[episode_url] = {"mixcloud": mixcloud_url}
    return mixcloud_url


def get_lotradio_set_url(
    episode_url: str,
    artist_name: str,
    sc_client_id: Optional[str],
    episode_cache: Dict[str, Any],
) -> Optional[str]:
    """Find the Lot Radio set URL on SoundCloud for an episode."""
    if episode_url in episode_cache:
        return episode_cache[episode_url].get("set_url")

    if not sc_client_id:
        episode_cache[episode_url] = {"set_url": None}
        return None

    # Search SC for "thelotradio {artist}" with long duration filter
    query = f"thelotradio {artist_name}"
    params = urllib.parse.urlencode({
        "q": query,
        "client_id": sc_client_id,
        "limit": 5,
        "filter.duration": "epic",
    })
    url = f"https://api-v2.soundcloud.com/search/tracks?{params}"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": _BROWSER_UA})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        episode_cache[episode_url] = {"set_url": None}
        return None

    for item in data.get("collection", []):
        permalink = item.get("permalink_url", "")
        if "thelotradio" in permalink.lower():
            episode_cache[episode_url] = {"set_url": permalink}
            return permalink

    episode_cache[episode_url] = {"set_url": None}
    return None


def get_episode_context(node: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Extract episode URL, timestamp, and DJ from the first edge context of a node."""
    first_ep_url = node.get("first_episode_url")
    first_ts = node.get("first_timestamp")
    if first_ep_url:
        # Find the DJ name from the first edge context
        dj = ""
        for edge in node.get("edges", []):
            for ctx in edge.get("contexts", []):
                if ctx.get("episode_url") == first_ep_url:
                    dj = ctx.get("dj", "")
                    break
            if dj:
                break
        return {
            "episode_url": first_ep_url,
            "timestamp": first_ts,
            "dj": dj,
        }

    # Fallback: use first available edge context
    for edge in node.get("edges", []):
        for ctx in edge.get("contexts", []):
            ep_url = ctx.get("episode_url", "")
            if ep_url:
                ts = ctx.get("timestamp_a") or ctx.get("timestamp_b")
                return {
                    "episode_url": ep_url,
                    "timestamp": ts,
                    "dj": ctx.get("dj", ""),
                }
    return None


def save_cache(cache: Dict[str, Any], cache_path: Path):
    """Save cache to disk."""
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)


def main():
    parser = argparse.ArgumentParser(
        description="Build audio cache with SoundCloud + Deezer + DJ set fallback"
    )
    parser.add_argument(
        "--graph", type=str, default="output/combined_graph.json",
        help="Path to graph JSON (default: output/combined_graph.json)",
    )
    parser.add_argument(
        "--output", type=str, default="output/audio_cache.json",
        help="Path to output cache JSON (default: output/audio_cache.json)",
    )
    parser.add_argument(
        "--skip-sets", action="store_true",
        help="Skip DJ set lookups (only do individual track search)",
    )
    args = parser.parse_args()

    # Load graph
    print(f"Loading graph from {args.graph}...")
    graph = load_graph(args.graph)
    graph_nodes = graph["nodes"]
    print(f"  {len(graph_nodes)} nodes loaded")

    # Load existing cache (incremental)
    cache: Dict[str, Any] = {}
    cache_path = Path(args.output)
    if cache_path.exists():
        with open(cache_path, "r", encoding="utf-8") as f:
            cache = json.load(f)
        print(f"  Existing cache: {len(cache)} entries")

    # Episode-level cache (avoid redundant API calls for same episode)
    episode_cache: Dict[str, Any] = {}

    # Determine which nodes still need enrichment
    all_ids = list(graph_nodes.keys())
    to_enrich = [nid for nid in all_ids if nid not in cache]
    print(f"  To enrich: {len(to_enrich)} / {len(all_ids)}")

    if not to_enrich:
        print("Nothing to do — cache is up to date.")
        return 0

    # Get SoundCloud client_id
    sc_client_id = get_soundcloud_client_id()
    if not sc_client_id:
        print("  WARNING: SoundCloud client_id not available, SC lookups will be skipped")

    # Stats
    stats = {"soundcloud": 0, "deezer": 0, "mixcloud_set": 0, "soundcloud_set": 0, "not_found": 0}
    interrupted = False

    def save_and_exit(signum, frame):
        nonlocal interrupted
        interrupted = True

    signal.signal(signal.SIGINT, save_and_exit)

    for i, nid in enumerate(to_enrich):
        if interrupted:
            break

        node = graph_nodes[nid]
        artist = node["artist"]
        title = node["title"]
        entry: Dict[str, Any] = {"source": "not_found"}

        # --- Step 1: SoundCloud individual track ---
        if sc_client_id:
            if i > 0:
                time.sleep(0.3)
            sc_result = search_soundcloud(artist, title, sc_client_id)
            if sc_result:
                entry["source"] = "soundcloud"
                entry["scTrackUrl"] = sc_result["scTrackUrl"]
                if sc_result.get("artUrl"):
                    entry["artUrl"] = sc_result["artUrl"]
                stats["soundcloud"] += 1

        # --- Step 2: Deezer (if no SC hit) ---
        if entry["source"] == "not_found":
            time.sleep(0.25)
            dz_result = search_deezer(artist, title)
            if dz_result and dz_result.get("artUrl"):
                entry["source"] = "deezer"
                entry["artUrl"] = dz_result["artUrl"]
                entry["previewUrl"] = dz_result.get("previewUrl")
                stats["deezer"] += 1
            elif dz_result and dz_result.get("previewUrl"):
                entry["source"] = "deezer"
                entry["previewUrl"] = dz_result["previewUrl"]
                stats["deezer"] += 1

        # --- Step 3: DJ set fallback ---
        if not args.skip_sets:
            ep_ctx = get_episode_context(node)
            if ep_ctx:
                ep_url = ep_ctx["episode_url"]
                ts = ep_ctx.get("timestamp")
                offset_sec = timestamp_to_seconds(ts)

                if "nts.live" in ep_url:
                    time.sleep(0.15)
                    mixcloud_url = get_nts_mixcloud_url(ep_url, episode_cache)
                    if mixcloud_url:
                        entry["setUrl"] = mixcloud_url
                        entry["setSource"] = "mixcloud"
                        entry["setTimestamp"] = ts
                        entry["setOffsetSec"] = offset_sec
                        entry["setDj"] = ep_ctx.get("dj", "")
                        if entry["source"] == "not_found":
                            entry["source"] = "mixcloud_set"
                            stats["mixcloud_set"] += 1

                elif "thelotradio.com" in ep_url:
                    time.sleep(0.3)
                    set_url = get_lotradio_set_url(
                        ep_url, ep_ctx.get("dj", artist), sc_client_id, episode_cache
                    )
                    if set_url:
                        entry["setUrl"] = set_url
                        entry["setSource"] = "soundcloud"
                        entry["setTimestamp"] = ts
                        entry["setOffsetSec"] = offset_sec
                        entry["setDj"] = ep_ctx.get("dj", "")
                        if entry["source"] == "not_found":
                            entry["source"] = "soundcloud_set"
                            stats["soundcloud_set"] += 1

        if entry["source"] == "not_found":
            stats["not_found"] += 1

        cache[nid] = entry

        # Progress log
        src_tag = entry["source"][:2].upper()
        print(f"  [{i+1}/{len(to_enrich)}] {src_tag} {artist} — {title}")

        # Save every 500 tracks
        if (i + 1) % 500 == 0:
            save_cache(cache, cache_path)
            print(f"    (saved {len(cache)} entries)")

    # Final save
    save_cache(cache, cache_path)

    print(f"\n{'Interrupted — ' if interrupted else ''}Saved {len(cache)} total entries to {cache_path}")
    print(f"  This run: {sum(stats.values())} processed")
    for src, count in stats.items():
        if count > 0:
            print(f"    {src}: {count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
