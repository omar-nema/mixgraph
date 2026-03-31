# Crates Mode: WebGL Migration Assessment

> Written: 2026-03-30
> Status: Analysis only — no implementation

---

## Background

Crates mode renders a virtualized infinite canvas of stacked album-art cards. The current implementation is DOM-based: CSS `transform: scale3d() translate3d()` moves the surface, and each crate stack is a small pile of `<div>` elements with `<img>` tags. The crates-worker generates pages off the main thread, DOM pruning keeps the live element count bounded, and requestAnimationFrame throttles pan updates.

The question is whether migrating the canvas to WebGL would materially improve performance, and how hard it would be.

---

## 1. What Needs to Be Replicated in WebGL

### 1a. Crate Stack Rendering

Each crate is a stack of up to 8 cards. Each card is a rectangle with:
- A background placeholder color (grayscale, derived from a hash)
- An image texture once art loads (120×120px from SoundCloud CDN, downsampled from `-t500x500`)
- An info overlay (artist/title text) that fades in on hover for the active card
- A box shadow and 2px border-radius
- Stagger offset: each card is `STEP` (3px) offset right+down from the one below it
- Shimmer animation during loading state

The top card (`active`) gets an elevated box shadow and its info overlay becomes visible.

This is basically "draw N rectangles per crate, with texture + drop shadow + rounded corners + overlay text". In WebGL:
- Rounded corners require either SDF-based fragment shaders or geometry tessellation
- Box shadows require either pre-rendered blur passes or pre-baked shadow textures
- The shimmer loading animation is a fragment shader gradient sweep (easy)

### 1b. Card-Fan Hover Animation

On desktop hover, cursor movement cycles through the card stack — each card can become `active`, raising its z-index and showing the info overlay. The transition is CSS (`transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1)`).

In WebGL, this means:
- Tracking which card is "active" per hovered crate (same state as today)
- Animating z-order (draw order) and a slight vertical lift transform per card
- Fading in/out the text overlay on the active card
- The cubic-bezier easing would need to be re-implemented in JS (interpolate toward target position each frame)

The hover card-fan is purely cosmetic and doesn't interact with layout math. It's self-contained per crate.

### 1c. Click → Transition to Tracks View

This is the most complex animation in the entire app. It's a multi-phase morph:

1. Fade out non-clicked crates (`opacity: 0` via CSS class)
2. Capture the crate's screen position via `getBoundingClientRect()`
3. Show the tracks view off-screen
4. Create "flying art" `<div>` elements (one per node in the cluster), positioned at the crate center
5. On next rAF, animate each flyer to its target card position in the tracks view
6. After 800ms, remove flyers and reveal the actual track cards
7. Stagger text and connection SVG paths in afterward

Steps 1–3 and 5–7 involve the tracks view (DOM-based, not crates). Only step 1 directly touches the crates canvas. In a WebGL world:
- Step 1 would fade the entire canvas to opacity 0 (one uniform update, trivial)
- Steps 4–7 would still use DOM elements for the flyers — they escape the crates canvas and overlay the tracks view

The morph animation itself can remain DOM-based. The crates canvas just needs to fade out.

### 1d. Pan and Zoom

The math is already clean: `targetPanX/Y`, `targetScale`, lerp on rAF, clamp scale to [0.2, 2.0]. In WebGL this becomes a 2D orthographic camera matrix — simpler than the CSS `transform-origin: 0 0` + `scale3d + translate3d` chain. The hit-testing math (converting screen coordinates to canvas coordinates) is `canvasX = (screenX / scale) - panX` — same formula, no CSS quirks.

Pan and zoom is actually *easier* to reason about in WebGL than in CSS transforms.

### 1e. Image / Texture Loading from SoundCloud CDN

Current flow:
1. `loadPageArt(page)` — create `<img>` elements, set src to CDN URL (120×120px)
2. Wait for all images in the stack to load (coordinated by a `pending` counter)
3. On complete, remove placeholder styling and reveal the stack

In WebGL:
1. Fetch image via `new Image()` (same as today)
2. On load: `gl.texImage2D(...)` to upload to GPU
3. Track texture handle per crate card
4. Unloading = `gl.deleteTexture(handle)`

The existing batch-reveal logic ("wait for all N to load before showing stack") carries over unchanged — it's still JS-level bookkeeping. GPU texture uploads are synchronous within a frame, so no additional coordination needed.

One important difference: WebGL textures must be power-of-two if you want mipmapping (though NPOT textures work fine without it). SoundCloud CDN returns arbitrary sizes; disabling mipmapping (`gl.NEAREST` or `gl.LINEAR` without mips) is fine at this scale.

### 1f. Text Labels (Artist / Title)

Text is the most painful part of a WebGL migration. There is no built-in text in WebGL. Options:

**Option A — Canvas2D texture atlases**
Render text into a `<canvas>`, upload as texture. Works, but means managing a dynamic texture atlas that gets invalidated when text changes, theme changes (dark/light mode), or font loads. Every unique label needs a slot in the atlas.

**Option B — DOM overlay (keep labels as HTML)**
The info overlay (`.crate-info` with `.ci-title` + `.ci-artist`) stays as HTML positioned over the WebGL canvas. The WebGL layer renders artwork rectangles; the DOM layer renders text at matching screen coordinates. This is the PixiJS recommended approach for rich text.

**Option C — MSDF (signed-distance-field) fonts**
Offline-generate an MSDF atlas from Space Grotesk, render glyphs in a fragment shader. Crisp at any scale, but requires a build step, font license check, and ~500 lines of glyph layout code.

Option B is by far the simplest and is used in production WebGL apps constantly. The text visibility logic (`opacity: 0` → `opacity: 1` on `.active`) is exactly the kind of thing DOM CSS transitions handle effortlessly.

### 1g. Glow and Gradient Artwork for Tracks Without Cover Art

`js/data.js` has 12 gradient palettes, each used to generate 5 layered radial gradients using a hash of the track key. Currently drawn via CSS `background` on the placeholder `<div>`.

In WebGL: implement as a fragment shader that takes (palette index, hash seed) as uniforms and procedurally reconstructs the gradient. The math is deterministic so the shader output is identical to the CSS result. This is actually cleaner in WebGL — no DOM, no CSS background, just a shader.

Alternatively, pre-render each gradient to a `<canvas>` and upload as a texture. This avoids shader complexity at the cost of one texture per unique gradient (bounded by the number of visible crates, maybe 50–100 at once).

### 1h. Light/Dark Mode Theming

Currently, dark mode is `body.night` CSS class overriding custom properties. Affected elements in crates:
- `.crate-info` background: `rgba(42, 37, 32, 0.55)` — hardcoded in CSS, not a variable
- Placeholder color: grayscale computed in JS (`148 ± 20`)
- Backdrop blur on info overlay

In WebGL: theme = a set of uniform colors passed to shaders. Toggle dark/light = update uniforms. This is simpler than CSS cascade, but requires explicitly wiring every theme-sensitive color as a uniform rather than inheriting via CSS variables.

### 1i. Mobile Touch Interactions

Touch is already handled in JS (not CSS). The same `touchstart/touchmove/touchend` handlers, pinch-to-zoom math, and momentum decay (`vel *= 0.92`) work identically against a WebGL canvas. Canvas pointer events work the same as DOM pointer events.

The only difference: there's no `cursor: grab` / `cursor: grabbing` on a `<canvas>` — that needs to be set on the container `<div>` wrapping the canvas, which is a two-line change.

---

## 2. WebGL Approach

### Raw WebGL vs PixiJS vs Three.js

**Raw WebGL** — Full control, zero overhead. For a 2D scene of textured quads with simple shaders, the boilerplate is maybe 300 lines (vertex/fragment shader pair, VBO, texture management, draw loop). No dependency. Best performance ceiling. Highest development cost.

**PixiJS** — Purpose-built 2D WebGL renderer. Handles texture atlases, sprite batching, text (via BitmapText or HTMLText), and has a 2D container/DisplayObject tree that maps cleanly to the current crate/card hierarchy. Already available via CDN. The PixiJS `Container` → `Sprite` hierarchy mirrors `.crate-surface` → `.crate-stack` → `.crate-card`. Built-in `InteractionManager` handles hit testing. The main concern is bundle size (~1MB minified for v7; v8 is lighter). **This is the pragmatic choice.**

**Three.js** — Overkill for a 2D use case. Three.js adds a scene graph, 3D camera, material system, lights, and geometry primitives optimized for 3D rendering. You'd spend half the migration configuring an orthographic camera and suppressing 3D features. Avoid.

**Recommendation: PixiJS if using a library; raw WebGL if keeping zero dependencies.**

For this project's "no build tools, no package.json" philosophy, raw WebGL or PixiJS via CDN are both feasible. PixiJS saves ~2–3 weeks of work on text, hit testing, and texture management.

### Text Rendering

Use DOM overlay (Option B above). Keep `.crate-info` divs as HTML absolutely positioned over the canvas. The WebGL layer renders artwork; the DOM layer renders text at matching screen positions. The position sync is: `screenX = (canvasX + panX) * scale`, `screenY = (canvasY + panY) * scale` — a trivial transform.

This also means backdrop-filter blur on the info overlay stays free via CSS.

### Texture Atlas vs Individual Textures

**Individual textures** — One `gl.createTexture()` per image. Simple. For 500+ thumbnails loaded across an infinite canvas, only ~50–200 are visible at once (due to DOM pruning). At 120×120px RGBA = 57KB GPU RAM per texture. 200 textures = ~11MB GPU RAM. Perfectly acceptable.

**Texture atlas** — Pack multiple images into one large texture, use UV offsets to address each. Reduces draw calls (batch all visible cards into one draw call per atlas). More complex: requires a bin-packing algorithm, atlas invalidation on load/unload. Payoff is only meaningful if draw call count is the bottleneck.

**Recommendation: Individual textures.** The current virtualization system (page-based loading/unloading) already keeps texture count bounded. If profiling later reveals draw call overhead, an atlas can be retrofitted.

### Hit Testing

Currently: CSS handles z-stacking within each crate; the `click` event bubbles up through the card → stack → surface. In WebGL, there's no automatic event routing through rendered quads.

Options:
1. **CPU bounding-box test** — On click, invert the pan/zoom transform to get canvas coordinates, then iterate visible crates and check `rect.contains(point)`. For ~50–200 visible crates this is O(n) with n small, fast enough.
2. **GPU color picking** — Render each crate with a unique color ID to an offscreen framebuffer, read the pixel under the cursor. More accurate for overlapping geometry, adds one extra render pass per hover/click.
3. **DOM hit-testing overlay** — Invisible `<div>` positioned over each crate (sized and positioned to match the WebGL quad). Click/hover events route through the DOM. Simple to implement, but adds N DOM elements per page.

**Recommendation: CPU bounding-box test** for clicks (already have the rect data), and DOM overlay divs for hover (needed anyway if keeping text as DOM).

---

## 3. What Can Stay as DOM Overlays

These don't need to move to WebGL at all:

| Element | Why it stays DOM |
|---|---|
| Filters/search UI (`#dev-panel`, genre pills, artist search) | Completely separate from the canvas; no spatial relationship |
| Helper toasts (`#crates-helper-toast`) | Appear once, dismissable, no animation coupling |
| SoundCloud/Mixcloud player widget | Third-party iframe, cannot be WebGL |
| Mode tabs (Crates / Tracks) | Pure nav UI |
| Flying art elements (during crates→tracks transition) | Already `<div>` elements appended to `<body>`; escape the canvas |
| `.crate-info` text overlays | Keep as DOM (see text rendering above) |
| Loading spinner on crate during cluster fetch | Can be DOM overlay positioned over the clicked crate |

The architecture would be:
```
#crates-view (position: relative, overflow: hidden)
  <canvas id="crates-canvas"> ← WebGL renders here
  <div id="crates-labels">   ← Text overlays, synchronized to canvas coords
  (existing filters/toasts above in normal DOM flow)
```

---

## 4. Migration Complexity Estimate

### Lines of Code

| Component | Current DOM LOC | WebGL LOC | Notes |
|---|---|---|---|
| Surface transform / pan / zoom | ~120 | ~80 | Simpler matrix math, less CSS juggling |
| Stack & card rendering | ~200 | ~350 | More explicit geometry management |
| Texture loading + management | ~100 | ~180 | `gl.texImage2D`, handle lifecycle |
| Hover / card-fan animation | ~120 | ~150 | Same state machine, manual easing |
| Hit testing | 0 (CSS) | ~60 | CPU bounding box |
| Text overlay sync | 0 (in-flow) | ~80 | DOM divs synced to canvas coords |
| Gradient/glow shader | 0 (CSS) | ~100 | Fragment shader or pre-render |
| Placeholder shimmer shader | 0 (CSS) | ~60 | Fragment shader gradient sweep |
| Shadow / rounded corners | 0 (CSS) | ~80–200 | SDF shader or accept sharp corners |
| Momentum / touch | ~100 | ~100 | No change |
| Page virtualization | ~200 | ~200 | Page data management unchanged |
| Crates→tracks transition | ~250 | ~250 | Mostly unchanged; canvas fades out |
| **Total** | **~1,100** | **~1,600–1,700** | ~50% more code |

Raw WebGL adds roughly 500 LOC. PixiJS would reduce the geometry/texture/shader sections by ~200 LOC but add a library dependency.

### Risk Areas

**High risk:**

1. **Rounded corners + box shadows** — CSS gives these for free. In raw WebGL, box shadows require a multi-pass blur or pre-baked textures. SDF rounded corners add a non-trivial fragment shader. PixiJS has a `Graphics` primitive for rounded rects but no built-in box shadow. If you accept sharp corners and flat card styling (no shadow), this disappears. Otherwise it's the biggest visual fidelity risk.

2. **Crates→tracks transition** — The flying-art morph reads `getBoundingClientRect()` on the clicked crate stack to get screen coordinates. In WebGL, there's no `getBoundingClientRect()` — you compute the screen rect manually from canvas coordinates + pan/zoom. This is doable but needs careful coordinate-space tracking. If the math is off by even 1px, the animation looks wrong.

3. **`backdrop-filter: blur(10px)` on info overlay** — This CSS property blurs whatever is behind the element, including the WebGL canvas contents. `backdrop-filter` does work on elements overlaid on canvas, but behavior varies across browsers and can be expensive. Test early.

4. **Dark/light mode color sync** — Currently the CSS cascade handles everything. In WebGL, every theme-sensitive color must be explicitly re-wired as a uniform when the theme toggles. Easy to miss one.

**Medium risk:**

5. **Pinch-to-zoom on mobile** — Identical math, but canvas touch events may need `touch-action: none` on the container. Currently this is in `mobile.css`; it needs to move to the canvas container element. Minor, but mobile input bugs are hard to catch in dev.

6. **Text overlay sync** — Keeping DOM labels synchronized to WebGL coordinates during pan/zoom animations requires running a sync step every rAF frame. At 60fps this is fine, but any drift (e.g., label position updates lagging one frame behind canvas) causes visible jitter.

7. **GPU memory on low-end mobile** — Individual textures for 200 visible crates at 120×120px RGBA = ~11MB GPU RAM. Fine on most devices. The existing unload logic (strip images when 3+ pages away) needs to be wired to `gl.deleteTexture()` to avoid GPU memory leaks.

**Low risk:**

8. **Momentum / touch** — The velocity math is trivial JS, no DOM coupling.
9. **Page virtualization** — The page generation (web worker) and BFS cluster fetching are completely decoupled from rendering. They produce data; the renderer consumes it.
10. **Filter/search UI** — Entirely separate; no changes needed.

### What Breaks During Migration

During the migration (if done incrementally), the transition boundary is:

- **Canvas rendering** switches to WebGL (new code path)
- **Text overlays** temporarily have positioning bugs until sync is tuned
- **Hover card-fan** loses smooth CSS transitions until JS easing is implemented
- **Crates→tracks animation** coordinate math will need re-testing
- **Dark mode** may show wrong colors until shader uniforms are wired up

If done as a flag-gated swap (old DOM path vs new WebGL path behind a URL param like `?webgl`), all of the above can be iterated without breaking the live app.

### Can It Be Done Incrementally or Is It All-or-Nothing?

**Incrementally, with a feature flag.** The current architecture separates concerns cleanly enough:

1. Add `?webgl` flag — if present, use WebGL canvas for crates; if absent, keep DOM path
2. Implement WebGL stack rendering first (no animation, no hover)
3. Add pan/zoom (easiest part)
4. Add texture loading
5. Add hover card-fan animation
6. Add text overlay sync
7. Add gradient/glow shaders
8. Re-wire crates→tracks transition coordinates
9. Test mobile thoroughly (pinch, momentum, tap)
10. Remove old DOM path

Steps 1–4 are about 2–3 days of work. Steps 5–9 are another 5–7 days. The entire migration is roughly **2–3 weeks** of focused work for someone already familiar with this codebase and comfortable with WebGL.

---

## Overall Recommendation

**The migration is tractable but not obviously worth it yet.**

The current DOM implementation already does the right things for performance:
- rAF-throttled pan updates (single `style.transform` write per frame)
- DOM pruning (pages unmounted when 5+ pages away)
- Art unloading (images stripped when 3+ pages away)
- Off-main-thread page generation (web worker)
- `will-change: transform` on the surface

These optimizations mean the main-thread DOM work per frame is already minimal. The GPU is doing the heavy lifting via CSS compositing.

**Profile before migrating.** If the bottleneck is:
- **Paint/rasterize** — WebGL wins clearly; no CSS layout recalcs
- **JS frame time** — WebGL helps only if the DOM overhead is measurable (unlikely given the current pruning)
- **Memory** — WebGL might help or hurt (GPU textures vs DOM nodes; similar magnitude)
- **Smooth scroll on mobile** — Current momentum + rAF approach is already smooth; WebGL would be identical

The case for WebGL would be strongest if you want to add visual effects that CSS can't do cheaply: per-card parallax, shader-based art filters, particle effects on hover, bloom glow on active crates. If the goal is just "make panning smoother," the current implementation is likely already hitting the ceiling of what's possible with the existing architecture — WebGL won't help meaningfully there.

If the goal is visual richness and future-proofing for effects, WebGL is a good investment. If the goal is performance alone, profile first.

---

## Summary Table

| Factor | Assessment |
|---|---|
| Total new LOC | ~1,600–1,700 (vs ~1,100 today) |
| Migration time estimate | 2–3 weeks focused |
| Biggest technical risk | Rounded corners / shadows; crates→tracks coordinate transform |
| Recommended library | PixiJS via CDN (saves ~1 week on text + hit testing) |
| Text rendering | DOM overlay (keep as HTML) |
| Textures | Individual per-card; reuse existing unload logic |
| Hit testing | CPU bounding-box for clicks; DOM overlay for hover |
| DOM overlays to keep | Text labels, player widget, filters, toasts, flying-art elements |
| Incremental? | Yes — `?webgl` flag gates old vs new path |
| Worth doing now? | Only if adding visual effects CSS can't do, or if profiling shows DOM as bottleneck |

---

## 5. Testing Plan

> Applies to the PixiJS-based prototype in `sandbox/webgl-crates/` and any future production migration.
> Reference implementation: `sandbox/webgl-crates/main.js`.

---

### 5a. Code Tests (Automated — Playwright + in-page JS)

All tests load `http://localhost:8000/sandbox/webgl-crates/index.html` (serve repo root with `python3 -m http.server 8000`). Network requests to `b2b-api.omarwnema.workers.dev` should be intercepted and replaced with fixture data to make tests hermetic.

---

#### Test 1 — PixiJS initialization and canvas creation

**What to check:**
- `PIXI.Application` constructor runs without throwing.
- A `<canvas>` element is appended inside `#canvas-wrap`.
- The canvas fills the viewport (`clientWidth === window.innerWidth`).
- No console errors containing `"WebGL"` or `"context"`.

**Expected behavior:** Canvas is present and sized correctly within 500ms of page load.

**How to automate:**
```js
// Playwright
await page.goto('http://localhost:8000/sandbox/webgl-crates/index.html');
await page.waitForSelector('#canvas-wrap canvas');
const box = await page.$eval('#canvas-wrap canvas', el => ({
  w: el.clientWidth, h: el.clientHeight
}));
const vw = await page.evaluate(() => window.innerWidth);
expect(box.w).toBe(vw);
const errors = await page.evaluate(() => window._consoleErrors || []);
expect(errors.filter(e => /webgl|context/i.test(e))).toHaveLength(0);
```

---

#### Test 2 — API data fetching (pool loads, correct cluster count)

**What to check:**
- `GET /api/crates-index?v=3` is called exactly once during a session.
- The pool is shuffled (order differs from index order).
- `cratesPool.length` equals the number of items in the fixture response.
- A second call to `getPool()` returns the cached result without re-fetching.

**Expected behavior:** Pool fetched once, shuffled, length matches fixture.

**How to automate:**
```js
// Intercept the API call with a fixture of N=60 items
await page.route('**/api/crates-index**', route => route.fulfill({
  body: JSON.stringify(fixture60),
}));
await page.goto('...');
// Wait for loading spinner to hide (first page rendered)
await page.waitForSelector('#loading.hidden');
const poolLen = await page.evaluate(() => window._cratesPool?.length);
expect(poolLen).toBe(60);
// Reload page — should re-fetch (pool is session-local)
// Second navigation: verify only one fetch call was recorded in the session
```

---

#### Test 3 — Page grid (pages created on demand, correct positions)

**What to check:**
- On load, pages for `(0,0)` and immediate neighbors are requested.
- `pages["0,0"]` exists after the pool loads.
- `page.container.x` equals `col * vw()` and `page.container.y` equals `row * vh()`.
- Panning right by `vw()` pixels triggers a request for column 1 (page `"1,0"`).

**Expected behavior:** Pages created at correct world-coordinate offsets.

**How to automate:**
```js
await page.waitForSelector('#loading.hidden');
const pos = await page.evaluate(() => {
  const p = window._pages?.['0,0'];
  return p ? { x: p.container.x, y: p.container.y } : null;
});
expect(pos.x).toBe(0);
// Simulate pan right by one viewport width
await page.evaluate(() => {
  window._panX = -window.innerWidth;
  window._applyTransform?.();
  window._updateVisible?.();
});
await page.waitForFunction(() => !!window._pages?.['1,0']);
```

---

#### Test 4 — CrateStack rendering (correct card count, stagger offsets)

**What to check:**
- A `CrateStack` with `item.artworks.length === 4` creates exactly 4 `PIXI.Container` children.
- Each card's `(x, y)` is `(i * STEP, i * STEP)` for `i = 0..3`.
- Each card has a `PIXI.Graphics` placeholder and a `PIXI.Sprite` child.
- Stack with `artworks.length > MAX_CARDS` is clamped to 8 cards.

**Expected behavior:** Card count clamped to `MAX_CARDS`, positions staggered by `STEP` px.

**How to automate:**
```js
const result = await page.evaluate(() => {
  const page = Object.values(window._pages)[0];
  const stack = page?.stacks[0];
  if (!stack) return null;
  return {
    numCards: stack.numCards,
    positions: stack._cardContainers.map(cc => ({ x: cc.x, y: cc.y })),
    childCounts: stack._cardContainers.map(cc => cc.children.length),
  };
});
expect(result.positions[0]).toEqual({ x: 0, y: 0 });
expect(result.positions[1]).toEqual({ x: 3, y: 3 }); // STEP = 3
expect(result.numCards).toBeLessThanOrEqual(8);
```

---

#### Test 5 — Artwork texture loading and fallback placeholders

**What to check:**
- Before artwork loads: `sprite.visible === false`, `bg.visible === true` (placeholder shown).
- After `loadArtwork()` resolves for a card with a valid URL: `sprite.visible === true`, `bg.visible === false`.
- For a card with no artwork URL (`artworks[i] === undefined`): placeholder stays visible permanently.
- 120×120 URL rewrite: raw `-t500x500` URLs are rewritten to `-t120x120` before fetching.

**Expected behavior:** Placeholder → sprite swap on load; no swap if URL absent.

**How to automate:**
```js
// Intercept texture URL to return a 1×1 PNG fixture
await page.route('**-t120x120*', route => route.fulfill({
  contentType: 'image/png', body: tiny1pxPNG,
}));
await page.waitForSelector('#loading.hidden');
// Wait for at least one sprite to become visible
await page.waitForFunction(() => {
  const stack = Object.values(window._pages)[0]?.stacks[0];
  return stack?._sprites.some(s => s.visible);
});
const state = await page.evaluate(() => {
  const s = Object.values(window._pages)[0].stacks[0];
  return s._sprites.map((sp, i) => ({ spVisible: sp.visible, bgVisible: s._bgs[i].visible }));
});
state.forEach(({ spVisible, bgVisible }) => {
  if (spVisible) expect(bgVisible).toBe(false);
});
```

---

#### Test 6 — Viewport culling (off-screen pages not loaded, distant pages removed)

**What to check:**
- Pages more than 1 column/row outside the viewport are never requested.
- Pages more than 5 columns/rows away have their containers removed from `world` (`page.container.parent === null`).
- Pages more than 2 columns/rows away have `artLoaded === false`.
- Re-entering the viewport re-adds the container and reloads art.

**Expected behavior:** `domFar` threshold removes page from world; `artFar` threshold unloads textures.

**How to automate:**
```js
// Pan 6 viewports to the right
await page.evaluate(() => {
  window._panX = -6 * window.innerWidth;
  window._applyTransform?.();
  window._updateVisible?.();
});
const p00 = await page.evaluate(() => {
  const p = window._pages?.['0,0'];
  return { hasParent: !!p?.container?.parent, artLoaded: p?.artLoaded };
});
expect(p00.hasParent).toBe(false);
expect(p00.artLoaded).toBe(false);
```

---

#### Test 7 — Pan math (drag delta correctly applied to stage position)

**What to check:**
- `mousedown` at `(100, 100)`, `mousemove` to `(200, 150)` → `panX` increases by 100, `panY` by 50.
- `world.x` equals `panX`, `world.y` equals `panY` after `applyTransform()`.
- Pan does not accumulate drift over repeated drag-release cycles.

**Expected behavior:** `world.x/y` tracks `panX/Y` exactly, delta matches mouse movement.

**How to automate:**
```js
const canvas = await page.$('#canvas-wrap canvas');
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 80, cy + 40);
const { panX, panY, wx, wy } = await page.evaluate(() => ({
  panX: window._panX, panY: window._panY,
  wx: window._world?.x, wy: window._world?.y,
}));
expect(wx).toBe(panX);
expect(wy).toBe(panY);
await page.mouse.up();
```

---

#### Test 8 — Zoom math (wheel scales correctly, centers on cursor)

**What to check:**
- Wheel `deltaY < 0` (scroll up) increases `scale` by factor `1.08`.
- Wheel `deltaY > 0` decreases `scale` by factor `1/1.08`.
- Scale is clamped to `[MIN_SCALE, MAX_SCALE]` (0.12 to 3.0).
- Zoom centers on cursor: the world-space point under the cursor is the same before and after zoom.

**Expected behavior:** Scale changes by ×1.08 per wheel tick; cursor world-point invariant.

**How to automate:**
```js
const initialScale = await page.evaluate(() => window._scale);
// Simulate ctrl+wheel up (zoom in)
await page.evaluate(() => {
  const canvas = document.querySelector('#canvas-wrap canvas');
  const evt = new WheelEvent('wheel', { deltaY: -10, ctrlKey: true,
    clientX: window.innerWidth / 2, clientY: window.innerHeight / 2,
    bubbles: true, cancelable: true });
  canvas.dispatchEvent(evt);
});
const newScale = await page.evaluate(() => window._scale);
expect(newScale).toBeCloseTo(initialScale * 1.08, 3);

// Verify cursor world-point invariance
const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
const wx_before = (cx - panX_before) / scale_before;
const wx_after  = (cx - panX_after)  / scale_after;
expect(wx_after).toBeCloseTo(wx_before, 1);
```

---

#### Test 9 — Momentum decay (velocity reduces at 0.92 per frame, stops at threshold)

**What to check:**
- After a fling (`tVelX = 20`), each rAF step multiplies velocity by `0.92`.
- `momentumId` is `null` once `|tVelX| < 0.5 && |tVelY| < 0.5`.
- Total distance traveled matches `vel * (1 / (1 - 0.92))` (geometric series sum, approx 12.5× initial vel).

**Expected behavior:** Velocity decays geometrically; stops when both components drop below 0.5.

**How to automate:**
```js
// Expose internal velocity via window for testing
await page.evaluate(() => {
  // Inject a fling directly
  window._tVelX = 20; window._tVelY = 0;
  // Start momentum loop manually
  window._startMomentum?.();
});
// Wait for momentum to finish (momentumId === null)
await page.waitForFunction(() => window._momentumId === null, { timeout: 3000 });
const finalVel = await page.evaluate(() => ({ x: window._tVelX, y: window._tVelY }));
expect(Math.abs(finalVel.x)).toBeLessThan(0.5);
```

---

#### Test 10 — Touch pinch zoom

**What to check:**
- Two-touch `touchstart` sets `pinchActive = true`.
- Moving touches apart (larger distance) increases scale proportionally.
- Scale does not change if touch distance is unchanged.
- Zoom centers on the midpoint of the two touches.
- `tDragging` is `false` during an active pinch.

**Expected behavior:** `scale = pinchStartScale * (currentDist / pinchStartDist)`, clamped.

**How to automate:**
```js
// Playwright touch simulation
const canvas = await page.$('#canvas-wrap canvas');
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const scaleBefore = await page.evaluate(() => window._scale);
await page.touchscreen.tap(cx - 50, cy); // not pinch-capable directly in Playwright
// Use page.evaluate to dispatch synthetic TouchEvents
await page.evaluate(([cx, cy]) => {
  function mkTouch(x, y) {
    return new Touch({ identifier: Math.random()*1e6|0, target: document.body, clientX: x, clientY: y });
  }
  const t1s = mkTouch(cx - 50, cy), t2s = mkTouch(cx + 50, cy);
  const t1e = mkTouch(cx - 100, cy), t2e = mkTouch(cx + 100, cy);
  const canvas = document.querySelector('#canvas-wrap canvas');
  canvas.dispatchEvent(new TouchEvent('touchstart', { touches: [t1s, t2s], changedTouches: [t1s, t2s], bubbles: true, cancelable: true }));
  canvas.dispatchEvent(new TouchEvent('touchmove',  { touches: [t1e, t2e], changedTouches: [t1e, t2e], bubbles: true, cancelable: true }));
  canvas.dispatchEvent(new TouchEvent('touchend',   { touches: [], changedTouches: [t1e, t2e], bubbles: true, cancelable: true }));
}, [cx, cy]);
const scaleAfter = await page.evaluate(() => window._scale);
expect(scaleAfter).toBeGreaterThan(scaleBefore * 1.5); // spread from 100→200px = 2× scale
```

---

#### Test 11 — Hit testing (correct stack receives pointer events)

**What to check:**
- `pointerover` fires on the `CrateStack.container` when the cursor enters its `hitArea` rectangle.
- `pointertap` fires on the correct stack when the canvas is clicked at that stack's world position.
- Overlapping stacks (when zoomed in) route to the topmost `zIndex`.
- Hit area accounts for current `panX/Y` and `scale`.

**Expected behavior:** Events route to the correct stack; no false positives outside `hitArea`.

**How to automate:**
```js
// Click at the screen position of the first stack in page (0,0)
const firstStack = await page.evaluate(() => {
  const s = Object.values(window._pages)[0]?.stacks[0];
  if (!s) return null;
  const panX = window._panX, panY = window._panY, scale = window._scale;
  // Stack's screen position
  const sx = (s.container.parent.x + s.container.x) * scale + panX;
  const sy = (s.container.parent.y + s.container.y) * scale + panY;
  return { sx: sx + 5, sy: sy + 5 }; // click just inside top-left corner
});
let clicked = null;
await page.exposeFunction('onStackClick', key => { clicked = key; });
await page.evaluate(() => {
  Object.values(window._pages)[0]?.stacks[0]?.container.on('pointertap', () =>
    window.onStackClick('stack0'));
});
await page.mouse.click(firstStack.sx, firstStack.sy);
expect(clicked).toBe('stack0');
```

---

#### Test 12 — Dark/light mode toggle

**What to check:**
- Clicking the theme button adds/removes `.dark` on `<body>`.
- `app.renderer.background.color` changes to `0x1e2228` (dark) or `0xf5f5f7` (light).
- Pressing `d` triggers the same toggle as clicking the button.
- Toggling twice returns to original theme.

**Expected behavior:** Background color and body class stay in sync; no render errors on toggle.

**How to automate:**
```js
const initialBg = await page.evaluate(() => window._app?.renderer.background.color);
await page.click('#theme-btn');
const darkBg = await page.evaluate(() => window._app?.renderer.background.color);
const hasDark = await page.evaluate(() => document.body.classList.contains('dark'));
expect(darkBg).toBe(0x1e2228);
expect(hasDark).toBe(true);
await page.click('#theme-btn');
const restoredBg = await page.evaluate(() => window._app?.renderer.background.color);
expect(restoredBg).toBe(initialBg);
```

---

#### Test 13 — Memory: texture count bounded during long sessions

**What to check:**
- After simulating panning through 20+ pages, `texCache._cache.size` does not grow unboundedly.
- Pages removed via `domFar` logic have their textures evicted: sprites reset to `PIXI.Texture.EMPTY`.
- `PIXI.Texture.EMPTY` is not counted as a live texture in the cache.
- GPU texture count (approximated by cache size) stays below 200 at any viewport.

**Expected behavior:** Texture cache stays roughly proportional to visible + 2-page buffer area.

**How to automate:**
```js
// Pan through pages 0–9 rightward, then check cache size
for (let col = 0; col <= 9; col++) {
  await page.evaluate(col => {
    window._panX = -col * window.innerWidth;
    window._applyTransform?.();
    window._updateVisible?.();
  }, col);
  await page.waitForTimeout(200);
}
const cacheSize = await page.evaluate(() => window._texCache?._cache.size);
expect(cacheSize).toBeLessThan(200);
```

---

#### Test 14 — FPS stays above 30 with 500+ stacks

**What to check:**
- With 500+ crate stacks rendered (25 pages × 20 clusters), PixiJS ticker FPS does not drop below 30.
- FPS is sampled over 3 seconds after all visible pages have loaded.
- No `console.error` entries during the measurement window.

**Expected behavior:** ≥30 FPS sustained; 60 FPS target on M1/M2 Mac.

**How to automate:**
```js
await page.waitForSelector('#loading.hidden');
// Let 3 seconds of frames accumulate
await page.waitForTimeout(3000);
const fps = await page.evaluate(() => {
  return window._app?.ticker?.FPS ?? 0;
});
expect(fps).toBeGreaterThan(30);
const stackCount = await page.evaluate(() =>
  Object.values(window._pages).reduce((n, p) => n + p.stacks.length, 0));
expect(stackCount).toBeGreaterThan(50); // enough to be meaningful
```

---

### 5b. Interaction Tests (Manual + Automated)

---

#### Desktop Interactions

| Interaction | What to Check | Expected Behavior | Automated? |
|---|---|---|---|
| Drag to pan | Hold left mouse, move 100px right | `world.x` increases by 100; cursor shows `grabbing` | Yes (Playwright mouse API) |
| Drag threshold | Move 3px (below threshold) | No pan applied; click still fires | Yes |
| Wheel scroll (no modifier) | Scroll without Ctrl | Pans in scroll direction (not zoom) | Yes (WheelEvent dispatch) |
| Wheel zoom (Ctrl + scroll up) | Ctrl+wheel up 5 ticks | Scale increases; point under cursor stays fixed | Yes |
| Wheel zoom (Ctrl + scroll down) | Ctrl+wheel down | Scale decreases; cursor point invariant | Yes |
| Hover fan — enter crate | Move cursor over a crate | Info overlay appears on top card | Yes (Playwright hover) |
| Hover fan — move within crate | Move cursor across crate horizontally | Active card cycles through stack | Manual (requires precise timing) |
| Hover fan — dead zone | Enter crate, immediately move cursor | No card change in first 150ms | Manual |
| Hover fan — exit crate | Move cursor out | Overlay hides, active resets to top card | Yes |
| Click crate | Click inside a crate | `pointertap` fires; toast appears with title/artist | Yes |
| Click vs drag | Mousedown + move 10px + mouseup | Should be drag (no `pointertap`) | Yes |
| Rapid pan | Fast back-and-forth drag | No drift, no position accumulation error | Manual |
| Zoom at min/max | Zoom out past `MIN_SCALE=0.12` | Scale clamped at 0.12; no further shrink | Yes |
| Zoom at max | Zoom in past `MAX_SCALE=3.0` | Scale clamped at 3.0 | Yes |
| `0` key reset | Press `0` or `=` | Pan resets to (0, TOOLBAR_H), scale to 0.85 | Yes |
| `+/-` keys | Press `+` then `-` | Scale increases/decreases by ×1.2, centers on viewport | Yes |
| Resize window | Drag browser window wider | Canvas resizes (`resizeTo: window`); layout adapts | Manual |

---

#### Mobile Interactions

| Interaction | What to Check | Expected Behavior | Automated? |
|---|---|---|---|
| Touch drag | Single-finger pan | `panX/Y` updates in real time; canvas follows finger | Yes (TouchEvent dispatch) |
| Drag threshold | 3px touch move | No pan, tap fires | Yes |
| Touch fling | Fast swipe + lift finger | Momentum starts; velocity decays at 0.92/frame | Yes (verify `_tVelX` decay) |
| Momentum stop | After fling, wait | `momentumId === null` when vel < 0.5 | Yes |
| Pinch zoom in | Spread two fingers apart | Scale increases; midpoint invariant | Yes (synthetic TouchEvents) |
| Pinch zoom out | Pinch two fingers together | Scale decreases; midpoint invariant | Yes |
| Pinch at min/max | Pinch past limits | Scale clamped; no panic/NaN | Yes |
| Pinch → pan transition | End pinch with one finger remaining | `pinchActive` clears; single-touch pan resumes correctly | Manual (tricky to automate) |
| Tap on crate | Single tap (no drag) | `pointertap` fires; toast shown | Yes |
| Fling during momentum | Start new drag during ongoing fling | Previous momentum cancelled; new drag takes control | Manual |
| `touchcancel` | System interrupt (e.g. notification) | Momentum stops; drag state resets | Manual |

---

#### Cross-Browser Tests (Manual)

All manual — run in dev server (`python3 -m http.server 8000`).

| Browser | Tests to Run | Known Risk Areas |
|---|---|---|
| Chrome (latest) | Full test suite; baseline | None expected |
| Safari 17+ | All interactions; focus on `backdrop-filter` on overlays | `backdrop-filter` over `<canvas>` sometimes composited incorrectly |
| Firefox (latest) | Pan, zoom, hover fan, textures | PixiJS WebGL context may pick a different backend; verify no visual glitch |
| Chrome (mobile, iOS) | Touch pan, pinch, tap, fling | `touch-action: none` must be on canvas container |
| Safari (mobile, iOS) | Same + check `touchcancel` | iOS may fire `touchcancel` on scroll, breaking drag state |

---

#### Edge Cases

| Scenario | What to Check | Expected |
|---|---|---|
| Zoom to `MIN_SCALE` then pan | All pages still culled correctly | No off-by-one in page index math at extreme zoom |
| Zoom to `MAX_SCALE` then pan | Only few crates visible; art loaded | Correct pages requested at high zoom |
| Pan far past pool boundary | `pageNum * CLUSTERS_PER_PAGE >= pool.length` | `slice.length === 0`, page not created, no crash |
| Pool fetch fails (network error) | Fetch rejects | Console error logged; loading spinner stays; no unhandled rejection |
| Single-item cluster (1 artwork) | `artworks.length === 1` | Stack renders 1 card with correct color; no index OOB |
| Artwork URL fetch fails | CDN returns 404 | `TextureCache.load` returns `null`; sprite stays hidden; placeholder persists |
| `item.rect.w < 20` | Very small treemap cell | `CrateStack.valid === false`; container not added to page |
| Dark mode toggle mid-pan | Toggle while dragging | No glitch; drag continues; background updates on next frame |
| Window resize during pan | Resize while mid-drag | `vw()/vh()` updates; new pages sized to new viewport; drag coordinates remain valid |
| Rapid theme toggle (10× fast) | Click theme button 10 times | No flickering; final state matches toggle count parity |

---

#### Performance Test (Manual + Automated)

| Scenario | Tool | Target |
|---|---|---|
| Steady-state FPS with ~500 stacks | Chrome DevTools Performance tab | ≥60 FPS on M1 Mac; ≥30 FPS on mid-range Android |
| Memory over 10-minute session | Chrome Memory Profiler → Heap Snapshots at 0, 5, 10 min | No monotonic texture heap growth; heap stable after initial load |
| First page time-to-paint | Playwright `page.metrics()` | Loading spinner hidden within 2s on fast network |
| GPU memory (textures) | `chrome://gpu-internals` or WebGL extensions | < 50MB after panning through 10 pages |
| Long pan + rapid zoom | DevTools Rendering → FPS meter | No frame drops below 30 during combined pan+zoom |

---

#### Dark Mode Toggle Mid-Interaction (Manual)

This is tricky to automate reliably because it tests visual consistency during an animation frame boundary.

**Procedure:**
1. Start a slow pan drag.
2. While dragging, press `d` to toggle dark mode.
3. Release drag.
4. Verify: canvas background updates immediately; drag completes without snap; card placeholders still visible.

**Expected:** Background color changes on the next renderer tick with no visual artifacts. The drag delta accumulates correctly across the toggle frame.

**Risk:** If `isDark` is captured in a closure before the toggle fires, the background may not update until the next interaction. Verify by inspecting `app.renderer.background.color` in DevTools console after toggle.

---

### 5c. Test Infrastructure Notes

**Exposing internals for tests:**
The implementation does not currently export state. For automated testing, add a thin test-harness shim (guarded by `?test` URL param) that exposes `_panX`, `_panY`, `_scale`, `_world`, `_pages`, `_texCache`, `_app`, `_cratesPool`, `_momentumId`, `_tVelX`, `_tVelY`, `_applyTransform`, `_updateVisible`, `_startMomentum` on `window`. This lets Playwright read and drive state without modifying production code paths.

**Hermetic API fixtures:**
Intercept `**/api/crates-index**` in all Playwright tests with a fixture of at least 60 clusters (3 pages). Each fixture item should have `id`, `artworks` (2–4 URLs), `weight`, `count`, and `n` fields matching the production schema.

**Texture stubbing:**
Intercept `*-t120x120*` routes with a 1×1 transparent PNG to avoid CDN dependency and make artwork-load tests deterministic.

**CI recommendation:**
Run the Playwright suite in headless Chromium on every push. Skip the cross-browser and mobile interaction rows (manual-only) in CI; run them on release branches before merging to `main`.
