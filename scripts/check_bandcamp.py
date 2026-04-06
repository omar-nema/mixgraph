import json
import random
import time
import re
import urllib.request
import urllib.parse

random.seed(42)

print("Loading data files...")
with open("web-app/output/combined_graph.json") as f:
    graph = json.load(f)

with open("web-app/output/audio_cache.json") as f:
    audio_cache = json.load(f)

nodes = graph["nodes"]
all_keys = list(nodes.keys())
print(f"Total nodes in graph: {len(all_keys)}")
print(f"Total entries in audio_cache: {len(audio_cache)}")

# Pick 40 random tracks
sample_keys = random.sample(all_keys, 40)

def has_soundcloud(track_key):
    entry = audio_cache.get(track_key)
    if not entry:
        return False
    return entry.get("source") == "soundcloud" and bool(entry.get("scTrackUrl"))

def check_bandcamp(artist, title):
    query = urllib.parse.quote_plus(f"{artist} {title}")
    url = f"https://bandcamp.com/search?q={query}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    }
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode("utf-8", errors="replace")
        # Look for the track title in the results (case-insensitive)
        title_lower = title.lower()
        artist_lower = artist.lower()
        html_lower = html.lower()
        # Check if both artist and title appear near each other in results
        title_found = title_lower in html_lower
        artist_found = artist_lower in html_lower
        if title_found and artist_found:
            return "FOUND (both)"
        elif title_found:
            return "FOUND (title only)"
        elif artist_found:
            return "artist only"
        else:
            return "not found"
    except Exception as e:
        return f"ERROR: {e}"

results = []
print("\n" + "="*80)
print(f"{'#':<3} {'TRACK KEY':<45} {'SC':^6} {'BANDCAMP'}")
print("="*80)

for i, key in enumerate(sample_keys, 1):
    node = nodes[key]
    title = node.get("title", "")
    artist = node.get("artist", "")

    sc_status = "YES" if has_soundcloud(key) else "no"

    bc_status = check_bandcamp(artist, title)
    time.sleep(0.5)

    results.append({
        "key": key,
        "title": title,
        "artist": artist,
        "soundcloud": sc_status,
        "bandcamp": bc_status,
    })

    display_key = key[:43] + ".." if len(key) > 45 else key
    print(f"{i:<3} {display_key:<45} {sc_status:^6} {bc_status}")

print("="*80)

# Summary
sc_yes = sum(1 for r in results if r["soundcloud"] == "YES")
sc_no = sum(1 for r in results if r["soundcloud"] == "no")
bc_found_both = sum(1 for r in results if r["bandcamp"] == "FOUND (both)")
bc_found_title = sum(1 for r in results if r["bandcamp"] == "FOUND (title only)")
bc_artist_only = sum(1 for r in results if r["bandcamp"] == "artist only")
bc_not_found = sum(1 for r in results if r["bandcamp"] == "not found")
bc_error = sum(1 for r in results if r["bandcamp"].startswith("ERROR"))

print(f"\nSUMMARY ({len(results)} tracks sampled)")
print(f"  SoundCloud available:     {sc_yes:>3} / {len(results)}")
print(f"  SoundCloud not found:     {sc_no:>3} / {len(results)}")
print(f"  Bandcamp - both match:    {bc_found_both:>3} / {len(results)}")
print(f"  Bandcamp - title only:    {bc_found_title:>3} / {len(results)}")
print(f"  Bandcamp - artist only:   {bc_artist_only:>3} / {len(results)}")
print(f"  Bandcamp - not found:     {bc_not_found:>3} / {len(results)}")
print(f"  Bandcamp - errors:        {bc_error:>3} / {len(results)}")
bc_any = bc_found_both + bc_found_title
print(f"\n  Bandcamp hit rate (title match): {bc_any}/{len(results)} = {bc_any/len(results)*100:.1f}%")
print(f"  SoundCloud hit rate:             {sc_yes}/{len(results)} = {sc_yes/len(results)*100:.1f}%")
