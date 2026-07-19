#!/usr/bin/env python3
"""
NTS Radio Scraper — Main orchestrator

Scrapes DJ sets with tracklists from NTS Radio (nts.live) via their public API
and outputs structured JSON data compatible with the Lot Radio graph pipeline.

Usage:
    python scraper.py                     # Full run (discover + scrape all)
    python scraper.py --limit 1500        # Scrape 1500 most recent episodes
    python scraper.py --skip-discovery    # Use existing episode index
    python scraper.py --resume            # Resume interrupted scrape
    python scraper.py --concurrency 10    # Increase parallelism
    python scraper.py --start-date 2024-10-01 --end-date 2024-12-31   # Backfill a date range
"""

import asyncio
import json
import logging
import sys
import time
from argparse import ArgumentParser
from pathlib import Path
from typing import Dict, List, Optional

import httpx

from discover import discover_episodes
from parse import fetch_and_parse_episode

# Configure logging
logger = logging.getLogger("nts-scraper")
logger.setLevel(logging.DEBUG)

console = logging.StreamHandler(sys.stdout)
console.setLevel(logging.INFO)
console.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s", datefmt="%H:%M:%S"))
logger.addHandler(console)

# Paths
OUTPUT_DIR = Path("output")
INDEX_FILE = OUTPUT_DIR / "nts_episode_index.json"
EPISODES_FILE = OUTPUT_DIR / "nts_episodes.json"

# Defaults
DEFAULT_CONCURRENCY = 10
SAVE_INTERVAL = 200


def load_existing(path: Path) -> Dict[str, dict]:
    """Load already-scraped episodes for idempotency. Returns dict keyed by URL."""
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            episodes = json.load(f)
        return {ep["episode_url"]: ep for ep in episodes if ep.get("episode_url")}
    except (json.JSONDecodeError, KeyError) as e:
        logger.warning(f"Could not load existing episodes: {e}")
        return {}


def save_episodes(episodes: List[dict], path: Path):
    """Deduplicate and save episodes."""
    seen = set()
    deduped = []
    for ep in episodes:
        url = ep.get("episode_url", "")
        if url and url not in seen:
            deduped.append(ep)
            seen.add(url)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(deduped, f, ensure_ascii=False)
    return len(deduped)


async def scrape_episodes(
    index: List[dict],
    existing: Dict[str, dict],
    limit: Optional[int] = None,
    concurrency: int = DEFAULT_CONCURRENCY,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> List[dict]:
    """
    Scrape episode metadata + tracklists from NTS API.

    Args:
        index: Episode index from discovery (sorted newest first)
        existing: Already-scraped episodes keyed by URL
        limit: Max episodes to scrape (None = all)
        concurrency: Number of concurrent requests
        start_date, end_date: Inclusive YYYY-MM-DD bounds (None = unbounded).
            Undated index entries are always excluded when a range is given,
            since there's no date to filter on.
    """
    # Build scrape queue (skip already done, then apply date range if given)
    to_scrape = []
    for entry in index:
        if start_date or end_date:
            d = entry.get("date")
            if not d or (start_date and d < start_date) or (end_date and d > end_date):
                continue
        url = f"https://www.nts.live/shows/{entry['show_alias']}/episodes/{entry['episode_alias']}"
        if url not in existing:
            to_scrape.append(entry)
        if limit and len(to_scrape) >= limit:
            break

    all_episodes = list(existing.values())
    total_existing = len(existing)

    if not to_scrape:
        logger.info(f"All episodes already scraped ({total_existing} total). Nothing to do.")
        return all_episodes

    logger.info(f"Scraping {len(to_scrape)} episodes ({total_existing} already done, concurrency={concurrency})")

    semaphore = asyncio.Semaphore(concurrency)
    scraped = 0
    with_tl = sum(1 for ep in all_episodes if ep.get("has_tracklist"))
    errors = 0

    async with httpx.AsyncClient() as client:
        for i, entry in enumerate(to_scrape):
            async with semaphore:
                try:
                    result = await fetch_and_parse_episode(
                        client, entry["show_alias"], entry["episode_alias"]
                    )
                    if result.get("error"):
                        # Don't save — a saved entry becomes "already scraped" and is
                        # permanently skipped on future runs, silently masking a fetch
                        # failure as "genuinely has no tracklist" forever.
                        errors += 1
                        logger.warning(f"  fetch failed, will retry next run: {entry['episode_alias']}: {result['error']}")
                        continue
                    all_episodes.append(result)
                    scraped += 1

                    if result.get("has_tracklist"):
                        with_tl += 1

                    if scraped % 50 == 0 or scraped == len(to_scrape):
                        total = total_existing + scraped
                        logger.info(
                            f"  [{scraped}/{len(to_scrape)}] "
                            f"{total} total, {with_tl} with tracklists, {errors} errors"
                        )

                    if scraped % SAVE_INTERVAL == 0:
                        n = save_episodes(all_episodes, EPISODES_FILE)
                        logger.info(f"  Checkpoint saved ({n} episodes)")

                except Exception as e:
                    errors += 1
                    logger.error(f"  Error scraping {entry['episode_alias']}: {e}")

    return all_episodes


async def run(
    skip_discovery: bool = False,
    limit: Optional[int] = None,
    concurrency: int = DEFAULT_CONCURRENCY,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    start = time.time()

    # Phase 1: Discovery
    logger.info("=" * 60)
    logger.info("PHASE 1: Episode Discovery")
    logger.info("=" * 60)

    if skip_discovery and INDEX_FILE.exists():
        logger.info(f"Loading existing index from {INDEX_FILE}")
        with open(INDEX_FILE, "r") as f:
            index = json.load(f)
        logger.info(f"Loaded {len(index)} episodes from index")
    else:
        index = discover_episodes(str(INDEX_FILE))

    # Phase 2: Scrape
    logger.info("")
    logger.info("=" * 60)
    logger.info("PHASE 2: Scraping Episodes")
    logger.info("=" * 60)

    existing = load_existing(EPISODES_FILE)
    logger.info(f"Found {len(existing)} already-scraped episodes")

    all_episodes = await scrape_episodes(
        index, existing, limit=limit, concurrency=concurrency,
        start_date=start_date, end_date=end_date,
    )

    # Save final
    n = save_episodes(all_episodes, EPISODES_FILE)
    elapsed = time.time() - start

    # Summary
    with_tl = sum(1 for ep in all_episodes if ep.get("has_tracklist"))
    total_tracks = sum(len(ep.get("tracklist", [])) for ep in all_episodes)

    logger.info("")
    logger.info("=" * 60)
    logger.info("SCRAPE COMPLETE")
    logger.info("=" * 60)
    logger.info(f"Time: {elapsed:.0f}s ({elapsed/60:.1f}m)")
    logger.info(f"Episodes saved: {n}")
    logger.info(f"With tracklist: {with_tl} ({100*with_tl/max(n,1):.0f}%)")
    logger.info(f"Total tracks: {total_tracks}")
    logger.info(f"Output: {EPISODES_FILE}")


def main():
    parser = ArgumentParser(description="NTS Radio Scraper")
    parser.add_argument("--limit", type=int, default=None, help="Max episodes to scrape (default: all)")
    parser.add_argument("--skip-discovery", action="store_true", help="Use existing episode index")
    parser.add_argument("--resume", action="store_true", help="Alias for --skip-discovery")
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY, help=f"Concurrent requests (default: {DEFAULT_CONCURRENCY})")
    parser.add_argument("--start-date", type=str, default=None, help="Only scrape episodes on/after this date (YYYY-MM-DD)")
    parser.add_argument("--end-date", type=str, default=None, help="Only scrape episodes on/before this date (YYYY-MM-DD)")

    args = parser.parse_args()
    skip = args.skip_discovery or args.resume

    try:
        asyncio.run(run(
            skip_discovery=skip, limit=args.limit, concurrency=args.concurrency,
            start_date=args.start_date, end_date=args.end_date,
        ))
    except KeyboardInterrupt:
        logger.info("\nInterrupted. Progress has been saved.")
    except Exception as e:
        logger.error(f"Scrape failed: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
