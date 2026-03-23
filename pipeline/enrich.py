#!/usr/bin/env python3
"""
Builds output/audio_cache.json with playable audio URLs for every track in the graph.

Waterfall:
  1. SoundCloud individual track (full song, best UX)
  2. SoundCloud DJ set at timestamp (NTS or Lot Radio)
  3. Mixcloud DJ set at timestamp (NTS only, last resort)

Incremental and Ctrl-C safe — progress saved every 500 tracks and on interrupt.

Usage:
    python enrich.py                                    # enrich all nodes
    python enrich.py --graph output/combined_graph.json
    python enrich.py --skip-sets                        # skip DJ set lookups
    python enrich.py --reprocess-deezer                 # re-enrich old deezer entries
    python enrich.py --reprocess-mixcloud               # upgrade mixcloud -> SC set
    python enrich.py --fix-sets                         # fix NTS set URLs via API
"""

import json
import re
import sys
import time
import signal
import socket
import http.client
import argparse
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path
from typing import Dict, Any, Optional, List, Set

from cluster import (
    search_soundcloud,
    get_soundcloud_client_id,
    load_graph,
    _BROWSER_UA,
)

# NTS SoundCloud account user IDs (for filtering search results)
NTS_SC_USER_IDS: Set[int] = set()

# Known NTS SC account permalinks to resolve at startup
NTS_SC_ACCOUNTS = [
    "user-202286394-991268468",  # NTS Latest
    "user-643553014",            # NTS 2024-2025
    "user-612196404",            # NTS 2023
    "nts-latest",                # NTS 2020
]


def resolve_nts_accounts(client_id: str):
    """Resolve NTS SC account permalinks to user IDs."""
    global NTS_SC_USER_IDS
    for permalink in NTS_SC_ACCOUNTS:
        try:
            params = urllib.parse.urlencode({"client_id": client_id})
            url = f"https://api-v2.soundcloud.com/resolve?url=https://soundcloud.com/{permalink}&{params}"
            req = urllib.request.Request(url, headers={"User-Agent": _BROWSER_UA})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read())
            uid = data.get("id")
            if uid:
                NTS_SC_USER_IDS.add(uid)
                print(f"    {data.get('username')}: {data.get('track_count', 0)} tracks")
            time.sleep(0.2)
        except Exception:
            continue
    print(f"  Resolved {len(NTS_SC_USER_IDS)} NTS SC accounts")


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


def mixcloud_slug_to_query(mc_url: str) -> str:
    """Extract a search query from a Mixcloud URL slug."""
    slug = mc_url.rstrip("/").split("/")[-1]
    # Strip date suffixes like '24th-november-2017' or '070226'
    slug = re.sub(
        r"-?\d{1,2}(?:st|nd|rd|th)?-(?:january|february|march|april|may|june|july|august|september|october|november|december)-\d{4}",
        "", slug,
    )
    slug = re.sub(r"-?\d{6,8}$", "", slug)
    return slug.replace("-", " ").strip()


def get_nts_sc_set_url(
    episode_url: str,
    sc_client_id: str,
    episode_cache: Dict[str, Any],
    mixcloud_url: Optional[str] = None,
) -> Optional[str]:
    """Find an NTS episode on SoundCloud by searching NTS accounts."""
    cache_key = f"sc_set:{episode_url}"
    if cache_key in episode_cache:
        return episode_cache[cache_key]

    # Build search query from mixcloud slug or episode URL
    if mixcloud_url:
        query = mixcloud_slug_to_query(mixcloud_url)
    else:
        # Extract show name from NTS URL
        m = re.search(r"nts\.live/shows/([^/]+)", episode_url)
        if m:
            query = m.group(1).replace("-", " ")
        else:
            episode_cache[cache_key] = None
            return None

    if not query or len(query) < 3:
        episode_cache[cache_key] = None
        return None

    params = urllib.parse.urlencode({
        "q": query,
        "client_id": sc_client_id,
        "limit": 10,
        "filter.duration": "epic",
    })
    url = f"https://api-v2.soundcloud.com/search/tracks?{params}"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": _BROWSER_UA})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        episode_cache[cache_key] = None
        return None

    # Find a result from a known NTS account
    for item in data.get("collection", []):
        user_id = item.get("user", {}).get("id")
        if user_id in NTS_SC_USER_IDS:
            permalink = item.get("permalink_url")
            episode_cache[cache_key] = permalink
            return permalink

    episode_cache[cache_key] = None
    return None


def get_nts_episode_urls(episode_url: str, episode_cache: Dict[str, Any]) -> Dict[str, Optional[str]]:
    """Fetch SoundCloud and Mixcloud URLs for an NTS episode from their API.

    Returns dict with keys 'soundcloud' and 'mixcloud' (either may be None).
    """
    cache_key = f"nts_urls:{episode_url}"
    if cache_key in episode_cache:
        return episode_cache[cache_key]

    # Rate limit only on actual API calls
    time.sleep(0.15)

    result: Dict[str, Optional[str]] = {"soundcloud": None, "mixcloud": None}

    m = re.search(r"nts\.live/shows/([^/]+)/episodes/([^/?#]+)", episode_url)
    if not m:
        episode_cache[cache_key] = result
        return result

    show_slug, ep_slug = m.group(1), m.group(2)
    api_url = f"https://www.nts.live/api/v2/shows/{show_slug}/episodes/{ep_slug}"

    try:
        req = urllib.request.Request(api_url, headers={"User-Agent": _BROWSER_UA})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        episode_cache[cache_key] = result
        return result

    result["mixcloud"] = data.get("mixcloud")

    # Extract SC URL from audio_sources
    for src in data.get("audio_sources", []):
        src_url = src.get("url", "")
        if "soundcloud.com" in src_url:
            # Strip tracking params
            result["soundcloud"] = src_url.split("?")[0]
            break

    episode_cache[cache_key] = result
    return result


def get_lotradio_set_url(
    episode_url: str,
    artist_name: str,
    sc_client_id: str,
    episode_cache: Dict[str, Any],
) -> Optional[str]:
    """Find the Lot Radio set URL on SoundCloud for an episode."""
    cache_key = f"lr_set:{episode_url}"
    if cache_key in episode_cache:
        return episode_cache[cache_key]

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
        episode_cache[cache_key] = None
        return None

    for item in data.get("collection", []):
        permalink = item.get("permalink_url", "")
        if "thelotradio" in permalink.lower():
            episode_cache[cache_key] = permalink
            return permalink

    episode_cache[cache_key] = None
    return None


def get_episode_context(node: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Extract episode URL, timestamp, and DJ from the first edge context of a node."""
    first_ep_url = node.get("first_episode_url")
    first_ts = node.get("first_timestamp")
    if first_ep_url:
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
        description="Build audio cache: SC track -> SC set -> Mixcloud set"
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
    parser.add_argument(
        "--reprocess-deezer", action="store_true",
        help="Re-enrich entries that were sourced from Deezer",
    )
    parser.add_argument(
        "--reprocess-mixcloud", action="store_true",
        help="Try to upgrade mixcloud_set entries to soundcloud_set",
    )
    parser.add_argument(
        "--fix-sets", action="store_true",
        help="Re-fetch NTS set URLs from API for all NTS soundcloud_set entries",
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

    # Determine which nodes need enrichment
    all_ids = list(graph_nodes.keys())

    if args.reprocess_deezer:
        # Re-enrich deezer entries
        to_enrich = [nid for nid in all_ids if cache.get(nid, {}).get("source") == "deezer"]
        # Remove old entries so they get reprocessed
        for nid in to_enrich:
            del cache[nid]
        print(f"  Reprocessing {len(to_enrich)} deezer entries")
    elif args.reprocess_mixcloud:
        # Try to upgrade mixcloud entries to SC sets
        to_enrich = [nid for nid in all_ids if cache.get(nid, {}).get("source") == "mixcloud_set"]
        print(f"  Upgrading {len(to_enrich)} mixcloud entries")
    elif args.fix_sets:
        # Re-fetch NTS set URLs from API for all NTS SC set entries
        to_enrich = [
            nid for nid in all_ids
            if cache.get(nid, {}).get("setSource") == "soundcloud"
            and "nts.live" in graph_nodes.get(nid, {}).get("first_episode_url", "")
        ]
        print(f"  Fixing set URLs for {len(to_enrich)} NTS SC set entries")
    else:
        to_enrich = [nid for nid in all_ids if nid not in cache]
        print(f"  To enrich: {len(to_enrich)} / {len(all_ids)}")

    if not to_enrich:
        print("Nothing to do — cache is up to date.")
        return 0

    # Get SoundCloud client_id
    sc_client_id = get_soundcloud_client_id()
    if not sc_client_id:
        print("  WARNING: SoundCloud client_id not available, SC lookups will be skipped")
        return 1

    # Resolve NTS SC accounts
    print("  Resolving NTS SoundCloud accounts...")
    resolve_nts_accounts(sc_client_id)

    # Stats
    stats = {"soundcloud": 0, "soundcloud_set": 0, "mixcloud_set": 0, "not_found": 0}
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

        # Keep existing entry for modes that only update set URLs
        if args.reprocess_mixcloud or args.fix_sets:
            entry = cache.get(nid, {"source": "not_found"})
        else:
            entry: Dict[str, Any] = {"source": "not_found"}

        try:
            # --- Step 1: SoundCloud individual track ---
            if not args.reprocess_mixcloud and not args.fix_sets:
                if i > 0:
                    time.sleep(0.3)
                sc_result = search_soundcloud(artist, title, sc_client_id)
                if sc_result:
                    entry["source"] = "soundcloud"
                    entry["scTrackUrl"] = sc_result["scTrackUrl"]
                    if sc_result.get("artUrl"):
                        entry["artUrl"] = sc_result["artUrl"]
                    stats["soundcloud"] += 1

            # --- Step 2: SoundCloud DJ set ---
            if not args.skip_sets:
                ep_ctx = get_episode_context(node)
                if ep_ctx:
                    ep_url = ep_ctx["episode_url"]
                    ts = ep_ctx.get("timestamp")
                    offset_sec = timestamp_to_seconds(ts)

                    if "nts.live" in ep_url:
                        # 2a: Get SC + Mixcloud URLs from NTS API
                        nts_urls = get_nts_episode_urls(ep_url, episode_cache)
                        sc_set_url = nts_urls["soundcloud"]

                        # 2b: Fall back to SC search if NTS API had no SC URL
                        if not sc_set_url:
                            time.sleep(0.3)
                            existing_mc = nts_urls["mixcloud"]
                            sc_set_url = get_nts_sc_set_url(
                                ep_url, sc_client_id, episode_cache, existing_mc
                            )

                        if sc_set_url:
                            entry["setUrl"] = sc_set_url
                            entry["setSource"] = "soundcloud"
                            entry["setTimestamp"] = ts
                            entry["setOffsetSec"] = offset_sec
                            entry["setDj"] = ep_ctx.get("dj", "")
                            if entry["source"] in ("not_found", "mixcloud_set"):
                                entry["source"] = "soundcloud_set"
                                stats["soundcloud_set"] += 1
                        else:
                            # 2c: Fall back to Mixcloud
                            existing_mc = nts_urls["mixcloud"]
                            if existing_mc:
                                entry["setUrl"] = existing_mc
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
        except (socket.timeout, urllib.error.URLError, OSError, http.client.IncompleteRead) as e:
            print(f"  [{i+1}/{len(to_enrich)}] !! {artist} — {title}: {e}")
            time.sleep(2)
            continue

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
