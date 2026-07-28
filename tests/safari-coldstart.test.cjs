/**
 * Safari desktop cold-start playback — REAL Safari via safaridriver.
 *
 * Desktop Safari silently refuses the FIRST playback attempt of every page load.
 * Cause: WebKit stamps each new HTMLMediaElement with a user-gesture requirement
 * at creation, SC.Widget.load() re-navigates the iframe (so every attempt gets a
 * fresh restricted element), and the widget builds that element lazily ~1s in —
 * so the first attempt's gesture lands with nothing to act on. The fix
 * (armSafariAudioPrime in js/audio.js) does a muted throwaway load at setup so an
 * initialized element already exists when the user first presses Play. It needs
 * no user gesture, which is what lets it cover the flows below.
 *
 * This CANNOT be tested in Playwright/WebKit — WebKit is stricter than real
 * Safari and gives false verdicts in both directions. This suite drives REAL
 * Safari over W3C WebDriver, where WebDriver clicks are genuine user gestures.
 *
 *   A. NEGATIVE CONTROL — primer disabled before it can run, then play as the
 *      first gesture: SILENT. Proves the bug is real, that the position-advance
 *      detector actually detects silence, and that the primer is what fixes it.
 *   B. DEFAULT JOURNEY — Dig → Shuffle tab → Play: PLAYS. This is the flow the
 *      earlier click-driven primer missed (no seed existed at the tab click, so
 *      the Play click itself got consumed).
 *   C. PLAY IS THE ONLY CLICK — e.g. landing straight on a shared /shuffle link:
 *      PLAYS, because priming no longer depends on a preceding gesture.
 *
 * Verdict = SC widget position ADVANCING (never a PLAY event or a landed seek).
 *
 * Opt-in (like tests/mobile-layout.spec.js) — NOT part of `npm test`, because it
 * needs macOS + real Safari + "Allow Remote Automation". Self-skips otherwise.
 *
 *   Prereq: Safari → Develop → Allow Remote Automation.
 *   Run:    node tests/safari-coldstart.test.cjs [SITE]
 *           SITE defaults to http://127.0.0.1:8000/ (scripts/serve.py).
 */
const { execSync, spawn } = require('child_process');

const SITE = process.argv[2] || process.env.SAFARI_SITE || 'http://127.0.0.1:8000/';
const WD = 'http://localhost:4444';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function skip(reason) { console.log(`\n⚠︎  SKIPPED (safari cold-start): ${reason}`); process.exit(0); }

async function wd(method, path, body) {
  const res = await fetch(WD + path, { method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (json && json.value && json.value.error) throw new Error(`${json.value.error}: ${json.value.message}`);
  return json.value;
}
const rolled = (tl) => { let run = 0; for (let i = 1; i < tl.length; i++) { const d = tl[i].p - tl[i - 1].p;
  if (d > 50 && d < 2000) { if (++run >= 3) return true; } else run = 0; } return false; };
const PROBE = `
  window.__tl=[]; clearInterval(window.__iv); window.__t0=Date.now();
  window.__iv=setInterval(function(){ try{ if(typeof scWidget!=='undefined'&&scWidget){
    scWidget.getPosition(function(p){ window.__tl.push({t:Date.now()-window.__t0,p:Math.round(p)}); }); }}catch(e){}
  },300); return 1;`;

// mode: 'control' | 'journey' | 'only-click'
async function runCase(label, mode) {
  const s = await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
  const S = (p) => `/session/${s.sessionId}${p}`;
  const js = (script) => wd('POST', S('/execute/sync'), { script, args: [] });
  const click = async (sel) => { const el = await wd('POST', S('/element'), { using: 'css selector', value: sel });
    return wd('POST', S(`/element/${Object.values(el)[0]}/click`), {}); };
  try {
    await wd('POST', S('/timeouts'), { script: 30000, pageLoad: 60000, implicit: 0 });
    await wd('POST', S('/window/rect'), { width: 1440, height: 900 });
    await wd('POST', S('/url'), { url: SITE });
    await sleep(3000);

    // Neutralise the fix for the control, before the graph (and thus a seed) exists.
    if (mode === 'control') await js('safariPrimed = true; return 1;').catch(() => {});

    // Programmatic setup clicks are isTrusted:false, so they are NOT user gestures.
    await js(`var x=document.querySelector('#onboarding-overlay .ob-close, #onboarding-overlay button'); if(x)x.click(); return 1;`).catch(() => {});
    if (mode === 'journey') {
      await click('#mode-tabs .mode-tab[data-mode="tracks"]'); // the one genuine gesture
    } else {
      await js(`var t=document.querySelector('#mode-tabs .mode-tab[data-mode="tracks"]'); if(t)t.click(); return 1;`).catch(() => {});
    }

    for (let i = 0; i < 100; i++) {
      const n = await js('return document.querySelectorAll(\'.node-card[data-rank="root"] .play-btn\').length');
      if (n > 0) break;
      if (i === 20 || i === 50) await js(`var t=document.querySelector('#mode-tabs .mode-tab[data-mode="tracks"]'); if(t)t.click();
              var b=document.getElementById('filter-shuffle-btn'); if(b)b.click(); return 1;`).catch(() => {});
      await sleep(500);
    }

    // Let the primer complete (it fires as soon as the graph yields a seed). The
    // widget builds its media element lazily, so give that a moment to settle —
    // a Play click inside ~2s of the graph appearing can still lose the race.
    if (mode !== 'control') {
      for (let i = 0; i < 40; i++) {
        if (await js('return typeof safariPrimed !== "undefined" && safariPrimed')) break;
        await sleep(500);
      }
      await sleep(4000);
    }

    const pick = () => js(`
      var el=Array.from(document.querySelectorAll('.node-card')).find(function(c){ var n=nodeMap[c.getAttribute('data-node-id')];
        return n && n.setUrl && (typeof mixPlayable!=='function'||mixPlayable(n)) && c.querySelector('.play-btn'); });
      if(!el) return null; var id=el.getAttribute('data-node-id'); setSelectedAudioSource(id,'mix'); el.setAttribute('data-target','1');
      return { title: nodeMap[id].title };`);
    const t = await pick();
    if (!t) { console.log(`  [${label}] no mix card — inconclusive`); return null; }

    await js(PROBE);
    await click('.node-card[data-target] .play-btn');
    await sleep(15000);
    const tl = await js('clearInterval(window.__iv); return window.__tl;');
    const ok = rolled(tl);
    console.log(`  ${label}: ${ok ? 'PLAYED ✅' : 'SILENT ❌'}  ("${t.title}", last pos ${tl.length ? tl[tl.length - 1].p : 'n/a'})`);
    return ok;
  } finally { await wd('DELETE', S('')).catch(() => {}); }
}

(async () => {
  if (process.platform !== 'darwin') skip('not macOS');
  try { execSync('/usr/bin/safaridriver --version', { stdio: 'ignore' }); } catch { skip('safaridriver not available'); }
  try { const r = await fetch(SITE, { method: 'HEAD' }).catch(() => null); if (!r) skip(`site not reachable: ${SITE}`); } catch { skip(`site not reachable: ${SITE}`); }

  let started = null;
  try { await fetch(WD + '/status'); }
  catch {
    started = spawn('/usr/bin/safaridriver', ['-p', '4444'], { stdio: 'ignore', detached: true });
    await sleep(2500);
    try { await fetch(WD + '/status'); } catch { if (started) try { process.kill(-started.pid); } catch (e) {} skip('could not start safaridriver (enable Safari → Develop → Allow Remote Automation)'); }
  }

  console.log(`\n[Safari cold-start] real Safari via safaridriver — ${SITE}`);
  let failed = 0;
  try {
    console.log('\nA. NEGATIVE CONTROL — primer disabled, play as first gesture (expect SILENT):');
    const a = await runCase('control', 'control');
    console.log('\nB. DEFAULT JOURNEY — Dig → Shuffle tab → Play (expect PLAYED):');
    const b = await runCase('journey', 'journey');
    console.log('\nC. PLAY IS THE ONLY CLICK — no preceding gesture (expect PLAYED):');
    const c = await runCase('only-click', 'only-click');

    console.log('\n════════ RESULT ════════');
    if (a === null || b === null || c === null) { console.log('inconclusive — no playable mix card surfaced; rerun'); }
    else {
      if (a === false) console.log('  ✓ control is SILENT (bug reproduced; detector works; primer is what fixes it)');
      else { console.log('  ✗ control unexpectedly PLAYED — detector or scenario suspect'); failed = 1; }
      if (b === true) console.log('  ✓ default journey PLAYS');
      else { console.log('  ✗ default journey SILENT — the primer did not cover Dig → Shuffle → Play'); failed = 1; }
      if (c === true) console.log('  ✓ play-as-only-click PLAYS (priming needs no preceding gesture)');
      else { console.log('  ✗ play-as-only-click SILENT — priming still depends on a gesture'); failed = 1; }
    }
  } finally {
    if (started) { try { process.kill(-started.pid); } catch (e) {} }
  }
  process.exit(failed);
})().catch(e => { console.error('FAILED:', e.message); process.exit(2); });
