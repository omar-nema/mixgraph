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
    clearPlayTimeout();
    showScPlayer();
    if (seekMs && !seekLanded) startScMuteGuard();
    else { try { scWidget.setVolume(100); } catch (e) {} } // recover if a prior set left it muted
    if (card) {
      hideLoading(card);
      card.classList.add('playing');
      applyGlow(card);
      // Button state is authoritative from the actual PLAY event — otherwise a
      // source switch (track → mix) can leave "play" showing while audio plays.
      const btn = card.querySelector('.play-btn');
      if (btn) btn.innerHTML = PAUSE_SVG;
    }
    startProgressPolling();
  });
  scWidget.bind(SC.Widget.Events.FINISH, onPlaybackEnded);
  scWidget.bind(SC.Widget.Events.ERROR, onError);
  return onLoadReady;
}

function playSC(nodeId, trackUrl) {
  if (AUDIO_SUPPRESSED) return;
  if (!initSCWidget()) {
    const node = nodeMap[nodeId];
    if (node && node.setUrl) { setSelectedAudioSource(nodeId, 'mix'); playSet(nodeId); }
    return;
  }

  const { card } = prepareCardForPlayback(nodeId, 'soundcloud');
  currentlyPlayingId = nodeId;
  currentBackend = 'sc';
  playingSetOffset = 0;
  userPaused = false;

  const onLoadReady = setupScWidget(nodeId, card, 0, () => {
    hideScPlayer();
    resetCardUI(nodeId);
    currentlyPlayingId = null;
    currentBackend = null;
    const node = nodeMap[nodeId];
    if (node && node.setUrl) { setSelectedAudioSource(nodeId, 'mix'); playSet(nodeId); }
  });

  showScPlayer();
  // Call play() synchronously in the user gesture so Safari unlocks iframe audio.
  // Mute first (all browsers): the widget is shared, so this play() briefly resumes
  // the previously-loaded (paused) track until load() swaps in the new one. Muting
  // keeps that ~0.5s leak silent; the PLAY handler restores volume for the new track.
  try { scWidget.setVolume(0); scWidget.play(); } catch (e) {}
  scWidget.load(trackUrl, { ...getScLoadOpts(), callback: onLoadReady });
  startPlayTimeout(nodeId, true);
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
