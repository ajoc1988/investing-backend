/* Fresh-load acceptance test — step 1.
 * Loads the REAL HTML in a real browser from clean saved state and confirms the primary
 * panels render BEFORE any button is pressed. Unit assertions cannot substitute for this:
 * 110 passing unit tests once missed a crash that blanked the page on every fresh load.
 *
 * A stub backend stands in for Render so 401 / 200 paths can both be exercised. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HTML = fs.readFileSync(path.join(__dirname, 'investing-command-centre.html'), 'utf8');

let MODE = '401';                       // flipped per variant
const api = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'OPTIONS') return send(204, {});
  if (req.url.startsWith('/api/health')) return send(200, { ok: true, version: '2.0.0', ts: Date.now() });
  if (MODE === '401') return send(401, { error: 'unauthorised' });
  if (req.url.startsWith('/api/portfolio')) return send(200, { source: 'manual', connected: false, holdings: [], allocationPercentages: {}, ts: Date.now() });
  if (req.url.startsWith('/api/prices')) return send(200, { prices: {}, source: 'none', ts: Date.now() });
  if (req.url.startsWith('/api/prompts')) return send(200, { files: ['a', 'b', 'c'], prompts: {}, ts: Date.now() });
  if (req.url.startsWith('/api/history')) return send(200, { snapshots: [], journal: [], ts: Date.now() });

  /* ── Wildcard stub, deliberately STATEFUL ────────────────────────────────────
   * The step machine reads its position from stored seat responses, not from a counter
   * in the page. A stateless stub would let a broken step machine pass. */
  if (req.url.startsWith('/api/wildcard/seats')) return send(200, { seats: WC_SEED, ts: Date.now() });
  if (req.url.startsWith('/api/wildcard/runs')) return send(200, { runs: [], ts: Date.now() });
  if (req.url.startsWith('/api/wildcard/prompt/')) {
    const seat = req.url.split('/api/wildcard/prompt/')[1].split('?')[0];
    if (['claude', 'deepseek', 'synthesis'].includes(seat) && !(WC_STORE.run || {}).evidence_pack_hash)
      return send(409, { error: 'evidence pack not locked', needsLock: true });
    // mirrors the real server: the chair is blocked until both trade analyses exist
    if (seat === 'synthesis') {
      const miss = ['claude', 'deepseek'].filter(x => !WC_STORE.resp.some(r => r.seat === x && r.status === 'ok'));
      if (miss.length) return send(409, { error: 'trade analysis incomplete', tradeIncomplete: true, missing: miss });
    }
    // The audit prompt must reflect the CURRENT evidence, otherwise lineage cannot be tested.
    const gem = WC_STORE.resp.filter(r => r.seat === 'gemini' && r.status === 'ok').pop();
    const body = seat === 'perplexity' ? 'AUDIT PROMPT :: ' + ((gem || {}).raw_response || 'none') : 'PROMPT';
    return send(200, { prompt: body, evidenceUsed: [], incomplete: false, missing: [] });
  }
  if (req.method === 'POST' && req.url === '/api/wildcard/run') {
    WC_STORE = { run: { id: '11111111-1111-1111-1111-111111111111', candidates: ['NBIS', 'SE', 'SPCX'] }, resp: [] };
    return send(200, { run: WC_STORE.run, seats: WC_SEED, ts: Date.now() });
  }
  /* AUTO route. AUTO_MODE selects which backend behaviour the page is facing.
   *  notfound  — the route is not deployed (the original 2.7.2 situation)
   *  thin      — SUCCESS, but the returned run has NO id. This is the exact shape the real
   *              route produced before 2.7.3: a narrow SELECT that omitted `id`. The page
   *              must NOT let this erase the run it is working on.
   *  retryable — a timeout. RUN must stay on the card, because the badge says RETRY.
   *  terminal  — a rejected key. RUN must go, because retrying cannot possibly help. */
  if (req.url.startsWith('/api/wildcard/seat/run')) {
    let b = ''; req.on('data', c => b += c).on('end', () => {
      let j = {}; try { j = JSON.parse(b); } catch (_) {}
      AUTO_LOG.push({ seat: j.seat, runId: j.runId });
      if (AUTO_MODE === 'notfound') return send(404, { error: 'not found' });
      if (AUTO_MODE.startsWith('fail:')) {
        const code = AUTO_MODE.slice(5);
        return send(502, { error: 'the provider failed', failCode: code, seat: j.seat,
                           note: 'Failed with ' + code + '. Manual is available.' });
      }
      const stage = LOCKED_SEATS.includes(j.seat) ? 'locked' : 'night';
      /* AUTO MUST NOT BE ABLE TO BYPASS THE LOCK. A locked-stage seat is refused until the
         owner has frozen the evidence, exactly as the real route refuses it. */
      if (stage === 'locked' && !(WC_STORE.run || {}).evidence_pack_hash)
        return send(409, { error: 'evidence pack not locked', failCode: 'needs_lock', seat: j.seat,
                           note: 'Review the evidence and press LOCK first.' });
      if (j.seat === 'synthesis') {
        const miss = ['claude', 'deepseek'].filter(x => !WC_STORE.resp.some(r => r.seat === x && r.status === 'ok'));
        if (miss.length) return send(409, { error: 'trade analysis incomplete', failCode: 'trade_incomplete',
                                            seat: j.seat, missing: miss, note: 'Needs ' + miss.join(' and ') + '.' });
      }
      const reply = j.seat === 'synthesis'
        ? JSON.stringify({ verdict: 'GO', ticker: 'NBIS', grade: 'B', limit: '$259',
                           stop: '$254.75', position: null, target: null,
                           next_check: 'tomorrow 14:30 UTC', reason: 'Stub decision.' })
        : 'AUTO ' + j.seat;
      let parsed = null; try { parsed = JSON.parse(reply); } catch (_) {}
      const row = { seat: j.seat, stage, source: 'api', status: 'ok',
                    provider: 'gemini', model: 'gemini-2.5-flash',
                    raw_response: reply, prompt_sent: 'PROMPT ' + j.seat, parsed };
      WC_STORE.resp.push(row);
      /* DELIBERATELY id-less — reproducing the pre-2.7.3 defect, so what is tested here is
         the FRONTEND guard rather than a re-test of the backend's select=*. It also proves
         AUTO never locks: evidence_locked_at is only ever set by the lock route. */
      const thinRun = { candidates: (WC_STORE.run || {}).candidates,
                        evidence_pack: (WC_STORE.run || {}).evidence_pack || null,
                        evidence_pack_hash: (WC_STORE.run || {}).evidence_pack_hash || null,
                        evidence_locked_at: (WC_STORE.run || {}).evidence_pack_hash ? 'locked' : null };
      send(200, { ok: true, saved: projectRow(row, true), run: thinRun,
                  seatResponses: WC_STORE.resp.map(function(r){ return projectRow(r); }),
                  seats: WC_SEED, providerUsed: 'gemini', modelUsed: 'gemini-2.5-flash' });
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/wildcard/lock') {
    LOCK_LOG.push('attempt');
    const need = ['grok', 'gemini', 'perplexity']
      .filter(x => !WC_STORE.resp.some(r => r.seat === x && r.status === 'ok'));
    if (need.length) return send(409, { error: 'cannot lock — night evidence incomplete', missing: need });
    // mirrors the real server: the audit must carry the prompt it was actually given
    const aud = WC_STORE.resp.filter(r => r.seat === 'perplexity' && r.status === 'ok').pop();
    if (!aud || !aud.prompt_sent)
      return send(409, { error: 'audit_stale', auditStale: true, reason: 'no_prompt_recorded',
                         seat: 'perplexity', note: 'No prompt was recorded against PERPLEXITY.' });
    WC_STORE.run.evidence_pack_hash = 'abc123def456abc123def456abc123de';
    WC_STORE.run.evidence_pack = { candidates: WC_STORE.run.candidates, seats: {
      grok:       { seat: 'grok',       source: 'manual', provider: 'xai',    model: null, response: 'FROZEN_GROK_TEXT' },
      gemini:     { seat: 'gemini',     source: 'api',    provider: 'gemini', model: 'g-1', response: 'FROZEN_GEMINI_TEXT' },
      perplexity: { seat: 'perplexity', source: 'manual', provider: null,     model: null, response: 'FROZEN_PPLX_TEXT' } } };
    return send(200, { locked: true, alreadyLocked: false, packHash: WC_STORE.run.evidence_pack_hash });
  }
  if (req.method === 'POST' && req.url === '/api/wildcard/seat') {
    let b = ''; req.on('data', c => b += c).on('end', () => {
      let j = {}; try { j = JSON.parse(b); } catch (_) {}
      // mirrors the real server: once locked, the night is closed
      if (j.stage === 'night' && (WC_STORE.run || {}).evidence_pack_hash)
        return send(409, { error: 'evidence is locked', locked: true,
                           packHash: WC_STORE.run.evidence_pack_hash });
      if (j.stage === 'night' && j.seat === 'perplexity' && typeof j.promptSent !== 'string')
        return send(400, { error: 'promptSent required for an auditing seat',
                           promptLineageRequired: true, seat: j.seat });
      let parsed = null; try { parsed = JSON.parse(j.rawResponse); } catch (_) {}
      WC_STORE.resp.push({ seat: j.seat, stage: j.stage, source: j.source, status: 'ok',
                           raw_response: j.rawResponse, prompt_sent: j.promptSent || null, parsed });
      send(200, { saved: true });
    });
    return;
  }
  if (req.url.startsWith('/api/wildcard/run/')) {
    /* PROJECT THE ROWS, exactly as PostgREST would. The stub used to hand back whatever it
       held, so the frontend was never tested against a response missing a column — which is
       precisely how a projection that dropped `parsed` reached a road test. STUB_DROP_PARSED
       reproduces that server, so the page can be tested against the broken shape. */
    return send(200, { run: WC_STORE.run, seats: WC_SEED, ts: Date.now(),
      seatResponses: WC_STORE.resp.map(function(r){ return projectRow(r); }) });
  }
  return send(200, { ok: true, ts: Date.now() });
});

// gemini has a key (AUTO); everything else manual — mirrors wcSeatModes() output shape.
const WC_SEED = {
  grok:       { label: 'Grok — Live Intelligence', stage: 'night',  step: 'evidence', autoAvailable: false, defaultMode: 'manual', manualAlwaysAvailable: true, note: '' },
  gemini:     { label: 'Gemini — Research',        stage: 'night',  step: 'evidence', autoAvailable: true,  defaultMode: 'auto',   manualAlwaysAvailable: true, note: '' },
  perplexity: { label: 'Perplexity — Auditor',     stage: 'night',  step: 'audit',    autoAvailable: false, defaultMode: 'manual', manualAlwaysAvailable: true, note: '', promptLineageRequired: true },
  claude:     { label: 'Claude — Trade Structure', stage: 'locked', step: 'test',     autoAvailable: false, defaultMode: 'manual', manualAlwaysAvailable: true, note: '' },
  deepseek:   { label: 'DeepSeek — Red Team',      stage: 'locked', step: 'test',     autoAvailable: false, defaultMode: 'manual', manualAlwaysAvailable: true, note: '' },
  /* SYNTHESIS IS A GEMINI SEAT, so with a Gemini key it genuinely has AUTO. The seed used to
     say autoAvailable:false while the decision card printed GET THE DECISION regardless —
     the card never read this field at all. The card now obeys it, so the seed has to be
     honest. The no-key case is tested explicitly in section G6 by flipping this off. */
  synthesis:  { label: 'Final Synthesis',          stage: 'locked', step: 'decision', autoAvailable: true,  defaultMode: 'auto',   manualAlwaysAvailable: true, note: '' }
};
let WC_STORE = { run: null, resp: [] };
const LOCK_LOG = [];
/* `saved` comes back from the INSERT with every column; `seatResponses` comes from a named
   projection. Keeping them DIFFERENT here is the point — that difference is the defect. */
let STUB_DROP_PARSED = false;
function projectRow(r, isSaved) {
  const o = Object.assign({}, r);
  if (STUB_DROP_PARSED && !isSaved) delete o.parsed;
  return o;
}
let AUTO_MODE = 'notfound';
const AUTO_LOG = [];
const LOCKED_SEATS = ['claude', 'deepseek', 'synthesis'];

const web = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail && !cond ? '  → ' + detail : ''}`);
}

async function variant(browser, label, { backendUrl, token, mode }) {
  MODE = mode;
  const ctx = await browser.newContext({ permissions: ['clipboard-read','clipboard-write'] });
  const page = await ctx.newPage();

  // Hermetic: this sandbox tunnels all egress through a proxy, so the page's Google Fonts
  // <link> fails with ERR_TUNNEL_CONNECTION_FAILED and pollutes the console-error assertion.
  // Fulfil anything non-local with an empty 200 so the test measures THIS PAGE's behaviour
  // and nothing else. Fonts are cosmetic and irrelevant to whether panels render.
  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.includes('127.0.0.1')) return route.continue();
    return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
  });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  // Seed saved state BEFORE the page's scripts run — this is what "clean state" vs
  // "returning user" actually means for this app.
  await ctx.addInitScript(({ backendUrl, token }) => {
    try {
      localStorage.clear();
      if (backendUrl) localStorage.setItem('andy_invest_v4', JSON.stringify({ backendUrl }));
      if (token) localStorage.setItem('andy_invest_token', token);
    } catch (_) {}
  }, { backendUrl, token });

  console.log(`\n── ${label}`);
  await page.goto('http://127.0.0.1:8901/', { waitUntil: 'load' });
  await page.waitForTimeout(1200);          // let non-blocking probes settle

  // NOTHING has been clicked at this point. Everything below must already be true.
  const state = await page.evaluate(() => ({
    bodyLen: document.body.innerText.trim().length,
    header: !!document.querySelector('header.top h1'),
    portfolioTable: (document.getElementById('pfBody') || {}).innerHTML || '',
    deployPanel: (document.getElementById('dpRecB') || {}).innerHTML || '',
    summary: !!document.querySelector('.summary'),
    authOpen: !!(document.getElementById('authOverlay') || {}).classList?.contains('open'),
    authExists: !!document.getElementById('authOverlay'),
    tokenLeft: (() => { try { return localStorage.getItem('andy_invest_token'); } catch (_) { return null; } })(),
    // Wildcard MUST be invisible until deliberately opened. Its "GO — BUY" card must never
    // sit beside the portfolio's resolved action, or two panels are telling the owner what
    // to do at once — the exact thing the architecture rule forbids.
    wildcardExists: !!document.getElementById('wcOverlay'),
    wildcardVisible: (() => { const el=document.getElementById('wcOverlay');
      return !!el && el.classList.contains('open'); })(),
    wildcardNav: !!document.getElementById('navWildcard')
  }));

  check(`${label} · page is not blank`, state.bodyLen > 400, `innerText length ${state.bodyLen}`);
  check(`${label} · header rendered`, state.header);
  check(`${label} · portfolio table rendered`, state.portfolioTable.length > 0);
  check(`${label} · deployment panel rendered`, state.deployPanel.length > 0);
  check(`${label} · summary panel present`, state.summary);
  check(`${label} · sign-in markup exists in DOM`, state.authExists);
  check(`${label} · zero console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
  check(`${label} · Wildcard markup exists`, state.wildcardExists);
  check(`${label} · Wildcard is HIDDEN by default`, state.wildcardVisible === false);
  check(`${label} · Wildcard reachable from the menu`, state.wildcardNav);

  // Now — and only now — make a protected call, to prove the 401 path surfaces the overlay.
  let after401 = null;
  if (backendUrl) {
    await page.evaluate(() => { try { return apiJson(S.backendUrl.replace(/\/+$/,'') + '/api/portfolio'); } catch (_) {} }).catch(() => {});
    await page.waitForTimeout(300);
    after401 = await page.evaluate(() => !!document.getElementById('authOverlay').classList.contains('open'));
  }
  state.after401 = after401;

  await ctx.close();
  return state;
}

// A realistically-shaped token: base64url(JSON payload) + '.' + signature, exp 12h out.
// The earlier placeholder 'valid.token.here' was rejected by tokenExpired() — correctly,
// since it carries no readable expiry. That was a bad test fixture, not a bug.
function mintToken(msFromNow) {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + msFromNow }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return payload + '.' + 'stub-signature-server-verifies-this';
}
const GOOD_TOKEN = mintToken(12 * 3600 * 1000);
const DEAD_TOKEN = mintToken(-60 * 1000);

/* Reads actual on-screen geometry at desktop width. Checks the three properties the
   desktop redesign exists to guarantee, none of which a DOM assertion can confirm. */
async function desktopLayout(browser) {
  MODE = '200';
  const ctx = await browser.newContext({ permissions: ['clipboard-read','clipboard-write'], viewport: { width: 1512, height: 950 } });
  const page = await ctx.newPage();
  await page.route('**/*', r => r.request().url().includes('127.0.0.1')
    ? r.continue() : r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await ctx.addInitScript(t => { try { localStorage.clear();
    localStorage.setItem('andy_invest_v4', JSON.stringify({ backendUrl: 'http://127.0.0.1:8902',
      holdings: [{ticker:'ISAC.L',name:'iShares MSCI ACWI',units:420,avg:6.42,price:7.05},
                 {ticker:'VOO',name:'Vanguard S&P 500',units:4,avg:498,price:551.2},
                 {ticker:'MSFT',name:'Microsoft',units:6,avg:402,price:463.1}],
      cashBhd: 717, monthlyPlanBhd: 500, fx: 2.6525 }));
    localStorage.setItem('andy_invest_token', t); } catch (_) {} }, GOOD_TOKEN);

  console.log('\n── F desktop layout @1512px');
  await page.goto('http://127.0.0.1:8901/', { waitUntil: 'load' });
  await page.waitForTimeout(1400);

  const g = await page.evaluate(() => {
    const box = s => { const el = document.querySelector(s); if (!el) return null;
      const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom }; };
    const fs = s => { const el = document.querySelector(s); return el ? parseFloat(getComputedStyle(el).fontSize) : null; };
    return {
      bodyDisplay: getComputedStyle(document.body).display,
      summary: box('.summary'), guide: box('.guide'), cmdbar: box('.cmdbar'),
      meters: box('.meters'), chips: box('.chips'),
      gate: box('#convictionGate'), tl: box('.tl'),
      pfTable: box('#pfCard table'), pie: box('#pfCard > .pie-row'),
      danger: box('#dangerCard'), opp: box('#oppCard'),
      trend: box('#trendCard'), alerts: box('#alertsCard'),
      guideMainFs: fs('.gcard .gmain'), tlActFs: fs('.tl .body .act'),
      pageH: document.documentElement.scrollHeight
    };
  });

  const sideBySide = (a, b) => a && b && a.x < b.x && a.y < b.b && b.y < a.b;
  check('F · body is a grid at desktop width', g.bodyDisplay === 'grid', g.bodyDisplay);
  check('F · summary sits beside the action panel', sideBySide(g.summary, g.guide));
  check('F · action panel spans past the summary', g.guide.h > g.summary.h * 1.5);

  // THE DEAD-SPACE TEST. The first version of this check asserted only that the left column
  // reached as far down as the action panel — which passed even with the bug reintroduced,
  // because a non-spanning action panel simply pushes the left items further down. The hole
  // is INSIDE the column, between consecutive cards, so that is what has to be measured.
  const gaps = [g.cmdbar.y - g.summary.b, g.meters.y - g.cmdbar.b, g.chips.y - g.meters.b];
  const worst = Math.max(...gaps);
  check('F · no dead hole between left-column cards',
        worst < 60, `largest gap ${Math.round(worst)}px (${gaps.map(x => Math.round(x)).join(', ')})`);
  // and the two columns must end at roughly the same place
  const leftBottom = Math.max(g.summary.b, g.cmdbar.b, g.meters.b, g.chips.b);
  check('F · the two columns finish level',
        Math.abs(leftBottom - g.guide.b) < 140, `left ${Math.round(leftBottom)} vs action ${Math.round(g.guide.b)}`);

  check('F · holdings sit beside the allocation donut', sideBySide(g.pfTable, g.pie));
  check('F · Market Danger beside Opportunity', sideBySide(g.danger, g.opp));
  check('F · Value Trend beside Alerts', sideBySide(g.trend, g.alerts));
  check('F · Conviction beside the traffic light', sideBySide(g.gate, g.tl));

  // ONE dominant instruction. The traffic light must not be a second big headline.
  check('F · traffic light is demoted below the action headline',
        g.tlActFs < g.guideMainFs / 1.6, `tl ${g.tlActFs}px vs action ${g.guideMainFs}px`);
  check('F · traffic light is a strip, not a panel', g.tl.h < 130, `${Math.round(g.tl.h)}px`);
  check('F · desktop page is far shorter than the phone stack', g.pageH < 4600, `${g.pageH}px`);
  check('F · zero page errors at desktop width', errors.length === 0, errors.slice(0, 2).join(' | '));

  // And the layout must vanish below the breakpoint.
  await page.setViewportSize({ width: 1099, height: 900 });
  await page.waitForTimeout(400);
  const below = await page.evaluate(() => ({
    body: getComputedStyle(document.body).display,
    cmdbar: getComputedStyle(document.querySelector('.cmdbar')).display }));
  check('F · below 1100px the grid is off', below.body === 'block', below.body);
  check('F · below 1100px .cmdbar is invisible to layout', below.cmdbar === 'contents', below.cmdbar);

  await ctx.close();
}

/* Drives the real overlay through all four steps against the stateful stub. */
async function wildcardWalk(browser) {
  MODE = '200';
  WC_STORE = { run: null, resp: [] };
  const ctx = await browser.newContext({ permissions: ['clipboard-read','clipboard-write'] });
  const page = await ctx.newPage();
  await page.route('**/*', route => route.request().url().includes('127.0.0.1')
    ? route.continue() : route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await ctx.addInitScript(({ b, t }) => { try { localStorage.clear();
    localStorage.setItem('andy_invest_v4', JSON.stringify({ backendUrl: b }));
    localStorage.setItem('andy_invest_token', t); } catch (_) {} },
    { b: 'http://127.0.0.1:8902', t: GOOD_TOKEN });

  console.log('\n── E Wildcard four-step walk');
  await page.goto('http://127.0.0.1:8901/', { waitUntil: 'load' });
  await page.waitForTimeout(900);

  // snapshot helper: what is ACTUALLY on screen right now
  const snap = () => page.evaluate(() => {
    const vis = el => !!(el && el.offsetParent !== null);
    const cards = [...document.querySelectorAll('#wcFlow .wc-card')].filter(vis);
    return {
      cards: cards.length,
      cardNames: cards.map(c => (c.querySelector('.nm') || {}).textContent || ''),
      // full row text, not just .nm — the pack hash lives in the row's second span, and
      // reading only .nm made a genuinely-rendered hash look missing.
      rows: [...document.querySelectorAll('#wcFlow .wc-row')].filter(vis)
              .map(r => (r.textContent || '').trim()),
      now: ((document.querySelector('#wcFlow .wc-rail .st.now') || {}).textContent || '').trim(),
      setupVisible: vis(document.getElementById('wcSetup')),
      decision: (document.querySelector('#wcFlow .wc-dec .verdict') || {}).textContent || '',
      grid: [...document.querySelectorAll('#wcFlow .wc-grid .c')]
              .map(c => ((c.querySelector('.k')||{}).textContent||'') + '=' + ((c.querySelector('.v')||{}).textContent||'')),
      rulesOpen: !!(document.getElementById('wcRules') || {}).open
    };
  });
  const save = async (seat, text) => {
    // Auditor seats now require the copied prompt, so the walk must press COPY PROMPT first —
    // which is the whole point of the guard: an audit with no provenance cannot be saved.
    if (seat === 'perplexity') {
      await page.evaluate(s => document.querySelector('[data-wc-copy="' + s + '"]').click(), seat);
      await page.waitForTimeout(250);
    }
    await page.evaluate(([s, t]) => {
      document.querySelector('[data-wc-paste="' + s + '"]').click();
      document.querySelector('[data-wc-box="' + s + '"]').value = t;
      document.querySelector('[data-wc-save="' + s + '"]').click();
    }, [seat, text]);
    await page.waitForTimeout(450);
  };

  await page.evaluate(() => wcOpen());
  await page.waitForTimeout(700);
  let s = await snap();
  check('E · opens on the setup screen, no seat cards', s.cards === 0 && s.setupVisible === true, `cards ${s.cards}`);
  check('E · the long explanation starts COLLAPSED', s.rulesOpen === false);

  await page.evaluate(() => { wc_t1.value='NBIS'; wc_t2.value='SE'; wc_t3.value='SPCX'; wcDebate.click(); });
  await page.waitForTimeout(700);
  s = await snap();
  check('E1 · step 1 EVIDENCE is the live step', /EVIDENCE/.test(s.now), s.now);
  check('E1 · exactly two cards — Grok and Gemini', s.cards === 2 && /GROK/.test(s.cardNames.join()) && /GEMINI/.test(s.cardNames.join()), s.cardNames.join('|'));
  check('E1 · later seats are waiting ROWS, not cards', /PERPLEXITY/.test(s.rows.join()) && /CLAUDE \+ DEEPSEEK/.test(s.rows.join()), s.rows.join('|'));
  check('E1 · setup screen is gone', s.setupVisible === false);

  await save('grok', 'grok text');
  await save('gemini', 'gemini text');
  s = await snap();
  check('E2 · step 2 AUDIT is the live step', /AUDIT/.test(s.now), s.now);
  check('E2 · ONLY Perplexity is a card', s.cards === 1 && /PERPLEXITY/.test(s.cardNames.join()), s.cardNames.join('|'));
  check('E2 · step 1 collapsed to a done row', /1 EVIDENCE/.test(s.rows.join()), s.rows.join('|'));

  await save('perplexity', 'perplexity text');
  s = await snap();

  // STEP 3 IS NOW REVIEW — the deliberate pause before anything is frozen.
  check('E3 · step 3 REVIEW is the live step', /REVIEW/.test(s.now), s.now);
  // Four cards, not three: the three night seats PLUS the lock gate beneath them. Counting
  // bare .wc-card conflated them — the seat cards are the ones carrying a replace control.
  const reviewCards = await page.evaluate(() =>
    [...document.querySelectorAll('#wcFlow .wc-card')].filter(c => c.querySelector('[data-wc-paste]')).length);
  check('E3 · all three night seats are shown for review',
        reviewCards === 3 && /GROK/.test(s.cardNames.join()) && /GEMINI/.test(s.cardNames.join()) && /PERPLEXITY/.test(s.cardNames.join()),
        `${reviewCards} seat cards · ` + s.cardNames.join('|'));
  check('E3 · Claude and DeepSeek are not among them',
        !/CLAUDE/.test(s.cardNames.join()) && !/DEEPSEEK/.test(s.cardNames.join()), s.cardNames.join('|'));
  const rev = await page.evaluate(() => ({
    replace: [...document.querySelectorAll('[data-wc-paste]')].map(b => b.textContent).join('|'),
    view: [...document.querySelectorAll('#wcFlow .wc-card .wc-det summary')].map(x => x.textContent).join('|'),
    // REPLACE, never edit: no control may write over the stored text of an existing answer
    editable: [...document.querySelectorAll('#wcFlow .wc-card pre')].some(p => p.isContentEditable),
    lockBtn: !!document.querySelector('[data-wc-lock]')
  }));
  check('E3 · each seat offers REPLACE, not edit', (rev.replace.match(/REPLACE/g) || []).length === 3, rev.replace);
  check('E3 · each seat can be read before freezing', (rev.view.match(/VIEW RESPONSE/g) || []).length === 3, rev.view);
  check('E3 · stored answers are NOT editable in place', rev.editable === false);
  check('E3 · LOCK sits below the review', rev.lockBtn === true);

  // Replacing stores a NEW answer; the superseded one stays in the record.
  await save('gemini', 'gemini REPLACEMENT text');
  s = await snap();
  check('E3 · still on REVIEW after replacing', /REVIEW/.test(s.now), s.now);
  const afterReplace = await page.evaluate(() => ({
    superseded: /superseded and kept in history/.test(document.getElementById('wcFlow').textContent),
    debate: [...document.querySelectorAll('#wcFlow .wc-det summary')].map(x => x.textContent).join('|')
  }));
  check('E3 · the superseded answer is reported, not deleted', afterReplace.superseded === true);
  check('E3 · replacement adds a row rather than overwriting', /VIEW DEBATE · 4 recorded/.test(afterReplace.debate), afterReplace.debate);

  /* ── CLIPBOARD-FAILURE LINEAGE SABOTAGE ──────────────────────────────────────
   * copy prompt A (succeeds) -> evidence changes to B -> copying B FAILS -> paste an answer
   * produced from A. The app must never attach the newer prompt, or the older one, to that
   * answer. Retaining the prompt before confirming the copy is exactly how it would.       */
  await page.evaluate(() => { window.__clip = []; window.__realWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = t => { window.__clip.push(t); return window.__realWrite(t); }; });
  await page.evaluate(() => document.querySelector('[data-wc-copy="perplexity"]').click());
  await page.waitForTimeout(300);
  const heldA = await page.evaluate(() => WC_UI['perplexity:prompt'] || null);
  check('E3s · prompt A retained after a SUCCESSFUL copy', typeof heldA === 'string' && /AUDIT PROMPT/.test(heldA), String(heldA).slice(0, 40));

  // evidence changes underneath
  await save('gemini', 'GEMINI_B_AFTER_THE_COPY');

  // now force the clipboard to fail while copying the NEW prompt
  await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('clipboard blocked')); });
  await page.evaluate(() => document.querySelector('[data-wc-copy="perplexity"]').click());
  await page.waitForTimeout(400);
  const heldAfterFail = await page.evaluate(() => WC_UI['perplexity:prompt'] || null);
  check('E3s · NOTHING retained when the copy fails', heldAfterFail === null, String(heldAfterFail).slice(0, 40));

  // attempt to save an answer produced from prompt A
  const refused = await page.evaluate(async () => {
    document.querySelector('[data-wc-paste="perplexity"]').click();
    document.querySelector('[data-wc-box="perplexity"]').value = 'ANSWER_DERIVED_FROM_PROMPT_A';
    document.querySelector('[data-wc-save="perplexity"]').click();
    await new Promise(r => setTimeout(r, 500));
    return { msg: (document.getElementById('wcStatus') || {}).textContent || '',
             stored: [...document.querySelectorAll('#wcFlow .wc-det summary')].map(x => x.textContent).join('|') };
  });
  check('E3s · the save is REFUSED', /COPY PROMPT/i.test(refused.msg), refused.msg.slice(0, 110));
  check('E3s · the answer was never stored', !/ANSWER_DERIVED_FROM_PROMPT_A/.test(refused.stored));

  // restore a working clipboard and re-audit properly
  await page.evaluate(() => { navigator.clipboard.writeText = window.__realWrite; });
  await save('perplexity', 'REAUDIT_OF_GEMINI_B');

  // THE LOCK GATE. Claude and DeepSeek must not be reachable before the evidence is frozen —
  // that is the whole failure being fixed: a prompt that says "use ONLY the locked pack"
  // while carrying no pack.
  check('E3 · Claude/DeepSeek are GATED until the pack is locked',
        !/CLAUDE/.test(s.cardNames.join()) && /LOCK THE EVIDENCE/.test(s.cardNames.join()), s.cardNames.join('|'));
  const noSeatsYet = await page.evaluate(() => !document.querySelector('[data-wc-copy="claude"]'));
  check('E3 · no Claude prompt button before the lock', noSeatsYet === true);

  await page.evaluate(() => document.querySelector('[data-wc-lock]').click());
  await page.waitForTimeout(600);
  s = await snap();
  check('E4 · step 4 TRADE is the live step', /TRADE/.test(s.now), s.now);
  check('E3 · PACK LOCKED shows after locking', /PACK LOCKED/.test(s.rows.join()), s.rows.join('|'));
  check('E3 · the pack hash is visible', /abc123def456/.test(s.rows.join()), s.rows.join('|'));
  check('E3 · Claude and DeepSeek together', s.cards === 2 && /CLAUDE/.test(s.cardNames.join()) && /DEEPSEEK/.test(s.cardNames.join()), s.cardNames.join('|'));

  // Once locked, the LOCK button must be gone for good. No accidental rewrite of history.
  const afterLock = await page.evaluate(() => ({
    lockBtn: !!document.querySelector('[data-wc-lock]'),
    relock: /relock/i.test(document.getElementById('wcFlow').innerHTML),
    viewer: [...document.querySelectorAll('#wcFlow .wc-det summary')].map(x => x.textContent).join('|'),
    viewerOpen: !!document.querySelector('#wcFlow .wc-det[open]'),
    // the viewer must show the STORED pack, not a rebuild from the seat responses
    body: (() => { const d=[...document.querySelectorAll('#wcFlow .wc-det')]
             .find(x => /VIEW LOCKED EVIDENCE/.test(x.textContent)); return d ? d.textContent : ''; })()
  }));
  check('E3 · LOCK button is gone once locked', afterLock.lockBtn === false);
  check('E3 · no relock control is exposed', afterLock.relock === false);
  check('E3 · VIEW LOCKED EVIDENCE is offered', /VIEW LOCKED EVIDENCE/.test(afterLock.viewer), afterLock.viewer);
  check('E3 · and stays folded away by default', afterLock.viewerOpen === false);
  check('E3 · viewer shows the STORED frozen text', /FROZEN_GROK_TEXT/.test(afterLock.body) && /FROZEN_GEMINI_TEXT/.test(afterLock.body) && /FROZEN_PPLX_TEXT/.test(afterLock.body));
  check('E3 · viewer shows the full pack hash', /abc123def456abc123def456abc123de/.test(afterLock.body));
  check('E3 · viewer shows provenance per seat', /manual/.test(afterLock.body) && /xai/.test(afterLock.body) && /api/.test(afterLock.body));

  // The real guarantee: DECISION is UNREACHABLE until both trade analyses are stored. That is
  // what makes a UI "FINAL BLOCKED" branch dead code, and why the block lives on the server.
  const beforeTrade = await snap();
  check('E4 · DECISION unreachable with no trade analyses', !/DECISION/.test(beforeTrade.now), beforeTrade.now);
  const noPanel = await page.evaluate(() => !document.querySelector('#wcFlow .wc-dec'));
  check('E4 · no decision panel is rendered yet', noPanel === true);

  await save('claude', 'claude trade structure');
  const afterOne = await snap();
  check('E4 · still unreachable with only ONE of the two', !/DECISION/.test(afterOne.now), afterOne.now);
  await save('deepseek', 'deepseek red team');
  s = await snap();
  check('E4 · step 4 DECISION is the live step', /DECISION/.test(s.now), s.now);
  check('E4 · a decision panel, not six seat cards', s.cards <= 1, `cards ${s.cards}`);
  check('E4 · says AWAITING rather than inventing one', /AWAITING/.test(s.decision), s.decision);

  // Step 4 must NOT be a sixth thing to copy and paste. Copy/paste for the synthesis is
  // allowed to appear ONLY after the automatic attempt has actually failed.
  const beforeAuto = await page.evaluate(() => !!document.querySelector('[data-wc-copy="synthesis"]'));
  check('E4 · no synthesis copy/paste before AUTO is tried', beforeAuto === false);
  await page.evaluate(() => document.querySelector('[data-wc-auto="synthesis"]').click());
  await page.waitForTimeout(600);
  const afterAuto = await page.evaluate(() => ({
    manual: !!document.querySelector('[data-wc-copy="synthesis"]'),
    badge: (document.querySelector('#wcSeat_synthesis .wc-badge') || {}).textContent || '',
    msg: (document.getElementById('wcStatus') || {}).textContent || ''
  }));
  check('E4 · AUTO failing exposes MANUAL immediately', afterAuto.manual === true);
  /* CHANGED at 2.7.3: the badge and message now NAME the cause. The stub answers 404 for
     /seat/run, which is "the route is not on the deployed backend" — a different problem
     from a provider failing, and it must not be reported as one. */
  check('E4 · the badge names the cause, not just FAILED', /API NOT DEPLOYED/.test(afterAuto.badge), afterAuto.badge);
  check('E4 · and the message says what to do about it',
        /not on the deployed backend/.test(afterAuto.msg) && /COPY PROMPT/.test(afterAuto.msg), afterAuto.msg);

  // A synthesis that parses: the fields must come from the reply, and the ones it does
  // not contain must read UNAVAILABLE rather than being filled in with something plausible.
  await save('synthesis', JSON.stringify({ verdict: 'GO', ticker: 'NBIS', grade: 'B', limit: '$259', stop: '$254.75' }));
  s = await snap();
  check('E4 · verdict rendered from the actual reply', /GO/.test(s.decision), s.decision);
  check('E4 · LIMIT taken from the reply', /LIMIT=\$259/.test(s.grid.join('|')), s.grid.join('|'));
  check('E4 · STOP taken from the reply', /STOP=\$254\.75/.test(s.grid.join('|')), s.grid.join('|'));
  check('E4 · absent TARGET reads UNAVAILABLE, never invented', /TARGET=UNAVAILABLE/.test(s.grid.join('|')), s.grid.join('|'));
  check('E4 · absent POSITION reads UNAVAILABLE, never invented', /POSITION=UNAVAILABLE/.test(s.grid.join('|')), s.grid.join('|'));

  const debate = await page.evaluate(() => {
    const d=[...document.querySelectorAll('#wcFlow .wc-det summary')].map(x=>x.textContent).join('|');
    return { d, hidden: !document.querySelector('#wcFlow .wc-det[open]') };
  });
  // 9: six seats, plus the superseded Gemini from the REVIEW replacement, plus the second
  // Gemini and the re-audit from the clipboard sabotage. Every superseded answer is KEPT
  // rather than replaced in place — the count rising IS the provenance guarantee working.
  check('E · every response kept behind VIEW DEBATE', /VIEW DEBATE · 9 recorded/.test(debate.d), debate.d);
  check('E · the machinery stays folded away by default', debate.hidden === true);
  check('E · zero page errors across the whole walk', errors.length === 0, errors.slice(0, 2).join(' | '));
  // A block-slice edit once deleted wcLock while leaving its call site, so LOCK silently did
  // nothing. Assert every function the delegated listener can invoke actually exists.
  const handlers = await page.evaluate(() => ['wcLock','wcAuto','wcCopyPrompt','wcSaveResponse',
    'wcCreateRun','wcRender','wcRefresh'].filter(n => typeof window[n] !== 'function'
      && typeof eval('typeof ' + n) !== 'function'));
  check('E · every Wildcard handler is defined', handlers.length === 0, handlers.join(','));

  await ctx.close();
}

/* ═══ G. AUTO ACROSS SEATS — the page must not lose the run, and RETRY must mean RETRY ══
 *
 * TWO DEFECTS, BOTH INVISIBLE TO EVERY EXISTING CHECK because every existing check ran AUTO
 * exactly once:
 *
 *  1. wcAuto did `WC_RUN = j.run`. The backend's SELECT omitted `id`, so the first successful
 *     automatic seat replaced the page's run with an id-less copy and the SECOND seat said
 *     "Create a run first." The server side is fixed, but the page is fixed too: it MERGES,
 *     so no thin response from any route can ever take the identity away again. The stub
 *     here deliberately still answers with an id-less run — that is what makes this a test
 *     of the frontend guard rather than a re-test of the backend.
 *
 *  2. Every failure forced the seat into manual mode, which removes the RUN button — while
 *     the badge read "TIMED OUT — RETRY". The badge and the buttons contradicted each other.
 */
async function autoRunWalk(browser) {
  MODE = '200';
  WC_STORE = { run: null, resp: [] };
  AUTO_LOG.length = 0;
  AUTO_MODE = 'thin';
  /* Every seat except Grok gets a key for this walk. Grok stays manual by ruling — that is a
     policy decision, not a configuration gap, and the walk must still work around it. */
  const seedBackup = JSON.stringify(WC_SEED);
  ['perplexity', 'claude', 'deepseek', 'synthesis'].forEach(k => {
    WC_SEED[k].autoAvailable = true; WC_SEED[k].defaultMode = 'auto';
  });

  const ctx = await browser.newContext({ permissions: ['clipboard-read','clipboard-write'] });
  const page = await ctx.newPage();
  await page.route('**/*', route => route.request().url().includes('127.0.0.1')
    ? route.continue() : route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  await ctx.addInitScript(({ b, t }) => { try { localStorage.clear();
    localStorage.setItem('andy_invest_v4', JSON.stringify({ backendUrl: b }));
    localStorage.setItem('andy_invest_token', t); } catch (_) {} },
    { b: 'http://127.0.0.1:8902', t: GOOD_TOKEN });

  console.log('\n── G AUTO across seats — run identity and retryability');
  await page.goto('http://127.0.0.1:8901/', { waitUntil: 'load' });
  await page.waitForTimeout(900);

  await page.evaluate(() => wcOpen());
  await page.waitForTimeout(700);
  await page.evaluate(() => { wc_t1.value='NBIS'; wc_t2.value='SE'; wc_t3.value='SPCX'; wcDebate.click(); });
  await page.waitForTimeout(700);
  const startId = await page.evaluate(() => (WC_RUN || {}).id || null);
  check('G · a run exists before any AUTO', !!startId, String(startId));

  // Grok is manual by ruling, so it is saved by hand. Without it the step machine stays on
  // EVIDENCE and the auditor never becomes an actionable card at all.
  await page.evaluate(() => {
    document.querySelector('[data-wc-paste="grok"]').click();
    document.querySelector('[data-wc-box="grok"]').value = 'grok text';
    document.querySelector('[data-wc-save="grok"]').click();
  });
  await page.waitForTimeout(450);

  // ── 1. First automatic seat, answered with a run object that has NO id.
  await page.evaluate(() => document.querySelector('[data-wc-auto="gemini"]').click());
  await page.waitForTimeout(600);
  const afterFirst = await page.evaluate(() => ({
    id: (typeof WC_RUN!=='undefined' ? (WC_RUN||{}).id : null),
    cands: (typeof WC_RUN!=='undefined' ? ((WC_RUN||{}).candidates||[]).join(',') : '')
  }));
  check('G1 · WC_RUN.id SURVIVED an id-less response', afterFirst.id === startId,
        'was ' + startId + ', now ' + afterFirst.id);
  check('G1 · the merge still took the new fields', /NBIS/.test(afterFirst.cands), afterFirst.cands);

  // ── 2. The next automatic seat must address the SAME run.
  await page.evaluate(() => { const b=document.querySelector('[data-wc-auto="perplexity"]'); if(b) b.click(); });
  await page.waitForTimeout(600);
  const pplxCall = AUTO_LOG.filter(x => x.seat === 'perplexity').pop();
  check('G2 · a SECOND automatic seat actually fired', !!pplxCall, JSON.stringify(AUTO_LOG));
  check('G2 · it used the ORIGINAL run id', !!pplxCall && pplxCall.runId === startId,
        pplxCall ? pplxCall.runId : 'no call');
  check('G2 · the progression was NOT stopped after the first success',
        AUTO_LOG.length >= 2, String(AUTO_LOG.length));
  const statusNow = await page.evaluate(() => (document.getElementById('wcStatus')||{}).textContent||'');
  check('G2 · never said "Create a run first"', !/Create a run first/.test(statusNow), statusNow);

  /* ── 3. THE FAILURE MATRIX ────────────────────────────────────────────────────
     Every failure used to force the seat to manual, deleting RUN — while the badge read
     "TIMED OUT — RETRY". Badge and buttons said opposite things. Each code is now driven
     through the real UI and both halves are asserted together.

     RETRYABLE means pressing RUN again could plausibly work. TERMINAL means it cannot until
     something outside the page changes. */
  const resetSeat = async (seat) => page.evaluate(s => {
    delete WC_UI[s]; delete WC_UI[s + ':mode']; delete WC_UI[s + ':failCode'];
    WC_RESP = WC_RESP.filter(r => r.seat !== s); wcRender();
  }, seat);
  const driveFailure = async (seat, code) => {
    AUTO_MODE = 'fail:' + code;
    await resetSeat(seat);
    await page.evaluate(s => { const b = document.querySelector('[data-wc-auto="' + s + '"]');
      if (b) b.click(); }, seat);
    await page.waitForTimeout(450);
    return page.evaluate(s => ({
      badge: (document.querySelector('#wcSeat_' + s + ' .wc-badge') || {}).textContent || '',
      run:    !!document.querySelector('[data-wc-auto="' + s + '"]'),
      manual: !!document.querySelector('[data-wc-copy="' + s + '"]')
    }), seat);
  };

  for (const code of ['timeout', 'empty_reply', 'provider_error', 'store_unreachable']) {
    const r = await driveFailure('gemini', code);
    check('G3 · ' + code + ' KEEPS RUN', r.run === true, r.badge);
    check('G3 · ' + code + ' still offers MANUAL', r.manual === true);
    check('G3 · ' + code + ' badge does not say USE MANUAL', !/MANUAL/.test(r.badge), r.badge);
  }
  for (const code of ['no_api_key', 'auth_failed', 'rate_limited', 'manual_only']) {
    const r = await driveFailure('gemini', code);
    check('G4 · ' + code + ' REMOVES RUN', r.run === false, r.badge);
    check('G4 · ' + code + ' badge says MANUAL', /MANUAL/.test(r.badge), r.badge);
    check('G4 · ' + code + ' still offers MANUAL', r.manual === true);
  }
  // route_unavailable arrives as a bare 404 with no failCode — the page must classify it
  // itself rather than reporting it as a provider failure.
  AUTO_MODE = 'notfound';
  await resetSeat('gemini');
  await page.evaluate(() => { const b = document.querySelector('[data-wc-auto="gemini"]'); if (b) b.click(); });
  await page.waitForTimeout(450);
  const nf = await page.evaluate(() => ({
    badge: (document.querySelector('#wcSeat_gemini .wc-badge') || {}).textContent || '',
    run: !!document.querySelector('[data-wc-auto="gemini"]'),
    manual: !!document.querySelector('[data-wc-copy="gemini"]')
  }));
  check('G4 · route_unavailable REMOVES RUN', nf.run === false, nf.badge);
  check('G4 · route_unavailable names the real cause', /NOT DEPLOYED/.test(nf.badge), nf.badge);
  check('G4 · route_unavailable still offers MANUAL', nf.manual === true);
  check('G · badge and buttons never contradict each other', errors.length === 0);

  /* ── 4. A COMPLETE AUTO RUN, IN ONE PAGE LOAD, NO REFRESH ─────────────────────
     Everything above tests one seat at a time. This drives the entire journey the owner
     actually makes — evidence, audit, review, lock, both trade analyses, decision — without
     reloading the page once, and asserts the step machine advances on its own after each
     success. The page-load crash that 110 unit tests once missed was exactly this: state
     that only breaks after several interactions on a single load. */
  AUTO_MODE = 'ok';
  WC_STORE = { run: null, resp: [] };
  AUTO_LOG.length = 0;
  await page.evaluate(() => { const b = document.getElementById('wcNewRun'); if (b) b.click(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { wc_t1.value='NBIS'; wc_t2.value='SE'; wc_t3.value='SPCX'; wcDebate.click(); });
  await page.waitForTimeout(600);
  const fullId = await page.evaluate(() => (WC_RUN || {}).id || null);
  const stepNow = () => page.evaluate(() =>
    ((document.querySelector('#wcFlow .wc-rail .st.now') || {}).textContent || '').trim());
  const clickAuto = async (seat) => {
    await page.evaluate(s => { const b = document.querySelector('[data-wc-auto="' + s + '"]'); if (b) b.click(); }, seat);
    await page.waitForTimeout(500);
  };

  await page.evaluate(() => {
    document.querySelector('[data-wc-paste="grok"]').click();
    document.querySelector('[data-wc-box="grok"]').value = 'grok text';
    document.querySelector('[data-wc-save="grok"]').click();
  });
  await page.waitForTimeout(400);
  await clickAuto('gemini');
  check('G5 · a successful seat ADVANCES the step by itself', /AUDIT/.test(await stepNow()), await stepNow());
  await clickAuto('perplexity');
  check('G5 · the audit advances to REVIEW', /REVIEW/.test(await stepNow()), await stepNow());

  // AUTO must not be able to skip the lock. Try the locked-stage seat first and be refused.
  const preLock = await page.evaluate(() => !!document.querySelector('[data-wc-auto="claude"]'));
  check('G5 · no trade-stage RUN button before the evidence is locked', preLock === false);

  await page.evaluate(() => { const b = document.querySelector('#wcFlow [data-wc-lock]') ||
    [...document.querySelectorAll('#wcFlow button')].find(x => /LOCK/.test(x.textContent || '')); if (b) b.click(); });
  await page.waitForTimeout(600);
  check('G5 · locking advanced to the TRADE step', /TEST|TRADE/i.test(await stepNow()), await stepNow());
  check('G5 · the owner locked it — AUTO never did',
        LOCK_LOG.length >= 1 && AUTO_LOG.every(x => x.seat !== 'lock'), String(LOCK_LOG.length));

  await clickAuto('claude');
  await clickAuto('deepseek');
  check('G5 · both analyses advance to DECISION', /DECISION/.test(await stepNow()), await stepNow());
  await clickAuto('synthesis');
  const done = await page.evaluate(() => ({
    verdict: (document.querySelector('#wcFlow .wc-dec .verdict') || {}).textContent || '',
    grid: [...document.querySelectorAll('#wcFlow .wc-grid .c')].map(c =>
      ((c.querySelector('.k')||{}).textContent||'') + '=' + ((c.querySelector('.v')||{}).textContent||'')).join('|'),
    id: (WC_RUN || {}).id || null
  }));
  check('G5 · THE WHOLE RUN FINISHED WITHOUT A PAGE REFRESH', /GO/.test(done.verdict), done.verdict);
  check('G5 · the decision was read from the reply', /LIMIT=\$259/.test(done.grid), done.grid);
  check('G5 · the run id survived all six seats', done.id === fullId, done.id + ' vs ' + fullId);
  check('G5 · every AUTO call addressed that same run',
        AUTO_LOG.length >= 5 && AUTO_LOG.every(x => x.runId === fullId), JSON.stringify(AUTO_LOG.slice(0, 3)));
  check('G · zero page errors across the AUTO walk', errors.length === 0, errors.slice(0, 2).join(' | '));

  /* ── 5. THE DECISION CARD MUST OBEY THE SAME MATRIX ──────────────────────────
     wcDecisionHtml() used to print GET THE DECISION unconditionally — it never consulted
     wcMode() or autoAvailable, unlike wcCardHtml(). So the failure matrix was correct on the
     five ordinary seat cards and silently bypassed on the one card that decides: with no
     Gemini key it still offered AUTO, and no terminal failure could actually remove RUN.

     The whole matrix is therefore driven again HERE, against synthesis specifically. */
  const decisionState = () => page.evaluate(() => ({
    auto:   !!document.querySelector('[data-wc-auto="synthesis"]'),
    disabled: !!(document.querySelector('[data-wc-auto="synthesis"]') || {}).disabled,
    copy:   !!document.querySelector('[data-wc-copy="synthesis"]'),
    paste:  !!document.querySelector('[data-wc-paste="synthesis"]'),
    badge:  (document.querySelector('#wcSeat_synthesis .wc-badge') || {}).textContent || '',
    verdict:(document.querySelector('#wcFlow .wc-dec .verdict') || {}).textContent || ''
  }));
  // Rewind to a decision-stage run that has NOT yet been synthesised.
  const rewindToDecision = async () => page.evaluate(() => {
    delete WC_UI.synthesis; delete WC_UI['synthesis:mode']; delete WC_UI['synthesis:failCode'];
    WC_RESP = WC_RESP.filter(r => r.seat !== 'synthesis'); wcRender();
  });

  AUTO_MODE = 'ok';
  await rewindToDecision();
  const d0 = await decisionState();
  check('G6 · with a key, the chair offers GET THE DECISION', d0.auto === true, d0.badge);
  check('G6 · and does NOT pre-empt with copy/paste', d0.copy === false);

  for (const code of ['timeout', 'invalid_reply', 'provider_error', 'store_unreachable']) {
    AUTO_MODE = 'fail:' + code;
    await rewindToDecision();
    await page.evaluate(() => { const b = document.querySelector('[data-wc-auto="synthesis"]'); if (b) b.click(); });
    await page.waitForTimeout(450);
    const d = await decisionState();
    check('G6 · synthesis ' + code + ' KEEPS GET THE DECISION', d.auto === true, d.badge);
    check('G6 · synthesis ' + code + ' also exposes MANUAL', d.copy === true && d.paste === true);
  }
  check('G6 · a bad-format reply is named as such', /BAD FORMAT/.test(
    (await (async () => { AUTO_MODE = 'fail:invalid_reply'; await rewindToDecision();
      await page.evaluate(() => { const b = document.querySelector('[data-wc-auto="synthesis"]'); if (b) b.click(); });
      await page.waitForTimeout(450); return (await decisionState()).badge; })())));

  for (const code of ['no_api_key', 'auth_failed', 'rate_limited', 'manual_only']) {
    AUTO_MODE = 'fail:' + code;
    await rewindToDecision();
    await page.evaluate(() => { const b = document.querySelector('[data-wc-auto="synthesis"]'); if (b) b.click(); });
    await page.waitForTimeout(450);
    const d = await decisionState();
    check('G6 · synthesis ' + code + ' REMOVES GET THE DECISION', d.auto === false, d.badge);
    check('G6 · synthesis ' + code + ' badge says MANUAL', /MANUAL/.test(d.badge), d.badge);
    check('G6 · synthesis ' + code + ' still offers MANUAL controls', d.copy === true);
  }

  /* NO KEY AT ALL. The card must start in MANUAL — not offer AUTO and then make a doomed
     call to discover what its own metadata already said. */
  AUTO_LOG.length = 0;
  WC_SEED.synthesis.autoAvailable = false; WC_SEED.synthesis.defaultMode = 'manual';
  /* The page holds the seat metadata it was last given, so the flip only reaches it on a
     refresh — the same way a real key change would. Without this the test would be asserting
     against stale metadata and could pass while the card ignored the field entirely. */
  await page.evaluate(() => wcRefresh());
  await page.waitForTimeout(400);
  await rewindToDecision();
  const noKey = await decisionState();
  check('G6 · with NO key the chair starts in MANUAL', noKey.auto === false, noKey.badge);
  check('G6 · manual controls are offered immediately', noKey.copy === true && noKey.paste === true);
  check('G6 · and it explains why', await page.evaluate(() =>
    /No API key for the chair/.test((document.getElementById('wcSeat_synthesis') || {}).textContent || '')));
  check('G6 · NO doomed AUTO call was made', AUTO_LOG.length === 0, JSON.stringify(AUTO_LOG));
  WC_SEED.synthesis.autoAvailable = true; WC_SEED.synthesis.defaultMode = 'auto';
  await page.evaluate(() => wcRefresh());
  await page.waitForTimeout(400);

  // A successful decision renders the verdict and offers no duplicate run action.
  AUTO_MODE = 'ok';
  await rewindToDecision();
  await page.evaluate(() => { const b = document.querySelector('[data-wc-auto="synthesis"]'); if (b) b.click(); });
  await page.waitForTimeout(500);
  const dOk = await decisionState();
  check('G6 · a valid decision renders the verdict', /GO/.test(dOk.verdict), dOk.verdict);
  check('G6 · and shows no duplicate run action', dOk.auto === false && dOk.copy === false);

  /* ── 6. THE DEFECT A ROAD TEST FOUND: a decision that renders NO VERDICT ─────
     The row was stored correctly and the AUTO route's seat-response projection omitted the
     `parsed` column. The page renders from seatResponses, so the run completed showing NO
     VERDICT. Every test passed because they all read `saved`, which the INSERT returns with
     every column — and this stub's rows were hand-written WITH parsed.

     STUB_DROP_PARSED now reproduces that server. The page must survive it, because merging
     `j.saved` means the answer just written cannot be lost by a bad reread. */
  AUTO_MODE = 'ok';
  STUB_DROP_PARSED = true;
  await rewindToDecision();
  await page.evaluate(() => { const b = document.querySelector('[data-wc-auto="synthesis"]'); if (b) b.click(); });
  await page.waitForTimeout(500);
  const dropped = await decisionState();
  check('G7 · a decision renders even when seatResponses omits parsed',
        /GO/.test(dropped.verdict), dropped.verdict);
  check('G7 · it is NOT rendered as NO VERDICT', !/NO VERDICT/.test(dropped.verdict), dropped.verdict);
  check('G7 · and the run reads as complete', await page.evaluate(() => wcDone('synthesis')) === true);
  STUB_DROP_PARSED = false;

  /* ── 7. A LEGACY OK ROW THAT IS NOT A DECISION ───────────────────────────────
     Rows stored before the contract existed are still status:"ok" with prose in them. They
     must not complete the run, or a resumed Wildcard shows NO VERDICT with nothing to press. */
  await page.evaluate(() => {
    WC_RESP = WC_RESP.filter(r => r.seat !== 'synthesis');
    WC_RESP.push({ id: 'legacy-1', seat: 'synthesis', stage: 'locked', source: 'api',
                   status: 'ok', raw_response: 'On balance this looks reasonable.', parsed: null });
    delete WC_UI.synthesis; delete WC_UI['synthesis:mode']; wcRender();
  });
  await page.waitForTimeout(300);
  const legacy = await decisionState();
  check('G7 · a legacy OK row does NOT complete the run',
        await page.evaluate(() => wcDone('synthesis')) === false);
  check('G7 · no verdict is invented from it', !/GO|NO-GO|NONE/.test(legacy.verdict), legacy.verdict);
  check('G7 · and the chair can still be run again', legacy.auto === true || legacy.copy === true);

  // Restore the seed so this walk cannot alter what any later test sees.
  Object.keys(WC_SEED).forEach(k => delete WC_SEED[k]);
  Object.assign(WC_SEED, JSON.parse(seedBackup));
  AUTO_MODE = 'notfound';
  await ctx.close();
}

(async () => {
  await new Promise(r => web.listen(8901, r));
  await new Promise(r => api.listen(8902, r));
  const browser = await chromium.launch({args:['--no-proxy-server']});

  // A1 — clean state, NO backend configured. Today's behaviour must be untouched.
  const a1 = await variant(browser, 'A1 offline/clean', { backendUrl: '', token: '', mode: '200' });
  check('A1 · no sign-in overlay (nothing returned 401)', a1.authOpen === false);

  // A2 — backend configured, returns 401. The overlay must appear OVER a rendered page.
  // No token at all: the overlay must STAY SHUT on load. This is the rollout-safety property —
  // before the backend enforces auth there is no token, so no sign-in screen may appear.
  const a2 = await variant(browser, 'A2 backend 401', { backendUrl: 'http://127.0.0.1:8902', token: '', mode: '401' });
  check('A2 · overlay stays shut with no token (rollout safety)', a2.authOpen === false);
  check('A2 · overlay opens once a protected call 401s', a2.after401 === true);

  // B — valid token, backend accepts. Dashboard renders automatically, no overlay, no click.
  const b = await variant(browser, 'B authenticated', { backendUrl: 'http://127.0.0.1:8902', token: GOOD_TOKEN, mode: '200' });
  check('B · dashboard renders with no overlay', b.authOpen === false);
  check('B · token retained', b.tokenLeft === GOOD_TOKEN);

  // C — garbage token in storage. THE historical failure shape: a malformed value reaching a renderer.
  const c = await variant(browser, 'C garbage token', { backendUrl: 'http://127.0.0.1:8902', token: '{{{not-a-token', mode: '401' });
  check('C · sign-in overlay is open', c.authOpen === true);
  check('C · stale token was cleared', c.tokenLeft === null);

  // D — a well-formed but EXPIRED token. Must prompt on load without any network call.
  const d = await variant(browser, 'D expired token', { backendUrl: 'http://127.0.0.1:8902', token: DEAD_TOKEN, mode: '200' });
  check('D · overlay opens on load for an expired token', d.authOpen === true);
  check('D · expired token cleared', d.tokenLeft === null);

  // F — DESKTOP LAYOUT. The desktop grid is CSS-only, so a unit test cannot see it.
  // These assertions read real geometry from a real 1512px browser.
  await desktopLayout(browser);

  // E — walk all four Wildcard steps in a real browser.
  // The complaint being tested: six seat cards on screen at once reads as six jobs.
  // At no point may more than TWO cards be visible, and the seats that are not yet
  // actionable must appear as small waiting rows, never as cards.
  await wildcardWalk(browser);

  // G — AUTO across MORE THAN ONE seat. Everything above only ever ran AUTO once, which is
  // precisely why the run-id loss and the RETRY/manual contradiction both survived to review.
  await autoRunWalk(browser);

  await browser.close();
  web.close(); api.close();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${'='.repeat(56)}\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('FAILED:'); failed.forEach(f => console.log('  - ' + f.name + (f.detail ? ' → ' + f.detail : ''))); process.exit(1); }
  console.log('ALL PASS — primary panels render on fresh load in every variant.');
})();
