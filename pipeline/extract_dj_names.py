"""
Extract DJ names from set/show title strings.

Reads combined_graph.json, extracts DJ names from the 'dj' field
(which contains the full show title like "Soup To Nuts w/ Shy One"),
and writes a mapping file: dj_name_map.json

Output format: { "Original Show Title": ["DJ Name 1", "DJ Name 2"], ... }

Run after graph.py whenever you rebuild the graph.
"""

import json
import os
import re

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
        dj_part = clean_name(m.group(1).strip())
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
        # Strip episode subtitles after " - " or ":" (e.g. "MOBILEGIRL - music for the kitchen" → "MOBILEGIRL")
        dj_part = re.split(r'\s+[-–—]\s+|:\s+', dj_part)[0].strip()
        return split_multiple_djs(dj_part)

    # "b2b" pattern — both are DJs
    if re.search(r'\s+[Bb]2[Bb]\s+', s):
        parts = re.split(r'\s+[Bb]2[Bb]\s+', s)
        return [clean_name(p.strip()) for p in parts if p.strip()]

    # "invites" pattern — both are DJs
    if re.search(r'\s+invites\s+', s, re.IGNORECASE):
        parts = re.split(r'\s+invites\s+', s, flags=re.IGNORECASE)
        return [clean_name(p.strip()) for p in parts if p.strip()]

    # Strip episode subtitles after " - " or ":" (e.g. "A Colourful Storm - Bitter Dream" → "A Colourful Storm")
    cleaned = re.split(r'\s+[-–—]\s+|:\s+', s)[0].strip()

    # Solo name — strip parentheticals
    return [clean_name(cleaned) or cleaned or s]


def clean_name(name):
    """Strip trailing parenthetical suffixes like '(Greensleeves Records)' or '(LIVE)'."""
    cleaned = re.sub(r'\s*\([^)]*\)\s*$', '', name).strip()
    return cleaned or name


def split_multiple_djs(dj_part):
    """Split 'DJ1 & DJ2' or 'DJ1, DJ2 + DJ3' into individual names."""
    # Split on &, +, "and", comma (but be careful with names containing these)
    # Only split on & if it looks like a separator (spaces around it)
    parts = re.split(r'\s*[&+]\s*|\s*,\s*|\s+and\s+', dj_part)
    result = [clean_name(p.strip()) for p in parts if p.strip()]
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

    # Normalize casing: pick the most frequent form for each lowercase key
    from collections import Counter
    case_counts = Counter()
    for names in dj_map.values():
        for name in names:
            case_counts[name] += 1
    # Build lowercase → canonical casing (most frequent wins)
    canonical = {}
    for name, count in case_counts.items():
        key = name.lower()
        if key not in canonical or count > canonical[key][1]:
            canonical[key] = (name, count)
    canon_map = {k: v[0] for k, v in canonical.items()}
    # Apply canonical casing to all entries
    for s in dj_map:
        dj_map[s] = [canon_map.get(n.lower(), n) for n in dj_map[s]]

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
