/**
 * Safari desktop cold-start playback — REAL Safari via safaridriver.
 *
 * The desktop-Safari "first play is silent" bug and its wasted-gesture fix
 * CANNOT be tested in Playwright/WebKit — WebKit is stricter than real Safari
 * and gives false verdicts (a fix that works in real Safari looks broken there,
 * and vice-versa). This suite drives REAL Safari over the W3C WebDriver protocol
 * (safaridriver), where WebDriver clicks count as genuine user gestures.
 *
 * Two cases against the app (which ships the fix):
 *   A. NEGATIVE CONTROL — play as the very FIRST gesture (no preceding gesture):
 *      same-gesture priming can't help, so it stays SILENT. Proves the bug is
 *      real and the position-advance detector actually detects silence.
 *   B. THE FIX — one ordinary gesture (click the search box) BEFORE the play
 *      click, so the in-app primer has spent the first gesture: cold play PLAYS.
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
const fs = require('fs');

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

async function runCase(label, primeGesture) {
  const s = await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
  const S = (p) => `/session/${s.sessionId}${p}`;
  const js = (script) => wd('POST', S('/execute/sync'), { script, args: [] });
  const click = async (sel) => { const el = await wd('POST', S('/element'), { using: 'css selector', value: sel });
    return wd('POST', S(`/element/${Object.values(el)[0]}/click`), {}); };
  try {
    await wd('POST', S('/timeouts'), { script: 30000, pageLoad: 60000, implicit: 0 });
    await wd('POST', S('/window/rect'), { width: 1440, height: 900 });
    await wd('POST', S('/url'), { url: SITE });
    await sleep(6000);
    // programmatic setup (isTrusted:false — does NOT count as a gesture / does not prime)
    await js(`var x=document.querySelector('#onboarding-overlay .ob-close, #onboarding-overlay button'); if(x)x.click();
              var t=document.querySelector('#mode-tabs .mode-tab[data-mode="tracks"]'); if(t)t.click(); return 1;`).catch(() => {});
    for (let i = 0; i < 100; i++) {
      const n = await js('return document.querySelectorAll(\'.node-card[data-rank="root"] .play-btn\').length');
      if (n > 0) break;
      if (i === 20 || i === 50) await js(`var t=document.querySelector('#mode-tabs .mode-tab[data-mode="tracks"]'); if(t)t.click();
              var b=document.getElementById('filter-shuffle-btn'); if(b)b.click(); return 1;`).catch(() => {});
      await sleep(500);
    }
    const pick = () => js(`
      var el=Array.from(document.querySelectorAll('.node-card')).find(function(c){ var n=nodeMap[c.getAttribute('data-node-id')];
        return n && n.setUrl && (typeof mixPlayable!=='function'||mixPlayable(n)) && c.querySelector('.play-btn'); });
      if(!el) return null; var id=el.getAttribute('data-node-id'); setSelectedAudioSource(id,'mix'); el.setAttribute('data-target','1');
      return { title: nodeMap[id].title };`);
    const t = await pick();
    if (!t) { console.log(`  [${label}] no mix card — inconclusive`); return null; }

    if (primeGesture) {
      // one ordinary user gesture BEFORE play — native click = genuine gesture
      let did = false;
      for (const sel of ['#filter-search', 'input[type="text"]', '#site-title', '#theme-toggle']) {
        try { await click(sel); did = true; break; } catch (e) {}
      }
      if (!did) { console.log(`  [${label}] no neutral element to click — inconclusive`); return null; }
      await sleep(6000); // let the priming load settle
      await pick(); // re-select in case of re-render
    }

    await js(PROBE);
    await click('.node-card[data-target] .play-btn'); // the cold play gesture
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

  // Start safaridriver if nothing is listening on 4444.
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
    console.log('\nA. NEGATIVE CONTROL — play as the first gesture (expect SILENT):');
    const a = await runCase('control', false);
    console.log('\nB. THE FIX — one neutral gesture before play (expect PLAYED):');
    const b = await runCase('fixed', true);

    console.log('\n════════ RESULT ════════');
    if (a === null || b === null) { console.log('inconclusive — no playable mix card surfaced; rerun'); }
    else {
      if (a === false) console.log('  ✓ control is SILENT (bug reproduced; detector works)');
      else { console.log('  ✗ control unexpectedly PLAYED — detector or scenario suspect'); failed = 1; }
      if (b === true) console.log('  ✓ fixed path PLAYS (wasted-gesture fix works in real Safari)');
      else { console.log('  ✗ fixed path is SILENT — the fix did NOT prime real Safari'); failed = 1; }
    }
  } finally {
    if (started) { try { process.kill(-started.pid); } catch (e) {} }
  }
  process.exit(failed);
})().catch(e => { console.error('FAILED:', e.message); process.exit(2); });
