#!/usr/bin/env python3
"""
Trim the combined graph for frontend delivery.

1. Back up the original (all fields, all episodes) to combined_graph_backup.json
2. Reduce high-frequency NTS morning shows (keep N most recent per host)
3. Strip fields unused by frontend (position, timestamp_a/b, first_timestamp)
4. Overwrite combined_graph.json with the trimmed version
"""

import json
import re
import shutil
from pathlib import Path

GRAPH_PATH = Path(__file__).parent / "output" / "combined_graph.json"
BACKUP_PATH = Path(__file__).parent / "output" / "combined_graph_backup.json"
WEB_PATH = Path(__file__).parent.parent / "web-app" / "output" / "combined_graph.json"

# (base show name lowercase, max episodes to keep per host)
TRIM_RULES = {
    "the nts breakfast show": 1,
    "the early bird show": 2,
}

# Fields to strip from the frontend-facing graph
STRIP_NODE_FIELDS = ["first_timestamp"]
STRIP_CONTEXT_FIELDS = ["position", "timestamp_a", "timestamp_b"]


def get_base_show(dj):
    parts = re.split(r"\s+[wW]/\s+", dj)
    return parts[0].strip().lower()


def get_host(dj):
    parts = re.split(r"\s+[wW]/\s+", dj)
    return parts[1].strip() if len(parts) > 1 else "_no_host_"


def main():
    # Step 1: Back up original before any modifications
    print(f"Backing up original to {BACKUP_PATH} ...")
    BACKUP_PATH.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(GRAPH_PATH, BACKUP_PATH)
    backup_mb = BACKUP_PATH.stat().st_size / 1024 / 1024
    print(f"Backup size: {backup_mb:.1f} MB")

    print(f"\nLoading {GRAPH_PATH} ...")
    with open(GRAPH_PATH) as f:
        graph = json.load(f)

    nodes = graph["nodes"]
    print(f"Nodes: {len(nodes):,}")

    # Step 2: Trim morning show episodes
    show_host_eps = {}
    all_trim_eps = set()

    for n in nodes.values():
        for e in n.get("edges", []):
            for ctx in e.get("contexts", []):
                dj = (ctx.get("dj") or "").strip()
                ep = ctx.get("episode_url", "")
                base = get_base_show(dj)
                if base in TRIM_RULES and ep:
                    all_trim_eps.add(ep)
                    host = get_host(dj)
                    key = (base, host)
                    if key not in show_host_eps:
                        show_host_eps[key] = []
                    show_host_eps[key].append((ctx.get("date", ""), ep))

    keep_eps = set()
    for (base, host), eps in show_host_eps.items():
        max_keep = TRIM_RULES[base]
        seen = set()
        unique = []
        for date, url in sorted(eps, reverse=True):
            if url not in seen:
                seen.add(url)
                unique.append(url)
        for url in unique[:max_keep]:
            keep_eps.add(url)

    cut_eps = all_trim_eps - keep_eps

    print(f"\nMorning show episodes found: {len(all_trim_eps)}")
    print(f"Keeping: {len(keep_eps)}")
    print(f"Cutting: {len(cut_eps)}")

    for base, max_keep in TRIM_RULES.items():
        hosts = set(h for (b, h) in show_host_eps if b == base)
        total = len(set(ep for (b, _), eps in show_host_eps.items() if b == base for _, ep in eps))
        print(f"  {base}: {total} eps -> ~{len(hosts) * max_keep} kept ({max_keep}/host, {len(hosts)} hosts)")

    # Trim contexts from cut episodes
    for n in nodes.values():
        new_edges = []
        for e in n.get("edges", []):
            new_contexts = [
                ctx for ctx in e.get("contexts", [])
                if ctx.get("episode_url", "") not in cut_eps
            ]
            if new_contexts:
                new_edge = dict(e)
                new_edge["contexts"] = new_contexts
                new_edges.append(new_edge)
        n["edges"] = new_edges

    # Step 3: Strip fields unused by frontend
    print(f"\nStripping unused fields: {STRIP_NODE_FIELDS + STRIP_CONTEXT_FIELDS}")
    for n in nodes.values():
        for f in STRIP_NODE_FIELDS:
            n.pop(f, None)
        for e in n.get("edges", []):
            for ctx in e.get("contexts", []):
                for f in STRIP_CONTEXT_FIELDS:
                    ctx.pop(f, None)

    # Step 4: Write trimmed graph
    print(f"\nNodes remaining: {len(nodes):,}")
    output = {"nodes": nodes}
    print(f"Writing trimmed graph to {GRAPH_PATH} ...")
    with open(GRAPH_PATH, "w") as f:
        json.dump(output, f)

    size_mb = GRAPH_PATH.stat().st_size / 1024 / 1024
    print(f"Trimmed file size: {size_mb:.1f} MB (was {backup_mb:.1f} MB)")

    # Copy to web-app output (skip if same file / symlink)
    if WEB_PATH.parent.exists() and GRAPH_PATH.resolve() != WEB_PATH.resolve():
        print(f"Copying to {WEB_PATH} ...")
        shutil.copy2(GRAPH_PATH, WEB_PATH)

    print("Done.")


if __name__ == "__main__":
    main()
