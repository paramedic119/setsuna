// Regression suite for 刹那 / SETSUNA.
// Boots index.html in a real (headless) browser and exercises game internals
// via window.__hooks (exposed when window.__TEST__ is set). No game code is
// shipped with the test harness; this only runs in CI / locally via `npm test`.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

// --- serve the repo root over http (localStorage is unreliable on file://) ---
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path === '/' ? '/index.html' : path;
    const buf = await readFile(ROOT + file.replace(/\.\./g, ''));
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/index.html`;

const results = [];
const ok = (n, c, d = '') => results.push({ n, pass: !!c, d });
// external resources fail in CI/sandbox (no certs/network) — not our bug
const benign = /jsdelivr|cdnjs|peerjs|fonts\.g|gstatic|supabase|favicon|ERR_CERT|net::ERR|Failed to load resource/i;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 780 } })).newPage();
const consoleErrors = [], pageErrors = [];
page.on('console', m => { if (m.type() === 'error' && !benign.test(m.text())) consoleErrors.push(m.text()); });
page.on('pageerror', e => { if (!benign.test(String(e))) pageErrors.push(String(e)); });

await page.addInitScript(() => { window.__TEST__ = true; });
await page.goto(URL_, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__hooks, null, { timeout: 5000 });
await page.waitForTimeout(150);

// ---- A. Boot ----
const boot = await page.evaluate(() => ({
  state: document.body.dataset.state,
  hooks: Object.keys(window.__hooks).length,
  intRail: !!document.getElementById('intRail'),
  ticks: document.querySelectorAll('#intRail .tick').length,
}));
ok('A1 boot reaches title', boot.state === 'title', `state=${boot.state}`);
ok('A2 hooks exposed', boot.hooks > 20, `${boot.hooks} keys`);
ok('A3 intensity rail in DOM', boot.intRail);
ok('A4 intensity ticks built', boot.ticks === 5, `${boot.ticks} ticks`);

// ---- B. Tutorial completes and persists (the original bug) ----
const tut = await page.evaluate(() => {
  const h = window.__hooks; h.tutStart();
  const steps = ['orb', 'hazard', 'arrow'];
  let guard = 0;
  while (h.TUT.on && guard++ < 20) {
    if (!h.TUT.await) break;
    const type = steps[h.TUT.step];
    h.tutHit(type === 'hazard' ? 'avoid' : type);
  }
  return { done: h.tutDone, stored: (() => { try { return localStorage.getItem('setsuna_tut'); } catch { return null; } })() };
});
ok('B1 tutorial completes', tut.done === true);
ok('B2 tutorial flag persisted', tut.stored === '1', `stored=${tut.stored}`);

// ---- C. Intensity meter mirrors the difficulty curve ----
const meter = await page.evaluate(() => {
  const h = window.__hooks;
  h.setMode('survival'); h.NET.mode = 'solo';
  h.startCountdown(); h.S.alive = true; h.S.lives = 99; h.S.maxLives = 99;
  const read = () => ({ w: parseFloat(document.getElementById('intFill').style.width) || 0, lv: document.getElementById('intLv').textContent });
  const probe = (t) => { h.targets.length = 0; h.S.time = t; h.step(0.0001); h.targets.length = 0; return read(); };
  return { t0: probe(0), t7: probe(7), t12: probe(12), t60: probe(60), t90: probe(90) };
});
ok('C1 meter ~0% at t=0', meter.t0.w < 2, `w=${meter.t0.w}% lv=${meter.t0.lv}`);
ok('C2 LV.2 after hazard unlock (t=7)', meter.t7.lv === 'LV.2', `lv=${meter.t7.lv}`);
ok('C3 LV.3 after arrow unlock (t=12)', meter.t12.lv === 'LV.3', `lv=${meter.t12.lv}`);
ok('C4 meter full + MAX at t=60', meter.t60.w >= 99 && meter.t60.lv === 'MAX', `w=${meter.t60.w}% lv=${meter.t60.lv}`);
ok('C5 meter clamps past max', meter.t90.w <= 100 && meter.t90.lv === 'MAX', `w=${meter.t90.w}%`);

// ---- D. Duel netcode ----
const duel = await page.evaluate(() => {
  const h = window.__hooks; const out = {};
  h.beginDuelTEST('seedA', 'normal'); h.NET.round = 1;
  h.onData({ t: 'rend', round: 2, s: 500 });          // stale -> dropped
  out.staleDropped = (h.NET.opp.done === false);
  h.NET.me = { done: true, score: 100, combo: 3, react: 180 };
  h.onData({ t: 'rend', round: 1, s: 50 });           // valid -> I win (100>50)
  out.myWins = h.NET.myWins;
  h.beginDuelTEST('seedB', 'normal'); h.NET.round = 1; h.S.alive = true; h.targets.length = 0;
  h.onData({ t: 'atk', round: 99 });                  // wrong round -> ignored
  out.atkWrong = h.targets.filter(t => t.type === 'hazard').length;
  h.onData({ t: 'atk', round: 1 });                   // current round -> lands
  out.atkRight = h.targets.filter(t => t.type === 'hazard').length;
  h.beginDuelTEST('seedC', 'normal'); h.NET.oppLost = true; h.showMatchResult();
  out.discClass = document.getElementById('verdict').className;
  // guest adopts the host's authoritative result instead of computing its own
  h.beginDuelTEST('seedD', 'normal'); h.NET.role = 'guest'; h.NET.round = 1; h.NET.roundResolved = false;
  h.onData({ t: 'rres', round: 1, hs: 30, gs: 80, win: 'guest', hWins: 0, gWins: 1, over: false });
  out.gMy = h.NET.myWins; out.gOpp = h.NET.oppWins; out.gOppScore = h.NET.opp.score;
  return out;
});
ok('D1 stale round-end dropped', duel.staleDropped);
ok('D2 host counts win authoritatively', duel.myWins === 1, `myWins=${duel.myWins}`);
ok('D3 atk from other round ignored', duel.atkWrong === 0, `hazards=${duel.atkWrong}`);
ok('D4 atk from current round lands', duel.atkRight > 0, `hazards=${duel.atkRight}`);
ok('D5 disconnect -> win for remaining player', /win/.test(duel.discClass), `class="${duel.discClass}"`);
ok('D6 guest adopts host result', duel.gMy === 1 && duel.gOpp === 0 && duel.gOppScore === 30,
  `my=${duel.gMy} opp=${duel.gOpp} oppScore=${duel.gOppScore}`);

// ---- E. Persistence across reload (localStorage fallback shim) ----
await page.evaluate(() => { try { localStorage.setItem('setsuna_best', '4242'); } catch {} });
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => !!window.__hooks, null, { timeout: 5000 });
await page.waitForTimeout(200);
const persist = await page.evaluate(() => document.getElementById('titleBest').textContent);
ok('E1 best score persists across reload', /4,?242/.test(persist), `titleBest="${persist.trim()}"`);

// ---- report ----
console.log('\n=== SETSUNA regression suite ===');
let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '  (' + r.d + ')' : ''}`); }
if (consoleErrors.length) { console.log(`\nunexpected console errors (${consoleErrors.length}):`); consoleErrors.forEach(e => console.log('  ' + e)); }
if (pageErrors.length) { console.log(`\npage errors (${pageErrors.length}):`); pageErrors.forEach(e => console.log('  ' + e)); }
console.log(`\n${results.length - fail}/${results.length} checks passed`);

await browser.close();
server.close();
const failed = fail + pageErrors.length + consoleErrors.length;
process.exit(failed ? 1 : 0);
