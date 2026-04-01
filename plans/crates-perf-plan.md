# Crates Mode Performance Plan: DOM Virtualization + rAF Pan Throttling

> Status: Implemented
> Date: 2026-03-29
> Scope: `js/app.js` only — no new files, no CSS changes, no other JS modules

---

## Problem

Two distinct performance bottlenecks in Crates mode:

1. **DOM accumulation**: `.crate-page` containers (and their stack/card children) are added to `#crates-surface` and never removed. After several pages of panning, thousands of DOM nodes accumulate along with their closure-based event listeners. Interaction slows proportionally.

2. **Synchronous pan writes**: `applyTransform()` writes `style.transform` directly inside `wheel`, `mousemove`, and `touchmove` handlers. These fire at up to 60–1000Hz. With a large DOM, each synchronous style write can force compositor work before the browser is ready to paint.

---

## Architecture Background

Key facts about the current implementation (all in `js/app.js`):

- `#crates-surface` is a single absolutely-positioned div transformed via one `scale3d + translate3d`. All stacks are absolute children.
- Pages are tracked in `pages["col,row"] = { clusters, el, stacks: [{el, item}], artLoaded }`.
- `receivePage()` builds a `.crate-page` container with `.crate-stack` children and appends it to the surface. It is **never removed**.
- Artwork *is* already virtualized: `unloadPageArt()` removes `<img>` tags when a page is >3 viewport-widths away, but the stack/card DOM stays forever.
- `attachHover()` adds 3 closure-based event listeners per stack (mouseenter, mousemove, mouseleave).
- Each desktop page has 20 stacks × up to 8 cards = up to 160 DOM nodes + 60 listeners.
- `applyTransform()` is called synchronously inside `wheel`, `mousemove`, and `touchmove` handlers with no rAF batching.
- The momentum loop (`momentumStep`) already runs inside `requestAnimationFrame` — it is fine as-is.

---

## Part 1: DOM Pruning / Virtualization

### Strategy

Virtualize at the **page level**. Pages are the natural unit: they're already tracked in the `pages` dict, and each page's `stacks` array holds `{ el, item }` where `item` contains everything needed to re-render the stack from scratch.

On **unmount**: remove the `.crate-page` DOM element, null out all `el` references, reset `artLoaded`. Keep `clusters` and the `item` objects in each stacks entry.

On **remount**: call `renderStack()` for each item, re-attach hover listeners, append to surface. `artLoaded` is false, so `loadPageArt()` will fire automatically on the next `updateVisible()` pass.

### Distance Thresholds

```
±1 page  → load art          (existing)
±3 pages → unload art        (existing)
±5 pages → unmount DOM       (new)
```

The 2-page gap between art-unload (3) and DOM-unmount (5) provides hysteresis: a page gets its images stripped a full viewport-width before its DOM is torn down, reducing mount/unmount thrash during casual panning.

At steady state with a desktop viewport, the live DOM is bounded to roughly:
`20 stacks × 8 cards × (11×11 page window) = ~19,360 nodes max`
versus unbounded growth today. In practice the window is typically 3×3 or 4×4, so ~1,440–2,560 nodes in normal use.

### Data Structure Change

**File:** `js/app.js` — `receivePage()` (~line 742)

Add `mounted: true` to the page object at creation time:

```javascript
// Before
const page = { clusters, el: container, stacks, artLoaded: false };

// After
const page = { clusters, el: container, stacks, artLoaded: false, mounted: true };
```

The `stacks` entries already have the shape `{ el, item }`. After unmount, `el` becomes `null`. No other structural changes.

### New Function: `unmountPage(key, page)`

Add near `unloadPageArt` (~line 835):

```javascript
function unmountPage(key, page) {
  if (!page.mounted) return;
  // Don't pull the rug during an active hover — skip this cycle
  if (page.stacks.some(s => s.el && s.el.classList.contains('hovered'))) return;
  page.el.remove();
  page.el = null;
  page.stacks.forEach(s => { s.el = null; });
  page.mounted = false;
  page.artLoaded = false;
}
```

~12 lines.

Note: `page.el.remove()` detaches the entire `.crate-page` subtree in one operation, releasing all child nodes and their listeners from the live DOM. The JS closure objects (from `attachHover`) will be GC'd once the stack elements are no longer reachable.

### New Function: `mountPage(key, page)`

Add near `receivePage` (~line 742):

```javascript
function mountPage(key, page) {
  if (page.mounted) return;
  const [col, row] = key.split(',').map(Number);
  const pageOffsetX = col * vw;
  const pageOffsetY = row * vh;
  const container = document.createElement('div');
  container.className = 'crate-page';
  page.stacks.forEach(stackData => {
    const stackEl = renderStack(stackData.item, pageOffsetX, pageOffsetY);
    if (stackEl) {
      container.appendChild(stackEl);
      stackData.el = stackEl;
      if (!isMobileView()) attachHover(stackEl);
    }
  });
  surface.appendChild(container);
  page.el = container;
  page.mounted = true;
  // artLoaded stays false — loadPageArt fires on next updateVisible pass
}
```

~20 lines.

### Changes to `updateVisible()`

**File:** `js/app.js` — `updateVisible()` (~line 852)

The existing per-page loop currently handles art load/unload. Extend it with mount/unmount:

```javascript
// Existing variables
const colVis0 = Math.floor(viewL / vw);
const colVis1 = Math.floor(viewR / vw);
const rowVis0 = Math.floor(viewT / vh);
const rowVis1 = Math.floor(viewB / vh);

for (const [key, page] of Object.entries(pages)) {
  const [c, r] = key.split(',').map(Number);

  const artNear = c >= colVis0 - 1 && c <= colVis1 + 1
               && r >= rowVis0 - 1 && r <= rowVis1 + 1;
  const domNear = c >= colVis0 - 5 && c <= colVis1 + 5
               && r >= rowVis0 - 5 && r <= rowVis1 + 5;
  const artFar  = c < colVis0 - 3 || c > colVis1 + 3
               || r < rowVis0 - 3 || r > rowVis1 + 3;

  // Mount before art-load so loadPageArt has DOM to work with
  if (!page.mounted && domNear) mountPage(key, page);

  if (artNear) {
    loadPageArt(page);
  } else if (artFar) {
    unloadPageArt(page);
  }

  // Unmount after art-unload (artFar threshold already cleared above)
  if (page.mounted && !domNear) unmountPage(key, page);
}
```

~8 lines added/changed. The ordering (mount → art-load → art-unload → unmount) ensures `loadPageArt` always finds a live DOM.

### Edge Cases

| Scenario | Handling |
|---|---|
| **User clicks a pruned stack** | Not possible. If the DOM is removed, there's no click target. Pages remount as the user pans toward them — the mount threshold (±5 pages) is wide enough that remounting happens well before a stack is reachable by cursor. |
| **Stack is hovered when unmount fires** | `unmountPage` checks `.hovered` on each stack el and returns early if any match. The page stays mounted until mouseleave fires. Next `updateVisible` cycle will retry. |
| **`transitionToTracks(seedKey, el)` animation** | Called on click; el is always live at click time (mounted page). No issue. |
| **Page currently being fetched** | `pendingPageKeys` tracks pre-DOM pages; `pages[key]` doesn't exist yet. Mount/unmount logic only iterates `pages`, so pending pages are unaffected. |
| **Scale change (pinch zoom)** | `vw/vh` are fixed. Zooming out makes more pages visible — `updateVisible()` fires via `scheduleUpdateVisible()` and mounts the newly visible pages. |
| **Art already loaded when page remounts** | `unmountPage` resets `artLoaded = false`. `mountPage` leaves it false. `loadPageArt` runs cleanly on the next `updateVisible` pass. |
| **`isMobileView()` changes between mount/remount** | `mountPage` calls `isMobileView()` at remount time, so hover listeners are correctly attached (desktop) or skipped (mobile) for the current viewport. |
| **Placeholder colors differ on remount** | `renderStack` calls `crateRand()` for placeholder grays. Re-rendering produces different shades. This is visually acceptable since images load quickly over them. If stable colors are required later, store the base gray value on `item` during first render. |
| **`page.stacks` has null els after unmount** | Any code that iterates `page.stacks` and touches `.el` (e.g. `unloadPageArt`) must guard: `if (!s.el) return`. Check `loadPageArt` and `unloadPageArt` for `stackEl.querySelectorAll` calls — these already guard on `page.artLoaded` flag, but add a null-el guard for safety. |

### LOC Estimate

| Change | Lines |
|---|---|
| `unmountPage()` new function | ~12 |
| `mountPage()` new function | ~20 |
| `updateVisible()` additions | ~8 |
| `receivePage()` add `mounted: true` | 1 |
| Null-el guards in `loadPageArt` / `unloadPageArt` | ~4 |
| **Subtotal** | **~45** |

---

## Part 2: rAF-Throttling the Pan Handler

### Strategy

Introduce a single `requestPanFrame()` function that event handlers call instead of `applyTransform()` directly. It schedules one `requestAnimationFrame` per frame (idempotent via a flag), applies the accumulated pan/scale, then calls `applyTransform()` and `scheduleUpdateVisible()` from within that frame callback.

Event handlers write to `targetPanX / targetPanY / targetScale` (pending values). The rAF callback commits them to `panX / panY / crateScale` and applies the transform. Multiple events that arrive between frames all update the pending values; only one rAF fires.

### New Variables and Function

Add near the existing pan state variables (~line 889):

```javascript
// Pending pan targets — written by event handlers, committed in rAF
let targetPanX = 0, targetPanY = 0, targetScale = crateScale;
let rafPanId = null;

function requestPanFrame() {
  if (rafPanId !== null) return;  // Already scheduled this frame
  rafPanId = requestAnimationFrame(() => {
    rafPanId = null;
    panX = targetPanX;
    panY = targetPanY;
    crateScale = targetScale;
    applyTransform();
    scheduleUpdateVisible();
  });
}
```

~15 lines.

`applyTransform()` itself is unchanged — it still reads `panX`, `panY`, `crateScale` and writes `surface.style.transform`. The only change is *when* it gets called.

### Changes to Event Handlers

**Wheel handler** (~line 921):

```javascript
// Before
cratesView.addEventListener('wheel', e => {
  panX -= e.deltaX;
  panY -= e.deltaY;
  applyTransform();
  scheduleUpdateVisible();
}, { passive: true });

// After
cratesView.addEventListener('wheel', e => {
  targetPanX -= e.deltaX;
  targetPanY -= e.deltaY;
  requestPanFrame();
}, { passive: true });
```

**Mousemove drag** (~line 935):

```javascript
// Before
if (didDrag) {
  panX = panStartX + dx;
  panY = panStartY + dy;
  applyTransform();
  scheduleUpdateVisible();
}

// After
if (didDrag) {
  targetPanX = panStartX + dx;
  targetPanY = panStartY + dy;
  requestPanFrame();
}
```

**Touchmove — pinch branch** (~line 975):

```javascript
// Before
crateScale = Math.max(0.2, Math.min(2, pinchStartScale * (dist / lastPinchDist)));
applyTransform();
scheduleUpdateVisible();

// After
targetScale = Math.max(0.2, Math.min(2, pinchStartScale * (dist / lastPinchDist)));
requestPanFrame();
```

**Touchmove — single-finger branch** (~line 990):

```javascript
// Before
panX = touchPanStartX + dx;
panY = touchPanStartY + dy;
applyTransform();
scheduleUpdateVisible();

// After
targetPanX = touchPanStartX + dx;
targetPanY = touchPanStartY + dy;
requestPanFrame();
```

### Momentum Loop — Keep As-Is, Add Target Sync

`momentumStep` is already called from within `requestAnimationFrame`. Having it call `requestPanFrame()` would defer to the *next* frame (double-rAF), adding 1 frame of lag and breaking the velocity decay loop. Keep it calling `applyTransform()` directly. However, it must keep `targetPan*` in sync so that if a wheel or drag event fires during momentum, the targets are accurate:

```javascript
function momentumStep() {
  velX *= 0.92; velY *= 0.92;
  if (Math.abs(velX) < 0.5 && Math.abs(velY) < 0.5) {
    momentumId = null;
    updateVisible();
    return;
  }
  panX += velX; panY += velY;
  targetPanX = panX; targetPanY = panY;  // keep targets in sync
  applyTransform();
  scheduleUpdateVisible();
  momentumId = requestAnimationFrame(momentumStep);
}
```

~2 lines added.

### Sync Targets on Init and Mode Transitions

Wherever `panX`, `panY`, or `crateScale` are assigned directly (mode init, back-navigation reset), also set the corresponding target variable. Search `js/app.js` for `panX =` and `crateScale =` — there are ~3-4 assignment sites. Each needs one line added:

```javascript
panX = 0; panY = 0; crateScale = isMobileView() ? 0.75 : 0.8;
targetPanX = panX; targetPanY = panY; targetScale = crateScale;  // add this line
```

~3-4 lines total.

### Edge Cases

| Scenario | Handling |
|---|---|
| **Multiple wheel events per frame** | All accumulate into `targetPanX/Y`. One rAF fires, applies final position. No position events are dropped — accumulation is identical to the current per-event approach, just batched. |
| **Wheel delta sign / pixelToLine conversion** | Unchanged. `targetPanX -= e.deltaX` has identical math to the current `panX -= e.deltaX`. |
| **Pinch scale + simultaneous pan** | Both `targetScale` and `targetPanX/Y` update; single rAF applies all three atomically, same as current behavior. |
| **`cancelAnimationFrame(momentumId)` in touchstart** | Momentum uses its own `momentumId`; the pan rAF uses `rafPanId`. They don't interfere. |
| **`panX` read in `updateVisible()`** | `updateVisible` is called from within the rAF callback (via `scheduleUpdateVisible`), after `panX = targetPanX` has already committed. Always reads current value. |
| **`panStartX/touchPanStartX` still reference `panX`** | These are captured at dragstart time from the live `panX`. Since `panX` is only committed inside rAF, and drag starts outside rAF, `panX` may lag `targetPanX` by one frame at drag start. Fix: capture `targetPanX` instead of `panX` at mousedown/touchstart. Alternatively, ensure `panX` is synced before capturing — simplest is to set `panX = targetPanX` at the start of each drag. |
| **rAF fires after crates view is hidden** | If the user navigates back to tracks view mid-frame, `rafPanId` may fire once more. `applyTransform` writes to a detached element — harmless but wasteful. Cancel `rafPanId` in the crates teardown/hide code. |

### LOC Estimate

| Change | Lines |
|---|---|
| `targetPanX/Y/Scale` variables + `requestPanFrame()` | ~15 |
| Wheel handler | ~2 delta |
| Mousemove handler | ~2 delta |
| Touchmove handler (both branches) | ~4 delta |
| `momentumStep` target sync | ~2 |
| Init/transition sync sites (~4 locations) | ~4 |
| Teardown: cancel `rafPanId` | ~2 |
| **Subtotal** | **~31** |

---

## Implementation Order

Do these sequentially to keep diffs reviewable:

1. **rAF throttling first** — smaller, self-contained, easy to verify (check for jank/lag in panning before touching DOM structure)
2. **DOM pruning second** — larger change, depends on stable pan behavior

Test after each:
- Pan rapidly for 20+ pages in all directions; confirm no visual lag, correct page loading
- Zoom in/out with pinch; confirm scale applies correctly
- Hover over stacks; confirm card-flip interaction works
- Navigate to tracks and back; confirm crates re-initializes cleanly
- Let inertial momentum run out; confirm final position matches where pan stopped
- Dark mode and light mode (no DOM differences, but sanity check)

---

## Total Estimate

| Part | LOC |
|---|---|
| DOM pruning | ~45 |
| rAF throttling | ~31 |
| **Total** | **~76** |

All changes are in `js/app.js`. No new files. No changes to CSS, HTML, or other JS modules.
