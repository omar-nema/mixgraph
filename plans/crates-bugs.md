# Crates Mode Bug Report

Tested ~30 crates across 2 pages on desktop (1440x900), with hover interaction testing, artwork verification, and automated state checks.

## Bug 1: `.flying-art` DOM leak (race condition)
**Severity: Medium** | **Status: Fixed** | `js/app.js`

Flying-art elements are now properly removed after the morph animation completes.

## Bug 2: `.flying-art` elements overlay node cards on first click
**Severity: High** | **Status: Fixed** | `js/app.js`

Cards are revealed with opacity reset and `fly-hidden` removal before flying-art elements are cleaned up.

## Bug 3: Stuck hover state after programmatic/interrupted interactions
**Severity: Low** | **Status: Fixed** | `js/app.js`

Mouseleave is explicitly dispatched before crate-to-cluster transition, clearing hover state.

## Bug 4: One crate with zero artwork ("The Field Is Full Of Stones")
**Severity: Low** | **Status: Open** | Server-side data issue

"The Field Is Full Of Stones" by Rory Salter (9 tracks) shows all 6 cards as gray placeholders with no artwork. Likely a data issue — the cluster has no artworks in the crates index, or artwork fetch failed for all tracks.

## Bug 5: Duplicate artwork within crate stacks
**Severity: Cosmetic** | **Status: Fixed** | `js/app.js`

`numCards` is now capped to `Math.min(Math.max(item.artworks.length, 1), 8)`, preventing cycling duplicates.

## Bug 6: Narrow treemap cells have unreadable labels
**Severity: Cosmetic** | **Status: Open** | `js/app.js`

After panning to load a second page, some crates on the edge are very narrow (~60px wide). Labels truncate to "Looks Li" / "The Postn" or are completely invisible. The artwork is also squeezed. The treemap algorithm doesn't enforce a minimum cell width — the only guard is `renderStack` skipping cells under 20px, but no minimum is enforced during layout.

## What works well

- **Hover leafing interaction**: Direction-based card cycling works smoothly
- **Label accuracy**: All labels match their seed tracks consistently across all cards
- **Infinite canvas panning**: Dragging to pan works and new page tiles load correctly
- **Crate-to-cluster transition**: Fly-out animation is visually impressive on clean clicks
- **Artwork-to-cluster consistency**: Crate artwork comes from tracks in the cluster (some from hidden "show more" tracks, which is expected)
