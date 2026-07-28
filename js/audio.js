// ═══════════════════════════════════════════
// Playback state machine
// ═══════════════════════════════════════════
// ?noplay query param suppresses all audio playback (for automated testing)
const AUDIO_SUPPRESSED = new URLSearchParams(window.location.search).has('noplay');

let currentlyPlayingId = null;
let currentBackend = null; // "sc" | "mc" | null
let scWidget = null;
let scWidgetReady = false;
let mcWidget = null;
let progressInterval = null;
let isSeeking = false;
let playingSetOffset = 0;   // track start offset in set (ms)
let scPlayTimeout = null;
let scMuteGuard = null; // interval that keeps the SC widget muted until the intro-skip seek lands
let scAudibleTimer = null; // fallback timer that flips the card to "playing" if PLAY_PROGRESS never fires
let scSetupSeq = 0; // bumped per setupScWidget so stale closures (same node re-setup) can self-disarm

// Loose URL identity for comparing a widget sound's permalink to the URL we
// asked it to load — dead loads leave the PREVIOUS sound in the widget, so
// getCurrentSound answering is only meaningful if it answers the right sound.
function scUrlKey(u) {
  return (u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '');
}

// SoundCloud sometimes refuses to STREAM a track while happily serving its
// metadata (geo/label blocks — they vary by IP and day, so a track can work one
// day and not the next). When playback detects this, we mark the track option
// as blocked on every rendered toggle for the node so the user can see why it
// won't play and tap "mixed" themselves. The user's source choice is NEVER
// switched automatically.
function markTrackDead(nodeId) {
  const node = nodeMap[nodeId];
  if (!node) return;
  node.scTrackDead = true;
  const tip = 'SoundCloud can’t stream this track right now — try mixed';
  document.querySelectorAll('.source-toggle').forEach(toggle => {
    if (toggle.dataset.nodeId !== String(nodeId)) return;
    toggle.setAttribute('data-disabled-tip', tip);
    const opt = toggle.querySelector('.src-opt[data-source="track"]');
    if (opt) {
      opt.classList.add('disabled');
      opt.setAttribute('aria-disabled', 'true');
      opt.setAttribute('data-tip', tip);
      opt.innerHTML = `${BLOCKED_ICON}<span class="src-label">track</span>`;
    }
  });
}
// Tracks whether the user has paused/stopped the current playback. A backend's
// load is async: it fires READY (and auto_play) some time after we call load().
// Without this flag, a pause issued during that window is silently overridden
// when the media finishes loading and auto-plays. Every code path that resumes
// audio must honor this intent, and every fresh play() intent must clear it.
let userPaused = false;
const ASSUMED_TRACK_DUR = 5 * 60 * 1000; // 5 min fallback for set tracks
var seekResumeDelay = 300;

function clearPlayTimeout() {
  if (scPlayTimeout) { clearTimeout(scPlayTimeout); scPlayTimeout = null; }
}

// Safety net: if auto_play doesn't fire within timeout, fall back.
// Only retry play() if the widget has signalled READY.
function startPlayTimeout(nodeId, fallbackToSet) {
  clearPlayTimeout();
  scPlayTimeout = setTimeout(() => {
    if (currentlyPlayingId !== nodeId) return;
    const card = findCardForNode(nodeId);
    const stillLoading = card && card.classList.contains('loading');
    if (!stillLoading) return; // PLAY fired, all good
    if (userPaused) return;    // user cancelled while loading — don't resurrect play
    // Only retry if widget is actually ready
    if (scWidgetReady) {
      try { scWidget.play(); } catch (e) {}
    }
    // Give it one more chance, then give up
    scPlayTimeout = setTimeout(() => {
      if (currentlyPlayingId !== nodeId) return;
      const c = findCardForNode(nodeId);
      if (c && c.classList.contains('loading')) {
        resetCardUI(nodeId);
        currentlyPlayingId = null;
        currentBackend = null;
        if (fallbackToSet) {
          const node = nodeMap[nodeId];
          if (node && node.setUrl) { setSelectedAudioSource(nodeId, 'mix'); playSet(nodeId); }
        }
      }
    }, 5000);
  }, 5000);
}

// SC widget iframe is pre-loaded with the bare SC player (no track).
// This avoids CORS errors from dummy tracks while keeping the widget
// ready for immediate use when the user clicks play.
let scWidgetInitQueue = null;
function initSCWidget() {
  if (scWidget) return true;
  try {
    if (typeof SC === 'undefined' || !SC.Widget) return false;
    const iframe = document.getElementById('sc-widget');
    scWidget = SC.Widget(iframe);
    return true;
  } catch (e) {
    console.warn('SC Widget init failed:', e);
    return false;
  }
}


// ── Safari desktop cold-start priming ──
// Desktop Safari silently refuses the FIRST play attempt of every page load (its
// autoplay policy vs the cross-origin SoundCloud iframe); the second attempt
// works. Root cause: WebKit stamps every new HTMLMediaElement with a
// user-gesture requirement at creation, and SC.Widget.load() RE-NAVIGATES the
// iframe, so each attempt gets a fresh restricted element. The widget creates
// that element lazily (~1s, at first playback), so the first attempt's gesture
// arrives with nothing to act on and is wasted; the second attempt succeeds
// because the first left an initialized element behind, and unlocking it trips a
// page-lifetime sticky bit.
//
// The gesture was never the active ingredient — an initialized element is, and
// load(..., auto_play:true) creates one with or without a gesture (Safari just
// denies the playback silently). So we prime once at setup instead of spending
// the user's first click. That also covers the two flows a click-driven primer
// missed: landing straight on /shuffle and pressing Play first, and the default
// Dig → Shuffle → Play journey, where no seed exists yet at the tab click so the
// Play click itself got consumed.
//
// Gated to desktop Safari ONLY. Every other browser — and mobile Safari, which
// already works via its visible widget — never primes and is untouched. The gate
// matters: on an autoplay-permissive browser this load could actually play.
const IS_DESKTOP_SAFARI = (() => {
  const ua = navigator.userAgent || '';
  const isSafari = /Safari\//.test(ua) && !/Chrom(e|ium)|CriOS|FxiOS|Edg|OPR|OPiOS|Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS reports as Mac
  return isSafari && !isIOS;
})();

let safariPrimed = false;
let safariPrimePoll = null;
function armSafariAudioPrime() {
  if (!IS_DESKTOP_SAFARI) return; // no-op on every other browser

  const tryPrime = () => {
    if (safariPrimed) return true;
    // Never prime over real playback — the user got there first, and the widget
    // is already unlocked by definition.
    if (currentlyPlayingId != null) { safariPrimed = true; return true; }
    if (!initSCWidget()) return false; // SC API not ready yet — keep waiting
    // Any real SoundCloud URL will do; all we need is for the widget to build a
    // media element. Prefer an individual track (fastest to resolve).
    let seed = null;
    if (typeof nodeMap !== 'undefined' && nodeMap) {
      for (const k in nodeMap) { const n = nodeMap[k]; if (n && n.scTrackUrl) { seed = n.scTrackUrl; break; } }
      if (!seed) for (const k in nodeMap) {
        const n = nodeMap[k]; if (n && n.setUrl && /soundcloud\.com/.test(n.setUrl)) { seed = n.setUrl; break; }
      }
    }
    if (!seed) return false; // graph not loaded yet (e.g. still on Dig) — keep waiting
    safariPrimed = true;
    try {
      scWidget.setVolume(0);
      scWidget.load(seed, { auto_play: true, show_artwork: false, visual: false,
        callback: () => { try { scWidget.setVolume(0); scWidget.play(); } catch (e) {} } });
      // Silence the throwaway once it has done its job — but never touch a real
      // playback the user may have started in the meantime.
      setTimeout(() => {
        if (currentlyPlayingId != null) return;
        try { scWidget.pause(); scWidget.seekTo(0); } catch (e) {}
      }, 1500);
    } catch (e) {}
    return true;
  };

  // The seed lives in the graph, which isn't loaded on the Dig landing page, so
  // poll until it appears rather than hanging the primer off a user click.
  if (tryPrime()) return;
  let tries = 0;
  safariPrimePoll = setInterval(() => {
    if (tryPrime() || ++tries > 120) { clearInterval(safariPrimePoll); safariPrimePoll = null; }
  }, 500);
}
if (typeof document !== 'undefined') armSafariAudioPrime();

function showLoading(card) {
  if (!card) return;
  card.classList.add('loading');
  const bar = card.querySelector('.progress-bar');
  if (bar) bar.classList.add('loading');
}

function hideLoading(card) {
  if (!card) return;
  card.classList.remove('loading');
  const bar = card.querySelector('.progress-bar');
  if (bar) bar.classList.remove('loading');
}

function resetCardUI(nodeId) {
  stopProgressPolling();
  const card = findCardForNode(nodeId);
  if (card) {
    card.classList.remove('playing');
    clearGlow(card);
    hideLoading(card);
    card.removeAttribute('data-source');
    const btn = card.querySelector('.play-btn');
    if (btn) btn.innerHTML = PLAY_SVG;
    const fill = card.querySelector('.bar-fill');
    if (fill) fill.style.width = '0%';
  }
}

function showScPlayer() {
  document.getElementById('sc-widget').classList.add('sc-active');
  const ph = document.getElementById('sc-placeholder');
  if (ph) ph.classList.add('hidden');
}
function hideScPlayer() {
  document.getElementById('sc-widget').classList.remove('sc-active');
  const ph = document.getElementById('sc-placeholder');
  if (ph) ph.classList.remove('hidden');
}

function stopCurrentPlayback() {
  clearPlayTimeout();
  if (scMuteGuard) { clearInterval(scMuteGuard); scMuteGuard = null; }
  if (scAudibleTimer) { clearTimeout(scAudibleTimer); scAudibleTimer = null; }
  // Suppress any in-flight load from auto-playing after this stop. A fresh
  // play() (playSC/playSCSet/playMixcloud) clears the flag again.
  userPaused = true;
  if (!currentlyPlayingId) return;
  if (currentBackend === 'sc' && scWidget) {
    try { scWidget.pause(); } catch (e) {}
    hideScPlayer();
  } else if (currentBackend === 'mc') {
    hideMcPlayer();
  }
  resetCardUI(currentlyPlayingId);
  currentlyPlayingId = null;
  currentBackend = null;
}

function onPlaybackEnded() {
  if (currentlyPlayingId) {
    hideScPlayer();
    resetCardUI(currentlyPlayingId);
    currentlyPlayingId = null;
    currentBackend = null;
  }
}

// ── Progress bar: polling + seek ──

function stopProgressPolling() {
  if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
}

function startProgressPolling() {
  stopProgressPolling();
  progressInterval = setInterval(() => {
    if (isSeeking || !currentlyPlayingId) return;
    const card = findCardForNode(currentlyPlayingId);
    if (!card) return;
    const fill = card.querySelector('.bar-fill');
    if (!fill) return;

    function updateBar(pos, dur) {
      if (dur <= 0 || isSeeking) return;
      let pct;
      if (playingSetOffset > 0) {
        const elapsed = pos - playingSetOffset;
        pct = Math.max(0, Math.min((elapsed / ASSUMED_TRACK_DUR) * 100, 100));
      } else {
        pct = Math.min((pos / dur) * 100, 100);
      }
      fill.style.width = pct + '%';
    }

    if (currentBackend === 'sc' && scWidget && scWidgetReady) {
      scWidget.getPosition(pos => {
        scWidget.getDuration(dur => updateBar(pos, dur));
      });
    } else if (currentBackend === 'mc' && mcWidget) {
      Promise.all([mcWidget.getPosition(), mcWidget.getDuration()]).then(([pos, dur]) => {
        updateBar(pos, dur);
      }).catch(() => {});
    }
  }, 250);
}

function seekToFraction(frac) {
  frac = Math.max(0, Math.min(1, frac));
  if (playingSetOffset > 0) {
    // Seek within the track's segment of the set
    const targetMs = playingSetOffset + (ASSUMED_TRACK_DUR * frac);
    if (currentBackend === 'sc' && scWidget && scWidgetReady) {
      scWidget.seekTo(targetMs);
    } else if (currentBackend === 'mc' && mcWidget) {
      mcWidget.seek(targetMs / 1000).catch(() => {});
    }
  } else {
    if (currentBackend === 'sc' && scWidget && scWidgetReady) {
      scWidget.getDuration(dur => {
        if (dur > 0) scWidget.seekTo(dur * frac);
      });
    } else if (currentBackend === 'mc' && mcWidget) {
      mcWidget.getDuration().then(dur => {
        if (dur > 0) mcWidget.seek(dur * frac);
      }).catch(() => {});
    }
  }
}

function initProgressBarInteraction(card) {
  const bar = card.querySelector('.progress-bar');
  if (!bar) return;

  function getFrac(e) {
    const rect = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function updateVisual(frac) {
    const fill = card.querySelector('.bar-fill');
    const pct = frac * 100;
    if (fill) fill.style.width = pct + '%';
  }

  bar.addEventListener('pointerdown', e => {
    const nodeId = card.getAttribute('data-node-id');
    if (nodeId !== currentlyPlayingId) return;
    // Go+ snippets reject seeks (SC restarts the 30s preview instead) — the bar
    // shows a not-allowed cursor + tooltip, so swallow the gesture entirely.
    if (card.classList.contains('snipped') && card.getAttribute('data-source') === 'soundcloud') return;
    e.preventDefault();
    e.stopPropagation();
    isSeeking = true;
    bar.classList.add('dragging');
    bar.setPointerCapture(e.pointerId);
    const frac = getFrac(e);
    updateVisual(frac);

    function onMove(ev) { updateVisual(getFrac(ev)); }

    function onUp(ev) {
      bar.classList.remove('dragging');
      bar.releasePointerCapture(ev.pointerId);
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      bar.removeEventListener('pointercancel', onUp);
      const finalFrac = getFrac(ev);
      updateVisual(finalFrac);
      seekToFraction(finalFrac);
      setTimeout(() => { isSeeking = false; }, seekResumeDelay);
    }

    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
    bar.addEventListener('pointercancel', onUp);
  });
}

function prepareCardForPlayback(nodeId, source) {
  const card = findCardForNode(nodeId);
  const btn = card ? card.querySelector('.play-btn') : null;
  if (btn) btn.innerHTML = PAUSE_SVG;
  if (card) {
    showLoading(card);
    card.setAttribute('data-source', source);
    // Point the SoundCloud badge at whatever is actually playing — the isolated
    // track, or the set at its timestamp when playing mixed. No href for
    // Mixcloud playback (the badge stays hidden there anyway).
    const scBadge = card.querySelector('.sc-badge');
    if (scBadge) {
      const href = source === 'set' ? scBadge.dataset.scSet
                 : source === 'soundcloud' ? scBadge.dataset.scTrack : '';
      if (href) scBadge.setAttribute('href', href);
      else scBadge.removeAttribute('href');
    }
  }
  return { card, btn };
}

function getScLoadOpts() {
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim().replace('#', '');
  return { auto_play: true, show_artwork: false, visual: false, show_teaser: false, sharing: false, buying: false, show_user: true, color: accent || '3C3CFA' };
}

function setupScWidget(nodeId, card, offsetSec, onError) {
  scWidgetReady = false;
  scWidget.unbind(SC.Widget.Events.READY);
  scWidget.unbind(SC.Widget.Events.PLAY);
  scWidget.unbind(SC.Widget.Events.PLAY_PROGRESS);
  scWidget.unbind(SC.Widget.Events.FINISH);
  scWidget.unbind(SC.Widget.Events.ERROR);

  const seekMs = offsetSec > 0 ? offsetSec * 1000 : 0;
  let seekLanded = !seekMs;
  // The SC widget iframe is shared across track/mix. When we swap sources we
  // resume the previously-loaded sound for ~0.5s before load() swaps in the new
  // one (see playSC/playSCSet), which fires a stale PLAY event. Until THIS load's
  // content is actually ready, that stale PLAY must not start the mute guard —
  // otherwise the guard reads the OLD sound's position, can conclude the seek has
  // "landed," unmute, and let the new set play from 0:00. This per-setup flag
  // gates every PLAY handler action on the new sound being loaded.
  let loadReady = false;
  if (scMuteGuard) { clearInterval(scMuteGuard); scMuteGuard = null; }
  if (scAudibleTimer) { clearTimeout(scAudibleTimer); scAudibleTimer = null; }

  // Flip the card from "loading" (shimmer) to "playing" (EQ badge + glow) only
  // once audio is actually audible. The PLAY event alone leads the sound by
  // 1-2s: the stream is still buffering, and for sets the widget is muted while
  // the intro-skip seek lands. Callers: the mute guard at the moment it unmutes
  // (sets), PLAY_PROGRESS once the position is advancing (tracks), and a
  // fallback timer so the card can never stick on shimmer. Idempotent.
  const mySeq = ++scSetupSeq;
  let audibleShown = false;
  function showAudible() {
    if (audibleShown || userPaused || currentlyPlayingId !== nodeId) return;
    if (mySeq !== scSetupSeq) return; // superseded setup (e.g. fallback re-play of the same node)
    audibleShown = true;
    clearPlayTimeout(); // audio confirmed — stand down the stuck-load safety net
    if (card) {
      hideLoading(card);
      card.classList.add('playing');
      applyGlow(card);
      // Button state is authoritative here — otherwise a source switch
      // (track → mix) can leave "play" showing while audio plays.
      const btn = card.querySelector('.play-btn');
      if (btn) btn.innerHTML = PAUSE_SVG;
    }
  }

  // Seek to the track's offset within the set (usually deep — median ~35 min).
  // SC swallows a seek issued before playback truly begins, so we keep the widget
  // muted and re-assert the seek until the position actually lands, then unmute.
  // Crucially we do NOT re-issue seekTo every tick: a deep seek needs SC to fetch a
  // new stream segment, and spamming seekTo restarts that fetch so it never lands.
  // We issue once, wait for it to buffer, and only re-seek if it clearly stalled.
  function startScMuteGuard() {
    if (!seekMs || scMuteGuard) return;
    const started = Date.now();
    let lastSeekAt = 0;
    const RESEEK_GRACE = 1500; // give a seek this long to buffer before re-issuing
    const BAIL_MS = 12000;     // deep seeks need more than the old 5s to land
    scMuteGuard = setInterval(() => {
      if (seekLanded) { clearInterval(scMuteGuard); scMuteGuard = null; return; }
      // Bail out (and restore volume) if the seek never lands, so audio is never
      // stuck silent.
      if (Date.now() - started > BAIL_MS) {
        seekLanded = true;
        try { scWidget.setVolume(100); } catch (e) {}
        clearInterval(scMuteGuard); scMuteGuard = null;
        showAudible(); // unmuted → audible now, wherever the position ended up
        return;
      }
      if (userPaused) return; // hold muted; don't fight a user pause with seek/play
      scWidget.getPosition(pos => {
        // Re-check: a pause may have landed while getPosition was in flight.
        // seekTo on a paused widget un-pauses it (Safari), so bail if paused now.
        if (userPaused) return;
        if (pos >= seekMs - 500) {
          seekLanded = true;
          try { scWidget.setVolume(100); } catch (e) {}
          if (scMuteGuard) { clearInterval(scMuteGuard); scMuteGuard = null; }
          showAudible(); // seek landed and volume restored — audio starts now
        } else if (Date.now() - lastSeekAt > RESEEK_GRACE) {
          // Not there yet and the last seek has had time to land — (re)issue it.
          lastSeekAt = Date.now();
          try { scWidget.setVolume(0); scWidget.seekTo(seekMs); } catch (e) {}
        } else {
          // A seek is in flight; stay muted and let it buffer.
          try { scWidget.setVolume(0); } catch (e) {}
        }
      });
    }, 100);
  }

  // Fires once THIS load's sound is ready, driven exclusively by SC's per-load
  // load() callback. We deliberately do NOT use the READY event: the SC widget
  // iframe is shared, and binding READY on an already-ready widget fires it
  // immediately against the PREVIOUS sound — which would seek/play/guard the wrong
  // track and let the new set unmute at 0:00. The load() callback is the only
  // signal that the NEW sound is actually loaded. Idempotent.
  function onLoadReady() {
    if (loadReady) return;
    loadReady = true;
    scWidgetReady = true;
    if (seekMs) { try { scWidget.setVolume(0); scWidget.seekTo(seekMs); } catch (e) {} }
    // Respect a pause the user issued while the set was still loading.
    if (userPaused) return;
    try { scWidget.play(); } catch (e) {}
  }

  scWidget.bind(SC.Widget.Events.PLAY, () => {
    // auto_play (or a stray play) can fire this after the user paused mid-load.
    // Immediately re-pause so the load never overrides the user's intent.
    if (userPaused) { try { scWidget.pause(); } catch (e) {} return; }
    // Ignore the stale PLAY from the previously-loaded sound resuming before this
    // load swapped in — acting on it would start the mute guard against the wrong
    // sound's position and let the new set unmute at 0:00.
    if (!loadReady) return;
    showScPlayer();
    if (seekMs && !seekLanded) {
      // The guard owns recovery from here (12s bail) — stand down the play
      // timeout so its 10s reset can't fire mid-seek. Card stays on shimmer;
      // the guard calls showAudible() when it unmutes.
      clearPlayTimeout();
      startScMuteGuard();
    } else {
      // NB: the play timeout stays armed here — PLAY alone doesn't prove audio.
      // A stale PLAY (old sound resuming pre-swap) or a stream-blocked track
      // fires PLAY with the position pinned at 0; if audio never rolls, the
      // timeout's 10s stage recovers (fallback to mix / reset). showAudible()
      // stands it down once audio is confirmed.
      try { scWidget.setVolume(100); } catch (e) {} // recover if a prior set left it muted
      // The audible flip comes from PLAY_PROGRESS (position actually advancing).
      // Fallback: if that event never fires, flip only if the position really
      // moved — a dead stream must keep the shimmer so the timeout can recover.
      if (!audibleShown && !scAudibleTimer) scAudibleTimer = setTimeout(() => {
        scAudibleTimer = null;
        try { scWidget.getPosition(p => { if (p > 0) showAudible(); }); } catch (e) {}
      }, 3000);
    }
    startProgressPolling();
  });
  scWidget.bind(SC.Widget.Events.PLAY_PROGRESS, e => {
    if (!loadReady || userPaused) return;
    if (seekMs && !seekLanded) return; // muted intro-skip still in flight — not audible
    if (e && e.currentPosition > 0) showAudible();
  });
  scWidget.bind(SC.Widget.Events.FINISH, onPlaybackEnded);
  scWidget.bind(SC.Widget.Events.ERROR, onError);
  return onLoadReady;
}

// ── SoundCloud Go+ snippet detection ──
// Go+-only tracks stream as 30s previews for anonymous listeners. The widget's
// sound object exposes this upfront (policy "SNIP", duration capped at 30000 vs
// full_duration) — getDuration() does NOT, it reports the full length. Verdicts
// are cached in localStorage so known tracks show the badge on future loads.
// Bump the version suffix to invalidate every cached verdict on deploy — use it
// whenever the detection logic changes so stale/false positives can't linger.
// v2: added the permalink guard below + reset misfires cached under the old key.
const SNIP_CACHE_KEY = 'scSnipCache:v2';
let scSnipCache = {};
try { scSnipCache = JSON.parse(localStorage.getItem(SNIP_CACHE_KEY) || '{}'); } catch (e) {}
// Drop the pre-versioning cache so old false positives (e.g. a full track
// mis-flagged from a stale sound read) don't survive this fix.
try { localStorage.removeItem('scSnipCache'); } catch (e) {}

function markSnipped(nodeId) {
  const card = findCardForNode(nodeId);
  if (card) card.classList.add('snipped');
}

function checkScSnip(nodeId, trackUrl, attempt = 0) {
  if (!trackUrl || !scWidget) return;
  if (trackUrl in scSnipCache) {
    if (scSnipCache[trackUrl]) markSnipped(nodeId);
    return;
  }
  try {
    scWidget.getCurrentSound(sound => {
      if (currentlyPlayingId !== nodeId) return;
      // Sound metadata can lag READY/load by several seconds on slow loads —
      // keep retrying while this node is still the current one (~9s total).
      if (!sound || !sound.duration) {
        if (attempt < 15) setTimeout(() => checkScSnip(nodeId, trackUrl, attempt + 1), 600);
        return;
      }
      // The SC widget is shared: right after load() getCurrentSound can still
      // report the PREVIOUS track's sound. Never cache a verdict read from a
      // different sound than the one we're evaluating — that's how a full track
      // gets a stale snippet's SNIP verdict pinned to its URL. Retry until the
      // widget reports the track we asked for (mirrors the dead-track guard).
      if (sound.permalink_url && scUrlKey(sound.permalink_url) !== scUrlKey(trackUrl)) {
        if (attempt < 15) setTimeout(() => checkScSnip(nodeId, trackUrl, attempt + 1), 600);
        return;
      }
      const snipped = sound.policy === 'SNIP' ||
        (sound.full_duration > 0 && sound.full_duration - sound.duration > 1000);
      scSnipCache[trackUrl] = snipped;
      try { localStorage.setItem(SNIP_CACHE_KEY, JSON.stringify(scSnipCache)); } catch (e) {}
      if (snipped) markSnipped(nodeId);
    });
  } catch (e) {}
}

function playSC(nodeId, trackUrl) {
  if (AUDIO_SUPPRESSED) return;
  // If the SC widget API isn't available nothing SC-hosted can play — bail
  // without touching the user's source choice.
  if (!initSCWidget()) return;

  const { card } = prepareCardForPlayback(nodeId, 'soundcloud');
  currentlyPlayingId = nodeId;
  currentBackend = 'sc';
  playingSetOffset = 0;
  userPaused = false;

  // The track can't play (stream refused / removed / widget error): stop the
  // shimmer, reset the card, and mark the track option as blocked so the user
  // can see why and choose "mixed" themselves. NEVER auto-switch their source.
  const abandonDeadTrack = () => {
    hideScPlayer();
    resetCardUI(nodeId);
    currentlyPlayingId = null;
    currentBackend = null;
    markTrackDead(nodeId);
  };
  const onLoadReady = setupScWidget(nodeId, card, 0, abandonDeadTrack);
  // Identifies THIS track load. A later playSCSet/playSC (e.g. the user
  // switching to mixed mid-load) bumps the seq — any still-pending dead-check
  // for this load must then stand down instead of clobbering the new playback.
  const myLoadSeq = scSetupSeq;

  showScPlayer();
  // Call play() synchronously in the user gesture so Safari unlocks iframe audio.
  // Mute first (all browsers): the widget is shared, so this play() briefly resumes
  // the previously-loaded (paused) track until load() swaps in the new one. Muting
  // keeps that ~0.5s leak silent; the PLAY handler restores volume for the new track.
  try { scWidget.setVolume(0); scWidget.play(); } catch (e) {}
  scWidget.load(trackUrl, { ...getScLoadOpts(), callback: () => {
    onLoadReady();
    checkScSnip(nodeId, trackUrl);
    // Dead-track detection: removed / region-blocked tracks reach this callback
    // and fire READY, but never stream — play() is silently ignored, leaving a
    // dead play button. Verified after a settle delay: right at the callback the
    // sound can still report playable=true (or be the previous sound); by ~1.5s
    // the widget has discovered stream refusals and playable flips to false
    // (geo/label blocks vary by IP, hence "worked yesterday, not today"). Dead
    // signatures: null sound, playable === false, a permalink that isn't what we
    // loaded, or getCurrentSound not answering at all. Resolves in ~1.5-4s
    // instead of the 10s play-timeout; skipped once the card left "loading"
    // (audio flowing) or the user cancelled/switched away.
    const stillMine = () => scSetupSeq === myLoadSeq && currentlyPlayingId === nodeId && !userPaused &&
      (c => c && c.classList.contains('loading'))(findCardForNode(nodeId));
    setTimeout(() => {
      if (!stillMine()) return;
      let answered = false;
      const deadTimer = setTimeout(() => { if (!answered && stillMine()) abandonDeadTrack(); }, 2500);
      try {
        scWidget.getCurrentSound(s => {
          answered = true;
          clearTimeout(deadTimer);
          const dead = !s || s.playable === false ||
            (s.permalink_url && scUrlKey(s.permalink_url) !== scUrlKey(trackUrl));
          if (dead && stillMine()) abandonDeadTrack();
        });
      } catch (e) { clearTimeout(deadTimer); }
    }, 1500);
  } });
  // No fallbackToSet: if audio still hasn't started after 10s the card resets,
  // but the user's track/mixed choice is left alone.
  startPlayTimeout(nodeId, false);
}

function playSCSet(nodeId, setUrl, offsetSec) {
  if (AUDIO_SUPPRESSED) return;
  if (!initSCWidget()) return;

  // Tracks that start at 0:00 (or have no/negative offset) begin with the set's
  // intro (e.g. the NTS sting). Nudge past it so playback opens on the actual music.
  offsetSec = offsetSec > 0 ? offsetSec : 7;

  const { card } = prepareCardForPlayback(nodeId, 'set');
  currentlyPlayingId = nodeId;
  currentBackend = 'sc';
  playingSetOffset = offsetSec ? offsetSec * 1000 : 0;
  userPaused = false;

  const onLoadReady = setupScWidget(nodeId, card, offsetSec, () => { hideScPlayer(); onPlaybackEnded(); });

  showScPlayer();
  // Call play() synchronously in the user gesture so Safari unlocks iframe audio.
  // Mute first (all browsers): the widget is shared, so this play() briefly resumes
  // the previously-loaded track until load() swaps in the set. Muting keeps that
  // ~0.5s leak silent; the load callback / mute guard hold it muted through the seek.
  try { scWidget.setVolume(0); scWidget.play(); } catch (e) {}
  scWidget.load(setUrl, { ...getScLoadOpts(), callback: onLoadReady });
  startPlayTimeout(nodeId, false);
}

function showMcPlayer() {
  document.getElementById('mc-player').classList.add('visible');
}

function hideMcPlayer() {
  const player = document.getElementById('mc-player');
  player.classList.remove('visible');
  document.getElementById('mc-widget').src = 'about:blank';
  mcWidget = null;
}

function playMixcloud(nodeId, mixcloudUrl, offsetSec) {
  if (AUDIO_SUPPRESSED) return;
  // Skip the set intro (e.g. the NTS sting) for tracks with no/zero/negative offset.
  offsetSec = offsetSec > 0 ? offsetSec : 7;
  const { card, btn } = prepareCardForPlayback(nodeId, 'mixcloud');
  currentlyPlayingId = nodeId;
  currentBackend = 'mc';
  playingSetOffset = offsetSec ? offsetSec * 1000 : 0;
  userPaused = false;
  // Mixcloud widget needs the path, not the full URL
  const mcPath = mixcloudUrl.replace(/^https?:\/\/(www\.)?mixcloud\.com/, '');
  const iframe = document.getElementById('mc-widget');
  iframe.src = `https://www.mixcloud.com/widget/iframe/?feed=${encodeURIComponent(mcPath)}&autoplay=1`;

  showMcPlayer();

  try {
    mcWidget = Mixcloud.PlayerWidget(iframe);
    mcWidget.ready.then(() => {
      mcWidget.events.play.on(() => {
        // autoplay=1 can fire this after the user paused mid-load — re-pause.
        if (userPaused) { mcWidget.pause().catch(() => {}); return; }
        if (btn) btn.innerHTML = PAUSE_SVG;
        if (card) { hideLoading(card); card.classList.add('playing'); applyGlow(card); }
        startProgressPolling();
      });
      mcWidget.events.pause.on(() => {
        if (btn) btn.innerHTML = PLAY_SVG;
        if (card) card.classList.remove('playing');
      });
      // Seek after a delay to let the player buffer, then verify it stuck
      if (offsetSec) {
        setTimeout(() => {
          mcWidget.seek(offsetSec);
          // Verify seek landed — retry if it reset to near 0
          setTimeout(() => {
            mcWidget.getPosition().then(pos => {
              if (pos < offsetSec * 0.5) mcWidget.seek(offsetSec);
            });
          }, 2000);
        }, 1500);
      }
    });
  } catch (e) {
    console.warn('Mixcloud widget failed:', e);
    hideMcPlayer();
    onPlaybackEnded();
  }
}

function playSet(nodeId) {
  if (AUDIO_SUPPRESSED) return false;
  const node = nodeMap[nodeId];
  if (!node || !node.setUrl) return false;

  if (node.setSource === 'mixcloud') {
    playMixcloud(nodeId, node.setUrl, node.setOffsetSec);
  } else {
    playSCSet(nodeId, node.setUrl, node.setOffsetSec);
  }
  return true;
}

function findCardForNode(nodeId) {
  return document.querySelector(`.node-card[data-node-id="${nodeId}"]`)
      || document.querySelector(`.mobile-carousel-card[data-node-id="${nodeId}"]`);
}

// Play a node honoring the user's "from track" / "from mix" choice.
function playSelectedAudioSource(nodeId) {
  const node = nodeMap[nodeId];
  if (!node) return;
  const source = getSelectedAudioSource(nodeId);
  if (source === 'mix' && mixPlayable(node)) { playSet(nodeId); return; }
  if (node.scTrackUrl) { playSC(nodeId, node.scTrackUrl); return; }
  if (mixPlayable(node)) { playSet(nodeId); }
}

function togglePlay(nodeId) {
  const node = nodeMap[nodeId];
  if (!node) return;

  const hasAudio = node.scTrackUrl || node.setUrl;
  if (!hasAudio) return;

  const card = findCardForNode(nodeId);
  const btn = card ? card.querySelector('.play-btn') : null;

  // Same track — toggle pause/play (or cancel loading)
  if (currentlyPlayingId === nodeId) {
    const isLoading = card && card.classList.contains('loading');
    if (isLoading) {
      stopCurrentPlayback();
      return;
    }
    const isPlaying = card && card.classList.contains('playing');
    if (isPlaying) {
      userPaused = true;
      // Tear down the intro-skip guard so it can't re-assert seek/play after pause.
      if (scMuteGuard) { clearInterval(scMuteGuard); scMuteGuard = null; }
      if (currentBackend === 'sc' && scWidget) try { scWidget.pause(); } catch(e) {}
      else if (currentBackend === 'mc' && mcWidget) try { mcWidget.pause(); } catch(e) {}
      if (btn) btn.innerHTML = PLAY_SVG;
      if (card) card.classList.remove('playing');
    } else {
      userPaused = false;
      if (currentBackend === 'sc' && scWidget) scWidget.play();
      else if (currentBackend === 'mc' && mcWidget) mcWidget.play();
      if (btn) btn.innerHTML = PAUSE_SVG;
      if (card) { card.classList.add('playing'); applyGlow(card); }
    }
    return;
  }

  // Different track — stop current, start new
  trackEvent('play');
  stopCurrentPlayback();
  playSelectedAudioSource(nodeId);
}
