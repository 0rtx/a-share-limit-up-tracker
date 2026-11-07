# -*- coding: utf-8 -*-
"""
通达信本地数据桥接服务 (TDX Bridge) for A股涨停跟踪
====================================================

数据来源（均为通达信官方/客户端数据，仅实时刷价与分时用腾讯公开行情）：
  1. 涨停/炸板/跌停池、连板、涨停统计、板块聚合 —— 本地 vipdoc .day 日线
     + 通达信官网盘后包 g4day（最新交易日，含全部代码与名称）
  2. 行业板块成分 —— 通达信客户端 T0002/hq_cache/tdxhy.cfg + tdxzs.cfg（本地）
  3. 概念板块成分 —— 通达信行情主站 block_gn.dat（协议下载，本地缓存）
  4. 盘中实时价格/封单/量比/涨速 —— 腾讯公开行情快照（通达信无网页实时接口）
  5. 封板时间/炸板次数（最新交易日）—— 腾讯分时（分钟粒度近似）

启动:  python tdx_bridge.py            # 默认 127.0.0.1:8770
       python tdx_bridge.py --host 0.0.0.0 --port 8770
       python tdx_bridge.py --tdx-dir D:\new_tdx64
"""
import argparse
import io
import json
import math
import os
import re
import socket
import struct
import sys
import threading
import time
import traceback
import urllib.request
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timedelta

# ---------------- config ----------------
DEFAULT_PORT = 8770
PACKAGE_URL = "https://www.tdx.com.cn/products/data/data/g4day/{ymd}.zip"
PACKAGE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
CONCEPTS_CACHE = os.path.join(PACKAGE_DIR, "concepts.json")
TENCENT_QT = "https://qt.gtimg.cn/q={symbols}"
TENCENT_TICK = "https://stock.gtimg.cn/data/index.php?appn=detail&action=data&c={symbol}&p={page}"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

STATE = {
    "tdx_dir": None,
    "latest_package": None,     # {ymd, rows:[{market,code,name,prev_close,o,h,l,c,amount,vol}]}
    "day_index": None,          # {ymd: {code: row}}  built lazily per date from .day files
    "pools_cache": {},          # date -> {ts, data}
    "boards_cache": {},         # (date,type) -> {ts, data}
    "strong_cache": {},         # date -> {ts, data}
    "live": {},                 # code -> realtime dict (腾讯)
    "live_ts": 0,
    "tick_cache": {},           # code -> minute-derived fbt/lbt/zbc for latest day
    "tick_attempt": {},         # code -> 失败重试时间戳（节流，保留字段）
    "tick_queue": {},           # 待后台采集的逐笔任务 key -> (mkt, limit_price)
    "tick_worker_on": False,
    "tick_date": None,
    "concepts": {},             # 概念名 -> [codes]
    "hy_map": {},               # T-code -> 一级行业名
    "stock_hy": {},             # code -> 行业名
    "code_name": {},            # code -> name (from package)
    "code_mkt": {},             # code -> market str
    "lock": threading.RLock(),
}

log = lambda *a: print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def find_tdx_dir(candidate):
    if candidate and os.path.isdir(candidate):
        return candidate
    for d in (r"D:\new_tdx64", r"D:\new_tdx", r"C:\new_tdx", r"C:\zd_zszq", r"C:\zd_gszq"):
        if os.path.isdir(d) and os.path.isdir(os.path.join(d, "vipdoc")):
            return d
    return None


# ---------------- daily data ----------------
_DAY_CACHE = {}
_DAY_CACHE_KEYS = []


def read_day_records(market, code):
    """读取本地 .day 日线，返回 [(ymd, o, h, l, c, amount, vol)]（按日期升序）。带 LRU 缓存。"""
    key = "%s|%s" % (market, code)
    if key in _DAY_CACHE:
        return _DAY_CACHE[key]
    f = os.path.join(STATE["tdx_dir"], "vipdoc", market, "lday", "%s%s.day" % (market, code))
    try:
        with open(f, "rb") as fp:
            data = fp.read()
    except OSError:
        return []
    out = []
    for i in range(0, len(data) - 31, 32):
        d, o, h, l, c, amount, vol, _ = struct.unpack("<IIIIIfII", data[i:i + 32])
        if d >= 19900101:
            out.append((d, o / 100.0, h / 100.0, l / 100.0, c / 100.0, amount, vol))
    if len(_DAY_CACHE) >= 3000:
        for k in _DAY_CACHE_KEYS[:800]:
            _DAY_CACHE.pop(k, None)
        del _DAY_CACHE_KEYS[:800]
    _DAY_CACHE[key] = out
    _DAY_CACHE_KEYS.append(key)
    return out


def load_calendar():
    """交易日历：取上证指数日线日期。"""
    recs = read_day_records("sh", "000001")
    STATE["trade_days"] = sorted(set(d for d, *_ in recs))


def load_names_fallback():
    """名称兜底：tdxpkmore.cfg（0|000301|东方盛虹|...）。"""
    f = os.path.join(STATE["tdx_dir"], "T0002", "hq_cache", "tdxpkmore.cfg")
    if not os.path.exists(f):
        return
    try:
        with open(f, "rb") as fp:
            text = fp.read().decode("gbk", "ignore")
        for line in text.splitlines():
            parts = line.split("|")
            if len(parts) >= 3 and parts[1].strip().isdigit() and len(parts[1].strip()) == 6:
                STATE["code_name"].setdefault(parts[1].strip(), parts[2].strip())
    except Exception:
        pass


def all_markets():
    return [("sh",), ("sz",), ("bj",)]


def iter_day_files():
    for mkt in ("sh", "sz", "bj"):
        d = os.path.join(STATE["tdx_dir"], "vipdoc", mkt, "lday")
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            if fn.endswith(".day"):
                code = fn.split(".")[0][2:]
                if len(code) == 6 and code.isdigit():
                    yield mkt, code


def market_of(code):
    if code[0] == "6":
        return "sh"
    if code[0] in ("4", "8") or code.startswith("92"):
        return "bj"
    return "sz"


def tdx_market_int(mkt):
    return {"sh": 1, "sz": 0, "bj": 0}.get(mkt, 0)


def is_a_stock(code, mkt):
    """只保留 A 股（排除指数/基金/债券/转债/B股）。"""
    if mkt == "sh":
        return code[:3] in ("600", "601", "603", "605", "688", "689")
    if mkt == "sz":
        return code[:3] in ("000", "001", "002", "003", "300", "301", "302")
    if mkt == "bj":
        return code.startswith("920") or code[:2] in ("43", "83", "87")
    return False


def limit_pct(code, name):
    n = (name or "")
    if "ST" in n.upper() or "st" in n:
        return 0.05
    if code[0] in ("4", "8") or code.startswith("92"):
        return 0.30
    if code.startswith(("30", "68")):
        return 0.20
    return 0.10


def round2(x):
    return round(x + 1e-9, 2)


def limit_up_price(prev_close, code, name):
    return round2(prev_close * (1 + limit_pct(code, name)))


def limit_down_price(prev_close, code, name):
    return round2(prev_close * (1 - limit_pct(code, name)))


# ---------------- g4day package ----------------
def download_package(ymd):
    url = PACKAGE_URL.format(ymd=ymd)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=90) as resp:
        return resp.read()


def parse_package(content, ymd):
    rows = []
    with zipfile.ZipFile(io.BytesIO(content)) as zf:
        for mkt in ("sh", "sz", "bj"):
            cod_name = "%s%s.cod" % (mkt, ymd[2:])
            md1_name = "%s%s.md1" % (mkt, ymd[2:])
            try:
                cod = zf.read(cod_name)
                md1 = zf.read(md1_name)
            except KeyError:
                continue
            if len(cod) % 150 or len(md1) % 512:
                log("WARN package %s market %s 长度异常" % (ymd, mkt))
                continue
            for off in range(0, len(cod), 150):
                rec = cod[off:off + 150]
                code = rec[0:6].rstrip(b"\x00 ").decode("ascii", "replace")
                if not re.fullmatch(r"[0-9]{6}", code):
                    continue
                seq = struct.unpack("<H", rec[32:34])[0]
                block = md1[seq * 512:(seq + 1) * 512]
                if len(block) != 512:
                    continue
                prev_close = struct.unpack("<d", block[4:12])[0]
                o, h, l, c = struct.unpack("<4d", block[12:44])
                amount = struct.unpack("<d", block[72:80])[0]
                vol = struct.unpack("<Q", block[56:64])[0]
                if not all(math.isfinite(v) for v in (prev_close, o, h, l, c, amount)):
                    continue
                if c <= 0:
                    continue
                raw_name = rec[40:72].split(b"\x00")[0]
                try:
                    name = raw_name.decode("gbk").strip()
                except UnicodeDecodeError:
                    name = code
                rows.append({"date": "%s-%s-%s" % (ymd[:4], ymd[4:6], ymd[6:]),
                             "market": mkt, "code": code, "name": name,
                             "prev_close": round(prev_close, 4), "open": round(o, 4),
                             "high": round(h, 4), "low": round(l, 4),
                             "close": round(c, 4), "volume": int(vol), "amount": round(amount, 2)})
    return rows


def load_latest_package():
    """尝试下载最新交易日盘后包（含今天往前 7 天）。"""
    os.makedirs(PACKAGE_DIR, exist_ok=True)
    today = datetime.now()
    for back in range(8):
        day = today - timedelta(days=back)
        if day.weekday() >= 5 and back == 0:
            continue
        ymd = day.strftime("%Y%m%d")
        fpath = os.path.join(PACKAGE_DIR, "g4day_%s.zip" % ymd)
        try:
            if os.path.exists(fpath):
                content = open(fpath, "rb").read()
            else:
                content = download_package(ymd)
                with open(fpath, "wb") as f:
                    f.write(content)
            rows = parse_package(content, ymd)
            if len(rows) >= 10000:
                STATE["latest_package"] = {"ymd": ymd, "rows": rows}
                STATE["code_name"] = {r["code"]: r["name"] for r in rows}
                STATE["code_mkt"] = {r["code"]: r["market"] for r in rows}
                log("最新盘后包: %s, %d 条" % (ymd, len(rows)))
                return ymd
        except Exception as e:
            log("包 %s 下载失败: %s" % (ymd, e))
    # 兜底：用本地 .day 最新日期
    log("WARN 官网包不可用，回退本地 .day")
    return None


# ---------------- 本地板块配置 ----------------
def load_hy_cfg():
    """tdxhy.cfg: 0|000001|T1001|||X500102 → stock T-code。"""
    stock_t = {}
    f = os.path.join(STATE["tdx_dir"], "T0002", "hq_cache", "tdxhy.cfg")
    if not os.path.exists(f):
        return stock_t
    with open(f, "rb") as fp:
        text = fp.read().decode("gbk", "ignore")
    for line in text.splitlines():
        parts = line.split("|")
        if len(parts) >= 3 and parts[1].strip().isdigit() and len(parts[1].strip()) == 6:
            t = parts[2].strip()
            if t.startswith("T"):
                stock_t[parts[1].strip()] = t
    return stock_t


def load_zs_cfg():
    """tdxzs.cfg/tdxzs3.cfg: 名称|880xxx|类型|级别|..|T码 → T码→(名,类型,级别)。"""
    tmap = {}
    for fn in ("tdxzs.cfg", "tdxzs3.cfg"):
        f = os.path.join(STATE["tdx_dir"], "T0002", "hq_cache", fn)
        if not os.path.exists(f):
            continue
        with open(f, "rb") as fp:
            text = fp.read().decode("gbk", "ignore")
        for line in text.splitlines():
            parts = line.split("|")
            if len(parts) >= 6:
                t = parts[5].strip()
                if t.startswith("T"):
                    try:
                        lv = int(parts[3])
                        typ = int(parts[2])
                    except ValueError:
                        continue
                    tmap[t] = (parts[0].strip(), typ, lv)
    return tmap


def build_industry():
    """stock → 行业名（优先通达信二级行业名，如“银行”“纺织”，退回大类）。"""
    stock_t = load_hy_cfg()
    tmap = load_zs_cfg()
    out = {}
    for code, t in stock_t.items():
        cur = t
        name_lv1 = None
        name_lv0 = None
        for _ in range(6):
            if cur in tmap:
                name, typ, lv = tmap[cur]
                if typ == 2:
                    if lv == 1 and name_lv1 is None:
                        name_lv1 = name
                    if lv == 0:
                        if name_lv0 is None:
                            name_lv0 = name
                        break
            if len(cur) > 2:
                cur = cur[:-2]
            else:
                break
        out[code] = name_lv1 or name_lv0 or ""
    STATE["stock_hy"] = out
    log("行业映射: %d 只股票" % len(out))


def load_concepts():
    """概念板块成分：解析通达信客户端本地 hq_cache/infoharbor_block.dat（#GN_ 段）。"""
    f = os.path.join(STATE["tdx_dir"], "T0002", "hq_cache", "infoharbor_block.dat")
    if not os.path.exists(f):
        log("WARN 未找到 infoharbor_block.dat，概念板块不可用")
        return
    try:
        with open(f, "rb") as fp:
            text = fp.read().decode("gbk", "ignore")
        cur = None
        concepts = {}
        for line in text.splitlines():
            if line.startswith("#"):
                parts = line.split(",")
                if len(parts) >= 2 and parts[0].startswith("#GN"):
                    cur = parts[0][3:].strip().lstrip("_")
                    concepts[cur] = []
                else:
                    cur = None
            elif cur:
                for item in line.split(","):
                    if "#" in item and item.split("#", 1)[0] in ("0", "1", "2"):
                        code = item.split("#", 1)[1]
                        if code.isdigit() and len(code) == 6:
                            concepts[cur].append(code)
        concepts = {k: v for k, v in concepts.items() if k and v}
        with open(CONCEPTS_CACHE, "w", encoding="utf-8") as fp:
            json.dump(concepts, fp, ensure_ascii=False)
        STATE["concepts"] = concepts
        log("概念板块: %d 个（本地板块文件）" % len(concepts))
    except Exception as e:
        log("WARN 概念板块解析失败: %s" % e)


# ---------------- 按日期的全市场日线 ----------------
def day_rows_for(date):
    """返回 {code: row}，row={o,h,l,c,amount,vol,prev_close,name,market,hybk}。"""
    with STATE["lock"]:
        idx = STATE["day_index"]
        if idx is None:
            idx = {}
            STATE["day_index"] = idx
        if date in idx:
            return idx[date]
    ymd = date.replace("-", "")
    rows = {}
    pkg = STATE["latest_package"]
    if pkg and pkg["ymd"] == ymd:
        for r in pkg["rows"]:
            rows[r["code"]] = dict(r)
    for mkt, code in iter_day_files():
        if code in rows:
            continue
        recs = read_day_records(mkt, code)
        if not recs:
            continue
        for d, o, h, l, c, amount, vol in recs:
            ds = "%d" % d
            if ds == ymd:
                name = STATE["code_name"].get(code) or code
                rows[code] = {"market": mkt, "code": code, "name": name,
                              "open": o, "high": h, "low": l, "close": c,
                              "amount": amount, "volume": vol,
                              "prev_close": None}
                break
            if ds > ymd:
                break
    # prev_close：取前一日收盘
    for code, row in rows.items():
        if row["prev_close"] is not None:
            continue
        recs = read_day_records(row["market"], code)
        pc = None
        for d, o, h, l, c, amount, vol in recs:
            if d == int(ymd):
                break
            pc = c
        row["prev_close"] = pc
    # 行业
    for code, row in rows.items():
        row["hybk"] = STATE["stock_hy"].get(code, "")
    with STATE["lock"]:
        idx[date] = rows
        if len(idx) > 40:
            for k in sorted(idx)[:10]:
                idx.pop(k, None)
    return rows


def hist_for(code, upto_ymd=None):
    """该股票 up to 日期的日线历史 [(ymd,o,h,l,c,prev_close)]，最新在前。"""
    mkt = STATE["code_mkt"].get(code) or market_of(code)
    recs = read_day_records(mkt, code)
    if not recs:
        return []
    out = []
    prev = None
    for d, o, h, l, c, amount, vol in recs:
        ds = "%d" % d
        if upto_ymd and d > int(upto_ymd):
            continue
        out.append({"ymd": ds, "o": o, "h": h, "l": l, "c": c,
                    "amount": amount, "vol": vol, "prev_close": prev, "_d": d})
        prev = c
    return out


def is_limit_up(row):
    pc = row["prev_close"]
    if pc is None or pc <= 0:
        return False
    lim = limit_up_price(pc, row["code"], row.get("name") or "")
    return row["close"] >= lim - 0.005


def is_limit_down(row):
    pc = row["prev_close"]
    if pc is None or pc <= 0:
        return False
    lim = limit_down_price(pc, row["code"], row.get("name") or "")
    return row["close"] <= lim + 0.005


def touched_limit(row):
    pc = row["prev_close"]
    if pc is None or pc <= 0:
        return False
    lim = limit_up_price(pc, row["code"], row.get("name") or "")
    return row["high"] >= lim - 0.005


def compute_lbc(code, ymd):
    """连板数：截至 ymd 的连续涨停天数。"""
    hist = hist_for(code, ymd)
    if not hist:
        return 0
    lbc = 0
    for rec in reversed(hist):  # 最新在前
        if rec["ymd"] == ymd:
            row = {"code": code, "name": STATE["code_name"].get(code) or "",
                   "close": rec["c"], "prev_close": rec["prev_close"], "high": rec["h"]}
            if is_limit_up(row):
                lbc = 1
            continue
        if lbc == 0:
            break
        row = {"code": code, "name": STATE["code_name"].get(code) or "",
               "close": rec["c"], "prev_close": rec["prev_close"], "high": rec["h"]}
        if is_limit_up(row):
            lbc += 1
        else:
            break
    return lbc


def compute_zttj(code, ymd, window=10):
    """涨停统计：近 window 个交易日涨停天数与次数。"""
    hist = hist_for(code, ymd)
    days = 0
    ct = 0
    seen = 0
    for rec in reversed(hist):
        if seen >= window:
            break
        row = {"code": code, "name": STATE["code_name"].get(code) or "",
               "close": rec["c"], "prev_close": rec["prev_close"], "high": rec["h"]}
        seen += 1
        if is_limit_up(row):
            days += 1
            ct += 1
    return {"days": days, "ct": ct}


def zdp_of(row):
    pc = row.get("prev_close")
    if not pc:
        return 0.0
    return (row["close"] / pc - 1) * 100


# ---------------- 实时（腾讯） ----------------
def fetch_tencent_quotes(codes):
    """codes: [(mkt, code)] → {code: {...}}"""
    out = {}
    syms = []
    for mkt, code in codes:
        syms.append({"sh": "sh", "sz": "sz", "bj": "bj"}[mkt] + code)
    for i in range(0, len(syms), 60):
        batch = syms[i:i + 60]
        url = TENCENT_QT.format(symbols=",".join(batch))
        try:
            req = urllib.request.Request(url, headers=UA)
            text = urllib.request.urlopen(req, timeout=10).read().decode("gbk", "ignore")
        except Exception:
            continue
        for line in text.split(";"):
            m = re.search(r'v_(\w{2})(\d{6})="([^"]*)"', line)
            if not m:
                continue
            code = m.group(2)
            f = m.group(3).split("~")
            if len(f) < 50:
                continue
            try:
                price = float(f[3]) if f[3] else 0
                pc = float(f[4]) if f[4] else 0
                out[code] = {
                    "price": price,
                    "zdp": (price / pc - 1) * 100 if pc else 0,
                    "hs": float(f[38]) if len(f) > 38 and f[38] else None,
                    "lb": float(f[49]) if len(f) > 49 and f[49] else None,
                    "zs": float(f[47]) if len(f) > 47 and f[47] else None,
                    "amount": float(f[37]) * 10000 if len(f) > 37 and f[37] else None,
                    "ask1": float(f[19]) if len(f) > 19 and f[19] else None,
                    "ask1_vol": float(f[20]) if len(f) > 20 and f[20] else None,
                }
            except (ValueError, IndexError):
                continue
    return out


def fetch_tencent_minute(mkt, code):
    """【已废弃】腾讯分时接口会 501 限流，改用逐笔 detail 接口。保留供参考。"""
    return []


def fetch_tencent_ticks(mkt, code):
    """腾讯逐笔成交（3 秒粒度，最近一个交易日）。返回 [(time, price, ...)] 按时间升序；失败返回 []。"""
    sym = {"sh": "sh", "sz": "sz", "bj": "bj"}[mkt] + code
    if mkt == "bj":
        return []
    out = []
    for page in range(300):
        try:
            req = urllib.request.Request(TENCENT_TICK.format(symbol=sym, page=page), headers=UA)
            text = urllib.request.urlopen(req, timeout=10).read().decode("gbk", "ignore")
        except Exception:
            break
        m = re.search(r'v_detail_data_%s=\[(\d+),"([^"]*)"\];?' % sym, text)
        if not m or not m.group(2):
            break
        for item in m.group(2).split("|"):
            parts = item.split("/")
            if len(parts) < 4:
                continue
            try:
                out.append((parts[1], float(parts[2])))
            except ValueError:
                continue
        time.sleep(0.08)
        if len(m.group(2).split("|")) < 70:
            break
    out.sort(key=lambda x: x[0])
    return out


def ticks_seal_info(mkt, code, limit_price):
    """逐笔粒度估计 首次封板/最后封板/炸板次数/是否封住过。"""
    pts = fetch_tencent_ticks(mkt, code)
    if not pts:
        return None, None, 0, False
    sealed = False
    sealed_any = False
    zbc = 0
    fbt = None
    lbt = None
    for t, price in pts:
        if price >= limit_price - 0.005 and t >= "09:25:00" and t <= "15:00:59":
            if not sealed:
                if fbt is None:
                    fbt = t
                sealed = True
                sealed_any = True
            lbt = t
        elif t <= "15:00:59":
            if sealed:
                sealed = False
                zbc += 1
    return fbt, lbt, zbc, sealed_any


def realtime_thread():
    while True:
        try:
            now = datetime.now()
            if now.weekday() < 5 and (545 <= now.hour * 60 + now.minute <= 905):
                pkg = STATE["latest_package"]
                if pkg:
                    codes = []
                    rows = day_rows_for(pkg["ymd"])
                    with STATE["lock"]:
                        pool_codes = set()
                        for date, c in STATE["pools_cache"].items():
                            d = c.get("data") or {}
                            for k in ("zt", "zb", "dt"):
                                for it in d.get(k, []):
                                    pool_codes.add(it["c"])
                        for code, row in rows.items():
                            if code in pool_codes or abs(zdp_of(row)) >= 7:
                                codes.append((row["market"], code))
                    live = fetch_tencent_quotes(codes[:1200])
                    with STATE["lock"]:
                        STATE["live"] = live
                        STATE["live_ts"] = time.time()
            time.sleep(60)
        except Exception as e:
            log("realtime ERROR: %s" % e)
            time.sleep(60)


# ---------------- 池计算 ----------------
def overlay_live(item, code):
    live = STATE["live"].get(code)
    if not live:
        return
    item["p"] = int(round(live["price"] * 1000))
    item["zdp"] = round(live["zdp"], 2)
    if live.get("hs") is not None:
        item["hs"] = live["hs"]
    if live.get("lb") is not None:
        item["lb"] = live["lb"]
    if live.get("zs") is not None:
        item["zs"] = live["zs"]
    if live.get("amount") is not None:
        item["amount"] = live["amount"]
    # 封单资金：卖一价=涨停价时的卖一量×价（近似）
    lim = item.get("_limit")
    if lim and live.get("ask1") and abs(live["ask1"] - lim) < 0.005:
        item["fund"] = live["ask1_vol"] * 100 * live["ask1"]
    else:
        item["fund"] = None


def compute_pools(date):
    ymd = date.replace("-", "")
    rows = day_rows_for(date)
    pkg = STATE["latest_package"]
    is_latest = bool(pkg and pkg["ymd"] == ymd)
    zt, zb, dt = [], [], []
    for code, row in rows.items():
        if not row.get("prev_close"):
            continue
        if not is_a_stock(code, row["market"]):
            continue
        name = row.get("name") or code
        # 与东财默认涨停池口径一致：剔除 ST 与新股（N 首日 / C 上市初期无涨跌幅限制）
        if "ST" in name.upper() or name.startswith(("N", "C")):
            continue
        zt_flag = is_limit_up(row)
        zb_flag = (not zt_flag) and touched_limit(row)
        dt_flag = is_limit_down(row)
        if not (zt_flag or zb_flag or dt_flag):
            continue
        if zb_flag and is_latest:
            # 最新交易日用分时核实“确实封住过”才算炸板（摸到涨停价不算）；
            # 分时拿不到数据时退回日线口径（high≥涨停价）
            fbt, lbt, zbc, sealed_any = tick_seal_full(code, row)
            if fbt is not None or sealed_any:
                zb_flag = sealed_any
        if not (zt_flag or zb_flag or dt_flag):
            continue
        zdp = zdp_of(row)
        base = {
            "c": code,
            "m": tdx_market_int(row["market"]),
            "n": name,
            "p": int(round(row["close"] * 1000)),
            "zdp": round(zdp, 2),
            "amount": row.get("amount"),
            "hybk": row.get("hybk", ""),
            "_limit": limit_up_price(row["prev_close"], code, name),
            "_prev_close": row["prev_close"],
        }
        if zt_flag:
            item = dict(base)
            item["lbc"] = compute_lbc(code, ymd)
            item["zttj"] = compute_zttj(code, ymd)
            item["hs"] = None
            item["fund"] = None
            fbt, lbt, zbc = tick_seal(code, row)
            item["fbt"] = fbt
            item["lbt"] = lbt
            item["zbc"] = zbc
            zt.append(item)
        elif zb_flag:
            item = dict(base)
            item["zf"] = round((row["high"] - row["low"]) / row["prev_close"] * 100, 2)
            item["zbc"] = 1
            item["fbt"] = None
            item["zttj"] = compute_zttj(code, ymd)
            item["hs"] = None
            zb.append(item)
        else:
            item = dict(base)
            item["days"] = compute_lbc_dt(code, ymd)
            item["fund"] = None
            item["lbt"] = None
            item["hs"] = None
            dt.append(item)
    # 最新交易日叠加实时价
    pkg = STATE["latest_package"]
    if pkg and pkg["ymd"] == ymd:
        for lst in (zt, zb, dt):
            for item in lst:
                overlay_live(item, item["c"])
    def key_fbt(x):
        return x.get("fbt") or "999999"
    zt.sort(key=key_fbt)
    zb.sort(key=lambda x: -(x.get("zf") or 0))
    dt.sort(key=lambda x: -(x.get("days") or 0))
    return {"qdate": ymd, "zt": zt, "zb": zb, "dt": dt}


def compute_lbc_dt(code, ymd):
    hist = hist_for(code, ymd)
    days = 0
    for rec in reversed(hist):
        if rec["ymd"] == ymd:
            row = {"code": code, "name": STATE["code_name"].get(code) or "",
                   "close": rec["c"], "prev_close": rec["prev_close"], "high": rec["h"]}
            if is_limit_down(row):
                days = 1
            continue
        if days == 0:
            break
        row = {"code": code, "name": STATE["code_name"].get(code) or "",
               "close": rec["c"], "prev_close": rec["prev_close"], "high": rec["h"]}
        if is_limit_down(row):
            days += 1
        else:
            break
    return days


def tick_cache_path(ymd):
    return os.path.join(PACKAGE_DIR, "ticks_%s.json" % ymd)


def load_tick_cache(ymd):
    p = tick_cache_path(ymd)
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                STATE["tick_cache"] = {k: tuple(v) for k, v in json.load(f).items()}
        except Exception:
            pass


def save_tick_cache(ymd):
    try:
        with open(tick_cache_path(ymd), "w", encoding="utf-8") as f:
            json.dump({k: list(v) for k, v in STATE["tick_cache"].items()}, f, ensure_ascii=False)
    except Exception:
        pass


def tick_seal_full(code, row):
    """读取封板信息缓存；未缓存则登记后台任务。返回 (fbt, lbt, zbc, sealed_any)。"""
    pkg = STATE["latest_package"]
    if not pkg or row.get("prev_close") is None:
        return None, None, 0, False
    key = "%s|%s" % (pkg["ymd"], code)
    if key in STATE["tick_cache"]:
        fbt, lbt, zbc, sealed_any = STATE["tick_cache"][key]
        return (fmt_tick(fbt), fmt_tick(lbt), max(0, zbc - 1) if zbc else 0, sealed_any)
    mkt = row.get("market") or market_of(code)
    if mkt != "bj":
        lim = limit_up_price(row["prev_close"], code, row.get("name") or "")
        with STATE["lock"]:
            STATE["tick_queue"][key] = (mkt, lim)
    return None, None, 0, False


def fmt_tick(t):
    """'09:25:01' → '092501'"""
    if not t:
        return None
    return t.replace(":", "")[:6]


def tick_worker_start():
    """后台逐笔采集：不阻塞页面，完成后下次池重算自动带上封板时间。"""
    with STATE["lock"]:
        if STATE["tick_worker_on"] or not STATE["tick_queue"]:
            return
        STATE["tick_worker_on"] = True
    threading.Thread(target=_tick_worker_main, daemon=True).start()


def _tick_worker_main():
    try:
        pkg = STATE["latest_package"]
        while True:
            with STATE["lock"]:
                if not STATE["tick_queue"]:
                    break
                items = {k: v for k, v in STATE["tick_queue"].items() if k not in STATE["tick_cache"]}
                STATE["tick_queue"].clear()
            if not items:
                break
            done = 0
            for key, (mkt, lim) in items.items():
                if key in STATE["tick_cache"]:
                    continue
                try:
                    res = ticks_seal_info(mkt, key.split("|")[1], lim)
                except Exception:
                    res = None, None, 0, False
                if res[0] is not None or res[3]:
                    STATE["tick_cache"][key] = res
                    save_tick_cache(key.split("|")[0])
                    done += 1
                time.sleep(0.15)
            if pkg:
                save_tick_cache(pkg["ymd"])
            log("逐笔采集完成: %d 只" % done)
            # 有新增数据时清掉最新日期的池缓存，下次请求自动重算并带上封板时间
            if done:
                with STATE["lock"]:
                    STATE["pools_cache"].pop(pkg["ymd"], None)
    except Exception as e:
        log("逐笔采集异常: %s" % e)
    finally:
        STATE["tick_worker_on"] = False


def tick_seal(code, row):
    fbt, lbt, zbc, _ = tick_seal_full(code, row)
    return fbt, lbt, zbc


# ---------------- 板块 ----------------
def compute_boards(date, btype):
    """btype: 2=行业 3=概念 1=地域（地域暂无成分数据，返回空）。
    返回 [{f12,f14,f3,f25,f128,f136,_cnt,_zc}]"""
    if btype == "1":
        return []
    ymd = date.replace("-", "")
    rows = day_rows_for(date)
    live = STATE["live"]
    pkg = STATE["latest_package"]
    is_latest = bool(pkg and pkg["ymd"] == ymd)
    groups = {}
    if btype == "2":
        for code, row in rows.items():
            hy = row.get("hybk")
            if hy:
                groups.setdefault(hy, []).append((code, row))
    else:
        for bn, codes in STATE["concepts"].items():
            for code in codes:
                row = rows.get(code)
                if row:
                    groups.setdefault(bn, []).append((code, row))
    out = []
    for name, members in groups.items():
        up = 0
        total_pct = 0.0
        total_amt = 0.0
        lead = None
        for code, row in members:
            if is_latest and code in live:
                lv = live[code]
                pct = lv.get("zdp") or 0
                amt = lv.get("amount") or 0
                price = lv.get("price") or 0
            else:
                pct = zdp_of(row)
                amt = row.get("amount") or 0
                price = row["close"]
            total_pct += pct
            total_amt += amt
            if pct > 0:
                up += 1
            if lead is None or pct > lead[1]:
                lead = (row.get("name") or code, pct)
        n = len(members)
        zc = sum(1 for code, row in members if is_limit_up(row))
        out.append({
            "f12": name,
            "f14": name,
            "f3": round(total_pct / n, 2) if n else 0,
            "f25": round(total_amt, 2),
            "f128": lead[0] if lead else "—",
            "f136": round(lead[1], 2) if lead else 0,
            "_cnt": n,
            "_zc": zc,
        })
    out.sort(key=lambda b: -(b["f3"] or 0))
    return out


# ---------------- 强势股池 ----------------
def compute_strong(date):
    ymd = date.replace("-", "")
    rows = day_rows_for(date)
    out = []
    for code, row in rows.items():
        if not row.get("prev_close"):
            continue
        if not is_a_stock(code, row["market"]):
            continue
        nm = row.get("name") or ""
        if "ST" in nm.upper() or nm.startswith(("N", "C")):
            continue
        zdp = zdp_of(row)
        hist = hist_for(code, ymd)
        # 60日新高
        nh = 1
        highs = [r["h"] for r in reversed(hist) if r["ymd"] != ymd][:60]
        if highs and row["high"] <= max(highs):
            nh = 0
        # 近20日涨停次数（不含今日）
        zt_cnt = 0
        seen = 0
        for r in reversed(hist):
            if r["ymd"] == ymd:
                continue
            seen += 1
            rr = {"code": code, "name": row.get("name") or "",
                  "close": r["c"], "prev_close": r["prev_close"], "high": r["h"]}
            if is_limit_up(rr):
                zt_cnt += 1
            if seen >= 20:
                break
        today_zt = is_limit_up(row)
        multi = zt_cnt >= 2
        if not (today_zt or ((nh or multi) and zdp > 0)):
            continue
        cc = 3 if (nh and multi) else (2 if multi else 1)
        item = {
            "c": code, "m": tdx_market_int(row["market"]), "n": row.get("name") or code,
            "p": int(round(row["close"] * 1000)),
            "ztp": int(round(limit_up_price(row["prev_close"], code, row.get("name") or "") * 1000)),
            "zdp": round(zdp, 2),
            "hs": None, "lb": None, "zs": None,
            "nh": nh, "cc": cc,
            "zttj": compute_zttj(code, ymd),
            "amount": row.get("amount"), "ltsz": None,
            "hybk": row.get("hybk", ""),
        }
        overlay_live(item, code)
        out.append(item)
    out.sort(key=lambda x: -(x["zdp"] or 0))
    return out


def today_ymd():
    return datetime.now().strftime("%Y%m%d")


_INFLIGHT = {}


def cached_compute(cache, key, ttl, fn):
    """带缓存的惰性计算：计算在锁外进行，同 key 并发去重（页面的 zt/zb/dt 并行请求只算一次）。"""
    with STATE["lock"]:
        c = cache.get(key)
        if c and time.time() - c["ts"] <= ttl:
            return c["data"]
        ev = _INFLIGHT.get(key)
        mine = ev is None
        if mine:
            ev = _INFLIGHT[key] = threading.Event()
    if mine:
        try:
            data = fn()
        except BaseException:
            with STATE["lock"]:
                _INFLIGHT.pop(key, None)
                ev.set()
            raise
        with STATE["lock"]:
            cache[key] = {"ts": time.time(), "data": data}
            _INFLIGHT.pop(key, None)
            ev.set()
        return data
    ev.wait(300)
    with STATE["lock"]:
        c = cache.get(key)
        if c is not None:
            return c["data"]
    return fn()


# ---------------- HTTP ----------------
class Handler(BaseHTTPRequestHandler):
    server_version = "TDXBridge/1.0"

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def _resolve_date(self, qs):
        """把缺省日期或 '20991231'（东财“最新”）映射到最新交易日。"""
        date = (qs.get("date") or "").replace("-", "")
        pkg = STATE["latest_package"]
        if pkg:
            latest = pkg["ymd"]
        elif STATE.get("trade_days"):
            latest = "%d" % STATE["trade_days"][-1]
        else:
            latest = today_ymd()
        if not date or date == "20991231" or int(date) > int(today_ymd()):
            return latest
        return date

    def do_GET(self):
        try:
            path = self.path.split("?")[0]
            qs = {}
            if "?" in self.path:
                for kv in self.path.split("?", 1)[1].split("&"):
                    if "=" in kv:
                        k, v = kv.split("=", 1)
                        qs[urllib.parse.unquote_plus(k)] = urllib.parse.unquote_plus(v)
            if path == "/api/ping":
                pkg = STATE["latest_package"]
                self._json({"ok": True, "source": "tdx",
                            "latestDate": pkg["ymd"] if pkg else None,
                            "stocks": len(STATE["code_name"]),
                            "concepts": len(STATE["concepts"]),
                            "industries": len(STATE["stock_hy"]),
                            "live": len(STATE["live"])})
                return
            if path == "/api/calendar":
                days = STATE.get("trade_days") or []
                if not days:
                    self._json({"error": "no calendar"}, 500)
                    return
                date = qs.get("date") or ""
                dirn = int(qs.get("dir") or -1)
                try:
                    cur = int(date.replace("-", ""))
                except ValueError:
                    cur = days[-1]
                if dirn < 0:
                    candidates = [d for d in days if d < cur]
                    target = candidates[-1] if candidates else None
                else:
                    candidates = [d for d in days if d > cur]
                    target = candidates[0] if candidates else None
                self._json({"date": ("%d" % target) if target else None, "latest": "%d" % days[-1]})
                return
            if path == "/api/pools":
                date = self._resolve_date(qs)
                latest = (STATE["latest_package"] or {}).get("ymd")
                ttl = 20 if date == latest else 120
                try:
                    data = cached_compute(STATE["pools_cache"], date, ttl, lambda: compute_pools(date))
                except Exception as e:
                    traceback.print_exc()
                    self._json({"error": str(e)}, 500)
                    return
                tick_worker_start()
                self._json(data)
                return
            if path == "/api/boards":
                date = self._resolve_date(qs)
                btype = qs.get("type") or "2"
                key = "%s|%s" % (date, btype)
                try:
                    data = cached_compute(STATE["boards_cache"], key, 30, lambda: compute_boards(date, btype))
                except Exception as e:
                    traceback.print_exc()
                    self._json({"error": str(e)}, 500)
                    return
                self._json(data)
                return
            if path == "/api/strong":
                date = self._resolve_date(qs)
                try:
                    data = cached_compute(STATE["strong_cache"], date, 300, lambda: compute_strong(date))
                except Exception as e:
                    traceback.print_exc()
                    self._json({"error": str(e)}, 500)
                    return
                self._json(data)
                return
            self._json({"error": "not found"}, 404)
        except Exception as e:
            traceback.print_exc()
            try:
                self._json({"error": str(e)}, 500)
            except Exception:
                pass


# ---------------- main ----------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--tdx-dir", default=None)
    args = ap.parse_args()

    tdx_dir = find_tdx_dir(args.tdx_dir)
    if not tdx_dir:
        print("未找到通达信安装目录（vipdoc），请用 --tdx-dir 指定")
        sys.exit(1)
    STATE["tdx_dir"] = tdx_dir
    log("通达信目录: %s" % tdx_dir)

    load_calendar()
    load_names_fallback()
    load_latest_package()
    pkg = STATE["latest_package"]
    if pkg:
        load_tick_cache(pkg["ymd"])
    build_industry()
    load_concepts()

    threading.Thread(target=realtime_thread, daemon=True).start()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    log("桥接服务已启动: http://%s:%d/api/ping" % (args.host, args.port))
    log("若页面在其它设备打开，请使用 --host 0.0.0.0 并放行防火墙")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
