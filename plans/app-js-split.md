# Plan: Split app.js into focused modules

`js/app.js` is 1570 lines and handles too many concerns. This plan splits it into four files while keeping the plain script-tag architecture.

## 1. Proposed split

### `js/crates.js` (~640 lines)
Lines 316-1128 of current app.js. Everything inside and related to `initCrates()`, plus the `transitionToTracks()` fly-out animation.

Contains:
- `transitionToTracks(seedKey, stackEl)` — fly-out animation from crate to tracks view (lines 317-492)
- `initCrates()` — the entire crates infinite canvas system (lines 499-1129):
  - `renderStack()`, `attachHover()`
  - `cratesTreemap()` — client-side treemap layout
  - `requestPage()`, `receivePage()`, `loadPageArt()`, `unloadPageArt()`, `mountPage()`, `unmountPage()`
  - Pan/drag/touch/pinch/momentum handlers
  - `updateVisible()`, `scheduleUpdateVisible()`
  - `window._cratesResetFn` setup
  - `cratesInitialized` flag

Both `transitionToTracks` and `initCrates` are defined inside the DOMContentLoaded handler today. They'll become top-level functions in the new file, wrapped in their own `DOMContentLoaded` listener (or called from app.js init).

### `js/theme.js` (~180 lines)
Lines 293-381 and 1166-1303 of current app.js. Theme toggle, gradient art knobs, accent color picker, genre pills toggle, helper toasts.

Contains:
- `applyTheme(isNight)` — theme toggle logic (lines 298-314)
- Theme toggle button wiring and `prefers-color-scheme` listener
- Genre pills checkbox (`show-genres`) wiring (lines 1166-1171)
- Helper toast logic — `showHelper()`, `dismissHelper()`, toast close buttons, helpers checkbox (lines 1181-1218)
- Dev panel toggle button (lines 1255-1258)
- `updateGradientFilter()` and all six gradient art slider wirings (lines 1260-1303)
- Accent color picker — `hexToHue()`, `applyAccent()`, preset swatches (lines 1305-1381)

### `js/context-menu.js` (~190 lines)
Lines 1383-1568 of current app.js. The right-click/hover context menu system.

Contains:
- Context menu DOM references and state (`ctxMenu`, `ctxItems`, `ctxData`, `ctxHideTimer`, `ctxActiveDots`)
- `CTX_SELECTOR` constant
- `reorderCtxMenu(source)`, `positionCtxMenu(x, y)`, `getSource(trigger)`, `openCtxMenu()`, `closeCtxMenu()`, `scheduleClose()`
- Desktop hover-to-open (`mouseover`/`mouseout` delegates)
- Click handling delegate (genre pills, dots, triggers)
- Context menu action handler (view-track, view-set, filter-dj, filter-artist, filter-genre)

Note: the context menu action handler calls `filterCtrl.addDjFilter()`, `filterCtrl.addSearchFilter()`, `filterCtrl.toggleGenre()`, and `shuffle()`. These are passed in during init (see cross-file dependencies below).

### `js/app.js` (remaining, ~400 lines)
The core orchestration that stays:

- `showCluster(cluster)` (lines 1-138)
- `getFilteredPoolSize()` (line 140-142)
- `showStatus()`, `hideStatus()` (lines 144-161)
- `buildFilterParams()` (lines 163-182)
- `shuffle()` (lines 184-216)
- `loadClusterById(id)` (lines 218-229)
- DOMContentLoaded init block (slimmed down):
  - Help panel setup
  - `initFilters()` call
  - Retry button wiring
  - `onClusterShown` hook
  - Initial cluster load (hash or shuffle)
  - `popstate` handler
  - Help modal wiring
  - Mode tabs wiring (tracks/crates switching, calls `initCrates()`)
  - Crates filters toggle (lines 1173-1179)
  - Dev panel control wiring: freeze, cluster-id copy, max-r1/r2, cluster-input (lines 1220-1253)
  - Mixcloud close button (lines 1250-1253)

## 2. Load order

```
js/data.js          (globals, state)
js/api.js           (API helpers)
js/audio.js         (playback engine)
js/graph.js         (layout, rendering, clearGraph)
js/mobile.js        (mobile carousel)
js/filters.js       (search, autocomplete, popovers)
js/theme.js         NEW — theme toggle, gradient art, accent, helpers
js/context-menu.js  NEW — right-click context menu
js/crates.js        NEW — crates view, treemap, pan/zoom
js/app.js           (init, shuffle, showCluster, event wiring) — LAST
```

The new files go between `filters.js` and `app.js`. Order among the three new files doesn't matter much since they're all wired during DOMContentLoaded, but `theme.js` first makes sense since it sets up visual state early.

## 3. Cross-file dependencies

### `js/crates.js` needs:
| Symbol | Defined in | Type |
|---|---|---|
| `isMobileView()` | graph.js | function |
| `showCluster()` | app.js | function |
| `showClusterMobile()` | mobile.js | function |
| `buildFilterParams()` | app.js | function |
| `apiFetch()` | api.js | function |
| `apiLoadCluster()` | api.js | function |
| `trackEvent()` | api.js | function |
| `nodes` | data.js | global |
| `window._cratesResetFn` | self (crates.js) | global |

**Circular dependency**: `crates.js` calls `showCluster()` (defined in app.js), and app.js calls `initCrates()` (defined in crates.js). This works fine with script tags because both are called at runtime (inside event handlers), not at parse time. By the time any of them execute, all files have been parsed and all globals are defined.

**How to handle `initCrates()`**: Make it a top-level function in `crates.js`. The mode-tab wiring in `app.js` calls `initCrates()` — since `crates.js` loads before `app.js`, this works.

**How to handle `transitionToTracks()`**: Same approach — top-level function in `crates.js`, called by crate stack click handlers (inside crates.js itself) and referenced nowhere else.

### `js/theme.js` needs:
| Symbol | Defined in | Type |
|---|---|---|
| `currentCluster` | data.js | global |
| `showCluster()` | app.js | function (for genre pills toggle) |

The genre pills checkbox calls `showCluster(currentCluster)` on change. Since `theme.js` loads before `app.js`, `showCluster` isn't defined yet at parse time — but it's only called inside an event handler, so it's fine at runtime.

### `js/context-menu.js` needs:
| Symbol | Defined in | Type |
|---|---|---|
| `isMobileView()` | graph.js | function |
| `filtersDirty` | data.js | global |
| `shuffle()` | app.js | function |

The context menu actions call `filterCtrl.addDjFilter()` etc. The `filterCtrl` object is returned by `initFilters()` in app.js's DOMContentLoaded. Two options:

**Option A (recommended)**: Have `initContextMenu(filterCtrl)` be an init function called from app.js after `initFilters()` resolves. This passes `filterCtrl` explicitly.

**Option B**: Stash `filterCtrl` on `window` (e.g. `window._filterCtrl`). Simpler but messier.

Go with Option A. `context-menu.js` exports `initContextMenu(filterCtrl)` which wires all context menu event listeners and returns `{ closeCtxMenu }` if needed.

### `js/app.js` (remaining) needs:
| Symbol | Defined in | Type |
|---|---|---|
| `initCrates()` | crates.js | function |
| `initContextMenu()` | context-menu.js | function |
| `initFilters()` | filters.js | function |
| All graph/render functions | graph.js | functions |
| All audio functions | audio.js | functions |
| All API functions | api.js | functions |
| All state variables | data.js | globals |

No issues — app.js loads last, everything is available.

## 4. Detailed file contents

### `js/crates.js`

```
// Top-level variables
let cratesInitialized = false;
window._cratesResetFn = null;

// Fly-out transition (currently nested in DOMContentLoaded)
function transitionToTracks(seedKey, stackEl) { ... }

// Main init (currently nested in DOMContentLoaded)
function initCrates() { ... }
```

Both functions are currently defined inside the DOMContentLoaded closure. To extract them:
- Move them to top-level scope
- Any references to variables from the DOMContentLoaded closure (like `cratesHelperToast`, `helpersCheckbox`) need to be resolved. Check: `transitionToTracks` doesn't reference any closure vars. `initCrates` is self-contained — all its state is local. The mode-tab handler in app.js that calls `initCrates()` also references `cratesHelperToast` — that toast reference should move to where it's used or be looked up by ID inline.

### `js/theme.js`

```
// Called from DOMContentLoaded
function initTheme() {
  // applyTheme(), theme button, prefers-color-scheme listener
  // Dev panel toggle
  // Gradient art knobs + updateGradientFilter()
  // Accent color picker + applyAccent(), hexToHue()
  // Genre pills checkbox
  // Helper toast logic (showHelper, dismissHelper, checkbox)
}
```

Wrap in a single `initTheme()` function called from app.js's DOMContentLoaded. Returns `{ showHelper }` so app.js can call it for initial tracks helper display and crates helper on tab switch.

### `js/context-menu.js`

```
function initContextMenu(filterCtrl) {
  // All context menu setup, event delegates, action handlers
  // Returns { closeCtxMenu } if needed externally
}
```

### `js/app.js` (remaining)

```
function showCluster(cluster) { ... }
function getFilteredPoolSize() { ... }
function showStatus() { ... }
function hideStatus() { ... }
function buildFilterParams() { ... }
async function shuffle() { ... }
async function loadClusterById(id) { ... }

document.addEventListener('DOMContentLoaded', async () => {
  // Help panels
  const filterCtrl = await initFilters();
  const themeCtrl = initTheme();        // from theme.js
  initContextMenu(filterCtrl);           // from context-menu.js

  // Retry button, onClusterShown hook
  // Initial load (hash or shuffle)
  // popstate handler
  // Help modal wiring
  // Mode tabs (calls initCrates() from crates.js)
  // Dev panel controls (freeze, cluster-id, r1/r2, cluster-input)
  // Mixcloud close
});
```

## 5. Step-by-step migration

Each step is independently deployable. Do one, test, commit, move to the next.

### Step 1: Extract `js/crates.js`

1. Create `js/crates.js`
2. Move `transitionToTracks()` and `initCrates()` out of the DOMContentLoaded closure to top-level functions in the new file
3. Move `cratesInitialized` and `window._cratesResetFn = null` to top of the new file
4. In app.js, remove those functions and variables — keep the mode-tab wiring that calls `initCrates()` and references to `transitionToTracks()`
5. Check: `transitionToTracks` is only called from inside `initCrates` (in the crate click handler) — so no cross-file call needed
6. Add `<script src="js/crates.js"></script>` before app.js in index.html

**Verify**: Load the app, switch to Crates tab, click a crate, verify fly-out works and tracks view shows correctly. Check console for errors.

### Step 2: Extract `js/theme.js`

1. Create `js/theme.js` with `initTheme()` function
2. Move theme toggle, gradient art, accent picker, helper toast code into it
3. Have `initTheme()` return `{ showHelper, showCratesHelper, showTracksHelper }` or similar
4. In app.js DOMContentLoaded, call `const themeCtrl = initTheme()` and use returned helpers where needed
5. Add `<script src="js/theme.js"></script>` before context-menu.js in index.html

**Verify**: Toggle night mode, adjust gradient sliders, change accent color, check helper toasts appear. Test both light and dark mode.

### Step 3: Extract `js/context-menu.js`

1. Create `js/context-menu.js` with `initContextMenu(filterCtrl)` function
2. Move all context menu code into it
3. In app.js DOMContentLoaded, call `initContextMenu(filterCtrl)` after `initFilters()` resolves
4. Add `<script src="js/context-menu.js"></script>` before crates.js in index.html

**Verify**: Right-click/hover on DJ names, click dots menu, use "filter for artist/DJ" actions, verify genre pill context menu works. Test on both mobile and desktop widths.

### Step 4: Clean up app.js

1. Review remaining app.js — should be ~400 lines
2. Remove any dead code or stale comments
3. Verify all init calls are in the right order

## 6. Verification checklist (after each step)

- [ ] Page loads without console errors
- [ ] Shuffle works (random cluster loads)
- [ ] Hash navigation works (paste a track URL, hit back/forward)
- [ ] Night mode toggles correctly
- [ ] Crates view loads, pans, zooms, stacks hover correctly
- [ ] Clicking a crate flies out to tracks view
- [ ] Context menu appears on DJ name hover (desktop) and click (mobile)
- [ ] Context menu "filter for DJ/artist" actions trigger shuffle with filter
- [ ] Genre pill click opens filter context menu
- [ ] Gradient art sliders work
- [ ] Accent color picker works
- [ ] Helper toasts appear and dismiss
- [ ] Dev panel opens/closes, freeze works, cluster input works
- [ ] Mobile: carousel works, mode tabs switch between tracks/crates
- [ ] No regressions in audio playback

## 7. Risks

### Shared mutable state
`currentCluster`, `currentRootId`, `frozen`, `shuffleHistory`, `nodes`, `edges`, `nodeMap`, `filtersDirty` are all globals in `data.js`. Multiple files read and write them. This is fine — it's how the app already works — but be careful not to introduce a second copy of any variable when extracting.

### Init order
The DOMContentLoaded handlers in different files fire in script-load order (which is source order in the HTML). If `crates.js` has its own DOMContentLoaded listener, it fires before `app.js`'s. This is fine as long as `crates.js` only defines functions (not calling them at load time). The actual `initCrates()` call happens from app.js's tab-switch handler, well after everything is loaded.

**Key rule**: New files should only *define* functions at the top level. All *calling* happens from app.js's DOMContentLoaded or from user-triggered event handlers.

### Closure variables becoming globals
`transitionToTracks` and `initCrates` are currently closures inside DOMContentLoaded. When extracted to top-level scope, any variables they captured from the DOMContentLoaded closure become inaccessible. Check each extracted function for references to:
- `filterCtrl` — the return value of `initFilters()`. Solution: pass as parameter to `initContextMenu()`, not needed by crates or theme.
- `cratesHelperToast`, `tracksHelperToast` — DOM elements cached in DOMContentLoaded. Solution: look them up by ID inline (`document.getElementById(...)`) or cache in the new file's own init function.
- `helpersCheckbox` — same solution, look up by ID.

### Event delegation timing
Context menu uses `document.addEventListener('mouseover', ...)` and `document.addEventListener('click', ...)` delegates. These must be registered after DOMContentLoaded. Wrapping in `initContextMenu()` called from app.js's DOMContentLoaded guarantees this.

### The `filterCtrl` handoff
`filterCtrl` is the trickiest dependency. It's returned by `await initFilters()` in app.js and needed by:
- Context menu actions (filter-dj, filter-artist, filter-genre)
- The `onClusterShown` hook
- The retry button "clear filters" action

Solution: pass it to `initContextMenu(filterCtrl)`. The other two uses stay in app.js. No global needed.
