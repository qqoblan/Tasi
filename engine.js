/* =====================================================================
   محرك فلتر تاسي: المؤشرات، الشروط، النقاط، الاختبار التاريخي
   كود صافٍ بلا اعتماد على المتصفح، يعمل في المتصفح وفي Node للاختبار.
   ===================================================================== */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------
  // أدوات
  // ------------------------------------------------------------------
  const NaNv = Number.NaN;
  const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
  const fa = (n, v = NaNv) => { const a = new Float64Array(n); if (v !== 0) a.fill(v); return a; };

  function sma(src, p) {
    const n = src.length, out = fa(n); let s = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const x = src[i];
      if (Number.isFinite(x)) { s += x; cnt++; }
      if (i >= p) { const y = src[i - p]; if (Number.isFinite(y)) { s -= y; cnt--; } }
      if (i >= p - 1 && cnt === p) out[i] = s / p;
    }
    return out;
  }
  function stdev(src, p) {
    const n = src.length, out = fa(n), m = sma(src, p);
    for (let i = p - 1; i < n; i++) {
      if (!Number.isFinite(m[i])) continue;
      let s = 0; for (let k = i - p + 1; k <= i; k++) { const d = src[k] - m[i]; s += d * d; }
      out[i] = Math.sqrt(s / p);
    }
    return out;
  }
  function rollMax(src, p, lag = 0) { // أعلى قيمة في p شمعة تنتهي عند i-lag
    const n = src.length, out = fa(n), dq = [];
    for (let i = 0; i < n; i++) {
      const j = i - lag; if (j < 0) continue;
      while (dq.length && src[dq[dq.length - 1]] <= src[j]) dq.pop();
      dq.push(j);
      while (dq[0] <= j - p) dq.shift();
      if (j >= p - 1) out[i] = src[dq[0]];
    }
    return out;
  }
  function rollMin(src, p, lag = 0) {
    const neg = Float64Array.from(src, (x) => -x);
    return rollMax(neg, p, lag).map((x) => -x);
  }
  function wilder(src, p) { // متوسط وايلدر (RMA)
    const n = src.length, out = fa(n); let s = 0, cnt = 0, prev = NaNv;
    for (let i = 0; i < n; i++) {
      const x = src[i]; if (!Number.isFinite(x)) continue;
      if (!Number.isFinite(prev)) { s += x; cnt++; if (cnt === p) { prev = s / p; out[i] = prev; } }
      else { prev = (prev * (p - 1) + x) / p; out[i] = prev; }
    }
    return out;
  }
  function rsi(c, p = 14) {
    const n = c.length, up = fa(n), dn = fa(n);
    for (let i = 1; i < n; i++) { const d = c[i] - c[i - 1]; up[i] = Math.max(d, 0); dn[i] = Math.max(-d, 0); }
    const au = wilder(up, p), ad = wilder(dn, p), out = fa(n);
    for (let i = 0; i < n; i++) if (Number.isFinite(au[i]) && Number.isFinite(ad[i])) out[i] = ad[i] === 0 ? 100 : 100 - 100 / (1 + au[i] / ad[i]);
    return out;
  }
  function atr(h, l, c, p) {
    const n = c.length, tr = fa(n);
    for (let i = 0; i < n; i++) tr[i] = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    return wilder(tr, p);
  }
  function roc(c, p) { const n = c.length, out = fa(n); for (let i = p; i < n; i++) out[i] = c[i] / c[i - p] - 1; return out; }
  function pctRankWindow(src, p) { // ترتيب القيمة الحالية ضمن آخر p قيمة (0..1)
    const n = src.length, out = fa(n);
    for (let i = p - 1; i < n; i++) {
      const x = src[i]; if (!Number.isFinite(x)) continue;
      let below = 0, cnt = 0;
      for (let k = i - p + 1; k <= i; k++) { const y = src[k]; if (Number.isFinite(y)) { cnt++; if (y < x) below++; } }
      if (cnt > p * 0.8) out[i] = below / (cnt - 1 || 1);
    }
    return out;
  }

  // ------------------------------------------------------------------
  // تعريف الشروط (العائلات والأوزان الافتراضية)
  // ------------------------------------------------------------------
  const FAMILIES = [
    { id: "trend", name: "الاتجاه", w: 20, school: "داو، تتبع الاتجاه، المتوسطات المتحركة، ستان وينستاين" },
    { id: "momentum", name: "الزخم", w: 15, school: "الزخم، CANSLIM، أبحاث قمة 52 أسبوعاً" },
    { id: "rs", name: "القوة النسبية", w: 15, school: "Relative Strength، CANSLIM" },
    { id: "volume", name: "الحجم والتجميع", w: 15, school: "وايكوف، VSA، OBV، العرض والطلب" },
    { id: "contraction", name: "انضغاط التقلب", w: 15, school: "بولنجر، ATR، VCP، القاعدة السعرية" },
    { id: "breakout", name: "الاختراق", w: 20, school: "الكلاسيكي، دونشيان، الدعم والمقاومة، Price Action" },
  ];

  const CONDS = [
    { id: "t1", fam: "trend", w: 5, name: "الإغلاق فوق المتوسط 50", formula: "C > SMA(C,50)", timing: "متأخرة" },
    { id: "t2", fam: "trend", w: 4, name: "المتوسط 50 فوق 150", formula: "SMA50 > SMA150", timing: "متأخرة" },
    { id: "t3", fam: "trend", w: 4, name: "المتوسط 150 فوق 200", formula: "SMA150 > SMA200", timing: "متأخرة" },
    { id: "t4", fam: "trend", w: 4, name: "المتوسط 200 صاعد", formula: "SMA200 > SMA200[21]", timing: "متأخرة" },
    { id: "t5", fam: "trend", w: 3, name: "الإغلاق فوق المتوسط 200", formula: "C > SMA(C,200)", timing: "متأخرة" },
    { id: "m1", fam: "momentum", w: 8, name: "القرب من قمة 52 أسبوعاً", formula: "clamp((C/MAX(H,252) − 0.75) / 0.15)", timing: "متوسطة" },
    { id: "m2", fam: "momentum", w: 4, name: "عائد 6 أشهر موجب", formula: "clamp(ROC(C,126) / 0.10)", timing: "متأخرة" },
    { id: "m3", fam: "momentum", w: 3, name: "عائد 3 أشهر موجب", formula: "clamp(ROC(C,63) / 0.08)", timing: "متوسطة" },
    { id: "r1", fam: "rs", w: 5, name: "خط القوة النسبية فوق متوسطه 50", formula: "RS = C/TASI ; RS > SMA(RS,50)", timing: "مبكرة" },
    { id: "r2", fam: "rs", w: 5, name: "تفوق على تاسي خلال 3 أشهر", formula: "clamp((RS/RS[63] − 1) / 0.10)", timing: "متوسطة" },
    { id: "r3", fam: "rs", w: 5, name: "ترتيب القوة النسبية في السوق", formula: "P = 0.4·ROC63 + 0.2·(ROC126+ROC189+ROC252) ; clamp((Percentile − 50)/40)", timing: "متوسطة" },
    { id: "v1", fam: "volume", w: 6, name: "حجم مرتفع في يوم صاعد", formula: "MAX آخر 5 أيام صاعدة لـ V/SMA(V,50) ; clamp((x − 1)/1)", timing: "مبكرة" },
    { id: "v2", fam: "volume", w: 5, name: "تجميع: حجم الصعود يفوق الهبوط", formula: "ΣV(صاعد,50) / ΣV(هابط,50) ; clamp((x − 1)/0.5)", timing: "مبكرة" },
    { id: "v3", fam: "volume", w: 4, name: "OBV فوق متوسطه 20", formula: "OBV > SMA(OBV,20)", timing: "مبكرة" },
    { id: "k1", fam: "contraction", w: 7, name: "انضغاط بولنجر", formula: "BBW = 4σ20/SMA20 ; أدنى ترتيب مئوي (126) خلال 10 أيام ; clamp((0.4 − x)/0.3)", timing: "مبكرة" },
    { id: "k2", fam: "contraction", w: 4, name: "انكماش ATR", formula: "أدنى ATR10/ATR50 خلال 10 أيام ; clamp((1 − x)/0.3)", timing: "مبكرة" },
    { id: "k3", fam: "contraction", w: 4, name: "قاعدة سعرية ضيقة", formula: "(MAX(H,20) − MIN(L,20))/C قبل 5 أيام ; clamp((0.25 − x)/0.12)", timing: "مبكرة" },
    { id: "b1", fam: "breakout", w: 10, name: "اختراق قمة 20 يوماً", formula: "C > MAX(H[1],20) خلال آخر 5 أيام (يتناقص من 1 إلى 0.6)", timing: "مبكرة" },
    { id: "b2", fam: "breakout", w: 6, name: "اختراق قناة دونشيان 55", formula: "C > MAX(H[1],55) خلال آخر 5 أيام", timing: "متوسطة" },
    { id: "b3", fam: "breakout", w: 4, name: "إغلاق قوي يوم الاختراق", formula: "CLV = (C − L)/(H − L) ; clamp((CLV − 0.4)/0.4)", timing: "مبكرة" },
  ];

  const PENALTIES = [
    { id: "p1", w: 10, name: "تمدد بعيد عن المتوسط 50", formula: "clamp((C/SMA50 − 1 − 0.15)/0.15)" },
    { id: "p2", w: 8, name: "تشبع شرائي RSI", formula: "clamp((RSI14 − 75)/10)" },
    { id: "p3", w: 7, name: "صعود حاد خلال 10 أيام", formula: "clamp((ROC(C,10) − 0.15)/0.10)" },
  ];

  const DEFAULTS = {
    weights: Object.fromEntries(FAMILIES.map((f) => [f.id, f.w])),
    penaltyScale: 1,
    minValue: 10e6,       // متوسط قيمة التداول اليومية 20 يوماً بالريال
    minBars: 260,
    regimeFilter: true,   // رفع العتبة عندما يكون تاسي تحت متوسطه 200
    regimeBump: 10,
    threshold: 75,
    entryMode: "cross",   // cross: عند تجاوز العتبة ، above: طالما فوقها
    maxPos: 10,
    stopATR: 2,
    targetATR: 4,
    maxHold: 30,
    costPerSide: 0.0025,  // عمولة + انزلاق لكل جهة
    oosSplit: 0.7,
  };

  const GRADES = [
    { min: 90, name: "ممتاز جداً", cls: "g5" },
    { min: 80, name: "قوي", cls: "g4" },
    { min: 70, name: "جيد", cls: "g3" },
    { min: 60, name: "متوسط", cls: "g2" },
    { min: -1, name: "مستبعد", cls: "g1" },
  ];
  const gradeOf = (s) => GRADES.find((g) => s >= g.min) || GRADES[GRADES.length - 1];

  // ------------------------------------------------------------------
  // بناء الكون (Universe)
  // ------------------------------------------------------------------
  function toStock(p, meta = {}) {
    const n = p.d.length;
    return {
      s: p.s, n: meta.n || p.s, sec: meta.sec || "غير مصنف", inactive: !!meta.inactive,
      d: Int32Array.from(p.d), o: Float64Array.from(p.o), h: Float64Array.from(p.h),
      l: Float64Array.from(p.l), c: Float64Array.from(p.c), v: Float64Array.from(p.v), len: n,
    };
  }

  function buildUniverse(stocks, index) {
    const set = new Set();
    for (const st of stocks) for (const d of st.d) set.add(d);
    const dates = Int32Array.from([...set].sort((a, b) => a - b));
    const gIdx = new Map(); dates.forEach((d, i) => gIdx.set(d, i));
    for (const st of stocks) {
      st.gi = Int32Array.from(st.d, (d) => gIdx.get(d));
      st.li = new Int32Array(dates.length).fill(-1);
      st.gi.forEach((g, i) => (st.li[g] = i));
    }
    let syntheticIndex = false;
    let idxClose = fa(dates.length);
    if (index && index.d && index.d.length > 100) {
      const m = new Map(); index.d.forEach((d, i) => m.set(d, index.c[i]));
      let last = NaNv;
      for (let g = 0; g < dates.length; g++) { const v = m.get(dates[g]); if (Number.isFinite(v)) last = v; idxClose[g] = last; }
    } else {
      // مؤشر بديل متساوي الأوزان من الأسهم نفسها
      syntheticIndex = true; let lvl = 1000;
      for (let g = 0; g < dates.length; g++) {
        let s = 0, k = 0;
        for (const st of stocks) { const i = st.li[g]; if (i > 0) { const r = st.c[i] / st.c[i - 1] - 1; if (Math.abs(r) < 0.3) { s += r; k++; } } }
        if (k) lvl *= 1 + s / k; idxClose[g] = lvl;
      }
    }
    const idxSma200 = sma(idxClose, 200);
    const bull = new Uint8Array(dates.length);
    for (let g = 0; g < dates.length; g++) bull[g] = Number.isFinite(idxSma200[g]) ? (idxClose[g] >= idxSma200[g] ? 1 : 0) : 1;
    return { stocks, dates, gIdx, idxClose, idxSma200, bull, syntheticIndex };
  }

  // ------------------------------------------------------------------
  // حساب الشروط لكل سهم (قيم 0..1 لكل شمعة)
  // ------------------------------------------------------------------
  function computeStock(st, U) {
    const { o, h, l, c, v, len: n } = st;
    const s50 = sma(c, 50), s150 = sma(c, 150), s200 = sma(c, 200);
    const hh252 = rollMax(h, 252), r126 = roc(c, 126), r63 = roc(c, 63), r189 = roc(c, 189), r252 = roc(c, 252), r10 = roc(c, 10);
    const vs50 = sma(v, 50), val = Float64Array.from(c, (x, i) => x * v[i]), val20 = sma(val, 20);
    const rsi14 = rsi(c, 14), atr14 = atr(h, l, c, 14), atr10 = atr(h, l, c, 10), atr50 = atr(h, l, c, 50);
    const sd20 = stdev(c, 20), m20 = sma(c, 20);
    const bbw = Float64Array.from(c, (_, i) => (Number.isFinite(sd20[i]) ? (4 * sd20[i]) / m20[i] : NaNv));
    const bbwPct = pctRankWindow(bbw, 126);
    const hh20p = rollMax(h, 20, 1), hh55p = rollMax(h, 55, 1);
    const baseHi = rollMax(h, 20, 5), baseLo = rollMin(l, 20, 5);
    // OBV
    const obv = fa(n, 0); for (let i = 1; i < n; i++) obv[i] = obv[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0);
    const obv20 = sma(obv, 20);
    // خط القوة النسبية
    const rs = Float64Array.from(c, (x, i) => x / U.idxClose[st.gi[i]]);
    const rs50 = sma(rs, 50);

    const C = {}; for (const k of CONDS) C[k.id] = new Float32Array(n);
    const P = {}; for (const k of PENALTIES) P[k.id] = new Float32Array(n);
    const perf = fa(n);
    const brkLevel = fa(n);
    let upV = 0, dnV = 0;
    const lastBrk20 = new Int32Array(n).fill(-1), lastBrk55 = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      // تراكم حجم الصعود/الهبوط لنافذة 50
      if (i > 0) { if (c[i] > c[i - 1]) upV += v[i]; else if (c[i] < c[i - 1]) dnV += v[i]; }
      if (i > 50) { const j = i - 50; if (c[j] > c[j - 1]) upV -= v[j]; else if (c[j] < c[j - 1]) dnV -= v[j]; }
      lastBrk20[i] = c[i] > hh20p[i] ? i : i > 0 ? lastBrk20[i - 1] : -1;
      lastBrk55[i] = c[i] > hh55p[i] ? i : i > 0 ? lastBrk55[i - 1] : -1;
      brkLevel[i] = hh20p[i];
      if (i < 252) continue;

      C.t1[i] = c[i] > s50[i] ? 1 : 0;
      C.t2[i] = s50[i] > s150[i] ? 1 : 0;
      C.t3[i] = s150[i] > s200[i] ? 1 : 0;
      C.t4[i] = s200[i] > s200[i - 21] ? 1 : 0;
      C.t5[i] = c[i] > s200[i] ? 1 : 0;

      C.m1[i] = clamp01((c[i] / hh252[i] - 0.75) / 0.15);
      C.m2[i] = clamp01(r126[i] / 0.1);
      C.m3[i] = clamp01(r63[i] / 0.08);

      C.r1[i] = rs[i] > rs50[i] ? 1 : 0;
      C.r2[i] = clamp01((rs[i] / rs[i - 63] - 1) / 0.1);
      perf[i] = 0.4 * r63[i] + 0.2 * (r126[i] + r189[i] + r252[i]);

      let vr = 0; for (let k = Math.max(1, i - 4); k <= i; k++) if (c[k] > c[k - 1] && vs50[k] > 0) vr = Math.max(vr, v[k] / vs50[k]);
      C.v1[i] = clamp01(vr - 1);
      C.v2[i] = dnV > 0 ? clamp01((upV / dnV - 1) / 0.5) : 1;
      C.v3[i] = obv[i] > obv20[i] ? 1 : 0;

      let minPct = 1, minAr = 9;
      for (let k = i - 9; k <= i; k++) {
        if (Number.isFinite(bbwPct[k])) minPct = Math.min(minPct, bbwPct[k]);
        if (atr50[k] > 0) minAr = Math.min(minAr, atr10[k] / atr50[k]);
      }
      C.k1[i] = clamp01((0.4 - minPct) / 0.3);
      C.k2[i] = clamp01((1 - minAr) / 0.3);
      C.k3[i] = clamp01((0.25 - (baseHi[i] - baseLo[i]) / c[i]) / 0.12);

      const b20 = lastBrk20[i], age20 = i - b20;
      if (b20 >= 0 && age20 <= 4) {
        C.b1[i] = 1 - 0.1 * age20;
        const rng = h[b20] - l[b20];
        C.b3[i] = rng > 0 ? clamp01(((c[b20] - l[b20]) / rng - 0.4) / 0.4) : 0.5;
        brkLevel[i] = hh20p[b20];
      }
      const b55 = lastBrk55[i];
      if (b55 >= 0 && i - b55 <= 4) C.b2[i] = 1;

      P.p1[i] = clamp01((c[i] / s50[i] - 1 - 0.15) / 0.15);
      P.p2[i] = clamp01((rsi14[i] - 75) / 10);
      P.p3[i] = clamp01((r10[i] - 0.15) / 0.1);
    }
    st.cond = C; st.pen = P; st.perf = perf;
    st.aux = { s50, s150, s200, atr14, rsi14, val20, brkLevel, rs, hh252 };
  }

  // ترتيب القوة النسبية عبر السوق لكل يوم
  function crossSectionalRank(U) {
    const { stocks, dates } = U;
    for (let g = 0; g < dates.length; g++) {
      const arr = [];
      for (const st of stocks) { const i = st.li[g]; if (i >= 252 && Number.isFinite(st.perf[i])) arr.push([st.perf[i], st, i]); }
      if (arr.length < 5) { for (const [, st, i] of arr) st.cond.r3[i] = 0.5; continue; }
      arr.sort((a, b) => a[0] - b[0]);
      const m = arr.length - 1;
      arr.forEach(([, st, i], k) => { const pct = (k / m) * 100; st.cond.r3[i] = clamp01((pct - 50) / 40); });
    }
  }

  function prepare(stocks, index) {
    const U = buildUniverse(stocks, index);
    for (const st of stocks) computeStock(st, U);
    crossSectionalRank(U);
    return U;
  }

  // ------------------------------------------------------------------
  // النقاط
  // ------------------------------------------------------------------
  const famConds = Object.fromEntries(FAMILIES.map((f) => [f.id, CONDS.filter((c) => c.fam === f.id)]));

  function scoreAt(st, i, cfg) {
    let tot = 0, wsum = 0; const fam = {};
    for (const f of FAMILIES) {
      const W = cfg.weights[f.id] ?? f.w; const cs = famConds[f.id];
      let s = 0, ws = 0; for (const k of cs) { s += k.w * st.cond[k.id][i]; ws += k.w; }
      fam[f.id] = s / ws; tot += W * fam[f.id]; wsum += W;
    }
    let pen = 0; for (const p of PENALTIES) pen += p.w * st.pen[p.id][i];
    const raw = wsum > 0 ? (tot / wsum) * 100 : 0;
    return { score: Math.max(0, Math.min(100, raw - pen * cfg.penaltyScale)), raw, pen: pen * cfg.penaltyScale, fam };
  }

  function eligibleAt(st, i, cfg) {
    return i >= Math.max(252, cfg.minBars - 1) && st.aux.val20[i] >= cfg.minValue;
  }

  function computeScores(U, cfg) {
    for (const st of U.stocks) {
      const n = st.len, sc = new Float32Array(n).fill(NaNv);
      for (let i = 252; i < n; i++) if (eligibleAt(st, i, cfg)) sc[i] = scoreAt(st, i, cfg).score;
      st.score = sc;
    }
  }

  function snapshot(U, cfg) {
    const rows = [];
    const lastG = U.dates.length - 1;
    for (const st of U.stocks) {
      const i = st.len - 1; if (i < 1) continue;
      const stale = st.gi[i] < lastG - 5 || st.inactive;
      const elig = eligibleAt(st, i, cfg) && !stale;
      const sa = i >= 252 ? scoreAt(st, i, cfg) : { score: 0, fam: {}, pen: 0, raw: 0 };
      rows.push({
        s: st.s, n: st.n, sec: st.sec, close: st.c[i], chg: st.c[i] / st.c[i - 1] - 1,
        date: st.d[i], value20: st.aux.val20[i], score: elig ? sa.score : NaNv, raw: sa.raw, pen: sa.pen,
        fam: sa.fam, eligible: elig, stale, reason: stale ? "بيانات قديمة" : i < 252 ? "تاريخ قصير" : st.aux.val20[i] < cfg.minValue ? "سيولة منخفضة" : "",
        rsi: st.aux.rsi14[i], ext50: st.c[i] / st.aux.s50[i] - 1, brk: st.aux.brkLevel[i],
      });
    }
    rows.sort((a, b) => (b.eligible - a.eligible) || ((b.score || 0) - (a.score || 0)));
    return rows;
  }

  function breakdown(st, i, cfg) {
    const sa = scoreAt(st, i, cfg);
    let wsum = 0; for (const f of FAMILIES) wsum += cfg.weights[f.id] ?? f.w;
    const fams = FAMILIES.map((f) => {
      const W = cfg.weights[f.id] ?? f.w; const cs = famConds[f.id];
      const ws = cs.reduce((a, k) => a + k.w, 0);
      return {
        ...f, W, frac: sa.fam[f.id], pts: wsum ? (W * sa.fam[f.id] / wsum) * 100 : 0, max: wsum ? (W / wsum) * 100 : 0,
        conds: cs.map((k) => ({ ...k, val: st.cond[k.id][i], pts: wsum ? (W / wsum) * 100 * (k.w / ws) * st.cond[k.id][i] : 0, max: wsum ? (W / wsum) * 100 * (k.w / ws) : 0 })),
      };
    });
    const pens = PENALTIES.map((p) => ({ ...p, val: st.pen[p.id][i], pts: p.w * st.pen[p.id][i] * cfg.penaltyScale }));
    return { ...sa, fams, pens };
  }

  // ------------------------------------------------------------------
  // الاختبار التاريخي (محفظة)
  // ------------------------------------------------------------------
  function backtest(U, cfg, opt = {}) {
    const { stocks, dates } = U;
    const G = dates.length;
    const g0 = opt.startG ?? 253, g1 = opt.endG ?? G - 1;
    let cash = 100, equity = 100;
    const pos = []; const trades = []; const curve = new Float64Array(G).fill(NaNv);
    const thrAt = (g) => cfg.threshold + (cfg.regimeFilter && !U.bull[g] ? cfg.regimeBump : 0);
    const lastClose = (st, g) => { for (let k = g; k >= 0; k--) { const i = st.li[k]; if (i >= 0) return st.c[i]; } return NaNv; };

    const closePos = (p, g, px, reason) => {
      const proceeds = p.sh * px * (1 - cfg.costPerSide);
      cash += proceeds;
      trades.push({ s: p.st.s, n: p.st.n, ent: dates[p.g], ex: dates[g], entPx: p.px, exPx: px, ret: proceeds / p.cost - 1, days: p.held, reason, score: p.score });
    };

    for (let g = g0; g <= g1; g++) {
      // 1) خروج المراكز القائمة
      for (let k = pos.length - 1; k >= 0; k--) {
        const p = pos[k], i = p.st.li[g]; if (i < 0) continue;
        p.held++;
        const { o, h, l, c } = p.st; let px = NaNv, why = "";
        if (o[i] <= p.stop) { px = o[i]; why = "وقف"; }
        else if (p.tgt && o[i] >= p.tgt) { px = o[i]; why = "هدف"; }
        else if (l[i] <= p.stop) { px = p.stop; why = "وقف"; }
        else if (p.tgt && h[i] >= p.tgt) { px = p.tgt; why = "هدف"; }
        else if (p.held >= cfg.maxHold) { px = c[i]; why = "مدة"; }
        if (Number.isFinite(px)) { closePos(p, g, px, why); pos.splice(k, 1); }
      }
      // 2) دخول على افتتاح اليوم بناءً على إشارات أمس
      const slots = cfg.maxPos - pos.length;
      if (slots > 0 && g > 0) {
        const thr = thrAt(g - 1), held = new Set(pos.map((p) => p.st));
        const cands = [];
        for (const st of stocks) {
          if (held.has(st)) continue;
          const ip = st.li[g - 1], it = st.li[g]; if (ip < 1 || it < 0) continue;
          const sc = st.score[ip]; if (!(sc >= thr)) continue;
          if (cfg.entryMode === "cross" && st.score[ip - 1] >= thr) continue;
          cands.push([sc, st, ip, it]);
        }
        cands.sort((a, b) => b[0] - a[0]);
        for (const [sc, st, ip, it] of cands.slice(0, slots)) {
          const alloc = Math.min(cash, equity / cfg.maxPos); if (alloc < 1e-6) break;
          const px = st.o[it], a = st.aux.atr14[ip]; if (!(px > 0) || !(a > 0)) continue;
          const sh = (alloc * (1 - cfg.costPerSide)) / px;
          cash -= alloc;
          const p = { st, g, px, sh, cost: alloc, held: 0, score: sc, stop: px - cfg.stopATR * a, tgt: cfg.targetATR > 0 ? px + cfg.targetATR * a : 0 };
          // فحص نفس اليوم (الوقف أولاً بشكل متحفظ)
          if (st.l[it] <= p.stop) { closePos(p, g, p.stop, "وقف"); continue; }
          if (p.tgt && st.h[it] >= p.tgt) { closePos(p, g, p.tgt, "هدف"); continue; }
          pos.push(p);
        }
      }
      // 3) تقييم المحفظة
      let mv = 0; for (const p of pos) mv += p.sh * lastClose(p.st, g);
      equity = cash + mv; curve[g] = equity;
    }
    for (const p of pos) closePos(p, g1, lastClose(p.st, g1), "مفتوحة");
    return { trades, curve, g0, g1 };
  }

  function metrics(U, bt, gA, gB) {
    const dA = U.dates[gA], dB = U.dates[gB];
    const tr = bt.trades.filter((t) => t.ent >= dA && t.ent <= dB);
    const wins = tr.filter((t) => t.ret > 0), losses = tr.filter((t) => t.ret <= 0);
    const gw = wins.reduce((a, t) => a + t.ret, 0), gl = -losses.reduce((a, t) => a + t.ret, 0);
    let peak = -Infinity, mdd = 0, first = NaNv, last = NaNv;
    for (let g = gA; g <= gB; g++) { const e = bt.curve[g]; if (!Number.isFinite(e)) continue; if (!Number.isFinite(first)) first = e; last = e; peak = Math.max(peak, e); mdd = Math.min(mdd, e / peak - 1); }
    const years = Math.max(1 / 252, (gB - gA) / 252);
    const ret = last / first - 1;
    const ib = U.idxClose[gB] / U.idxClose[gA] - 1;
    return {
      trades: tr.length, winRate: tr.length ? wins.length / tr.length : NaNv,
      avgWin: wins.length ? gw / wins.length : NaNv, avgLoss: losses.length ? -gl / losses.length : NaNv,
      pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : NaNv), expectancy: tr.length ? (gw - gl) / tr.length : NaNv,
      ret, cagr: Math.pow(1 + ret, 1 / years) - 1, mdd, bench: ib, benchCagr: Math.pow(1 + ib, 1 / years) - 1,
      avgDays: tr.length ? tr.reduce((a, t) => a + t.days, 0) / tr.length : NaNv,
    };
  }

  function runFull(U, cfg) {
    computeScores(U, cfg);
    const G = U.dates.length, g0 = 253, g1 = G - 1;
    const split = Math.round(g0 + (g1 - g0) * cfg.oosSplit);
    const bt = backtest(U, cfg, { startG: g0, endG: g1 });
    return { bt, g0, g1, split, all: metrics(U, bt, g0, g1), is: metrics(U, bt, g0, split), oos: metrics(U, bt, split + 1, g1) };
  }

  function ablation(U, cfg) {
    const out = [];
    const base = runFull(U, cfg);
    out.push({ id: "base", name: "الفلتر كاملاً", m: base.all, oos: base.oos });
    for (const f of FAMILIES) {
      const c2 = { ...cfg, weights: { ...cfg.weights, [f.id]: 0 } };
      const r = runFull(U, c2);
      out.push({ id: f.id, name: "بدون " + f.name, m: r.all, oos: r.oos });
    }
    computeScores(U, cfg); // استعادة النقاط الأصلية
    return out;
  }

  // ------------------------------------------------------------------
  // بيانات تجريبية (للعرض حين لا تتوفر بيانات حقيقية)
  // ------------------------------------------------------------------
  function demoData(nStocks = 36, nDays = 1500, seed = 7) {
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const dates = []; let d = new Date(Date.UTC(2020, 0, 5));
    while (dates.length < nDays) { const wd = d.getUTCDay(); if (wd !== 5 && wd !== 6) dates.push(d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()); d = new Date(d.getTime() + 864e5); }
    const mkt = []; let m = 0; for (let i = 0; i < nDays; i++) { m += 0.0002 + 0.009 * gauss() + (i > nDays * 0.45 && i < nDays * 0.55 ? -0.002 : 0); mkt.push(m); }
    const idx = { s: "TASI", d: dates, o: [], h: [], l: [], c: [], v: [] };
    for (let i = 0; i < nDays; i++) { const c = 10000 * Math.exp(mkt[i]); idx.c.push(c); idx.o.push(c); idx.h.push(c * 1.004); idx.l.push(c * 0.996); idx.v.push(0); }
    const names = ["الأفق للصناعة", "نخيل القصيم", "الواحة للتقنية", "رواسي للأسمنت", "السنابل للأغذية", "مدار للاتصالات", "الصفوة المالية", "بوابة النقل", "ركائز العقارية", "الريادة للتجزئة", "منار الطاقة", "سحاب للخدمات", "الندى الزراعية", "قمم للتعدين", "الجسر اللوجستية", "وهج للمرافق", "أصالة القابضة", "زمزم للتأمين", "الوثبة للصناعات", "طيبة للرعاية", "سراج للتقنية", "الدرع للتأمين", "مرجان البحرية", "أبراج التطوير", "بيان للإعلام", "نجد للبتروكيماويات", "شروق للطاقة", "الإتقان للمقاولات", "ربوع السياحة", "مسارات للنقل", "حصاد المالية", "الأصيل للأغذية", "النخبة الطبية", "صروح العقارية", "ديم للتقنية", "مكين للصناعة"];
    const secs = ["المواد الأساسية", "إنتاج الأغذية", "التطبيقات وخدمات التقنية", "المواد الأساسية", "إنتاج الأغذية", "الاتصالات", "الخدمات المالية", "النقل", "إدارة وتطوير العقارات", "تجزئة السلع الكمالية", "الطاقة", "الخدمات الاستهلاكية"];
    const out = [];
    for (let k = 0; k < nStocks; k++) {
      const beta = 0.6 + rnd() * 0.8, drift = (rnd() - 0.45) * 0.0012, vol = 0.012 + rnd() * 0.012;
      const setup = k % 5 === 0 ? "breakout" : k % 7 === 3 ? "extended" : "none";
      let lp = Math.log(15 + rnd() * 80); const P = { s: String(9100 + k * 7), d: dates, o: [], h: [], l: [], c: [], v: [] };
      const baseV = 2e5 + rnd() * 3e6;
      for (let i = 0; i < nDays; i++) {
        let r = drift + beta * (i ? mkt[i] - mkt[i - 1] : 0) + vol * gauss(), vm = 1;
        const back = nDays - 1 - i;
        if (setup === "breakout") {
          if (back < 120 && back >= 45) r = 0.0025 + vol * 0.6 * gauss();
          else if (back < 45 && back >= 4) r = vol * 0.35 * gauss() + (back % 12 < 6 ? 0.001 : -0.001);
          else if (back < 4) { r = 0.025 + 0.01 * rnd(); vm = 2.6; }
          if (back < 45 && back >= 4) vm = 0.7;
        } else if (setup === "extended" && back < 25) { r = 0.012 + vol * 0.5 * gauss(); vm = 1.5; }
        r = Math.max(-0.095, Math.min(0.095, r));
        const prev = Math.exp(lp); lp += r; const c = Math.exp(lp);
        const o = prev * (1 + (rnd() - 0.5) * vol * 0.6), hi = Math.max(o, c) * (1 + rnd() * vol * 0.7), lo = Math.min(o, c) * (1 - rnd() * vol * 0.7);
        P.o.push(+o.toFixed(3)); P.h.push(+hi.toFixed(3)); P.l.push(+lo.toFixed(3)); P.c.push(+c.toFixed(3));
        P.v.push(Math.round(baseV * vm * (0.6 + rnd() * 0.8) * (1 + Math.abs(r) * 20)));
      }
      out.push({ p: P, meta: { n: names[k % names.length] + " (تجريبي)", sec: secs[k % secs.length] } });
    }
    return { stocks: out, index: idx };
  }

  // ------------------------------------------------------------------
  // قراءة الجداول: ملفات تاريخية (OHLCV) أو ملفات لحظية (لقطة السوق)
  // ------------------------------------------------------------------
  const normH = (h) => String(h == null ? "" : h).toLowerCase().replace(/["'‏‎]/g, "")
    .replace(/[ً-ْ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/[\s_\-.()]/g, "");
  const HDR = {
    s: ["الرمز", "رمز", "symbol", "ticker", "code", "كود"],
    n: ["الاسم", "اسم", "الشركه", "name", "company"],
    d: ["التاريخ", "تاريخ", "date", "time", "datetime", "الوقت"],
    o: ["الافتتاح", "افتتاح", "open"],
    h: ["الاعلي", "اعلي", "high"],
    l: ["الادني", "ادني", "low"],
    c: ["الاغلاق", "اغلاق", "close", "adjclose", "last", "اخرسعر", "السعر", "سعر"],
    chg: ["التغير", "تغير", "change", "chg"],
    chgPct: ["التغير%", "تغير%", "التغيرنسبه", "نسبهالتغير", "change%", "chg%", "%change", "changepct"],
    net: ["صافيالسيوله", "صافيسيوله", "السيولهالصافيه", "netliquidity", "netflow", "moneyflow", "صافيالتدفق"],
    v: ["الكميه", "كميه", "حجمالتداول", "الحجم", "volume", "vol"],
    val: ["القيمه", "قيمهالتداول", "value", "turnover"],
  };
  function mapHeaders(hdr) {
    const H = hdr.map(normH), idx = {};
    for (const [k, names] of Object.entries(HDR)) {
      const ns = names.map(normH);
      let i = H.findIndex((h) => ns.includes(h));                               // تطابق تام أولاً
      if (i < 0 && k !== "chg" && k !== "c") i = H.findIndex((h) => ns.some((n) => n.length > 2 && h.startsWith(n) && !h.includes("%")));
      if (i >= 0) idx[k] = i;
    }
    if (idx.chgPct != null && idx.chg === idx.chgPct) delete idx.chg;
    return idx;
  }
  function cellNum(x) {
    if (typeof x === "number") return x;
    if (x == null) return NaNv;
    const t = String(x).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/٫/g, ".").replace(/[,٬\s%"]/g, "").replace(/^\((.*)\)$/, "-$1");
    return t === "" ? NaNv : Number(t);
  }
  function cellDate(x) { // يعيد {d: YYYYMMDD, t: نص الوقت}
    if (x == null || x === "") return null;
    if (typeof x === "object" && typeof x.getFullYear === "function") {
      return { d: x.getFullYear() * 10000 + (x.getMonth() + 1) * 100 + x.getDate(), t: `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}` };
    }
    if (typeof x === "number") {
      if (x > 20000 && x < 80000) { // رقم تاريخ إكسل
        const ms = Math.round((x - 25569) * 864e5), t = new Date(ms);
        return { d: t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate(), t: `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}` };
      }
      if (x > 1e9 && x < 1e11) { const t = new Date(x * 1000); return { d: t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate(), t: "" }; }
      if (x > 19000101 && x < 21001231) return { d: x, t: "" };
      return null;
    }
    const raw = String(x).replace(/"/g, "").trim();
    if (/^\d{9,10}$/.test(raw)) return cellDate(+raw);
    const tm = (raw.match(/(\d{1,2}:\d{2})/) || [])[1] || "";
    let m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); if (m) return { d: +m[1] * 10000 + +m[2] * 100 + +m[3], t: tm };
    m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/); if (m) return { d: +m[3] * 10000 + +m[2] * 100 + +m[1], t: tm };
    return null;
  }
  const cleanSym = (x) => String(x == null ? "" : x).replace(/"/g, "").trim().replace(/\.SR$/i, "").replace(/^TADAWUL:/i, "").replace(/\.0+$/, "");

  function textToRows(text) {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((x) => x.trim());
    if (!lines.length) return [];
    const h = lines[0];
    const sep = h.includes("\t") ? "\t" : (h.match(/;/g) || []).length > (h.match(/,/g) || []).length ? ";" : ",";
    return lines.map((ln) => ln.split(sep).map((x) => x.replace(/^"|"$/g, "").trim()));
  }

  // يحدد نوع الجدول ويقرؤه. يعيد {type:"snapshot", snap} أو {type:"history", series:[...]}
  function readTable(rows, fallbackSymbol) {
    rows = rows.filter((r) => r && r.some((x) => x !== null && x !== undefined && String(x).trim() !== ""));
    // البحث عن صف العناوين ضمن أول 10 صفوف
    let hi = -1, idx = null;
    for (let k = 0; k < Math.min(10, rows.length); k++) { const m = mapHeaders(rows[k]); if (m.c != null && (m.s != null || m.d != null)) { hi = k; idx = m; break; } }
    if (hi < 0) throw new Error("لم أجد أعمدة الرمز/التاريخ والإغلاق");
    const body = rows.slice(hi + 1);
    const syms = idx.s != null ? body.map((r) => cleanSym(r[idx.s])).filter(Boolean) : [];
    const unique = new Set(syms).size;
    const isSnap = idx.s != null && syms.length >= 3 && unique >= syms.length * 0.95 && (idx.o == null || idx.d == null || unique === syms.length);
    if (isSnap) {
      const map = {}; let maxD = 0, time = "";
      for (const r of body) {
        const s = cleanSym(r[idx.s]); const last = cellNum(r[idx.c]); if (!s || !(last > 0)) continue;
        const dt = idx.d != null ? cellDate(r[idx.d]) : null;
        if (dt && dt.d >= maxD) { maxD = dt.d; time = dt.t || time; }
        let chgPct = idx.chgPct != null ? cellNum(r[idx.chgPct]) / 100 : NaNv;
        const chg = idx.chg != null ? cellNum(r[idx.chg]) : NaNv;
        if (!Number.isFinite(chgPct) && Number.isFinite(chg)) chgPct = chg / (last - chg);
        map[s] = {
          s, n: idx.n != null && r[idx.n] != null ? String(r[idx.n]).trim() : "", last, chg, chgPct,
          net: idx.net != null ? cellNum(r[idx.net]) : NaNv,
          v: idx.v != null ? cellNum(r[idx.v]) : NaNv, val: idx.val != null ? cellNum(r[idx.val]) : NaNv,
          o: idx.o != null ? cellNum(r[idx.o]) : NaNv, h: idx.h != null ? cellNum(r[idx.h]) : NaNv, l: idx.l != null ? cellNum(r[idx.l]) : NaNv,
        };
      }
      return { type: "snapshot", snap: { date: maxD || null, time, count: Object.keys(map).length, hasNet: idx.net != null, map } };
    }
    if (idx.d == null) throw new Error("ملف تاريخي بلا عمود تاريخ");
    const by = new Map();
    for (const r of body) {
      const dt = cellDate(r[idx.d]), c = cellNum(r[idx.c]); if (!dt || !(c > 0)) continue;
      const sym = idx.s != null ? cleanSym(r[idx.s]) : fallbackSymbol;
      const num = (k) => { const x = idx[k] != null ? cellNum(r[idx[k]]) : NaNv; return Number.isFinite(x) && x > 0 ? x : NaNv; };
      if (!by.has(sym)) by.set(sym, []);
      by.get(sym).push([dt.d, num("o") || c, num("h") || c, num("l") || c, c, num("v") || 0]);
    }
    const series = [...by.entries()].map(([s, rr]) => {
      rr.sort((a, b) => a[0] - b[0]);
      const u = rr.filter((r, i) => i === 0 || r[0] !== rr[i - 1][0]);
      return { s, d: u.map((r) => r[0]), o: u.map((r) => r[1]), h: u.map((r) => Math.max(r[1], r[2], r[4])), l: u.map((r) => Math.min(r[1], r[3], r[4])), c: u.map((r) => r[4]), v: u.map((r) => r[5]) };
    });
    return { type: "history", series };
  }
  function parseCSV(text, fallbackSymbol) { const r = readTable(textToRows(text), fallbackSymbol); return r.type === "history" ? r.series : []; }

  root.Engine = { FAMILIES, CONDS, PENALTIES, DEFAULTS, GRADES, gradeOf, toStock, prepare, computeScores, snapshot, breakdown, scoreAt, runFull, ablation, metrics, demoData, parseCSV, readTable, textToRows, _ind: { sma, rsi, atr, rollMax, rollMin, stdev, pctRankWindow } };
})(typeof window !== "undefined" ? window : globalThis);
