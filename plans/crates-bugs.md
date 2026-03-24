# Crates Mode Bug Report

Tested ~30 crates across 2 pages on desktop (1440x900), with hover interaction testing, artwork verification, and automated state checks.

## Bug 1: `.flying-art` DOM leak (race condition)
**Severity: Medium** | `js/app.js:356-435`

When clicking crates in rapid succession (or when automated), the `.flying-art` elements created during the fly-out animation are never removed from `<body>`. They accumulate — after 10 rapid clicks, 90 orphaned elements were found. In single clean clicks the cleanup at line 435 works fine, so this is a race condition when the transition is interrupted mid-flight (e.g., clicking back to Crates before the 800ms timeout fires).

## Bug 2: `.flying-art` elements overlay node cards on first click
**Severity: High** | `js/app.js:355-435`

On the very first crate click after page load, 9 large `.flying-art` divs remain visible at full card size, opacity 1, positioned exactly over the real node cards. They cover the actual cards and intercept clicks. The node cards underneath have `opacity: 0` while the flying-art overlays are fully opaque. Subsequent clicks (after manual cleanup) work correctly. This is a first-click-only initialization bug.

## Bug 3: Stuck hover state after programmatic/interrupted interactions
**Severity: Low** | `js/app.js:561-597`

If a crate click happens while a stack is hovered (e.g., click-through during hover), the `mouseleave` event never fires. This leaves `.hovered` on the stack and `has-hover` on the surface. The `activeIdx` inside the closure also gets stuck, so the wrong card shows as active when returning to Crates.

## Bug 4: One crate with zero artwork ("The Field Is Full Of Stones")
**Severity: Low** | Server-side data issue

"The Field Is Full Of Stones" by Rory Salter (9 tracks) shows all 6 cards as gray placeholders with no artwork. Likely a data issue — the cluster has no artworks in the crates index, or artwork fetch failed for all tracks.

## Bug 5: Duplicate artwork within crate stacks
**Severity: Cosmetic** | `pipeline/build_kv.js:82-103` / `js/app.js:766-770`

The server caps artworks at 4 per crate (`build_kv.js` line 92: `if (artworks.length >= 4) break`), but the frontend renders 6 cards. The card assignment logic (`app.js:769`: `otherArt[i % otherArt.length]`) cycles through the 3 non-top artworks for 5 non-top cards, guaranteeing duplicates.

However, the cap is only part of the problem. Even with cap=6, only 13% of crates (957/7525) have 6+ unique neighbor artworks available — the average is 3.8 regardless of cap. Raising it to 6 costs only +0.2MB but most crates will still duplicate. Better fix: set `numCards = Math.min(6, item.artworks.length)` so each stack only renders as many cards as it has unique artwork.

## Bug 6: Narrow treemap cells have unreadable labels
**Severity: Cosmetic** | Layout / `js/app.js:662-685`

After panning to load a second page, some crates on the edge are very narrow (~60px wide). Labels truncate to "Looks Li" / "The Postn" or are completely invisible. The artwork is also squeezed. The treemap algorithm doesn't enforce a minimum cell width.

## What works well

- **Hover leafing interaction**: Direction-based card cycling works smoothly
- **Label accuracy**: All labels match their seed tracks consistently across all cards
- **Infinite canvas panning**: Dragging to pan works and new page tiles load correctly
- **Crate-to-cluster transition**: Fly-out animation is visually impressive on clean clicks
- **Artwork-to-cluster consistency**: Crate artwork comes from tracks in the cluster (some from hidden "show more" tracks, which is expected)
