#!/usr/bin/env python3
"""
Lot Radio scraper — new-site (2026) index API.

The Lot Radio rebuilt on a newer Next.js. The old skip-based Server Action in
discover.py is gone (the action-hash format changed and pagination is now
cursor-based). The rebuilt index paginates via a cursor-based Server Action
that returns FULL episode records — including inline tracklists — so this one
script replaces the old discover.py + parse.py flow for Lot Radio.

Only the `next-action` header is required (the `next-router-state-tree` and
`x-deployment-id` headers the browser sends are optional). The action id
rotates on each site redeploy; if the hardcoded default 404s, the script
auto-discovers the new one by scanning the page's JS chunks and testing
candidates against the API.

To refresh the action id manually: open thelotradio.com/the-index in Chrome,
DevTools -> Network, scroll to trigger a "load more" POST to /the-index, and
copy the `next-action` request header into DEFAULT_ACTION_ID below.

Usage:
    python scrape_index_api.py                 # incremental: fetch new episodes, stop at already-scraped
    python scrape_index_api.py --full          # walk the entire archive (backfill older episodes)
    python scrape_index_api.py --max-pages 2   # test: only fetch N pages
    python scrape_index_api.py --dry-run       # don't write, just report
"""

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx

BASE_URL = "https://www.thelotradio.com"
INDEX_URL = f"{BASE_URL}/the-index"
PAGE_LIMIT = 16
REQUEST_DELAY = 0.5  # seconds between requests (2 req/s, respect the community station)

# Rotates on each site redeploy. If it 404s, the script auto-discovers a new one.
DEFAULT_ACTION_ID = "40218d0ac09e19345f42a0c459a4003aa746ac9477"

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

OUTPUT_DIR = Path("output")
EPISODES_FILE = OUTPUT_DIR / "lot_radio_episodes.json"


def _headers(action_id: str) -> dict[str, str]:
    return {
        "Accept": "text/x-component",
        "Content-Type": "text/plain;charset=UTF-8",
        "next-action": action_id,
        "User-Agent": USER_AGENT,
    }


def _body(cursor: Optional[str]) -> str:
    return json.dumps(
        [{"limit": PAGE_LIMIT, "cursor": cursor, "order": "date:desc",
          "filters": {}, "staffChoice": False}]
    )


def _parse_rsc(text: str) -> Optional[dict]:
    """The action response is RSC flight data; the payload is an object like
    `{"items":[...],"total":N,"pages":{...}}` on a `1:` line. Brace-match with
    raw_decode rather than a line regex, since a track title/description can
    contain a newline that splits the payload across lines. The top-level object
    is distinguished from nested `{"items":[]}` collections by having "total"."""
    dec = json.JSONDecoder()
    idx = text.find('{"items"')
    while idx != -1:
        try:
            obj, _ = dec.raw_decode(text, idx)
            if isinstance(obj, dict) and "items" in obj and "total" in obj:
                return obj
        except json.JSONDecodeError:
            pass
        idx = text.find('{"items"', idx + 1)
    return None


def fetch_page(client: httpx.Client, action_id: str, cursor: Optional[str], retries: int = 4):
    """POST one page. Returns (items, total, next_cursor).

    Retries transient failures (network errors, empty/garbled RSC payloads) with
    backoff so one flaky page doesn't abort a long backfill. A stale action id is
    not transient and raises immediately.
    """
    last_err = None
    for attempt in range(retries):
        try:
            r = client.post(INDEX_URL, headers=_headers(action_id), content=_body(cursor), timeout=30.0)
            if "Server action not found" in r.text:
                raise RuntimeError("stale action id")
            r.raise_for_status()
            data = _parse_rsc(r.text)
            if data is None:
                raise RuntimeError("could not parse RSC payload")
            return data.get("items", []), data.get("total", 0), (data.get("pages") or {}).get("next")
        except RuntimeError as e:
            if "stale action id" in str(e):
                raise
            last_err = e
        except httpx.HTTPError as e:
            last_err = e
        if attempt < retries - 1:
            time.sleep(1.5 * (attempt + 1))
    raise last_err


def discover_action_id(client: httpx.Client) -> Optional[str]:
    """Fallback when the default action id is stale: scan the index page's JS
    chunks for 40-44 hex tokens and test each against the API."""
    html = client.get(INDEX_URL, headers={"User-Agent": USER_AGENT}, timeout=30.0).text
    chunks = re.findall(r"/_next/static/chunks/[^\"]+\.js", html)
    seen, candidates = set(), []
    for c in chunks:
        try:
            js = client.get(BASE_URL + c, headers={"User-Agent": USER_AGENT}, timeout=30.0).text
        except httpx.HTTPError:
            continue
        for tok in re.findall(r"[0-9a-f]{40,44}", js):
            if tok not in seen:
                seen.add(tok)
                candidates.append(tok)
    print(f"  auto-discovery: testing {len(candidates)} action-id candidates...")
    for tok in candidates:
        try:
            items, _, _ = fetch_page(client, tok, None)
            if items:
                print(f"  found working action id: {tok}")
                return tok
        except (httpx.HTTPError, RuntimeError):
            continue
    return None


def _iso(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _offset_hhmmss(track_ts: Optional[str], start: Optional[datetime]) -> Optional[str]:
    t = _iso(track_ts)
    if t is None:
        return None
    if start is None:
        return None
    secs = int((t - start).total_seconds())
    if secs < 0:
        secs = 0
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def item_to_episode(item: dict[str, Any]) -> dict[str, Any]:
    """Map a new-API index item to the existing lot_radio_episodes.json schema."""
    slug = item.get("slug", "")
    show = item.get("show") or {}
    show_slug = show.get("slug") or ""
    # URL matches the old format: /shows/{show}/{slug}. Fall back to slug-as-show
    # for the (rare) newest episodes not yet assigned a show — keeps URL unique.
    url_show = show_slug or slug
    episode_url = f"{BASE_URL}/shows/{url_show}/{slug}" if slug else ""

    genres = [g.get("name") for g in (item.get("genres") or {}).get("items", []) if g.get("name")]
    if not genres:  # fall back to the show's genres
        genres = [g.get("name") for g in (show.get("genres") or {}).get("items", []) if g.get("name")]

    start = _iso(item.get("startTimestamp")) or _iso(item.get("date"))
    tracklist = []
    for i, tr in enumerate(item.get("tracklist") or [], start=1):
        if not isinstance(tr, dict):
            continue
        tracklist.append({
            "position": i,
            "timestamp": _offset_hhmmss(tr.get("timestamp"), start),
            "title": tr.get("title", ""),
            "artist": tr.get("artist", ""),
        })

    date = item.get("date", "")
    return {
        "episode_url": episode_url,
        "artist_name": item.get("title", ""),
        "date": date[:10] if date else "",
        "genres": genres,
        "location": (item.get("location") or {}).get("name", ""),
        "description": show.get("description", "") if isinstance(show, dict) else "",
        "show_name": show_slug,
        "has_tracklist": len(tracklist) > 0,
        "tracklist": tracklist,
    }


def load_existing() -> tuple[list, set]:
    if not EPISODES_FILE.exists():
        return [], set()
    eps = json.load(open(EPISODES_FILE, encoding="utf-8"))
    return eps, {e.get("episode_url", "") for e in eps if e.get("episode_url")}


def _slug(url: str) -> Optional[str]:
    """The date-time slug (e.g. 2026-07-19-1300) uniquely identifies a broadcast,
    even when show slugs differ between the old scraper and the new API."""
    m = re.search(r"/(\d{4}-\d{2}-\d{2}-\d{4})$", url or "")
    return m.group(1) if m else None


def save(episodes: list):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    # Dedup by date-time slug (fall back to URL) so old verbose-show URLs and new
    # canonical-show URLs for the same broadcast don't both survive. Keep the
    # richest record (has tracklist, most tracks, canonical/shorter show slug).
    def score(e):
        # Prefer records that are complete (tracklist, artist, date) so the new
        # API's clean records win over old-scraper records with empty fields.
        return (1 if e.get("has_tracklist") else 0,
                1 if (e.get("artist_name") or "").strip() else 0,
                1 if (e.get("date") or "").strip() else 0,
                len(e.get("tracklist") or []),
                -len(e.get("show_name") or ""))
    best: dict[str, dict] = {}
    for ep in episodes:
        key = _slug(ep.get("episode_url", "")) or ep.get("episode_url", "")
        if not key:
            continue
        if key not in best or score(ep) > score(best[key]):
            best[key] = ep
    with open(EPISODES_FILE, "w", encoding="utf-8") as f:
        json.dump(list(best.values()), f, indent=2, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser(description="Lot Radio new-site index API scraper")
    ap.add_argument("--full", action="store_true", help="Walk the whole archive (backfill), not just new episodes")
    ap.add_argument("--max-pages", type=int, default=None, help="Stop after N pages (testing)")
    ap.add_argument("--dry-run", action="store_true", help="Don't write output")
    args = ap.parse_args()

    existing, existing_urls = load_existing()
    print(f"Existing episodes: {len(existing)}")

    client = httpx.Client(follow_redirects=True)
    action_id = DEFAULT_ACTION_ID

    # Probe the default action id; auto-discover if stale.
    try:
        fetch_page(client, action_id, None)
    except (httpx.HTTPError, RuntimeError) as e:
        print(f"Default action id failed ({e}); auto-discovering...")
        action_id = discover_action_id(client)
        if not action_id:
            print("ERROR: could not find a working action id. Refresh it via the browser "
                  "(DevTools Network -> load-more POST -> next-action header).")
            sys.exit(1)

    new_episodes, cursor, page = [], None, 0
    total = None
    fully_seen_pages = 0
    while True:
        page += 1
        try:
            items, total, cursor = fetch_page(client, action_id, cursor)
        except (httpx.HTTPError, RuntimeError) as e:
            print(f"  page {page} failed: {e} — stopping")
            break
        if not items:
            break

        page_eps = [item_to_episode(it) for it in items]
        page_new = [e for e in page_eps if e["episode_url"] not in existing_urls]
        # --full re-collects every fetched episode so the clean new-API record can
        # replace an old-scraper record for the same broadcast (via slug-dedup in
        # save()). Incremental mode only keeps genuinely new URLs.
        new_episodes.extend(page_eps if args.full else page_new)
        for e in page_new:
            existing_urls.add(e["episode_url"])

        newest, oldest = page_eps[0]["date"], page_eps[-1]["date"]
        print(f"  page {page}: {len(items)} items ({newest}..{oldest}), {len(page_new)} new "
              f"[running collected: {len(new_episodes)}, total archive: {total}]")

        # Incremental mode: stop once we reach already-scraped territory.
        if not args.full:
            if len(page_new) == 0:
                fully_seen_pages += 1
                if fully_seen_pages >= 2:
                    print("  reached already-scraped episodes — stopping (use --full to backfill)")
                    break
            else:
                fully_seen_pages = 0

        if args.max_pages and page >= args.max_pages:
            print(f"  hit --max-pages {args.max_pages}")
            break
        if not cursor:
            print("  no more pages")
            break
        time.sleep(REQUEST_DELAY)

    with_tl = sum(1 for e in new_episodes if e["has_tracklist"])
    print(f"\nNew episodes: {len(new_episodes)} ({with_tl} with tracklists)")

    if args.dry_run:
        print("Dry run — not writing.")
        if new_episodes:
            print("Sample:", json.dumps({k: v for k, v in new_episodes[0].items() if k != "tracklist"}, ensure_ascii=False))
        return

    if new_episodes:
        save(existing + new_episodes)
        saved = json.load(open(EPISODES_FILE, encoding="utf-8"))
        print(f"Saved {len(saved)} episodes to {EPISODES_FILE} (after slug-dedup)")
    else:
        print("Nothing new to save.")


if __name__ == "__main__":
    main()
