#!/usr/bin/env python3
"""
Targeted NTS scraper — fetch specific DJs' episodes by name.

Searches the episode index (from sitemaps) for matching show/episode aliases,
scrapes the most recent N episodes per DJ, and merges into nts_episodes.json.

Usage:
    python targeted_scrape.py                # Scrape all targets (dry run first)
    python targeted_scrape.py --dry-run      # Just show what would be scraped
    python targeted_scrape.py --count 5      # 5 episodes per DJ instead of 3
"""

import asyncio
import json
import logging
import sys
import time
from argparse import ArgumentParser
from pathlib import Path

import httpx

from parse import fetch_and_parse_episode

logger = logging.getLogger("nts-targeted")
logger.setLevel(logging.DEBUG)
console = logging.StreamHandler(sys.stdout)
console.setLevel(logging.INFO)
console.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s", datefmt="%H:%M:%S"))
logger.addHandler(console)

OUTPUT_DIR = Path("output")
INDEX_FILE = OUTPUT_DIR / "nts_episode_index.json"
EPISODES_FILE = OUTPUT_DIR / "nts_episodes.json"

# Target DJs: search terms matched against show_alias and episode_alias
# Each entry is (display_name, [search_terms], desired_count)
TARGETS = [
    ("Ben UFO", ["ben-ufo"], 10),
    ("Zack Fox", ["zack-fox"], 10),
    ("Powder", ["powder"], 10),
    ("David August", ["david-august"], 10),
    ("Tim Reaper", ["tim-reaper"], 10),
    ("Kelman Duran", ["kelman-duran"], 10),
    ("DJ Haram", ["dj-haram", "haram"], 10),
    ("Retro Cassetta", ["retro-cassetta"], 10),
    ("Logic1000", ["logic1000", "logic-1000"], 10),
    ("Against All Logic", ["against-all-logic"], 10),  # Nicolas Jaar alias
    ("Avalon Emerson", ["avalon-emerson"], 10),
    ("Shyboi", ["shyboi"], 10),
    ("Floating Points", ["floating-points"], 10),
    ("DJ Lag", ["dj-lag"], 10),
    ("Physical Therapy", ["physical-therapy"], 10),
]

# Specific episodes to scrape by (show_alias, episode_alias) — for guests not in the slug
SPECIFIC_EPISODES = [
    ("INVT (on Tash LC)", "tash-lc", "tash-lc-7th-june-2023"),
]

# Exclude false positives (episode aliases that match but aren't the target DJ)
EXCLUDE_ALIASES = {
    "powder": {"dj-catpowder", "bug-powder"},  # not DJ Powder
    "avalon-emerson": {"jeremy-avalon"},  # different person
}


def find_episodes(index, search_terms, exclude_set=None):
    """Find index entries matching any search term in show or episode alias."""
    matches = []
    for entry in index:
        show = entry.get("show_alias", "")
        ep = entry.get("episode_alias", "")
        combined = f"{show} {ep}"
        # Check excludes
        if exclude_set and any(ex in ep for ex in exclude_set):
            continue
        if any(term in combined for term in search_terms):
            matches.append(entry)
    return matches


def build_url(entry):
    return f"https://www.nts.live/shows/{entry['show_alias']}/episodes/{entry['episode_alias']}"


async def scrape_entries(entries, existing_urls):
    """Scrape a list of index entries, skipping already-scraped ones."""
    to_scrape = [e for e in entries if build_url(e) not in existing_urls]
    if not to_scrape:
        return []

    results = []
    async with httpx.AsyncClient() as client:
        for entry in to_scrape:
            try:
                result = await fetch_and_parse_episode(
                    client, entry["show_alias"], entry["episode_alias"]
                )
                result.pop("error", None)
                results.append(result)
                has_tl = result.get("has_tracklist", False)
                n_tracks = len(result.get("tracklist", []))
                logger.info(f"  scraped: {entry['episode_alias']} | tracklist={has_tl} ({n_tracks} tracks)")
                await asyncio.sleep(0.15)  # rate limit
            except Exception as e:
                logger.error(f"  error: {entry['episode_alias']}: {e}")
    return results


async def run(count_override=None, dry_run=False):
    # Load index
    if not INDEX_FILE.exists():
        logger.error(f"Episode index not found: {INDEX_FILE}")
        logger.error("Run discover.py first, or use scraper.py --skip-discovery")
        sys.exit(1)

    with open(INDEX_FILE) as f:
        index = json.load(f)
    logger.info(f"Loaded episode index: {len(index)} episodes")

    # Load existing scraped episodes
    existing_urls = set()
    existing_episodes = []
    if EPISODES_FILE.exists():
        with open(EPISODES_FILE) as f:
            existing_episodes = json.load(f)
        existing_urls = {ep["episode_url"] for ep in existing_episodes if ep.get("episode_url")}
    logger.info(f"Already scraped: {len(existing_urls)} episodes")

    # Find and plan scrapes
    plan = []
    for name, terms, default_count in TARGETS:
        count = count_override or default_count
        exclude = set()
        for term in terms:
            if term in EXCLUDE_ALIASES:
                exclude.update(EXCLUDE_ALIASES[term])

        matches = find_episodes(index, terms, exclude)
        # Filter already scraped
        new_matches = [e for e in matches if build_url(e) not in existing_urls]
        # Take most recent (index is sorted newest first)
        selected = new_matches[:count]

        already = len(matches) - len(new_matches)
        logger.info(f"{name}: {len(matches)} in index, {already} already scraped, {len(selected)} to scrape")
        for e in selected:
            logger.info(f"  -> {e['episode_alias']} ({e.get('date', '?')})")

        if not matches:
            logger.warning(f"  ** NOT FOUND on NTS **")

        plan.extend(selected)

    # Add specific episodes (guests whose names aren't in the URL slug)
    for name, show_alias, episode_alias in SPECIFIC_EPISODES:
        entry = {"show_alias": show_alias, "episode_alias": episode_alias}
        url = build_url(entry)
        if url in existing_urls:
            logger.info(f"{name}: already scraped")
        else:
            logger.info(f"{name}: 1 specific episode to scrape")
            logger.info(f"  -> {episode_alias}")
            plan.append(entry)

    logger.info(f"\nTotal to scrape: {len(plan)} episodes")

    if dry_run:
        logger.info("Dry run — not scraping.")
        return

    if not plan:
        logger.info("Nothing to scrape — all targets already covered.")
        return

    # Scrape
    start = time.time()
    new_episodes = await scrape_entries(plan, existing_urls)

    # Merge and save
    all_episodes = existing_episodes + new_episodes
    seen = set()
    deduped = []
    for ep in all_episodes:
        url = ep.get("episode_url", "")
        if url and url not in seen:
            deduped.append(ep)
            seen.add(url)

    with open(EPISODES_FILE, "w", encoding="utf-8") as f:
        json.dump(deduped, f, ensure_ascii=False)

    elapsed = time.time() - start
    with_tl = sum(1 for ep in new_episodes if ep.get("has_tracklist"))
    total_tracks = sum(len(ep.get("tracklist", [])) for ep in new_episodes)

    logger.info(f"\nDone in {elapsed:.0f}s")
    logger.info(f"Scraped: {len(new_episodes)} episodes ({with_tl} with tracklists, {total_tracks} tracks)")
    logger.info(f"Total episodes in file: {len(deduped)}")
    logger.info(f"Output: {EPISODES_FILE}")
    logger.info(f"\nNext steps:")
    logger.info(f"  cd ../../pipeline && python3 graph.py")
    logger.info(f"  python3 extract_dj_names.py")


def main():
    parser = ArgumentParser(description="Targeted NTS scraper for specific DJs")
    parser.add_argument("--count", type=int, default=None, help="Episodes per DJ (overrides per-target defaults)")
    parser.add_argument("--dry-run", action="store_true", help="Show plan without scraping")
    args = parser.parse_args()

    try:
        asyncio.run(run(count_override=args.count, dry_run=args.dry_run))
    except KeyboardInterrupt:
        logger.info("\nInterrupted.")
    except Exception as e:
        logger.error(f"Failed: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
