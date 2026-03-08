#!/usr/bin/env python3
"""
Phase 2: NTS Radio Episode Parser

Fetches episode metadata and tracklist from the NTS public API and converts
to our standard episode schema (matching the Lot Radio format so graph.py
and adjacency.py can be reused).

API endpoints:
    GET /api/v2/shows/{show}/episodes/{ep}          -> metadata
    GET /api/v2/shows/{show}/episodes/{ep}/tracklist -> tracklist
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

NTS_API_BASE = "https://www.nts.live/api/v2"

MAX_RETRIES = 3
RETRY_BACKOFF = 2  # exponential: 1s, 2s, 4s


async def fetch_json(client: httpx.AsyncClient, url: str) -> Optional[Dict]:
    """Fetch a JSON endpoint with retries."""
    for attempt in range(MAX_RETRIES):
        try:
            resp = await client.get(url, timeout=15.0)
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json()
        except (httpx.HTTPStatusError, httpx.RequestError) as e:
            if attempt < MAX_RETRIES - 1:
                wait = RETRY_BACKOFF ** attempt
                logger.debug(f"Retry {attempt+1} for {url}: {e}")
                await asyncio.sleep(wait)
            else:
                logger.warning(f"Failed after {MAX_RETRIES} attempts: {url}: {e}")
                return None


def parse_episode(meta: dict, tracklist_data: Optional[Dict], show_alias: str, episode_alias: str) -> dict:
    """
    Convert NTS API responses into our standard episode schema.

    Args:
        meta: JSON from /api/v2/shows/{show}/episodes/{ep}
        tracklist_data: JSON from .../tracklist endpoint (or None)
        show_alias: e.g. "150session"
        episode_alias: e.g. "150session-17th-january-2026"

    Returns:
        Episode dict matching the Lot Radio schema.
    """
    url = f"https://www.nts.live/shows/{show_alias}/episodes/{episode_alias}"

    # Extract metadata
    artist_name = meta.get("name", "")
    broadcast = meta.get("broadcast", "")
    date = broadcast[:10] if broadcast else None  # "2026-01-17T15:00:00+00:00" -> "2026-01-17"
    genres = [g["value"].strip() for g in meta.get("genres", []) if g.get("value")]
    location = meta.get("location_long", "") or meta.get("location_short", "")
    description = meta.get("description", "")

    # Audio sources & Mixcloud URL
    audio_sources = meta.get("audio_sources", [])
    mixcloud_url = meta.get("mixcloud")

    # Parse tracklist
    tracklist = []
    has_tracklist = False

    if tracklist_data and tracklist_data.get("results"):
        tracks = tracklist_data["results"]
        for i, track in enumerate(tracks):
            artist = (track.get("artist") or "").strip()
            title = (track.get("title") or "").strip()
            if not artist or not title:
                continue

            # Convert offset_estimate (seconds) to HH:MM:SS
            timestamp = None
            offset_secs = None
            offset = track.get("offset") or track.get("offset_estimate")
            if offset is not None:
                try:
                    secs = int(offset)
                    h, m, s = secs // 3600, (secs % 3600) // 60, secs % 60
                    timestamp = f"{h:02d}:{m:02d}:{s:02d}"
                    offset_secs = secs
                except (ValueError, TypeError):
                    pass

            # Estimate duration: gap to next track's offset, or None for last
            duration_secs = None
            if i < len(tracks) - 1:
                next_offset = tracks[i + 1].get("offset") or tracks[i + 1].get("offset_estimate")
                if offset is not None and next_offset is not None:
                    try:
                        duration_secs = int(next_offset) - int(offset)
                        if duration_secs < 0:
                            duration_secs = None
                    except (ValueError, TypeError):
                        pass

            tracklist.append({
                "position": i + 1,
                "title": title,
                "artist": artist,
                "timestamp": timestamp,
                "offset_secs": offset_secs,
                "duration_secs": duration_secs,
            })

        has_tracklist = len(tracklist) >= 1

    return {
        "episode_url": url,
        "source": "nts",
        "artist_name": artist_name,
        "date": date,
        "genres": genres,
        "location": location,
        "description": description,
        "show_name": show_alias,
        "has_tracklist": has_tracklist,
        "tracklist": tracklist,
        "audio_sources": audio_sources,
        "mixcloud_url": mixcloud_url,
    }


async def fetch_and_parse_episode(
    client: httpx.AsyncClient,
    show_alias: str,
    episode_alias: str,
) -> Dict[str, Any]:
    """
    Fetch metadata and tracklist concurrently, return parsed episode.
    """
    meta_url = f"{NTS_API_BASE}/shows/{show_alias}/episodes/{episode_alias}"
    tl_url = f"{meta_url}/tracklist"

    # Fire both requests concurrently
    meta_data, tl_data = await asyncio.gather(
        fetch_json(client, meta_url),
        fetch_json(client, tl_url),
    )

    if meta_data is None:
        # Episode not found or API error
        return {
            "episode_url": f"https://www.nts.live/shows/{show_alias}/episodes/{episode_alias}",
            "source": "nts",
            "artist_name": None,
            "date": None,
            "genres": [],
            "location": None,
            "description": None,
            "show_name": show_alias,
            "has_tracklist": False,
            "tracklist": [],
            "error": "metadata_fetch_failed",
        }

    return parse_episode(meta_data, tl_data, show_alias, episode_alias)
