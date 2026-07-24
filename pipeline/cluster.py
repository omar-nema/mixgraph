#!/usr/bin/env python3
"""
Selects a cluster from the track adjacency graph, enriches it with Spotify
album art and preview URLs, computes a polar layout, and writes cluster.json.

Usage:
    export SPOTIFY_CLIENT_ID=your_id
    export SPOTIFY_CLIENT_SECRET=your_secret
    python cluster.py [--seed 42]

Input:  output/lot_radio_graph.json
Output: output/cluster.json
"""

import json
import math
import random
import hashlib
import argparse
import re
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path
from typing import Dict, Any, List, Optional, Set, Tuple


# ═══════════════════════════════════════════
# Graph loading & cluster selection
# ═══════════════════════════════════════════

def load_graph(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def find_candidates(graph_nodes: Dict[str, Any], min_edges: int = 3) -> List[str]:
    """Return node IDs with at least `min_edges` edges."""
    return [
        nid for nid, node in graph_nodes.items()
        if len(node.get("edges", [])) >= min_edges
    ]


def _get_neighbors(graph_nodes, node_id, exclude):
    """Return neighbor IDs for node_id, excluding IDs in the exclude set."""
    node = graph_nodes.get(node_id)
    if not node:
        return []
    return [
        e["node"] for e in node["edges"]
        if e["node"] in graph_nodes and e["node"] not in exclude
    ]


def _get_edge_context(graph_nodes, from_id, to_id):
    """Get the first context (dj, episode_url, date) for an edge between two nodes."""
    node = graph_nodes.get(from_id)
    if not node:
        return None
    for edge in node.get("edges", []):
        if edge["node"] == to_id and edge.get("contexts"):
            ctx = edge["contexts"][0]
            return {
                "dj": ctx.get("dj", ""),
                "episodeUrl": ctx.get("episode_url", ""),
                "date": ctx.get("date", ""),
            }
    return None


def select_cluster(
    graph_nodes: Dict[str, Any],
    root_id: str,
    r1_count: int = 2,
    r2_per_r1: int = 2,
    rng: random.Random = None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]]]:
    """
    BFS depth 2-3 from root. Selects r1_count R1 neighbors (preferring those
    with enough children) and r2_per_r1 R2 per R1. If an R2 slot can't be
    filled, extends to R3. Guarantees both sides have equal depth.

    Returns (nodes_list, edges_list).
    """
    if rng is None:
        rng = random.Random()

    root_node = graph_nodes[root_id]
    nodes = []
    edges = []
    used_ids = {root_id}  # all graph IDs already in the cluster

    def make_node(local_id, graph_id, rank):
        n = graph_nodes[graph_id]
        used_ids.add(graph_id)
        # Collect unique DJs who played this track (from all edge contexts)
        seen_djs = set()
        djs = []
        for edge in n.get("edges", []):
            for ctx in edge.get("contexts", []):
                dj_name = ctx.get("dj", "").strip()
                ep_url = ctx.get("episode_url", "")
                if dj_name and dj_name not in seen_djs:
                    seen_djs.add(dj_name)
                    djs.append({"name": dj_name, "episodeUrl": ep_url})
        return {
            "id": local_id,
            "graphId": graph_id,
            "rank": rank,
            "title": n["title"],
            "artist": n["artist"],
            "djs": djs,
        }

    def make_edge(from_local, to_local, from_graph_id, to_graph_id):
        edge = {"from": from_local, "to": to_local}
        ctx = _get_edge_context(graph_nodes, from_graph_id, to_graph_id)
        if ctx:
            edge["context"] = ctx
        return edge

    # Root
    nodes.append(make_node("root", root_id, "root"))

    # Rank 1: only consider candidates that have at least 1 child (not a dead-end)
    r1_all = _get_neighbors(graph_nodes, root_id, used_ids)

    def r1_child_count(cid):
        return len(_get_neighbors(graph_nodes, cid, used_ids | {root_id}))

    # Filter out dead-ends, then sort: rich (>= r2_per_r1 children) first
    viable = [c for c in r1_all if r1_child_count(c) >= 1]
    rich = [c for c in viable if r1_child_count(c) >= r2_per_r1]
    okay = [c for c in viable if r1_child_count(c) < r2_per_r1]
    rng.shuffle(rich)
    rng.shuffle(okay)
    r1_candidates = rich + okay
    r1_selected = r1_candidates[:r1_count]

    for i, r1_graph_id in enumerate(r1_selected):
        r1_local = f"r1_{i}"
        nodes.append(make_node(r1_local, r1_graph_id, "1"))
        edges.append(make_edge("root", r1_local, root_id, r1_graph_id))

        # Rank 2: pick from r1's edges, excluding everything already used
        r2_candidates = _get_neighbors(graph_nodes, r1_graph_id, used_ids)
        rng.shuffle(r2_candidates)
        r2_selected = r2_candidates[:r2_per_r1]

        r2_local_ids = []
        for j, r2_graph_id in enumerate(r2_selected):
            r2_local = f"r2_{i}_{j}"
            nodes.append(make_node(r2_local, r2_graph_id, "2"))
            edges.append(make_edge(r1_local, r2_local, r1_graph_id, r2_graph_id))
            r2_local_ids.append((r2_local, r2_graph_id))

        # If we couldn't fill all R2 slots, extend existing R2 nodes to R3
        filled = len(r2_selected)
        if filled < r2_per_r1 and filled > 0:
            needed = r2_per_r1 - filled
            for r2_local, r2_graph_id in r2_local_ids:
                if needed <= 0:
                    break
                r3_candidates = _get_neighbors(graph_nodes, r2_graph_id, used_ids)
                rng.shuffle(r3_candidates)
                for k, r3_graph_id in enumerate(r3_candidates[:needed]):
                    r3_local = f"r3_{i}_{k}"
                    nodes.append(make_node(r3_local, r3_graph_id, "2"))
                    edges.append(make_edge(r2_local, r3_local, r2_graph_id, r3_graph_id))
                    needed -= 1

    return nodes, edges


# ═══════════════════════════════════════════
# Polar layout
# ═══════════════════════════════════════════

CONTAINER_W = 1200
CONTAINER_H = 900
R1_RADIUS = 280
R2_RADIUS = 220

# Card dimensions by rank (must match CSS)
CARD_DIMS = {
    "root": (280, 310),
    "1": (180, 210),
    "2": (155, 185),
}


def _jitter(node_id: str, scale: float = 20.0) -> Tuple[float, float]:
    """Deterministic jitter from node ID hash."""
    h = int(hashlib.md5(node_id.encode()).hexdigest()[:8], 16)
    jx = ((h & 0xFFFF) / 0xFFFF - 0.5) * scale
    jy = (((h >> 16) & 0xFFFF) / 0xFFFF - 0.5) * scale
    return jx, jy


def compute_layout(nodes: List[Dict[str, Any]]) -> None:
    """Assign x, y coordinates in-place using polar layout."""
    # Center of container (top-left of root card, centered)
    root_w, root_h = CARD_DIMS["root"]
    cx = CONTAINER_W / 2 - root_w / 2
    cy = CONTAINER_H / 2 - root_h / 2

    # Group nodes by rank and parent
    r1_nodes = [n for n in nodes if n["rank"] == "1"]
    r2_by_parent: Dict[str, List[Dict]] = {}
    for n in nodes:
        if n["rank"] == "2":
            # Parent is encoded in ID: r2_{parent_idx}_{child_idx}
            parent_idx = n["id"].split("_")[1]
            parent_id = f"r1_{parent_idx}"
            r2_by_parent.setdefault(parent_id, []).append(n)

    # Place root
    for n in nodes:
        if n["rank"] == "root":
            jx, jy = _jitter(n.get("graphId", n["id"]), 8)
            n["x"] = int(cx + jx)
            n["y"] = int(cy + jy)

    # Place R1 nodes on a diagonal arc around root center
    r1_count = len(r1_nodes)
    if r1_count > 0:
        # Spread R1 nodes: upper-left and lower-right diagonal
        base_angles = []
        if r1_count == 1:
            base_angles = [math.radians(-45)]
        elif r1_count == 2:
            base_angles = [math.radians(-135), math.radians(45)]
        else:
            spread = 2 * math.pi / r1_count
            base_angles = [i * spread - math.pi / 4 for i in range(r1_count)]

        root_center_x = cx + root_w / 2
        root_center_y = cy + root_h / 2

        for i, r1_node in enumerate(r1_nodes):
            angle = base_angles[i]
            jx, jy = _jitter(r1_node.get("graphId", r1_node["id"]))
            card_w, card_h = CARD_DIMS["1"]
            r1_x = root_center_x + math.cos(angle) * R1_RADIUS - card_w / 2 + jx
            r1_y = root_center_y + math.sin(angle) * R1_RADIUS - card_h / 2 + jy
            r1_node["x"] = int(max(0, min(CONTAINER_W - card_w, r1_x)))
            r1_node["y"] = int(max(0, min(CONTAINER_H - card_h, r1_y)))

            # Place R2 nodes fanning outward from this R1
            r2_children = r2_by_parent.get(r1_node["id"], [])
            if r2_children:
                r1_center_x = r1_node["x"] + card_w / 2
                r1_center_y = r1_node["y"] + card_h / 2
                fan_spread = math.radians(50)
                fan_start = angle - fan_spread * (len(r2_children) - 1) / 2

                for j, r2_node in enumerate(r2_children):
                    r2_angle = fan_start + j * fan_spread
                    jx2, jy2 = _jitter(r2_node.get("graphId", r2_node["id"]), 15)
                    cw, ch = CARD_DIMS["2"]
                    r2_x = r1_center_x + math.cos(r2_angle) * R2_RADIUS - cw / 2 + jx2
                    r2_y = r1_center_y + math.sin(r2_angle) * R2_RADIUS - ch / 2 + jy2
                    r2_node["x"] = int(max(0, min(CONTAINER_W - cw, r2_x)))
                    r2_node["y"] = int(max(0, min(CONTAINER_H - ch, r2_y)))


# ═══════════════════════════════════════════
# Deezer enrichment (no auth needed)
# ═══════════════════════════════════════════

def search_deezer(artist: str, title: str) -> Optional[Dict[str, str]]:
    """Search Deezer for a track. Returns art/preview/link or None."""
    import time
    query = f'artist:"{artist}" track:"{title}"'
    params = urllib.parse.urlencode({"q": query, "limit": 1})
    url = f"https://api.deezer.com/search?{params}"
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except (urllib.error.URLError, TimeoutError):
        return None

    items = data.get("data", [])
    if not items:
        # Retry with looser query (no field prefixes)
        query2 = f"{artist} {title}"
        params2 = urllib.parse.urlencode({"q": query2, "limit": 1})
        url2 = f"https://api.deezer.com/search?{params2}"
        req2 = urllib.request.Request(url2)
        try:
            time.sleep(0.1)
            with urllib.request.urlopen(req2, timeout=10) as resp2:
                data2 = json.loads(resp2.read())
        except (urllib.error.URLError, TimeoutError):
            return None
        items = data2.get("data", [])
        if not items:
            return None

    track = items[0]
    # album.cover_big is 500x500
    art_url = track.get("album", {}).get("cover_big")
    preview_url = track.get("preview")  # 30s MP3
    deezer_link = track.get("link")

    # preview_url is "" when not available
    if preview_url == "":
        preview_url = None

    return {
        "artUrl": art_url,
        "previewUrl": preview_url,
        "deezerUrl": deezer_link,
    }


def soundcloud_search_url(artist: str, title: str) -> str:
    """Build a SoundCloud search URL (no auth needed)."""
    q = urllib.parse.quote(f"{artist} {title}")
    return f"https://soundcloud.com/search/sounds?q={q}"


# ═══════════════════════════════════════════
# SoundCloud enrichment
# ═══════════════════════════════════════════

_sc_client_id: Optional[str] = None
_sc_client_id_fetched: bool = False

_BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


from utils import normalize as _normalize


def get_soundcloud_client_id() -> Optional[str]:
    """Extract a SoundCloud client_id from their JS bundles. Cached per run."""
    global _sc_client_id, _sc_client_id_fetched
    if _sc_client_id_fetched:
        return _sc_client_id
    _sc_client_id_fetched = True

    try:
        req = urllib.request.Request(
            "https://soundcloud.com",
            headers={"User-Agent": _BROWSER_UA},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"  ⚠ SC client_id: failed to fetch soundcloud.com: {e}")
        return None

    # Find JS bundle URLs
    bundle_urls = re.findall(
        r'src="(https://a-v2\.sndcdn\.com/assets/[^"]+\.js)"', html
    )
    if not bundle_urls:
        print("  ⚠ SC client_id: no JS bundles found")
        return None

    # Check last 3 bundles (client_id is usually in later bundles)
    for bundle_url in bundle_urls[-3:]:
        try:
            req = urllib.request.Request(
                bundle_url, headers={"User-Agent": _BROWSER_UA}
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                js = resp.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError, OSError):
            continue

        m = re.search(r'client_id:"([a-zA-Z0-9]{32})"', js)
        if m:
            _sc_client_id = m.group(1)
            print(f"  ✓ SC client_id extracted")
            return _sc_client_id

    print("  ⚠ SC client_id: not found in bundles")
    return None


# Tokens this short are matched as isolated words, not substrings — otherwise
# acronyms like "M.O.M." (normalized "mom") match anything containing "mom"
# ("Momentum", "Moment Of Truth"). Longer tokens keep substring matching so
# minor suffix variance ("remix" / "remixes") still lines up.
_ISOLATED_TOKEN_MAX_LEN = 4


def _token_matches(token: str, combined: str, combined_tokens: Set[str]) -> bool:
    """True if a query token is present in a candidate's 'user title' string."""
    if len(token) <= _ISOLATED_TOKEN_MAX_LEN:
        return token in combined_tokens
    return token in combined


def sc_track_matches(item: Dict[str, Any], norm_artist: str, norm_title: str) -> bool:
    """True if a SoundCloud search result plausibly *is* the track we asked for.

    Every word of the artist and title must appear in "<uploader> <track title>".
    """
    item_title = _normalize(item.get("title", ""))
    item_user = _normalize(item.get("user", {}).get("username", ""))
    combined = f"{item_user} {item_title}"
    combined_tokens = set(combined.split())
    words = norm_artist.split() + norm_title.split()
    if not words:
        return False
    return all(_token_matches(w, combined, combined_tokens) for w in words)


def search_soundcloud(
    artist: str, title: str, client_id: str
) -> Optional[Dict[str, Any]]:
    """Search SoundCloud for a track. Returns scTrackUrl/artUrl/scDuration or None."""
    norm_artist = _normalize(artist)
    norm_title = _normalize(title)

    def _query_sc(
        query_str: str, want_artist: str = None, want_title: str = None
    ) -> Optional[Dict[str, Any]]:
        want_artist = norm_artist if want_artist is None else want_artist
        want_title = norm_title if want_title is None else want_title

        params = urllib.parse.urlencode({
            "q": query_str, "client_id": client_id, "limit": 5,
        })
        url = f"https://api-v2.soundcloud.com/search/tracks?{params}"
        req = urllib.request.Request(url, headers={"User-Agent": _BROWSER_UA})

        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read())
                break
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    wait = 0.5 * (2 ** attempt)
                    time.sleep(wait)
                    continue
                if e.code in (401, 403):
                    return None
                return None
            except (urllib.error.URLError, TimeoutError, OSError):
                return None
        else:
            return None

        for item in data.get("collection", []):
            if sc_track_matches(item, want_artist, want_title):
                artwork = item.get("artwork_url") or ""
                # Upgrade to 500x500
                if artwork:
                    artwork = artwork.replace("-large.", "-t500x500.")
                return {
                    "scTrackUrl": item.get("permalink_url"),
                    "artUrl": artwork or None,
                    "scDuration": item.get("duration"),  # milliseconds
                }
        return None

    # First attempt: full query
    result = _query_sc(f"{artist} {title}")
    if result:
        return result

    # Retry with simplified query (strip parentheticals)
    simple_title = re.sub(r"\s*\([^)]*\)", "", title).strip()
    simple_artist = re.sub(r"\s*\([^)]*\)", "", artist).strip()
    if simple_title != title or simple_artist != artist:
        time.sleep(0.25)
        return _query_sc(
            f"{simple_artist} {simple_title}",
            _normalize(simple_artist), _normalize(simple_title),
        )

    return None


def enrich_nodes(nodes: List[Dict[str, Any]]) -> Dict[str, int]:
    """Add artUrl, previewUrl, scTrackUrl, source to each node. Returns counts.

    Waterfall: SoundCloud (full track) -> Deezer (30s preview) -> not_found.
    """
    stats = {"soundcloud": 0, "deezer": 0, "not_found": 0}

    # Extract SC client_id once for the whole batch
    sc_client_id = get_soundcloud_client_id()
    sc_disabled = sc_client_id is None

    for i, node in enumerate(nodes):
        artist = node["artist"]
        title = node["title"]

        if i > 0:
            time.sleep(0.25)  # gentle rate limiting

        # Scaffold archive fields (null for now)
        node["archiveUrl"] = None
        node["archiveOffset"] = None
        node["archiveDuration"] = None

        # 1) Try SoundCloud
        sc_result = None
        if not sc_disabled:
            try:
                sc_result = search_soundcloud(artist, title, sc_client_id)
            except Exception:
                pass

        if sc_result and sc_result.get("scTrackUrl"):
            node["scTrackUrl"] = sc_result["scTrackUrl"]
            node["artUrl"] = sc_result.get("artUrl")
            node["previewUrl"] = None
            node["deezerUrl"] = None
            node["source"] = "soundcloud"
            stats["soundcloud"] += 1
            print(f"  ✓ [SC] {artist} — {title}")
            continue

        # 2) Try Deezer
        if i > 0 or sc_result is None:
            time.sleep(0.15)

        dz_result = search_deezer(artist, title)

        if dz_result and dz_result.get("artUrl"):
            node["scTrackUrl"] = None
            node["artUrl"] = dz_result["artUrl"]
            node["previewUrl"] = dz_result.get("previewUrl")
            node["deezerUrl"] = dz_result.get("deezerUrl")
            node["source"] = "deezer"
            stats["deezer"] += 1
            preview_tag = " +audio" if dz_result.get("previewUrl") else " (no preview)"
            print(f"  ✓ [DZ] {artist} — {title}{preview_tag}")
            continue

        # 3) Neither found
        node["scTrackUrl"] = None
        node["artUrl"] = None
        node["previewUrl"] = None
        node["deezerUrl"] = None
        node["soundcloudUrl"] = soundcloud_search_url(artist, title)
        node["source"] = "not_found"
        stats["not_found"] += 1
        print(f"  ✗ {artist} — {title}")

    return stats


# ═══════════════════════════════════════════
# Main
# ═══════════════════════════════════════════

def generate_one_cluster(
    graph_nodes: Dict[str, Any],
    candidates: List[str],
    rng: random.Random,
    r1_count: int,
    r2_per_r1: int,
    index: int,
    total: int,
) -> Optional[Dict[str, Any]]:
    """Generate a single enriched cluster. Returns the cluster dict or None."""
    root_id = rng.choice(candidates)
    root_node = graph_nodes[root_id]
    print(f"\n[{index + 1}/{total}] {root_node['artist']} — {root_node['title']}  ({len(root_node['edges'])} edges)")

    nodes, edges = select_cluster(graph_nodes, root_id, r1_count, r2_per_r1, rng)

    stats = enrich_nodes(nodes)

    return {
        "meta": {
            "root_id": root_id,
            "soundcloud": stats["soundcloud"],
            "deezer": stats["deezer"],
            "not_found": stats["not_found"],
            "found": stats["soundcloud"] + stats["deezer"],
        },
        "nodes": nodes,
        "edges": edges,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Generate clusters from the track adjacency graph with Deezer enrichment"
    )
    parser.add_argument(
        "--seed", type=int, default=None,
        help="Random seed for reproducible cluster selection",
    )
    parser.add_argument(
        "--graph", type=str, default="output/combined_graph.json",
        help="Path to graph JSON (default: output/combined_graph.json)",
    )
    parser.add_argument(
        "--output", type=str, default="output/clusters.json",
        help="Path to output JSON (default: output/clusters.json)",
    )
    parser.add_argument(
        "--root", type=str, default=None,
        help="Force a specific root node ID (e.g. 'moodymann:::no')",
    )
    parser.add_argument(
        "--r1", type=int, default=2,
        help="Number of rank-1 neighbors (default: 2)",
    )
    parser.add_argument(
        "--r2", type=int, default=2,
        help="Number of rank-2 neighbors per rank-1 (default: 2)",
    )
    parser.add_argument(
        "--count", type=int, default=20,
        help="Number of clusters to generate (default: 20)",
    )
    args = parser.parse_args()

    rng = random.Random(args.seed)

    # Load graph
    print(f"Loading graph from {args.graph}...")
    graph = load_graph(args.graph)
    graph_nodes = graph["nodes"]
    print(f"  {len(graph_nodes)} nodes loaded")

    candidates = find_candidates(graph_nodes, min_edges=3)
    print(f"  {len(candidates)} candidates with 3+ edges")
    if not candidates:
        print("Error: No candidates found")
        return 1

    if args.root:
        if args.root not in graph_nodes:
            print(f"Error: Node '{args.root}' not found in graph")
            return 1
        # Single forced root — generate just one
        args.count = 1

    # Generate clusters
    clusters = []
    used_roots = set()
    for i in range(args.count):
        if args.root:
            root_id = args.root
            # Temporarily override choice
            orig_choice = rng.choice
            rng.choice = lambda lst, _r=root_id: _r
            cluster = generate_one_cluster(
                graph_nodes, candidates, rng, args.r1, args.r2, i, args.count
            )
            rng.choice = orig_choice
        else:
            # Try to pick a root we haven't used yet
            available = [c for c in candidates if c not in used_roots]
            if not available:
                available = candidates  # allow repeats if we exhaust candidates
            cluster = generate_one_cluster(
                graph_nodes, available, rng, args.r1, args.r2, i, args.count
            )

        if cluster:
            used_roots.add(cluster["meta"]["root_id"])
            clusters.append(cluster)

    # Write
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(clusters, f, indent=2, ensure_ascii=False)

    total_found = sum(c["meta"]["found"] for c in clusters)
    total_nodes = sum(len(c["nodes"]) for c in clusters)
    print(f"\nWrote {len(clusters)} clusters to {args.output}")
    print(f"  Total tracks enriched: {total_found}/{total_nodes}")
    print("\nDone!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
