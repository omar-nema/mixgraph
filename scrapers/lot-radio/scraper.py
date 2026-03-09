#!/usr/bin/env python3
"""
Lot Radio Scraper — Main orchestrator
Scrapes all DJ sets with tracklists from The Lot Radio (thelotradio.com)
and outputs structured JSON data for a music recommendation engine.

Usage:
    python scraper.py                          # Full scrape
    python scraper.py --urls episode_urls.json # Scrape from pre-discovered URL list
    python scraper.py --test 10                # Test run with 10 episodes
    python scraper.py --skip-discovery         # Skip discovery, use existing URLs
"""

import asyncio
import json
import logging
import sys
import time
from argparse import ArgumentParser
from pathlib import Path
from typing import Any, Optional

import httpx

from discover import discover_episodes
from parse import fetch_and_parse_episode
from adjacency import generate_adjacencies, generate_stats

# Configure logging
logger = logging.getLogger("scraper")
logger.setLevel(logging.DEBUG)

console_handler = logging.StreamHandler(sys.stdout)
console_handler.setLevel(logging.INFO)
console_formatter = logging.Formatter(
    "%(asctime)s - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
console_handler.setFormatter(console_formatter)
logger.addHandler(console_handler)

log_dir = Path("logs")
log_dir.mkdir(parents=True, exist_ok=True)
file_handler = logging.FileHandler(log_dir / "scrape.log")
file_handler.setLevel(logging.DEBUG)
file_formatter = logging.Formatter(
    "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
file_handler.setFormatter(file_formatter)
logger.addHandler(file_handler)

# Configuration
OUTPUT_DIR = Path("output")
EPISODES_FILE = OUTPUT_DIR / "lot_radio_episodes.json"
ADJACENCIES_FILE = OUTPUT_DIR / "lot_radio_adjacencies.json"
STATS_FILE = OUTPUT_DIR / "lot_radio_stats.json"
URLS_FILE = OUTPUT_DIR / "episode_urls.json"

MAX_CONCURRENT = 2  # Max concurrent requests (respects rate limit)
REQUEST_DELAY = 0.5  # Seconds between requests (2 req/sec)


def load_existing_episodes(path: Path) -> dict[str, dict]:
    """Load already-scraped episodes for idempotency. Returns dict keyed by URL."""
    if not path.exists():
        return {}
    try:
        with open(path, "r") as f:
            episodes = json.load(f)
        return {ep["episode_url"]: ep for ep in episodes if ep.get("episode_url")}
    except (json.JSONDecodeError, KeyError) as e:
        logger.warning(f"Could not load existing episodes from {path}: {e}")
        return {}


def load_urls_from_file(path: str) -> list[dict]:
    """Load episode URLs from a pre-discovered JSON file."""
    with open(path, "r") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    raise ValueError(f"Expected a JSON array in {path}")


async def scrape_episodes(
    episode_metas: list[dict],
    existing: dict[str, dict],
    max_episodes: Optional[int] = None,
) -> tuple[list[dict], list[dict]]:
    """
    Scrape episode pages and parse tracklists.

    Args:
        episode_metas: List of episode metadata dicts (from discovery)
        existing: Dict of already-scraped episodes keyed by URL
        max_episodes: Optional limit on number of episodes to scrape

    Returns:
        Tuple of (all_episodes, errors)
    """
    all_episodes = list(existing.values())
    errors = []
    to_scrape = []

    for meta in episode_metas:
        url = meta.get("episode_url", "")
        if not url:
            continue
        if url in existing:
            continue
        to_scrape.append(meta)

    if max_episodes is not None:
        to_scrape = to_scrape[:max_episodes]

    total_to_scrape = len(to_scrape)
    already_done = len(existing)

    if total_to_scrape == 0:
        logger.info(f"All {already_done} episodes already scraped. Nothing to do.")
        return all_episodes, errors

    logger.info(
        f"Scraping {total_to_scrape} new episodes "
        f"({already_done} already done, {len(episode_metas)} total discovered)"
    )

    semaphore = asyncio.Semaphore(MAX_CONCURRENT)
    scraped_count = 0
    with_tracklist = sum(1 for ep in all_episodes if ep.get("has_tracklist"))

    async with httpx.AsyncClient() as client:
        for i, meta in enumerate(to_scrape):
            url = meta["episode_url"]

            async with semaphore:
                try:
                    result = await fetch_and_parse_episode(
                        client, url, metadata=meta
                    )

                    # Use discovery metadata as fallback for missing fields
                    if not result.get("artist_name") and meta.get("artist_name"):
                        result["artist_name"] = meta["artist_name"]
                    if not result.get("date") and meta.get("date"):
                        result["date"] = meta["date"]
                    if not result.get("genres") and meta.get("genres"):
                        result["genres"] = meta["genres"]
                    if not result.get("location") and meta.get("location"):
                        result["location"] = meta["location"]

                    # Remove internal status field
                    result.pop("status", None)
                    result.pop("error", None)

                    all_episodes.append(result)
                    scraped_count += 1

                    if result.get("has_tracklist"):
                        with_tracklist += 1

                    # Progress output
                    total_done = already_done + scraped_count
                    total_all = already_done + total_to_scrape
                    logger.info(
                        f"Scraped {total_done}/{total_all} episodes, "
                        f"{with_tracklist} with tracklists"
                    )

                    # Save intermediate results every 50 episodes
                    if scraped_count % 50 == 0:
                        _save_episodes(all_episodes)
                        logger.info(f"Saved intermediate results ({len(all_episodes)} episodes)")

                except Exception as e:
                    error_msg = f"Failed to scrape {url}: {e}"
                    logger.error(error_msg)
                    errors.append({"url": url, "error": str(e)})

                # Rate limiting
                await asyncio.sleep(REQUEST_DELAY)

    return all_episodes, errors


def _save_episodes(episodes: list[dict]):
    """Save episodes to the output file."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    # Deduplicate by URL before saving
    seen = set()
    deduped = []
    for ep in episodes:
        url = ep.get("episode_url", "")
        if url and url not in seen:
            deduped.append(ep)
            seen.add(url)
    with open(EPISODES_FILE, "w") as f:
        json.dump(deduped, f, indent=2, ensure_ascii=False)


async def run(
    urls_file: Optional[str] = None,
    skip_discovery: bool = False,
    test_limit: Optional[int] = None,
    skip_adjacency: bool = False,
):
    """
    Main scraper pipeline.

    Args:
        urls_file: Optional path to pre-discovered URLs JSON
        skip_discovery: If True, load URLs from existing file
        test_limit: Optional limit on episodes to scrape
        skip_adjacency: If True, skip adjacency generation
    """
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    start_time = time.time()

    # === Phase 1: Discovery ===
    logger.info("=" * 60)
    logger.info("PHASE 1: Episode Discovery")
    logger.info("=" * 60)

    if urls_file:
        logger.info(f"Loading episode URLs from {urls_file}")
        episode_metas = load_urls_from_file(urls_file)
        logger.info(f"Loaded {len(episode_metas)} episodes from file")
    elif skip_discovery:
        if URLS_FILE.exists():
            logger.info(f"Loading existing URLs from {URLS_FILE}")
            episode_metas = load_urls_from_file(str(URLS_FILE))
            logger.info(f"Loaded {len(episode_metas)} episodes")
        else:
            logger.error(f"No existing URL file found at {URLS_FILE}. Run discovery first.")
            return
    else:
        episode_metas = await discover_episodes(output_path=str(URLS_FILE))

    # === Phase 2: Scrape Episodes ===
    logger.info("")
    logger.info("=" * 60)
    logger.info("PHASE 2: Episode Scraping")
    logger.info("=" * 60)

    existing = load_existing_episodes(EPISODES_FILE)
    logger.info(f"Found {len(existing)} already-scraped episodes")

    all_episodes, errors = await scrape_episodes(
        episode_metas, existing, max_episodes=test_limit
    )

    # Save final episodes
    _save_episodes(all_episodes)
    logger.info(f"Saved {len(all_episodes)} episodes to {EPISODES_FILE}")

    # === Phase 3: Generate Adjacencies ===
    if not skip_adjacency:
        logger.info("")
        logger.info("=" * 60)
        logger.info("PHASE 3: Adjacency Generation")
        logger.info("=" * 60)

        adjacencies = generate_adjacencies(all_episodes)
        stats = generate_stats(all_episodes, adjacencies, errors)

        with open(ADJACENCIES_FILE, "w") as f:
            json.dump(adjacencies, f, indent=2, ensure_ascii=False)
        logger.info(f"Saved {len(adjacencies)} adjacency pairs to {ADJACENCIES_FILE}")

        with open(STATS_FILE, "w") as f:
            json.dump(stats, f, indent=2, ensure_ascii=False)
        logger.info(f"Saved stats to {STATS_FILE}")

        # Print summary
        logger.info("")
        logger.info("=" * 60)
        logger.info("SCRAPE COMPLETE")
        logger.info("=" * 60)
        elapsed = time.time() - start_time
        logger.info(f"Total time: {elapsed:.1f}s ({elapsed/60:.1f}m)")
        logger.info(f"Episodes found: {stats['total_episodes_found']}")
        logger.info(f"Episodes with tracklist: {stats['episodes_with_tracklist']}")
        logger.info(f"Episodes without tracklist: {stats['episodes_without_tracklist']}")
        logger.info(f"Total tracks: {stats['total_tracks']}")
        logger.info(f"Adjacency pairs: {stats['total_adjacency_pairs']}")
        logger.info(f"Unique artists: {stats['unique_artists']}")
        logger.info(f"Unique tracks: {stats['unique_tracks']}")
        if errors:
            logger.info(f"Errors: {len(errors)}")
    else:
        elapsed = time.time() - start_time
        logger.info(f"\nScraping complete in {elapsed:.1f}s. Adjacency generation skipped.")


def main():
    parser = ArgumentParser(
        description="Lot Radio Scraper — Collect DJ sets and tracklists"
    )
    parser.add_argument(
        "--urls",
        type=str,
        default=None,
        help="Path to pre-discovered episode URLs JSON file",
    )
    parser.add_argument(
        "--skip-discovery",
        action="store_true",
        help="Skip discovery phase, use existing URL file",
    )
    parser.add_argument(
        "--test",
        type=int,
        default=None,
        metavar="N",
        help="Test mode: only scrape N episodes",
    )
    parser.add_argument(
        "--skip-adjacency",
        action="store_true",
        help="Skip adjacency pair generation",
    )

    args = parser.parse_args()

    try:
        asyncio.run(
            run(
                urls_file=args.urls,
                skip_discovery=args.skip_discovery,
                test_limit=args.test,
                skip_adjacency=args.skip_adjacency,
            )
        )
    except KeyboardInterrupt:
        logger.info("\nScrape interrupted by user. Progress has been saved.")
    except Exception as e:
        logger.error(f"Scrape failed: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
