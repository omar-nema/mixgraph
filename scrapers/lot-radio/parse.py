"""
Phase 2: Lot Radio Episode Page Parser

Parses individual episode pages. Metadata (artist name, description, location)
is extracted from the rendered HTML via BeautifulSoup. Tracklist data is extracted
from the embedded RSC (React Server Components) JSON stream — the tracks are NOT
in the rendered DOM, they're serialized as escaped JSON within inline <script> tags.
"""

import asyncio
import json
import logging
import re
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# User-Agent for requests
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# Retry configuration
MAX_RETRIES = 3
RETRY_BACKOFF_FACTOR = 2  # exponential backoff: 1s, 2s, 4s


def normalize_date(date_str: str) -> Optional[str]:
    """
    Convert MM.DD.YYYY format to YYYY-MM-DD format.

    Args:
        date_str: Date string in MM.DD.YYYY format

    Returns:
        Date string in YYYY-MM-DD format, or None if parsing fails
    """
    if not date_str:
        return None

    try:
        # Remove any whitespace
        date_str = date_str.strip()
        # Parse MM.DD.YYYY
        parsed_date = datetime.strptime(date_str, "%m.%d.%Y")
        # Return as YYYY-MM-DD
        return parsed_date.strftime("%Y-%m-%d")
    except ValueError as e:
        logger.warning(f"Failed to parse date '{date_str}': {e}")
        return None


def extract_show_name(episode_url: str) -> Optional[str]:
    """
    Extract show_name from URL path: /shows/{show_name}/{slug} → show_name

    Args:
        episode_url: Full episode URL

    Returns:
        show_name or None if extraction fails
    """
    try:
        path = urlparse(episode_url).path
        # Expected format: /shows/{show_name}/{date-time}
        parts = path.strip("/").split("/")
        if len(parts) >= 3 and parts[0] == "shows":
            return parts[1]
    except Exception as e:
        logger.warning(f"Failed to extract show_name from {episode_url}: {e}")

    return None


def parse_date_from_html(text: str) -> Optional[str]:
    """
    Extract date matching pattern MM.DD.YYYY from text.

    Args:
        text: Text content to search

    Returns:
        Date in YYYY-MM-DD format, or None if not found
    """
    if not text:
        return None

    # Look for MM.DD.YYYY pattern
    match = re.search(r"\b(\d{2})\.(\d{2})\.(\d{4})\b", text)
    if match:
        date_str = f"{match.group(1)}.{match.group(2)}.{match.group(3)}"
        return normalize_date(date_str)

    return None


def parse_genres_from_html(soup: BeautifulSoup) -> List[str]:
    """
    Extract genres from page content.

    Genres appear as comma-separated tags in the page text (e.g., "ELECTRONICA,\nHOUSE,\nCLOUD RAP")

    Args:
        soup: BeautifulSoup object

    Returns:
        List of genre strings, capitalized properly
    """
    try:
        # Get all text from the page
        text = soup.get_text()

        # Look for pattern of uppercase words separated by commas and/or newlines
        # Common pattern: "GENRE1,\nGENRE2,\nGENRE3"
        genre_pattern = r"([A-Z][A-Z\s]+?)(?:,\s*|\n)([A-Z][A-Z\s]+?)(?:,\s*|\n)([A-Z][A-Z\s]+?)(?:[,\n]|$)"

        # First, let's try to find any sequence of uppercase comma-separated words
        # Look in the header area near artist name
        header_area = soup.find_all(["h1", "h2", "h3", "div"], limit=20)

        NON_GENRE_TERMS = {
            "NYC", "USA", "THE LOT RADIO", "SUBSCRIBE", "LOGIN", "REGISTER",
            "LIVE", "INDEX", "SHOWS", "ARTISTS", "CALENDAR", "EVENTS", "ABOUT",
            "DJ", "MC", "B2B",
        }

        for element in header_area:
            elem_text = element.get_text()
            # Look for comma-separated genres
            if "," in elem_text:
                # Check if this looks like genres (multiple commas, uppercase words)
                potential_genres = re.findall(r"([A-Z][A-Z\s]*?)(?:,|\n)", elem_text)
                if len(potential_genres) >= 2:
                    genres = [
                        g.strip().title()
                        for g in potential_genres
                        if g.strip() and len(g.strip()) > 1 and g.strip().upper() not in NON_GENRE_TERMS
                    ]
                    if genres:
                        return genres

        # Fallback: look for genre-like patterns throughout the page
        # Pattern: uppercase word/phrase followed by comma
        # Exclude common non-genre terms
        NON_GENRE_TERMS = {
            "NYC", "USA", "THE LOT RADIO", "SUBSCRIBE", "LOGIN", "REGISTER",
            "LIVE", "INDEX", "SHOWS", "ARTISTS", "CALENDAR", "EVENTS", "ABOUT",
        }
        matches = re.findall(r"([A-Z][A-Z\s]*?)(?:,|\n)", text)
        if matches:
            genres = [
                m.strip().title()
                for m in matches[:5]  # Limit to first 5 potential genres
                if m.strip() and len(m.strip()) > 2 and m.strip().upper() not in NON_GENRE_TERMS
            ]
            if genres:
                return genres

    except Exception as e:
        logger.warning(f"Failed to parse genres: {e}")

    return []


def ms_to_timestamp(ms: int) -> str:
    """
    Convert milliseconds to HH:MM:SS timestamp string.

    Args:
        ms: Timestamp in milliseconds

    Returns:
        Formatted timestamp string (e.g., "00:02:01")
    """
    total_secs = ms // 1000
    h = total_secs // 3600
    m = (total_secs % 3600) // 60
    s = total_secs % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def parse_tracklist(html: str) -> tuple[bool, List[Dict[str, Any]]]:
    """
    Extract tracklist from embedded RSC (React Server Components) JSON data.

    The Lot Radio uses Next.js App Router with RSC. Tracklist data is NOT in
    rendered HTML elements — it's embedded as escaped JSON in the RSC flight
    data stream within inline <script> tags. The format looks like:

        \\"tracks\\":[{\\"name\\":\\"Track Title\\",\\"artist\\":\\"Artist Name\\",\\"timestamp\\":121490}]

    Where timestamp is in milliseconds.

    Args:
        html: Raw HTML string of the episode page

    Returns:
        Tuple of (has_tracklist: bool, tracklist: List[Dict])
    """
    tracklist = []

    try:
        # Search for the escaped JSON pattern: \"tracks\":[...]
        # In the raw HTML, this appears as literal backslash + quote characters
        keyword = "tracks"
        search_from = 0

        while True:
            idx = html.find(keyword, search_from)
            if idx == -1:
                break

            # Verify this is the right pattern: preceded by \" and followed by \":[
            # In the raw HTML: ...\"tracks\":[...
            # That means: char at idx-1 is '"', char at idx-2 is '\'
            # And: char at idx+6 is '\', char at idx+7 is '"', char at idx+8 is ':'
            if (
                idx >= 2
                and html[idx - 1] == '"'
                and html[idx - 2] == "\\"
                and idx + 8 < len(html)
                and html[idx + 6] == "\\"
                and html[idx + 7] == '"'
                and html[idx + 8] == ":"
            ):
                # Find the opening bracket of the array
                bracket_start = html.find("[", idx)
                if bracket_start == -1 or bracket_start - idx > 15:
                    search_from = idx + 1
                    continue

                # Find the matching closing bracket using depth tracking
                depth = 0
                end = bracket_start
                for i in range(bracket_start, min(bracket_start + 50000, len(html))):
                    if html[i] == "[":
                        depth += 1
                    elif html[i] == "]":
                        depth -= 1
                    if depth == 0:
                        end = i + 1
                        break

                # Extract and clean the JSON array
                raw_array = html[bracket_start:end]
                # Unescape the JSON: \" -> " and \' -> '
                cleaned = raw_array.replace('\\"', '"').replace("\\'", "'")

                try:
                    parsed = json.loads(cleaned)
                    if (
                        isinstance(parsed, list)
                        and len(parsed) > 0
                        and isinstance(parsed[0], dict)
                        and "name" in parsed[0]
                    ):
                        # Successfully found tracks
                        for i, track in enumerate(parsed):
                            timestamp = None
                            if track.get("timestamp") is not None:
                                timestamp = ms_to_timestamp(int(track["timestamp"]))

                            tracklist.append({
                                "position": i + 1,
                                "timestamp": timestamp,
                                "title": track.get("name", ""),
                                "artist": track.get("artist") or None,
                            })

                        if tracklist:
                            logger.info(f"Successfully parsed {len(tracklist)} tracks from RSC data")
                            return True, tracklist

                except (json.JSONDecodeError, ValueError):
                    # Not valid JSON, keep searching
                    pass

            search_from = idx + 1

        logger.debug("No tracklist found in RSC data")
        return False, []

    except Exception as e:
        logger.error(f"Error parsing tracklist from RSC data: {e}")
        return False, []


def parse_artist_name(soup: BeautifulSoup) -> Optional[str]:
    """
    Extract artist name (second h1 with specific classes).

    Args:
        soup: BeautifulSoup object

    Returns:
        Artist name or None
    """
    try:
        h1_tags = soup.find_all("h1")
        if len(h1_tags) < 2:
            logger.warning(f"Expected at least 2 h1 tags, found {len(h1_tags)}")
            if h1_tags:
                return h1_tags[0].get_text(strip=True) or None
            return None

        # Get the second h1
        artist_h1 = h1_tags[1]
        artist_name = artist_h1.get_text(strip=True)
        return artist_name if artist_name else None

    except Exception as e:
        logger.warning(f"Failed to parse artist name: {e}")
        return None


def parse_description(soup: BeautifulSoup) -> Optional[str]:
    """
    Extract description after <h3 class="opacity-50">The session</h3>.

    Args:
        soup: BeautifulSoup object

    Returns:
        Description text or None
    """
    try:
        # Find h3 with "The session"
        for h3 in soup.find_all("h3"):
            if h3.get_text(strip=True).lower() == "the session":
                # Get the next sibling div with rich text classes
                parent = h3.find_parent()
                if not parent:
                    continue

                # Look for next siblings that might contain description
                for sibling in parent.find_all():
                    sibling_text = sibling.get_text(strip=True)
                    if sibling_text and sibling_text != "The session":
                        # Check if this looks like a description (not just metadata)
                        if len(sibling_text) > 20 and "opacity-50" not in sibling.get("class", []):
                            return sibling_text

                # Alternative: get text content after h3
                h3_parent = h3.find_parent()
                if h3_parent:
                    all_text = h3_parent.get_text(strip=True)
                    # Extract text after "The session"
                    idx = all_text.find("The session")
                    if idx != -1:
                        desc = all_text[idx + len("The session"):].strip()
                        if desc and len(desc) > 10:
                            return desc

    except Exception as e:
        logger.warning(f"Failed to parse description: {e}")

    return None


def parse_location(soup: BeautifulSoup) -> Optional[str]:
    """
    Extract location information (e.g., "The Lot Radio, NYC").

    Args:
        soup: BeautifulSoup object

    Returns:
        Location string or None
    """
    try:
        # Look for location patterns in page text
        text = soup.get_text()

        # Look for exact "The Lot Radio, NYC" pattern first
        if "The Lot Radio, NYC" in text:
            return "The Lot Radio, NYC"

        # Common pattern: "The Lot Radio, CITY"
        location_pattern = r"The Lot Radio,\s*(\w[\w\s]*)"
        match = re.search(location_pattern, text)
        if match:
            city = match.group(1).strip()
            if city and city.upper() not in {"DJ", "MC", "THE", "AND"}:
                return f"The Lot Radio, {city}"

        # Look for "NYC" or other location markers
        if "NYC" in text:
            return "The Lot Radio, NYC"

    except Exception as e:
        logger.warning(f"Failed to parse location: {e}")

    return None


def parse_episode(
    html: str,
    episode_url: str,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Parse episode data from HTML content.

    Args:
        html: Raw HTML string
        episode_url: The episode URL
        metadata: Optional pre-fetched metadata (genres, location, date, etc.) as fallback

    Returns:
        Dictionary containing parsed episode data
    """
    metadata = metadata or {}

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception as e:
        logger.error(f"Failed to parse HTML: {e}")
        return {
            "episode_url": episode_url,
            "artist_name": None,
            "date": None,
            "genres": [],
            "location": None,
            "description": None,
            "show_name": extract_show_name(episode_url),
            "has_tracklist": False,
            "tracklist": [],
            "error": str(e)
        }

    # Extract show_name
    show_name = extract_show_name(episode_url)

    # Extract artist name
    artist_name = parse_artist_name(soup)

    # Extract date (from HTML, prefer metadata)
    date = metadata.get("date")
    if not date:
        date = parse_date_from_html(soup.get_text())

    # Extract genres (from HTML, prefer metadata)
    genres = metadata.get("genres", [])
    if not genres:
        genres = parse_genres_from_html(soup)

    # Extract location (from HTML, prefer metadata)
    location = metadata.get("location")
    if not location:
        location = parse_location(soup)

    # Extract description
    description = parse_description(soup)

    # Extract tracklist from raw HTML (RSC JSON), not from parsed DOM
    has_tracklist, tracklist = parse_tracklist(html)

    return {
        "episode_url": episode_url,
        "artist_name": artist_name,
        "date": date,
        "genres": genres,
        "location": location,
        "description": description,
        "show_name": show_name,
        "has_tracklist": has_tracklist,
        "tracklist": tracklist
    }


async def fetch_and_parse_episode(
    client: httpx.AsyncClient,
    episode_url: str,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Fetch episode HTML and parse it.

    Args:
        client: httpx AsyncClient
        episode_url: The episode URL to fetch
        metadata: Optional pre-fetched metadata as fallback

    Returns:
        Dictionary containing parsed episode data
    """
    metadata = metadata or {}

    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1"
    }

    for attempt in range(MAX_RETRIES):
        try:
            logger.info(f"Fetching {episode_url} (attempt {attempt + 1}/{MAX_RETRIES})")

            response = await client.get(
                episode_url,
                headers=headers,
                timeout=30.0,
                follow_redirects=True
            )

            response.raise_for_status()

            logger.info(f"Successfully fetched {episode_url}")

            # Parse the HTML
            result = parse_episode(response.text, episode_url, metadata)
            result["status"] = "success"
            return result

        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error {e.response.status_code} for {episode_url}: {e}")
            if attempt == MAX_RETRIES - 1:
                return {
                    "episode_url": episode_url,
                    "artist_name": None,
                    "date": None,
                    "genres": [],
                    "location": None,
                    "description": None,
                    "show_name": extract_show_name(episode_url),
                    "has_tracklist": False,
                    "tracklist": [],
                    "status": "failed",
                    "error": f"HTTP {e.response.status_code}"
                }

        except httpx.RequestError as e:
            logger.warning(f"Request error for {episode_url} (attempt {attempt + 1}): {e}")
            if attempt < MAX_RETRIES - 1:
                wait_time = (RETRY_BACKOFF_FACTOR ** attempt)
                logger.info(f"Retrying in {wait_time}s...")
                await asyncio.sleep(wait_time)
            else:
                return {
                    "episode_url": episode_url,
                    "artist_name": None,
                    "date": None,
                    "genres": [],
                    "location": None,
                    "description": None,
                    "show_name": extract_show_name(episode_url),
                    "has_tracklist": False,
                    "tracklist": [],
                    "status": "failed",
                    "error": str(e)
                }

        except Exception as e:
            logger.error(f"Unexpected error for {episode_url}: {e}")
            if attempt == MAX_RETRIES - 1:
                return {
                    "episode_url": episode_url,
                    "artist_name": None,
                    "date": None,
                    "genres": [],
                    "location": None,
                    "description": None,
                    "show_name": extract_show_name(episode_url),
                    "has_tracklist": False,
                    "tracklist": [],
                    "status": "failed",
                    "error": str(e)
                }


async def main():
    """Main function for standalone testing."""
    if len(sys.argv) < 2:
        print("Usage: python parse.py <episode_url> [--html-file <path>]")
        print("Example: python parse.py https://www.thelotradio.com/shows/special-guests/2026-01-11-1200")
        sys.exit(1)

    episode_url = sys.argv[1]
    html_file = None

    # Check for --html-file argument
    if "--html-file" in sys.argv:
        idx = sys.argv.index("--html-file")
        if idx + 1 < len(sys.argv):
            html_file = sys.argv[idx + 1]

    # If HTML file provided, read from file
    if html_file:
        try:
            with open(html_file, "r", encoding="utf-8") as f:
                html_content = f.read()
            logger.info(f"Loaded HTML from {html_file}")
            result = parse_episode(html_content, episode_url)
            print("\n=== PARSE RESULT ===")
            import json
            print(json.dumps(result, indent=2))
        except FileNotFoundError:
            logger.error(f"HTML file not found: {html_file}")
            sys.exit(1)
        except Exception as e:
            logger.error(f"Error reading HTML file: {e}")
            sys.exit(1)
    else:
        # Fetch from URL
        async with httpx.AsyncClient() as client:
            result = await fetch_and_parse_episode(client, episode_url)
            print("\n=== FETCH AND PARSE RESULT ===")
            import json
            print(json.dumps(result, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
