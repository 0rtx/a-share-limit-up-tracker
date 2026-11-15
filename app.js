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
  TX_MIN: 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=',
  TX_K: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=',
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
  minute: new Map(),  // code -> {pre, pts}
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

async function fetchJSON(url, timeout = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
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
  const sym = (isSh(code) ? 'sh' : 'sz') + code;
  const j = await fetchJSON(API.TX_MIN + sym, 10000);
  const d = j && j.data && j.data[sym];
  if (!d || !d.data || !d.data.data) return null;
  const qt = d.qt && d.qt[sym];
  const pre = qt ? +qt[4] : 0;
  const pts = [];
  for (const row of d.data.data) {
    const seg = row.split(' ');
    const t = seg[0];
    if (t.length < 4) continue;
    const hh = +t.slice(0, 2), mm = +t.slice(2, 4);
    const p = +seg[1];
    if (!p) continue;
    pts.push([slotOf(hh * 60 + mm), p]);
  }
  return { pre, pts };
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
  for (const s of S.day.zt) m = Math.max(m, s.level || 1);
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
  let first = zt.filter((s) => (s.level || 1) === 1);
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
async function ensureMinutes(codes) {
  const need = codes.filter((c) => !S.minute.has(c) && !S.minutePending.has(c));
  if (!need.length) return;
  need.forEach((c) => S.minutePending.add(c));
  await mapLimit(need, 8, async (code) => {
    try {
      const m = await fetchMinute(code);
      if (m) S.minute.set(code, m);
    } catch (e) { /* ignore */ }
    finally { S.minutePending.delete(code); }
  });
}

async function buildBoardCurves() {
  const sel = S.day.blocks.filter((b) => S.boardSel.has(b.name));
  if (!sel.length) return [];
  const codes = Array.from(new Set(sel.flatMap((b) => b.stocks.map((s) => s.code))));
  await ensureMinutes(codes);

  return sel.map((b) => {
    const pts = b.stocks.map((s) => {
      const m = S.minute.get(s.code);
      if (!m || !m.pre) return null;
      return { m, first: s.first || 0 };
    }).filter(Boolean);
    if (!pts.length) return { name: b.name, values: [], ztCount: b.zt };
    const arrs = pts.map((p) => {
      const a = new Array(242).fill(null);
      for (const [slot, v] of p.m.pts) a[slot] = v;
      let zslot = 999;
      if (p.first) {
        const d = new Date(+p.first * 1000 + 8 * 3600 * 1000);
        zslot = slotOf(d.getUTCHours() * 60 + d.getUTCMinutes());
      }
      return { a, pre: p.m.pre, zslot };
    });
    const values = [];
    const ztSeries = [];
    for (let slot = 0; slot <= 241; slot++) {
      let sum = 0, n = 0, zc = 0;
      for (const p of arrs) {
        const v = p.a[slot];
        if (v != null) { sum += (v - p.pre) / p.pre * 100; n++; }
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
    chg: '成员股等权涨幅 · 分钟级',
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
    { t: '连板', v: (s) => `<span class="tag">${s.level === 1 ? '首板' : s.level + '板'}</span>` },
    { t: '涨停统计', v: (s) => `<span class="tag g">${esc(s.daysText || '—')}</span>` },
    { t: '板块概念', cls: 'tags-cell', v: (s) => tagsHtml(s.code) },
    { t: '首封', v: (s) => fmtTs(s.first) },
    { t: '最后封板', v: (s) => fmtTs(s.last) },
    { t: '炸板', v: (s) => s.openNum || 0 },
    { t: '封单额', v: (s) => fmtAmt(s.orderAmt) },
    { t: '换手', v: (s) => pctOf(q(s.code)?.turnover ?? s.turnover) },
    { t: '成交额', v: (s) => fmtAmt(q(s.code)?.amt ?? s.amount) },
    { t: '流通市值', v: (s) => fmtAmt(q(s.code)?.flowCap ?? s.flowCap) },
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
      rows = rows.filter((s) => (lv >= 6 ? (s.level || 1) >= 6 : (s.level || 1) === lv));
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

/* ---------------------------- modal ---------------------------- */
async function openStock(code, name) {
  $('#modalTitle').innerHTML = `${esc(name || code)}<span class="sub">${code}</span>`;
  $('#modal').classList.add('on');
  try {
    if (!S.minute.has(code)) {
      const m = await fetchMinute(code);
      if (m) S.minute.set(code, m);
    }
    drawIntra(code);
    await drawKline(code);
  } catch (e) {
    console.error(e);
  }
}

function drawIntra(code) {
  const m = S.minute.get(code);
  const canvas = $('#chartIntra');
  if (!m) {
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#9aa5b1'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('暂无分时数据', canvas.clientWidth / 2, canvas.clientHeight / 2);
    return;
  }
  const vals = new Array(242).fill(null);
  for (const [slot, p] of m.pts) vals[slot] = (p - m.pre) / m.pre * 100;
  drawLineChart(canvas, {
    series: [{ name: '涨幅', color: vals[241] >= 0 ? '#ef4444' : '#16a34a', vals }],
    xFrom: 0, xTo: 241,
    xLabels: SLOT_LABELS,
    yFmt: (v) => v.toFixed(1) + '%',
    legend: false,
    tipFmt: (items, idx) => `<div>${labelOfSlot(idx)}</div><div>${items[0] ? items[0].v.toFixed(2) + '%' : '—'}</div>`,
  });
}

async function drawKline(code) {
  const sym = (isSh(code) ? 'sh' : 'sz') + code;
  const j = await fetchJSON(API.TX_K + `${sym},day,,,60,qfq`, 12000);
  const d = j && j.data && j.data[sym];
  const k = d && (d.qfqday || d.day);
  const canvas = $('#chartKline');
  if (!k || !k.length) {
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#9aa5b1'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('暂无 K 线数据', canvas.clientWidth / 2, canvas.clientHeight / 2);
    return;
  }
  const rows = k.map((r) => ({ date: r[0], open: +r[1], close: +r[2], high: +r[3], low: +r[4] }));
  const vals = rows.map((r) => r.close);
  drawLineChart(canvas, {
    series: [{ name: '收盘', color: '#2563eb', vals }],
    xFrom: 0, xTo: rows.length - 1,
    xLabels: [[0, rows[0].date.slice(5)], [Math.floor(rows.length / 2), rows[Math.floor(rows.length / 2)].date.slice(5)], [rows.length - 1, rows[rows.length - 1].date.slice(5)]],
    yFmt: (v) => v.toFixed(2),
    legend: false,
  });
}

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
