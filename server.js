'use strict';
/*
 * Investing Command Centre — secure data + AI proxy
 * --------------------------------------------------
 * Holds all API keys server-side. The frontend calls these endpoints and
 * never sees a key. Every adapter fails soft: a missing key or a dead
 * upstream returns null for that field instead of crashing the response.
 *
 * Endpoints
 *   GET  /api/health
 *   GET  /api/prices?symbols=VOO,QQQ,NVDA,MSFT,VXUS,SCHD
 *   GET  /api/market          -> spx, ndx, vix, y2, y10, dxy
 *   GET  /api/macro           -> cpi, cpiPrev, fedRate, cutProb, fg, breadth
 *   GET  /api/events          -> upcoming CPI/PPI/Jobs/Fed + NVDA/MSFT earnings
 *   GET  /api/news            -> market headlines
 *   POST /api/deep-triggers   -> { packet } => AI consensus, verdict, risk, $1000, idiot guide
 */

try { require('dotenv').config(); } catch (_) { /* dotenv optional: hosted platforms inject env vars directly */ }
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '128kb' }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

const PORT = process.env.PORT || 8787;
const FINNHUB = process.env.FINNHUB_API_KEY || '';
const FRED = process.env.FRED_API_KEY || '';
// eToro read-only. We never request or send trade/order/leverage scopes.
const ETORO_KEY = process.env.ETORO_API_KEY || '';
const ETORO_URL = process.env.ETORO_API_URL || '';

/* ───────── tiny utilities ───────── */
async function getJson(url, opts = {}, ms = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}
const num = (v) => (v == null || v === '' || v === '.' || isNaN(+v)) ? null : +v;

// in-memory cache so we don't burn free-tier quotas on rapid refreshes
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  const data = await fn();
  cache.set(key, { data, exp: Date.now() + ttlMs });
  return data;
}

// very light per-IP rate limit (protects your keys from a runaway client)
const hits = new Map();
app.use((req, res, next) => {
  const ip = req.ip || 'x';
  const now = Date.now();
  const w = hits.get(ip) || { n: 0, exp: now + 60000 };
  if (w.exp < now) { w.n = 0; w.exp = now + 60000; }
  w.n++; hits.set(ip, w);
  if (w.n > 120) return res.status(429).json({ error: 'rate_limited' });
  next();
});

/* ───────── FRED helpers ───────── */
async function fredObs(series, limit = 1) {
  if (!FRED) return [];
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${FRED}&file_type=json&sort_order=desc&limit=${limit}`;
  const j = await getJson(url);
  return (j.observations || []).map(o => ({ date: o.date, value: num(o.value) }));
}
async function fredLatest(series) {
  // pull a few in case the most recent is missing (".")
  const obs = await fredObs(series, 6);
  const first = obs.find(o => o.value != null);
  return first ? first.value : null;
}

/* ───────── /api/health ───────── */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    keys: {
      etoro: !!ETORO_KEY, finnhub: !!FINNHUB, fred: !!FRED, supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
      openai: !!process.env.OPENAI_API_KEY, anthropic: !!process.env.ANTHROPIC_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY, perplexity: !!process.env.PERPLEXITY_API_KEY
    },
    ts: Date.now()
  });
});

/* ───────── /api/prices ───────── */
app.get('/api/prices', async (req, res) => {
  const symbols = String(req.query.symbols || 'VOO,QQQ,NVDA,MSFT,VXUS,SCHD')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 25);
  try {
    const data = await cached('prices:' + symbols.join(','), 30000, async () => {
      const out = {};
      if (!FINNHUB) return { prices: {}, source: 'none', note: 'set FINNHUB_API_KEY' };
      await Promise.all(symbols.map(async sym => {
        try {
          const j = await getJson(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB}`);
          if (j && j.c) out[sym] = { price: j.c, dp: num(j.dp), change: num(j.d), prevClose: num(j.pc) };
        } catch (_) { /* leave symbol out */ }
      }));
      return { prices: out, source: 'finnhub' };
    });
    res.json({ ...data, ts: Date.now() });
  } catch (e) { res.json({ prices: {}, source: 'error', error: String(e.message), ts: Date.now() }); }
});

/* ───────── /api/market ───────── */
app.get('/api/market', async (req, res) => {
  try {
    const data = await cached('market', 60000, async () => {
      const [spx, ndx, vix, y2, y10, dxy] = await Promise.all([
        fredLatest('SP500').catch(() => null),
        fredLatest('NASDAQCOM').catch(() => null),
        fredLatest('VIXCLS').catch(() => null),
        fredLatest('DGS2').catch(() => null),
        fredLatest('DGS10').catch(() => null),
        fredLatest('DTWEXBGS').catch(() => null)
      ]);
      return { spx, ndx, vix, y2, y10, dxy, source: FRED ? 'fred' : 'none' };
    });
    res.json({ ...data, note: 'FRED values are daily close (may lag intraday).', ts: Date.now() });
  } catch (e) { res.json({ error: String(e.message), ts: Date.now() }); }
});

/* ───────── /api/macro ───────── */
async function cpiYoY() {
  // CPIAUCSL is a monthly index; YoY = latest vs 12 months prior
  const obs = await fredObs('CPIAUCSL', 14);
  const vals = obs.filter(o => o.value != null);
  if (vals.length < 13) return { cpi: null, cpiPrev: null };
  const cpi = +(((vals[0].value / vals[12].value) - 1) * 100).toFixed(1);
  const cpiPrev = vals.length > 13 ? +(((vals[1].value / vals[13].value) - 1) * 100).toFixed(1) : null;
  return { cpi, cpiPrev };
}
async function fearGreed() {
  // CNN's index has no official API; this unofficial endpoint is best-effort.
  try {
    const j = await getJson('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, 7000);
    const s = j && j.fear_and_greed && j.fear_and_greed.score;
    return s != null ? Math.round(s) : null;
  } catch (_) { return null; }
}
app.get('/api/macro', async (req, res) => {
  try {
    const data = await cached('macro', 6 * 3600000, async () => {
      const [{ cpi, cpiPrev }, fedRate, fg] = await Promise.all([
        cpiYoY().catch(() => ({ cpi: null, cpiPrev: null })),
        fredLatest('DFF').catch(() => null),   // effective fed funds rate, daily
        fearGreed()
      ]);
      return {
        cpi, cpiPrev,
        fedRate: fedRate != null ? +fedRate.toFixed(2) : null,
        cutProb: null,   // no reliable free source (CME FedWatch is gated) — keep manual
        fg,
        breadth: null,   // no reliable free source — keep manual
        source: FRED ? 'fred+cnn' : 'cnn'
      };
    });
    res.json({ ...data, ts: Date.now() });
  } catch (e) { res.json({ error: String(e.message), ts: Date.now() }); }
});

/* ───────── /api/events ───────── */
async function earningsDate(symbol) {
  if (!FINNHUB) return null;
  const today = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
  try {
    const j = await getJson(`https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${to}&symbol=${symbol}&token=${FINNHUB}`);
    const arr = (j.earningsCalendar || []).filter(e => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    return arr.length ? arr[0].date : null;
  } catch (_) { return null; }
}
app.get('/api/events', async (req, res) => {
  try {
    const data = await cached('events', 6 * 3600000, async () => {
      const [nvda, msft] = await Promise.all([earningsDate('NVDA'), earningsDate('MSFT')]);
      // Macro release dates need a paid economic calendar; left blank for you to set
      // in the dashboard. Earnings come straight from Finnhub when a key is present.
      const events = [
        { name: 'US CPI', date: '', time: '13:30', impact: 'high', watch: 'Inflation print — drives the Fed.' },
        { name: 'US PPI', date: '', time: '13:30', impact: 'med', watch: 'Producer prices, CPI preview.' },
        { name: 'Jobs report (NFP)', date: '', time: '13:30', impact: 'high', watch: 'Labour strength vs rate cuts.' },
        { name: 'FOMC decision', date: '', time: '19:00', impact: 'high', watch: 'Rate decision + guidance.' },
        { name: 'NVDA earnings', date: nvda || '', time: '21:00', impact: 'high', watch: 'Your biggest single-stock risk.' },
        { name: 'MSFT earnings', date: msft || '', time: '21:00', impact: 'med', watch: 'Cloud + AI capex read.' }
      ];
      return { events, source: FINNHUB ? 'finnhub-earnings' : 'config', note: 'Macro release dates need manual entry (no free economic calendar).' };
    });
    res.json({ ...data, ts: Date.now() });
  } catch (e) { res.json({ events: [], error: String(e.message), ts: Date.now() }); }
});

/* ───────── /api/news ───────── */
app.get('/api/news', async (req, res) => {
  try {
    const data = await cached('news', 5 * 60000, async () => {
      if (!FINNHUB) return { news: [], source: 'none' };
      const j = await getJson(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB}`);
      const news = (Array.isArray(j) ? j : []).slice(0, 8).map(n => ({
        headline: n.headline, source: n.source, url: n.url,
        datetime: n.datetime ? n.datetime * 1000 : null, summary: (n.summary || '').slice(0, 240)
      }));
      return { news, source: 'finnhub' };
    });
    res.json({ ...data, ts: Date.now() });
  } catch (e) { res.json({ news: [], error: String(e.message), ts: Date.now() }); }
});

/* ───────── /api/portfolio (eToro READ-ONLY stub) ─────────
 * Read-only sync of holdings, value, cash and P/L. This NEVER places orders,
 * never requests trade/leverage/CFD scopes, and never executes anything.
 *
 * eToro's portfolio API requires approved read-only partner access, and the
 * exact response shape depends on that access. So the upstream URL + key are
 * env-configured and the response is run through a tolerant mapper. Until you
 * have access (or point ETORO_API_URL at your own read-only adapter), this
 * returns source:"manual" so the dashboard keeps using manual/last-known data.
 */
function n2(v) { const x = num(v); return x == null ? null : x; }
function mapEtoro(raw) {
  // Accept either our already-normalised shape (from your own read-only adapter)
  // or a generic eToro-style positions payload. Best-effort, never throws.
  if (raw && Array.isArray(raw.holdings)) return normalisePortfolio(raw); // already-normalised passthrough
  const positions = (raw && (raw.positions || raw.holdings || raw.instruments || raw.assets)) || [];
  const cash = n2(raw && (raw.availableCashUsd ?? raw.cash ?? raw.availableCash ?? raw.realizedCredit));
  const holdings = (Array.isArray(positions) ? positions : []).map(p => ({
    symbol: String(p.symbol || p.ticker || p.instrumentName || p.name || '').toUpperCase(),
    name: p.name || p.instrumentName || p.symbol || '',
    units: n2(p.units ?? p.amount ?? p.quantity ?? p.shares),
    currentPrice: n2(p.currentPrice ?? p.price ?? p.marketPrice ?? p.rate),
    valueUsd: n2(p.valueUsd ?? p.value ?? p.marketValue),
    plUsd: n2(p.plUsd ?? p.pl ?? p.profit ?? p.unrealizedPl),
  })).filter(h => h.symbol);
  return normalisePortfolio({ holdings, availableCashUsd: cash, todayPlUsd: n2(raw && raw.todayPlUsd), totalPlUsd: n2(raw && raw.totalPlUsd) });
}
function normalisePortfolio(p) {
  const holdings = (p.holdings || []).map(h => {
    const units = n2(h.units), price = n2(h.currentPrice);
    const valueUsd = h.valueUsd != null ? n2(h.valueUsd) : (units != null && price != null ? units * price : null);
    return { symbol: h.symbol, name: h.name || h.symbol, units, currentPrice: price, valueUsd, plUsd: n2(h.plUsd), allocationPercent: null };
  });
  const cash = n2(p.availableCashUsd) || 0;
  const invested = holdings.reduce((s, h) => s + (h.valueUsd || 0), 0);
  const total = invested + cash;
  const allocationPercentages = {};
  holdings.forEach(h => { h.allocationPercent = total > 0 ? +(((h.valueUsd || 0) / total) * 100).toFixed(2) : 0; allocationPercentages[h.symbol] = h.allocationPercent; });
  allocationPercentages.CASH = total > 0 ? +((cash / total) * 100).toFixed(2) : 0;
  const totalPl = p.totalPlUsd != null ? n2(p.totalPlUsd) : holdings.reduce((s, h) => s + (h.plUsd || 0), 0);
  return {
    portfolioValueUsd: +total.toFixed(2),
    availableCashUsd: +cash.toFixed(2),
    todayPlUsd: n2(p.todayPlUsd),
    totalPlUsd: totalPl,
    holdings, allocationPercentages,
    lastUpdated: new Date().toISOString()
  };
}

app.get('/api/portfolio', async (req, res) => {
  if (!ETORO_KEY || !ETORO_URL) {
    return res.json({
      source: 'manual', connected: false,
      note: 'eToro read-only not configured. Set ETORO_API_KEY + ETORO_API_URL (read-only) to enable. Dashboard uses manual/last-known data.',
      portfolioValueUsd: null, availableCashUsd: null, todayPlUsd: null, totalPlUsd: null,
      holdings: [], allocationPercentages: {}, lastUpdated: null, ts: Date.now()
    });
  }
  try {
    const data = await cached('portfolio', 60000, async () => {
      // READ-ONLY request. No trade/order/leverage scopes are ever sent.
      const raw = await getJson(ETORO_URL, {
        headers: { 'Authorization': 'Bearer ' + ETORO_KEY, 'X-Permissions': 'read-only', 'Accept': 'application/json' }
      }, 12000);
      return mapEtoro(raw);
    });
    res.json({ ...data, source: 'etoro', connected: true, ts: Date.now() });
  } catch (e) {
    res.json({
      source: 'manual', connected: false, error: String(e.message),
      note: 'eToro sync unavailable — using manual/last known data.',
      holdings: [], allocationPercentages: {}, ts: Date.now()
    });
  }
});

/* ───────── Phase 3: AI Committee (adversarial + synthesiser) ───────── */
const fs = require('fs');
const path = require('path');
const PROMPT_DIR = path.join(__dirname, 'prompts');
const VERDICTS = ['BUY AGGRESSIVELY', 'BUY GRADUALLY', 'HOLD', 'WAIT', 'REDUCE RISK'];
const STANCE = { 'BUY AGGRESSIVELY': 3, 'BUY GRADUALLY': 2, 'HOLD': 1, 'WAIT': 0, 'REDUCE RISK': 0 };

// Built-in fallbacks used only if a prompt file is missing.
const DEFAULTS = {
  'system-investing.md': 'You advise Andrew Collins, a long-term eToro ETF/stock investor in Bahrain. Advice only — never place trades, never suggest leverage/CFDs/options/shorting/crypto. Scope: portfolio, markets, dry powder, deployment, risk, opportunity. Be blunt and decision-led.',
  'deep-triggers.md': 'From your role, give a blunt independent read of the portfolio, market, the biggest risk, the best opportunity, and whether to deploy today and where. End with ONE verdict.',
  roles: {
    ChatGPT: 'Investment strategist and deployment coach.',
    Claude: 'Critical risk analyst and devil\'s advocate.',
    Gemini: 'Quantitative market-data scanner.',
    Perplexity: 'Research analyst with live web access.',
    synthesiser: 'You are the chair. Judge which argument is strongest given the data — do not average or vote. Make one decisive call.',
    idiotGuideStyle: 'Plain, blunt, no jargon. Concrete numeric actions.'
  }
};
const _pcache = {};
function loadPrompt(file) {
  try {
    const fp = path.join(PROMPT_DIR, file);
    const st = fs.statSync(fp);
    const c = _pcache[file];
    if (c && c.mt === st.mtimeMs) return c.data;          // serve cached unless the file changed
    const txt = fs.readFileSync(fp, 'utf8');
    _pcache[file] = { mt: st.mtimeMs, data: txt };
    return txt;
  } catch (_) { return DEFAULTS[file] || ''; }
}
function loadRoles() {
  const txt = loadPrompt('ai-roles.json');
  if (txt) { try { return Object.assign({}, DEFAULTS.roles, JSON.parse(txt)); } catch (_) {} }
  return DEFAULTS.roles;
}
function roleLabel(name) { return { ChatGPT: 'strategist', Claude: 'risk analyst', Gemini: 'data scanner', Perplexity: 'web research' }[name] || ''; }

function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (_) {} }
  return null;
}
function coerceVerdict(v) {
  if (!v) return null;
  const up = String(v).toUpperCase();
  return VERDICTS.find(x => up.includes(x)) || null;
}

// Each call takes (userContent, systemContent) so the handler controls the prompt.
async function callOpenAI(user, system) {
  const key = process.env.OPENAI_API_KEY; if (!key) return null;
  const j = await getJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature: 0.4, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
  }, 35000);
  return j.choices && j.choices[0] && j.choices[0].message.content;
}
async function callAnthropic(user, system) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  const j = await getJson('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest', max_tokens: 900, system, messages: [{ role: 'user', content: user }] })
  }, 35000);
  return j.content && j.content[0] && j.content[0].text;
}
async function callGemini(user, system) {
  const key = process.env.GEMINI_API_KEY; if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  const j = await getJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: system + '\n\n' + user }] }] })
  }, 35000);
  return j.candidates && j.candidates[0] && j.candidates[0].content.parts[0].text;
}
async function callPerplexity(user, system) {
  const key = process.env.PERPLEXITY_API_KEY; if (!key) return null;
  const j = await getJson('https://api.perplexity.ai/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ model: process.env.PERPLEXITY_MODEL || 'sonar', temperature: 0.3, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
  }, 35000);
  return j.choices && j.choices[0] && j.choices[0].message.content;
}
const MODELS = [
  { name: 'ChatGPT', call: callOpenAI }, { name: 'Claude', call: callAnthropic },
  { name: 'Gemini', call: callGemini }, { name: 'Perplexity', call: callPerplexity }
];
function hasKey(name) {
  return { ChatGPT: !!process.env.OPENAI_API_KEY, Claude: !!process.env.ANTHROPIC_API_KEY, Gemini: !!process.env.GEMINI_API_KEY, Perplexity: !!process.env.PERPLEXITY_API_KEY }[name];
}
// Synthesiser preference: Claude → ChatGPT → Gemini → Perplexity (first one with a key).
function pickSynth() {
  const order = ['Claude', 'ChatGPT', 'Gemini', 'Perplexity'];
  for (const n of order) { if (hasKey(n)) return MODELS.find(m => m.name === n); }
  return null;
}

const MODEL_ASK = '\n\nRespond ONLY with compact JSON, no markdown:\n{"verdict":"<one of: ' + VERDICTS.join(' | ') + '>","keyArgument":"<your single strongest point>","weakestAssumption":"<the weakest assumption in the optimistic case>","risk":"<the biggest risk being ignored>","deploy":"<exact $ split for new cash today, or WAIT FOR <event>>","reasoning":"<2-3 blunt sentences>"}';
const SYNTH_ASK = '\n\nYou MUST judge which argument is strongest. DO NOT average the verdicts and DO NOT just take the majority. Decide.\n\nRespond ONLY with compact JSON, no markdown:\n{"finalVerdict":"<one of: ' + VERDICTS.join(' | ') + '>","agree":["<points all/most models agree on>"],"disagree":["<genuine points of disagreement>"],"strongestArgument":"<which view is strongest and why>","weakestAssumption":"<the weakest assumption anyone is relying on>","riskWarning":"<one blunt sentence>","ifIHad1000":"<exact $ split totalling 1000, or WAIT FOR <event>>","idiotGuide":{"do":["..."],"dont":["..."],"checkAgain":"..."}}';

app.post('/api/deep-triggers', async (req, res) => {
  const packet = req.body && req.body.packet;
  if (!packet || typeof packet !== 'string') return res.status(400).json({ error: 'missing packet' });

  const SYSTEM = loadPrompt('system-investing.md');
  const TASK = loadPrompt('deep-triggers.md');
  const ROLES = loadRoles();

  // 1) Independent views — each model analyses the same packet in its own role.
  const results = await Promise.allSettled(MODELS.map(async m => {
    if (!hasKey(m.name)) return null;
    const system = SYSTEM + '\n\nYOUR ROLE: ' + (ROLES[m.name] || '') + '\n\n' + TASK + MODEL_ASK;
    const raw = await m.call(packet, system);
    if (!raw) return null;
    const p = parseJsonLoose(raw) || {};
    return {
      name: m.name, role: roleLabel(m.name),
      verdict: coerceVerdict(p.verdict) || coerceVerdict(raw),
      keyArgument: p.keyArgument || '', weakestAssumption: p.weakestAssumption || '',
      risk: p.risk || '', deploy: p.deploy || '',
      text: p.reasoning || (typeof raw === 'string' ? raw.slice(0, 600) : '')
    };
  }));
  const models = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
  if (!models.length) return res.json({ models: [], consensus: 0, verdict: null, agree: [], disagree: [], strongestArgument: '', weakestAssumption: '', risk: 'No AI models configured. Set at least one key (OPENAI/ANTHROPIC/GEMINI/PERPLEXITY).', ifIHad1000: null, idiotGuide: null, synthesised: false, ts: Date.now() });

  // consensus = how much the independent models agree (NOT the final call)
  const verdicts = models.map(m => m.verdict).filter(Boolean);
  const tally = {}; verdicts.forEach(v => tally[v] = (tally[v] || 0) + 1);
  let top = null, topN = 0;
  Object.entries(tally).forEach(([k, n]) => { if (n > topN || (n === topN && top && STANCE[k] < STANCE[top])) { top = k; topN = n; } });
  const consensus = verdicts.length ? Math.round(topN / verdicts.length * 100) : 0;

  // 2) Synthesiser — judges the strongest argument and makes ONE decisive call.
  let synth = null;
  const synthModel = pickSynth();
  if (synthModel) {
    try {
      const system = SYSTEM + '\n\nYOU ARE THE COMMITTEE CHAIR / SYNTHESISER.\n' + (ROLES.synthesiser || '') + '\n\nIdiot\'s Guide style: ' + (ROLES.idiotGuideStyle || '') + SYNTH_ASK;
      const user = 'DATA PACKET:\n' + packet + '\n\nINDEPENDENT MODEL VIEWS:\n' + JSON.stringify(models.map(m => ({ model: m.name, verdict: m.verdict, keyArgument: m.keyArgument, weakestAssumption: m.weakestAssumption, risk: m.risk, deploy: m.deploy, reasoning: m.text })), null, 1);
      const raw = await synthModel.call(user, system);
      synth = parseJsonLoose(raw);
    } catch (_) { /* fall back to majority below */ }
  }

  const verdict = (synth && coerceVerdict(synth.finalVerdict)) || top;
  res.json({
    models, consensus, verdict,
    agree: (synth && synth.agree) || [],
    disagree: (synth && synth.disagree) || [],
    strongestArgument: (synth && synth.strongestArgument) || '',
    weakestAssumption: (synth && synth.weakestAssumption) || models.map(m => m.weakestAssumption).filter(Boolean)[0] || '',
    risk: (synth && synth.riskWarning) || models.map(m => m.risk).filter(Boolean)[0] || '',
    ifIHad1000: (synth && synth.ifIHad1000) || models.map(m => m.deploy).filter(Boolean)[0] || null,
    idiotGuide: (synth && synth.idiotGuide) || null,
    synthesised: !!synth, synthBy: synthModel ? synthModel.name : null,
    ts: Date.now()
  });
});

/* ───────── Prompt management (admin) ───────── */
const PROMPT_FILES = ['system-investing.md', 'deep-triggers.md', 'ai-roles.json'];
app.get('/api/prompts', (req, res) => {
  const out = {};
  PROMPT_FILES.forEach(f => out[f] = loadPrompt(f));
  res.json({ dir: PROMPT_DIR, files: PROMPT_FILES, prompts: out, ts: Date.now() });
});
app.post('/api/prompts', (req, res) => {
  const { file, content } = req.body || {};
  if (!PROMPT_FILES.includes(file)) return res.status(400).json({ error: 'unknown file', allowed: PROMPT_FILES });
  if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
  if (file === 'ai-roles.json') { try { JSON.parse(content); } catch (e) { return res.status(400).json({ error: 'invalid JSON: ' + e.message }); } }
  try {
    fs.mkdirSync(PROMPT_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROMPT_DIR, file), content, 'utf8');
    delete _pcache[file];
    res.json({ ok: true, file, savedBytes: content.length, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ error: 'write failed (filesystem may be read-only on this host): ' + e.message });
  }
});

/* ───────── Our own portfolio history DB (independent of eToro) ─────────
 * Durable store for snapshots + decision journal. The frontend is local-first
 * (localStorage) and mirrors here so history survives device changes.
 *
 * Storage backend, picked automatically:
 *   1. Supabase  — if SUPABASE_URL + SUPABASE_SERVICE_KEY are set (durable, shared)
 *   2. JSON file — backend/data/history.json
 *   3. In-memory — if the filesystem is read-only
 * Supabase failures fall back to the file store so a write never crashes.
 */
const DATA_DIR = path.join(__dirname, 'data');
const HIST_FILE = path.join(DATA_DIR, 'history.json');
let _hist = null;
function histLoad() {
  if (_hist) return _hist;
  try { _hist = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch (_) { _hist = { snapshots: [], journal: [] }; }
  if (!_hist.snapshots) _hist.snapshots = []; if (!_hist.journal) _hist.journal = [];
  return _hist;
}
function histSave() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(HIST_FILE, JSON.stringify(_hist)); } catch (_) { /* in-memory only */ } }

// ---- Supabase (service-role, server-side only; targets the `investing` schema) ----
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SB_SCHEMA = process.env.SUPABASE_SCHEMA || 'investing';
const sbOn = () => !!(SB_URL && SB_KEY);
function sbHeaders(write) {
  const h = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
  h[write ? 'Content-Profile' : 'Accept-Profile'] = SB_SCHEMA;   // select the investing schema
  return h;
}
const iso = (ms) => ms == null ? null : new Date(typeof ms === 'number' ? ms : Date.parse(ms)).toISOString();
function mapSnap(e) {
  return { ts: iso(e.ts) || new Date().toISOString(), trigger: e.trigger, value: e.value, cash: e.cash, dry_powder: e.dryPowder,
    cash_pc: e.cashPc, holdings: e.holdings, alloc: e.alloc, tot_pl: e.totPl, day_pl: e.dayPl, danger: e.danger,
    opportunity: e.opportunity, status: e.status, light: e.light, ai_verdict: e.aiVerdict, suggested_deploy: e.suggestedDeploy, source: e.source };
}
function mapJournal(e) {
  return { id: e.id, ts: iso(e.ts) || new Date().toISOString(), conditions: e.conditions, ai_verdict: e.aiVerdict,
    recommended_action: e.recommendedAction, actual_action: e.actualAction || null, notes: e.notes || null,
    outcome: e.outcome || null, outcome_ts: iso(e.outcomeTs), updated_at: new Date().toISOString() };
}
async function sbAppend(type, incoming) {
  if (type === 'journal') {
    const r = await fetch(`${SB_URL}/rest/v1/journal?on_conflict=id`, { method: 'POST', headers: { ...sbHeaders(true), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(incoming.map(mapJournal)) });
    if (!r.ok) throw new Error('supabase journal ' + r.status + ' ' + (await r.text()).slice(0, 160));
  } else {
    const r = await fetch(`${SB_URL}/rest/v1/snapshots`, { method: 'POST', headers: { ...sbHeaders(true), Prefer: 'return=minimal' }, body: JSON.stringify(incoming.map(mapSnap)) });
    if (!r.ok) throw new Error('supabase snapshots ' + r.status + ' ' + (await r.text()).slice(0, 160));
  }
}
async function sbRead(type, limit) {
  const table = type === 'journal' ? 'journal' : 'snapshots';
  const r = await fetch(`${SB_URL}/rest/v1/${table}?select=*&order=ts.desc&limit=${limit}`, { headers: sbHeaders(false) });
  if (!r.ok) throw new Error('supabase read ' + r.status);
  const rows = await r.json();
  return rows.reverse();   // return oldest-first to match the file store
}

app.get('/api/history', async (req, res) => {
  const type = req.query.type;
  const limit = Math.min(500, +req.query.limit || 200);
  if (sbOn()) {
    try {
      if (type === 'snapshots') return res.json({ snapshots: await sbRead('snapshots', limit), backend: 'supabase', ts: Date.now() });
      if (type === 'journal') return res.json({ journal: await sbRead('journal', limit), backend: 'supabase', ts: Date.now() });
      const [snapshots, journal] = await Promise.all([sbRead('snapshots', limit), sbRead('journal', limit)]);
      return res.json({ snapshots, journal, backend: 'supabase', ts: Date.now() });
    } catch (e) { /* fall through to file store */ }
  }
  const h = histLoad();
  if (type === 'snapshots') return res.json({ snapshots: h.snapshots.slice(-limit), backend: 'file', ts: Date.now() });
  if (type === 'journal') return res.json({ journal: h.journal.slice(-limit), backend: 'file', ts: Date.now() });
  res.json({ snapshots: h.snapshots.slice(-limit), journal: h.journal.slice(-limit), backend: 'file', ts: Date.now() });
});
app.post('/api/history', async (req, res) => {
  const { type, entry, entries } = req.body || {};
  if (!['snapshots', 'journal'].includes(type)) return res.status(400).json({ error: 'type must be snapshots or journal' });
  const incoming = Array.isArray(entries) ? entries : (entry ? [entry] : []);
  if (!incoming.length) return res.status(400).json({ error: 'no entry/entries provided' });
  if (sbOn()) {
    try { await sbAppend(type, incoming); return res.json({ ok: true, type, count: incoming.length, backend: 'supabase', ts: Date.now() }); }
    catch (e) { /* fall back to file store below, never crash */ }
  }
  const h = histLoad();
  if (type === 'journal') { incoming.forEach(e => { const i = h.journal.findIndex(x => x.id === e.id); if (i >= 0) h.journal[i] = e; else h.journal.push(e); }); h.journal = h.journal.slice(-500); }
  else { h.snapshots.push(...incoming); h.snapshots = h.snapshots.slice(-1000); }
  histSave();
  res.json({ ok: true, type, count: incoming.length, total: h[type].length, backend: 'file', ts: Date.now() });
});

app.use((req, res) => res.status(404).json({ error: 'not_found' }));
app.listen(PORT, () => console.log(`Investing Command Centre backend on :${PORT}`));
