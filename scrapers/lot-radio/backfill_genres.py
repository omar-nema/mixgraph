#!/usr/bin/env python3
"""
Backfill genres for Lot Radio episodes by fetching RSC data from episode pages.

The new Lot Radio site (Next.js + Contentful) embeds structured genre data in
the RSC flight stream. This script fetches each episode URL and extracts
genres from the "genres":{"items":[{"name":"Disco","slug":"disco"}, ...]} pattern.

Usage:
    python backfill_genres.py              # Backfill all episodes missing genres
    python backfill_genres.py --all        # Re-fetch genres for ALL episodes
    python backfill_genres.py --test 5     # Test with 5 episodes
    python backfill_genres.py --dry-run    # Show what would change, don't save
"""

import asyncio
import json
import logging
import re
import sys
import time
from argparse import ArgumentParser
from pathlib import Path

import httpx

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

EPISODES_FILE = Path(__file__).parent / "output" / "lot_radio_episodes.json"
BACKUP_FILE = Path(__file__).parent / "output" / "lot_radio_episodes.backup.json"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# Rate limit: max 2 req/s per CLAUDE.md
REQUEST_DELAY = 0.5

# Regex to find genre items in RSC data
# Matches: "genres":{"items":[{"sys":{"id":"..."},"name":"Disco","slug":"disco"}, ...]}
GENRE_PATTERN = re.compile(
    r'"genres"\s*:\s*\{\s*"items"\s*:\s*\[(.*?)\]\s*\}',
    re.DOTALL,
)
GENRE_NAME_PATTERN = re.compile(r'"name"\s*:\s*"([^"]+)"')


def extract_genres_from_rsc(html: str) -> list[str]:
    """
    Extract genre names from the RSC flight data in the HTML.

    The RSC data contains escaped JSON like:
        \"genres\":{\"items\":[{\"sys\":{\"id\":\"...\"},\"name\":\"Disco\",\"slug\":\"disco\"}]}

    The page structure has genres in this order:
      [0] = target episode genres (may be empty)
      [1] = show-level genres (usually empty)
      [2+] = "Other sessions" on the page

    We take the FIRST non-show-level genres block (index 0). If it's empty,
    that means this episode genuinely has no genres in Contentful.
    """
    unescaped = html.replace('\\"', '"')

    for i, match in enumerate(GENRE_PATTERN.finditer(unescaped)):
        items_str = match.group(1).strip()

        # Check if this is a show-level genres block (preceded by "show":{ )
        pre = unescaped[max(0, match.start() - 100):match.start()]
        if '"show"' in pre:
            continue

        # This is an episode-level genres block — take it (first one = our episode)
        if not items_str:
            return []

        names = GENRE_NAME_PATTERN.findall(items_str)
        genre_names = [
            n for n in names
            if len(n) > 1 and (n[0].isupper() or n[0].isdigit())
        ]
        return genre_names

    return []


async def fetch_genres_for_episode(
    client: httpx.AsyncClient, episode_url: str
):
    """Fetch an episode page and extract genres from RSC data."""
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    try:
        resp = await client.get(
            episode_url, headers=headers, timeout=30.0, follow_redirects=True
        )
        resp.raise_for_status()
        genres = extract_genres_from_rsc(resp.text)
        return genres
    except httpx.HTTPStatusError as e:
        logger.warning(f"HTTP {e.response.status_code} for {episode_url}")
        return None
    except Exception as e:
        logger.warning(f"Error fetching {episode_url}: {e}")
        return None


async def backfill(args):
    # Load episodes
    if not EPISODES_FILE.exists():
        logger.error(f"Episodes file not found: {EPISODES_FILE}")
        sys.exit(1)

    with open(EPISODES_FILE) as f:
        episodes = json.load(f)

    logger.info(f"Loaded {len(episodes)} episodes")

    # Determine which episodes to process
    if args.all:
        to_process = list(range(len(episodes)))
        logger.info("Processing ALL episodes (--all)")
    else:
        to_process = [
            i for i, e in enumerate(episodes) if not e.get("genres")
        ]
        logger.info(f"Found {len(to_process)} episodes missing genres")

    if args.test:
        to_process = to_process[: args.test]
        logger.info(f"Test mode: processing {len(to_process)} episodes")

    if not to_process:
        logger.info("Nothing to do!")
        return

    # Create backup before modifying
    if not args.dry_run:
        with open(BACKUP_FILE, "w") as f:
            json.dump(episodes, f)
        logger.info(f"Backup saved to {BACKUP_FILE}")

    # Process episodes
    updated = 0
    failed = 0
    no_genres = 0
    save_every = 100

    async with httpx.AsyncClient() as client:
        for idx_num, ep_idx in enumerate(to_process):
            ep = episodes[ep_idx]
            url = ep["episode_url"]
            old_genres = ep.get("genres", [])

            genres = await fetch_genres_for_episode(client, url)

            if genres is None:
                failed += 1
                logger.warning(f"[{idx_num+1}/{len(to_process)}] FAILED: {url}")
            elif not genres:
                no_genres += 1
                logger.debug(
                    f"[{idx_num+1}/{len(to_process)}] No genres found: {url}"
                )
            else:
                if genres != old_genres:
                    if args.dry_run:
                        logger.info(
                            f"[{idx_num+1}/{len(to_process)}] WOULD UPDATE: {url}"
                        )
                        logger.info(f"  Old: {old_genres}")
                        logger.info(f"  New: {genres}")
                    else:
                        episodes[ep_idx]["genres"] = genres
                    updated += 1
                else:
                    logger.debug(
                        f"[{idx_num+1}/{len(to_process)}] Unchanged: {url}"
                    )

            # Progress update
            if (idx_num + 1) % 50 == 0:
                logger.info(
                    f"Progress: {idx_num+1}/{len(to_process)} "
                    f"(updated={updated}, no_genres={no_genres}, failed={failed})"
                )

            # Incremental save
            if not args.dry_run and (idx_num + 1) % save_every == 0 and updated > 0:
                with open(EPISODES_FILE, "w") as f:
                    json.dump(episodes, f, indent=2)
                logger.info(f"Saved progress ({updated} updated so far)")

            # Rate limit
            await asyncio.sleep(REQUEST_DELAY)

    # Final save
    if not args.dry_run and updated > 0:
        with open(EPISODES_FILE, "w") as f:
            json.dump(episodes, f, indent=2)

    logger.info(f"\nDone! Updated: {updated}, No genres on page: {no_genres}, Failed: {failed}")
    logger.info(f"Total episodes: {len(episodes)}")
    with_genres = sum(1 for e in episodes if e.get("genres"))
    logger.info(f"Episodes with genres: {with_genres} ({with_genres/len(episodes)*100:.1f}%)")


def main():
    parser = ArgumentParser(description="Backfill genres for Lot Radio episodes")
    parser.add_argument("--all", action="store_true", help="Re-fetch genres for ALL episodes")
    parser.add_argument("--test", type=int, help="Test with N episodes")
    parser.add_argument("--dry-run", action="store_true", help="Show changes without saving")
    args = parser.parse_args()
    asyncio.run(backfill(args))


if __name__ == "__main__":
    main()
