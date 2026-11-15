'use strict';

/* =====================================================================
   A股涨停跟踪 —— 接力复盘 / 板块强度
   数据：同花顺涨停池 + 东财行情 + 腾讯分时
   ===================================================================== */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const API = {
  THS_POOL: 'https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool',
  THS_BLOCK: 'https://data.10jqka.com.cn/dataapi/limit_up/block_top',
  EM_UT: '7eea3edcaed734bea9cbfc24409ed989',
  EM_POOL: 'https://push2ex.eastmoney.com/',
  EM_QUOTE: 'https://push2.eastmoney.com/api/qt/ulist.np/get',
  EM_TREND: 'https://push2.eastmoney.com/api/qt/stock/trends2/get',
  EM_KLINE: 'https://push2his.eastmoney.com/api/qt/stock/kline/get',
  TX_KLINE: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
  TX_MKLINE: 'https://ifzq.gtimg.cn/appstock/app/kline/mkline',
};
const THS_FIELDS = '199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004';

const S = {
  date: null,
  latestDate: null,
  view: 'relay',
  rule: 'hot',
  chip: null,
  tab: 'zt',
  search: '',
  level: '',
  day: null,          // {zt, zb, dt, prev, blocks, quotes, prevDate}
  quotes: new Map(),  // code -> {chg, price, amt, turnover, flowCap, mainIn}
  minute: new Map(),  // code -> {pre, bars, fake}
  minutePending: new Set(),
  blockMeta: new Map(), // code -> [blockName]
  autoTimer: null,
  loading: false,
  boardMode: 'chg',
  boardSel: new Set(),
  boardCurves: null,
  legendRects: [],
};

/* ------------------------------ utils ------------------------------ */
const pad2 = (n) => String(n).padStart(2, '0');
const ds = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
const dsToDate = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
const shiftDay = (s, n) => { const d = dsToDate(s); d.setDate(d.getDate() + n); return ds(d); };
const isWeekend = (s) => { const w = dsToDate(s).getDay(); return w === 0 || w === 6; };

function fmtAmt(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Math.abs(v);
  if (n >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (n >= 1e4) return (v / 1e4).toFixed(0) + '万';
  return String(Math.round(v));
}
function fmtPct(v, signed = true) {
  if (v == null || isNaN(v)) return '—';
  return (signed && v > 0 ? '+' : '') + v.toFixed(2) + '%';
}
function pctOf(v) {
  if (v == null || v === '' || isNaN(v)) return '—';
  return (+v).toFixed(2) + '%';
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/* unix 秒（北京时间）-> HH:MM:SS */
function fmtTs(sec) {
  if (!sec) return '—';
  const d = new Date(+sec * 1000 + 8 * 3600 * 1000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}
/* 东财 93015 -> 09:30:15 */
function fmtEmTime(v) {
  if (!v) return '—';
  const s = String(v).padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}
function isSh(code) { return code.startsWith('6'); }
function mkName(code) {
  if (code.startsWith('68')) return '创';
  if (code.startsWith('30')) return '创';
  if (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')) return '北';
  return isSh(code) ? '沪' : '深';
}
function marketOf(code) { return isSh(code) ? '1' : '0'; }

async function fetchJSON(url, timeout = 12000, retries = 0, gap = 1500) {
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === retries) throw e;
      await sleep(gap * (i + 1));
    } finally { clearTimeout(t); }
  }
}

function jsonp(url, cbParam = 'cb', timeout = 12000) {
  return new Promise((resolve, reject) => {
    const name = cbParam + '_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      try { delete window[name]; } catch (e) { /* ignore */ }
      if (script.parentNode) script.parentNode.removeChild(script);
    };
    window[name] = (data) => { if (done) return; done = true; cleanup(); resolve(data); };
    script.onerror = () => { if (done) return; done = true; cleanup(); reject(new Error('jsonp error')); };
    const timer = setTimeout(() => {
      if (done) return; done = true; cleanup(); reject(new Error('jsonp timeout'));
    }, timeout);
    script.src = url + (url.includes('?') ? '&' : '?') + cbParam + '=' + name;
    document.head.appendChild(script);
  });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------------------- data layer ---------------------------- */
function levelOf(x) {
  const v = +x.high_days_value;
  if (v > 0) {
    // 高 16 位 = 连板数，低 16 位 = 统计天数（65537=首板，131074=2天2板，196613=5天3板）
    const lv = Math.floor(v / 65536);
    if (lv > 0) return lv;
  }
  const m = /(\d+)\s*板/.exec(x.high_days || '');
  if (m) return +m[1];
  return 1;
}

function normThs(x) {
  return {
    code: String(x.code),
    name: x.name,
    price: +x.latest,
    chg: +x.change_rate,
    turnover: +x.turnover_rate,
    orderAmt: +x.order_amount,
    openNum: +x.open_num,
    type: x.limit_up_type,
    level: levelOf(x),
    daysText: x.high_days,
    first: x.first_limit_up_time || 0,
    last: x.last_limit_up_time || 0,
    reason: x.reason_type || '',
    flowCap: x.currency_value,
    tag: x.change_tag || '',
    tp: Array.isArray(x.time_preview) ? x.time_preview : null,
  };
}

async function fetchThsPool(date) {
  const url = `${API.THS_POOL}?page=1&limit=200&field=${THS_FIELDS}&filter=HS,GEM2STAR&order_field=330324&order_type=0&date=${date}`;
  const j = await fetchJSON(url);
  if (!j || j.status_code !== 0 || !j.data || !Array.isArray(j.data.info)) return [];
  return j.data.info.map(normThs);
}

async function fetchThsBlocks(date) {
  const url = `${API.THS_BLOCK}?filter=HS,GEM2STAR&date=${date}`;
  const j = await fetchJSON(url);
  if (!j || j.status_code !== 0 || !Array.isArray(j.data)) return [];
  return j.data.map((b) => ({
    name: b.name,
    code: b.code,
    chg: +b.change,
    zt: +b.limit_up_num,
    cont: +b.continuous_plate_num,
    high: b.high,
    days: b.days,
    stocks: (b.stock_list || []).map((s) => ({
      code: String(s.code),
      chg: +s.change_rate,
      first: s.first_limit_up_time || 0,
      concept: s.concept || '',
      reason: s.reason_info || '',
    })),
  })).filter((b) => b.zt > 0);
}

function emPoolUrl(kind, date) {
  const page = kind === 'zt' ? 'getTopicZTPool' : kind === 'zb' ? 'getTopicZBPool' : 'getTopicDTPool';
  const sort = kind === 'zt' ? 'fbt:asc' : kind === 'zb' ? 'fbt:asc' : 'fund:asc';
  return `${API.EM_POOL}${page}?ut=${API.EM_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=${sort}&date=${date}&_=${Date.now()}`;
}

function normEm(x) {
  return {
    code: String(x.c),
    name: x.n,
    price: x.p != null ? x.p / 1000 : null,
    chg: x.zdp,
    turnover: x.hs,
    amount: x.amount,
    orderAmt: x.fund,
    openNum: x.zbc || 0,
    first: x.fbt,
    last: x.lbt,
    industry: x.hybk || '',
    days: x.zttj ? x.zttj.days : (x.days || 0),
    cont: x.zttj ? x.zttj.ct : 0,
    flowCap: x.ltsz,
  };
}

async function fetchEmPool(kind, date) {
  const j = await jsonp(emPoolUrl(kind, date));
  if (!j || !j.data || !Array.isArray(j.data.pool)) return [];
  return j.data.pool.map(normEm);
}

async function fetchQuotes(codes) {
  const uniq = Array.from(new Set(codes)).filter(Boolean);
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < uniq.length; i += 60) chunks.push(uniq.slice(i, i + 60));
  await mapLimit(chunks, 3, async (chunk) => {
    const secids = chunk.map((c) => marketOf(c) + '.' + c).join(',');
    const url = `${API.EM_QUOTE}?fltt=2&invt=2&fields=f2,f3,f6,f8,f12,f20,f21,f62&secids=${secids}`;
    const j = await fetchJSON(url);
    const list = (j && j.data && j.data.diff) || [];
    const num = (v) => (v === '-' || v === null || v === undefined || v === '' ? null : +v);
    for (const q of list) {
      out.set(String(q.f12), {
        price: num(q.f2),
        chg: num(q.f3),
        amt: num(q.f6),
        turnover: num(q.f8),
        totalCap: num(q.f20),
        flowCap: num(q.f21),
        mainIn: num(q.f62),
      });
    }
  });
  for (const [k, v] of out) if (v.chg == null) out.delete(k);
  return out;
}

async function fetchMinute(code) {
  const secid = (isSh(code) ? '1.' : '0.') + code;
  const url = `${API.EM_TREND}?ut=${API.EM_UT}&secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=1`;
  const j = await fetchJSON(url, 10000, 2);
  const d = j && j.data;
  if (!d || !Array.isArray(d.trends) || !d.trends.length) return null;
  const pre = +d.preClose || 0;
  const bars = [];
  for (const row of d.trends) {
    const seg = row.split(',');
    const hm = (seg[0] || '').split(' ')[1];
    if (!hm) continue;
    const hh = +hm.slice(0, 2), mm = +hm.slice(3, 5);
    const c = +seg[2];
    if (!c) continue;
    const slot = slotOf(hh * 60 + mm);
    bars.push({ slot, t: hm, o: +seg[1] || c, c, h: +seg[3] || c, l: +seg[4] || c, v: +seg[5] || 0, amt: +seg[6] || 0, avg: +seg[7] || null });
  }
  if (!bars.length) return null;
  return { pre, bars, fake: false };
}

/* 分钟 -> 图表 slot（09:30=0, 11:30=120, 13:00=121, 15:00=241） */
function slotOf(min) {
  if (min <= 690) return min - 570;
  return 120 + (min - 780) + 1;
}
const SLOT_LABELS = [
  [0, '09:30'], [60, '10:30'], [120, '11:30/13:00'], [181, '14:00'], [241, '15:00'],
];

/* 找上一个有数据的交易日 */
async function resolvePrevDate(date) {
  let d = shiftDay(date, -1);
  for (let i = 0; i < 12; i++) {
    if (!isWeekend(d)) {
      try {
        const pool = await fetchThsPool(d);
        if (pool.length) return { date: d, pool };
      } catch (e) { /* continue */ }
    }
    d = shiftDay(d, -1);
  }
  return { date: null, pool: [] };
}

/* 若所选日期无数据（周末/节假日），回退到最近交易日 */
async function resolveDate(date) {
  let d = date;
  for (let i = 0; i < 12; i++) {
    const pool = await fetchThsPool(d);
    if (pool.length) return { date: d, pool };
    d = shiftDay(d, -1);
  }
  return null;
}

/* ---------------------------- load day ---------------------------- */
async function loadDay(date, opts = {}) {
  if (S.loading) return;
  S.loading = true;
  setLoading(true);
  setStatus('正在加载…', '');
  try {
    const resolved = await resolveDate(date);
    if (!resolved) throw new Error('未找到可用的交易日数据');
    const useDate = resolved.date;
    S.date = useDate;
    $('#dateInput').value = `${useDate.slice(0, 4)}-${useDate.slice(4, 6)}-${useDate.slice(6, 8)}`;
    S.latestDate = useDate;

    const zt = resolved.pool;
    const [zb, dt, blocks, prevInfo] = await Promise.all([
      fetchEmPool('zb', useDate).catch(() => []),
      fetchEmPool('dt', useDate).catch(() => []),
      fetchThsBlocks(useDate).catch(() => []),
      resolvePrevDate(useDate),
    ]);

    const allCodes = [...zt.map((s) => s.code), ...zb.map((s) => s.code), ...dt.map((s) => s.code), ...prevInfo.pool.map((s) => s.code)];
    const quotes = await fetchQuotes(allCodes).catch(() => new Map());

    S.quotes = quotes;
    S.day = { zt, zb, dt, prev: prevInfo.pool, prevDate: prevInfo.date, blocks };
    S._lv = null;

    // 代码 -> 所属板块
    const meta = new Map();
    const sortedBlocks = [...blocks].sort((a, b) => b.zt - a.zt);
    for (const b of sortedBlocks) {
      for (const s of b.stocks) {
        if (!meta.has(s.code)) meta.set(s.code, []);
        meta.get(s.code).push(b.name);
      }
    }
    S.blockMeta = meta;

    S.minute.clear();
    S.boardCurves = null;
    if (!S.boardSel.size) {
      sortedBlocks.slice(0, 6).forEach((b) => S.boardSel.add(b.name));
    } else {
      const names = new Set(blocks.map((b) => b.name));
      for (const n of Array.from(S.boardSel)) if (!names.has(n)) S.boardSel.delete(n);
      if (!S.boardSel.size) sortedBlocks.slice(0, 6).forEach((b) => S.boardSel.add(b.name));
    }

    renderAll();
    const t = new Date();
    const hm = `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
    S.lastUpdate = hm;
    setStatus(`已更新 ${hm}`, 'live');
  } catch (e) {
    console.error(e);
    setStatus('加载失败：' + (e.message || e), 'err');
    toast('数据加载失败：' + (e.message || e));
  } finally {
    S.loading = false;
    setLoading(false);
  }
}

function setLoading(on) { $('#loading').classList.toggle('on', on); }
function setStatus(text, cls) {
  $('#statusText').textContent = text;
  const dot = $('#liveDot');
  dot.className = 'dot' + (cls ? ' ' + cls : '');
}
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2600);
}

/* ---------------------------- derived ---------------------------- */
function todayMap() { return new Map(S.day.zt.map((s) => [s.code, s])); }
// 今日真实连板数：昨日也涨停则 +1，否则按首板（同花顺 high_days 是「N天M板」，非严格连续）
function todayLevels() {
  if (S._lv) return S._lv;
  const pm = new Map((S.day.prev || []).map((x) => [x.code, x]));
  const m = new Map();
  for (const s of S.day.zt) {
    const p = pm.get(s.code);
    m.set(s.code, p ? (p.level || 1) + 1 : 1);
  }
  S._lv = m;
  return m;
}
function lvOf(code) { return todayLevels().get(code) || 1; }
function zbMap() { return new Map(S.day.zb.map((s) => [s.code, s])); }
function q(code) { return S.quotes.get(code) || null; }
function chgOf(code, fallback) {
  const v = q(code);
  if (v && v.chg != null) return v.chg;
  return fallback != null ? fallback : null;
}
function blockTags(code, limit = 1) {
  const arr = S.blockMeta.get(code);
  if (arr && arr.length) return arr.slice(0, limit);
  const s = todayMap().get(code);
  if (s && s.reason) return s.reason.split('+').slice(0, limit);
  return [];
}
function maxLevel() {
  let m = 1;
  for (const s of S.day.zt) m = Math.max(m, lvOf(s.code));
  return m;
}

/* ---------------------------- render ---------------------------- */
function renderAll() {
  renderStats();
  renderChips();
  renderLadder();
  renderSector();
  renderList();
}

function renderStats() {
  if (!S.day) return;
  const { zt, zb, dt, prev } = S.day;
  const tMap = todayMap();
  const totalPrev = prev.length;
  let promoted = 0;
  for (const s of prev) if (tMap.has(s.code)) promoted++;
  const rate = totalPrev ? (promoted / totalPrev) * 100 : 0;
  const sealRate = zt.length + zb.length ? (zt.length / (zt.length + zb.length)) * 100 : 0;
  const maxLv = maxLevel();
  const maxLvCount = zt.filter((s) => s.level === maxLv).length;
  const maxLvName = zt.filter((s) => s.level === maxLv).map((s) => s.name).slice(0, 1).join('');

  const items = [
    { k: '涨停家数', v: zt.length, cls: 'up', s: `昨 ${prev.length} 家` },
    { k: '炸板家数', v: zb.length, cls: '', s: `封板率 ${sealRate.toFixed(1)}%` },
    { k: '跌停家数', v: dt.length, cls: 'down', s: dt.length ? '注意风险' : '无跌停' },
    { k: '最高连板', v: maxLv + ' 板', cls: 'accent', s: `${maxLvCount} 家 · ${maxLvName || '—'}` },
    { k: '昨日晋级率', v: promoted + '/' + totalPrev, cls: '', s: `${rate.toFixed(1)}%` },
    { k: '板块热点', v: (S.day.blocks[0] ? S.day.blocks[0].zt : 0) + ' 家', cls: 'up', s: S.day.blocks[0] ? S.day.blocks[0].name : '—' },
  ];
  $('#stats').innerHTML = items.map((it) => `
    <div class="stat ${it.cls}">
      <div class="k">${it.k}</div>
      <div class="v">${it.v}</div>
      <div class="s">${it.s}</div>
    </div>`).join('');
}

function renderChips() {
  if (!S.day) return;
  const blocks = S.day.blocks;
  const total = S.day.zt.length;
  const html = [`<button class="chip ${S.chip ? '' : 'on'}" data-chip="">全部 <span class="n">${total}</span></button>`];
  for (const b of blocks.slice(0, 24)) {
    html.push(`<button class="chip ${S.chip === b.name ? 'on' : ''}" data-chip="${esc(b.name)}">${esc(b.name)} <span class="n">${b.zt}</span></button>`);
  }
  $('#chips').innerHTML = html.join('');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const RULES = {
  hot: (a, b) => (rank(a) - rank(b)) || (b.chg - a.chg),
  chg: (a, b) => (b.chg ?? -999) - (a.chg ?? -999),
  first: (a, b) => (a.first || 9e9) - (b.first || 9e9),
  open: (a, b) => (b.openNum || 0) - (a.openNum || 0),
  order: (a, b) => (b.orderAmt || 0) - (a.orderAmt || 0),
  amount: (a, b) => (b.amount || 0) - (a.amount || 0),
  cap: (a, b) => (a.flowCap || 9e12) - (b.flowCap || 9e12),
  turnover: (a, b) => (b.turnover || 0) - (a.turnover || 0),
};
function rank(x) { return x.status === 'up' ? 0 : x.status === 'boom' ? 1 : 2; }

function buildItems(codes, srcMap) {
  const tMap = todayMap();
  const zMap = zbMap();
  return codes.map((code) => {
    const prevS = srcMap.get(code);
    const t = tMap.get(code);
    const z = zMap.get(code);
    const status = t ? 'up' : z ? 'boom' : 'fail';
    const live = q(code);
    const base = t || z || prevS || {};
    return {
      code,
      name: base.name || code,
      status,
      chg: chgOf(code, base.chg),
      first: t ? t.first : z ? z.first : 0,
      openNum: t ? t.openNum : z ? z.openNum : 0,
      orderAmt: t ? t.orderAmt : 0,
      amount: live ? live.amt : (z ? z.amount : 0),
      turnover: live ? live.turnover : (base.turnover || 0),
      flowCap: live ? live.flowCap : (base.flowCap || 0),
      level: prevS ? prevS.level : (t ? t.level : 1),
    };
  });
}

function renderLadder() {
  if (!S.day) return;
  const { zt, prev } = S.day;
  const chipSet = S.chip ? memberSet(S.chip) : null;
  const groups = new Map();
  for (const s of prev) {
    const lv = s.level || 1;
    if (!groups.has(lv)) groups.set(lv, []);
    groups.get(lv).push(s.code);
  }
  const srcMap = new Map(prev.map((s) => [s.code, s]));
  const rows = [];
  const maxLv = Math.max(...groups.keys(), 1);

  for (let lv = maxLv; lv >= 1; lv--) {
    let codes = groups.get(lv) || [];
    if (chipSet) codes = codes.filter((c) => chipSet.has(c));
    if (!codes.length) continue;
    const items = buildItems(codes, srcMap);
    const succ = items.filter((i) => i.status === 'up').length;
    items.sort(RULES[S.rule] || RULES.hot);
    rows.push(rowHtml(`${lv}进${lv + 1}`, `${succ}/${items.length}`, items.length ? (succ / items.length) * 100 : 0, items));
  }

  // 首板行 = 今日首板
  let first = zt.filter((s) => lvOf(s.code) === 1);
  if (chipSet) first = first.filter((s) => chipSet.has(s.code));
  if (first.length) {
    const items = buildItems(first.map((s) => s.code), new Map(first.map((s) => [s.code, s])));
    items.sort(RULES[S.rule] || RULES.hot);
    const totalToday = zt.length;
    const pct = totalToday ? (items.length / totalToday) * 100 : 0;
    rows.push(rowHtml('首板', `${items.length}/${totalToday}`, pct, items));
  }

  $('#ladder').innerHTML = rows.join('') || '<div class="empty">该板块今日无涨停</div>';
}

function memberSet(name) {
  const b = S.day.blocks.find((x) => x.name === name);
  return b ? new Set(b.stocks.map((s) => s.code)) : new Set();
}

function rowHtml(key, num, pct, items) {
  const cls = pct >= 50 ? 'up' : '';
  const cells = items.map((it) => {
    const tags = blockTags(it.code, 1);
    const tag = tags[0] || '';
    const chgCls = it.chg == null ? 'flat' : it.chg > 0 ? 'up' : it.chg < 0 ? 'down' : 'flat';
    const label = it.status === 'up' ? '成' : it.status === 'boom' ? '炸' : '败';
    return `<span class="stk st ${it.status}" data-code="${it.code}" title="${esc(it.name)} ${it.level ? it.level + '板' : ''}">
      <i class="mk">${mkName(it.code)}</i>
      <em class="nm">${esc(it.name)}</em>
      <i class="st">${label}</i>
      <b class="chg ${chgCls}">${it.chg == null ? '—' : fmtPct(it.chg, false)}</b>
      <i class="sec ${S.chip && tag === S.chip ? 'hl' : ''}">${esc(tag)}</i>
    </span>`;
  }).join('');
  return `<div class="lrow">
    <div class="lrow-key"><b>${key}</b><span class="rate">${num}<i>${pct ? ' = ' + pct.toFixed(0) + '%' : ''}</i></span></div>
    <div class="lrow-stocks">${cells}</div>
  </div>`;
}

/* ---------------------------- sector ---------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureMinutes(codes) {
  const need = codes.filter((c) => !S.minute.has(c) && !S.minutePending.has(c));
  if (!need.length) return;
  need.forEach((c) => S.minutePending.add(c));
  await mapLimit(need, 3, async (code) => {
    try {
      const m = await fetchMinute(code);
      if (m) S.minute.set(code, m);
    } catch (e) { /* ignore */ }
    finally { S.minutePending.delete(code); }
  });
}

/* time_preview: 80 个 3 分钟涨跌幅采样（0..40=09:30-11:30，41..79=13:00-14:54）-> 图表 slot */
function tpSlot(i) {
  const s = i <= 40 ? 3 * i : 121 + 3 * (i - 41);
  return s > 241 ? 241 : s;
}

async function buildBoardCurves() {
  const sel = S.day.blocks.filter((b) => S.boardSel.has(b.name));
  if (!sel.length) return [];
  const pmap = new Map((S.day.zt || []).map((s) => [s.code, s]));

  return sel.map((b) => {
    const arrs = b.stocks.map((s) => {
      const pr = pmap.get(s.code);
      if (!pr || !pr.tp || !pr.tp.length) return null;
      const a = new Array(242).fill(null);
      pr.tp.forEach((v, i) => { a[tpSlot(i)] = v; });
      let zslot = 999;
      if (pr.first) {
        const d = new Date(+pr.first * 1000 + 8 * 3600 * 1000);
        zslot = slotOf(d.getUTCHours() * 60 + d.getUTCMinutes());
      }
      return { a, zslot };
    }).filter(Boolean);
    if (!arrs.length) return { name: b.name, values: [], ztCount: b.zt };
    const values = [];
    const ztSeries = [];
    for (let slot = 0; slot <= 241; slot++) {
      let sum = 0, n = 0, zc = 0;
      for (const p of arrs) {
        const v = p.a[slot];
        if (v != null) { sum += v; n++; }
        if (p.zslot <= slot) zc++;
      }
      values.push(n ? sum / n : null);
      ztSeries.push(zc);
    }
    return { name: b.name, values, ztCount: b.zt, ztSeries };
  });
}

async function renderSector() {
  if (!S.day) return;
  const listEl = $('#sectorList');
  const blocks = S.day.blocks;
  if (!blocks.length) {
    listEl.innerHTML = '<div class="empty">暂无板块数据</div>';
    return;
  }
  listEl.innerHTML = blocks.slice(0, 60).map((b) => {
    const on = S.boardSel.has(b.name);
    const chgCls = b.chg > 0 ? 'up' : b.chg < 0 ? 'down' : '';
    return `<label class="srow ${on ? 'on' : ''}" data-board="${esc(b.name)}">
      <input type="checkbox" ${on ? 'checked' : ''}>
      <span class="nm">${esc(b.name)} <em>${b.zt}</em></span>
      <span class="val ${chgCls}">${fmtPct(b.chg, false)}</span>
      <span class="sub">${b.cont ? b.cont + '连' : ''}</span>
    </label>`;
  }).join('');

  $('#sectorHint').textContent = `已选 ${S.boardSel.size} 个板块 · 勾选左侧对比走势`;
  if (!S.boardSel.size) return;

  $('#sectorHint').textContent = '正在加载分时…';
  S.boardCurves = await buildBoardCurves();
  updateSectorHint();
  drawSectorChart();
}

function updateSectorHint() {
  const txt = {
    chg: '成员股等权涨幅 · 3分钟级',
    strength: '强度 = 涨停家数 × 100 + 涨幅 × 10',
    zt: '按首封时间累计的涨停家数',
  }[S.boardMode] || '';
  $('#sectorHint').textContent = `已选 ${S.boardSel.size} 个板块 · ${txt}`;
}

const COLORS = ['#2563eb', '#e11d48', '#f59e0b', '#10b981', '#8b5cf6', '#06b6d4', '#ec4899', '#64748b', '#84cc16', '#f97316'];

function drawSectorChart() {
  const canvas = $('#sectorCanvas');
  canvas._tipEl = $('#sectorTip');
  const curves = (S.boardCurves || []).filter((c) => c.values.length);
  if (!curves.length) {
    drawEmpty(canvas, '暂无分时数据');
    return;
  }

  const mode = S.boardMode;
  const series = curves.map((c, i) => {
    let vals;
    if (mode === 'strength') {
      vals = c.values.map((v, idx) => (v == null ? null : (c.ztSeries[idx] * 100 + v * 10)));
    } else if (mode === 'chg') {
      vals = c.values;
    } else {
      vals = c.ztSeries.map((v) => v);
    }
    return { name: c.name, color: COLORS[i % COLORS.length], vals };
  });

  drawLineChart(canvas, {
    series,
    xFrom: 0, xTo: 241,
    xLabels: SLOT_LABELS,
    yFmt: (v) => (mode === 'chg' ? v.toFixed(1) + '%' : v.toFixed(0)),
    legend: true,
    tipFmt: (items, idx) => {
      const t = labelOfSlot(idx);
      const head = `<div style="margin-bottom:2px;color:#c7d2fe">${t}</div>`;
      return head + items.map((it) => {
        const unit = mode === 'zt' ? ' 家' : mode === 'chg' ? '%' : '';
        return `<div><i style="background:${it.color}"></i>${esc(it.name)}<span class="tv">${it.v == null ? '—' : it.v.toFixed(mode === 'zt' ? 0 : 2) + unit}</span></div>`;
      }).join('');
    },
  });
}

function labelOfSlot(idx) {
  let min;
  if (idx <= 120) min = 570 + idx;
  else min = 780 + (idx - 121);
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

/* ---------------------------- chart ---------------------------- */
function drawLineChart(canvas, cfg) {
  canvas._cfg = cfg;
  canvas._hover = null;
  paintChart(canvas);
  bindChartEvents(canvas);
}

function drawEmpty(canvas, msg) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(200, Math.round(rect.width)), H = Math.max(120, Math.round(rect.height));
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#9aa5b1';
  ctx.font = '13px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(msg, W / 2, H / 2);
}

function paintChart(canvas) {
  const cfg = canvas._cfg;
  if (!cfg) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(240, Math.round(rect.width));
  const H = Math.max(140, Math.round(rect.height));
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const legendH = cfg.legend ? 32 : 8;
  const pad = { l: 58, r: 16, t: legendH, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  if (iw < 30 || ih < 30) return;

  const all = [];
  for (const s of cfg.series) for (const v of s.vals) if (v != null && isFinite(v)) all.push(v);
  if (!all.length) { drawEmpty(canvas, '暂无数据'); return; }
  let mn = Math.min.apply(null, all), mx = Math.max.apply(null, all);
  if (mn === mx) { mn -= 1; mx += 1; }
  const step = stepFor((mx - mn) / 4);
  let y0 = Math.floor(mn / step) * step;
  let y1 = y0;
  while (y1 < mx) y1 += step;
  if (y1 === y0) y1 = y0 + step;

  const spanX = Math.max(1, cfg.xTo - cfg.xFrom);
  const X = (i) => pad.l + (i - cfg.xFrom) / spanX * iw;
  const Y = (v) => pad.t + ih - (v - y0) / (y1 - y0) * ih;

  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  const decimals = (y1 - y0) / step >= 4 ? 0 : 1;
  for (let v = y0; v <= y1 + 1e-9; v += step) {
    const y = Y(v);
    ctx.strokeStyle = '#eff3f8';
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillStyle = '#93a0b4';
    const label = cfg.yFmt ? cfg.yFmt(v) : v.toFixed(Math.abs(step) < 1 ? 1 : 0);
    ctx.fillText(label, pad.l - 8, y + 4);
  }
  if (y0 < 0 && y1 > 0) {
    ctx.strokeStyle = '#dde4ee';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad.l, Y(0)); ctx.lineTo(W - pad.r, Y(0)); ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = '#93a0b4';
  for (const pair of cfg.xLabels || []) {
    const idx = pair[0], lab = pair[1];
    if (idx < cfg.xFrom || idx > cfg.xTo) continue;
    const x = X(idx);
    ctx.strokeStyle = '#f5f8fc';
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ih); ctx.stroke();
    ctx.fillText(lab, x, H - 8);
  }

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const s of cfg.series) {
    if (!s.vals) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < s.vals.length; i++) {
      const v = s.vals[i];
      if (v == null || !isFinite(v)) { pen = false; continue; }
      const x = X(cfg.xFrom + i), y = Y(v);
      if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  canvas._legendRects = [];
  if (cfg.legend) {
    let x = pad.l, y = 15;
    ctx.textAlign = 'left';
    ctx.font = '12px -apple-system, sans-serif';
    for (const s of cfg.series) {
      const w = ctx.measureText(s.name).width + 24;
      if (x + w > W - pad.r) { x = pad.l; y += 21; }
      roundedRect(ctx, x, y - 8, 10, 10, 2, s.color);
      ctx.fillStyle = '#4b5563';
      ctx.fillText(s.name, x + 15, y);
      canvas._legendRects.push({ x: x - 4, y: y - 14, w, h: 20, name: s.name });
      x += w + 4;
    }
  }

  if (canvas._hover != null) {
    const idx = canvas._hover;
    const x = X(idx);
    ctx.strokeStyle = '#c7d2e0';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ih); ctx.stroke();
    ctx.setLineDash([]);
    for (const s of cfg.series) {
      const v = s.vals[idx - cfg.xFrom];
      if (v == null || !isFinite(v)) continue;
      ctx.beginPath();
      ctx.arc(x, Y(v), 3, 0, Math.PI * 2);
      ctx.fillStyle = s.color; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.stroke();
    }
  }
}

function bindChartEvents(canvas) {
  if (canvas._bound) return;
  canvas._bound = true;

  canvas.addEventListener('mousemove', (ev) => {
    const cfg = canvas._cfg;
    if (!cfg) return;
    const r = canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const legendH = cfg.legend ? 32 : 8;
    const padL = 58, padR = 16, padT = legendH, padB = 24;
    const iw = r.width - padL - padR;
    if (mx < padL || mx > r.width - padR || my < padT || my > r.height - padB) {
      if (canvas._hover != null) { canvas._hover = null; paintChart(canvas); }
      if (canvas._tipEl) canvas._tipEl.classList.remove('on');
      return;
    }
    const ratio = (mx - padL) / iw;
    const idx = Math.round(cfg.xFrom + ratio * (cfg.xTo - cfg.xFrom));
    if (idx !== canvas._hover) {
      canvas._hover = idx;
      paintChart(canvas);
    }
    const tip = canvas._tipEl;
    if (tip && cfg.tipFmt) {
      const items = cfg.series.map((s) => ({ name: s.name, color: s.color, v: s.vals[idx - cfg.xFrom] }))
        .filter((it) => it.v != null && isFinite(it.v));
      tip.innerHTML = cfg.tipFmt(items, idx);
      const host = tip.parentElement.getBoundingClientRect();
      tip.style.left = (mx + 0) + 'px';
      tip.style.top = (my + 0) + 'px';
      tip.classList.add('on');
      void host;
    }
  });

  canvas.addEventListener('mouseleave', () => {
    if (canvas._hover != null) { canvas._hover = null; paintChart(canvas); }
    if (canvas._tipEl) canvas._tipEl.classList.remove('on');
  });

  canvas.addEventListener('click', (ev) => {
    const rects = canvas._legendRects || [];
    const r = canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    for (const rc of rects) {
      if (mx >= rc.x && mx <= rc.x + rc.w && my >= rc.y && my <= rc.y + rc.h) {
        if (S.boardSel.has(rc.name)) {
          if (S.boardSel.size > 1) S.boardSel.delete(rc.name);
        } else {
          S.boardSel.add(rc.name);
        }
        renderSector();
        break;
      }
    }
  });
}

function roundedRect(ctx, x, y, w, h, r, fill) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function stepFor(span) {
  const raw = Math.max(1e-9, span);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return step * mag;
}

/* ---------------------------- list table ---------------------------- */
const TABLE_COLS = {
  zt: [
    { t: '#', w: 40, v: (s, i) => i + 1 },
    { t: '代码', v: (s) => `<span class="code">${s.code}</span>` },
    { t: '名称', v: (s) => `<span class="name" data-code="${s.code}">${esc(s.name)}</span>` },
    { t: '最新价', v: (s) => s.price != null ? s.price.toFixed(2) : '—' },
    { t: '涨跌幅', cls: 'chg', v: (s) => fmtPct(s.chg) },
    { t: '连板', v: (s) => `<span class="tag">${lvOf(s.code) === 1 ? '首板' : lvOf(s.code) + '板'}</span>` },
    { t: '涨停统计', v: (s) => `<span class="tag g">${esc(s.daysText || '—')}</span>` },
    { t: '板块概念', cls: 'tags-cell', v: (s) => tagsHtml(s.code) },
  ],
  zb: [
    { t: '#', v: (s, i) => i + 1 },
    { t: '代码', v: (s) => `<span class="code">${s.code}</span>` },
    { t: '名称', v: (s) => `<span class="name" data-code="${s.code}">${esc(s.name)}</span>` },
    { t: '最新价', v: (s) => s.price != null ? s.price.toFixed(2) : '—' },
    { t: '涨跌幅', cls: 'chg', v: (s) => fmtPct(chgOf(s.code, s.chg)) },
    { t: '行业', v: (s) => `<span class="tag g">${esc(s.industry || '—')}</span>` },
    { t: '首封', v: (s) => fmtEmTime(s.first) },
    { t: '最后封板', v: (s) => fmtEmTime(s.last) },
    { t: '炸板次数', v: (s) => s.openNum || 0 },
    { t: '换手', v: (s) => pctOf(q(s.code)?.turnover ?? s.turnover) },
    { t: '成交额', v: (s) => fmtAmt(q(s.code)?.amt ?? s.amount) },
  ],
  dt: [
    { t: '#', v: (s, i) => i + 1 },
    { t: '代码', v: (s) => `<span class="code">${s.code}</span>` },
    { t: '名称', v: (s) => `<span class="name" data-code="${s.code}">${esc(s.name)}</span>` },
    { t: '最新价', v: (s) => s.price != null ? s.price.toFixed(2) : '—' },
    { t: '涨跌幅', cls: 'chg', v: (s) => fmtPct(chgOf(s.code, s.chg)) },
    { t: '连续跌停', v: (s) => s.days ? s.days + ' 天' : '—' },
    { t: '行业', v: (s) => `<span class="tag g">${esc(s.industry || '—')}</span>` },
    { t: '最后封板', v: (s) => fmtEmTime(s.last) },
    { t: '封单额', v: (s) => fmtAmt(s.orderAmt) },
    { t: '换手', v: (s) => pctOf(q(s.code)?.turnover ?? s.turnover) },
    { t: '成交额', v: (s) => fmtAmt(q(s.code)?.amt ?? s.amount) },
  ],
};

function tagsHtml(code, n = 2) {
  const tags = blockTags(code, n);
  if (!tags.length) return '—';
  return `<span class="tags">${tags.map((t) => `<span class="tag b">${esc(t)}</span>`).join('')}</span>`;
}

function currentRows() {
  const tab = S.tab;
  let rows = S.day[tab] || [];
  if (tab === 'zt') {
    if (S.level) {
      const lv = +S.level;
      rows = rows.filter((s) => (lv >= 6 ? lvOf(s.code) >= 6 : lvOf(s.code) === lv));
    }
  }
  const kw = S.search.trim().toLowerCase();
  if (kw) {
    rows = rows.filter((s) => s.code.includes(kw) || (s.name || '').toLowerCase().includes(kw) ||
      (blockTags(s.code, 3).join('') + (s.industry || '')).toLowerCase().includes(kw));
  }
  return rows;
}

function renderList() {
  if (!S.day) return;
  $('#cntZt').textContent = S.day.zt.length;
  $('#cntZb').textContent = S.day.zb.length;
  $('#cntDt').textContent = S.day.dt.length;
  const cols = TABLE_COLS[S.tab];
  const rows = currentRows();
  const thead = $('#thead');
  thead.innerHTML = `<tr>${cols.map((c) => `<th>${c.t}</th>`).join('')}</tr>`;
  const tbody = $('#tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${cols.length}"><div class="empty">暂无数据</div></td></tr>`;
    $('#tableFoot').textContent = '';
    return;
  }
  tbody.innerHTML = rows.map((s, i) => {
    const tds = cols.map((c) => {
      const val = c.v(s, i);
      if (c.cls === 'chg') {
        const v = chgOf(s.code, s.chg);
        const cls = v == null ? '' : v > 0 ? 'num-up' : v < 0 ? 'num-down' : '';
        return `<td class="${cls}">${val}</td>`;
      }
      return `<td class="${c.cls || ''}">${val}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  $('#tableFoot').textContent = `共 ${rows.length} 条${rows.length !== (S.day[S.tab] || []).length ? '（已筛选）' : ''}`;
}

/* ---------------------------- stock chart ---------------------------- */
const PERIODS = [
  { key: 'intra', label: '分时' },
  { key: '15', label: '15分' },
  { key: '30', label: '30分' },
  { key: 'day', label: '日K' },
  { key: 'week', label: '周K' },
  { key: 'month', label: '月K' },
];
const KLT = { 15: 15, 30: 30, day: 101, week: 102, month: 103 };
const KLMT = { 15: 240, 30: 240, day: 160, week: 140, month: 72 };

function maOf(vals, n) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= n) sum -= vals[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function emaOf(vals, n) {
  const k = 2 / (n + 1);
  const out = [];
  let prev = null;
  for (const v of vals) {
    if (v == null || !isFinite(v)) { out.push(prev); continue; }
    prev = prev == null ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsiOf(vals, n) {
  const out = new Array(vals.length).fill(null);
  let up = 0, dn = 0;
  for (let i = 1; i < vals.length; i++) {
    const ch = vals[i] - vals[i - 1];
    const u = Math.max(ch, 0), d = Math.max(-ch, 0);
    if (i <= n) {
      up += u; dn += d;
      if (i === n) out[i] = up + dn === 0 ? 50 : up / (up + dn) * 100;
    } else {
      up = (up * (n - 1) + u) / n;
      dn = (dn * (n - 1) + d) / n;
      out[i] = up + dn === 0 ? 50 : up / (up + dn) * 100;
    }
  }
  return out;
}

function calcInd(bars) {
  const c = bars.map((b) => b.c);
  const e12 = emaOf(c, 12), e26 = emaOf(c, 26);
  const dif = c.map((_, i) => (e12[i] == null || e26[i] == null ? null : e12[i] - e26[i]));
  const dea = emaOf(dif, 9);
  const macd = dif.map((v, i) => (v == null || dea[i] == null ? null : (v - dea[i]) * 2));
  const K = [], D = [], J = [];
  let k = 50, d = 50;
  for (let i = 0; i < bars.length; i++) {
    const s = Math.max(0, i - 8);
    let hh = -Infinity, ll = Infinity;
    for (let j = s; j <= i; j++) { hh = Math.max(hh, bars[j].h); ll = Math.min(ll, bars[j].l); }
    const rsv = hh === ll ? 50 : (bars[i].c - ll) / (hh - ll) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    K.push(k); D.push(d); J.push(3 * k - 2 * d);
  }
  return {
    ma5: maOf(c, 5), ma10: maOf(c, 10), ma20: maOf(c, 20),
    dif, dea, macd, K, D, J,
    rsi6: rsiOf(c, 6), rsi12: rsiOf(c, 12), rsi24: rsiOf(c, 24),
  };
}

function fmtBarT(t, period) {
  const s = String(t);
  if (/^\d{12}$/.test(s)) return `${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
  if (s.length >= 16) return s.slice(5, 16);
  if (s.length >= 10) return s.slice(5, 10);
  return s;
}

function fmtVol(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(Math.round(v));
}

async function klineEm(code, period) {
  const secid = (isSh(code) ? '1.' : '0.') + code;
  const klt = KLT[period] || 101, lmt = KLMT[period] || 160;
  const url = `${API.EM_KLINE}?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=${klt}&fqt=1&end=20500101&lmt=${lmt}`;
  const j = await fetchJSON(url, 9000, 1);
  const k = j && j.data && j.data.klines;
  if (!k || !k.length) return null;
  return k.map((r) => {
    const c = r.split(',');
    return { t: c[0], o: +c[1], c: +c[2], h: +c[3], l: +c[4], v: +c[5] || 0 };
  });
}

async function klineTx(code, period) {
  const key = (isSh(code) ? 'sh' : 'sz') + code;
  if (period === '15' || period === '30') {
    const url = `${API.TX_MKLINE}?param=${key},m${period},,300`;
    const j = await fetchJSON(url, 9000, 1);
    const arr = j && j.data && j.data[key] && j.data[key][`m${period}`];
    if (!arr || !arr.length) return null;
    return arr.map((r) => ({ t: String(r[0]), o: +r[1], c: +r[2], h: +r[3], l: +r[4], v: +r[5] || 0 }));
  }
  const tp = period === 'week' ? 'week' : period === 'month' ? 'month' : 'day';
  const url = `${API.TX_KLINE}?param=${key},${tp},,,${KLMT[period] || 160},qfq`;
  const j = await fetchJSON(url, 9000, 1);
  const arr = j && j.data && j.data[key] && (j.data[key]['qfq' + tp] || j.data[key][tp]);
  if (!arr || !arr.length) return null;
  return arr.map((r) => ({ t: String(r[0]), o: +r[1], c: +r[2], h: +r[3], l: +r[4], v: +r[5] || 0 }));
}

async function fetchBars(code, period) {
  let bars = null;
  try { bars = await klineEm(code, period); } catch (e) { bars = null; }
  if (!bars || !bars.length) {
    try { bars = await klineTx(code, period); } catch (e) { bars = null; }
  }
  return bars;
}

function intraBars(m, fake) {
  if (!m || !m.bars) return null;
  return m.bars.map((b) => ({ ...b, fake, t: b.t || labelOfSlot(b.slot) }));
}

/** 分时兜底：腾讯 1 分钟线，只取最后交易日 */
async function intraFromTx(code) {
  const all = await klineTx(code, '1');
  if (!all || !all.length) return null;
  const last = all[all.length - 1];
  const day = String(last.t).slice(0, 8);
  const seg = all.filter((b) => String(b.t).slice(0, 8) === day);
  if (seg.length < 2) return null;
  const bars = [];
  for (const b of seg) {
    const s = String(b.t);
    const hh = +s.slice(8, 10), mm = +s.slice(10, 12);
    if (!(hh >= 9 && hh <= 15)) continue;
    bars.push({ ...b, slot: slotOf(hh * 60 + mm), t: `${s.slice(8, 10)}:${s.slice(10, 12)}` });
  }
  if (bars.length < 2) return null;
  return { pre: bars[0].o, bars, fake: false, src: 'tx' };
}

async function openStock(code, name) {
  $('#modalTitle').innerHTML = `${esc(name || code)}<span class="sub">${code}</span>`;
  $('#modal').classList.add('on');
  S.stock = { code, name: name || code, period: 'intra', bars: null, ind: null, pre: null, hover: null, loading: true };
  renderPeriodTabs();
  bindStockChart();
  setStockPeriod('intra');
}

function renderPeriodTabs() {
  const box = $('#periodTabs');
  if (!box) return;
  box.innerHTML = PERIODS.map((p) => `<button data-p="${p.key}" class="${S.stock && S.stock.period === p.key ? 'on' : ''}">${p.label}</button>`).join('');
  if (!box._bound) {
    box._bound = true;
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-p]');
      if (!b) return;
      setStockPeriod(b.dataset.p);
    });
  }
}

async function setStockPeriod(period) {
  const st = S.stock;
  if (!st) return;
  st.period = period;
  st.hover = null;
  st.loading = true;
  st.bars = null; st.ind = null;
  renderPeriodTabs();
  setChartInfo(null);
  drawStockChart();
  const code = st.code;

  if (period === 'intra') {
    if (!S.minute.has(code)) {
      const row = (S.day.zt || []).find((s) => s.code === code);
      if (row && row.tp) {
        S.minute.set(code, {
          pre: 100,
          fake: true,
          bars: row.tp.map((v, i) => ({ slot: tpSlot(i), t: labelOfSlot(tpSlot(i)), o: 100 + v, c: 100 + v, h: 100 + v, l: 100 + v, v: 0, avg: null })),
        });
      }
    }
    const m = S.minute.get(code);
    applyBars(m ? intraBars(m) : null, m ? m.pre : null, m ? !!m.fake : false);
    let mm = null;
    try { mm = await fetchMinute(code); } catch (e) { mm = null; }
    if (!mm || !mm.bars || mm.bars.length < 2) {
      try { mm = await intraFromTx(code); } catch (e) { mm = null; }
    }
    if (mm && mm.bars && mm.bars.length > 1 && S.stock && S.stock.code === code && S.stock.period === 'intra') {
      S.minute.set(code, mm);
      applyBars(intraBars(mm), mm.pre, false);
    }
    return;
  }

  const bars = await fetchBars(code, period);
  if (!S.stock || S.stock.code !== code || S.stock.period !== period) return;
  applyBars(bars, null);
}

function applyBars(bars, pre, fake) {
  const st = S.stock;
  if (!st) return;
  st.bars = bars && bars.length ? bars : null;
  st.fake = !!(fake && st.bars);
  st.pre = pre || (st.bars && st.bars.length ? st.bars[0].o : null);
  st.ind = st.bars ? calcInd(st.bars) : null;
  st.loading = false;
  st.hover = null;
  drawStockChart();
  setChartInfo(st.bars ? st.bars.length - 1 : null);
}

/* ---------------------------- chart paint ---------------------------- */
const C_UP = '#ef4444', C_DN = '#16a34a', C_TXT = '#93a0b4', C_GRID = '#f0f4f9', C_MA5 = '#f59e0b', C_MA10 = '#8b5cf6', C_MA20 = '#0ea5e9';

function drawStockChart() {
  const canvas = $('#stockChart');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(320, Math.round(rect.width));
  const H = Math.max(300, Math.round(rect.height));
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const st = S.stock;
  if (!st) return;
  if (!st.bars || !st.bars.length) {
    ctx.fillStyle = C_TXT; ctx.font = '13px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(st.loading ? '加载中…' : '暂无数据', W / 2, H / 2);
    return;
  }

  const bars = st.bars, ind = st.ind, n = bars.length;
  const isIntra = st.period === 'intra';
  const padL = 8, padR = 60, padB = 20, topT = 6;
  const iw = W - padL - padR;
  const gap = 12;
  const subH = Math.max(42, Math.min(64, Math.round((H - 150) / 4.6)));
  const priceH = H - padB - topT - (subH * 4) - gap * 4;
  const volH = subH, macdH = subH, kdjH = subH, rsiH = subH;

  const paneTop = [];
  let y = topT;
  paneTop.push(y); y += priceH + gap;
  paneTop.push(y); y += volH + gap;
  paneTop.push(y); y += macdH + gap;
  paneTop.push(y); y += kdjH + gap;
  paneTop.push(y);

  const stepX = iw / Math.max(1, n);
  const bw = Math.max(1, Math.min(14, stepX * 0.72));
  const X = (i) => (isIntra ? padL + (bars[i].slot / 241) * iw : padL + (i + 0.5) * stepX);

  ctx.font = '10.5px "Microsoft YaHei", sans-serif';

  /* ---- price pane ---- */
  const pTop = paneTop[0];
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); }
  if (!isFinite(lo) || !isFinite(hi)) return;
  let pvmin, pvmax, toY;
  if (isIntra) {
    const pre = st.pre || bars[0].o || bars[0].c;
    const dev = Math.max(
      Math.max.apply(null, bars.map((b) => Math.abs((b.h - pre) / pre * 100))),
      Math.max.apply(null, bars.map((b) => Math.abs((b.l - pre) / pre * 100))),
      0.6,
    );
    pvmin = -dev * 1.08; pvmax = dev * 1.08;
    toY = (b) => pTop + priceH / 2 - ((b.c - pre) / pre * 100) / pvmax * (priceH / 2);
    // grid: percent labels
    ctx.textAlign = 'left';
    for (let g = 0; g <= 2; g++) {
      const v = pvmax * (g / 2);
      for (const s of [v, -v]) {
        const yy = pTop + priceH / 2 - s / pvmax * (priceH / 2);
        ctx.strokeStyle = s === 0 ? '#e2e8f2' : C_GRID;
        ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + iw, yy); ctx.stroke();
        ctx.fillStyle = s === 0 ? '#8d99ab' : s > 0 ? C_UP : C_DN;
        ctx.fillText(s.toFixed(2) + '%', padL + iw + 6, yy + 3.5);
      }
    }
    ctx.fillStyle = '#8d99ab';
    ctx.textAlign = 'right';
    ctx.fillText(fmtPrice(pre), padL + iw - 2, pTop + priceH / 2 - 4);
  } else {
    pvmin = lo; pvmax = hi;
    const padV = (hi - lo) * 0.04 || 1;
    pvmin -= padV; pvmax += padV;
    toY = (b) => pTop + priceH - (b.c - pvmin) / (pvmax - pvmin) * priceH;
    ctx.textAlign = 'left';
    for (let g = 0; g <= 4; g++) {
      const v = pvmin + (pvmax - pvmin) * (g / 4);
      const yy = pTop + priceH - (g / 4) * priceH;
      ctx.strokeStyle = C_GRID;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + iw, yy); ctx.stroke();
      ctx.fillStyle = C_TXT;
      ctx.fillText(fmtPrice(v), padL + iw + 6, yy + 3.5);
    }
  }

  if (isIntra) {
    // price line + fill
    const path = new Path2D();
    let started = false;
    for (let i = 0; i < n; i++) {
      const x = X(i), yy = toY(bars[i]);
      if (!started) { path.moveTo(x, yy); started = true; } else path.lineTo(x, yy);
    }
    const last = bars[n - 1].c, first = st.pre || bars[0].o;
    const lineColor = last >= first ? C_UP : C_DN;
    const grad = ctx.createLinearGradient(0, pTop, 0, pTop + priceH);
    grad.addColorStop(0, lineColor + '33');
    grad.addColorStop(1, lineColor + '05');
    const area = new Path2D(path);
    area.lineTo(X(n - 1), pTop + priceH);
    area.lineTo(X(0), pTop + priceH);
    area.closePath();
    ctx.fillStyle = grad; ctx.fill(area);
    ctx.strokeStyle = lineColor; ctx.lineWidth = 1.4; ctx.stroke(path);
    // avg line
    const avg = bars.map((b) => b.avg).filter((v) => v != null);
    if (avg.length === bars.length) {
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) {
        const v = bars[i].avg;
        if (v == null) { pen = false; continue; }
        const x = X(i), yy = pTop + priceH / 2 - ((v - st.pre) / st.pre * 100) / pvmax * (priceH / 2);
        if (!pen) { ctx.moveTo(x, yy); pen = true; } else ctx.lineTo(x, yy);
      }
      ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1.1; ctx.stroke();
    }
  } else {
    // candles
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const x = X(i);
      const up = b.c >= b.o;
      const col = up ? C_UP : C_DN;
      const yO = pTop + priceH - (b.o - pvmin) / (pvmax - pvmin) * priceH;
      const yC = pTop + priceH - (b.c - pvmin) / (pvmax - pvmin) * priceH;
      const yH = pTop + priceH - (b.h - pvmin) / (pvmax - pvmin) * priceH;
      const yL = pTop + priceH - (b.l - pvmin) / (pvmax - pvmin) * priceH;
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
      const top = Math.min(yO, yC), hgt = Math.max(1, Math.abs(yC - yO));
      if (up) {
        ctx.fillStyle = '#fff'; ctx.fillRect(x - bw / 2, top, bw, hgt);
        ctx.strokeRect(x - bw / 2, top, bw, hgt);
      } else {
        ctx.fillStyle = col; ctx.fillRect(x - bw / 2, top, bw, hgt);
      }
    }
    // MA lines
    const mas = [[ind.ma5, C_MA5, 'MA5'], [ind.ma10, C_MA10, 'MA10'], [ind.ma20, C_MA20, 'MA20']];
    for (const [arr, col] of mas) {
      ctx.strokeStyle = col; ctx.lineWidth = 1.1; ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (v == null) { pen = false; continue; }
        const x = X(i), yy = pTop + priceH - (v - pvmin) / (pvmax - pvmin) * priceH;
        if (!pen) { ctx.moveTo(x, yy); pen = true; } else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    ctx.textAlign = 'left'; ctx.font = '10px "Microsoft YaHei", sans-serif';
    let lx = padL + 2;
    for (const [arr, col, name] of mas) {
      const v = arr[n - 1];
      ctx.fillStyle = col;
      ctx.fillText(`${name} ${v == null ? '—' : fmtPrice(v)}`, lx, pTop + 10);
      lx += 74;
    }
    ctx.font = '10.5px "Microsoft YaHei", sans-serif';
  }

  /* ---- volume ---- */
  const vTop = paneTop[1];
  const maxV = Math.max.apply(null, bars.map((b) => b.v || 0)) || 1;
  ctx.fillStyle = C_TXT; ctx.textAlign = 'left';
  ctx.fillText('VOL ' + fmtVol(bars[n - 1].v), padL + 2, vTop + 9);
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const hgt = Math.max(0.5, (b.v || 0) / maxV * (volH - 12));
    const base = isIntra ? (i > 0 ? bars[i - 1].c : (st.pre || b.o)) : b.o;
    ctx.fillStyle = b.c >= base ? C_UP : C_DN;
    ctx.globalAlpha = 0.75;
    ctx.fillRect(X(i) - bw / 2, vTop + volH - hgt, bw, hgt);
    ctx.globalAlpha = 1;
  }

  /* ---- MACD ---- */
  const mTop = paneTop[2];
  let mmax = 0;
  for (let i = 0; i < n; i++) {
    mmax = Math.max(mmax, Math.abs(ind.macd[i] || 0), Math.abs(ind.dif[i] || 0), Math.abs(ind.dea[i] || 0));
  }
  if (!mmax) mmax = 1;
  const midY = mTop + macdH / 2;
  ctx.strokeStyle = '#e8eef6';
  ctx.beginPath(); ctx.moveTo(padL, midY); ctx.lineTo(padL + iw, midY); ctx.stroke();
  for (let i = 0; i < n; i++) {
    const v = ind.macd[i] || 0;
    const hgt = Math.max(0.5, Math.abs(v) / mmax * (macdH / 2 - 3));
    ctx.fillStyle = v >= 0 ? C_UP : C_DN;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(X(i) - bw / 2, v >= 0 ? midY - hgt : midY, bw, hgt);
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1; ctx.beginPath();
  let pen1 = false;
  for (let i = 0; i < n; i++) {
    const v = ind.dif[i];
    if (v == null) { pen1 = false; continue; }
    const x = X(i), yy = midY - v / mmax * (macdH / 2 - 3);
    if (!pen1) { ctx.moveTo(x, yy); pen1 = true; } else ctx.lineTo(x, yy);
  }
  ctx.stroke();
  ctx.strokeStyle = '#f59e0b'; ctx.beginPath();
  pen1 = false;
  for (let i = 0; i < n; i++) {
    const v = ind.dea[i];
    if (v == null) { pen1 = false; continue; }
    const x = X(i), yy = midY - v / mmax * (macdH / 2 - 3);
    if (!pen1) { ctx.moveTo(x, yy); pen1 = true; } else ctx.lineTo(x, yy);
  }
  ctx.stroke();
  ctx.fillStyle = C_TXT; ctx.textAlign = 'left';
  ctx.fillText('MACD(12,26,9)', padL + 2, mTop + 9);

  /* ---- KDJ ---- */
  const kTop = paneTop[3];
  const KY = (v) => kTop + kdjH - (Math.max(-30, Math.min(130, v)) + 30) / 160 * kdjH;
  for (const lv of [20, 80]) {
    ctx.strokeStyle = '#eef2f8';
    ctx.beginPath(); ctx.moveTo(padL, KY(lv)); ctx.lineTo(padL + iw, KY(lv)); ctx.stroke();
  }
  const kseries = [[ind.K, '#2563eb', 'K'], [ind.D, '#f59e0b', 'D'], [ind.J, '#a855f7', 'J']];
  for (const [arr, col] of kseries) {
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      if (v == null) { pen = false; continue; }
      const x = X(i), yy = KY(v);
      if (!pen) { ctx.moveTo(x, yy); pen = true; } else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  ctx.fillStyle = C_TXT; ctx.textAlign = 'left';
  ctx.fillText('KDJ(9,3,3)', padL + 2, kTop + 9);
  ctx.textAlign = 'right'; ctx.fillStyle = '#b9c2d0';
  ctx.fillText('80', padL + iw + 56, KY(80) + 3);
  ctx.fillText('20', padL + iw + 56, KY(20) + 3);

  /* ---- RSI ---- */
  const rTop = paneTop[4];
  const RY = (v) => rTop + rsiH - v / 100 * rsiH;
  for (const lv of [30, 70]) {
    ctx.strokeStyle = '#eef2f8';
    ctx.beginPath(); ctx.moveTo(padL, RY(lv)); ctx.lineTo(padL + iw, RY(lv)); ctx.stroke();
  }
  const rseries = [[ind.rsi6, '#2563eb', 'RSI6'], [ind.rsi12, '#f59e0b', 'RSI12'], [ind.rsi24, '#a855f7', 'RSI24']];
  for (const [arr, col] of rseries) {
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      if (v == null) { pen = false; continue; }
      const x = X(i), yy = RY(v);
      if (!pen) { ctx.moveTo(x, yy); pen = true; } else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  ctx.fillStyle = C_TXT; ctx.textAlign = 'left';
  ctx.fillText('RSI(6,12,24)', padL + 2, rTop + 9);

  /* ---- x labels ---- */
  ctx.textAlign = 'center'; ctx.fillStyle = C_TXT;
  if (isIntra) {
    const xs = [[0, '09:30'], [60, '10:30'], [120, '11:30/13:00'], [181, '14:00'], [241, '15:00']];
    for (const [slot, lab] of xs) {
      const x = padL + (slot / 241) * iw;
      ctx.fillText(lab, x, H - 6);
    }
  } else {
    const picks = Math.min(5, n);
    for (let g = 0; g < picks; g++) {
      const i = Math.round((n - 1) * (g / Math.max(1, picks - 1)));
      ctx.fillText(fmtBarT(bars[i].t, st.period), X(i), H - 6);
    }
  }

  /* ---- crosshair ---- */
  if (st.hover != null && st.hover >= 0 && st.hover < n) {
    const hx = X(st.hover);
    ctx.strokeStyle = '#b6c2d4'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(hx, pTop); ctx.lineTo(hx, rTop + rsiH); ctx.stroke();
    const b = bars[st.hover];
    if (!isIntra) {
      const hy = pTop + priceH - (b.c - pvmin) / (pvmax - pvmin) * priceH;
      ctx.beginPath(); ctx.moveTo(padL, hy); ctx.lineTo(padL + iw, hy); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

function setChartInfo(idx) {
  const el = $('#chartInfo');
  const st = S.stock;
  if (!el || !st) return;
  if (!st.bars || !st.bars.length) { el.innerHTML = st.loading ? '<span class="muted">加载中…</span>' : '<span class="muted">暂无数据</span>'; return; }
  const i = idx == null ? st.bars.length - 1 : Math.max(0, Math.min(st.bars.length - 1, idx));
  const b = st.bars[i];
  const ind = st.ind;
  const base = st.period === 'intra' ? st.pre : (i > 0 ? st.bars[i - 1].c : (st.pre || b.o));
  const chg = base ? (b.c - base) / base * 100 : 0;
  const fake = st.period === 'intra' && st.fake;
  const cls = chg >= 0 ? 'up' : 'down';
  const pct = (v) => (v == null ? '—' : v.toFixed(2));
  const parts = [];
  if (b.t) parts.push(`<span><b>${esc(fmtBarT(b.t, st.period))}</b></span>`);
  if (fake) {
    parts.push(`<span class="${cls}"><b>${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</b></span>`);
    parts.push('<span class="muted">分时采样</span>');
  } else {
    parts.push(`<span>开 <b>${fmtPrice(b.o)}</b></span>`);
    parts.push(`<span>高 <b>${fmtPrice(b.h)}</b></span>`);
    parts.push(`<span>低 <b>${fmtPrice(b.l)}</b></span>`);
    parts.push(`<span>收 <b class="${cls}">${fmtPrice(b.c)}</b></span>`);
    parts.push(`<span class="${cls}"><b>${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</b></span>`);
    parts.push(`<span>量 <b>${fmtVol(b.v)}</b></span>`);
  }
  if (ind) {
    parts.push(`<span class="k">MACD <b>${pct(ind.dif[i])}</b>/<b>${pct(ind.dea[i])}</b>/<b>${pct(ind.macd[i])}</b></span>`);
    parts.push(`<span class="k">KDJ <b>${pct(ind.K[i])}</b>/<b>${pct(ind.D[i])}</b>/<b>${pct(ind.J[i])}</b></span>`);
    parts.push(`<span class="k">RSI <b>${pct(ind.rsi6[i])}</b>/<b>${pct(ind.rsi12[i])}</b>/<b>${pct(ind.rsi24[i])}</b></span>`);
  }
  el.innerHTML = parts.join('');
}

function fmtPrice(v) {
  if (v == null || !isFinite(v)) return '—';
  return v >= 100 ? v.toFixed(2) : v.toFixed(v < 10 ? 2 : 2);
}

function bindStockChart() {
  const canvas = $('#stockChart');
  if (!canvas || canvas._bound) return;
  canvas._bound = true;
  const pick = (ev) => {
    const st = S.stock;
    if (!st || !st.bars || !st.bars.length) return null;
    const r = canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    const padL = 8, padR = 60;
    const iw = r.width - padL - padR;
    if (mx < padL || mx > padL + iw) return null;
    const n = st.bars.length;
    if (st.period === 'intra') {
      const slot = (mx - padL) / iw * 241;
      let best = null, bd = 1e9;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(st.bars[i].slot - slot);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }
    return Math.max(0, Math.min(n - 1, Math.floor((mx - padL) / (iw / n))));
  };
  canvas.addEventListener('mousemove', (ev) => {
    const st = S.stock;
    if (!st) return;
    const idx = pick(ev);
    if (idx == null) { if (st.hover != null) { st.hover = null; drawStockChart(); setChartInfo(null); } return; }
    if (idx !== st.hover) { st.hover = idx; drawStockChart(); setChartInfo(idx); }
  });
  canvas.addEventListener('mouseleave', () => {
    if (!S.stock) return;
    S.stock.hover = null;
    drawStockChart();
    setChartInfo(null);
  });
}

let _resizeTimer = null;
window.addEventListener('resize', () => {
  if (!$('#modal') || !$('#modal').classList.contains('on')) return;
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => drawStockChart(), 120);
});

/* ---------------------------- export ---------------------------- */
function exportCSV() {
  const cols = TABLE_COLS[S.tab];
  const rows = currentRows();
  const head = cols.map((c) => c.t).join(',');
  const lines = rows.map((s, i) => cols.map((c) => {
    let v = c.v(s, i);
    v = String(v).replace(/<[^>]+>/g, '').replace(/,/g, ' ');
    return v;
  }).join(','));
  const csv = '\ufeff' + [head, ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${S.date}-${S.tab}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------------------- events ---------------------------- */
function bindEvents() {
  $('#viewTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    S.view = btn.dataset.view;
    $$('#viewTabs button').forEach((b) => b.classList.toggle('on', b === btn));
    ['relay', 'sector', 'list'].forEach((v) => $('#view' + v[0].toUpperCase() + v.slice(1)).classList.toggle('hidden', v !== S.view));
    if (S.view === 'sector' && !S.boardCurves) renderSector();
  });

  $('#ruleTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-rule]');
    if (!btn) return;
    S.rule = btn.dataset.rule;
    $$('#ruleTabs button').forEach((b) => b.classList.toggle('on', b === btn));
    renderLadder();
  });

  $('#chips').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    S.chip = btn.dataset.chip || null;
    renderChips();
    renderLadder();
  });

  $('#ladder').addEventListener('click', (e) => {
    const el = e.target.closest('.stk');
    if (el) openStock(el.dataset.code, el.querySelector('.nm').textContent);
  });

  $('#sectorMode').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-m]');
    if (!btn) return;
    S.boardMode = btn.dataset.m;
    $$('#sectorMode button').forEach((b) => b.classList.toggle('on', b === btn));
    updateSectorHint();
    drawSectorChart();
  });

  $('#sectorList').addEventListener('click', (e) => {
    const row = e.target.closest('.srow');
    if (!row) return;
    const name = row.dataset.board;
    if (S.boardSel.has(name)) S.boardSel.delete(name); else S.boardSel.add(name);
    if (S.boardSel.size > 8) {
      const first = Array.from(S.boardSel)[0];
      S.boardSel.delete(first);
      toast('最多同时对比 8 个板块');
    }
    renderSector();
  });

  $('#tabTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    S.tab = btn.dataset.tab;
    $$('#tabTabs button').forEach((b) => b.classList.toggle('on', b === btn));
    renderList();
  });

  let searchTimer = null;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => { S.search = v; renderList(); }, 180);
  });
  $('#levelFilter').addEventListener('change', (e) => { S.level = e.target.value; renderList(); });
  $('#exportBtn').addEventListener('click', exportCSV);
  $('#tbody').addEventListener('click', (e) => {
    const el = e.target.closest('.name');
    if (el) openStock(el.dataset.code, el.textContent);
  });

  $('#prevDay').addEventListener('click', () => loadDay(shiftDay(S.date, -1)));
  $('#nextDay').addEventListener('click', () => {
    const n = shiftDay(S.date, 1);
    if (n > ds(new Date())) { toast('已经是最新交易日'); return; }
    loadDay(n);
  });
  $('#todayBtn').addEventListener('click', () => loadDay(ds(new Date())));
  $('#refreshBtn').addEventListener('click', () => loadDay(S.date));
  $('#dateInput').addEventListener('change', (e) => {
    const v = e.target.value;
    if (!v) return;
    loadDay(v.replace(/-/g, ''));
  });

  $('#modalClose').addEventListener('click', () => $('#modal').classList.remove('on'));
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.remove('on'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').classList.remove('on'); });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (S.view === 'sector' && S.boardCurves) drawSectorChart();
    }, 180);
  });
}

/* 交易时段自动刷新 */
function isTradingTime() {
  const now = new Date();
  const d = now.getDay();
  if (d === 0 || d === 6) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return (m >= 555 && m <= 690) || (m >= 780 && m <= 905);
}
function startAuto() {
  clearInterval(S.autoTimer);
  S.autoTimer = setInterval(() => {
    if (document.hidden) return;
    if (!isTradingTime()) return;
    if (S.date !== S.latestDate) return;
    loadDay(S.date);
  }, 60000);
}

/* ---------------------------- boot ---------------------------- */
bindEvents();
const today = ds(new Date());
$('#dateInput').value = `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}`;
$('#dateInput').max = `${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}`;
loadDay(today).then(startAuto);
