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
  TX_KLINE: 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get',
  TX_KLINE2: 'https://ifzq.gtimg.cn/appstock/app/fqkline/get',
  TX_KLINE3: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
  TX_MKLINE: 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/kline/mkline',
  TX_MKLINE2: 'https://ifzq.gtimg.cn/appstock/app/kline/mkline',
  THS_BK: 'https://d.10jqka.com.cn/v6/line/',
};
const THS_FIELDS = '199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004';

const S = {
  date: null,
  latestDate: null,
  view: 'relay',
  rule: 'hot',
  chip: null,
  promoteOnly: false,  // 只看晋级成功
  focusSec: null,      // 高亮的板块/概念名
  tab: 'zt',
  search: '',
  level: '',
  day: null,          // {zt, zb, dt, prev, blocks, quotes, prevDate}
  quotes: new Map(),  // code -> {chg, price, amt, turnover, flowCap, mainIn}
  minute: new Map(),  // code -> {pre, bars, fake}
  minutePending: new Set(),
  blockMeta: new Map(), // code -> [blockName]
  reasonMap: new Map(), // code -> [涨停原因里的题材标签]
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
    S.day = { date: useDate, zt, zb, dt, prev: prevInfo.pool, prevDate: prevInfo.date, blocks };
    S._lv = null;
    S.focusSec = null;

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

    // 代码 -> 涨停原因里的题材标签（覆盖今日涨停/炸板/跌停/昨日涨停，兜底无板块归属的股票）
    const blockNames = new Set(blocks.map((b) => b.name));
    for (const arr2 of meta.values()) for (const n of arr2) blockNames.add(n);
    const canonTag = (t) => {
      if (blockNames.has(t)) return t;
      let best = null;
      for (const n of blockNames) {
        if (n.length <= t.length || n.indexOf(t) < 0) continue;
        if (!best || n.length < best.length) best = n;
      }
      return best || t;
    };
    const reasonMap = new Map();
    for (const arr2 of [zt, zb, dt, prevInfo.pool]) {
      for (const s of arr2) {
        if (!s || !s.reason || reasonMap.has(s.code)) continue;
        const raw = String(s.reason).split('+').map((t) => t.replace(/[“”"]/g, '').trim()).filter(Boolean);
        const canon = raw.map(canonTag);
        // 能对应到真实板块名的标签优先（点它能联动到同板块其它股票）
        const order = raw.map((t, i) => i).sort((a, b) => (canon[a] === raw[a] ? 1 : 0) - (canon[b] === raw[b] ? 1 : 0));
        const tags = order.map((i) => canon[i]).filter((t, i, a) => t && a.indexOf(t) === i);
        if (tags.length) reasonMap.set(s.code, tags);
      }
    }
    S.reasonMap = reasonMap;

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
    loadStrategyExtras(useDate).catch(() => {});
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
  const r = S.reasonMap.get(code);
  if (r && r.length) return r.slice(0, limit);
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
  renderStrategy();
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
    let items = buildItems(codes, srcMap);
    const succ = items.filter((i) => i.status === 'up').length;
    const total = items.length;
    if (S.promoteOnly) items = items.filter((i) => i.status === 'up');
    if (!items.length) continue;
    items.sort(RULES[S.rule] || RULES.hot);
    rows.push(rowHtml(`${lv}进${lv + 1}`, `${succ}/${total}`, total ? (succ / total) * 100 : 0, items));
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

  $('#ladder').innerHTML = rows.join('') || `<div class="empty">${S.promoteOnly ? '今日没有晋级成功的股票' : '该板块今日无涨停'}</div>`;
  $('#ladder').classList.toggle('focusing', !!S.focusSec);
  const bar = $('#focusBar');
  if (bar) {
    if (S.focusSec) {
      const n = $('#ladder').querySelectorAll('.stk.focus').length;
      bar.innerHTML = `<b>已高亮</b><i>${esc(S.focusSec)}</i><span>${n} 只</span><em>点击空白处取消</em><button class="fb-x" type="button">取消</button>`;
      bar.classList.remove('hidden');
    } else {
      bar.classList.add('hidden');
      bar.innerHTML = '';
    }
  }
}

function clearFocusSec() {
  if (!S.focusSec) return false;
  S.focusSec = null;
  renderLadder();
  return true;
}

function memberSet(name) {
  const b = S.day.blocks.find((x) => x.name === name);
  return b ? new Set(b.stocks.map((s) => s.code)) : new Set();
}

function rowHtml(key, num, pct, items) {
  const cls = pct >= 50 ? 'up' : '';
  const focus = S.focusSec || null;
  const cells = items.map((it) => {
    const tags = blockTags(it.code, 8);
    const tag = tags[0] || '';
    const chgCls = it.chg == null ? 'flat' : it.chg > 0 ? 'up' : it.chg < 0 ? 'down' : 'flat';
    const label = it.status === 'up' ? '成' : it.status === 'boom' ? '炸' : '败';
    const hit = !!focus && (tag === focus || tags.indexOf(focus) >= 0);
    const tagOn = focus ? tag === focus : !!(S.chip && tag === S.chip);
    const tagHtml = tag
      ? `<i class="sec${tagOn ? ' hl' : ''}" data-sec="${esc(tag)}" title="${esc(tag)} · 点击高亮同板块股票">${esc(tag)}</i>`
      : '<i class="sec"></i>';
    return `<span class="stk st ${it.status}${hit ? ' focus' : ''}" data-code="${it.code}" title="${esc(it.name)} ${it.level ? it.level + '板' : ''}">
      <i class="mk">${mkName(it.code)}</i>
      <em class="nm">${esc(it.name)}</em>
      <i class="st">${label}</i>
      <b class="chg ${chgCls}">${it.chg == null ? '—' : fmtPct(it.chg, false)}</b>
      ${tagHtml}
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
    // 采样为 3 分钟一个点，中间槽位是空的；不补密的话折线会断成一个个孤点（画不出来）
    let f0 = -1, f1 = -1;
    for (let i = 0; i < values.length; i++) if (values[i] != null) { if (f0 < 0) f0 = i; f1 = i; }
    if (f0 >= 0) {
      for (let i = f0 + 1; i < f1; i++) {
        if (values[i] != null) continue;
        let j = i + 1;
        while (j <= f1 && values[j] == null) j++;
        const a = values[i - 1], b = values[j], span = j - (i - 1);
        for (let k = i; k < j; k++) values[k] = a + ((b - a) * (k - (i - 1))) / span;
        i = j;
      }
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
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  const dpr = window.devicePixelRatio || 1;
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
  const rect = canvas.getBoundingClientRect();
  // 视图隐藏时尺寸为 0，此时绘制会把位图压成 240x140（切换视图后就再也画不回正常尺寸）
  if (rect.width < 10 || rect.height < 10) return;
  const dpr = window.devicePixelRatio || 1;
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
      if (v == null || !isFinite(v)) continue;
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

function ensureChartObserver(canvas) {
  if (canvas._ro || typeof ResizeObserver === 'undefined') return;
  canvas._ro = new ResizeObserver(() => {
    const r = canvas.getBoundingClientRect();
    if (!canvas._cfg || r.width < 10 || r.height < 10) return;
    paintChart(canvas);
  });
  canvas._ro.observe(canvas);
}

function bindChartEvents(canvas) {
  if (canvas._bound) return;
  canvas._bound = true;
  ensureChartObserver(canvas);

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
const KLMT = { 15: 240, 30: 240, day: 400, week: 140, month: 72 };

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
  if (s.length >= 10) return period === 'month' ? s.slice(0, 7) : s.slice(5, 10);
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
  const j = await fetchJSON(url, 6000, 0);
  const k = j && j.data && j.data.klines;
  if (!k || !k.length) return null;
  return k.map((r) => {
    const c = r.split(',');
    return { t: c[0], o: +c[1], c: +c[2], h: +c[3], l: +c[4], v: +c[5] || 0 };
  });
}

async function klineTx(code, period) {
  const key = (isSh(code) ? 'sh' : 'sz') + code;
  if (period === '1' || period === '5' || period === '15' || period === '30') {
    let arr = null;
    for (const host of [API.TX_MKLINE, API.TX_MKLINE2]) {
      try {
        const j = await fetchJSON(`${host}?param=${key},m${period},,300`, 6000, 0);
        arr = j && j.data && j.data[key] && j.data[key][`m${period}`];
        if (arr && arr.length) break;
      } catch (e) { /* next host */ }
    }
    if (!arr || !arr.length) return null;
    return arr.map((r) => ({ t: String(r[0]), o: +r[1], c: +r[2], h: +r[3], l: +r[4], v: +r[5] || 0 }));
  }
  const tp = period === 'week' ? 'week' : period === 'month' ? 'month' : 'day';
  let arr = null;
  for (const host of [API.TX_KLINE, API.TX_KLINE2, API.TX_KLINE3]) {
    try {
      const j = await fetchJSON(`${host}?param=${key},${tp},,,${KLMT[period] || 160},qfq`, 6000, 0);
      arr = j && j.data && j.data[key] && (j.data[key]['qfq' + tp] || j.data[key][tp]);
      if (arr && arr.length) break;
    } catch (e) { /* next host */ }
  }
  if (!arr || !arr.length) return null;
  return arr.map((r) => ({ t: String(r[0]), o: +r[1], c: +r[2], h: +r[3], l: +r[4], v: +r[5] || 0 }));
}

/** 新浪日K JSONP 兜底（script 标签不走 CORS；全局串行队列，防止 window._ 互相覆盖） */
let _sinaQ = Promise.resolve();
function sinaDay(code) {
  _sinaQ = _sinaQ.then(() => new Promise((res) => {
    const key = (isSh(code) ? 'sh' : 'sz') + code;
    try { window._ = undefined; } catch (e) {}
    const s = document.createElement('script');
    const to = setTimeout(() => { s.remove(); res(null); }, 12000);
    s.onload = () => {
      clearTimeout(to); s.remove();
      const a = window._;
      res(Array.isArray(a) && a.length ? a.map((d) => ({ t: d.day.replace(/-/g, ''), o: +d.open, c: +d.close, h: +d.high, l: +d.low, v: +d.volume || 0 })) : null);
    };
    s.onerror = () => { clearTimeout(to); s.remove(); res(null); };
    s.src = 'https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_=/CN_MarketDataService.getKLineData?symbol=' + key + '&scale=240&ma=no&datalen=500';
    document.head.appendChild(s);
  }));
  return _sinaQ;
}

/** 周key：ISO 周起始日（周一）的 YYYYMMDD */
function weekKey(dt) {
  const n = String(dt).replace(/\D/g, '').slice(0, 8);
  const t = new Date(+n.slice(0, 4), +n.slice(4, 6) - 1, +n.slice(6, 8));
  const dow = (t.getDay() + 6) % 7;
  const m = new Date(t); m.setDate(t.getDate() - dow);
  return '' + m.getFullYear() + String(m.getMonth() + 1).padStart(2, '0') + String(m.getDate()).padStart(2, '0');
}

/** 日K 聚合为周K/月K：开=首日开、收=末日收、高=最高、低=最低、量=求和、t=末日 */
function aggregateBars(day, mode) {
  if (!day || day.length < 2) return null;
  const out = [];
  let cur = null, curKey = null;
  const fmt = (n) => n.slice(0, 4) + '-' + n.slice(4, 6) + '-' + n.slice(6, 8);
  for (const b of day) {
    const n = String(b.t).replace(/\D/g, '').slice(0, 8);
    const y = +n.slice(0, 4), m = +n.slice(4, 6);
    const key = mode === 'week' ? weekKey(n) : (y * 100 + m);
    if (key !== curKey) {
      if (cur) out.push(cur);
      cur = { t: fmt(n), o: b.o, c: b.c, h: b.h, l: b.l, v: b.v };
      curKey = key;
    } else {
      cur.c = b.c; cur.t = fmt(n);
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 日K 三源：东财 fetch → 腾讯三主机 → 新浪 JSONP */
async function fetchBarsDay(code) {
  let bars = null;
  try { bars = await klineEm(code, 'day'); } catch (e) { bars = null; }
  if (!bars || !bars.length) {
    try { bars = await klineTx(code, 'day'); } catch (e) { bars = null; }
  }
  if (!bars || !bars.length) {
    try { bars = await sinaDay(code); } catch (e) { bars = null; }
  }
  return bars;
}

async function fetchBars(code, period) {
  if (period === 'day') return fetchBarsDay(code);
  let bars = null;
  try { bars = await klineEm(code, period); } catch (e) { bars = null; }
  if (!bars || !bars.length) {
    try { bars = await klineTx(code, period); } catch (e) { bars = null; }
  }
  if (!bars || !bars.length) {
    try { bars = aggregateBars(await fetchBarsDay(code), period); } catch (e) { bars = null; }
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
  let pre = bars[0].o;
  try {
    const dayBars = await klineTx(code, 'day');
    if (dayBars && dayBars.length > 1) {
      const dg = (x) => String(x).replace(/\D/g, '').slice(0, 8);
      for (let i = dayBars.length - 1; i > 0; i--) {
        if (dg(dayBars[i].t) === day) { pre = dayBars[i - 1].c; break; }
      }
    }
  } catch (e) { /* keep open as base */ }
  return { pre, bars, fake: false, src: 'tx' };
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
  const cap = st.period === 'intra' ? 300 : st.period === '15' || st.period === '30' ? 240 : st.period === 'day' ? 160 : st.period === 'week' ? 140 : 80;
  st.bars = bars && bars.length ? bars.slice(-cap) : null;
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
    grad.addColorStop(0, lineColor + '1f');
    grad.addColorStop(1, lineColor + '03');
    const area = new Path2D(path);
    area.lineTo(X(n - 1), pTop + priceH);
    area.lineTo(X(0), pTop + priceH);
    area.closePath();
    ctx.fillStyle = grad; ctx.fill(area);
    ctx.strokeStyle = lineColor; ctx.lineWidth = 1.4; ctx.stroke(path);
    // pre-close base line on top of the fill
    const y0 = pTop + priceH / 2;
    ctx.strokeStyle = '#c9d3e2'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(padL + iw, y0); ctx.stroke();
    ctx.setLineDash([]);
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
  ctx.fillStyle = C_TXT;
  if (isIntra) {
    const xs = [[0, '09:30'], [60, '10:30'], [120, '11:30/13:00'], [181, '14:00'], [241, '15:00']];
    xs.forEach(([slot, lab], i) => {
      const x = padL + (slot / 241) * iw;
      ctx.textAlign = i === 0 ? 'left' : i === xs.length - 1 ? 'right' : 'center';
      ctx.fillText(lab, x, H - 6);
    });
  } else {
    const picks = Math.min(5, n);
    const idxs = [];
    for (let g = 0; g < picks; g++) idxs.push(Math.round((n - 1) * (g / Math.max(1, picks - 1))));
    idxs.forEach((i, g) => {
      const x = X(i);
      ctx.textAlign = g === 0 ? 'left' : g === idxs.length - 1 ? 'right' : 'center';
      ctx.fillText(fmtBarT(bars[i].t, st.period), Math.max(padL, Math.min(padL + iw, x)), H - 6);
    });
  }
  ctx.textAlign = 'center';

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


/* ---------------------------- 策略选股 ---------------------------- */
function fmtAmt(v) {
  if (v == null || isNaN(v) || v <= 0) return '—';
  return v >= 1e8 ? (v / 1e8).toFixed(2) + '亿' : (v / 1e4).toFixed(0) + '万';
}

/* 命中条目：code、名称、今日涨幅、理由、连板高度 */
function sh(code, name, reason, level, score) {
  const chg = chgOf(code, null);
  return { code, name: name || code, chg, reason, level: level || 1, score: score || 0 };
}

/* 首板优选：首板中封单足、封得早、换手健康 */
function runFirst() {
  return S.day.zt
    .filter((s) => lvOf(s.code) === 1)
    .filter((s) => s.turnover >= 3 && s.turnover <= 30 && s.orderAmt >= 5e7)
    .sort((a, b) => (b.orderAmt - a.orderAmt) || (a.first - b.first))
    .slice(0, 10)
    .map((s) => sh(s.code, s.name, '封单' + fmtAmt(s.orderAmt) + ' · 首封' + fmtTs(s.first).slice(0, 5) + ' · 换手' + pctOf(s.turnover), 1, s.orderAmt));
}

/* 一进二：昨日首板、今日晋级 */
function runPromote() {
  const t = todayMap();
  const lv = todayLevels();
  return (S.day.prev || [])
    .filter((p) => (p.level || 1) === 1)
    .filter((p) => t.has(p.code))
    .sort((a, b) => lv.get(b.code) - lv.get(a.code))
    .map((p) => sh(p.code, p.name, '昨日首板 → 今日' + lv.get(p.code) + '板', lv.get(p.code)));
}

/* 高标龙头：全市场最高板 */
function runLeader() {
  const lv = todayLevels();
  let mx = 0;
  for (const v of lv.values()) if (v > mx) mx = v;
  if (mx < 2) return [];
  return S.day.zt
    .filter((s) => lv.get(s.code) === mx)
    .map((s) => sh(s.code, s.name, '全市场最高 ' + mx + ' 板 · ' + (s.reason || s.type || ''), mx, s.orderAmt));
}

/* 炸板回封：开过板但最终封住 */
function runReseal() {
  return S.day.zt
    .filter((s) => (s.openNum || 0) >= 1)
    .sort((a, b) => (b.openNum - a.openNum) || (a.first - b.first))
    .map((s) => sh(s.code, s.name, '开板' + s.openNum + '次后回封 · 最后封板' + fmtTs(s.last).slice(0, 5)));
}

/* 涨停反包：昨日炸板、今日涨停 */
function runReversal() {
  const t = todayMap();
  return (S.day.prevZb || [])
    .filter((z) => t.has(z.code))
    .map((z) => sh(z.code, z.name, '昨日炸板' + (z.chg != null ? ' ' + fmtPct(z.chg, false) : '') + ' → 今日涨停'));
}

/* 龙回头低吸：近5日曾涨停、今日未涨停但温和上涨 */
function runPullback() {
  const t = todayMap();
  const hits = [];
  for (const r of (S.day.recentZt || [])) {
    if (t.has(r.code)) continue;
    const qv = q(r.code);
    if (!qv || qv.chg == null || qv.chg < 2 || qv.chg > 6) continue;
    if (qv.turnover != null && qv.turnover < 3) continue;
    hits.push(sh(r.code, r.name, r.day.slice(4, 6) + '月' + r.day.slice(6, 8) + '日涨停 · 今日' + fmtPct(qv.chg, false) + ' · 换手' + pctOf(qv.turnover)));
  }
  return hits.sort((a, b) => b.chg - a.chg).slice(0, 10);
}

/* 地天板：昨日跌停、今日涨停 */
function runDtd() {
  const t = todayMap();
  return (S.day.prevDt || [])
    .filter((z) => t.has(z.code))
    .map((z) => sh(z.code, z.name, '昨日跌停 → 今日涨停'));
}

/* 一字加速：开盘即封死、几乎无换手 */
function runOneword() {
  return S.day.zt
    .filter((s) => {
      if (!s.first || s.first <= 0) return false;
      const d = new Date(+s.first * 1000 + 8 * 3600 * 1000);
      const min = d.getUTCHours() * 60 + d.getUTCMinutes();
      return min <= 566 && s.turnover < 1.5;
    })
    .map((s) => sh(s.code, s.name, '首封' + fmtTs(s.first).slice(0, 5) + ' · 换手' + pctOf(s.turnover)));
}


/* ---------- 指标策略（K线缓存，近5日涨停池内筛选） ---------- */
function kdjOfBars(bars) {
  const K = [], D = [], J = [];
  let k = 50, d = 50;
  for (let i = 0; i < bars.length; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = Math.max(0, i - 8); j <= i; j++) { if (bars[j].l < lo) lo = bars[j].l; if (bars[j].h > hi) hi = bars[j].h; }
    const rsv = hi === lo ? 50 : (bars[i].c - lo) / (hi - lo) * 100;
    k = (k * 2 + rsv) / 3; d = (d * 2 + k) / 3;
    K.push(k); D.push(d); J.push(3 * k - 2 * d);
  }
  return { K, D, J };
}
function klOf(code) { const k = S._kl && S._kl[code]; return k || null; }
function barDay(b) { return String(b.t).replace(/\D/g, '').slice(0, 8); }

/* 低位横盘：涨停后平台整理（振幅≤15%）+ 贴近60日低点 + 缩量蓄势 */
function runSideways() {
  const t = todayMap();
  const rows = [];
  for (const r of (S.day.recentZt || [])) {
    if (t.has(r.code)) continue;
    const k = klOf(r.code); const bars = k && k.day;
    if (!bars || bars.length < 60) continue;
    const dg = (b) => String(b.t).replace(/\D/g, '').slice(0, 8);
    let idx = -1;
    for (let i = bars.length - 1; i >= 0; i--) { if (dg(bars[i]) === r.day) { idx = i; break; } }
    if (idx < 0) continue;
    const seg = bars.slice(idx);
    const lo = Math.min(...seg.map((b) => b.l));
    const hi = Math.max(...seg.map((b) => b.h));
    const amp = (hi - lo) / lo * 100;
    if (amp > 15) continue;
    const low60 = Math.min(...bars.slice(-60).map((b) => b.l));
    const offLow = (bars[bars.length - 1].c - low60) / low60 * 100;
    if (offLow > 20) continue;
    const prev5 = bars.slice(-6, -1);
    const avgV = prev5.reduce((x, b) => x + b.v, 0) / prev5.length;
    const vr = avgV > 0 ? bars[bars.length - 1].v / avgV : 0;
    if (vr > 2) continue;
    rows.push({ code: r.code, name: r.name, amp, offLow, vr, n: seg.length, day: r.day });
  }
  rows.sort((a, b) => a.amp - b.amp);
  return rows.slice(0, 12).map((x) => sh(x.code, x.name, x.day.slice(4, 6) + '月' + x.day.slice(6, 8) + '日涨停后' + x.n + '日整理 · 振幅' + x.amp.toFixed(1) + '% · 距60日低点' + x.offLow.toFixed(1) + '% · 量比' + x.vr.toFixed(1)));
}

function kdjHit(bars, label) {
  if (!bars || bars.length < 16) return null;
  const { K, D, J } = kdjOfBars(bars);
  const n = bars.length - 1;
  if (K[n] < D[n] || K[n - 1] >= D[n - 1]) return null;   // 本周/本月刚金叉
  if (K[n] <= K[n - 1] || D[n] < D[n - 1]) return null;   // K、D 上翘
  if (K[n] > 60) return null;                              // 低位区
  if (Math.abs(K[n] - D[n]) > 8) return null;              // 金叉初期三线仍粘合
  const pre = K.slice(n - 4, n);                           // 金叉前 K 值波动
  if (Math.max(...pre) - Math.min(...pre) > 15) return null; // 前期粘合
  return { k: K[n], d: D[n], j: J[n], label };
}

/* KDJ 周线上翘粘合 */
function runKdjWeek() {
  const rows = [];
  for (const r of (S.day.recentZt || [])) {
    const k = klOf(r.code);
    const hit = kdjHit(k && k.week, '周KDJ');
    if (hit) rows.push({ ...hit, code: r.code, name: r.name });
  }
  rows.sort((a, b) => a.k - b.k);
  return rows.slice(0, 20).map((x) => sh(x.code, x.name, x.label + ' K' + x.k.toFixed(0) + ' D' + x.d.toFixed(0) + ' J' + x.j.toFixed(0) + ' · 低位金叉上翘'));
}

/* KDJ 月线上翘粘合 */
function runKdjMonth() {
  const rows = [];
  for (const r of (S.day.recentZt || [])) {
    const k = klOf(r.code);
    const hit = kdjHit(k && k.month, '月KDJ');
    if (hit) rows.push({ ...hit, code: r.code, name: r.name });
  }
  rows.sort((a, b) => a.k - b.k);
  return rows.slice(0, 20).map((x) => sh(x.code, x.name, x.label + ' K' + x.k.toFixed(0) + ' D' + x.d.toFixed(0) + ' J' + x.j.toFixed(0) + ' · 低位金叉上翘'));
}

/* 放量启动：量比≥2.5 + 今日涨2~7% + 未涨停 */
function runVolume() {
  const t = todayMap();
  const rows = [];
  for (const r of (S.day.recentZt || [])) {
    if (t.has(r.code)) continue;
    const qv = q(r.code);
    if (!qv || qv.chg == null || qv.chg < 2 || qv.chg > 7) continue;
    const k = klOf(r.code); const bars = k && k.day;
    if (!bars || bars.length < 6) continue;
    if (barDay(bars[bars.length - 1]) !== S.day.date) continue;
    const prev5 = bars.slice(-6, -1);
    const avgV = prev5.reduce((x, b) => x + b.v, 0) / prev5.length;
    const vr = avgV > 0 ? bars[bars.length - 1].v / avgV : 0;
    if (vr < 2.5) continue;
    rows.push({ code: r.code, name: r.name, vr });
  }
  rows.sort((a, b) => b.vr - a.vr);
  return rows.slice(0, 10).map((x) => sh(x.code, x.name, '量比' + x.vr.toFixed(1) + ' · 今日' + fmtPct(q(x.code).chg, false)));
}

const KL_CACHE = 'klcache_v2_';
let _klTok = 0;
async function loadStrategyKlines() {
  if (S._klLoading || S._klReady) return;
  const codes = (S.day && S.day.recentZt || []).map((r) => r.code);
  if (!codes.length) return;
  const tok = ++_klTok;
  S._klLoading = true;
  S._klTotal = codes.length;
  S._klDone = 0;
  S._klFail = 0;
  const ckey = KL_CACHE + (S.day.date || '');
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(ckey) || '{}') || {}; } catch (e) { cache = {}; }
  for (const c of codes) {
    if (cache[c] && Array.isArray(cache[c].day) && cache[c].day.length) {
      (S._kl[c] = S._kl[c] || {}).day = cache[c].day;
      S._klDone++;
    }
  }
  if (S.view === 'strategy') renderStrategy();
  const missing = codes.filter((c) => !((S._kl[c] || {}).day));
  await mapLimit(missing, 5, async (code, idx) => {
    let bars = null;
    try { bars = await fetchBarsDay(code); } catch (e) { bars = null; }
    if (tok !== _klTok) return;
    (S._kl[code] = S._kl[code] || {}).day = bars;
    if (bars && bars.length) cache[code] = { day: bars.slice(-300) };
    else S._klFail++;
    S._klDone++;
    if (idx % 40 === 0) await sleep(200);
    if (S.view === 'strategy' && S._klDone % 10 === 0) renderStrategy();
  });
  if (tok !== _klTok) return;
  try { localStorage.setItem(ckey, JSON.stringify(cache)); } catch (e) { /* quota */ }
  // 周/月由日线聚合（close 序列与真实周/月K一致，KDJ 形态等价）
  for (const code of codes) {
    const kl = S._kl[code] = S._kl[code] || {};
    kl.week = aggregateBars(kl.day, 'week');
    kl.month = aggregateBars(kl.day, 'month');
  }
  S._klLoading = false;
  S._klReady = true;
  if (S.view === 'strategy') renderStrategy();
}

/* ---- 行业概念板块 KDJ：同花顺板块日K last300.js（CORS *），周/月聚合 ---- */
const BK_CACHE = 'bkcache_';
let _bkTok = 0;
function prevDateStr(d) {
  const y = +d.slice(0, 4), m = +d.slice(4, 6) - 1, dd = +d.slice(6, 8);
  const dt = new Date(Date.UTC(y, m, dd)); dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10).replace(/-/g, '');
}
/* 板块宇宙：近 60 个自然日的 block_top（有涨停股出现的行业/概念板块）合并去重 */
async function fetchBoardUniverse(startDate) {
  const map = new Map();
  let d = startDate;
  for (let i = 0; i < 60; i++) {
    const list = await fetchThsBlocks(d).catch(() => []);
    for (const b of list) if (!map.has(b.name)) map.set(b.name, { code: b.code, name: b.name, chg: b.chg, zt: b.zt });
    d = prevDateStr(d);
  }
  return Array.from(map.values());
}
async function fetchThsBkKline(code) {
  const base = API.THS_BK + 'bk_' + code + '/01/last300.js';
  let txt = null;
  for (const u of [base.replace('/v6/', '/v4/'), base]) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 9000);
    try {
      const r = await fetch(u, { signal: ctl.signal, cache: 'no-store' });
      if (r.ok) txt = await r.text();
    } catch (e) { txt = null; }
    clearTimeout(t);
    if (txt && txt.indexOf('({') > 0) break;
  }
  if (!txt || txt.indexOf('({') < 0) throw new Error('bad');
  const i = txt.indexOf('({');
  const j = JSON.parse(txt.slice(i + 1, txt.lastIndexOf('})') + 1));
  if (!j || !j.data) throw new Error('bad');
  return String(j.data).split(';').filter(Boolean).map((seg) => {
    const p = seg.split(',');
    return { t: p[0], o: +p[1], h: +p[2], l: +p[3], c: +p[4], v: +p[5] || 0 };
  });
}
async function loadBkKlines() {
  if (S._bkLoading || S._bkReady) return;
  if (!S._bkList) {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem('thsbk_list') || 'null'); } catch (e) { cached = null; }
    if (cached && Array.isArray(cached) && cached.length > 10) S._bkList = cached;
  }
  if (!S._bkList) {
    S._bkList = await fetchBoardUniverse(S.day.date).catch(() => []);
    if (S._bkList.length > 10) { try { localStorage.setItem('thsbk_list', JSON.stringify(S._bkList)); } catch (e) { /* quota */ } }
  }
  const blocks = S._bkList;
  if (!blocks.length) { S._bkReady = true; return; }
  const tok = ++_bkTok;
  S._bkLoading = true; S._bkTotal = blocks.length; S._bkDone = 0; S._bkFail = 0;
  S._bk = {};
  const missing = blocks.filter((b) => !S._bk[b.code]);
  await mapLimit(missing, 4, async (b, idx) => {
    let bars = null;
    try { bars = await fetchThsBkKline(b.code); } catch (e) { bars = null; }
    if (tok !== _bkTok) return;
    S._bk[b.code] = bars;
    if (!bars || !bars.length) S._bkFail++;
    S._bkDone++;
    if (idx % 20 === 0) await sleep(250);
    if (S.view === 'strategy' && S._bkDone % 10 === 0) renderStrategy();
  });
  if (tok !== _bkTok) return;
  S._bkLoading = false;
  S._bkReady = true;
  if (S.view === 'strategy') renderStrategy();
}
/* 三周期共振：日线 J 上窜 K（多头排列）、周线三线粘合、月线 KDJ 上翘；≥2 项即命中，全中排前 */
function runBkKdj() {
  const ztMap = new Map((S.day.blocks || []).map((b) => [b.name, b]));
  const rows = [];
  for (const b of (S._bkList || [])) {
    const day = S._bk[b.code];
    if (!day || day.length < 120) continue;
    const wk = aggregateBars(day, 'week');
    const mo = aggregateBars(day, 'month');
    const d = kdjOfBars(day), w = kdjOfBars(wk), m = kdjOfBars(mo);
    if (!d || !w || !m || d.K.length < 3 || w.K.length < 2 || m.K.length < 2) continue;
    const dn = d.K.length - 1, wn = w.K.length - 1, mn = m.K.length - 1;
    const jUpK = d.J[dn] > d.K[dn] && d.K[dn] > d.D[dn];
    const wSpan = Math.max(w.K[wn], w.D[wn], w.J[wn]) - Math.min(w.K[wn], w.D[wn], w.J[wn]);
    const wStick = wSpan <= 12;
    const mUp = m.K[mn] > m.K[mn - 1];
    const score = (jUpK ? 1 : 0) + (wStick ? 1 : 0) + (mUp ? 1 : 0);
    if (score < 2) continue;
    const zt = ztMap.get(b.name);
    const tags = [jUpK ? '日J上窜K' : '', wStick ? '周粘合' : '', mUp ? '月KDJ上翘' : ''].filter(Boolean).join(' · ');
    rows.push({
      bk: b.code,
      nm: b.name,
      name: b.name,
      chg: zt ? zt.chg : null,
      reason: tags + (zt ? ' · 今日涨停' + zt.zt + '家' : '') + ' · 周差' + wSpan.toFixed(1),
      score,
      wSpan,
    });
  }
  rows.sort((a, b) => (b.score - a.score) || (a.wSpan - b.wSpan) || ((ztMap.get(b.nm) ? ztMap.get(b.nm).zt : 0) - (ztMap.get(a.nm) ? ztMap.get(a.nm).zt : 0)));
  return rows.slice(0, 20);
}

const STRATEGIES = [
  { id: 'first', name: '首板优选', tag: '打板', desc: '今日首板中封单最足、封板最早、换手健康的前 10 只', run: runFirst },
  { id: 'promote', name: '一进二晋级', tag: '打板', desc: '昨日首板、今日再度封板，短线最经典的打板晋级', run: runPromote },
  { id: 'leader', name: '高标龙头', tag: '情绪', desc: '全市场今日最高连板的股票，市场情绪总龙头', run: runLeader },
  { id: 'reseal', name: '炸板回封', tag: '打板', desc: '今日盘中开过板、尾盘仍封住涨停，分歧转一致', run: runReseal },
  { id: 'reversal', name: '涨停反包', tag: '反包', desc: '昨日炸板、今日直接涨停反包，弱转强信号', run: runReversal },
  { id: 'pullback', name: '龙回头低吸', tag: '低吸', desc: '近 5 日曾涨停、今日未涨停但温和放量上涨，强势股资金回流', run: runPullback },
  { id: 'sideways', name: '低位横盘', tag: '指标', desc: '涨停后平台整理（振幅≤15%）、贴近60日低点、缩量蓄势（近5日涨停池内筛选，前复权）', needsKl: true, run: runSideways },
  { id: 'kdjw', name: 'KDJ周线上翘', tag: '指标', desc: '周线KDJ(9,3,3)三线低位粘合、K上穿D后继续上翘（近5日涨停池内筛选，显示前20只）', needsKl: true, run: runKdjWeek },
  { id: 'kdjm', name: 'KDJ月线上翘', tag: '指标', desc: '月线KDJ(9,3,3)三线低位粘合、K上穿D后继续上翘（近5日涨停池内筛选，显示前20只）', needsKl: true, run: runKdjMonth },
  { id: 'volume', name: '放量启动', tag: '指标', desc: '量比≥2.5、今日涨2~7%且未涨停，资金进场信号（近5日涨停池内筛选）', needsKl: true, run: runVolume },
  { id: 'bkkdj', name: '行业概念KDJ共振', tag: '指标', desc: '近三个月有涨停的行业/概念板块指数：日线J上窜K、周线三线粘合（差≤12）、月线KDJ上翘，满足≥2项即命中、全中排前（最多20个）', needsBk: true, unit: '个', run: runBkKdj },
  { id: 'dtd', name: '地天板', tag: '反包', desc: '昨日跌停、今日涨停的极端反转，辨识度极高', run: runDtd },
  { id: 'oneword', name: '一字加速', tag: '情绪', desc: '开盘即封死、几乎无换手的一字板，资金一致性最强', run: runOneword },
];

let _extrasDate = null;
async function loadStrategyExtras(date) {
  if (_extrasDate === date) return;
  _extrasDate = date;
  if (S._klDate !== date) { S._klDate = date; S._kl = {}; S._klReady = false; S._klLoading = false; _klTok++; }
  if (S._bkDate !== date) { S._bkDate = date; S._bk = {}; S._bkReady = false; S._bkLoading = false; _bkTok++; }
  const prevDate = S.day && S.day.prevDate;
  if (!prevDate) { _extrasDate = null; return; }
  const [prevZb, prevDt, recentZt] = await Promise.all([
    fetchEmPool('zb', prevDate).catch(() => []),
    fetchEmPool('dt', prevDate).catch(() => []),
    fetchRecentZt(date, 5).catch(() => []),
  ]);
  if (!S.day || S.day.date !== date) return;
  S.day.prevZb = prevZb;
  S.day.prevDt = prevDt;
  S.day.recentZt = recentZt;
  const need = recentZt.map((r) => r.code).filter((c) => !S.quotes.has(c));
  if (need.length) {
    const extra = await fetchQuotes(need).catch(() => new Map());
    for (const [k, v] of extra) S.quotes.set(k, v);
    if (!S.day || S.day.date !== date) return;
  }
  if (S.view === 'strategy') { renderStrategy(); loadStrategyKlines().catch(() => {}); loadBkKlines().catch(() => {}); requestAnimationFrame(() => requestAnimationFrame(layoutStrategyMasonry)); }
}

async function fetchRecentZt(endDate, days) {
  const seen = new Map();
  for (let i = 1; i <= days; i++) {
    const d = shiftDay(endDate, -i);
    const pool = await fetchThsPool(d).catch(() => []);
    for (const st of pool) {
      if (!seen.has(st.code)) seen.set(st.code, { code: st.code, name: st.name, level: st.level || 1, day: d });
    }
  }
  return Array.from(seen.values());
}

/* 卡片高度自适应：按内容高度计算 grid 行跨度，消除行间大片空白 */
function layoutStrategyMasonry() {
  const grid = $('#strategyGrid');
  if (!grid || !grid.children.length) return;
  const view = $('#viewStrategy');
  if (view && view.classList.contains('hidden')) return;
  const cards = Array.from(grid.children);
  cards.forEach((c) => { c.style.gridRowEnd = 'auto'; });
  const cs = getComputedStyle(grid);
  const rowGap = parseFloat(cs.rowGap) || 12;
  const unit = parseFloat(cs.gridAutoRows) || 8;
  const step = unit + rowGap;
  const hs = cards.map((c) => c.getBoundingClientRect().height);
  cards.forEach((c, i) => {
    const h = hs[i];
    if (!h) return;
    const span = Math.max(1, Math.ceil((h + rowGap) / step));
    c.style.gridRowEnd = 'span ' + span;
  });
}

function renderStrategy() {
  const grid = $('#strategyGrid');
  if (!grid) return;
  if (!S.day) { grid.innerHTML = ''; return; }
  const readyBase = !!(S.day.prevZb && S.day.prevDt && S.day.recentZt);
  grid.innerHTML = STRATEGIES.map((st) => {
    let hits = [];
    const ready = (st.needsKl || st.needsBk) ? readyBase && (st.needsKl ? !!S._klReady : true) && (st.needsBk ? !!S._bkReady : true) : readyBase;
    if (ready) {
      try { hits = st.run() || []; } catch (e) { console.error(st.id, e); }
    }
    const cells = hits.length
      ? hits.map((x) => {
          const ccls = x.chg == null ? 'flat' : x.chg > 0 ? 'up' : x.chg < 0 ? 'down' : 'flat';
          return '<button class="sh" ' + (x.bk ? 'data-bk="' + x.bk + '" data-nm="' + esc(x.nm || x.name) + '"' : 'data-code="' + x.code + '"') + ' title="' + esc(x.reason) + '">'
            + '<i class="mk">' + (x.bk ? '板' : mkName(x.code)) + '</i>'
            + '<b class="sh-nm">' + esc(x.name) + '</b>'
            + '<span class="sh-chg ' + ccls + '">' + fmtPct(x.chg, false) + '</span>'
            + '<span class="sh-reason">' + esc(x.reason) + '</span></button>';
        }).join('')
      : '<div class="sh-empty">' + (ready
          ? ((st.needsKl && S._klFail >= (S._klTotal || 1) * 0.9) ? 'K线数据加载失败（' + (S._klFail || 0) + '/' + (S._klTotal || 0) + ' 只）<a class="retry">点此重试</a>'
            : (st.needsBk && S._bkFail >= (S._bkTotal || 1) * 0.9) ? '板块K线加载失败（' + (S._bkFail || 0) + '/' + (S._bkTotal || 0) + ' 个）<a class="retry">点此重试</a>' : '今日无命中')
          : (st.needsKl ? 'K线计算中… ' + (S._klDone || 0) + '/' + (S._klTotal || 0) : st.needsBk ? '板块K线计算中… ' + (S._bkDone || 0) + '/' + (S._bkTotal || 0) : '数据加载中…')) + '</div>';
    return '<div class="strategy-card">'
      + '<div class="strategy-head"><b>' + st.name + '</b><span class="strategy-tag">' + st.tag + '</span>'
      + '<span class="strategy-count">' + (ready ? hits.length + ' ' + (st.unit || '只') : ((st.needsKl || st.needsBk) ? '计算中' : '')) + '</span>'
      + '<p class="strategy-desc">' + st.desc + '</p></div>'
      + '<div class="strategy-hits">' + cells + '</div></div>';
  }).join('');
  requestAnimationFrame(layoutStrategyMasonry);
}

/* ---------------------------- events ---------------------------- */
function bindEvents() {
  $('#viewTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    S.view = btn.dataset.view;
    $$('#viewTabs button').forEach((b) => b.classList.toggle('on', b === btn));
    ['relay', 'sector', 'list', 'strategy'].forEach((v) => $('#view' + v[0].toUpperCase() + v.slice(1)).classList.toggle('hidden', v !== S.view));
    if (S.view === 'strategy') { renderStrategy(); loadStrategyKlines().catch(() => {}); loadBkKlines().catch(() => {}); requestAnimationFrame(() => requestAnimationFrame(layoutStrategyMasonry)); }
    if (S.view === 'sector') {
      if (!S.boardCurves) renderSector();
      else requestAnimationFrame(() => requestAnimationFrame(() => drawSectorChart()));
    }
  });

  $('#ruleTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-rule]');
    if (!btn) return;
    S.rule = btn.dataset.rule;
    $$('#ruleTabs button').forEach((b) => b.classList.toggle('on', b === btn));
    renderLadder();
  });

  $('#promoteBtn').addEventListener('click', (e) => {
    S.promoteOnly = !S.promoteOnly;
    e.currentTarget.classList.toggle('on', S.promoteOnly);
    e.currentTarget.setAttribute('aria-pressed', String(S.promoteOnly));
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
    const sec = e.target.closest('.sec[data-sec]');
    if (sec) {
      // 重渲染会移除被点的元素，阻止冒泡以免 document 兜底逻辑误判为「点空白」
      e.stopPropagation();
      const nm = sec.dataset.sec;
      S.focusSec = S.focusSec === nm ? null : nm;
      renderLadder();
      return;
    }
    const el = e.target.closest('.stk');
    if (el) {
      clearFocusSec();
      openStock(el.dataset.code, el.querySelector('.nm').textContent);
      return;
    }
    clearFocusSec();
  });

  $('#focusBar').addEventListener('click', clearFocusSec);

  document.addEventListener('click', (e) => {
    if (!S.focusSec) return;
    if (e.target.closest('#ladder') || e.target.closest('#focusBar')) return;
    clearFocusSec();
  });

  $('#sectorMode').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-m]');
    if (!btn) return;
    S.boardMode = btn.dataset.m;
    $('#sectorMode button').forEach((b) => b.classList.toggle('on', b === btn));
    updateSectorHint();
    const secTip = $('#sectorTip');
    if (secTip) secTip.classList.remove('on');
    drawSectorChart();
  });

  $('#strategyGrid').addEventListener('click', (e) => {
    if (e.target.classList && e.target.classList.contains('retry')) {
      if (S._bkFail >= (S._bkTotal || 1) * 0.9 && !S._bkReady) {
        S._bkReady = false; S._bkLoading = false;
        try { localStorage.removeItem(BK_CACHE + (S.day.date || '')); } catch (err) {}
        loadBkKlines().catch(() => {});
        return;
      }
      S._klReady = false;
      S._klLoading = false;
      try { localStorage.removeItem(KL_CACHE + (S.day.date || '')); } catch (err) {}
      loadStrategyKlines().catch(() => {});
      return;
    }
    const btn = e.target.closest('.sh');
    if (!btn) return;
    if (btn.dataset.bk) {
      const tab = document.querySelector('#viewTabs button[data-view="sector"]');
      if (tab) tab.click();
      const row = document.querySelector('#sectorList .srow[data-board="' + CSS.escape(btn.dataset.nm) + '"]');
      if (row) { if (!row.classList.contains('on')) row.click(); }
      else toast('该板块今日无涨停股，暂无分时曲线');
      return;
    }
    openStock(btn.dataset.code);
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
      if (S.view === 'strategy') layoutStrategyMasonry();
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
