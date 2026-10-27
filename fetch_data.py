#!/usr/bin/env python3
"""
جامع بيانات منصة فلتر تاسي
---------------------------------
يجلب الأسعار اليومية (OHLCV المعدّلة) لأسهم السوق الرئيسية ولمؤشر تاسي،
ويحفظها كملفات JSON في مجلد data/ لتقرأها المنصة (index.html).

الاستخدام:
    python fetch_data.py              # تحديث تراكمي (الأيام الجديدة فقط)
    python fetch_data.py --full       # إعادة جلب التاريخ كاملاً
    python fetch_data.py --discover   # اكتشاف الأسهم المدرجة وإضافتها لقائمة الرموز ثم التحديث
    python fetch_data.py --only 2222 1120

المصدر الأساسي: Yahoo Finance عبر مكتبة yfinance.
المصدر الاحتياطي (اختياري): EODHD عبر مفتاح في متغير البيئة EODHD_API_KEY.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import sys
import time
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
SYMBOLS_PATH = ROOT / "symbols.json"


# ----------------------------------------------------------------------------
# أدوات عامة
# ----------------------------------------------------------------------------
def log(msg: str) -> None:
    print(f"[{dt.datetime.utcnow():%H:%M:%S}] {msg}", flush=True)


def load_json(path: Path, default):
    if path.exists():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


def save_json(path: Path, obj, compact: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=2)
    tmp.replace(path)


def int_date(ts) -> int:
    return ts.year * 10000 + ts.month * 100 + ts.day


def from_int_date(d: int) -> dt.date:
    return dt.date(d // 10000, (d // 100) % 100, d % 100)


# ----------------------------------------------------------------------------
# تنظيف البيانات وفحص الجودة
# ----------------------------------------------------------------------------
def clean_frame(df: pd.DataFrame, price_limit: float) -> tuple[pd.DataFrame, dict]:
    """يعيد إطاراً نظيفاً بأعمدة Open High Low Close Volume وتقرير جودة."""
    issues = {"dropped_rows": 0, "weekend_rows": 0, "limit_breaches": []}
    if df is None or df.empty:
        return pd.DataFrame(), issues

    df = df.copy()
    df.columns = [str(c).title() for c in df.columns]
    needed = ["Open", "High", "Low", "Close", "Volume"]
    for col in needed:
        if col not in df.columns:
            df[col] = math.nan if col != "Volume" else 0
    df = df[needed]

    idx = pd.to_datetime(df.index)
    if getattr(idx, "tz", None) is not None:
        idx = idx.tz_localize(None)
    df.index = idx.normalize()
    df = df[~df.index.duplicated(keep="last")].sort_index()

    before = len(df)
    df = df[df["Close"].notna() & (df["Close"] > 0)]
    # أيام عطلة السوق السعودي: الجمعة (4) والسبت (5)
    weekend = df.index.dayofweek.isin([4, 5])
    issues["weekend_rows"] = int(weekend.sum())
    df = df[~weekend]
    issues["dropped_rows"] = before - len(df)

    df["Volume"] = df["Volume"].fillna(0).clip(lower=0)
    for col in ["Open", "High", "Low"]:
        df[col] = df[col].fillna(df["Close"])
    df.loc[df["Open"] <= 0, "Open"] = df["Close"]
    df["High"] = df[["Open", "High", "Low", "Close"]].max(axis=1)
    df["Low"] = df[["Open", "High", "Low", "Close"]].min(axis=1)

    ret = df["Close"].pct_change().abs()
    breaches = ret[ret > price_limit + 0.005]
    issues["limit_breaches"] = [
        {"date": int_date(i), "move": round(float(v), 4)} for i, v in breaches.items()
    ][-20:]
    return df, issues


def frame_to_payload(symbol: str, df: pd.DataFrame) -> dict:
    def r(x):
        return [round(float(v), 4) for v in x]

    return {
        "s": symbol,
        "d": [int_date(i) for i in df.index],
        "o": r(df["Open"]),
        "h": r(df["High"]),
        "l": r(df["Low"]),
        "c": r(df["Close"]),
        "v": [int(v) for v in df["Volume"]],
    }


def payload_to_frame(p: dict) -> pd.DataFrame:
    if not p or not p.get("d"):
        return pd.DataFrame()
    idx = pd.to_datetime([str(d) for d in p["d"]], format="%Y%m%d")
    return pd.DataFrame(
        {"Open": p["o"], "High": p["h"], "Low": p["l"], "Close": p["c"], "Volume": p["v"]},
        index=idx,
    )


# ----------------------------------------------------------------------------
# المصدر الأساسي: Yahoo Finance
# ----------------------------------------------------------------------------
def _extract(raw: pd.DataFrame, ticker: str, n_tickers: int) -> pd.DataFrame:
    if raw is None or raw.empty:
        return pd.DataFrame()
    if isinstance(raw.columns, pd.MultiIndex):
        lv0 = raw.columns.get_level_values(0)
        lv1 = raw.columns.get_level_values(1)
        if ticker in lv0:
            return raw[ticker].dropna(how="all")
        if ticker in lv1:
            return raw.xs(ticker, axis=1, level=1).dropna(how="all")
        return pd.DataFrame()
    return raw.dropna(how="all") if n_tickers == 1 else pd.DataFrame()


def yahoo_download(tickers: list[str], start: str | None, cfg: dict, period: str | None = None) -> dict:
    import yfinance as yf  # استيراد متأخر حتى تعمل الاختبارات دون الشبكة

    out: dict[str, pd.DataFrame] = {}
    bs = cfg["batch_size"]
    for i in range(0, len(tickers), bs):
        batch = tickers[i : i + bs]
        raw = None
        for attempt in range(cfg["max_retries"]):
            try:
                kwargs = dict(
                    tickers=batch,
                    auto_adjust=True,
                    group_by="ticker",
                    threads=True,
                    progress=False,
                    actions=False,
                )
                if period:
                    kwargs["period"] = period
                else:
                    kwargs["start"] = start
                raw = yf.download(**kwargs)
                break
            except Exception as e:  # noqa: BLE001
                log(f"  محاولة {attempt + 1} فشلت للدفعة {i // bs + 1}: {e}")
                time.sleep(cfg["pause_seconds"] * (attempt + 2))
        for t in batch:
            out[t] = _extract(raw, t, len(batch)) if raw is not None else pd.DataFrame()
        log(f"  Yahoo: دفعة {i // bs + 1}/{math.ceil(len(tickers) / bs)}")
        time.sleep(cfg["pause_seconds"])
    return out


def yahoo_name(ticker: str) -> str | None:
    try:
        import yfinance as yf

        info = yf.Ticker(ticker).info or {}
        return info.get("shortName") or info.get("longName")
    except Exception:  # noqa: BLE001
        return None


# ----------------------------------------------------------------------------
# المصدر الاحتياطي: EODHD (اختياري)
# ----------------------------------------------------------------------------
def eodhd_download(code: str, start: str, cfg: dict) -> pd.DataFrame:
    fb = cfg.get("fallback") or {}
    key = os.environ.get(fb.get("api_key_env", "EODHD_API_KEY"), "").strip()
    if not key or fb.get("provider") != "eodhd":
        return pd.DataFrame()
    import requests

    url = f"https://eodhd.com/api/eod/{code}"
    try:
        r = requests.get(url, params={"api_token": key, "fmt": "json", "from": start}, timeout=30)
        r.raise_for_status()
        rows = r.json()
    except Exception as e:  # noqa: BLE001
        log(f"  EODHD فشل لـ {code}: {e}")
        return pd.DataFrame()
    if not isinstance(rows, list) or not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    df.index = pd.to_datetime(df["date"])
    factor = (df["adjusted_close"] / df["close"]).where(df["close"] > 0, 1.0)
    return pd.DataFrame(
        {
            "Open": df["open"] * factor,
            "High": df["high"] * factor,
            "Low": df["low"] * factor,
            "Close": df["adjusted_close"],
            "Volume": df["volume"],
        }
    )


# ----------------------------------------------------------------------------
# اكتشاف الأسهم المدرجة
# ----------------------------------------------------------------------------
def discover(cfg: dict, symbols_doc: dict) -> int:
    known = {x["s"] for x in symbols_doc["symbols"]}
    candidates = []
    for a, b in cfg["discover_ranges"]:
        candidates += [str(c) for c in range(a, b + 1)]
    candidates = [c for c in candidates if c not in known]
    log(f"اكتشاف: فحص {len(candidates)} رمزاً محتملاً...")
    sfx = cfg["yahoo_suffix"]
    res = yahoo_download([c + sfx for c in candidates], None, cfg, period="1mo")
    cutoff = pd.Timestamp(dt.date.today() - dt.timedelta(days=30))
    added = 0
    for c in candidates:
        df = res.get(c + sfx)
        if df is None or df.empty or "Close" not in df.columns:
            continue
        closes = df["Close"].dropna()
        if len(closes) >= 5 and closes.index.max() >= cutoff:
            name = yahoo_name(c + sfx) or c
            symbols_doc["symbols"].append({"s": c, "n": name, "sec": "غير مصنف", "auto": True})
            added += 1
            log(f"  أضيف: {c} {name}")
    symbols_doc["symbols"].sort(key=lambda x: x["s"])
    save_json(SYMBOLS_PATH, symbols_doc, compact=False)
    log(f"اكتشاف: أضيف {added} سهماً جديداً.")
    return added


# ----------------------------------------------------------------------------
# ملفات inbox: لقطة السوق من تيكرشارت (الرمز، الاسم، الإغلاق، التغير، صافي السيولة...)
# ----------------------------------------------------------------------------
import re

_HDR = {
    "s": ["الرمز", "رمز", "symbol", "ticker", "code", "كود"],
    "n": ["الاسم", "اسم", "الشركه", "name", "company"],
    "d": ["التاريخ", "تاريخ", "date", "time", "datetime", "الوقت"],
    "c": ["الاغلاق", "اغلاق", "close", "last", "اخرسعر", "السعر", "سعر"],
    "chg": ["التغير", "تغير", "change", "chg"],
    "chgPct": ["التغير%", "تغير%", "التغيرنسبه", "نسبهالتغير", "change%", "chg%", "%change"],
    "net": ["صافيالسيوله", "صافيسيوله", "السيولهالصافيه", "netliquidity", "netflow", "moneyflow"],
    "v": ["الكميه", "كميه", "حجمالتداول", "الحجم", "volume", "vol"],
    "val": ["القيمه", "قيمهالتداول", "value", "turnover"],
}


def _norm(h) -> str:
    h = str(h if h is not None else "").lower()
    h = re.sub(r"[\u064B-\u0652\u200e\u200f\"']", "", h)
    h = re.sub(r"[أإآ]", "ا", h).replace("ة", "ه").replace("ى", "ي")
    return re.sub(r"[\s_\-.()]", "", h)


def _num(x) -> float:
    if isinstance(x, (int, float)) and not isinstance(x, bool):
        return float(x)
    t = str(x if x is not None else "").translate(str.maketrans("٠١٢٣٤٥٦٧٨٩٫", "0123456789."))
    t = re.sub(r"[,٬\s%\"]", "", t)
    try:
        return float(t)
    except ValueError:
        return math.nan


def read_snapshot_file(path: Path) -> dict | None:
    if path.suffix.lower() in (".xlsx", ".xls"):
        raw = pd.read_excel(path, header=None)
    else:
        raw = pd.read_csv(path, header=None, sep=None, engine="python", encoding="utf-8-sig")
    rows = raw.values.tolist()
    hi, idx = -1, {}
    for k, row in enumerate(rows[:10]):
        H = [_norm(x) for x in row]
        m = {}
        for key, names in _HDR.items():
            ns = [_norm(n) for n in names]
            for j, h in enumerate(H):
                if h in ns:
                    m[key] = j
                    break
        if "s" in m and "c" in m:
            hi, idx = k, m
            break
    if hi < 0:
        log(f"  inbox: {path.name} لا يحتوي عمودي الرمز والإغلاق، تم تجاهله")
        return None
    snap = {"date": None, "time": "", "count": 0, "hasNet": "net" in idx, "map": {}}
    for row in rows[hi + 1:]:
        sym = re.sub(r"\.0+$", "", str(row[idx["s"]]).strip()).replace(".SR", "")
        last = _num(row[idx["c"]])
        if not sym or sym == "nan" or not (last > 0):
            continue
        g = lambda k: _num(row[idx[k]]) if k in idx else math.nan  # noqa: E731
        chg_pct = g("chgPct") / 100 if "chgPct" in idx else math.nan
        chg = g("chg")
        if math.isnan(chg_pct) and not math.isnan(chg):
            chg_pct = chg / (last - chg)
        if "d" in idx:
            ts = pd.to_datetime(row[idx["d"]], errors="coerce", dayfirst=True)
            if pd.notna(ts):
                d = int_date(ts)
                if snap["date"] is None or d >= snap["date"]:
                    snap["date"], snap["time"] = d, ts.strftime("%H:%M")
        clean = lambda x: None if isinstance(x, float) and math.isnan(x) else round(x, 4)  # noqa: E731
        snap["map"][sym] = {
            "s": sym, "n": str(row[idx["n"]]).strip() if "n" in idx and row[idx["n"]] is not None else "",
            "last": last, "chg": clean(chg), "chgPct": clean(chg_pct), "net": clean(g("net")),
            "v": clean(g("v")), "val": clean(g("val")),
        }
    snap["count"] = len(snap["map"])
    return snap


def process_inbox(symbols_doc: dict, data_dir: Path) -> None:
    inbox = ROOT / "inbox"
    files = sorted([p for p in inbox.glob("*") if p.suffix.lower() in (".xlsx", ".xls", ".csv")]) if inbox.exists() else []
    if not files:
        return
    known = {e["s"]: e for e in symbols_doc["symbols"]}
    latest, renamed, added = None, 0, 0
    for f in files:
        try:
            snap = read_snapshot_file(f)
        except Exception as e:  # noqa: BLE001
            log(f"  inbox: تعذرت قراءة {f.name}: {e}")
            continue
        if not snap or not snap["map"]:
            continue
        log(f"  inbox: {f.name} → {snap['count']} سهماً بتاريخ {snap['date']} {snap['time']}")
        if snap["date"]:
            save_json(data_dir / "snapshots" / f"{snap['date']}.json", snap)
        key = lambda x: (x["date"] or 0, x["time"] or "")  # noqa: E731
        if latest is None or key(snap) >= key(latest):
            latest = snap
        for code, x in snap["map"].items():
            if not code.isdigit():
                continue
            if code in known:
                if x["n"] and known[code].get("n") != x["n"]:
                    known[code]["n"] = x["n"]
                    known[code].pop("auto", None)
                    renamed += 1
            else:
                e = {"s": code, "n": x["n"] or code, "sec": "غير مصنف"}
                symbols_doc["symbols"].append(e)
                known[code] = e
                added += 1
    if latest:
        save_json(data_dir / "snapshot.json", latest)
    symbols_doc["symbols"].sort(key=lambda x: x["s"])
    save_json(SYMBOLS_PATH, symbols_doc, compact=False)
    log(f"inbox: عُرّب {renamed} اسماً، وأضيف {added} سهماً جديداً.")


# ----------------------------------------------------------------------------
# التحديث الرئيسي
# ----------------------------------------------------------------------------
def merge_incremental(old: pd.DataFrame, new: pd.DataFrame, tol: float) -> tuple[pd.DataFrame, bool]:
    """يدمج الجديد مع القديم. يعيد (الإطار، هل يلزم إعادة جلب كامل بسبب تعديل الأسعار)."""
    if old.empty:
        return new, False
    if new.empty:
        return old, False
    overlap = old.index.intersection(new.index)
    if len(overlap) > 0:
        a = old.loc[overlap, "Close"]
        b = new.loc[overlap, "Close"]
        diff = ((a - b).abs() / b).max()
        if pd.notna(diff) and diff > tol:
            return new, True  # حدث توزيع أو تجزئة: الأسعار القديمة تغيّر تعديلها
    merged = pd.concat([old[old.index < new.index.min()], new])
    merged = merged[~merged.index.duplicated(keep="last")].sort_index()
    return merged, False


def run(args) -> int:
    cfg = load_json(CONFIG_PATH, {})
    symbols_doc = load_json(SYMBOLS_PATH, {"symbols": []})
    data_dir = Path(args.data_dir)
    prices_dir = data_dir / "prices"
    prices_dir.mkdir(parents=True, exist_ok=True)

    if args.discover:
        discover(cfg, symbols_doc)
    process_inbox(symbols_doc, data_dir)

    entries = [e for e in symbols_doc["symbols"] if not e.get("exclude")]
    if cfg.get("exclude_nomu", True):
        entries = [e for e in entries if not e["s"].startswith("9")]
    if args.only:
        entries = [e for e in entries if e["s"] in set(args.only)]

    sfx = cfg["yahoo_suffix"]
    idx_code = cfg["index_code"]
    all_codes = [idx_code] + [e["s"] for e in entries]
    yahoo_map = {idx_code: cfg["index_symbol_yahoo"], **{e["s"]: e["s"] + sfx for e in entries}}

    # تحديد بداية الجلب لكل رمز
    existing: dict[str, pd.DataFrame] = {}
    starts: dict[str, str] = {}
    for code in all_codes:
        old = pd.DataFrame() if args.full else payload_to_frame(load_json(prices_dir / f"{code}.json", {}))
        existing[code] = old
        if old.empty:
            starts[code] = cfg["start_date"]
        else:
            s = old.index.max() - pd.Timedelta(days=cfg["overlap_days"] * 2)
            starts[code] = s.strftime("%Y-%m-%d")

    # تجميع حسب تاريخ البداية حتى نستفيد من الجلب الجماعي
    groups: dict[str, list[str]] = {}
    for code, s in starts.items():
        groups.setdefault(s, []).append(code)

    fetched: dict[str, pd.DataFrame] = {}
    source: dict[str, str] = {}
    for s, codes in sorted(groups.items()):
        log(f"جلب {len(codes)} رمزاً من {s}")
        res = yahoo_download([yahoo_map[c] for c in codes], s, cfg)
        for c in codes:
            fetched[c] = res.get(yahoo_map[c], pd.DataFrame())
            source[c] = "yahoo"

    report = {"failed": [], "refetched": [], "fallback_used": [], "quality": {}, "inactive": []}

    def try_fallback(code: str, start: str) -> pd.DataFrame:
        fb = cfg.get("fallback") or {}
        sym = fb.get("index_symbol") if code == idx_code else code + fb.get("exchange_suffix", ".SR")
        df = eodhd_download(sym, start, cfg)
        if not df.empty:
            report["fallback_used"].append(code)
            source[code] = "eodhd"
        return df

    meta_symbols = []
    today = pd.Timestamp(dt.date.today())
    name_map = {e["s"]: e for e in entries}

    for code in all_codes:
        new_df = fetched.get(code, pd.DataFrame())
        if new_df is None or new_df.empty:
            new_df = try_fallback(code, starts[code])
        new_df, issues = clean_frame(new_df, cfg["price_limit"] if code != idx_code else 1.0)

        merged, need_full = merge_incremental(existing[code], new_df, cfg["adjust_mismatch_tolerance"])
        if need_full:
            log(f"  {code}: تغيّر تعديل الأسعار (توزيع/تجزئة) → إعادة جلب كامل")
            report["refetched"].append(code)
            full = yahoo_download([yahoo_map[code]], cfg["start_date"], cfg).get(yahoo_map[code], pd.DataFrame())
            if full is None or full.empty:
                full = try_fallback(code, cfg["start_date"])
            merged, issues = clean_frame(full, cfg["price_limit"] if code != idx_code else 1.0)

        if merged.empty:
            report["failed"].append(code)
            if not existing[code].empty:
                merged = existing[code]  # نحتفظ بالبيانات السابقة
            else:
                continue

        if issues["limit_breaches"]:
            report["quality"][code] = issues["limit_breaches"]

        save_json(prices_dir / f"{code}.json", frame_to_payload(code, merged))

        if code == idx_code:
            continue
        last = merged.index.max()
        inactive = (today - last).days > 30
        if inactive:
            report["inactive"].append(code)
        e = name_map[code]
        meta_symbols.append(
            {
                "s": code,
                "n": e.get("n", code),
                "sec": e.get("sec", "غير مصنف"),
                "bars": int(len(merged)),
                "first": int_date(merged.index.min()),
                "last": int_date(last),
                "src": source.get(code, "cache"),
                "inactive": bool(inactive),
            }
        )

    idx_payload = load_json(prices_dir / f"{idx_code}.json", {})
    last_dates = [m["last"] for m in meta_symbols if not m["inactive"]]
    meta = {
        "generated_at": dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        "last_date": max(last_dates) if last_dates else None,
        "index": {"code": idx_code, "available": bool(idx_payload.get("d")),
                  "last": idx_payload["d"][-1] if idx_payload.get("d") else None},
        "count": len(meta_symbols),
        "symbols": meta_symbols,
    }
    save_json(data_dir / "meta.json", meta)
    report["generated_at"] = meta["generated_at"]
    save_json(data_dir / "report.json", report, compact=False)

    log(f"انتهى: {len(meta_symbols)} سهماً محفوظاً، فشل التحديث لـ {len(report['failed'])}، "
        f"احتياطي {len(report['fallback_used'])}، إعادة جلب {len(report['refetched'])}.")
    total = max(1, len(all_codes))
    if len(report["failed"]) / total > 0.5:
        log("تحذير: فشل أكثر من نصف الرموز. قد يكون المصدر متوقفاً مؤقتاً.")
        return 1
    return 0


def main() -> None:
    p = argparse.ArgumentParser(description="جامع بيانات منصة فلتر تاسي")
    p.add_argument("--full", action="store_true", help="إعادة جلب التاريخ كاملاً")
    p.add_argument("--discover", action="store_true", help="اكتشاف الأسهم المدرجة")
    p.add_argument("--only", nargs="*", help="رموز محددة فقط")
    p.add_argument("--data-dir", default=str(ROOT / "data"))
    sys.exit(run(p.parse_args()))


if __name__ == "__main__":
    main()
