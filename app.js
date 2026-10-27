(function () {
  "use strict";
  const E = window.Engine;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const LS_KEY = "tasi-screener-settings-v1";
  const FAMC = { trend: "var(--f-trend)", momentum: "var(--f-momentum)", rs: "var(--f-rs)", volume: "var(--f-volume)", contraction: "var(--f-contraction)", breakout: "var(--f-breakout)" };

  const state = { snap: null, U: null, cfg: null, rows: [], sortK: "score", sortDir: -1, mode: "demo", meta: null, current: null, bt: null, charts: {} };

  // ---------------- أدوات التنسيق ----------------
  const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—");
  const pct = (x, d = 1) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + (x * 100).toFixed(d) + "%" : "—");
  const dstr = (d) => `${Math.floor(d / 10000)}-${String(Math.floor(d / 100) % 100).padStart(2, "0")}-${String(d % 100).padStart(2, "0")}`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // ---------------- الإعدادات ----------------
  function loadCfg() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch (e) { saved = {}; }
    const c = { ...E.DEFAULTS, ...saved };
    c.weights = { ...E.DEFAULTS.weights, ...(saved.weights || {}) };
    return c;
  }
  function saveCfg(c) { try { localStorage.setItem(LS_KEY, JSON.stringify(c)); } catch (e) { /* تجاهل */ } }

  // ---------------- التحميل ----------------
  const overlay = (txt, p) => { $("#overlay").classList.remove("hidden"); if (txt) $("#ovText").textContent = txt; if (p != null) $("#ovBar").style.width = Math.round(p * 100) + "%"; };
  const hideOverlay = () => $("#overlay").classList.add("hidden");
  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function loadReal() {
    const r = await fetch("data/meta.json", { cache: "no-cache" });
    if (!r.ok) throw new Error("no meta");
    const meta = await r.json();
    if (!meta.symbols || !meta.symbols.length) throw new Error("empty meta");
    const list = meta.symbols;
    const stocks = []; let done = 0;
    const getP = async (code) => { const x = await fetch(`data/prices/${code}.json`, { cache: "no-cache" }); if (!x.ok) throw new Error(code); return x.json(); };
    let index = null;
    try { if (meta.index && meta.index.available) index = await getP(meta.index.code); } catch (e) { index = null; }
    const queue = list.slice();
    const worker = async () => {
      while (queue.length) {
        const m = queue.shift();
        try { const p = await getP(m.s); if (p.d && p.d.length > 30) stocks.push(E.toStock(p, m)); } catch (e) { /* يتجاوز السهم */ }
        done++; overlay(`تحميل البيانات… ${done} / ${list.length}`, done / list.length);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    if (stocks.length < 5) throw new Error("too few");
    return { stocks, index, meta };
  }

  function loadDemo() {
    const d = E.demoData();
    return { stocks: d.stocks.map((x) => E.toStock(x.p, x.meta)), index: d.index, meta: null };
  }

  async function init() {
    state.cfg = loadCfg();
    applyTheme(null);
    overlay("جاري تحميل البيانات…", 0.02);
    let data;
    try { data = await loadReal(); state.mode = "real"; }
    catch (e) { data = loadDemo(); state.mode = "demo"; }
    await loadStoredSnapshot();
    await setData(data);
  }

  // ---------------- الملف اللحظي (لقطة السوق) ----------------
  const SNAP_KEY = "tasi-snapshot-v1";
  async function loadStoredSnapshot() {
    let local = null, repo = null;
    try { local = JSON.parse(localStorage.getItem(SNAP_KEY) || "null"); } catch (e) { local = null; }
    try { const r = await fetch("data/snapshot.json", { cache: "no-cache" }); if (r.ok) repo = await r.json(); } catch (e) { repo = null; }
    const key = (x) => (x ? (x.date || 0) * 10000 + +(String(x.time || "0").replace(":", "")) : -1);
    state.snap = key(repo) > key(local) ? repo : local;
    if (state.snap) state.snap.src = state.snap === repo ? "repo" : "local";
  }
  function setSnapshot(snap) {
    state.snap = snap; snap.src = "upload";
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(snap)); } catch (e) { /* تجاهل */ }
  }
  function clearSnapshot() {
    state.snap = null; try { localStorage.removeItem(SNAP_KEY); } catch (e) { /* تجاهل */ }
    refreshAll();
  }
  function applySnapNames() {
    const sn = state.snap; if (!sn || !state.U) return;
    for (const st of state.U.stocks) { const x = sn.map[st.s]; if (x && x.n) st.n = x.n; }
  }
  // أعلى قمة لآخر 20 جلسة (شاملة آخر جلسة) لقياس الاختراق اللحظي
  function hh20(st) { let m = -Infinity; for (let i = Math.max(0, st.len - 20); i < st.len; i++) m = Math.max(m, st.h[i]); return m; }
  function liveOf(st) {
    const x = state.snap && state.snap.map[st.s]; if (!x) return null;
    const lvl = hh20(st), lastD = st.d[st.len - 1];
    const intraday = !state.snap.date || state.snap.date > lastD;
    return { ...x, lvl, brk: x.last > lvl, intraday };
  }
  const fmtNet = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "−") + (Math.abs(x) >= 1e6 ? (Math.abs(x) / 1e6).toFixed(2) + "م" : Math.abs(x) >= 1e3 ? (Math.abs(x) / 1e3).toFixed(0) + "ألف" : Math.abs(x).toFixed(0)) : "—");

  async function setData(data) {
    overlay("حساب المؤشرات والشروط…", 0.95); await tick();
    state.meta = data.meta;
    state.U = E.prepare(data.stocks, data.index);
    applySnapNames();
    state.bt = null;
    E.computeScores(state.U, state.cfg);
    refreshAll();
    hideOverlay();
  }

  // ---------------- الشرائح العلوية والتنبيهات ----------------
  function tradingDaysBetween(a, b) { // أيام الأحد-الخميس بين تاريخين
    let n = 0; const d = new Date(a); while (d < b) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 5 && w !== 6) n++; } return n;
  }
  function renderStatus() {
    const U = state.U, lastD = U.dates[U.dates.length - 1];
    const src = $("#srcChip"), banners = [];
    if (state.mode === "real") {
      const last = new Date(dstr(lastD) + "T12:00:00");
      const lag = tradingDaysBetween(last, new Date());
      const stale = lag > 2;
      src.innerHTML = `<span class="dot ${stale ? "warn" : "ok"}"></span><span>بيانات حقيقية · آخر جلسة <span class="num">${dstr(lastD)}</span></span>`;
      if (stale) banners.push(`<b>تنبيه:</b> آخر بيانات متاحة بتاريخ <span class="num">${dstr(lastD)}</span> (متأخرة ${lag} أيام تداول). تحقق من تشغيل التحديث اليومي في GitHub Actions.`);
    } else if (state.mode === "csv") {
      src.innerHTML = `<span class="dot ok"></span><span>ملفات CSV مرفوعة · <span class="num">${dstr(lastD)}</span></span>`;
    } else {
      src.innerHTML = `<span class="dot warn"></span><span>بيانات تجريبية</span>`;
      banners.push(`<b>بيانات تجريبية:</b> لم يُعثر على مجلد البيانات، فالأسهم المعروضة وهمية لعرض طريقة عمل المنصة. بعد إعداد التحديث التلقائي على GitHub ستظهر أسهم تاسي الحقيقية هنا تلقائياً.`);
    }
    if (U.syntheticIndex) banners.push(`<b>ملاحظة:</b> بيانات مؤشر تاسي غير متاحة، فاستُخدم مؤشر بديل متساوي الأوزان من الأسهم المحمّلة لحساب القوة النسبية وحالة السوق.`);
    document.body.classList.toggle("has-snap", !!state.snap);
    if (state.snap) {
      const sn = state.snap, codes = Object.keys(sn.map);
      const have = new Set(U.stocks.map((s) => s.s));
      const matched = codes.filter((c) => have.has(c)).length, missing = codes.length - matched;
      const when = sn.date ? `<span class="num">${dstr(sn.date)}${sn.time ? " " + sn.time : ""}</span>` : "بدون تاريخ";
      let msg = `<b>ملف لحظي:</b> ${when} · ${codes.length} سهماً، طابق منها ${matched} سهماً في البيانات.`;
      if (missing && state.mode === "real") msg += ` ${missing} سهماً في الملف ليست في البيانات بعد؛ ارفع الملف إلى مجلد <span class="mono">inbox</span> في المستودع لتُضاف تلقائياً.`;
      if (!matched) msg += ` لا يوجد تطابق مع الأسهم الحالية${state.mode === "demo" ? " لأن المعروض بيانات تجريبية" : ""}. الملف اللحظي يضيف السعر اللحظي وصافي السيولة فقط، ولا يكفي وحده لحساب الشروط التي تحتاج سنة من التاريخ.`;
      msg += ` <button class="btn" id="clearSnap" style="padding:2px 10px;font-size:12.5px;margin-inline-start:6px">إزالة الملف</button>`;
      banners.unshift(msg);
    }
    const G = U.dates.length - 1, bull = U.bull[G];
    $("#regimeChip").innerHTML = `<span class="dot ${bull ? "ok" : "bad"}"></span><span>تاسي ${bull ? "فوق" : "تحت"} متوسط 200</span>`;
    if (!bull && state.cfg.regimeFilter) banners.push(`<b>السوق في اتجاه هابط:</b> المؤشر تحت متوسطه 200، فرُفعت عتبة الدخول في الاختبار التاريخي بمقدار ${state.cfg.regimeBump} نقاط. الاختراقات في الأسواق الهابطة أضعف تاريخياً.`);
    $("#banners").innerHTML = banners.map((b) => `<div class="banner"><div>${b}</div></div>`).join("");
    const cb = $("#clearSnap"); if (cb) cb.onclick = clearSnapshot;
  }

  // ---------------- النتائج ----------------
  function renderResults() {
    const cfg = state.cfg;
    state.rows = E.snapshot(state.U, cfg);
    const bySym = new Map(state.U.stocks.map((st) => [st.s, st]));
    for (const r of state.rows) {
      const lv = liveOf(bySym.get(r.s));
      r.live = lv ? lv.last : NaN; r.liveChg = lv ? lv.chgPct : NaN; r.net = lv ? lv.net : NaN; r.liveBrk = !!(lv && lv.brk); r.liveLvl = lv ? lv.lvl : NaN;
    }
    const el = state.rows.filter((r) => r.eligible);
    const cnt = (a, b) => el.filter((r) => r.score >= a && r.score < b).length;
    $("#sumCards").innerHTML = [
      ["الأسهم المؤهلة", `${el.length} <span class="muted small">من ${state.rows.length}</span>`],
      ["ممتاز جداً 90+", cnt(90, 101)], ["قوي 80–89", cnt(80, 90)], ["جيد 70–79", cnt(70, 80)], ["متوسط 60–69", cnt(60, 70)],
      ...(state.snap ? [["70+ بسيولة صافية موجبة", el.filter((r) => r.score >= 70 && r.net > 0).length], ["اختراق لحظي (70+)", el.filter((r) => r.score >= 70 && r.liveBrk).length]] : []),
    ].map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v num">${v}</div></div>`).join("");
    const secs = [...new Set(state.rows.map((r) => r.sec))].sort();
    const sel = $("#secSel"), cur = sel.value;
    sel.innerHTML = `<option value="">كل القطاعات</option>` + secs.map((s) => `<option ${s === cur ? "selected" : ""}>${esc(s)}</option>`).join("");
    $("#famLegend").innerHTML = E.FAMILIES.map((f) => `<span><i style="background:${FAMC[f.id]}"></i>${f.name}</span>`).join("");
    renderTable();
  }

  function filteredRows() {
    const q = $("#q").value.trim(), sec = $("#secSel").value, g = +$("#gradeSel").value;
    let rows = state.rows.filter((r) => {
      if (q && !(r.s.includes(q) || r.n.includes(q))) return false;
      if (sec && r.sec !== sec) return false;
      if (g >= 0 && (!r.eligible || !(r.score >= g))) return false;
      if (state.snap && $("#netPos").checked && !(r.net > 0)) return false;
      if (state.snap && $("#liveBrk").checked && !r.liveBrk) return false;
      return true;
    });
    const k = state.sortK, d = state.sortDir;
    rows.sort((a, b) => {
      const x = a[k], y = b[k];
      if (typeof x === "string") return d * x.localeCompare(y, "ar");
      const xv = Number.isFinite(x) ? x : -Infinity, yv = Number.isFinite(y) ? y : -Infinity;
      return d * (xv - yv);
    });
    return rows;
  }

  function renderTable() {
    const rows = filteredRows();
    const tb = $("#resTbl tbody");
    if (!rows.length) { tb.innerHTML = `<tr><td colspan="14" class="muted" style="text-align:center;padding:30px">لا توجد أسهم تطابق المعايير الحالية. جرّب خفض الحد الأدنى للتصنيف.</td></tr>`; return; }
    tb.innerHTML = rows.map((r, i) => {
      const g = E.gradeOf(r.eligible ? r.score : -1);
      const famBars = E.FAMILIES.map((f) => `<span style="height:22px" title="${f.name}: ${Math.round((r.fam[f.id] || 0) * 100)}%"><i style="height:${Math.round((r.fam[f.id] || 0) * 100)}%;background:${FAMC[f.id]}"></i></span>`).join("");
      return `<tr data-s="${esc(r.s)}" class="${r.eligible ? "" : "dim"}">
        <td class="num muted">${i + 1}</td>
        <td class="num"><b>${esc(r.s)}</b></td>
        <td>${esc(r.n)}</td>
        <td class="hide-sm muted">${esc(r.sec)}</td>
        <td class="num">${fmt(r.close)}</td>
        <td class="num ${r.chg >= 0 ? "up" : "down"}">${pct(r.chg, 2)}</td>
        <td class="snapcol">${Number.isFinite(r.live) ? `<span class="num">${fmt(r.live)}</span> <span class="num small ${r.liveChg >= 0 ? "up" : "down"}">${pct(r.liveChg, 2)}</span>${r.liveBrk ? '<span class="badge" title="السعر اللحظي فوق أعلى قمة لآخر 20 جلسة">اختراق</span>' : ""}` : '<span class="muted">—</span>'}</td>
        <td class="snapcol num ${r.net > 0 ? "up" : r.net < 0 ? "down" : "muted"}">${fmtNet(r.net)}</td>
        <td>${r.eligible ? `<div class="score"><span class="num" style="min-width:34px"><b>${r.score.toFixed(0)}</b></span><span class="sbar"><i style="width:${r.score}%;background:var(--${g.cls})"></i></span></div>` : `<span class="muted small">${esc(r.reason)}</span>`}</td>
        <td><span class="grade ${g.cls}">${g.name}</span></td>
        <td class="hide-sm"><div class="fams">${famBars}</div></td>
        <td class="num hide-sm ${r.rsi > 75 ? "down" : ""}">${fmt(r.rsi, 0)}</td>
        <td class="num hide-sm ${r.ext50 > 0.15 ? "down" : ""}">${pct(r.ext50, 1)}</td>
        <td class="num hide-sm">${fmt(r.value20 / 1e6, 1)}</td>
      </tr>`;
    }).join("");
  }

  function exportResults() {
    const rows = filteredRows();
    const head = ["الرمز", "الاسم", "القطاع", "التاريخ", "الإغلاق", "التغير%", "الدرجة", "التصنيف", ...E.FAMILIES.map((f) => f.name + "%"), "العقوبات", "RSI14", "البعد عن م50%", "السيولة20 مليون", "مستوى الاختراق", ...(state.snap ? ["السعر اللحظي", "التغير اللحظي%", "صافي السيولة", "اختراق لحظي"] : [])];
    const lines = rows.map((r) => [r.s, r.n, r.sec, dstr(r.date), r.close.toFixed(2), (r.chg * 100).toFixed(2), r.eligible ? r.score.toFixed(1) : "", E.gradeOf(r.eligible ? r.score : -1).name,
      ...E.FAMILIES.map((f) => Math.round((r.fam[f.id] || 0) * 100)), r.pen.toFixed(1), fmt(r.rsi, 1), (r.ext50 * 100).toFixed(1), (r.value20 / 1e6).toFixed(2), fmt(r.brk),
      ...(state.snap ? [Number.isFinite(r.live) ? r.live : "", Number.isFinite(r.liveChg) ? (r.liveChg * 100).toFixed(2) : "", Number.isFinite(r.net) ? r.net : "", r.liveBrk ? "نعم" : ""] : [])]);
    download(`tasi-screener-${dstr(state.U.dates[state.U.dates.length - 1])}.csv`, [head, ...lines]);
  }
  function download(name, rows) {
    const csv = "﻿" + rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------------- تفاصيل السهم ----------------
  function openStock(code) {
    const st = state.U.stocks.find((s) => s.s === code); if (!st) return;
    state.current = st; switchTab("stock"); renderStock();
  }

  function renderStock() {
    let st = state.current;
    if (!st) { const top = state.rows.find((r) => r.eligible) || state.rows[0]; st = state.current = state.U.stocks.find((s) => s.s === top.s); }
    const i = st.len - 1, cfg = state.cfg, row = state.rows.find((r) => r.s === st.s);
    const bd = i >= 252 ? E.breakdown(st, i, cfg) : null;
    const sc = row && row.eligible ? row.score : NaN, g = E.gradeOf(Number.isFinite(sc) ? sc : -1);
    const opts = state.rows.map((r) => `<option value="${esc(r.s)}" ${r.s === st.s ? "selected" : ""}>${esc(r.s)} · ${esc(r.n)}${r.eligible ? " · " + r.score.toFixed(0) : ""}</option>`).join("");
    $("#stockHead").innerHTML = `
      <div class="ring" style="--p:${Number.isFinite(sc) ? sc : 0};--c:var(--${g.cls})"><b class="num">${Number.isFinite(sc) ? sc.toFixed(0) : "—"}</b></div>
      <div style="flex:1;min-width:200px">
        <div style="font-size:20px;font-weight:700">${esc(st.n)} <span class="num muted" style="font-size:15px">${esc(st.s)}</span></div>
        <div class="muted small">${esc(st.sec)} · آخر جلسة <span class="num">${dstr(st.d[i])}</span> · الإغلاق <span class="num">${fmt(st.c[i])}</span> <span class="num ${st.c[i] >= st.c[i - 1] ? "up" : "down"}">${pct(st.c[i] / st.c[i - 1] - 1, 2)}</span></div>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap"><span class="grade ${g.cls}">${g.name}</span>${row && !row.eligible ? `<span class="pill">${esc(row.reason)}</span>` : ""}
          <span class="pill">مستوى الاختراق <span class="num">${fmt(st.aux.brkLevel[i])}</span></span>
          <span class="pill">ATR14 <span class="num">${fmt(st.aux.atr14[i])}</span></span>
          ${(() => { const lv = liveOf(st); return lv ? `<span class="pill">اللحظي <span class="num">${fmt(lv.last)}</span> <span class="num ${lv.chgPct >= 0 ? "up" : "down"}">${pct(lv.chgPct, 2)}</span></span><span class="pill">صافي السيولة <span class="num ${lv.net > 0 ? "up" : lv.net < 0 ? "down" : ""}">${fmtNet(lv.net)}</span></span>${lv.brk ? `<span class="pill" style="color:var(--accent);border-color:var(--accent)">اختراق لحظي فوق <span class="num">${fmt(lv.lvl)}</span></span>` : ""}` : ""; })()}
          <span class="pill">وقف مقترح (2×ATR) <span class="num">${fmt(st.c[i] - cfg.stopATR * st.aux.atr14[i])}</span></span></div>
      </div>
      <select id="stockSel" style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);max-width:100%">${opts}</select>`;
    $("#stockSel").onchange = (e) => openStock(e.target.value);

    if (!bd) { $("#bdPanel").innerHTML = `<div class="pbody muted" style="padding:16px">تاريخ السهم أقصر من 252 جلسة، فلا يمكن حساب الدرجة.</div>`; }
    else {
      const blocks = bd.fams.map((f) => `
        <div class="fam-block">
          <div class="fam-title"><i style="width:10px;height:10px;border-radius:2px;background:${FAMC[f.id]}"></i>${f.name}<span class="pts num">${f.pts.toFixed(1)} / ${f.max.toFixed(1)}</span></div>
          ${f.conds.map((c) => { const cl = c.val >= 0.99 ? "full" : c.val > 0.01 ? "part" : "none"; return `<div class="cond"><span class="ck ${cl}">${cl === "full" ? "✓" : cl === "part" ? "~" : "×"}</span><span title="${esc(c.formula)}">${esc(c.name)}</span><span class="num muted">${c.pts.toFixed(1)}</span></div>`; }).join("")}
        </div>`).join("");
      const pens = bd.pens.map((p) => `<div class="cond"><span class="ck ${p.val > 0.01 ? "part" : "none"}" style="${p.val > 0.01 ? "background:var(--down)" : ""}">${p.val > 0.01 ? "−" : "·"}</span><span title="${esc(p.formula)}">${esc(p.name)}</span><span class="num ${p.pts > 0 ? "down" : "muted"}">${p.pts > 0 ? "−" + p.pts.toFixed(1) : "0"}</span></div>`).join("");
      $("#bdPanel").innerHTML = `<div class="phead"><h3>تفصيل النقاط</h3><span class="sp num muted small">قبل العقوبات ${bd.raw.toFixed(1)}</span></div>${blocks}
        <div class="fam-block"><div class="fam-title">عقوبات التمدد<span class="pts num down">−${bd.pen.toFixed(1)}</span></div>${pens}</div>`;
    }
    drawStockChart(st);
  }

  function chartOpts(el) {
    return {
      width: el.clientWidth, height: el.clientHeight,
      layout: { background: { type: "solid", color: css("--panel") }, textColor: css("--muted"), fontFamily: "IBM Plex Mono, monospace" },
      grid: { vertLines: { color: css("--line") }, horzLines: { color: css("--line") } },
      rightPriceScale: { borderColor: css("--line") }, timeScale: { borderColor: css("--line") }, crosshair: { mode: 0 },
    };
  }
  function noLib(el) { el.innerHTML = `<div class="muted small" style="padding:20px;direction:rtl">تعذر تحميل مكتبة الرسوم البيانية (يتطلب اتصالاً بالإنترنت).</div>`; }

  function drawStockChart(st) {
    const el = $("#chart");
    if (!window.LightweightCharts) return noLib(el);
    if (state.charts.stock) { state.charts.stock.remove(); state.charts.stock = null; }
    if (!el.clientWidth) return;
    const ch = LightweightCharts.createChart(el, chartOpts(el)); state.charts.stock = ch;
    const from = Math.max(0, st.len - 400);
    const t = (i) => dstr(st.d[i]);
    const candles = ch.addCandlestickSeries({ upColor: css("--up"), downColor: css("--down"), borderVisible: false, wickUpColor: css("--up"), wickDownColor: css("--down") });
    const cd = [], vd = [], ln = { s50: [], s150: [], s200: [], brk: [] };
    for (let i = from; i < st.len; i++) {
      cd.push({ time: t(i), open: st.o[i], high: st.h[i], low: st.l[i], close: st.c[i] });
      vd.push({ time: t(i), value: st.v[i], color: st.c[i] >= st.o[i] ? css("--up") + "66" : css("--down") + "66" });
      for (const k of ["s50", "s150", "s200"]) if (Number.isFinite(st.aux[k][i])) ln[k].push({ time: t(i), value: st.aux[k][i] });
    }
    for (let i = Math.max(from, st.len - 60); i < st.len; i++) if (Number.isFinite(st.aux.brkLevel[i])) ln.brk.push({ time: t(i), value: st.aux.brkLevel[i] });
    candles.setData(cd);
    const vol = ch.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    ch.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    vol.setData(vd);
    const add = (data, color, style = 0) => { const s = ch.addLineSeries({ color, lineWidth: 1.5, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }); s.setData(data); };
    add(ln.s50, "#2563a8"); add(ln.s150, "#c06a1b"); add(ln.s200, "#8e44ad"); add(ln.brk, "#b03a5b", 2);
    ch.timeScale().setVisibleLogicalRange({ from: Math.max(0, cd.length - 180), to: cd.length + 3 });
  }

  // ---------------- الاختبار التاريخي ----------------
  async function runBacktest() {
    overlay("تشغيل الاختبار التاريخي…", 0.5); await tick();
    const r = E.runFull(state.U, state.cfg); state.bt = r;
    const U = state.U;
    $("#btInfo").textContent = `من ${dstr(U.dates[r.g0])} إلى ${dstr(U.dates[r.g1])} · بداية خارج العينة ${dstr(U.dates[r.split + 1])}`;
    const block = (title, m) => `<div><div class="mtitle">${title}</div>
      ${[["عدد الصفقات", m.trades], ["نسبة النجاح", pct(m.winRate, 1).replace("+", "")], ["متوسط الربح", pct(m.avgWin)], ["متوسط الخسارة", pct(m.avgLoss)],
        ["معامل الربحية", Number.isFinite(m.pf) ? m.pf.toFixed(2) : "—"], ["التوقع لكل صفقة", pct(m.expectancy, 2)], ["العائد الإجمالي", pct(m.ret)],
        ["العائد السنوي", pct(m.cagr)], ["أقصى تراجع", pct(m.mdd)], ["عائد تاسي السنوي", pct(m.benchCagr)], ["متوسط أيام الاحتفاظ", fmt(m.avgDays, 1)]]
        .map(([k, v]) => `<div class="mrow"><span>${k}</span><span class="num">${v}</span></div>`).join("")}</div>`;
    $("#btMetrics").innerHTML = block("الفترة كاملة", r.all) + block("فترة البناء (داخل العينة)", r.is) + block("خارج العينة", r.oos);
    const tr = r.bt.trades.slice().reverse();
    $("#trTbl tbody").innerHTML = tr.slice(0, 300).map((t) => `<tr><td class="num">${esc(t.s)}</td><td>${esc(t.n)}</td><td class="num">${dstr(t.ent)}</td><td class="num">${dstr(t.ex)}</td><td class="num">${fmt(t.entPx)}</td><td class="num">${fmt(t.exPx)}</td><td class="num ${t.ret > 0 ? "up" : "down"}">${pct(t.ret)}</td><td class="num">${t.days}</td><td>${t.reason}</td><td class="num">${t.score.toFixed(0)}</td></tr>`).join("") ||
      `<tr><td colspan="10" class="muted" style="text-align:center;padding:20px">لا توجد صفقات بهذه الإعدادات. جرّب خفض العتبة.</td></tr>`;
    drawEquity(r);
    hideOverlay();
  }

  function drawEquity(r) {
    const el = $("#eqchart");
    if (!window.LightweightCharts) return noLib(el);
    if (state.charts.eq) { state.charts.eq.remove(); state.charts.eq = null; }
    if (!el.clientWidth) return;
    const U = state.U, ch = LightweightCharts.createChart(el, chartOpts(el)); state.charts.eq = ch;
    const a = [], b = []; const base = U.idxClose[r.g0];
    for (let g = r.g0; g <= r.g1; g++) {
      const t = dstr(U.dates[g]);
      if (Number.isFinite(r.bt.curve[g])) a.push({ time: t, value: r.bt.curve[g] });
      if (Number.isFinite(U.idxClose[g])) b.push({ time: t, value: (100 * U.idxClose[g]) / base });
    }
    const s1 = ch.addLineSeries({ color: css("--accent"), lineWidth: 2, priceLineVisible: false });
    const s2 = ch.addLineSeries({ color: css("--muted"), lineWidth: 1.5, priceLineVisible: false });
    s1.setData(a); s2.setData(b);
    s1.createPriceLine({ price: 100, color: css("--line"), lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
    const split = dstr(U.dates[r.split + 1]);
    s1.setMarkers([{ time: split, position: "aboveBar", color: css("--warn"), shape: "arrowDown", text: "بداية خارج العينة" }]);
    ch.timeScale().fitContent();
  }

  async function runAblation() {
    overlay("تحليل مساهمة العائلات…", 0.5); await tick();
    const ab = E.ablation(state.U, state.cfg);
    const base = ab[0].m;
    $("#abTbl tbody").innerHTML = ab.map((a, k) => {
      const better = k > 0 && a.m.pf > base.pf;
      return `<tr style="${k === 0 ? "font-weight:600" : ""}"><td>${a.name}${better ? ' <span class="pill" style="color:var(--warn)">الأداء أفضل بدونها</span>' : ""}</td><td class="num">${a.m.trades}</td><td class="num">${pct(a.m.winRate, 1).replace("+", "")}</td><td class="num">${Number.isFinite(a.m.pf) ? a.m.pf.toFixed(2) : "—"}</td><td class="num">${pct(a.m.cagr)}</td><td class="num">${pct(a.m.mdd)}</td><td class="num">${Number.isFinite(a.oos.pf) ? a.oos.pf.toFixed(2) : "—"}</td></tr>`;
    }).join("");
    hideOverlay();
  }

  function exportTrades() {
    if (!state.bt) return;
    const rows = state.bt.bt.trades.map((t) => [t.s, t.n, dstr(t.ent), dstr(t.ex), t.entPx.toFixed(3), t.exPx.toFixed(3), (t.ret * 100).toFixed(2), t.days, t.reason, t.score.toFixed(1)]);
    download("backtest-trades.csv", [["الرمز", "الاسم", "الدخول", "الخروج", "سعر الدخول", "سعر الخروج", "العائد%", "الأيام", "السبب", "الدرجة"], ...rows]);
  }

  // ---------------- الإعدادات ----------------
  const FIELDS = {
    f: [
      { k: "minValue", label: "الحد الأدنى للسيولة اليومية (ريال)", type: "number", step: 1e6, hint: "متوسط قيمة التداول لآخر 20 جلسة. يستبعد الأسهم ضعيفة السيولة التي يصعب الدخول والخروج منها." },
      { k: "minBars", label: "الحد الأدنى لعدد الجلسات", type: "number", step: 10, hint: "الشروط تحتاج سنة تداول على الأقل (252 جلسة)." },
      { k: "penaltyScale", label: "شدة عقوبات التمدد", type: "range", min: 0, max: 2, step: 0.1, hint: "0 = بلا عقوبات، 1 = افتراضي، 2 = مضاعفة. العقوبات تمنع التقاط نهاية الموجة." },
      { k: "regimeFilter", label: "فلتر حالة السوق", type: "check", hint: "رفع العتبة عندما يكون تاسي تحت متوسطه 200." },
      { k: "regimeBump", label: "مقدار رفع العتبة في السوق الهابط", type: "number", step: 1 },
    ],
    b: [
      { k: "threshold", label: "عتبة الدخول (الدرجة)", type: "number", step: 1, hint: "الافتراضي 75." },
      { k: "entryMode", label: "طريقة الدخول", type: "select", options: [["cross", "عند تجاوز العتبة"], ["above", "طالما فوق العتبة"]] },
      { k: "maxPos", label: "أقصى عدد للمراكز", type: "number", step: 1 },
      { k: "stopATR", label: "وقف الخسارة (× ATR14)", type: "number", step: 0.25 },
      { k: "targetATR", label: "الهدف (× ATR14)، 0 = بلا هدف", type: "number", step: 0.5 },
      { k: "maxHold", label: "أقصى مدة احتفاظ (جلسات)", type: "number", step: 1 },
      { k: "costPerSide", label: "العمولة والانزلاق لكل جهة (%)", type: "number", step: 0.05, pctField: true },
      { k: "oosSplit", label: "نسبة فترة البناء", type: "range", min: 0.4, max: 0.9, step: 0.05, hint: "الباقي يُستخدم كاختبار خارج العينة." },
    ],
  };

  function fieldHTML(f, val) {
    const id = "fld-" + f.k;
    let input;
    if (f.type === "range") input = `<span class="num" id="${id}-v">${val}</span><input type="range" id="${id}" min="${f.min}" max="${f.max}" step="${f.step}" value="${val}">`;
    else if (f.type === "check") input = `<input type="checkbox" id="${id}" ${val ? "checked" : ""} style="width:18px;height:18px;accent-color:var(--accent)">`;
    else if (f.type === "select") input = `<select id="${id}">${f.options.map(([v, t]) => `<option value="${v}" ${v === val ? "selected" : ""}>${t}</option>`).join("")}</select>`;
    else input = `<input type="number" id="${id}" step="${f.step}" value="${f.pctField ? +(val * 100).toFixed(3) : val}">`;
    return `<div class="field"><label for="${id}">${f.label}</label>${input}${f.hint ? `<div class="hint">${f.hint}</div>` : ""}</div>`;
  }

  function renderSettings() {
    const c = state.cfg;
    $("#wFields").innerHTML = E.FAMILIES.map((f) => `<div class="field"><label for="w-${f.id}"><i style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${FAMC[f.id]};margin-inline-end:6px"></i>${f.name}</label><span class="num" id="w-${f.id}-v">${c.weights[f.id]}</span><input type="range" id="w-${f.id}" min="0" max="40" step="1" value="${c.weights[f.id]}"><div class="hint">${f.school}</div></div>`).join("");
    $("#fFields").innerHTML = FIELDS.f.map((f) => fieldHTML(f, c[f.k])).join("");
    $("#bFields").innerHTML = FIELDS.b.map((f) => fieldHTML(f, c[f.k])).join("");
    $$("#tab-settings input[type=range]").forEach((r) => r.addEventListener("input", () => { const v = $("#" + r.id + "-v"); if (v) v.textContent = r.value; }));
  }

  function readSettings() {
    const c = { ...state.cfg, weights: { ...state.cfg.weights } };
    E.FAMILIES.forEach((f) => (c.weights[f.id] = +$("#w-" + f.id).value));
    [...FIELDS.f, ...FIELDS.b].forEach((f) => {
      const el = $("#fld-" + f.k);
      if (f.type === "check") c[f.k] = el.checked;
      else if (f.type === "select") c[f.k] = el.value;
      else { let v = parseFloat(el.value); if (!Number.isFinite(v)) v = E.DEFAULTS[f.k]; c[f.k] = f.pctField ? v / 100 : v; }
    });
    if (Object.values(c.weights).every((w) => w === 0)) c.weights = { ...E.DEFAULTS.weights };
    c.maxPos = Math.max(1, Math.round(c.maxPos)); c.maxHold = Math.max(1, Math.round(c.maxHold));
    return c;
  }

  async function applySettings(c) {
    overlay("إعادة حساب النقاط…", 0.6); await tick();
    state.cfg = c; saveCfg(c);
    E.computeScores(state.U, c);
    state.bt = null;
    refreshAll();
    hideOverlay();
    $("#applyMsg").textContent = "تم التطبيق. أعد تشغيل الاختبار التاريخي لرؤية أثر التغيير.";
  }

  // ---------------- المنهجية ----------------
  function renderMethod() {
    const famName = Object.fromEntries(E.FAMILIES.map((f) => [f.id, f]));
    const tot = E.FAMILIES.reduce((a, f) => a + f.w, 0);
    $("#methodIntro").innerHTML = `
      <p><b>الفكرة:</b> بدلاً من جمع نقاط لكل مؤشر على حدة (وهو ما يضخّم الدرجة لأن RSI وMACD والزخم تقيس الشيء نفسه)، جُمعت الشروط في <b>ست عائلات</b> لكل منها سقف نقاط، ومجموع السقوف 100. ثم تُخصم <b>عقوبات التمدد</b> حتى لا يلتقط الفلتر نهاية الموجة.</p>
      <p><b>شروط الأهلية قبل النقاط:</b> سنة تداول على الأقل، وسيولة يومية فوق الحد المحدد، وبيانات حديثة. يُستبعد سوق نمو افتراضياً.</p>
      <p><b>التصنيف:</b> 90–100 ممتاز جداً · 80–89 قوي · 70–79 جيد · 60–69 متوسط · أقل من 60 مستبعد.</p>
      <p class="muted small">القيم بين 0 و1 تعني أن الشرط متدرج (يتحقق جزئياً) وليس نعم/لا فقط، وهذا يقلل حساسية الفلتر للحدود الحادة.</p>`;
    $("#methodTbl tbody").innerHTML = E.CONDS.map((c) => {
      const f = famName[c.fam]; const fw = E.FAMILIES.find((x) => x.id === c.fam); const famTot = E.CONDS.filter((x) => x.fam === c.fam).reduce((a, x) => a + x.w, 0);
      return `<tr><td><b>${c.name}</b></td><td><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${FAMC[c.fam]};margin-inline-end:5px"></i>${f.name}</td><td class="small muted">${f.school}</td><td class="num">${((fw.w / tot) * 100 * (c.w / famTot)).toFixed(1)}</td><td class="mono">${esc(c.formula)}</td><td><span class="pill">${c.timing}</span></td></tr>`;
    }).join("") + E.PENALTIES.map((p) => `<tr><td><b>${p.name}</b></td><td class="down">عقوبة</td><td class="small muted">إدارة المخاطر، تجنب مطاردة السعر</td><td class="num down">−${p.w}</td><td class="mono">${esc(p.formula)}</td><td><span class="pill">—</span></td></tr>`).join("");
    $("#methodNotes").innerHTML = `
      <h3 style="margin:0 0 8px">لماذا هذه الشروط تحديداً؟</h3>
      <p><b>الزخم والقرب من قمة 52 أسبوعاً:</b> من أكثر الظواهر توثيقاً في الأبحاث الأكاديمية عبر أسواق عديدة، لذلك أخذ القرب من القمة السنوية أعلى وزن داخل عائلته.</p>
      <p><b>الاتجاه والقوة النسبية:</b> مبدأ مشترك بين داو وتتبع الاتجاه وCANSLIM ومراحل وينستاين: الشراء في الأسهم التي تقود السوق وفي المرحلة الثانية من الصعود.</p>
      <p><b>الانضغاط ثم الاختراق بحجم:</b> ترجمة رقمية لفكرة وايكوف (تجميع ثم انطلاق) وVCP والقاعدة السعرية. هذه إشارات مبكرة تستهدف بداية الموجة.</p>
      <p><b>ما استُبعد ولماذا:</b> موجات إليوت وGann وكثير من مفاهيم ICT/SMC تعتمد على تقدير المحلل ولا تُترجم إلى قاعدة رقمية متفق عليها، فإدخالها يضيف ضجيجاً لا معلومة. MACD وStochastic وADX مكررة لما تقيسه عائلتا الزخم والاتجاه. Ichimoku وSuperTrend وKeltner صيغ أخرى للاتجاه والتقلب الموجودين أصلاً.</p>
      <p><b>عن الأدلة:</b> الأنماط الكلاسيكية والشموع لا تملك دليلاً أكاديمياً قوياً منفرداً، لذلك لم تُعطَ وزناً مستقلاً. الأوزان الافتراضية نقطة بداية منطقية، والحكم النهائي لتبويب الاختبار التاريخي و«تحليل المساهمة» على بيانات السوق السعودي نفسها.</p>
      <p><b>تنبيهات الاختبار التاريخي:</b> (1) تحيز البقاء: Yahoo لا يحتفظ عادة بأسعار الأسهم المشطوبة، فالنتائج قد تكون أفضل من الواقع. (2) تحسين الأوزان على كامل البيانات يعطي نتائج مبالغاً فيها، فاعتمد على نتائج «خارج العينة». (3) التنفيذ يفترض الدخول على افتتاح اليوم التالي، وقد يختلف السعر الفعلي في الأسهم ضعيفة السيولة أو عند الحد الأعلى للتذبذب.</p>`;
  }

  // ---------------- CSV يدوي ----------------
  let xlsxLoading = null;
  function loadXLSX() {
    if (window.XLSX) return Promise.resolve();
    if (!xlsxLoading) xlsxLoading = new Promise((res, rej) => {
      const sc = document.createElement("script");
      sc.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
      sc.onload = res; sc.onerror = () => { xlsxLoading = null; rej(new Error("تعذر تحميل قارئ ملفات Excel (يتطلب اتصالاً بالإنترنت)")); };
      document.head.appendChild(sc);
    });
    return xlsxLoading;
  }
  async function fileRows(f) {
    if (/\.(xlsx|xls)$/i.test(f.name)) {
      await loadXLSX();
      const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: "array", cellDates: true });
      return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
    }
    return E.textToRows(await f.text());
  }

  async function handleFiles(files) {
    overlay("قراءة الملفات…", 0.2); await tick();
    const stocks = []; let index = null, snap = null; const errs = [];
    for (const f of files) {
      try {
        const base = f.name.replace(/\.(csv|txt|xlsx|xls)$/i, "").replace(/^TADAWUL[_:]/i, "").replace(/[, ].*$/, "");
        const res = E.readTable(await fileRows(f), base);
        if (res.type === "snapshot") { if (!snap || (res.snap.date || 0) >= (snap.date || 0)) snap = res.snap; continue; }
        for (const p of res.series) {
          if (/TASI/i.test(p.s)) index = p;
          else if (p.d.length > 30) stocks.push(E.toStock(p, { n: p.s }));
        }
      } catch (e) { errs.push(f.name + ": " + e.message); }
    }
    if (snap) setSnapshot(snap);
    if (stocks.length) { state.mode = "csv"; await setData({ stocks, index, meta: null }); }
    else if (snap) { applySnapNames(); refreshAll(); hideOverlay(); }
    else { hideOverlay(); alert("لم أتمكن من قراءة أي بيانات.\n" + errs.join("\n")); return; }
    if (errs.length) alert("بعض الملفات لم تُقرأ:\n" + errs.join("\n"));
  }

  // ---------------- عام ----------------
  function switchTab(name) {
    $$("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name ? "true" : "false"));
    $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
    if (name === "stock") renderStock();
    if (name === "backtest" && !state.bt) runBacktest();
    else if (name === "backtest" && state.bt) drawEquity(state.bt);
  }

  function refreshAll() {
    renderStatus(); renderResults(); renderSettings(); renderMethod();
    if ($("#tab-stock").classList.contains("active")) renderStock();
    if ($("#tab-backtest").classList.contains("active")) runBacktest();
  }

  function applyTheme(t) {
    let theme = t;
    if (!theme) { try { theme = localStorage.getItem("tasi-theme"); } catch (e) { theme = null; } }
    if (theme) document.documentElement.setAttribute("data-theme", theme);
  }

  document.addEventListener("DOMContentLoaded", () => {
    $$("nav.tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
    ["#q", "#secSel", "#gradeSel", "#netPos", "#liveBrk"].forEach((s) => $(s).addEventListener("input", renderTable));
    $("#resTbl thead").addEventListener("click", (e) => {
      const th = e.target.closest("th"); if (!th || th.classList.contains("nosort")) return;
      const k = th.dataset.k; state.sortDir = state.sortK === k ? -state.sortDir : (typeof (state.rows[0] || {})[k] === "string" ? 1 : -1); state.sortK = k; renderTable();
    });
    $("#resTbl tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-s]"); if (tr) openStock(tr.dataset.s); });
    $("#exportBtn").onclick = exportResults;
    $("#btRun").onclick = runBacktest;
    $("#abRun").onclick = runAblation;
    $("#trExport").onclick = exportTrades;
    $("#applyBtn").onclick = () => applySettings(readSettings());
    $("#resetBtn").onclick = () => applySettings({ ...E.DEFAULTS, weights: { ...E.DEFAULTS.weights } });
    $("#csvInput").addEventListener("change", (e) => { if (e.target.files.length) handleFiles([...e.target.files]); e.target.value = ""; });
    $("#themeBtn").onclick = () => {
      const dark = document.documentElement.getAttribute("data-theme") === "dark" || (!document.documentElement.getAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
      const t = dark ? "light" : "dark"; document.documentElement.setAttribute("data-theme", t);
      try { localStorage.setItem("tasi-theme", t); } catch (e) { /* تجاهل */ }
      if (state.current && $("#tab-stock").classList.contains("active")) drawStockChart(state.current);
      if (state.bt && $("#tab-backtest").classList.contains("active")) drawEquity(state.bt);
    };
    let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => {
      for (const [k, el] of [["stock", "#chart"], ["eq", "#eqchart"]]) if (state.charts[k]) { const e = $(el); state.charts[k].applyOptions({ width: e.clientWidth }); }
    }, 150); });
    init().catch((e) => { hideOverlay(); alert("خطأ غير متوقع: " + e.message); });
  });
})();
