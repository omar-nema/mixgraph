# Safari Audio Playback — Known Issues

## Current state (2026-03-13)

Audio playback via the SoundCloud widget is **unreliable on Safari**. It works on Chrome and Firefox consistently. On Safari, the first play attempt after a page load often fails silently — the card shows the loading shimmer, then either stays stuck or resets. A second attempt (or playing a different track first, then going back) usually succeeds.

## What was tried

### 1. Iframe positioning (partially successful)
**Problem:** The SC widget iframe was hidden offscreen with `position:absolute;left:-9999px`. Safari treats offscreen iframes as non-user-activated contexts and blocks autoplay.

**Fix:** Changed to `position:fixed;bottom:0;left:0;opacity:0;pointer-events:none;z-index:-1` — visually hidden but technically on-screen.

**Result:** Helped in Playwright WebKit tests, but didn't fully resolve real Safari.

### 2. `allow` attribute on iframes (kept)
**Fix:** Changed `allow="autoplay"` → `allow="autoplay; encrypted-media"` on both SC and Mixcloud iframes.

**Result:** Necessary but not sufficient on its own.

### 3. Explicit `play()` call in READY handler (kept)
**Problem:** Safari ignores the SC widget's `auto_play: true` option because the user gesture context doesn't propagate through the async `load()` call into the cross-origin iframe.

**Fix:** Added `try { scWidget.play(); } catch (e) {}` inside the `SC.Widget.Events.READY` handler for both `playSC()` and `playSCSet()`.

**Result:** This is the most impactful change. Makes playback work most of the time. However, it relies on the READY event firing promptly enough that Safari still considers it within the user gesture window — which is not guaranteed.

### 4. Removing the dummy track from iframe src (kept)
**Problem:** The iframe was pre-loaded with `tracks/293` (a dead/ancient SoundCloud track). On page load, the SC widget inside the iframe tried to fetch this track, hit CORS errors and 403s, and entered a broken internal state. First real `scWidget.load()` call would then fail.

**Fix:** Changed iframe src from `https://w.soundcloud.com/player/?url=...tracks/293...` to `https://w.soundcloud.com/player/?show_artwork=false&auto_play=false` (bare player, no track).

**Result:** Eliminated the cascade of CORS errors on page load. The widget initializes cleanly.

### 5. Lazy iframe bootstrap with `ensureSCWidget()` (reverted)
**Problem:** Tried starting the iframe as `about:blank` and only loading the SC player on first play click, to keep the user gesture chain as short as possible.

**Fix:** Added `ensureSCWidget()` which set iframe src on demand, waited for `load` event, then initialized `SC.Widget()`.

**Result:** Introduced a race condition — the iframe `load` event fires when the document loads, but the SC widget JavaScript inside it may not be ready yet. Also, loading the iframe with the same track URL that `scWidget.load()` would subsequently request caused a silent no-op (SC widget detects duplicate loads). Reverted to pre-loading the bare player in HTML.

## Why it's hard to fix

The root cause is a fundamental tension between Safari's autoplay policy and the SoundCloud widget architecture:

1. **Safari requires a direct user gesture** to play audio in cross-origin iframes. The gesture context has a very short lifetime — any async operation (network request, setTimeout, postMessage) can break the chain.

2. **The SC widget API is async by design.** `scWidget.load(url)` triggers a cross-origin postMessage to the iframe, which fetches the track, then fires READY, then fires PLAY. By the time READY fires, Safari may have already expired the user gesture context.

3. **The SC widget is a black box.** We can't modify its internal behavior. We can only call its public API (`load`, `play`, `bind`) and hope the events fire in time.

4. **SoundCloud's own rate-limiting/captcha.** The SC widget sometimes triggers a captcha (`captcha-delivery.com`) which cannot be solved inside a hidden iframe. This is unrelated to our code and causes silent failures. Having DevTools open seems to trigger it more frequently.

5. **Playwright WebKit ≠ real Safari.** All fixes pass in Playwright's WebKit engine, but real Safari on macOS has stricter autoplay enforcement, possibly tighter gesture timeout windows, and browser-level "Intelligent Tracking Prevention" that may interfere with cross-origin iframe communication.

## Current code state

```
iframe src:   bare SC player (no track, no CORS errors on load)
positioning:  fixed, opacity:0 (on-screen but invisible)
allow attr:   "autoplay; encrypted-media"
on READY:     explicit play() call
on first use: initSCWidget() wraps iframe with SC.Widget()
```

The code is clean and simple — no lazy loading, no async bootstrap, no workarounds stacked on workarounds. The issue is in the browser/widget interaction, not code complexity.

## Potential remediations

### A. User-facing: show a "tap to enable audio" prompt on Safari
Instead of trying to silently autoplay, detect Safari and show a one-time prompt that plays a silent audio clip via a direct `<audio>` element. This establishes user gesture + audio context, and subsequent SC widget plays may be allowed. Many music sites do this (Spotify web, Bandcamp).

### B. Replace SC widget with direct Audio element
Fetch the actual stream URL from SoundCloud's API (or a proxy) and play it via `new Audio(streamUrl)`. This gives full control over the audio element and avoids all cross-origin iframe issues. Downside: SC's API requires authentication and their stream URLs are transient/signed.

### C. Use SC widget in visible mode
Make the SC widget iframe visible (small player bar at bottom). Safari may be more lenient with visible iframes that the user can see and interact with directly. This changes the UX but might be the simplest reliable fix.

### D. Double-load workaround
Since the second play attempt usually works, automatically retry: if the PLAY event doesn't fire within N seconds, call `scWidget.load()` again. This is hacky but matches the observed behavior that "second try works." The existing `startPlayTimeout` does something similar but with a 5s+5s delay — could be made more aggressive.

### E. Investigate Safari's media session API
Safari supports the Media Session API. Registering a media session before the first play might signal to Safari that the page intends to play audio, potentially relaxing autoplay restrictions. Untested.

### F. Proxy the SC player
Host a copy of the SC widget player on the same origin (omarnema.com) to eliminate cross-origin restrictions entirely. Legal/ToS concerns aside, this would give full control. Probably not viable.
