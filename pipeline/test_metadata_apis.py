#!/usr/bin/env python3
"""
Test music metadata APIs for artist genre/tag lookup.
Tests MusicBrainz, Last.fm, and Discogs with real artists from our graph.
"""

import httpx
import time
import json

# Test artists — mix of well-known and niche DJ/electronic artists from tracklists
TEST_ARTISTS = [
    "Floating Points",
    "Burial",
    "DJ Rashad",
    "Erykah Badu",
    "Actress",
    "Theo Parrish",
    "Björk",
    "Four Tet",
    "Shackleton",
    "Kelela",
    "King Tubby",
    "Pharoah Sanders",
    "Tirzah",
    "Objekt",
    "Makaya McCraven",
]

HEADERS = {"User-Agent": "adjacency-music-discovery/0.1 (https://github.com/omarish/adjacency)"}


def test_musicbrainz(artists: list[str]) -> dict:
    """MusicBrainz: No auth needed, just User-Agent. 1 req/sec limit."""
    print("\n=== MUSICBRAINZ ===")
    print("Auth: None (User-Agent only)")
    print("Rate limit: 1 req/sec\n")

    results = {}
    client = httpx.Client(headers=HEADERS, timeout=10)

    for artist in artists:
        try:
            # Search for artist
            r = client.get(
                "https://musicbrainz.org/ws/2/artist",
                params={"query": artist, "fmt": "json", "limit": 1},
            )
            r.raise_for_status()
            data = r.json()

            if not data.get("artists"):
                results[artist] = {"found": False, "tags": [], "genres": []}
                print(f"  {artist}: NOT FOUND")
                time.sleep(1.1)
                continue

            mb_artist = data["artists"][0]
            name = mb_artist.get("name", "?")
            score = mb_artist.get("score", 0)
            tags = [t["name"] for t in mb_artist.get("tags", [])]
            genres = [g["name"] for g in mb_artist.get("genres", [])]

            results[artist] = {
                "found": True,
                "matched_name": name,
                "score": score,
                "tags": tags[:10],
                "genres": genres[:10],
            }

            tag_str = ", ".join(tags[:5]) if tags else "(none)"
            genre_str = ", ".join(genres[:5]) if genres else "(none)"
            print(f"  {artist} -> {name} (score={score})")
            print(f"    tags: {tag_str}")
            print(f"    genres: {genre_str}")

        except Exception as e:
            results[artist] = {"found": False, "error": str(e)}
            print(f"  {artist}: ERROR - {e}")

        time.sleep(1.1)  # respect rate limit

    client.close()
    return results


def test_lastfm(artists: list[str], api_key: str = None) -> dict:
    """Last.fm: Requires free API key. 5 req/sec limit."""
    print("\n=== LAST.FM ===")

    if not api_key:
        print("  SKIPPED - no API key provided")
        print("  Get one free at: https://www.last.fm/api/account/create")
        return {}

    print(f"Auth: API key")
    print("Rate limit: 5 req/sec\n")

    results = {}
    client = httpx.Client(timeout=10)

    for artist in artists:
        try:
            r = client.get(
                "http://ws.audioscrobbler.com/2.0/",
                params={
                    "method": "artist.getTopTags",
                    "artist": artist,
                    "api_key": api_key,
                    "format": "json",
                },
            )
            r.raise_for_status()
            data = r.json()

            if "error" in data:
                results[artist] = {"found": False, "error": data.get("message")}
                print(f"  {artist}: {data.get('message')}")
                time.sleep(0.25)
                continue

            tags = data.get("toptags", {}).get("tag", [])
            tag_list = [(t["name"], int(t["count"])) for t in tags[:10]]

            results[artist] = {
                "found": True,
                "tags": tag_list,
            }

            tag_str = ", ".join(f"{name}({count})" for name, count in tag_list[:5])
            print(f"  {artist}: {tag_str}")

        except Exception as e:
            results[artist] = {"found": False, "error": str(e)}
            print(f"  {artist}: ERROR - {e}")

        time.sleep(0.25)

    client.close()
    return results


def test_discogs(artists: list[str], token: str = None) -> dict:
    """Discogs: Optional token (25/min without, 60/min with)."""
    print("\n=== DISCOGS ===")

    headers = {**HEADERS}
    if token:
        headers["Authorization"] = f"Discogs token={token}"
        print("Auth: Token")
        print("Rate limit: 60 req/min\n")
    else:
        print("Auth: None (unauthenticated)")
        print("Rate limit: 25 req/min\n")

    results = {}
    client = httpx.Client(headers=headers, timeout=10)

    for artist in artists:
        try:
            # Search for artist
            r = client.get(
                "https://api.discogs.com/database/search",
                params={"q": artist, "type": "artist", "per_page": 1},
            )
            r.raise_for_status()
            data = r.json()

            if not data.get("results"):
                results[artist] = {"found": False, "genres": [], "styles": []}
                print(f"  {artist}: NOT FOUND")
                time.sleep(2.5)
                continue

            disc_artist = data["results"][0]
            title = disc_artist.get("title", "?")

            # Discogs search results don't always include genre directly
            # Need to look at releases for genre/style info
            artist_id = disc_artist.get("id")

            # Get artist's releases for genre info
            time.sleep(2.5)
            r2 = client.get(
                f"https://api.discogs.com/artists/{artist_id}/releases",
                params={"per_page": 5, "sort": "year", "sort_order": "desc"},
            )
            r2.raise_for_status()
            releases = r2.json().get("releases", [])

            genres = set()
            styles = set()
            for rel in releases:
                # Release search results may not include genre directly
                # Check if the release data has genre/style info
                if "genre" in rel:
                    genres.update(rel["genre"] if isinstance(rel["genre"], list) else [rel["genre"]])
                if "style" in rel:
                    styles.update(rel["style"] if isinstance(rel["style"], list) else [rel["style"]])

            # If no genres from releases list, try getting a specific release
            if not genres and releases:
                time.sleep(2.5)
                main_release_id = releases[0].get("main_release") or releases[0].get("id")
                r3 = client.get(f"https://api.discogs.com/releases/{main_release_id}")
                r3.raise_for_status()
                rel_data = r3.json()
                genres.update(rel_data.get("genres", []))
                styles.update(rel_data.get("styles", []))

            results[artist] = {
                "found": True,
                "matched_name": title,
                "genres": sorted(genres),
                "styles": sorted(styles),
            }

            genre_str = ", ".join(sorted(genres)) if genres else "(none)"
            style_str = ", ".join(sorted(styles)[:5]) if styles else "(none)"
            print(f"  {artist} -> {title}")
            print(f"    genres: {genre_str}")
            print(f"    styles: {style_str}")

        except Exception as e:
            results[artist] = {"found": False, "error": str(e)}
            print(f"  {artist}: ERROR - {e}")

        time.sleep(2.5)  # respect rate limit

    client.close()
    return results


def summary(mb_results, lastfm_results, discogs_results):
    """Print comparison summary."""
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)

    for artist in TEST_ARTISTS:
        print(f"\n{artist}:")

        mb = mb_results.get(artist, {})
        if mb.get("found"):
            genres = mb.get("genres", [])
            tags = mb.get("tags", [])
            best = genres if genres else tags
            print(f"  MB:      {', '.join(best[:3]) if best else '(no tags)'}")
        else:
            print(f"  MB:      not found")

        lf = lastfm_results.get(artist, {})
        if lf.get("found"):
            tags = [name for name, count in lf.get("tags", [])[:3]]
            print(f"  Last.fm: {', '.join(tags) if tags else '(no tags)'}")
        elif lastfm_results:
            print(f"  Last.fm: not found")
        else:
            print(f"  Last.fm: (skipped)")

        dc = discogs_results.get(artist, {})
        if dc.get("found"):
            styles = dc.get("styles", [])
            genres = dc.get("genres", [])
            best = styles if styles else genres
            print(f"  Discogs: {', '.join(best[:3]) if best else '(no tags)'}")
        else:
            print(f"  Discogs: not found")


if __name__ == "__main__":
    import sys

    # Optional: pass Last.fm API key and/or Discogs token as args
    lastfm_key = None
    discogs_token = None

    for arg in sys.argv[1:]:
        if arg.startswith("lastfm="):
            lastfm_key = arg.split("=", 1)[1]
        elif arg.startswith("discogs="):
            discogs_token = arg.split("=", 1)[1]

    print("Testing metadata APIs with 15 artists from the graph...")
    print(f"Last.fm key: {'provided' if lastfm_key else 'not provided (will skip)'}")
    print(f"Discogs token: {'provided' if discogs_token else 'not provided (unauthenticated)'}")

    mb_results = test_musicbrainz(TEST_ARTISTS)
    lastfm_results = test_lastfm(TEST_ARTISTS, lastfm_key)
    discogs_results = test_discogs(TEST_ARTISTS, discogs_token)

    summary(mb_results, lastfm_results, discogs_results)
