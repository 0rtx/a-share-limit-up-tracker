'use strict';

const UT = '7eea3edcaed734bea9cbfc24409ed989';
const DPT = 'wz.ztzt';
const BASE = 'https://push2ex.eastmoney.com/';
const EP = { zt: 'getTopicZTPool', zb: 'getTopicZBPool', dt: 'getTopicDTPool', qs: 'getTopicQSPool' };

const TIME_BUCKETS = [
  { label: '竞价', from: 0, to: 92959 },
  { label: '09:30-10:00', from: 93000, to: 100000 },
  { label: '10:00-10:30', from: 100000, to: 103000 },
  { label: '10:30-11:00', from: 103000, to: 110000 },
  { label: '11:00-11:30', from: 110000, to: 113000 },
  { label: '13:00-13:30', from: 130000, to: 133000 },
  { label: '13:30-14:00', from: 133000, to: 140000 },
  { label: '14:00-14:30', from: 140000, to: 143000 },
  { label: '14:30-15:00', from: 143000, to: 150100 }
];

const LEFT_KEYS = new Set(['code', 'name', 'hybk']);

const COLS = {
  zt: [
    { k: 'idx', label: '#' },
    { k: 'code', label: '代码', sort: 'c' },
    { k: 'name', label: '名称', sort: 'n' },
    { k: 'price', label: '最新价', sort: 'p', num: true },
    { k: 'zdp', label: '涨跌幅', sort: 'zdp', num: true },
    { k: 'lbc', label: '连板', sort: 'lbc', num: true },
    { k: 'zttj', label: '涨停统计', sort: 'zttj' },
    { k: 'fbt', label: '首次封板', sort: 'fbt' },
    { k: 'lbt', label: '最后封板', sort: 'lbt' },
    { k: 'zbc', label: '炸板', sort: 'zbc', num: true },
    { k: 'fund', label: '封单资金', sort: 'fund', num: true },
    { k: 'hs', label: '换手率', sort: 'hs', num: true },
    { k: 'amount', label: '成交额', sort: 'amount', num: true },
    { k: 'hybk', label: '行业', sort: 'hybk' }
  ],
  zb: [
    { k: 'idx', label: '#' },
    { k: 'code', label: '代码', sort: 'c' },
    { k: 'name', label: '名称', sort: 'n' },
    { k: 'price', label: '最新价', sort: 'p', num: true },
    { k: 'zdp', label: '涨跌幅', sort: 'zdp', num: true },
    { k: 'zf', label: '振幅', sort: 'zf', num: true },
    { k: 'fbt', label: '首次封板', sort: 'fbt' },
    { k: 'zbc', label: '炸板次数', sort: 'zbc', num: true },
    { k: 'zttj', label: '涨停统计', sort: 'zttj' },
    { k: 'hs', label: '换手率', sort: 'hs', num: true },
    { k: 'amount', label: '成交额', sort: 'amount', num: true },
    { k: 'hybk', label: '行业', sort: 'hybk' }
  ],
  dt: [
    { k: 'idx', label: '#' },
    { k: 'code', label: '代码', sort: 'c' },
    { k: 'name', label: '名称', sort: 'n' },
    { k: 'price', label: '最新价', sort: 'p', num: true },
    { k: 'zdp', label: '涨跌幅', sort: 'zdp', num: true },
    { k: 'days', label: '跌停天数', sort: 'days', num: true },
    { k: 'fund', label: '封单资金', sort: 'fund', num: true },
    { k: 'lbt', label: '封板时间', sort: 'lbt' },
    { k: 'hs', label: '换手率', sort: 'hs', num: true },
    { k: 'amount', label: '成交额', sort: 'amount', num: true },
    { k: 'hybk', label: '行业', sort: 'hybk' }
  ],
  qs: [
    { k: 'idx', label: '#' },
    { k: 'code', label: '代码', sort: 'c' },
    { k: 'name', label: '名称', sort: 'n' },
    { k: 'price', label: '最新价', sort: 'p', num: true },
    { k: 'zdp', label: '涨跌幅', sort: 'zdp', num: true },
    { k: 'ztp', label: '涨停价', sort: 'ztp', num: true },
    { k: 'hs', label: '换手率', sort: 'hs', num: true },
    { k: 'lb', label: '量比', sort: 'lb', num: true },
    { k: 'zs', label: '涨速', sort: 'zs', num: true },
    { k: 'nh', label: '新高', sort: 'nh' },
    { k: 'zttj', label: '涨停统计', sort: 'zttj' },
    { k: 'cc', label: '入选理由', sort: 'cc' },
    { k: 'amount', label: '成交额', sort: 'amount', num: true },
    { k: 'ltsz', label: '流通市值', sort: 'ltsz', num: true },
    { k: 'hybk', label: '行业', sort: 'hybk' }
  ]
};

const state = {
  date: '',
  tab: 'zt',
  data: { zt: [], zb: [], dt: [], qs: [] },
  filters: { search: '', lbc: 'all', industry: '' },
  sort: { key: 'fbt', dir: 1 },
  prevZt: null,
  auto: true,
  followLatest: true,
  lastUpdate: null
};

let latestDate = null;
let isOnLatest = false;
let refreshTimer = null;
let nextRefreshAt = 0;

const $ = (id) => document.getElementById(id);
const dateInput = $('dateInput');
const tabsEl = $('tabs');
const cardsEl = $('cards');
const summaryEl = $('summaryText');
const chartLb = $('chartLb');
const chartTime = $('chartTime');
const chartInd = $('chartInd');
const theadEl = $('thead');
const tbodyEl = $('tbody');
const searchEl = $('search');
const lbcEl = $('lbcFilter');
const indEl = $('industryFilter');
const tableFootEl = $('tableFoot');
const loadingEl = $('loading');
const toastEl = $('toast');
const statusText = $('statusText');
const countdownEl = $('countdown');
const liveDot = $('liveDot');
const pauseBtn = $('pauseBtn');
const followLatestEl = $('followLatest');
const auctionStats = $('auctionStats');
const auctionTable = $('auctionTable');
const auctionZbNote = $('auctionZbNote');
const ladderStats = $('ladderStats');
const ladderList = $('ladderList');
const chartModal = $('chartModal');
const modalTitle = $('modalTitle');
const modalClose = $('modalClose');
const chartIntra = $('chartIntra');
const chartKline = $('chartKline');
const boardTabs = $('boardTabs');
const boardType = $('boardType');
const boardSearch = $('boardSearch');
const boardBody = $('boardBody');
const boardSummary = $('boardSummary');
const strongSearch = $('strongSearch');
const strongStats = $('strongStats');
const strongBody = $('strongBody');

/* ---------- utils ---------- */
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function todayStr() { const d = new Date(); return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
function parseYmd(s) { return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)); }
function fmtYmd(d) { return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function toInput(s) { return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); }
const CN_WEEK = ['日', '一', '二', '三', '四', '五', '六'];
function fmtWeek(s) { return '周' + CN_WEEK[parseYmd(s).getDay()]; }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtPrice(v) { return v == null || isNaN(v) ? '—' : (v / 1000).toFixed(2); }
function fmtPct(v) { return v == null || isNaN(v) ? '—' : (+v).toFixed(2) + '%'; }
function fmtMoney(v) {
  if (v == null || isNaN(v)) return '—';
  const n = +v, abs = Math.abs(n);
  if (abs >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (abs >= 1e4) return (n / 1e4).toFixed(2) + '万';
  return n.toFixed(0);
}
function fmtTime(v) {
  if (v == null || v === '') return '—';
  const s = String(v).padStart(6, '0');
  return s.slice(0, 2) + ':' + s.slice(2, 4) + ':' + s.slice(4, 6);
}
function fmtZttj(z) { if (!z || !z.days) return '—'; return z.days + '天' + z.ct + '板'; }
function pclass(v) { return +v > 0 ? 'up' : (+v < 0 ? 'down' : ''); }

function lbcBadge(l) {
  if (!l) return '—';
  if (l >= 5) return '<span class="badge b5">' + l + '板</span>';
  if (l >= 3) return '<span class="badge b3">' + l + '板</span>';
  if (l >= 2) return '<span class="badge b2">' + l + '板</span>';
  return '<span class="badge b1">首板</span>';
}

function fbtBucket(t) {
  const v = +t || 0;
  for (let i = 0; i < TIME_BUCKETS.length; i++) {
    const b = TIME_BUCKETS[i];
    if (v >= b.from && v <= b.to) return i;
  }
  return -1;
}

function countBy(arr) {
  const m = {};
  arr.forEach((k) => { m[k] = (m[k] || 0) + 1; });
  return m;
}

/* ---------- JSONP ---------- */
let cbCounter = 0;
function jsonp(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const name = '__ztp_cb_' + (cbCounter++);
    const script = document.createElement('script');
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; cleanup(); reject(new Error('请求超时')); } }, timeout);
    function cleanup() { delete window[name]; if (script.parentNode) script.parentNode.removeChild(script); clearTimeout(timer); }
    window[name] = (payload) => { if (settled) return; settled = true; cleanup(); resolve(payload); };
    script.onerror = () => { if (settled) return; settled = true; cleanup(); reject(new Error('网络请求失败')); };
    script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'cb=' + name;
    document.head.appendChild(script);
  });
}

async function fetchPool(kind, date) {
  const sort = kind === 'dt' ? 'fund:asc' : 'fbt:asc';
  const list = [];
  let qdate = null;
  for (let page = 0; page < 20; page++) {
    const url = BASE + EP[kind] + '?ut=' + UT + '&dpt=' + DPT + '&Pageindex=' + page + '&pagesize=500&sort=' + encodeURIComponent(sort) + '&date=' + date;
    const res = await jsonp(url);
    const d = res && res.data;
    if (page === 0) qdate = d && d.qdate ? String(d.qdate) : null;
    if (!d || !Array.isArray(d.pool) || d.pool.length === 0) break;
    list.push.apply(list, d.pool);
    if (list.length >= (d.tc || 0)) break;
  }
  return { list: list, qdate: qdate };
}

async function fetchStrongPool(date) {
  const list = [];
  for (let page = 0; page < 20; page++) {
    const url = BASE + 'getTopicQSPool?ut=' + UT + '&dpt=' + DPT + '&Pageindex=' + page + '&pagesize=500&sort=' + encodeURIComponent('zdp:desc') + '&date=' + date;
    const res = await jsonp(url);
    const d = res && res.data;
    if (!d || !Array.isArray(d.pool) || d.pool.length === 0) break;
    list.push.apply(list, d.pool);
    if (list.length >= (d.tc || 0)) break;
  }
  return list;
}

/* ---------- loading / toast ---------- */
function setLoading(on) { loadingEl.classList.toggle('show', !!on); }
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

/* ---------- auto refresh scheduler ---------- */
function bjNow() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', hour12: false, hourCycle: 'h23',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = {};
  fmt.formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
  return { hour: (+parts.hour) % 24, minute: +parts.minute, second: +parts.second, weekday: parts.weekday };
}

function isTradingHours() {
  const p = bjNow();
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const t = p.hour * 60 + p.minute;
  return (t >= 555 && t <= 690) || (t >= 780 && t <= 905);
}

function refreshInterval() { return isTradingHours() ? 30 : 300; }

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const sec = refreshInterval();
  nextRefreshAt = Date.now() + sec * 1000;
  refreshTimer = setTimeout(() => { autoTick(); }, sec * 1000);
}

function updateStatus() {
  if (!state.auto) {
    liveDot.className = 'live-dot off';
    statusText.textContent = '自动刷新已暂停';
    countdownEl.textContent = '';
    return;
  }
  liveDot.className = 'live-dot on';
  const last = state.lastUpdate ? state.lastUpdate.toTimeString().slice(0, 8) : '—';
  statusText.textContent = '实时更新中 · 最后更新 ' + last;
  const remain = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  countdownEl.textContent = '下次刷新 ' + remain + 's';
}

async function autoTick() {
  if (!state.auto) return;
  try {
    if (state.followLatest && isOnLatest && !isTradingHours()) {
      const probe = await fetchPool('zt', '20991231');
      const qd = probe.qdate || state.date;
      if (Number(qd) > Number(state.date)) {
        latestDate = qd;
        await applyDay(qd, { silent: true, skipPrev: true });
      } else {
        await applyDay(state.date, { silent: true, skipPrev: true });
      }
    } else {
      await applyDay(state.date, { silent: true, skipPrev: true });
    }
    state.lastUpdate = new Date();
    updateStatus();
  } catch (e) {
    statusText.textContent = '更新失败：' + e.message;
  }
  if (state.auto) scheduleRefresh();
}

/* ---------- rendering ---------- */
function setDefaultSort(tab) { state.sort = tab === 'dt' ? { key: 'days', dir: -1 } : { key: 'fbt', dir: 1 }; }

function renderAll(opts) {
  opts = opts || {};
  $('cntZt').textContent = state.data.zt.length;
  $('cntZb').textContent = state.data.zb.length;
  $('cntDt').textContent = state.data.dt.length;
  renderCards();
  renderSummary();
  renderAuction();
  renderLadder();
  renderCharts();
  renderIndustryOptions();
  renderTable();
  renderBoards();
  renderStrongPool();
  if (!opts.skipPrev) refreshPrevDelta();
}

function renderCards() {
  const zt = state.data.zt, zb = state.data.zb, dt = state.data.dt;
  const n = zt.length;
  const maxLbc = n ? Math.max.apply(null, zt.map((s) => s.lbc || 0)) : 0;
  const lianban = zt.filter((s) => (s.lbc || 0) >= 2).length;
  const sealed = n + zb.length;
  const sealRate = sealed ? n / sealed * 100 : null;
  const zhaRate = sealed ? zb.length / sealed * 100 : null;
  const first = n - lianban;
  const jinRate = n ? lianban / n * 100 : null;

  let deltaHtml = '<span class="sub muted">较上一交易日 —</span>';
  if (state.prevZt != null) {
    const d = n - state.prevZt;
    if (d > 0) deltaHtml = '<span class="sub up">较上一交易日 +' + d + '</span>';
    else if (d < 0) deltaHtml = '<span class="sub down">较上一交易日 ' + d + '</span>';
    else deltaHtml = '<span class="sub muted">较上一交易日 平</span>';
  }

  cardsEl.innerHTML =
    '<div class="card"><div class="k">涨停家数</div><div class="v up">' + n + '</div>' + deltaHtml + '</div>' +
    '<div class="card"><div class="k">炸板家数</div><div class="v warn">' + zb.length + '</div><div class="sub muted">炸板率 ' + fmtPct(zhaRate) + '</div></div>' +
    '<div class="card"><div class="k">跌停家数</div><div class="v down">' + dt.length + '</div><div class="sub muted">风险观察</div></div>' +
    '<div class="card"><div class="k">最高连板</div><div class="v up">' + maxLbc + '板</div><div class="sub muted">连板股 ' + lianban + ' 家</div></div>' +
    '<div class="card"><div class="k">封板率</div><div class="v">' + fmtPct(sealRate) + '</div><div class="sub muted">' + n + '/' + sealed + ' 封住</div></div>' +
    '<div class="card"><div class="k">首板家数</div><div class="v">' + first + '</div><div class="sub muted">晋级率 ' + fmtPct(jinRate) + '</div></div>';
}

function renderSummary() {
  const zt = state.data.zt, zb = state.data.zb, dt = state.data.dt;
  if (!zt.length && !zb.length && !dt.length) {
    summaryEl.textContent = '该日期无涨停 / 炸板 / 跌停数据（可能为非交易日）。可点击“今天”返回最新交易日。';
    return;
  }
  const maxLbc = Math.max.apply(null, zt.map((s) => s.lbc || 0).concat([0]));
  const lianban = zt.filter((s) => (s.lbc || 0) >= 2).length;
  const sealed = zt.length + zb.length;
  const sealRate = sealed ? zt.length / sealed * 100 : 0;
  const zhaRate = sealed ? zb.length / sealed * 100 : 0;

  const tCounts = TIME_BUCKETS.map(() => 0);
  zt.forEach((s) => { const b = fbtBucket(s.fbt); if (b >= 0) tCounts[b]++; });
  let peakI = 0;
  tCounts.forEach((c, i) => { if (c > tCounts[peakI]) peakI = i; });

  const ind = countBy(zt.map((s) => s.hybk || '其他'));
  const top = Object.entries(ind).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => k + '（' + v + '家）').join('、') || '—';

  summaryEl.textContent =
    toInput(state.date) + ' ' + fmtWeek(state.date) + '：' +
    '涨停 ' + zt.length + ' 家，炸板 ' + zb.length + ' 家，跌停 ' + dt.length + ' 家。' +
    '最高连板 ' + maxLbc + ' 板，连板股 ' + lianban + ' 家。' +
    '封板率 ' + sealRate.toFixed(1) + '%（' + zt.length + '/' + sealed + '），炸板率 ' + zhaRate.toFixed(1) + '%。' +
    '封板集中在 ' + TIME_BUCKETS[peakI].label + '（' + tCounts[peakI] + ' 家）。' +
    '热点行业：' + top + '。' +
    '数据仅供复盘参考，不构成投资建议。';
}

/* ---------- auction & ladder ---------- */
function renderAuction() {
  const zt = state.data.zt, zb = state.data.zb;
  const jy = zt.filter((s) => s.fbt != null && +s.fbt <= 92500);
  const jyZb = zb.filter((s) => s.fbt != null && +s.fbt <= 92500);
  const pct = zt.length ? jy.length / zt.length * 100 : 0;
  const fundSum = jy.reduce((a, s) => a + (+s.fund || 0), 0);

  auctionStats.innerHTML =
    '<span class="stat-chip">竞价涨停 <b>' + jy.length + '</b> 家</span>' +
    '<span class="stat-chip">占全部涨停 <b>' + pct.toFixed(1) + '%</b></span>' +
    '<span class="stat-chip">竞价封单合计 <b>' + fmtMoney(fundSum) + '</b></span>' +
    '<span class="stat-chip">竞价涨停后炸板 <b class="warn">' + jyZb.length + '</b> 家</span>';

  if (!jy.length) {
    auctionTable.innerHTML = '<div class="empty-note">今日暂无竞价涨停（集合竞价阶段未封板或数据尚未生成）</div>';
  } else {
    const head = '<thead><tr><th class="l">代码</th><th class="l">名称</th><th class="num">现价</th><th class="num">涨跌幅</th><th class="num">连板</th><th class="num">封单资金</th><th class="l">行业</th></tr></thead>';
    const body = '<tbody>' + jy.map((s) =>
      '<tr><td class="l code">' + s.c + '</td>' +
      '<td class="l name">' + esc(s.n) + '</td>' +
      '<td class="num ' + pclass(s.zdp) + '">' + fmtPrice(s.p) + '</td>' +
      '<td class="num ' + pclass(s.zdp) + '">' + fmtPct(s.zdp) + '</td>' +
      '<td class="num">' + lbcBadge(s.lbc) + '</td>' +
      '<td class="num">' + fmtMoney(s.fund) + '</td>' +
      '<td class="l muted">' + esc(s.hybk || '—') + '</td></tr>'
    ).join('') + '</tbody>';
    auctionTable.innerHTML = '<table>' + head + body + '</table>';
  }

  auctionZbNote.innerHTML = jyZb.length
    ? '竞价涨停后炸板：' + jyZb.map((s) => esc(s.n) + '(' + s.c + ')').join('、')
    : '';
}

function renderLadder() {
  const zt = state.data.zt;
  const ladder = {};
  zt.forEach((s) => { const l = Math.max(1, s.lbc || 0); (ladder[l] = ladder[l] || []).push(s); });
  const heights = Object.keys(ladder).map(Number).filter((l) => l >= 2).sort((a, b) => b - a);
  const lianban = zt.filter((s) => (s.lbc || 0) >= 2).length;
  const maxLbc = heights[0] || 0;
  const prev = state.prevZt;
  let jin = '—';
  if (prev) jin = lianban + '/' + prev + '（' + (lianban / prev * 100).toFixed(1) + '%）';
  ladderStats.textContent = '最高 ' + maxLbc + ' 板 · 连板 ' + lianban + ' 家 · 昨日涨停晋级 ' + jin;

  if (!zt.length) {
    ladderList.innerHTML = '<div class="muted first-note">暂无涨停数据</div>';
    return;
  }

  let html = '';
  heights.forEach((h) => {
    const stocks = (ladder[h] || []).slice().sort((a, b) => (+b.fund || 0) - (+a.fund || 0));
    const chips = stocks.map((s) =>
      '<span class="stock-chip" data-code="' + esc(s.c) + '" title="' + esc(s.n) + ' 封单 ' + fmtMoney(s.fund) + ' · ' + esc(s.hybk || '') + '">' +
      esc(s.n) + '<span class="c">' + s.c + '</span></span>'
    ).join('');
    const tagCls = h >= 5 ? 'tag-5' : (h >= 3 ? 'tag-3' : 'tag-2');
    html += '<div class="ladder-row"><div class="ladder-tag ' + tagCls + '">' + h + '板</div><div class="ladder-stocks">' + chips + '</div></div>';
  });
  const firstN = (ladder[1] || []).length;
  html += '<div class="ladder-row"><div class="ladder-tag tag-1">首板</div><div class="ladder-stocks"><span class="muted first-note">' + firstN + ' 家（见下方涨停板表格）</span></div></div>';
  ladderList.innerHTML = html;
}

/* ---------- stock chart modal ---------- */
let modalStock = null;
let modalTimer = null;

function secidOf(s) { return s.m + '.' + s.c; }

async function fetchTrend(s) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=' + secidOf(s) +
    '&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=1';
  const res = await jsonp(url);
  const d = res && res.data;
  if (!d || !Array.isArray(d.trends)) throw new Error('无分时数据');
  const preClose = parseFloat(d.preClose);
  const points = d.trends.map(function (it) {
    const p = String(it).split(',');
    return { t: p[0].split(' ')[1], price: parseFloat(p[2]) };
  }).filter(function (p) { return isFinite(p.price); });
  return { preClose: preClose, points: points };
}

async function fetchKline(s, date) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secidOf(s) +
    '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=0&end=' + date + '&lmt=90';
  const res = await jsonp(url);
  const d = res && res.data;
  if (!d || !Array.isArray(d.klines)) throw new Error('无K线数据');
  return d.klines.map(function (it) {
    const p = String(it).split(',');
    return { date: p[0], o: parseFloat(p[1]), c: parseFloat(p[2]), h: parseFloat(p[3]), l: parseFloat(p[4]) };
  }).filter(function (x) { return isFinite(x.c); }).slice(-60);
}

function drawNote(canvas, text) {
  const g = setupCanvas(canvas, 250);
  g.ctx.clearRect(0, 0, g.W, g.H);
  g.ctx.fillStyle = '#8b949e';
  g.ctx.font = '12px sans-serif';
  g.ctx.textAlign = 'center';
  g.ctx.fillText(text, g.W / 2, g.H / 2);
}

function drawIntraday(canvas, preClose, points) {
  const H = 250;
  const g = setupCanvas(canvas, H);
  const ctx = g.ctx, W = g.W;
  ctx.clearRect(0, 0, W, H);
  if (!points.length) { emptyChart(ctx, W, H); return; }
  const padL = 48, padR = 12, padT = 12, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  let minP = preClose, maxP = preClose;
  points.forEach(function (p) { if (p.price < minP) minP = p.price; if (p.price > maxP) maxP = p.price; });
  if (maxP === minP) { maxP += 0.01; minP -= 0.01; }
  let range = maxP - minP;
  minP -= range * 0.06; maxP += range * 0.06;
  range = maxP - minP;
  function yOf(v) { return padT + plotH * (maxP - v) / range; }

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = '#8b949e';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  for (let i = 0; i <= 4; i++) {
    const v = maxP - range * i / 4;
    const y = yOf(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(v.toFixed(2), 4, y + 4);
  }

  const ypc = yOf(preClose);
  ctx.strokeStyle = '#9aa4b2';
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(padL, ypc); ctx.lineTo(W - padR, ypc); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillText('昨收 ' + preClose.toFixed(2), 4, ypc - 3);

  const n = points.length;
  const last = points[n - 1].price;
  const color = last >= preClose ? '#ff4d4f' : '#16c784';
  const xs = points.map(function (p, i) { return padL + plotW * i / Math.max(1, n - 1); });
  ctx.beginPath();
  points.forEach(function (p, i) {
    const x = xs[i], y = yOf(p.price);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(xs[0], yOf(points[0].price));
  for (let i = 1; i < n; i++) ctx.lineTo(xs[i], yOf(points[i].price));
  ctx.lineTo(xs[n - 1], ypc);
  ctx.lineTo(xs[0], ypc);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, color + '2e');
  grad.addColorStop(1, color + '00');
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.fillStyle = '#8b949e';
  ctx.textAlign = 'center';
  [[0, '09:30'], [0.25, '10:30'], [0.5, '11:30/13:00'], [0.75, '14:00'], [1, '15:00']].forEach(function (lb) {
    ctx.fillText(lb[1], padL + plotW * lb[0], H - 6);
  });
}

function drawKlineChart(canvas, kl) {
  const H = 250;
  const g = setupCanvas(canvas, H);
  const ctx = g.ctx, W = g.W;
  ctx.clearRect(0, 0, W, H);
  if (!kl.length) { emptyChart(ctx, W, H); return; }
  const padL = 48, padR = 12, padT = 12, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  let minL = Infinity, maxH = -Infinity;
  kl.forEach(function (k) { if (k.l < minL) minL = k.l; if (k.h > maxH) maxH = k.h; });
  if (!isFinite(minL) || !isFinite(maxH)) { emptyChart(ctx, W, H); return; }
  let range = maxH - minL || 1;
  minL -= range * 0.06; maxH += range * 0.06;
  range = maxH - minL;
  function yOf(v) { return padT + plotH * (maxH - v) / range; }

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = '#8b949e';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  for (let i = 0; i <= 4; i++) {
    const v = maxH - range * i / 4;
    const y = yOf(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(v.toFixed(2), 4, y + 4);
  }

  const n = kl.length;
  const step = plotW / n;
  const bw = Math.max(2, Math.min(11, step * 0.7));
  kl.forEach(function (k, i) {
    const x = padL + step * (i + 0.5);
    const up = k.c >= k.o;
    const color = up ? '#ff4d4f' : '#16c784';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yOf(k.h)); ctx.lineTo(x, yOf(k.l)); ctx.stroke();
    const yTop = yOf(Math.max(k.o, k.c));
    const yBot = yOf(Math.min(k.o, k.c));
    const bh = Math.max(1, yBot - yTop);
    ctx.fillStyle = color;
    roundRect(ctx, x - bw / 2, yTop, bw, bh, 1);
    ctx.fill();
  });

  ctx.fillStyle = '#8b949e';
  ctx.textAlign = 'center';
  [0, Math.floor((n - 1) / 2), n - 1].forEach(function (i) {
    ctx.fillText(String(kl[i].date).slice(5), padL + step * (i + 0.5), H - 6);
  });
}

async function refreshModalChart() {
  if (!modalStock) return;
  drawNote(chartIntra, '加载中…');
  drawNote(chartKline, '加载中…');
  const isLatest = (state.date === latestDate);
  try {
    const klP = fetchKline(modalStock, state.date);
    if (isLatest) {
      const [tr, kl] = await Promise.all([fetchTrend(modalStock), klP]);
      drawIntraday(chartIntra, tr.preClose, tr.points);
      drawKlineChart(chartKline, kl);
    } else {
      const kl = await klP;
      drawNote(chartIntra, '历史日期暂无分时数据');
      drawKlineChart(chartKline, kl);
    }
  } catch (e) {
    drawNote(chartIntra, '加载失败');
    drawNote(chartKline, '加载失败');
  }
}

function openChart(s) {
  modalStock = s;
  chartModal.classList.add('show');
  modalTitle.innerHTML = '<span>' + esc(s.n) + '</span><span class="code">' + s.c + '</span>' + (s.zdp != null ? '<span class="' + pclass(s.zdp) + '">' + fmtPct(s.zdp) + '</span>' : '');
  requestAnimationFrame(function () { refreshModalChart(); });
  if (modalTimer) clearInterval(modalTimer);
  modalTimer = setInterval(function () { refreshModalChart(); }, 30000);
}

function closeChart() {
  chartModal.classList.remove('show');
  modalStock = null;
  if (modalTimer) { clearInterval(modalTimer); modalTimer = null; }
}

/* ---------- board sector panel ---------- */
const boardState = { mode: 'featured', type: '2', list: [], currentKey: null, sort: { key: 'strength', dir: -1 } };
const boardCache = { '1': [], '2': [], '3': [] };
const boardFetching = {};

async function fetchBoardsPage(type, pn) {
  const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=' + pn + '&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:' + type + '+f:!50&fields=f2,f3,f12,f14,f20,f25,f62,f104,f105,f128,f136';
  const res = await jsonp(url, 8000);
  const d = res && res.data;
  return (d && Array.isArray(d.diff)) ? { total: d.total || 0, diff: d.diff } : null;
}

async function fetchBoards(type) {
  let first = null;
  try { first = await fetchBoardsPage(type, 1); }
  catch (e) { try { first = await fetchBoardsPage(type, 1); } catch (e2) { throw e2; } }
  if (!first || !Array.isArray(first.diff) || !first.diff.length) return [];
  const total = first.total || first.diff.length;
  const pages = Math.min(Math.ceil(total / 100), 10);
  const jobs = [];
  for (let pn = 2; pn <= pages; pn++) jobs.push(fetchBoardsPage(type, pn));
  const settled = await Promise.allSettled(jobs);
  const list = first.diff.slice();
  settled.forEach(function (r) {
    if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.diff)) list.push.apply(list, r.value.diff);
  });
  return list;
}

function fetchBoardsCached(type) {
  if (!boardFetching[type]) {
    boardFetching[type] = fetchBoards(type).then(function (list) {
      boardCache[type] = list;
      return list;
    }).finally(function () { delete boardFetching[type]; });
  }
  return boardFetching[type];
}

function ztHybkList() {
  return state.data.zt.map(function (s) { return s.hybk || ''; }).filter(Boolean);
}

function ztCountFor(name, hybkList) {
  let c = 0;
  for (let i = 0; i < hybkList.length; i++) {
    if (name.indexOf(hybkList[i]) === 0) c++;
  }
  return c;
}

function computeStrength(b, zc) {
  const pct = +b.f3 || 0;
  const lead = +b.f136 || 0;
  return Math.round((zc * 100 + pct * 10 + lead) * 10) / 10;
}

function decorateBoards(list, type) {
  const hybkList = ztHybkList();
  return list.map(function (b) {
    const zc = type === '2' ? ztCountFor(b.f14 || '', hybkList) : null;
    b._zc = zc;
    b._strength = computeStrength(b, zc || 0);
    return b;
  });
}

function fmtSignedPct(v) {
  if (v == null || isNaN(v)) return '—';
  const n = +v;
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtSignedMoney(v) {
  if (v == null || isNaN(v)) return '—';
  const n = +v, abs = Math.abs(n);
  let s;
  if (abs >= 1e8) s = (abs / 1e8).toFixed(2) + '亿';
  else if (abs >= 1e4) s = (abs / 1e4).toFixed(2) + '万';
  else s = abs.toFixed(0);
  return (n > 0 ? '+' : (n < 0 ? '-' : '')) + s;
}

function udRatio(up, down) {
  const u = +up || 0, d = +down || 0;
  const t = u + d;
  return t ? Math.round(u / t * 100) : 0;
}

function renderBoardSummary(list) {
  if (!list.length) { boardSummary.innerHTML = ''; return; }
  const up = list.filter(function (b) { return (+b.f3 || 0) > 0; }).length;
  const down = list.filter(function (b) { return (+b.f3 || 0) < 0; }).length;
  const lead = list[0];
  let lag = list[0];
  list.forEach(function (b) { if ((+b.f3 || 0) < (+lag.f3 || 0)) lag = b; });
  boardSummary.innerHTML =
    '上涨板块 <b class="up">' + up + '</b> 家　下跌板块 <b class="down">' + down + '</b> 家　|　' +
    '领涨 <span class="up">' + esc(lead.f14) + ' ' + fmtSignedPct(lead.f3) + '</span>　|　' +
    '领跌 <span class="down">' + esc(lag.f14) + ' ' + fmtSignedPct(lag.f3) + '</span>';
}

function renderFeaturedBoards(list) {
  const rows = decorateBoards(list, '2').sort(function (a, b) { return b._strength - a._strength; }).slice(0, 15);
  renderBoardSummary(list);
  if (!rows.length) { boardBody.innerHTML = '<div class="empty-note">暂无板块数据</div>'; return; }
  boardBody.innerHTML = rows.map(function (b, i) {
    const r = i + 1;
    const rankCls = r === 1 ? 'rank-1' : (r === 2 ? 'rank-2' : (r === 3 ? 'rank-3' : ''));
    const pctCls = (+b.f3 || 0) > 0 ? 'up' : ((+b.f3 || 0) < 0 ? 'down' : '');
    const leadCls = (+b.f136 || 0) >= 0 ? 'up' : 'down';
    const ratio = udRatio(b.f104, b.f105);
    return '<div class="hot-row"><span class="hot-rank ' + rankCls + '">' + r + '</span>' +
      '<div class="hot-main">' +
        '<div class="hot-name">' + esc(b.f14) + (b._zc ? ' <span class="zt-badge">涨停 ' + b._zc + '</span>' : '') + '</div>' +
        '<div class="hot-lead">领涨 ' + esc(b.f128 || '—') + (b.f136 != null ? ' <span class="' + leadCls + '">' + fmtSignedPct(b.f136) + '</span>' : '') + '</div>' +
        '<div class="ratio-bar"><div class="ratio-up" style="width:' + ratio + '%"></div></div>' +
      '</div>' +
      '<div class="hot-pct ' + pctCls + '">' + fmtSignedPct(b.f3) + '</div></div>';
  }).join('');
}

function renderBoardTable(list) {
  boardState.list = decorateBoards(list, boardState.type);
  renderBoardSummary(list);
  const q = boardSearch.value.trim().toLowerCase();
  let rows = boardState.list.slice();
  if (q) rows = rows.filter(function (b) { return String(b.f14 || '').toLowerCase().indexOf(q) >= 0; });
  const key = boardState.sort.key, dir = boardState.sort.dir;
  rows.sort(function (a, b) {
    if (key === 'strength') return (a._strength - b._strength) * dir;
    if (key === 'f14') return String(a.f14 || '').localeCompare(String(b.f14 || ''), 'zh') * dir;
    return ((+a[key] || 0) - (+b[key] || 0)) * dir;
  });
  if (!rows.length) { boardBody.innerHTML = '<div class="empty-note">无匹配板块</div>'; return; }
  const arrow = function (k) { return boardState.sort.key === k ? (boardState.sort.dir > 0 ? ' ▲' : ' ▼') : ''; };
  const head = '<thead><tr>' +
    '<th class="num sortable" data-bk="strength">强度' + arrow('strength') + '</th>' +
    '<th class="l sortable" data-bk="f14">板块名称' + arrow('f14') + '</th>' +
    '<th class="num sortable" data-bk="f3">涨跌幅' + arrow('f3') + '</th>' +
    '<th class="num sortable" data-bk="f104">上涨' + arrow('f104') + '</th>' +
    '<th class="num sortable" data-bk="f105">下跌' + arrow('f105') + '</th>' +
    '<th class="l">领涨股</th>' +
    '<th class="num sortable" data-bk="f62">主力净流入' + arrow('f62') + '</th>' +
    '<th class="num sortable" data-bk="f25">成交额' + arrow('f25') + '</th>' +
    '<th class="num sortable" data-bk="f20">总市值' + arrow('f20') + '</th>' +
    '</tr></thead>';
  const body = '<tbody>' + rows.map(function (b) {
    return '<tr><td class="num up">' + b._strength + '</td>' +
      '<td class="l name">' + esc(b.f14) + '<span class="board-code">' + esc(b.f12) + '</span>' + (b._zc ? ' <span class="zt-badge">涨停' + b._zc + '</span>' : '') + '</td>' +
      '<td class="num"><span class="pct-pill ' + pclass(b.f3) + '">' + fmtSignedPct(b.f3) + '</span></td>' +
      '<td class="num up">' + (b.f104 || 0) + '</td>' +
      '<td class="num down">' + (b.f105 || 0) + '</td>' +
      '<td class="l">' + esc(b.f128 || '—') + (b.f136 != null ? ' <span class="muted">' + fmtSignedPct(b.f136) + '</span>' : '') + '</td>' +
      '<td class="num ' + pclass(b.f62) + '">' + fmtSignedMoney(b.f62) + '</td>' +
      '<td class="num">' + fmtMoney(b.f25) + '</td>' +
      '<td class="num">' + fmtMoney(b.f20) + '</td></tr>';
  }).join('') + '</tbody>';
  boardBody.innerHTML = '<div class="board-table-wrap"><table>' + head + body + '</table></div>';
}

function renderBoards() {
  const mode = boardState.mode;
  const type = boardState.type;
  const key = mode === 'featured' ? 'featured' : 'all-' + type;
  const targetType = mode === 'featured' ? '2' : type;
  const cached = boardCache[targetType];
  if (boardState.currentKey !== key) {
    boardState.currentKey = key;
    if (cached && cached.length) {
      if (mode === 'featured') renderFeaturedBoards(cached);
      else renderBoardTable(cached);
    } else {
      boardBody.innerHTML = '<div class="empty-note">加载中…</div>';
    }
  }
  fetchBoardsCached(targetType).then(function (list) {
    if (boardState.currentKey !== key) return;
    if (list && list.length) {
      if (mode === 'featured') renderFeaturedBoards(list);
      else renderBoardTable(list);
    } else if (!(boardCache[targetType] && boardCache[targetType].length)) {
      boardBody.innerHTML = '<div class="empty-note">暂无板块数据</div>';
    }
  }).catch(function () {
    if (boardState.currentKey !== key) return;
    if (boardCache[targetType] && boardCache[targetType].length) {
      toast('板块数据更新失败，显示最近一次数据');
    } else {
      boardBody.innerHTML = '<div class="empty-note">加载失败，请稍后重试</div>';
    }
  });
}

/* ---------- strong stock pool ---------- */
const strongState = { search: '', sort: { key: 'zdp', dir: -1 } };

function ccLabel(cc) {
  if (cc === 3) return '60日新高且近期多次涨停';
  if (cc === 2) return '近期多次涨停';
  if (cc === 1) return '60日新高';
  return '—';
}

function ccBadge(cc) {
  const cls = cc === 3 ? 'cc3' : (cc === 2 ? 'cc2' : (cc === 1 ? 'cc1' : ''));
  return '<span class="cc-badge ' + cls + '">' + ccLabel(cc) + '</span>';
}

function strongSortVal(s, key) {
  if (key === 'n') return String(s.n || '');
  if (key === 'hybk') return String(s.hybk || '');
  if (key === 'zttj') return s.zttj ? s.zttj.ct * 100 + s.zttj.days : -1;
  return +(s[key]) || 0;
}

function getStrongRows() {
  let rows = state.data.qs.slice();
  const q = strongState.search.trim().toLowerCase();
  if (q) rows = rows.filter((s) => String(s.c).includes(q) || String(s.n || '').toLowerCase().includes(q) || String(s.hybk || '').toLowerCase().includes(q));
  const col = COLS.qs.find((c) => c.k === strongState.sort.key);
  const key = col && col.sort;
  if (key) {
    const dir = strongState.sort.dir;
    rows.sort((a, b) => {
      let va = strongSortVal(a, key), vb = strongSortVal(b, key);
      if (key === 'n' || key === 'hybk') return String(va).localeCompare(String(vb), 'zh') * dir;
      return (va - vb) * dir;
    });
  }
  return rows;
}

function strongCell(k, s) {
  switch (k) {
    case 'code': return '<span class="code">' + esc(s.c) + '</span>';
    case 'name': return '<a class="name name-link" href="javascript:void(0)">' + esc(s.n) + '</a>';
    case 'price': return '<span class="' + pclass(s.zdp) + '">' + fmtPrice(s.p) + '</span>';
    case 'zdp': return '<span class="' + pclass(s.zdp) + '">' + fmtPct(s.zdp) + '</span>';
    case 'ztp': return '<span class="muted">' + fmtPrice(s.ztp) + '</span>';
    case 'hs': return fmtPct(s.hs);
    case 'lb': return s.lb == null ? '—' : (+s.lb).toFixed(2);
    case 'zs': return '<span class="' + pclass(s.zs) + '">' + fmtPct(s.zs) + '</span>';
    case 'nh': return s.nh == 1 ? '<span class="up">是</span>' : '<span class="muted">—</span>';
    case 'zttj': return '<span class="muted">' + fmtZttj(s.zttj) + '</span>';
    case 'cc': return ccBadge(s.cc);
    case 'amount': return fmtMoney(s.amount);
    case 'ltsz': return fmtMoney(s.ltsz);
    case 'hybk': return '<span class="muted">' + esc(s.hybk || '—') + '</span>';
  }
  return '';
}

function renderStrongPool() {
  const list = state.data.qs;
  const ztCodes = {};
  state.data.zt.forEach((s) => { ztCodes[s.c] = true; });
  const ztToday = list.filter((s) => ztCodes[s.c]).length;
  const nhCount = list.filter((s) => s.nh == 1).length;
  const multiCount = list.filter((s) => s.cc === 2 || s.cc === 3).length;
  const lbSum = list.reduce((a, s) => a + (+s.lb || 0), 0);
  const avgLb = list.length ? lbSum / list.length : 0;

  strongStats.innerHTML =
    '<span class="stat-chip">池内 <b>' + list.length + '</b> 家</span>' +
    '<span class="stat-chip">今日已涨停 <b>' + ztToday + '</b> 家</span>' +
    '<span class="stat-chip">60日新高 <b>' + nhCount + '</b> 家</span>' +
    '<span class="stat-chip">近期多次涨停 <b>' + multiCount + '</b> 家</span>' +
    '<span class="stat-chip">平均量比 <b>' + avgLb.toFixed(2) + '</b></span>';

  const rows = getStrongRows();
  if (!rows.length) {
    strongBody.innerHTML = '<div class="empty-note">' + (list.length ? '无匹配股票' : '暂无强势股池数据（可能为非交易日或数据尚未生成）') + '</div>';
    return;
  }

  const cols = COLS.qs;
  const arrow = function (k) { return strongState.sort.key === k ? (strongState.sort.dir > 0 ? ' ▲' : ' ▼') : ''; };
  const head = '<thead><tr>' + cols.map((c) => {
    if (c.k === 'idx') return '<th class="c">#</th>';
    const cls = (c.num ? 'num ' : '') + (LEFT_KEYS.has(c.k) ? 'l' : '') + (c.sort ? ' sortable' : '');
    return '<th data-k="' + c.k + '" class="' + cls.trim() + '">' + c.label + (c.sort ? arrow(c.k) : '') + '</th>';
  }).join('') + '</tr></thead>';

  const body = '<tbody>' + rows.map((s, i) => {
    const cells = cols.map((c) => {
      if (c.k === 'idx') return '<td class="idx">' + (i + 1) + '</td>';
      const cls = (c.num ? 'num ' : '') + (LEFT_KEYS.has(c.k) ? 'l' : '');
      return '<td class="' + cls.trim() + '">' + strongCell(c.k, s) + '</td>';
    });
    return '<tr data-code="' + s.c + '" data-m="' + s.m + '" data-name="' + esc(s.n) + '">' + cells.join('') + '</tr>';
  }).join('') + '</tbody>';

  strongBody.innerHTML = '<div class="board-table-wrap strong-table-wrap"><table>' + head + body + '</table></div>';
}

function exportStrongCSV() {
  const rows = getStrongRows();
  if (!rows.length) { toast('没有可导出的强势股池数据'); return; }
  const cols = COLS.qs;
  const header = cols.map((c) => c.label).join(',');
  const lines = rows.map((s, i) => cols.map((c) => {
    let v = '';
    if (c.k === 'idx') v = i + 1;
    else if (c.k === 'code') v = s.c;
    else if (c.k === 'name') v = s.n;
    else if (c.k === 'price') v = fmtPrice(s.p);
    else if (c.k === 'zdp') v = fmtPct(s.zdp);
    else if (c.k === 'ztp') v = fmtPrice(s.ztp);
    else if (c.k === 'hs') v = fmtPct(s.hs);
    else if (c.k === 'lb') v = s.lb;
    else if (c.k === 'zs') v = fmtPct(s.zs);
    else if (c.k === 'nh') v = s.nh == 1 ? '是' : '否';
    else if (c.k === 'zttj') v = fmtZttj(s.zttj);
    else if (c.k === 'cc') v = ccLabel(s.cc);
    else if (c.k === 'amount') v = s.amount;
    else if (c.k === 'ltsz') v = s.ltsz;
    else if (c.k === 'hybk') v = s.hybk;
    return csvQuote(v);
  }).join(','));
  const csv = '\uFEFF' + header + '\n' + lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '强势股池_' + state.date + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

/* ---------- charts ---------- */
function setupCanvas(canvas, H) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 560;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx: ctx, W: W, H: H };
}

function roundRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y); ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr); ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h); ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr); ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function emptyChart(ctx, W, H) {
  ctx.fillStyle = '#8b949e';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('暂无数据', W / 2, H / 2);
}

function drawVBar(canvas, labels, values, opts) {
  opts = opts || {};
  const H = opts.height || 230;
  const g = setupCanvas(canvas, H);
  const ctx = g.ctx, W = g.W;
  ctx.clearRect(0, 0, W, H);
  if (!labels.length || values.every((v) => !v)) { emptyChart(ctx, W, H); return; }
  const padL = 34, padR = 12, padT = 18, padB = 46;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(1, Math.max.apply(null, values));

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = '#8b949e';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const y = padT + plotH - plotH * i / steps;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(String(Math.round(max * i / steps)), padL - 6, y + 4);
  }

  const n = labels.length;
  const bw = Math.min(42, plotW / n * 0.6);
  labels.forEach((lab, i) => {
    const x = padL + plotW * (i + 0.5) / n;
    const h = plotH * values[i] / max;
    const y = padT + plotH - h;
    const grad = ctx.createLinearGradient(0, y, 0, padT + plotH);
    grad.addColorStop(0, opts.color || '#ff4d4f');
    grad.addColorStop(1, opts.color2 || '#8f1f20');
    ctx.fillStyle = grad;
    roundRect(ctx, x - bw / 2, y, bw, Math.max(h, 0), 3);
    ctx.fill();
    if (values[i] > 0) {
      ctx.fillStyle = '#e6edf3'; ctx.textAlign = 'center'; ctx.font = '11px sans-serif';
      ctx.fillText(String(values[i]), x, y - 4);
    }
    ctx.save();
    ctx.translate(x, padT + plotH + 10);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = '#8b949e'; ctx.textAlign = 'right'; ctx.font = '11px sans-serif';
    ctx.fillText(lab, 0, 0);
    ctx.restore();
  });
}

function drawHBar(canvas, labels, values, opts) {
  opts = opts || {};
  const rowH = 26;
  const H = Math.max(180, labels.length * rowH + 26);
  const g = setupCanvas(canvas, H);
  const ctx = g.ctx, W = g.W;
  ctx.clearRect(0, 0, W, H);
  if (!labels.length || values.every((v) => !v)) { emptyChart(ctx, W, H); return; }

  ctx.font = '12px sans-serif';
  let labelW = 0;
  labels.forEach((l) => { labelW = Math.max(labelW, ctx.measureText(l).width); });
  const padL = labelW + 14, padR = 40;
  const plotW = W - padL - padR;
  const max = Math.max(1, Math.max.apply(null, values));

  labels.forEach((lab, i) => {
    const y = i * rowH + 6;
    ctx.fillStyle = '#c9d1d9'; ctx.textAlign = 'right';
    ctx.fillText(lab, padL - 8, y + 13);
    const w = plotW * values[i] / max;
    const grad = ctx.createLinearGradient(padL, 0, padL + w, 0);
    grad.addColorStop(0, '#ff7a45'); grad.addColorStop(1, '#ff4d4f');
    ctx.fillStyle = grad;
    roundRect(ctx, padL, y + 3, Math.max(w, 1), rowH - 8, 3);
    ctx.fill();
    ctx.fillStyle = '#e6edf3'; ctx.textAlign = 'left';
    ctx.fillText(String(values[i]), padL + w + 6, y + 13);
  });
}

function renderCharts() {
  const zt = state.data.zt;

  const lbBuckets = [
    { label: '首板', lo: 1, hi: 1 }, { label: '2板', lo: 2, hi: 2 },
    { label: '3板', lo: 3, hi: 3 }, { label: '4板', lo: 4, hi: 4 },
    { label: '5板', lo: 5, hi: 5 }, { label: '6板+', lo: 6, hi: Infinity }
  ];
  const lbCounts = lbBuckets.map((b) => zt.filter((s) => { const l = s.lbc || 0; return l >= b.lo && l <= b.hi; }).length);
  drawVBar(chartLb, lbBuckets.map((b) => b.label), lbCounts);

  const tCounts = TIME_BUCKETS.map(() => 0);
  zt.forEach((s) => { const b = fbtBucket(s.fbt); if (b >= 0) tCounts[b]++; });
  drawVBar(chartTime, TIME_BUCKETS.map((b) => b.label), tCounts, { height: 230 });

  const ind = countBy(zt.map((s) => s.hybk || '其他'));
  const entries = Object.entries(ind).sort((a, b) => b[1] - a[1]).slice(0, 10);
  drawHBar(chartInd, entries.map((e) => e[0]), entries.map((e) => e[1]));
}

/* ---------- table ---------- */
function renderHead() {
  const cols = COLS[state.tab];
  theadEl.innerHTML = '<tr>' + cols.map((c) => {
    let arrow = '';
    if (c.sort && state.sort.key === c.k) arrow = state.sort.dir > 0 ? ' ▲' : ' ▼';
    const cls = (c.num ? 'num ' : '') + (LEFT_KEYS.has(c.k) ? 'l ' : (c.k === 'idx' ? 'c ' : '')) + (c.sort ? 'sortable' : '');
    return '<th data-k="' + c.k + '" class="' + cls.trim() + '">' + c.label + arrow + '</th>';
  }).join('') + '</tr>';
}

function cellHTML(k, s) {
  switch (k) {
    case 'code': return '<span class="code">' + esc(s.c) + '</span>';
    case 'name': return '<a class="name name-link" href="javascript:void(0)">' + esc(s.n) + '</a>';
    case 'price': return '<span class="' + pclass(s.zdp) + '">' + fmtPrice(s.p) + '</span>';
    case 'zdp': return '<span class="' + pclass(s.zdp) + '">' + fmtPct(s.zdp) + '</span>';
    case 'lbc': return lbcBadge(s.lbc);
    case 'days': return s.days ? s.days + '天' : '—';
    case 'zttj': return '<span class="muted">' + fmtZttj(s.zttj) + '</span>';
    case 'fbt': return '<span class="time">' + fmtTime(s.fbt) + '</span>';
    case 'lbt': return '<span class="time">' + fmtTime(s.lbt) + '</span>';
    case 'zbc': return s.zbc > 0 ? '<span class="warn">' + s.zbc + '</span>' : '0';
    case 'fund': return fmtMoney(s.fund);
    case 'hs': return fmtPct(s.hs);
    case 'amount': return fmtMoney(s.amount);
    case 'zf': return fmtPct(s.zf);
    case 'hybk': return '<span class="muted">' + esc(s.hybk || '—') + '</span>';
  }
  return '';
}

function sortVal(s, key) {
  if (key === 'n') return String(s.n || '');
  if (key === 'hybk') return String(s.hybk || '');
  if (key === 'zttj') return s.zttj ? s.zttj.ct * 100 + s.zttj.days : -1;
  return +(s[key]) || 0;
}

function getRows() {
  let rows = state.data[state.tab].slice();
  const f = state.filters;
  if (f.search) {
    const q = f.search.trim().toLowerCase();
    rows = rows.filter((s) => String(s.c).includes(q) || String(s.n || '').toLowerCase().includes(q));
  }
  if (state.tab === 'zt' && f.lbc !== 'all') {
    if (f.lbc === '5p') rows = rows.filter((s) => (s.lbc || 0) >= 6);
    else rows = rows.filter((s) => (s.lbc || 0) === +f.lbc);
  }
  if (f.industry) rows = rows.filter((s) => (s.hybk || '') === f.industry);

  const col = COLS[state.tab].find((c) => c.k === state.sort.key);
  const key = col && col.sort;
  if (key) {
    const dir = state.sort.dir;
    rows.sort((a, b) => {
      let va = sortVal(a, key), vb = sortVal(b, key);
      if (key === 'n' || key === 'hybk') return String(va).localeCompare(String(vb), 'zh') * dir;
      return (va - vb) * dir;
    });
  }
  return rows;
}

function renderTable() {
  renderHead();
  const cols = COLS[state.tab];
  const rows = getRows();
  if (!rows.length) {
    tbodyEl.innerHTML = '<tr><td colspan="' + cols.length + '" class="empty">无匹配数据</td></tr>';
    tableFootEl.textContent = '';
    return;
  }
  tbodyEl.innerHTML = rows.map((s, i) => {
    const cells = cols.map((c) => {
      if (c.k === 'idx') return '<td class="idx">' + (i + 1) + '</td>';
      const cls = (c.num ? 'num ' : '') + (LEFT_KEYS.has(c.k) ? 'l' : '');
      return '<td data-k="' + c.k + '" class="' + cls.trim() + '">' + cellHTML(c.k, s) + '</td>';
    });
    return '<tr data-code="' + s.c + '" data-m="' + s.m + '" data-name="' + esc(s.n) + '">' + cells.join('') + '</tr>';
  }).join('');
  tableFootEl.textContent = '共 ' + rows.length + ' 条';
}

function renderIndustryOptions() {
  const ind = countBy(state.data[state.tab].map((s) => s.hybk || '其他'));
  const entries = Object.entries(ind).sort((a, b) => b[1] - a[1]);
  const cur = indEl.value;
  indEl.innerHTML = '<option value="">全部行业</option>' + entries.map(([h, n]) => '<option value="' + esc(h) + '">' + esc(h) + '（' + n + '）</option>').join('');
  if (cur && entries.some((e) => e[0] === cur)) indEl.value = cur;
  else indEl.value = '';
  state.filters.industry = indEl.value;
}

/* ---------- data loading ---------- */
async function init() {
  clearTimeout(refreshTimer);
  setLoading(true);
  try {
    const [zt, zb, dt, qs] = await Promise.all([
      fetchPool('zt', '20991231'), fetchPool('zb', '20991231'), fetchPool('dt', '20991231'),
      fetchStrongPool('20991231').catch(() => [])
    ]);
    const qd = zt.qdate || todayStr();
    state.date = qd;
    dateInput.value = toInput(qd);
    state.data = { zt: zt.list, zb: zb.list, dt: dt.list, qs: qs };
    state.tab = 'zt';
    state.filters = { search: '', lbc: 'all', industry: '' };
    searchEl.value = ''; lbcEl.value = 'all';
    lbcEl.style.display = '';
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'zt'));
    setDefaultSort('zt');
    renderAll();
    latestDate = state.date;
    isOnLatest = true;
    state.lastUpdate = new Date();
    scheduleRefresh();
    updateStatus();
  } catch (e) {
    summaryEl.textContent = '加载失败：' + e.message + '，请检查网络后点击“刷新”重试。';
    toast('加载失败：' + e.message);
  } finally {
    setLoading(false);
  }
}

async function applyDay(date, opts) {
  opts = opts || {};
  const [zt, zb, dt, qs] = await Promise.all([
    fetchPool('zt', date), fetchPool('zb', date), fetchPool('dt', date),
    fetchStrongPool(date).catch(() => [])
  ]);
  const qd = zt.qdate || date;
  const has = zt.list.length + zb.list.length + dt.list.length > 0;
  let actual = date;
  if (has && Number(date) > Number(qd)) {
    actual = qd;
    if (!opts.silent) toast(toInput(date) + ' 非交易日，已切换至最近交易日 ' + toInput(actual));
  }
  state.date = actual;
  dateInput.value = toInput(actual);
  state.data = { zt: zt.list, zb: zb.list, dt: dt.list, qs: qs };
  renderAll({ skipPrev: !!opts.skipPrev });
  return actual;
}

async function loadDate(date) {
  setLoading(true);
  try {
    await applyDay(date, {});
    isOnLatest = (state.date === latestDate);
  } catch (e) {
    toast('加载失败：' + e.message);
    summaryEl.textContent = '加载失败：' + e.message + '，请点击“刷新”重试。';
  } finally {
    setLoading(false);
  }
}

async function nav(dir) {
  setLoading(true);
  try {
    const base = state.date || todayStr();
    if (!latestDate) latestDate = state.date;
    let d = parseYmd(base);
    for (let i = 0; i < 30; i++) {
      d = addDays(d, dir);
      const ds = fmtYmd(d);
      if (dir > 0 && Number(ds) > Number(latestDate)) {
        const lp = await fetchPool('zt', '20991231');
        latestDate = lp.qdate || latestDate;
        if (Number(latestDate) > Number(base)) {
          await loadDate(latestDate);
        } else {
          toast('已是最新交易日');
        }
        return;
      }
      const probe = await fetchPool('zt', ds);
      if (probe.list.length > 0) {
        await loadDate(ds);
        return;
      }
    }
    toast(dir < 0 ? '未找到更早的交易日数据' : '已是最新交易日');
  } catch (e) {
    toast('导航失败：' + e.message);
  } finally {
    setLoading(false);
  }
}

async function refreshPrevDelta() {
  state.prevZt = null;
  renderCards();
  renderLadder();
  try {
    let d = parseYmd(state.date);
    for (let i = 0; i < 30; i++) {
      d = addDays(d, -1);
      const probe = await fetchPool('zt', fmtYmd(d));
      if (probe.list.length > 0) { state.prevZt = probe.list.length; break; }
    }
  } catch (e) { /* ignore */ }
  renderCards();
  renderLadder();
}

/* ---------- CSV export ---------- */
function csvQuote(v) {
  v = String(v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function exportCell(k, s) {
  switch (k) {
    case 'code': return s.c; case 'name': return s.n;
    case 'price': return fmtPrice(s.p); case 'zdp': return fmtPct(s.zdp);
    case 'lbc': return s.lbc; case 'days': return s.days;
    case 'zttj': return fmtZttj(s.zttj);
    case 'fbt': return fmtTime(s.fbt); case 'lbt': return fmtTime(s.lbt);
    case 'zbc': return s.zbc; case 'fund': return s.fund;
    case 'hs': return fmtPct(s.hs); case 'amount': return s.amount;
    case 'zf': return fmtPct(s.zf); case 'hybk': return s.hybk;
  }
  return '';
}
function exportCSV() {
  const cols = COLS[state.tab];
  const rows = getRows();
  if (!rows.length) { toast('没有可导出的数据'); return; }
  const header = cols.map((c) => c.label).join(',');
  const lines = rows.map((s, i) => cols.map((c) => csvQuote(c.k === 'idx' ? (i + 1) : exportCell(c.k, s))).join(','));
  const csv = '\uFEFF' + header + '\n' + lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'A股涨停_' + state.tab + '_' + state.date + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

/* ---------- events ---------- */
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  lbcEl.style.display = tab === 'zt' ? '' : 'none';
  if (tab !== 'zt') state.filters.lbc = 'all';
  setDefaultSort(tab);
  renderIndustryOptions();
  renderTable();
}

dateInput.addEventListener('change', () => {
  const v = dateInput.value.replace(/-/g, '');
  if (v && v.length === 8) loadDate(v);
});
$('prevDay').addEventListener('click', () => nav(-1));
$('nextDay').addEventListener('click', () => nav(1));
$('todayBtn').addEventListener('click', init);
$('refreshBtn').addEventListener('click', init);
tabsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) setTab(btn.dataset.tab);
});
searchEl.addEventListener('input', () => { state.filters.search = searchEl.value; renderTable(); });
lbcEl.addEventListener('change', () => { state.filters.lbc = lbcEl.value; renderTable(); });
indEl.addEventListener('change', () => { state.filters.industry = indEl.value; renderTable(); });
$('exportBtn').addEventListener('click', exportCSV);
pauseBtn.addEventListener('click', () => {
  state.auto = !state.auto;
  pauseBtn.textContent = state.auto ? '暂停' : '继续';
  if (state.auto) scheduleRefresh();
  else clearTimeout(refreshTimer);
  updateStatus();
});
followLatestEl.addEventListener('change', () => { state.followLatest = followLatestEl.checked; });
ladderList.addEventListener('click', (e) => {
  const chip = e.target.closest('.stock-chip');
  if (!chip) return;
  state.filters.search = chip.dataset.code;
  searchEl.value = chip.dataset.code;
  if (state.tab !== 'zt') setTab('zt');
  else renderTable();
  document.querySelector('.table-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
modalClose.addEventListener('click', closeChart);
chartModal.addEventListener('click', (e) => { if (e.target === chartModal) closeChart(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChart(); });
tbodyEl.addEventListener('click', (e) => {
  const link = e.target.closest('.name-link');
  if (!link) return;
  const tr = e.target.closest('tr');
  if (!tr) return;
  const code = tr.dataset.code;
  const list = state.data[state.tab] || [];
  let stock = null;
  for (let i = 0; i < list.length; i++) { if (String(list[i].c) === code) { stock = list[i]; break; } }
  if (!stock) stock = { c: code, m: tr.dataset.m, n: tr.dataset.name || code };
  openChart(stock);
});
boardTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.board-tab');
  if (!btn) return;
  boardState.mode = btn.dataset.mode;
  document.querySelectorAll('.board-tab').forEach((b) => b.classList.toggle('active', b === btn));
  const isAll = boardState.mode === 'all';
  boardType.style.display = isAll ? '' : 'none';
  boardSearch.style.display = isAll ? '' : 'none';
  boardState.currentKey = null;
  renderBoards();
});
boardType.addEventListener('click', (e) => {
  const btn = e.target.closest('.board-type-btn');
  if (!btn) return;
  boardState.type = btn.dataset.type;
  document.querySelectorAll('.board-type-btn').forEach((b) => b.classList.toggle('active', b === btn));
  boardState.currentKey = null;
  renderBoards();
});
boardSearch.addEventListener('input', () => { renderBoardTable(boardState.list); });
boardBody.addEventListener('click', (e) => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const k = th.dataset.bk;
  if (boardState.sort.key === k) boardState.sort.dir *= -1;
  else boardState.sort = { key: k, dir: -1 };
  renderBoardTable(boardState.list);
});
strongSearch.addEventListener('input', () => { strongState.search = strongSearch.value; renderStrongPool(); });
strongBody.addEventListener('click', (e) => {
  const th = e.target.closest('th.sortable');
  if (th) {
    const k = th.dataset.k;
    if (strongState.sort.key === k) strongState.sort.dir *= -1;
    else strongState.sort = { key: k, dir: (k === 'n' || k === 'hybk') ? 1 : -1 };
    renderStrongPool();
    return;
  }
  const link = e.target.closest('.name-link');
  if (!link) return;
  const tr = e.target.closest('tr');
  if (!tr) return;
  const code = tr.dataset.code;
  let stock = null;
  for (let i = 0; i < state.data.qs.length; i++) { if (String(state.data.qs[i].c) === code) { stock = state.data.qs[i]; break; } }
  if (!stock) stock = { c: code, m: tr.dataset.m, n: tr.dataset.name || code };
  openChart(stock);
});
$('strongExportBtn').addEventListener('click', exportStrongCSV);
theadEl.addEventListener('click', (e) => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const k = th.dataset.k;
  if (state.sort.key === k) state.sort.dir *= -1;
  else state.sort = { key: k, dir: 1 };
  renderTable();
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderCharts, 150);
});

setInterval(updateStatus, 1000);

init();
