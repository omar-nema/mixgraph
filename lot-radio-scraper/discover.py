#!/usr/bin/env python3
"""
Phase 1: Discovery module for Lot Radio scraper
Discovers all episode URLs by calling the Next.js Server Action API
"""

import asyncio
import json
import logging
import re
import sys
from argparse import ArgumentParser
from datetime import datetime
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urljoin

import httpx

# Configure logging
logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)

# Console handler
console_handler = logging.StreamHandler(sys.stdout)
console_handler.setLevel(logging.INFO)
console_formatter = logging.Formatter(
    "%(asctime)s - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
console_handler.setFormatter(console_formatter)
logger.addHandler(console_handler)

# File handler
log_file_path = Path("logs/discover.log")
log_file_path.parent.mkdir(parents=True, exist_ok=True)
file_handler = logging.FileHandler(log_file_path)
file_handler.setLevel(logging.DEBUG)
file_formatter = logging.Formatter(
    "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
file_handler.setFormatter(file_formatter)
logger.addHandler(file_handler)

# Configuration
BASE_URL = "https://www.thelotradio.com"
INDEX_URL = f"{BASE_URL}/the-index"
ACTION_URL = INDEX_URL
LIMIT_PER_PAGE = 16
MAX_REQUESTS_PER_SECOND = 2
RETRY_ATTEMPTS = 3
DEFAULT_NEXT_ACTION = "c0ac6b566a9c50587e659d85a6540f5d7f28f87b51"

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def extract_next_action_id(html: str) -> Optional[str]:
    """
    Extract the next-action ID from the index page HTML.
    Looks for the JS bundle and extracts the action ID from it.
    """
    logger.debug("Attempting to extract next-action ID from HTML")

    # Look for _next/static/chunks references
    # The pattern typically looks for the hash in script sources
    patterns = [
        r'/_next/static/chunks/.*?([a-f0-9]{40}).*?\.js',
        r'next-action["\']?\s*[:=]\s*["\']([a-f0-9]{40})',
        r'([a-f0-9]{40})',  # Generic 40-char hex hash
    ]

    for pattern in patterns:
        match = re.search(pattern, html)
        if match:
            action_id = match.group(1)
            logger.info(f"Extracted next-action ID from HTML: {action_id}")
            return action_id

    logger.warning("Could not extract next-action ID from HTML, will use default")
    return None


async def fetch_next_action_id(client: httpx.AsyncClient) -> str:
    """
    Fetch the index page and extract the next-action ID.
    Falls back to default if extraction fails.
    """
    try:
        logger.info("Fetching index page to extract next-action ID")
        response = await client.get(INDEX_URL, follow_redirects=True)
        response.raise_for_status()

        extracted_id = extract_next_action_id(response.text)
        if extracted_id:
            return extracted_id
    except Exception as e:
        logger.warning(f"Failed to fetch/parse index page: {e}")

    logger.info(f"Using default next-action ID: {DEFAULT_NEXT_ACTION}")
    return DEFAULT_NEXT_ACTION


def parse_rsc_response(response_text: str) -> dict[str, Any]:
    """
    Parse the RSC flight data response.
    Response format: multiple lines, each with NUMBER:DATA
    Episode data is on the line starting with '1:'
    """
    logger.debug("Parsing RSC response")
    lines = response_text.strip().split('\n')

    for line in lines:
        if line.startswith('1:'):
            json_str = line[2:]  # Remove '1:' prefix
            try:
                data = json.loads(json_str)
                logger.debug(f"Successfully parsed RSC data. Total items: {len(data.get('items', []))}")
                return data
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse RSC JSON: {e}")
                raise

    raise ValueError("Could not find line starting with '1:' in RSC response")


def construct_episode_url(show_slug: str, episode_slug: str) -> str:
    """Construct the full episode URL."""
    return f"{BASE_URL}/shows/{show_slug}/{episode_slug}"


def extract_artist_name(title: str) -> str:
    """
    Extract artist name from title.
    Title format: "Episode Title with Artist Name"
    Try to extract the artist from the title intelligently.
    """
    # If there's a separator like " - ", " by ", etc., extract the part after it
    for sep in [' - ', ' by ', ' w/ ', ' with ']:
        if sep in title:
            parts = title.split(sep)
            if len(parts) > 1:
                return parts[-1].strip()

    # Otherwise return the full title as artist name
    return title.strip()


def parse_episode_item(item: dict[str, Any]) -> dict[str, Any]:
    """Parse a single episode item from the API response."""
    # Extract date as YYYY-MM-DD from ISO timestamp
    full_date = item.get('date', '')
    date_str = full_date.split('T')[0] if full_date else ''

    # Extract genres
    genres = []
    if 'genres' in item and 'items' in item['genres']:
        genres = [g['name'] for g in item['genres']['items']]

    # Extract location
    location = ''
    if 'location' in item and isinstance(item['location'], dict):
        location = item['location'].get('name', '')

    # Extract show name
    show_name = ''
    show_slug = ''
    if 'show' in item and isinstance(item['show'], dict):
        show_slug = item['show'].get('slug', '')
        show_name = item['show'].get('name', '')

    # Extract artist name from artists array or title
    artist_name = ''
    if 'artists' in item and 'items' in item['artists'] and item['artists']['items']:
        artist_name = item['artists']['items'][0].get('name', '')

    if not artist_name:
        artist_name = extract_artist_name(item.get('title', ''))

    # Construct episode URL
    episode_slug = item.get('slug', '')
    episode_url = construct_episode_url(show_slug, episode_slug) if show_slug and episode_slug else ''

    return {
        'episode_url': episode_url,
        'artist_name': artist_name,
        'date': date_str,
        'genres': genres,
        'location': location,
        'show_name': show_slug,
        'contentful_id': item.get('sys', {}).get('id', ''),
    }


async def fetch_episodes_page(
    client: httpx.AsyncClient,
    next_action_id: str,
    skip: int = 0
) -> tuple[list[dict[str, Any]], int]:
    """
    Fetch a single page of episodes from the API.
    Returns tuple of (episodes, total_count)
    """
    payload = [
        {
            "limit": LIMIT_PER_PAGE,
            "skip": skip,
            "order": "date:desc",
            "filters": "$undefined",
            "staffChoice": "$undefined",
            "since": datetime.now().isoformat(timespec='milliseconds') + 'Z'
        }
    ]

    headers = {
        "Accept": "text/x-component",
        "Content-Type": "text/plain;charset=UTF-8",
        "next-action": next_action_id,
        "User-Agent": USER_AGENT,
    }

    logger.debug(f"Fetching episodes with skip={skip}, next-action={next_action_id}")

    # Retry logic with exponential backoff
    for attempt in range(RETRY_ATTEMPTS):
        try:
            response = await client.post(
                ACTION_URL,
                headers=headers,
                content=json.dumps(payload),
                timeout=30.0
            )
            response.raise_for_status()

            # Parse RSC response
            data = parse_rsc_response(response.text)

            items = data.get('items', [])
            total = data.get('total', 0)

            logger.info(f"Fetched {len(items)} episodes from API (skip={skip}, total={total})")

            # Parse each item into episode object
            episodes = [parse_episode_item(item) for item in items]

            return episodes, total

        except (httpx.HTTPError, json.JSONDecodeError, ValueError) as e:
            if attempt < RETRY_ATTEMPTS - 1:
                wait_time = 2 ** attempt  # Exponential backoff: 1s, 2s, 4s
                logger.warning(
                    f"Attempt {attempt + 1}/{RETRY_ATTEMPTS} failed: {e}. "
                    f"Retrying in {wait_time}s..."
                )
                await asyncio.sleep(wait_time)
            else:
                logger.error(f"Failed to fetch episodes after {RETRY_ATTEMPTS} attempts: {e}")
                raise


async def discover_episodes(output_path: Optional[str] = None) -> list[dict[str, Any]]:
    """
    Main discovery function. Fetches all episodes from the API with pagination.
    Returns a list of discovered episodes (deduplicated by URL).

    Args:
        output_path: Optional custom output path for saving episodes (default: output/episode_urls.json)

    Returns:
        List of episode dictionaries
    """
    if output_path is None:
        output_path = "output/episode_urls.json"

    output_dir = Path(output_path).parent
    output_dir.mkdir(parents=True, exist_ok=True)

    logger.info("Starting episode discovery")

    all_episodes = []
    seen_urls = set()

    async with httpx.AsyncClient() as client:
        # Fetch the next-action ID
        next_action_id = await fetch_next_action_id(client)

        skip = 0
        total = None

        while True:
            # Rate limiting: max 2 requests per second
            await asyncio.sleep(1.0 / MAX_REQUESTS_PER_SECOND)

            try:
                episodes, total = await fetch_episodes_page(client, next_action_id, skip)

                # Deduplicate by URL and add to results
                for episode in episodes:
                    url = episode['episode_url']
                    if url and url not in seen_urls:
                        all_episodes.append(episode)
                        seen_urls.add(url)

                logger.info(f"Discovered {len(all_episodes)}/{total} episodes")

                # Check if we've fetched all episodes
                skip += LIMIT_PER_PAGE
                if skip >= total:
                    break

            except Exception as e:
                logger.error(f"Error during discovery: {e}")
                raise

    # Save results
    logger.info(f"Saving {len(all_episodes)} unique episodes to {output_path}")
    with open(output_path, 'w') as f:
        json.dump(all_episodes, f, indent=2)

    logger.info(f"Discovery complete. Found {len(all_episodes)}/{total} unique episodes")
    print(f"Discovered {len(all_episodes)}/{total} episodes")

    return all_episodes


async def main():
    """CLI entry point."""
    parser = ArgumentParser(
        description="Discover all Lot Radio episodes via Next.js Server Action API"
    )
    parser.add_argument(
        "--output",
        default="output/episode_urls.json",
        help="Output path for discovered episodes (default: output/episode_urls.json)"
    )

    args = parser.parse_args()

    try:
        episodes = await discover_episodes(output_path=args.output)
        logger.info(f"Successfully discovered {len(episodes)} episodes")
        return 0
    except Exception as e:
        logger.error(f"Discovery failed: {e}", exc_info=True)
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
