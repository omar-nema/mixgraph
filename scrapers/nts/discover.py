#!/usr/bin/env python3
"""
Phase 1: NTS Radio Episode Discovery

Parses NTS sitemaps to extract all episode URLs, then sorts by broadcast
date (parsed from episode alias) to enable scraping most recent episodes first.

Input:  https://www.nts.live/sitemap1.xml.gz, sitemap2.xml.gz
Output: output/nts_episode_index.json
"""

import gzip
import json
import logging
import re
import sys
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Optional, List, Dict

import httpx

logger = logging.getLogger(__name__)

SITEMAP_URLS = [
    "https://www.nts.live/sitemap1.xml.gz",
    "https://www.nts.live/sitemap2.xml.gz",
]

MONTH_MAP = {
    "january": 1, "february": 2, "march": 3, "april": 4,
    "may": 5, "june": 6, "july": 7, "august": 8,
    "september": 9, "october": 10, "november": 11, "december": 12,
}

# Regex to extract date from episode alias: "17th-january-2026"
DATE_PATTERN = re.compile(r"(\d{1,2})(?:st|nd|rd|th)-(\w+)-(\d{4})$")

# Regex to extract (show_alias, episode_alias) from sitemap URL
EPISODE_URL_PATTERN = re.compile(
    r"<loc>https://www\.nts\.live/shows/([^/]+)/episodes/([^<]+)</loc>"
)


def parse_date_from_alias(alias: str) -> Optional[str]:
    """Parse a YYYY-MM-DD date from an episode alias like '150session-17th-january-2026'."""
    m = DATE_PATTERN.search(alias)
    if not m:
        return None
    day, month_str, year = m.group(1), m.group(2).lower(), m.group(3)
    month_num = MONTH_MAP.get(month_str)
    if not month_num:
        return None
    try:
        return f"{year}-{month_num:02d}-{int(day):02d}"
    except ValueError:
        return None


def fetch_sitemap(url: str) -> str:
    """Fetch and decompress a gzipped sitemap."""
    logger.info(f"Fetching sitemap: {url}")
    resp = httpx.get(url, follow_redirects=True, timeout=30.0)
    resp.raise_for_status()
    try:
        return gzip.decompress(resp.content).decode("utf-8")
    except gzip.BadGzipFile:
        return resp.text


def discover_episodes(output_path: str = "output/nts_episode_index.json") -> List[Dict]:
    """
    Discover all NTS episodes from sitemaps.

    Returns list of dicts sorted by date descending (most recent first):
        [{"show_alias": "...", "episode_alias": "...", "date": "YYYY-MM-DD"}, ...]
    """
    all_episodes = []
    seen = set()

    for url in SITEMAP_URLS:
        xml = fetch_sitemap(url)
        matches = EPISODE_URL_PATTERN.findall(xml)
        logger.info(f"  Found {len(matches)} episode URLs in {url.split('/')[-1]}")

        for show_alias, episode_alias in matches:
            key = (show_alias, episode_alias)
            if key in seen:
                continue
            seen.add(key)

            date = parse_date_from_alias(episode_alias)
            all_episodes.append({
                "show_alias": show_alias,
                "episode_alias": episode_alias,
                "date": date,
            })

    # Sort by date descending (most recent first), undated episodes last
    all_episodes.sort(key=lambda e: e.get("date") or "0000-00-00", reverse=True)

    logger.info(f"Total unique episodes discovered: {len(all_episodes)}")
    dated = sum(1 for e in all_episodes if e.get("date"))
    logger.info(f"  With parseable date: {dated}")
    logger.info(f"  Without date: {len(all_episodes) - dated}")

    # Save index
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(all_episodes, f, ensure_ascii=False)
    logger.info(f"Saved episode index to {output_path}")

    return all_episodes


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    episodes = discover_episodes()
    print(f"\nDiscovered {len(episodes)} episodes")
    if episodes:
        print(f"Most recent: {episodes[0]['show_alias']}/{episodes[0]['episode_alias']} ({episodes[0]['date']})")
        print(f"Oldest:      {episodes[-1]['show_alias']}/{episodes[-1]['episode_alias']} ({episodes[-1]['date']})")
