"""
Extract DJ names from set/show title strings.

Reads combined_graph.json, extracts DJ names from the 'dj' field
(which contains the full show title like "Soup To Nuts w/ Shy One"),
and writes a mapping file: dj_name_map.json

Output format: { "Original Show Title": ["DJ Name 1", "DJ Name 2"], ... }

Run after graph.py whenever you rebuild the graph.
"""

import json
import re
import os

def extract_dj_names(full_string):
    """Extract DJ name(s) from a show title string.

    Patterns handled:
      "ShowName w/ DJ"           → [DJ]
      "ShowName W/ DJ"           → [DJ]
      "ShowName with DJ"         → [DJ]
      "DJ presents: ShowName"    → [DJ]
      "DJ1 b2b DJ2"              → [DJ1, DJ2]
      "DJ1 invites DJ2"          → [DJ1, DJ2]
      "ShowName w/ DJ1 & DJ2"    → [DJ1, DJ2]
      "ShowName w/ DJ1, DJ2"     → [DJ1, DJ2]
      "Solo Name"                → [Solo Name]  (kept as-is)
    """
    s = full_string.strip()

    # "presents:" pattern — DJ is BEFORE, show is AFTER
    m = re.match(r'^(.+?)\s+[Pp]resents?:?\s+', s)
    if m:
        dj_part = m.group(1).strip()
        return split_multiple_djs(dj_part)

    # "w/" or "with" pattern — show is BEFORE, DJ is AFTER
    # Handle "w/", "W/", "w ", "with" (but not "w/" inside a word)
    m = re.split(r'\s+[Ww]/\s*|\s+[Ww]ith\s+|\s+w\s+', s, maxsplit=1)
    if len(m) == 2:
        dj_part = m[1].strip()
        # Handle sub-patterns like "HD: DEMIIGODDESS" → take after colon
        colon_m = re.match(r'^[^:]+:\s*(.+)$', dj_part)
        if colon_m:
            dj_part = colon_m.group(1).strip()
        # Handle trailing episode titles like " - Best of 2025"
        dj_part = re.sub(r'\s*[-–—]\s*(Best of|Special|Edition|Part|Vol).*$', '', dj_part, flags=re.IGNORECASE)
        return split_multiple_djs(dj_part)

    # "b2b" pattern — both are DJs
    if re.search(r'\s+[Bb]2[Bb]\s+', s):
        parts = re.split(r'\s+[Bb]2[Bb]\s+', s)
        return [p.strip() for p in parts if p.strip()]

    # "invites" pattern — both are DJs
    if re.search(r'\s+invites\s+', s, re.IGNORECASE):
        parts = re.split(r'\s+invites\s+', s, flags=re.IGNORECASE)
        return [p.strip() for p in parts if p.strip()]

    # Strip trailing episode-specific suffixes for solo names
    cleaned = re.sub(r'\s*[-–—]\s*(Best of|Special|Edition|Part|Vol|Archive|Tribute).*$', '', s, flags=re.IGNORECASE)
    cleaned = re.sub(r'\s*:\s*(Best of|Special|Edition|Part|Vol).*$', '', cleaned, flags=re.IGNORECASE)

    # Solo name — keep as-is
    return [cleaned.strip() or s]


def split_multiple_djs(dj_part):
    """Split 'DJ1 & DJ2' or 'DJ1, DJ2 + DJ3' into individual names."""
    # Split on &, +, "and", comma (but be careful with names containing these)
    # Only split on & if it looks like a separator (spaces around it)
    parts = re.split(r'\s*[&+]\s*|\s*,\s*|\s+and\s+', dj_part)
    result = [p.strip() for p in parts if p.strip()]
    return result if result else [dj_part]


def main():
    graph_path = os.path.join(os.path.dirname(__file__), 'output', 'combined_graph.json')
    output_path = os.path.join(os.path.dirname(__file__), 'output', 'dj_name_map.json')

    with open(graph_path) as f:
        graph = json.load(f)

    nodes = graph.get('nodes', graph)

    # Collect all unique DJ strings
    dj_strings = set()
    for node_id, node in nodes.items():
        for edge in node.get('edges', []):
            for ctx in edge.get('contexts', []):
                dj = (ctx.get('dj') or '').strip()
                if dj:
                    dj_strings.add(dj)

    # Build mapping
    dj_map = {}
    for s in sorted(dj_strings):
        names = extract_dj_names(s)
        dj_map[s] = names

    with open(output_path, 'w') as f:
        json.dump(dj_map, f, indent=2, ensure_ascii=False)

    # Stats
    total = len(dj_map)
    multi = sum(1 for v in dj_map.values() if len(v) > 1)
    changed = sum(1 for k, v in dj_map.items() if v != [k])
    print(f'Total DJ strings: {total}')
    print(f'Extracted/changed: {changed}')
    print(f'Multi-DJ entries: {multi}')
    print(f'Written to {output_path}')


if __name__ == '__main__':
    main()
