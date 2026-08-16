/* app.js — 頁面邏輯與渲染：消費 SparkEngine.analyze() 的 report，全段落對應文字輸出。
 * 所有對外字串繁體中文；無 emoji；零外部依賴。 */
(function (root) {
  "use strict";

  var SparkData = root.SparkData;
  var SparkEngine = root.SparkEngine;
  var F = SparkEngine.helpers;

  var resultsEl, inputEl, analyzeBtn, fileInput, emptyStateEl;
  var currentReport = null;
  var reportCache = {};

  function reportPluginOf(cls) {
    return currentReport && currentReport._pluginOf ? currentReport._pluginOf(cls) : null;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function fmtPct(v, denom) {
    return F.pctStr((v * 100) / denom) + "%";
  }

  function sectionHead(title, desc) {
    var head = el("div", "section-head");
    head.appendChild(el("div", "section-title", title));
    if (desc) head.appendChild(el("div", "section-desc", desc));
    return head;
  }

  /* 可獨立開合的表格區段：head 標題 + body 內容 */
  function tsec(label, body, open) {
    var wrap = el("div", "tsec");
    var head = el("div", "collapse-btn tsec-head");
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.appendChild(el("span", "collapse-arrow", "▶"));
    head.appendChild(el("span", "tsec-label", label));
    var bodyWrap = el("div", "collapse-body");
    if (open) {
      head.classList.add("open");
      bodyWrap.classList.add("open");
    }
    bodyWrap.appendChild(body);
    head.addEventListener("click", function () {
      head.classList.toggle("open");
      bodyWrap.classList.toggle("open");
    });
    head.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        head.classList.toggle("open");
        bodyWrap.classList.toggle("open");
      }
    });
    wrap.appendChild(head);
    wrap.appendChild(bodyWrap);
    return wrap;
  }

  /* 類別縮寫：取最後一段類別名 */
  function fmtDuration(sec) {
    if (sec === null || sec === undefined || isNaN(sec)) return "?";
    sec = Math.round(sec);
    var units = [
      [86400, "天"],
      [3600, "小時"],
      [60, "分"],
      [1, "秒"],
    ];
    var parts = [];
    for (var u = 0; u < units.length && parts.length < 2; u++) {
      var n = Math.floor(sec / units[u][0]);
      if (n > 0) {
        parts.push(n + units[u][1]);
        sec -= n * units[u][0];
      }
    }
    if (!parts.length) return "0秒";
    return parts.join("");
  }

  function clsShort(cls) {
    var m = cls.indexOf("$$Lambda");
    if (m > 0) {
      var pre = cls.slice(0, m);
      var i = pre.lastIndexOf(".");
      return (i >= 0 ? pre.slice(i + 1) : pre) + "$$Lambda";
    }
    var j = cls.lastIndexOf(".");
    return j >= 0 ? cls.slice(j + 1) : cls;
  }

  /* Hari key（cls.mth:line）拆成 [簡名, 完整名] */
  function hariName(key) {
    var k = key;
    var line = "";
    var li = k.lastIndexOf(":");
    if (li > 0) {
      line = k.slice(li + 1);
      k = k.slice(0, li);
    }
    var di = k.lastIndexOf(".");
    var cls = di > 0 ? k.slice(0, di) : k;
    var mth = di > 0 ? k.slice(di + 1) : "";
    return [clsShort(cls) + "." + mth + (line ? ":" + line : ""), cls + "." + mth + (line ? ":" + line : "")];
  }

  /* 偵錯：掃描頁面上殘留的 0x 位址文字，輸出到 console */
  function debugScan0x() {
    if (typeof console === "undefined" || !console.warn) return;
    var walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var n;
    var hits = 0;
    while ((n = walk.nextNode())) {
      var t = n.nodeValue;
      if (!t || t.indexOf("0x") === -1) continue;
      var p = n.parentElement;
      if (p && p.closest("script,style")) continue;
      var path = p ? p.tagName.toLowerCase() + (p.className ? "." + String(p.className).split(" ").join(".") : "") : "?";
      console.warn("[0x 殘留] " + path + " → " + t.trim().slice(0, 120));
      hits++;
    }
    if (!hits) console.log("[0x 偵測] 頁面無殘留位址");
  }

  /* 方法名 code chip：類別縮寫.方法:行號 [插件] */
  function methodChip(cls, mth, line, plugin) {
    var s = clsShort(cls) + "." + mth;
    if (line) s += ":" + line;
    var c = el("span", "chip", s);
    c.title = cls + "." + mth + (line ? ":" + line : "");
    if (plugin) {
      var p = el("span", "chip-line", " [" + plugin + "]");
      c.appendChild(p);
    }
    return c;
  }

  function nodeRow(selfMs, denom, cls, mth, line, plugin) {
    var row = el("div", "node-row");
    var pct = denom ? (selfMs * 100) / denom : 0;
    var meta = el("span", "node-meta");
    var b = el("b", null, F.pctStr(pct) + "%");
    meta.appendChild(b);
    meta.appendChild(document.createTextNode(F.fmtF(selfMs, 0) + "ms"));
    row.appendChild(meta);
    var barWrap = el("div", "node-bar");
    var bar = el("div", "bar-track");
    var fill = el("div", "bar-fill" + (pct >= 15 ? " top" : pct >= 8 ? " mid" : " low"));
    fill.style.width = Math.min(100, pct) + "%";
    bar.appendChild(fill);
    barWrap.appendChild(bar);
    row.appendChild(barWrap);
    row.appendChild(methodChip(cls, mth, line, plugin));
    return row;
  }

  /* ===== 狀態 ===== */

  function showState(kind, title, desc) {
    resultsEl.innerHTML = "";
    var st = el("div", "state" + (kind === "error" ? " state-error" : ""));
    if (kind === "loading") {
      st.appendChild(el("div", "spinner"));
    } else {
      st.appendChild(el("div", "state-icon"));
    }
    st.appendChild(el("div", "state-title", title));
    if (desc) st.appendChild(el("div", "state-desc", desc));
    resultsEl.appendChild(st);
  }

  function showLoading() {
    showState("loading", "分析中…", "正在解碼取樣報告並計算診斷（大檔案可能需要幾秒）");
  }

  function showError(msg) {
    showState("error", "無法分析", msg || "發生未知錯誤");
  }

  function showEmpty() {
    resultsEl.innerHTML = "";
    resultsEl.appendChild(emptyStateEl);
  }

  /* ===== 診斷層 ===== */

  function severityMeta(sev) {
    if (sev === "嚴重") return { cls: "banner-critical", label: "嚴重", color: "bad" };
    if (sev === "中等") return { cls: "banner-medium", label: "中等", color: "warn" };
    return { cls: "banner-minor", label: "輕微", color: "good" };
  }

  function renderBanner(d) {
    var sev = severityMeta(d.severity);
    var b = el("div", "banner " + sev.cls);
    b.appendChild(el("div", "banner-label", "Lag Diagnosis"));
    b.appendChild(el("div", "banner-title", "伺服器狀態：" + sev.label));

    var parts = [];
    var ti = d.tpsInfo;
    var fmt2 = function (v) { return v === null || v === undefined ? "?" : F.fmtF(v, 2); };
    parts.push("TPS 1m=" + fmt2(ti["1m"]) + "  5m=" + fmt2(ti["5m"]) + "  15m=" + fmt2(ti["15m"]));
    if (d.msptP95 !== null) {
      var sign = d.overrun !== null && d.overrun >= 0 ? "+" : "";
      parts.push("tick 超支 " + (d.overrun === null ? "未知" : sign + F.fmtF(d.overrun, 1) + "ms（預算 " + F.fmtF(d.budget, 1) + "ms / p95 " + F.fmtF(d.msptP95, 1) + "ms）"));
    } else {
      parts.push("MSPT p95 無資料");
    }
    if (d.durationS) {
      var ticks = d.factor ? Math.trunc(1 / d.factor) : 0;
      parts.push("採樣 " + fmtDuration(d.durationS) + (ticks ? "（約 " + ticks + " ticks）" : ""));
    }
    b.appendChild(el("div", "banner-desc", parts.join(" · ")));

    var stats = el("div", "banner-stats");
    var s1 = el("div", "banner-stat");
    s1.appendChild(el("div", "banner-stat-label", "TPS 1m"));
    var tpsV = el("div", "banner-stat-value", fmt2(ti["1m"]));
    if (ti["1m"] !== null && ti["1m"] < 15) tpsV.classList.add("bad");
    else if (ti["1m"] !== null && ti["1m"] < 19) tpsV.classList.add("warn");
    s1.appendChild(tpsV);
    stats.appendChild(s1);
    var s2 = el("div", "banner-stat");
    s2.appendChild(el("div", "banner-stat-label", "MSPT p95"));
    var msv = el("div", "banner-stat-value", d.msptP95 !== null ? F.fmtF(d.msptP95, 1) + "ms" : "-");
    if (d.overrun !== null && d.overrun > 0) msv.classList.add("warn");
    s2.appendChild(msv);
    stats.appendChild(s2);
    var s3 = el("div", "banner-stat");
    s3.appendChild(el("div", "banner-stat-label", "tick 超支"));
    var ovV = el("div", "banner-stat-value", d.overrun === null ? "-" : (d.overrun > 0 ? "+" : "") + F.fmtF(d.overrun, 1) + "ms");
    if (d.overrun !== null) ovV.classList.add(d.overrun >= 5 ? "bad" : d.overrun > 0 ? "warn" : "good");
    s3.appendChild(ovV);
    stats.appendChild(s3);
    b.appendChild(stats);
    return b;
  }

  function renderMetrics(d) {
    var grid = el("div", "metrics");
    var ti = d.tpsInfo;
    var fmt2 = function (v) { return v === null || v === undefined ? "?" : F.fmtF(v, 2); };

    var mTps = el("div", "metric");
    mTps.appendChild(el("div", "metric-label", "TPS（1m / 5m）"));
    var tpsV = el("div", "metric-value", fmt2(ti["1m"]));
    var clsBad = ti["1m"] !== null && ti["1m"] < 15 ? "bad" : ti["1m"] !== null && ti["1m"] < 19 ? "warn" : "";
    if (clsBad) tpsV.classList.add(clsBad);
    tpsV.appendChild(el("small", null, "  /  " + fmt2(ti["5m"])));
    mTps.appendChild(tpsV);
    grid.appendChild(mTps);

    var mMspt = el("div", "metric");
    mMspt.appendChild(el("div", "metric-label", "MSPT p95"));
    var msv = el("div", "metric-value", d.msptP95 !== null ? F.fmtF(d.msptP95, 2) + "ms" : "無資料");
    if (d.overrun !== null && d.overrun > 0) msv.classList.add("warn");
    mMspt.appendChild(msv);
    mMspt.appendChild(el("div", "metric-sub", "預算 " + F.fmtF(d.budget, 1) + "ms / tick"));
    grid.appendChild(mMspt);

    var mOv = el("div", "metric");
    mOv.appendChild(el("div", "metric-label", "tick 超支"));
    var ovV = el("div", "metric-value", d.overrun === null ? "未知" : (d.overrun > 0 ? "+" : "") + F.fmtF(d.overrun, 1) + "ms");
    if (d.overrun !== null) ovV.classList.add(d.overrun >= 5 ? "bad" : d.overrun > 0 ? "warn" : "good");
    mOv.appendChild(ovV);
    mOv.appendChild(el("div", "metric-sub", "p95 − 預算"));
    grid.appendChild(mOv);

    var mDur = el("div", "metric");
    mDur.appendChild(el("div", "metric-label", "採樣期間"));
    var ticks = d.factor ? Math.trunc(1 / d.factor) : 0;
    mDur.appendChild(el("div", "metric-value", d.durationS ? fmtDuration(d.durationS) : "?"));
    mDur.appendChild(el("div", "metric-sub", ticks ? "約 " + ticks + " ticks" : ""));
    grid.appendChild(mDur);

    var mPool = el("div", "metric");
    mPool.appendChild(el("div", "metric-label", "tick 執行緒"));
    mPool.appendChild(el("div", "metric-value", d.singleTick ? (d.pool > 1 ? d.pool + " 執行緒池" : "單一") : "多執行緒"));
    var idlePct = 0;
    if (d.tickGrand > 0) idlePct = (Math.max(0, d.tickGrand - d.tickActive) * 100) / d.tickGrand;
    mPool.appendChild(el("div", "metric-sub", "idle " + F.fmtF(idlePct, 0) + "%"));
    grid.appendChild(mPool);

    return grid;
  }

  function renderDiagnosis(d) {
    var sec = el("section", "section");
    sec.id = "sec-overview";
    sec.appendChild(sectionHead("總覽", "伺服器狀態、TPS/MSPT 指標與 tick 負載概況"));
    var band = el("div", "diag-band");
    band.appendChild(renderBanner(d));
    band.appendChild(renderMetrics(d));
    sec.appendChild(band);
    return sec;
  }

  /* ===== 主要原因 ===== */

  function confPill(c) {
    var cls = c === "HIGH" ? "pill-high" : c === "MEDIUM" ? "pill-medium" : "pill-low";
    var label = c === "HIGH" ? "HIGH" : c === "MEDIUM" ? "MEDIUM" : "LOW";
    return el("span", "pill " + cls, "Confidence " + label);
  }

  function entityBlock(d) {
    var sections = d.entityBr[0];
    var specific = d.entityBr[1];
    var aiOwners = d.entityBr[2];
    if (!sections.size) return null;
    var wrap = el("div", null);
    var total = 0;
    for (var sv of sections.values()) total += sv;
    var sorted = [];
    for (var se of sections.entries()) sorted.push(se);
    sorted.sort(function (a, b) { return b[1] - a[1]; });
    var groups = [];
    if (sections.size) groups.push({ label: "分項（系統層級，無法精確到單一實體）", rows: sorted });
    if (specific.size) {
      var specTop = [];
      for (var se2 of specific.entries()) specTop.push(se2);
      specTop.sort(function (a, b) { return b[1] - a[1]; });
      groups.push({ label: "實體類別自身 self", rows: specTop });
    }
    if (aiOwners.size) {
      var aiTop = [];
      for (var se3 of aiOwners.entries()) aiTop.push(se3);
      aiTop.sort(function (a, b) { return b[1] - a[1]; });
      groups.push({ label: "AI 開銷的實體入口", rows: aiTop });
    }
    wrap.appendChild(el("div", "ebar-total", "實體 self 總計 " + F.fmtF(total, 0) + "ms"));
    var list = el("div", "ebar-list");
    var MAX_ROW = 20;
    function appendGroup(labelText, items) {
      var head = el("button", "collapse-btn ebar-label", null);
      head.type = "button";
      head.appendChild(el("span", "collapse-arrow", "▶"));
      head.appendChild(document.createTextNode(labelText));
      list.appendChild(head);
      var bodyWrap = el("div", "ebar-group-body");
      var rows = [];
      for (var k = 0; k < items.length; k++) {
        var row = el("div", "ebar-row");
        var disp = items[k][0] === "（停用區域實體 inactiveTick）" ? "停用區域實體 inactiveTick" : items[k][0];
        var name = el("span", "ebar-name", disp);
        name.title = items[k][0];
        row.appendChild(name);
        var bar = el("span", "ebar-bar");
        var fill = el("i", null);
        fill.style.width = total > 0 ? Math.min(100, (items[k][1] * 100) / total) + "%" : "0%";
        bar.appendChild(fill);
        row.appendChild(bar);
        row.appendChild(el("span", "ebar-ms", F.fmtF(items[k][1], 0) + "ms"));
        row.appendChild(el("span", "ebar-pct", total > 0 ? F.fmtF((items[k][1] * 100) / total, 1) + "%" : "-"));
        rows.push(row);
        bodyWrap.appendChild(row);
      }
      if (rows.length > MAX_ROW) {
        for (var h = MAX_ROW; h < rows.length; h++) rows[h].style.display = "none";
        var btn = el("button", "collapse-btn ebar-more");
        var label = document.createTextNode("顯示全部（" + rows.length + "）");
        btn.appendChild(label);
        var showAll = false;
        btn.addEventListener("click", function () {
          showAll = !showAll;
          for (var h2 = MAX_ROW; h2 < rows.length; h2++) rows[h2].style.display = showAll ? "" : "none";
          btn.classList.toggle("open", showAll);
          label.nodeValue = showAll ? "收合（前 " + MAX_ROW + "）" : "顯示全部（" + rows.length + "）";
        });
        bodyWrap.appendChild(btn);
      }
      head.addEventListener("click", function () {
        var open = bodyWrap.classList.toggle("collapsed") ? false : true;
        head.classList.toggle("open", open);
        // 收合整個組時重置「顯示全部」狀態 → 再打開時回到前 MAX_ROW
        if (!open && btn) {
          showAll = false;
          for (var h3 = MAX_ROW; h3 < rows.length; h3++) rows[h3].style.display = "none";
          btn.classList.remove("open");
          label.nodeValue = "顯示全部（" + rows.length + "）";
        }
      });
      list.appendChild(bodyWrap);
    }
    for (var g = 0; g < groups.length; g++) {
      if (g > 0) list.appendChild(el("div", "ebar-sep"));
      appendGroup(groups[g].label, groups[g].rows);
    }
    wrap.appendChild(list);
    return wrap;
  }

  function chainBlock(chains, category) {
    var ch = chains.get(category);
    if (!ch) return null;
    var wrap = el("div", null);
    var btn = el("button", "collapse-btn", null);
    btn.type = "button";
    var arrow = el("span", "collapse-arrow", "▶");
    btn.appendChild(arrow);
    btn.appendChild(document.createTextNode("Call Chain（self 最高的節點往上追，最內層路徑）"));
    var body = el("div", "collapse-body");
    for (var ci = 0; ci < ch.length; ci++) {
      var nodes = ch[ci][2];
      var shown = nodes.slice(-5);
      var chain = el("div", "chain");
      for (var j = 0; j < shown.length; j++) {
        var cn = shown[j];
        var line = el("div", "chain-line" + (j > 0 ? " chain-child" : ""));
        var s = clsShort(cn[0]) + "." + cn[1];
        if (cn[2]) s += ":" + cn[2];
        line.appendChild(document.createTextNode(s));
        if (j === shown.length - 1) {
          var mark = el("span", "mark", "   ← self 最高");
          line.appendChild(mark);
        }
        chain.appendChild(line);
      }
      body.appendChild(chain);
    }
    btn.addEventListener("click", function () {
      var open = body.classList.toggle("open");
      btn.classList.toggle("open", open);
    });
    wrap.appendChild(btn);
    wrap.appendChild(body);
    return wrap;
  }

  function renderCauses(d) {
    var sec = el("section", "section");
    sec.id = "sec-causes";
    sec.appendChild(sectionHead("主要原因", "self 佔非 idle tick 採樣 ≥3% 的類別，附每 tick 成本估計與呼叫鏈"));

    var grid = el("div", "cause-grid");
    var shown = 0;
    for (var i = 0; i < d.causes.length; i++) {
      var c = d.causes[i];
      if (c.selfPct < 3) continue;
      shown += 1;
      var card = el("div", "card card-pad");
      var headRow = el("div", "cause-head");
      headRow.appendChild(el("span", "cause-rank", "#" + shown));
      headRow.appendChild(el("span", "cause-cat", c.label));
      headRow.appendChild(confPill(c.confidence));
      if (c.costMs !== null) {
        headRow.appendChild(el("span", "cause-cost", "約 +" + F.fmtF(c.costMs, 1) + " ms/tick"));
      }
      card.appendChild(headRow);

      var hero = el("div", "cause-hero");
      var heroNum = el("div", "cause-hero-num");
      heroNum.appendChild(el("b", null, F.fmtF(c.selfPct, 1) + "%"));
      heroNum.appendChild(el("span", null, "self 佔非 idle tick"));
      hero.appendChild(heroNum);
      var heroBar = el("div", "cause-hero-bar");
      var track = el("div", "bar-track");
      var fill = el("div", "bar-fill" + (c.selfPct >= 15 ? " top" : c.selfPct >= 8 ? " mid" : " low"));
      fill.style.width = Math.min(100, c.selfPct) + "%";
      track.appendChild(fill);
      heroBar.appendChild(track);
      heroBar.appendChild(el("div", "cause-hero-note", "inc/self " + F.fmtF(c.incRatio, 1) + (c.incRatio >= 1.5 ? " → 開銷來自被大量呼叫" : "")));
      hero.appendChild(heroBar);
      card.appendChild(hero);

      var stats = el("div", "cause-stats");
      var s1 = el("div", "cause-stat");
      s1.appendChild(el("div", "cause-stat-label", "self 佔比"));
      s1.appendChild(el("div", "cause-stat-value", F.fmtF(c.selfPct, 1) + "%"));
      stats.appendChild(s1);
      var s2 = el("div", "cause-stat");
      s2.appendChild(el("div", "cause-stat-label", "inc/self 比"));
      s2.appendChild(el("div", "cause-stat-value", F.fmtF(c.incRatio, 1)));
      if (c.incRatio >= 1.5) s2.appendChild(el("div", "cause-stat-label", "≫1 → 開銷來自被大量呼叫"));
      stats.appendChild(s2);
      var s3 = el("div", "cause-stat");
      s3.appendChild(el("div", "cause-stat-label", "證據"));
      var evTd = el("div", "cause-stat-value", clsShort(c.evidence));
      evTd.title = c.evidence;
      s3.appendChild(evTd);
      s3.appendChild(el("div", "cause-stat-label", "self 合計 " + F.fmtF(c.evidenceSelf, 0) + "ms"));
      stats.appendChild(s3);
      var s4 = el("div", "cause-stat");
      s4.appendChild(el("div", "cause-stat-label", "出現"));
      s4.appendChild(el("div", "cause-stat-value", "跨 " + c.threadCount + " 執行緒"));
      stats.appendChild(s4);
      card.appendChild(stats);

      var nodes = el("div", "cause-nodes");
      var topSrc = (c.topMethodsInc && c.topMethodsInc.length) ? c.topMethodsInc : c.topMethods;
      var catInc = d.catTick ? ((d.catTick.get(c.category) || {}).inc || 0) : 0;
      var nDenom = catInc > 0 ? catInc : d.tickActive;
      for (var q = 0; q < topSrc.length; q++) {
        var tm = topSrc[q];
        var parts = F.splitKey(tm[0]);
        nodes.appendChild(nodeRow(tm[1], nDenom, parts[0], parts[1], parts[2], reportPluginOf(parts[0])));
      }
      if (topSrc.length) {
        var note = el("div", "cause-nodes-note", "節點 % = 含子時間 ÷ 類別含子時間；含子時間因父子路徑重複計入，合計可能超過上方 self 佔比");
        card.appendChild(note);
      }
      card.appendChild(nodes);

      if (c.category === "ENTITY" && d.entityBr) {
        var eb = entityBlock(d);
        if (eb) card.appendChild(eb);
      }
      var cb = chainBlock(d.chains, c.category);
      if (cb) card.appendChild(cb);
      grid.appendChild(card);
    }
    if (!shown) {
      var card2 = el("div", "card card-pad");
      card2.appendChild(el("div", "cause-stat-label", "tick 執行緒未偵測到 ≥3% 的單一類別負載"));
      grid.appendChild(card2);
    }
    sec.appendChild(grid);
    return sec;
  }

  /* ===== 排除 / 注意 ===== */

  function renderExclusions(d) {
    if (!d.exclusions.length && !d.notes.length) return null;
    var sec = el("section", "section");
    sec.appendChild(sectionHead("排除原因與注意", "診斷時排除的類別（低於 5% 門檻）與需要注意的事項"));
    var list = el("div", "note-list");
    for (var i = 0; i < d.exclusions.length; i++) {
      var it = el("div", "note-item");
      it.appendChild(el("span", "tag", "排除"));
      it.appendChild(el("span", null, d.exclusions[i]));
      list.appendChild(it);
    }
    for (var j = 0; j < d.notes.length; j++) {
      var it2 = el("div", "note-item");
      it2.appendChild(el("span", "tag", "注意"));
      it2.appendChild(el("span", null, d.notes[j]));
      list.appendChild(it2);
    }
    sec.appendChild(list);
    return sec;
  }

  /* ===== 插件分析 ===== */

  function renderPlugins(d) {
    var sec = el("section", "section");
    sec.id = "sec-plugins";
    sec.appendChild(sectionHead("插件分析", "tick 執行緒上的插件負載（依 spark classSources 歸因）"));

    if (!d.plugins.size) {
      var card = el("div", "card card-pad");
      card.appendChild(el("div", "cause-stat-label", "（無插件熱點）沒有證據顯示插件是本次卡頓來源。"));
      sec.appendChild(card);
      return sec;
    }
    var ranked = [];
    for (var pe of d.plugins.entries()) ranked.push(pe);
    ranked.sort(function (a, b) { return b[1].self - a[1].self; });
    var totalPlugin = 0;
    for (var pr = 0; pr < ranked.length; pr++) totalPlugin += ranked[pr][1].self;
    var totalPct = d.tickActive > 0 ? (totalPlugin * 100) / d.tickActive : 0;
    var shownPlugins = ranked.slice(0, 10);
    var restPlugins = ranked.slice(10);

    var tbl = el("div", "table-wrap");
    var table = el("table");
    var thead = el("thead");
    var tr = el("tr");
    tr.appendChild(el("th", null, "#"));
    tr.appendChild(el("th", null, "插件"));
    tr.appendChild(el("th", "num", "self 佔比"));
    tr.appendChild(el("th", "num", "成本"));
    tr.appendChild(el("th", null, "top 方法"));
    thead.appendChild(tr);
    table.appendChild(thead);
    var tbody = el("tbody");
    for (var i = 0; i < shownPlugins.length; i++) {
      var pn = shownPlugins[i];
      var d2 = pn[1];
      var ppct = d.tickActive > 0 ? (d2.self * 100) / d.tickActive : 0;
      var topK = null;
      var topT = 0;
      for (var me of d2.methods.entries()) {
        if (!topK || me[1] > topT) { topK = me[0]; topT = me[1]; }
      }
      var r = el("tr");
      r.appendChild(el("td", "num", String(i + 1)));
      r.appendChild(el("td", "strong", pn[0]));
      r.appendChild(el("td", "num", F.pctStr(ppct) + "%"));
      r.appendChild(el("td", "num", d.factor ? "+" + F.fmtF(d2.self * d.factor, 1) + " ms/tick" : "-"));
      if (topK) {
        var tkParts = F.splitKey(topK);
        var cell = el("td", null);
        cell.appendChild(methodChip(tkParts[0], tkParts[1], tkParts[2], null));
        cell.appendChild(el("span", "chip-line", " " + F.pctStr((topT * 100) / d.tickActive) + "%"));
        r.appendChild(cell);
      } else {
        r.appendChild(el("td", null, "-"));
      }
      tbody.appendChild(r);
    }
    if (restPlugins.length) {
      var restSum = 0;
      for (pr = 0; pr < restPlugins.length; pr++) restSum += restPlugins[pr][1].self;
      var restPct = d.tickActive > 0 ? (restSum * 100) / d.tickActive : 0;
      var r2 = el("tr");
      r2.appendChild(el("td", null, "…"));
      r2.appendChild(el("td", null, "另有 " + restPlugins.length + " 個插件微量"));
      r2.appendChild(el("td", "num", F.pctStr(restPct) + "%"));
      r2.appendChild(el("td", "num", "-"));
      r2.appendChild(el("td", null, "-"));
      tbody.appendChild(r2);
    }
    table.appendChild(tbody);
    tbl.appendChild(table);
    sec.appendChild(tbl);

    var concl = el("div", "note-item");
    concl.style.marginTop = "12px";
    concl.appendChild(el("span", "tag", "結論"));
    var msg = "";
    if (totalPct >= 30) msg = "插件合計 " + F.fmtF(totalPct, 1) + "% tick CPU — 插件是主要負載來源，優先檢查下列插件。";
    else if (totalPct >= 15) msg = "插件合計 " + F.fmtF(totalPct, 1) + "% tick CPU — 插件負載顯著，值得優先檢查。";
    else msg = "插件合計 " + F.fmtF(totalPct, 1) + "% tick CPU — 無證據顯示插件為主要卡頓來源。";
    concl.appendChild(el("span", null, msg));
    sec.appendChild(concl);
    return sec;
  }

  /* ===== Region 排名 ===== */

  function renderRegions(d) {
    var sec = el("section", "section");
    sec.appendChild(sectionHead("Region 排名", "threaded regions / region scheduler 執行緒的活躍度排名"));
    if (!d.regions.length) {
      var card = el("div", "card card-pad");
      card.appendChild(el("div", "cause-stat-label", "（無 REGION_TICK 執行緒）"));
      sec.appendChild(card);
      return sec;
    }
    var tbl = el("div", "table-wrap");
    var table = el("table");
    var thead = el("thead");
    var tr = el("tr");
    tr.appendChild(el("th", null, "#"));
    tr.appendChild(el("th", null, "執行緒"));
    tr.appendChild(el("th", "num", "活躍度"));
    tr.appendChild(el("th", "num", "每 tick"));
    thead.appendChild(tr);
    table.appendChild(thead);
    var tbody = el("tbody");
    for (var i = 0; i < d.regions.length; i++) {
      var rg = d.regions[i];
      var r = el("tr");
      r.appendChild(el("td", "num", String(i + 1)));
      r.appendChild(el("td", "strong mono", rg.name));
      r.appendChild(el("td", "num", rg.busy !== null ? F.fmtF(rg.busy, 0) + "%" : "?"));
      r.appendChild(el("td", "num", rg.perTick !== null ? "~" + F.fmtF(rg.perTick, 1) + " ms" : "-"));
      tbody.appendChild(r);
    }
    table.appendChild(tbody);
    tbl.appendChild(table);
    sec.appendChild(tbl);
    return sec;
  }

  /* ===== 相關性 ===== */

  function renderCorrelation(d) {
    var sec = el("section", "section");
    sec.appendChild(sectionHead("實體 / 區塊相關性", "採樣窗口的平均實體數與區塊數，對照 tick 負載判讀"));
    var card = el("div", "card card-pad");
    card.style.marginTop = "16px";
    var wins2 = d.wins;
    var totalDur = 0, entSum = 0, chunkSum = 0, tpsSum = 0, entSeen = false, chunkSeen = false, tpsSeen = false;
    for (var i = 0; i < wins2.length; i++) {
      var w = wins2[i];
      if (!w.dur_s) continue;
      totalDur += w.dur_s;
      if (w.entities !== null && w.entities !== undefined) { entSum += w.entities * w.dur_s; entSeen = true; }
      if (w.chunks !== null && w.chunks !== undefined) { chunkSum += w.chunks * w.dur_s; chunkSeen = true; }
      if (w.tps !== null && w.tps !== undefined) { tpsSum += w.tps * w.dur_s; tpsSeen = true; }
    }
    var avgEnt2 = null, avgChunk2 = null, avgTps2 = null;
    if (totalDur > 0) {
      if (entSeen) avgEnt2 = entSum / totalDur;
      if (chunkSeen) avgChunk2 = chunkSum / totalDur;
      if (tpsSeen) avgTps2 = tpsSum / totalDur;
    }
    var entD = d.catTick.get("ENTITY");
    var chunkD = d.catTick.get("CHUNK");
    var entityPct = d.tickActive ? ((entD ? entD.self : 0) * 100) / d.tickActive : 0;
    var chunkPct = d.tickActive ? ((chunkD ? chunkD.self : 0) * 100) / d.tickActive : 0;
    var reads = [];
    if (avgEnt2 !== null && entityPct >= 10) {
      reads.push("實體數量高（約 " + F.fmtF(avgEnt2, 0) + "）且 Entity tick CPU " + F.fmtF(entityPct, 1) + "% → 疑似實體過多造成 tick 壓力");
    } else if (entityPct >= 10) {
      reads.push("Entity tick CPU " + F.fmtF(entityPct, 1) + "% → 實體 tick 是主要負載之一");
    }
    if (avgChunk2 !== null && chunkPct >= 10) {
      reads.push("chunks 數量高（約 " + F.fmtF(avgChunk2, 0) + "）且 Chunk 相關 CPU " + F.fmtF(chunkPct, 1) + "% → 疑似區塊載入/生成壓力");
    } else if (chunkPct >= 10) {
      reads.push("Chunk 相關 CPU " + F.fmtF(chunkPct, 1) + "% → 區塊處理是主要負載之一");
    }
    if (!reads.length) reads.push("實體 / 區塊熱點均未達顯著門檻（≥10%），不是主要嫌疑");
    var list = el("div", "note-list");
    list.style.marginTop = "12px";
    for (var rd = 0; rd < reads.length; rd++) {
      var n = el("div", "note-item");
      n.appendChild(el("span", "tag", "判讀"));
      n.appendChild(el("span", null, reads[rd]));
      list.appendChild(n);
    }
    card.appendChild(list);
    sec.appendChild(card);
    return sec;
  }

  /* ===== 詳細 profiler ===== */

  function renderEnv(report) {
    var env = report.env;
    var sec = el("div", "sub-block");
    sec.appendChild(sectionHead("環境", "報告元資料與執行環境"));
    var kv = el("div", "kv-grid");
    var rows = [
      ["報告 ID", env.id],
      ["採樣者", env.samplerName + " (" + env.samplerType + ")"],
    ];
    if (env.startMs && env.endMs) {
      rows.push(["採樣期間", F.fmtTs(env.startMs) + " → " + F.fmtTs(env.endMs) + "（" + fmtDuration(env.durationSec) + "）"]);
    }
    if (env.intervalMs) rows.push(["取樣區間", F.fmtF(env.intervalMs / 1000, 0) + " ms"]);
    rows.push(["伺服器", env.platformName + " " + env.platformVersion + "（" + env.platformType + "）"]);
    rows.push(["MC 版本", env.mcVersion]);
    rows.push(["核心", env.core]);
    rows.push(["CPU", env.cpuName + "（" + env.cpuThreads + " threads）"]);
    if (env.osName) rows.push(["作業系統", env.osName + " " + env.osVersion + "（" + env.osArch + "）"]);
    if (env.jvmName) rows.push(["JVM", "JDK " + env.jvmName + "（" + env.jvmVersion + "）"]);
    if (env.heapMax) rows.push(["Heap", F.fmtF(env.heapUsed / 1073741824, 2) + " GB / " + F.fmtF(env.heapMax / 1073741824, 2) + " GB（" + env.heapPct + "%）"]);
    for (var i = 0; i < rows.length; i++) {
      var it = el("div", "kv");
      it.appendChild(el("div", "kv-label", rows[i][0]));
      it.appendChild(el("div", "kv-value", rows[i][1]));
      kv.appendChild(it);
    }
    sec.appendChild(kv);
    if (env.gcs.length) {
      var gl = el("div", "gc-list");
      for (var gi = 0; gi < env.gcs.length; gi++) {
        var g = env.gcs[gi];
        var gr = el("div", "gc-row");
        gr.appendChild(el("b", "gc-name", g.name));
        gr.appendChild(el("span", "gc-cnt", F.fnum(g.total) + " 次 / 平均 " + F.fmtF(g.avgT || 0, 1) + "ms"));
        gr.appendChild(el("span", "gc-freq", g.avgF ? "每 " + F.fmtF(g.avgF / 1000, 1) + "s 一次" : "間隔?"));
        gl.appendChild(gr);
      }
      sec.appendChild(gl);
    }
    return sec;
  }

  function renderTpsMspt(report) {
    var tp = report.tpsMspt;
    var sec = el("div", "sub-block");
    sec.appendChild(sectionHead("TPS / MSPT", "1m / 5m 統計與取樣時間窗"));
    var kv = el("div", "kv-grid stack");
      if (tp.tps) {
        var it = el("div", "kv");
        it.appendChild(el("div", "kv-label", "TPS"));
        it.appendChild(el("div", "kv-value", "1m=" + F.fmtF(tp.tps["1m"], 2) + "  5m=" + F.fmtF(tp.tps["5m"], 2) + "  15m=" + F.fmtF(tp.tps["15m"], 2)));
        kv.appendChild(it);
      }
      var wins = tp.wins.slice().sort(function (a, b) {
        var sa = a.startMs, sb = b.startMs;
        if (sa === null || sa === undefined) return 1;
        if (sb === null || sb === undefined) return -1;
        return sa - sb;
      });
      var tpsAll = [], msptAll = [], entAll = [], chunkAll = [], minsAll = [];
      var minStart = null;
      for (var ks = 0; ks < wins.length; ks++) {
        var ws = wins[ks];
        if (ws.startMs && (minStart === null || ws.startMs < minStart)) minStart = ws.startMs;
      }
      for (var k2 = 0; k2 < wins.length; k2++) {
        var w2 = wins[k2];
        minsAll.push(w2.startMs ? Math.floor((w2.startMs - minStart) / 60000) + 1 : null);
        tpsAll.push(w2.tps !== null && w2.tps !== undefined ? w2.tps : null);
        msptAll.push(w2.mspt !== null && w2.mspt !== undefined ? w2.mspt : null);
        entAll.push(w2.entities !== null && w2.entities !== undefined ? w2.entities : null);
        chunkAll.push(w2.chunks !== null && w2.chunks !== undefined ? w2.chunks : null);
      }
      var datasets = [];
      if (tpsAll.filter(function (v) { return v !== null; }).length > 1) datasets.push({ label: "TPS", values: tpsAll, unit: "", decimals: 2, invert: false, color: "#71E27D" });
      if (msptAll.filter(function (v) { return v !== null; }).length > 1) datasets.push({ label: "MSPT", values: msptAll, unit: "ms", decimals: 1, invert: true, color: "#E271D5" });
      if (entAll.filter(function (v) { return v !== null; }).length > 1) datasets.push({ label: "實體", values: entAll, unit: "", decimals: 0, invert: true, color: "#fc704f" });
      if (chunkAll.filter(function (v) { return v !== null; }).length > 1) datasets.push({ label: "chunks", values: chunkAll, unit: "", decimals: 0, invert: true, color: "#a1a1a1" });
      var tog = el("div", "view-toggle");
      var bSplit = el("button", "vt-btn open", "分開");
      var bOver = el("button", "vt-btn", "重疊");
      tog.appendChild(bSplit);
      tog.appendChild(bOver);
      var splitWrap = el("div", "win-charts show");
      for (var dsi = 0; dsi < datasets.length; dsi++) {
        var ds0 = datasets[dsi];
        var fv = [], fm = [];
        for (var fi = 0; fi < ds0.values.length; fi++) {
          if (ds0.values[fi] !== null) { fv.push(ds0.values[fi]); fm.push(minsAll[fi]); }
        }
        splitWrap.appendChild(winChart(ds0.label, fv, ds0.unit, ds0.decimals, ds0.invert, fm, ds0.color));
      }
      var overWrap = el("div", "win-overlay");
      if (datasets.length) overWrap.appendChild(overlayChart(datasets, minsAll));
      bSplit.addEventListener("click", function () {
        bSplit.classList.add("open");
        bOver.classList.remove("open");
        splitWrap.classList.add("show");
        overWrap.classList.remove("show");
      });
      bOver.addEventListener("click", function () {
        bOver.classList.add("open");
        bSplit.classList.remove("open");
        overWrap.classList.add("show");
        splitWrap.classList.remove("show");
      });
    function msptRow(tag, rv) {
      if (!rv) return;
      var it = el("div", "kv");
      it.appendChild(el("div", "kv-label", "MSPT " + tag));
      it.appendChild(el("div", "kv-value", "平均=" + F.fmtMspt(rv.avg) + "ms  最大=" + F.fmtMspt(rv.max) + "ms  最小=" + F.fmtMspt(rv.min) + "ms  中位=" + F.fmtMspt(rv.median) + "ms  p95=" + F.fmtMspt(rv.p95) + "ms"));
      kv.appendChild(it);
    }
    msptRow("1m", tp.mspt1m);
    msptRow("5m", tp.mspt5m);
    sec.appendChild(kv);
    if (datasets.length) {
      var whead = el("div", "kv-label", "時間窗");
      var wsec = el("div", "sub-block");
      wsec.appendChild(whead);
      wsec.appendChild(tog);
      wsec.appendChild(splitWrap);
      wsec.appendChild(overWrap);
      sec.appendChild(wsec);
    }
    return sec;
  }

  function winChart(label, values, unit, decimals, invert, mins, color) {
    var wrap = el("div", "win-chart");
    var head = el("div", "wc-head");
    head.appendChild(el("span", "wc-label", label));
    var last = values[values.length - 1];
    var lb = el("b", null, F.fmtF(last, decimals || 0) + unit);
    var d = winDelta(values.length - 1, values.length > 1 ? values[values.length - 2] : null, last, invert);
    if (d) lb.appendChild(d);
    head.appendChild(lb);
    wrap.appendChild(head);
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    wrap.appendChild(el("div", "wc-range", "min " + F.fmtF(min, decimals || 0) + unit + " · max " + F.fmtF(max, decimals || 0) + unit));
    var body = el("div", "chart-body");
    var svg = mkSvgPolyline(values, color);
    body.appendChild(svg);
    var dots = addDots(body, values, color);
    wrap.appendChild(body);
    attachTip(svg, function (xr) {
      var i = idxAt(xr, values.length);
      var mn = mins && mins[i] ? mins[i] : i + 1;
      return [{ name: "第 " + mn + " 分鐘", val: F.fmtF(values[i], decimals || 0) + unit }];
    }, function (xr) {
      for (var k = 0; k < dots.length; k++) dots[k].classList.toggle("active", xr !== null && k === idxAt(xr, values.length));
    });
    var axis = el("div", "wc-axis");
    axis.appendChild(el("span", null, "1"));
    axis.appendChild(el("span", null, values.length + " 分"));
    wrap.appendChild(axis);
    return wrap;
  }

  function idxAt(xr, n) {
    if (n === 1) return 0;
    var W = 100, pad = 4;
    var t = (xr * W - pad) / (W - 2 * pad);
    var i = Math.round(t * (n - 1));
    if (i < 0) i = 0;
    if (i >= n) i = n - 1;
    return i;
  }

  function addDots(body, values, color) {
    var W = 100, H = 36, pad = 4;
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = max - min || 1;
    var dots = [];
    for (var i = 0; i < values.length; i++) {
      var px = pad + (values.length === 1 ? (W - 2 * pad) / 2 : (i * (W - 2 * pad)) / (values.length - 1));
      var py = H - pad - ((values[i] - min) / span) * (H - 2 * pad);
      var d = el("div", "chart-dot");
      d.style.left = ((px / W) * 100).toFixed(2) + "%";
      d.style.top = ((py / H) * 100).toFixed(2) + "%";
      d.style.background = color;
      body.appendChild(d);
      dots.push(d);
    }
    return dots;
  }

  function attachTip(svg, getLines, onMove) {
    var tip = el("div", "ov-tip");
    var xline = el("div", "chart-xline");
    svg.parentNode.appendChild(tip);
    svg.parentNode.appendChild(xline);
    svg.addEventListener("mousemove", function (e) {
      var rect = svg.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
        tip.style.display = "none";
        xline.style.display = "none";
        return;
      }
      var xr = (e.clientX - rect.left) / rect.width;
      xline.style.display = "block";
      xline.style.left = (xr * 100) + "%";
      if (onMove) onMove(xr);
      var lines = getLines(xr);
      if (!lines.length) {
        tip.style.display = "none";
        return;
      }
      tip.textContent = "";
      for (var k = 0; k < lines.length; k++) {
        var rw = el("div", "ov-tip-row");
        rw.appendChild(el("span", null, lines[k].name));
        rw.appendChild(el("b", null, lines[k].val));
        tip.appendChild(rw);
      }
      tip.style.display = "block";
      var tw = tip.offsetWidth;
      var th = tip.offsetHeight;
      var tx = e.clientX + 16;
      if (tx + tw > window.innerWidth - 8) tx = e.clientX - tw - 16;
      var ty = e.clientY + 24;
      if (ty + th > window.innerHeight - 8) ty = e.clientY - th - 12;
      tip.style.left = Math.max(4, tx) + "px";
      tip.style.top = Math.max(4, ty) + "px";
    });
    svg.addEventListener("mouseleave", function () {
      tip.style.display = "none";
      xline.style.display = "none";
      if (onMove) onMove(null);
    });
  }

  function mkSvgPolyline(values, color) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 100 36");
    svg.setAttribute("preserveAspectRatio", "none");
    var W = 100, H = 36, pad = 4;
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = max - min || 1;
    for (var g = 0; g < 3; g++) {
      var y = pad + (g / 2) * (H - 2 * pad);
      var ln = document.createElementNS(ns, "line");
      ln.setAttribute("x1", String(pad));
      ln.setAttribute("x2", String(W - pad));
      ln.setAttribute("y1", String(y));
      ln.setAttribute("y2", String(y));
      ln.setAttribute("stroke", "rgba(255,255,255,0.07)");
      ln.setAttribute("stroke-width", "1");
      ln.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(ln);
    }
    var pts = values.map(function (v, i) {
      var x = pad + (values.length === 1 ? (W - 2 * pad) / 2 : (i * (W - 2 * pad)) / (values.length - 1));
      var y = H - pad - ((v - min) / span) * (H - 2 * pad);
      return x.toFixed(2) + "," + y.toFixed(2);
    }).join(" ");
    var pl = document.createElementNS(ns, "polyline");
    pl.setAttribute("points", pts);
    pl.setAttribute("fill", "none");
    pl.setAttribute("stroke", color);
    pl.setAttribute("stroke-width", "2");
    pl.setAttribute("stroke-linejoin", "round");
    pl.setAttribute("stroke-linecap", "round");
    pl.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(pl);
    return svg;
  }

  function winDelta(i, prev, cur, invert) {
    if (i <= 0 || prev === null || prev === undefined || prev === 0) return null;
    var chg = ((cur - prev) / prev) * 100;
    if (Math.abs(chg) < 0.05) return el("span", "w-delta plain", "持平");
    var up = chg > 0;
    var cls = "w-delta " + (invert ? (up ? "down" : "up") : up ? "up" : "down");
    return el("span", cls, (up ? "+" : "") + F.fmtF(chg, 1) + "%");
  }

  function overlayChart(datasets, minsAll) {
    var ns = "http://www.w3.org/2000/svg";
    var wrap = el("div", "win-chart ov-chart");
    var bar = el("div", "ov-bar");
    var reset = el("button", "vt-btn", "重設縮放");
    bar.appendChild(el("div", "ov-desc", "拖曳選取時間範圍可縮放檢視；滑鼠移過圖表顯示該時間點各統計數值"));
    bar.appendChild(reset);
    wrap.appendChild(bar);
    var body = el("div", "chart-body ov-body");
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 100 36");
    svg.setAttribute("preserveAspectRatio", "none");
    var xline = el("div", "chart-xline");
    var brushEl = el("div", "ov-brush");
    body.appendChild(svg);
    body.appendChild(xline);
    body.appendChild(brushEl);
    var yL = el("div", "ov-yaxis ov-left");
    var yR = el("div", "ov-yaxis ov-right");
    body.appendChild(yL);
    body.appendChild(yR);
    wrap.appendChild(body);
    var xAxis = el("div", "ov-xaxis");
    wrap.appendChild(xAxis);
    var legend = el("div", "ov-legend");
    wrap.appendChild(legend);
    var W = 100, H = 36, pad = 4;
    var n = datasets.length ? datasets[0].values.length : 0;
    var keys = [];
    var range = [0, n - 1];
    for (var di = 0; di < datasets.length; di++) {
      keys.push(di);
      var vals = datasets[di].values.filter(function (v) { return v !== null; });
      var mx = Math.max.apply(null, vals);
      if (datasets[di].label === "TPS") mx = Math.max(mx, 20);
      else if (datasets[di].label === "MSPT") mx = Math.ceil(mx / 10) * 10;
      else mx = Math.ceil(mx / (mx > 1000 ? 1000 : mx > 100 ? 100 : 10)) * (mx > 1000 ? 1000 : mx > 100 ? 100 : 10);
      datasets[di].maxi = mx;
    }
    function visibleLen() { return range[1] - range[0] + 1; }
    function draw() {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      yL.textContent = "";
      yR.textContent = "";
      for (var g = 0; g < 3; g++) {
        var gy = pad + (g / 2) * (H - 2 * pad);
        var ln = document.createElementNS(ns, "line");
        ln.setAttribute("x1", String(pad));
        ln.setAttribute("x2", String(W - pad));
        ln.setAttribute("y1", String(gy));
        ln.setAttribute("y2", String(gy));
        ln.setAttribute("stroke", "rgba(255,255,255,0.07)");
        ln.setAttribute("stroke-width", "1");
        ln.setAttribute("vector-effect", "non-scaling-stroke");
        svg.appendChild(ln);
      }
      var len = visibleLen();
      var yTicks = [0, 0.25, 0.5, 0.75, 1];
      function axisTicks(axis, ds) {
        for (var t = 0; t < yTicks.length; t++) {
          var sp = el("span", null, F.fmtF(yTicks[t] * ds.maxi, 0));
          axis.appendChild(sp);
        }
      }
      for (var ki = 0; ki < keys.length; ki++) {
        var ds = datasets[keys[ki]];
        var segs = [];
        var cur = null;
        for (var j = 0; j < len; j++) {
          var v = ds.values[range[0] + j];
          if (v === null || v === undefined) { if (cur) { segs.push(cur); cur = null; } continue; }
          if (!cur) cur = [];
          cur.push(j);
        }
        if (cur) segs.push(cur);
        for (var si = 0; si < segs.length; si++) {
          var seg = segs[si];
          var pts = seg.map(function (jj) {
            var v = ds.values[range[0] + jj];
            var x = pad + (len === 1 ? (W - 2 * pad) / 2 : (jj * (W - 2 * pad)) / (len - 1));
            var yv = Math.min(v, ds.maxi);
            var y = H - pad - (yv / ds.maxi) * (H - 2 * pad);
            return x.toFixed(2) + "," + y.toFixed(2);
          }).join(" ");
          var pl = document.createElementNS(ns, "polyline");
          pl.setAttribute("points", pts);
          pl.setAttribute("fill", "none");
          pl.setAttribute("stroke", ds.color);
          pl.setAttribute("stroke-width", "4");
          pl.setAttribute("stroke-linejoin", "round");
          pl.setAttribute("stroke-linecap", "round");
          pl.setAttribute("vector-effect", "non-scaling-stroke");
          svg.appendChild(pl);
        }
      }
      if (keys.length) {
        var leftDs = datasets[keys[0]];
        var rightDs = datasets[keys[keys.length - 1]];
        axisTicks(yL, leftDs);
        axisTicks(yR, rightDs);
        var ylabL = el("span", "ov-ylab", leftDs.label);
        ylabL.style.color = leftDs.color;
        yL.appendChild(ylabL);
        var ylabR = el("span", "ov-ylab", rightDs.label);
        ylabR.style.color = rightDs.color;
        yR.appendChild(ylabR);
      }
      xAxis.textContent = "";
      var step = Math.max(1, Math.round(len / 6));
      for (var xi = 0; xi < len; xi += step) {
        if (xi > 0 && len - 1 - xi > 0 && xi + step >= len) continue;
        var winIdx = range[0] + xi;
        var lbl;
        if (minsAll[winIdx] !== null && minsAll[winIdx] !== undefined) {
          lbl = "第 " + minsAll[winIdx] + " 分";
        } else {
          lbl = String(winIdx + 1);
        }
        var xs = el("span", null, lbl);
        xAxis.appendChild(xs);
      }
      var lastLbl;
      if (minsAll[range[1]] !== null && minsAll[range[1]] !== undefined) {
        lastLbl = "第 " + minsAll[range[1]] + " 分";
      } else {
        lastLbl = String(range[1] + 1);
      }
      xAxis.appendChild(el("span", null, lastLbl));
    }
    function winIdxAt(xr) {
      if (n === 1) return range[0];
      var t = (xr * W - pad) / (W - 2 * pad);
      var j = Math.round(t * (visibleLen() - 1));
      if (j < 0) j = 0;
      if (j >= visibleLen()) j = visibleLen() - 1;
      return range[0] + j;
    }
    var dotSets = [];
    function rebuildDots() {
      var bd = body.querySelectorAll(".chart-dot");
      for (var q = 0; q < bd.length; q++) bd[q].parentNode.removeChild(bd[q]);
      dotSets = [];
      var len = visibleLen();
      for (var di2 = 0; di2 < datasets.length; di2++) {
        var ds2 = datasets[di2];
        var arr = [];
        for (var j2 = 0; j2 < len; j2++) {
          var v2 = ds2.values[range[0] + j2];
          if (v2 === null || v2 === undefined) continue;
          var x2 = pad + (len === 1 ? (W - 2 * pad) / 2 : (j2 * (W - 2 * pad)) / (len - 1));
          var y2 = H - pad - (Math.min(v2, ds2.maxi) / ds2.maxi) * (H - 2 * pad);
          var d2 = el("div", "chart-dot");
          d2.style.left = ((x2 / W) * 100).toFixed(2) + "%";
          d2.style.top = ((y2 / H) * 100).toFixed(2) + "%";
          d2.style.background = ds2.color;
          body.appendChild(d2);
          arr.push(d2);
        }
        dotSets.push(arr);
      }
    }
    function redraw() { draw(); rebuildDots(); }
    var dragging = false, dragStart = null, dragCur = null;
    svg.addEventListener("mousedown", function (e) {
      dragging = true;
      dragStart = e.clientX;
      dragCur = e.clientX;
      brushEl.style.display = "block";
      brushEl.style.left = "0%";
      brushEl.style.width = "0%";
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      dragCur = e.clientX;
      var rect = svg.getBoundingClientRect();
      var x1 = Math.min(dragStart, dragCur);
      var x2 = Math.max(dragStart, dragCur);
      var l = Math.max(0, (x1 - rect.left) / rect.width);
      var r = Math.min(1, (x2 - rect.left) / rect.width);
      brushEl.style.left = (l * 100) + "%";
      brushEl.style.width = ((r - l) * 100) + "%";
    });
    document.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      brushEl.style.display = "none";
      var rect = svg.getBoundingClientRect();
      var x1 = Math.min(dragStart, dragCur);
      var x2 = Math.max(dragStart, dragCur);
      var l = Math.max(0, (x1 - rect.left) / rect.width);
      var r = Math.min(1, (x2 - rect.left) / rect.width);
      if (r - l >= (n - 1) / n * 0.98 || r - l >= 0.98) {
        range = [0, n - 1];
      } else if (r - l >= 0.03) {
        var a = Math.round(l * (n - 1));
        var b = Math.round(r * (n - 1));
        if (a < 0) a = 0;
        if (b > n - 1) b = n - 1;
        if (b > a) range = [a, b];
      }
      redraw();
    });
    attachTip(svg, function (xr) {
      var out = [];
      var wi = winIdxAt(xr);
      for (var k = 0; k < keys.length; k++) {
        var ds = datasets[keys[k]];
        var v = ds.values[wi];
        if (v === null || v === undefined) continue;
        var mn = minsAll[wi] !== null && minsAll[wi] !== undefined ? minsAll[wi] : wi + 1;
        out.push({ name: ds.label + " 第 " + mn + " 分鐘", val: F.fmtF(v, ds.decimals || 0) + ds.unit });
      }
      return out;
    }, function (xr) {
      for (var k = 0; k < dotSets.length; k++) {
        var jx = -1;
        if (xr !== null) {
          var wi2 = winIdxAt(xr);
          var len2 = visibleLen();
          for (var j3 = 0; j3 < len2; j3++) {
            if (range[0] + j3 === wi2 && datasets[k].values[range[0] + j3] !== null) { jx = j3; break; }
          }
        }
        for (var j4 = 0; j4 < dotSets[k].length; j4++) dotSets[k][j4].classList.toggle("active", j4 === jx);
      }
    });
    reset.addEventListener("click", function () { range = [0, n - 1]; redraw(); });
    legend.textContent = "";
    for (var li = 0; li < datasets.length; li++) {
      (function (idx) {
        var ds = datasets[idx];
        var b = el("button", "legend-btn toggled");
        b.style.color = ds.color;
        b.appendChild(el("span", null, ds.label));
        var lastV = null;
        for (var lj = ds.values.length - 1; lj >= 0; lj--) {
          if (ds.values[lj] !== null) { lastV = ds.values[lj]; break; }
        }
        var vb = el("b", "ov-val", F.fmtF(lastV, ds.decimals || 0) + ds.unit);
        var d = winDelta(0, null, lastV, ds.invert);
        b.appendChild(vb);
        b.addEventListener("click", function () {
          var pos = keys.indexOf(idx);
          if (pos >= 0) {
            keys.splice(pos, 1);
            b.classList.remove("toggled");
          } else {
            keys.push(idx);
            b.classList.add("toggled");
          }
          redraw();
        });
        legend.appendChild(b);
      })(li);
    }
    redraw();
    return wrap;
  }

  function renderWorld(report) {
    var w = report.world;
    var sec = el("div", "sub-block");
    sec.appendChild(sectionHead("世界", "實體總數與類型分佈"));
    var kv = el("div", "kv-grid");
    if (w.total) {
      var it = el("div", "kv");
      it.appendChild(el("div", "kv-label", "實體總數"));
      it.appendChild(el("div", "kv-value", String(w.total)));
      kv.appendChild(it);
    }
    if (w.dist.length) {
      var sorted = w.dist.slice().sort(function (a, b) { return b[0] - a[0] || (b[1] < a[1] ? -1 : b[1] > a[1] ? 1 : 0); });
      var denom = sorted[0][0];
      var total = w.total || sorted.reduce(function (acc, en) { return acc + en[0]; }, 0);
      var dl = el("div", "dist-list");
      var head = Math.min(10, sorted.length);
      for (var j = 0; j < sorted.length; j++) {
        var en = sorted[j];
        var row = el("div", "dist-row");
        var name = el("span", "d-name", en[1]);
        name.title = en[1];
        row.appendChild(name);
        var bar = el("span", "d-bar");
        var inner = el("i", null);
        inner.style.width = denom ? Math.min(100, (en[0] / denom) * 100) + "%" : "0%";
        bar.appendChild(inner);
        row.appendChild(bar);
        var num = el("span", "d-num");
        num.appendChild(document.createTextNode(String(en[0]) + " 隻"));
        var p = el("span", "d-pct", "(" + F.pctStr((en[0] / total) * 100) + "%)");
        num.appendChild(p);
        row.appendChild(num);
        dl.appendChild(row);
      }
      sec.appendChild(dl);
      if (sorted.length > head) {
        var restRows = dl.childNodes;
        for (var j2 = head; j2 < restRows.length; j2++) restRows[j2].style.display = "none";
        var showAll = false;
        var btn = el("button", "collapse-btn", null);
        btn.type = "button";
        btn.appendChild(el("span", "collapse-arrow", "▶"));
        var label = document.createTextNode("顯示全部實體（" + sorted.length + "）");
        btn.appendChild(label);
        btn.addEventListener("click", function () {
          showAll = !showAll;
          var rows2 = dl.childNodes;
          for (var k = head; k < rows2.length; k++) rows2[k].style.display = showAll ? "" : "none";
          btn.classList.toggle("open", showAll);
          label.nodeValue = showAll ? "收合實體列表" : "顯示全部實體（" + sorted.length + "）";
        });
        sec.appendChild(btn);
      }
    }
    sec.appendChild(kv);
    return sec;
  }

  function hotRows(list, denom, showPlugin) {
    var tbody = el("tbody");
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      var r = el("tr");
      var pct = denom ? (w[3] * 100) / denom : 0;
      var pctTd = el("td", "pct", F.pctStr(pct) + "%");
      if (denom) {
        pctTd.title = F.fmtF(w[3], 0) + "ms / 總採樣 " + F.fmtF(denom, 0) + "ms";
        var cb = el("span", "cell-bar");
        var inner = el("i", null);
        inner.style.width = Math.min(100, pct) + "%";
        cb.appendChild(inner);
        pctTd.appendChild(cb);
      }
      r.appendChild(pctTd);
      var c = el("td", null);
      c.appendChild(methodChip(w[0], w[1], w[2], showPlugin ? w[4] : null));
      r.appendChild(c);
      r.appendChild(el("td", "num", F.fmtF(w[3], 0) + "ms"));
      tbody.appendChild(r);
    }
    return tbody;
  }

  function hotTable(columns, list, denom, showPlugin) {
    var tbl = el("div", "table-wrap");
    var table = el("table", "hot-table");
    var thead = el("thead");
    var tr = el("tr");
    for (var i = 0; i < columns.length; i++) {
      var headClass = i === 0 ? "pct" : (i === columns.length - 1 ? "num" : null);
      tr.appendChild(el("th", headClass, columns[i]));
    }
    thead.appendChild(tr);
    table.appendChild(thead);
    table.appendChild(hotRows(list, denom, showPlugin));
    tbl.appendChild(table);
    return tbl;
  }

  function renderThreads(report) {
    var sec = el("div", "sub-block");
    var note = el("div", "note-list");
    note.style.margin = "12px 0 20px";
    var notes = [
      "熱點以 self time 統計；已排除等待/idle、執行緒入口框架與 java.* 基礎框架",
      "百分比 = 佔總採樣，可與「已排除」表直接相加",
      "熱點後綴 :N = 該方法內的原始碼行號（來自 bytecode LineNumberTable）",
      "行尾 [插件] = 該類別歸屬於的插件（spark classSources 歸因）",
    ];
    for (var i = 0; i < notes.length; i++) {
      var n = el("div", "note-item");
      n.appendChild(el("span", "tag", "說明"));
      n.appendChild(el("span", null, notes[i]));
      note.appendChild(n);
    }
    sec.appendChild(note);

    var threads = report.threads;
    var list = el("div", "thread-list");
    var listHead = el("div", "thread-list-head");
    var toggleAll = el("button", "thread-toggle", "全部展開");
    listHead.appendChild(toggleAll);
    list.appendChild(listHead);

    var details = [];
    for (var t = 0; t < threads.length; t++) {
      var th = threads[t];
      var row = el("div", "thread-row");
      var head = el("div", "collapse-btn thread-row-head");
      head.setAttribute("role", "button");
      head.tabIndex = 0;
      head.appendChild(el("span", "collapse-arrow", "▶"));
      head.appendChild(el("span", "thread-name", th.name));
      head.appendChild(el("span", "thread-role", th.role));
      var bwrap = el("span", "thread-busy");
      if (th.busyPct !== null && th.busyPct !== undefined) {
        var bar = el("span", "thread-busybar");
        var inner = el("i", null);
        inner.style.width = Math.min(100, th.busyPct) + "%";
        bar.appendChild(inner);
        bwrap.appendChild(bar);
        var bv = el("span", "thread-busyval", F.fmtF(th.busyPct, 2) + "%");
        if (th.hasPool) bv.title = "合併執行緒池（xN）分母 dur×N";
        bwrap.appendChild(bv);
      } else {
        bwrap.appendChild(el("span", "thread-busyval", "—"));
      }
      head.appendChild(bwrap);
      head.appendChild(el("span", "thread-busy-meta", "採樣 " + F.fmtF(th._grand, 0) + (th.idleRatio ? " · idle " + F.fmtF(th.idleRatio, 0) + "%" : "")));
      row.appendChild(head);

      var detail = el("div", "collapse-body");
      if (th.noData || th.noTime) {
        detail.appendChild(el("div", "thread-meta", th.noData ? "（無堆疊資料）" : "（無時間資料）"));
        detail.classList.add("open");
      } else {
        var two = el("div", "two-col");
        var left = el("div", null);
        left.appendChild(tsec("熱點 top 20", hotTable(["self", "方法", "self ms"], th.workTop, th._grand, true), true));
        two.appendChild(left);
        var right = el("div", null);
        right.appendChild(tsec("已排除（前 15，排除共 " + F.fmtF(th.exclTotalPct, 0) + "%，長尾 " + F.fmtF(th.exclTailPct, 1) + "% 未列）", hotTable(["self", "方法", "self ms"], th.exclTop, th._grand, false), true));
        two.appendChild(right);
        detail.appendChild(two);

        if (th.incTop.length) {
          var incTbl = el("div", "table-wrap");
          var table = el("table", "hot-table");
          var thead = el("thead");
          var tr = el("tr");
          ["含子（self）", "方法", "含子 ms"].forEach(function (h, hi) {
            tr.appendChild(el("th", hi === 0 ? "pct" : (hi === 2 ? "num" : null), h));
          });
          thead.appendChild(tr);
          table.appendChild(thead);
          var tbody = el("tbody");
          for (var q = 0; q < th.incTop.length; q++) {
            var inc = th.incTop[q];
            var r = el("tr");
            var incPct = el("td", "pct", F.pctStr((inc[3] * 100) / th._grand) + "% (" + F.pctStr((inc[4] * 100) / th._grand) + "%)");
            incPct.title = "含子時間可超過 100%：同一方法出現在多條呼叫路徑時會重複計入";
            r.appendChild(incPct);
            var c = el("td", null);
            c.appendChild(methodChip(inc[0], inc[1], inc[2], inc[5]));
            r.appendChild(c);
            r.appendChild(el("td", "num", F.fmtF(inc[3], 0) + "ms"));
            tbody.appendChild(r);
          }
          table.appendChild(tbody);
          incTbl.appendChild(table);
          detail.appendChild(tsec("含子時間榜（含全部子呼叫，與 spark 網站一致；含子 ≥1% 才列出，百分比不可互相相加）", incTbl, true));
        }
      }
      row.appendChild(detail);

      details.push({ head: head, body: detail, no: !!(th.noData || th.noTime) });
      head.addEventListener("click", function () {
        this.classList.toggle("open");
        this.nextSibling.classList.toggle("open");
      });
      head.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.classList.toggle("open");
          this.nextSibling.classList.toggle("open");
        }
      });
      list.appendChild(row);
    }

    var allOpen = details.length > 0 && details[0].head.classList.contains("open");
    toggleAll.addEventListener("click", function () {
      allOpen = !allOpen;
      for (var d = 0; d < details.length; d++) {
        if (details[d].no) continue;
        details[d].head.classList.toggle("open", allOpen);
        details[d].body.classList.toggle("open", allOpen);
      }
      toggleAll.textContent = allOpen ? "全部收合" : "全部展開";
    });
    if (!details.length || details[0].head.classList.contains("open")) toggleAll.textContent = "全部收合";

    sec.appendChild(list);
    return sec;
  }

  function renderServerAgg(report) {
    var agg = report.serverAgg;
    if (!agg) return null;
    var sec = el("div", "sub-block");
    sec.appendChild(sectionHead("全伺服器彙總", "所有執行緒合併（self time）"));
    sec.appendChild(el("div", "thread-meta", "總採樣 " + F.fmtF(agg.grand, 0) + "（等待/idle " + F.fmtF(agg.idlePct, 0) + "% 已排除）"));
    sec.appendChild(tsec("熱點 top 20", hotTable(["self", "方法", "self ms"], agg.topAll, agg.grand, true), true));
    sec.appendChild(tsec("已排除（前 15，排除共 " + F.fmtF(agg.exclTotalPct, 0) + "%，長尾 " + F.fmtF(agg.exclTailPct, 1) + "% 未列）", hotTable(["self", "方法", "self ms"], agg.exclTop, agg.grand, false), true));
    if (agg.incTop.length) {
      var incTbl = el("div", "table-wrap");
       var table = el("table", "hot-table");
      var thead = el("thead");
      var tr = el("tr");
       ["含子（self）", "方法", "含子 ms"].forEach(function (h, hi) {
         tr.appendChild(el("th", hi === 0 ? "pct" : (hi === 2 ? "num" : null), h));
      });
      thead.appendChild(tr);
      table.appendChild(thead);
      var tbody = el("tbody");
      for (var q = 0; q < agg.incTop.length; q++) {
        var inc = agg.incTop[q];
        var r = el("tr");
        var aggPct = el("td", "pct", F.pctStr((inc[3] * 100) / agg.grand) + "% (" + F.pctStr((inc[4] * 100) / agg.grand) + "%)");
        aggPct.title = "含子時間可超過 100%：同一方法出現在多條呼叫路徑時會重複計入";
        r.appendChild(aggPct);
        var c = el("td", null);
        c.appendChild(methodChip(inc[0], inc[1], inc[2], inc[5]));
        r.appendChild(c);
        r.appendChild(el("td", "num", F.fmtF(inc[3], 0) + "ms"));
        tbody.appendChild(r);
      }
      table.appendChild(tbody);
      incTbl.appendChild(table);
      sec.appendChild(tsec("含子時間榜（含子 ≥1%，百分比不可互相相加）", incTbl, true));
    }
    return sec;
  }

  function renderHari(report) {
    var h = report.hari;
    if (!h) return null;
    var sec = el("div", "sub-block");
    sec.appendChild(sectionHead("Hari 熱點", "io.hari. 橋接相關節點"));
    sec.appendChild(el("div", "thread-meta", "命中 " + h.count + " 節點，累計 " + F.fmtF(h.total, 0) + "ms（佔總採樣 " + F.pctStr((h.total * 100) / h.overall) + "%）"));
    var tbl = el("div", "table-wrap");
    var table = el("table");
    var thead = el("thead");
    var tr = el("tr");
    tr.appendChild(el("th", "num", "self"));
    tr.appendChild(el("th", null, "節點"));
    thead.appendChild(tr);
    table.appendChild(thead);
    var tbody = el("tbody");
    for (var i = 0; i < h.items.length; i++) {
      var r = el("tr");
      r.appendChild(el("td", "num", F.pctStr((h.items[i][1] * 100) / h.overall) + "%"));
      var nm = hariName(h.items[i][0]);
      var td = el("td", "strong mono", nm[0]);
      td.title = nm[1];
      r.appendChild(td);
      tbody.appendChild(r);
    }
    table.appendChild(tbody);
    tbl.appendChild(table);
    sec.appendChild(tbl);
    return sec;
  }

  function renderDetail(report) {
    var out = [];
    var envSec = el("section", "section");
    envSec.id = "sec-env";
    envSec.appendChild(sectionHead("環境與取樣", "報告元資料、TPS/MSPT 統計與世界狀態"));
    envSec.appendChild(renderEnv(report));
    envSec.appendChild(renderTpsMspt(report));
    envSec.appendChild(renderWorld(report));
    out.push(envSec);

    var thSec = el("section", "section");
    thSec.id = "sec-threads";
    thSec.appendChild(sectionHead("執行緒詳細", "各執行緒熱點、已排除與含子時間榜"));
    thSec.appendChild(renderThreads(report));
    var agg = renderServerAgg(report);
    if (agg) thSec.appendChild(agg);
    var hari = renderHari(report);
    if (hari) thSec.appendChild(hari);
    out.push(thSec);
    return out;
  }

  /* ===== 主渲染 ===== */

  var navEl = null;
  var navHandler = null;

  function setupNav() {
    if (!navEl) {
      navEl = el("nav", "section-nav");
    } else {
      navEl.innerHTML = "";
    }
    var targets = [];
    var secIds = ["sec-overview", "sec-causes", "sec-plugins", "sec-threads", "sec-env"];
    var labels = ["總覽", "根因", "插件", "執行緒", "環境"];
    for (var i = 0; i < secIds.length; i++) {
      var s = document.getElementById(secIds[i]);
      if (s) targets.push([s, labels[i]]);
    }
    if (!targets.length) {
      navEl.classList.remove("show");
      return;
    }
    var pills = [];
    for (var q = 0; q < targets.length; q++) {
      (function (idx) {
        var p = el("button", "nav-pill", targets[idx][1]);
        p.type = "button";
        p.addEventListener("click", function () {
          var top = targets[idx][0].offsetTop - 70;
          window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        });
        pills.push(p);
        navEl.appendChild(p);
      })(q);
    }
    navEl.classList.add("show");
    if (resultsEl.firstChild !== navEl) {
      resultsEl.insertBefore(navEl, resultsEl.firstChild);
    }
    var onScroll = function () {
      var y = window.scrollY + 80;
      var cur = -1;
      for (var k = 0; k < targets.length; k++) {
        if (targets[k][0].offsetTop <= y) cur = k;
      }
      for (var m = 0; m < pills.length; m++) {
        pills[m].classList.toggle("active", m === cur);
      }
    };
    if (navHandler) window.removeEventListener("scroll", navHandler);
    navHandler = onScroll;
    window.addEventListener("scroll", navHandler, { passive: true });
    onScroll();
  }

  function renderReport(report) {
    resultsEl.innerHTML = "";
    currentReport = report;
    var d = report.diag;
    if (report.allocation) {
      var note = el("div", "note-item");
      note.appendChild(el("span", "tag", "注意"));
      note.appendChild(el("span", null, "ALLOCATION 模式（times 為配置位元組數，時間語意不適用，診斷略過）"));
      resultsEl.appendChild(note);
      var dts = renderDetail(report);
      for (var z = 0; z < dts.length; z++) resultsEl.appendChild(dts[z]);
      return;
    }
    resultsEl.appendChild(renderDiagnosis(d));
    resultsEl.appendChild(renderCauses(d));
    var ex = renderExclusions(d);
    var pl = renderPlugins(d);
    if (ex && pl) {
      var aux1 = el("div", "aux-grid");
      aux1.appendChild(ex);
      aux1.appendChild(pl);
      resultsEl.appendChild(aux1);
    } else {
      if (ex) resultsEl.appendChild(ex);
      if (pl) resultsEl.appendChild(pl);
    }
    var aux2 = el("div", "aux-grid");
    aux2.appendChild(renderRegions(d));
    aux2.appendChild(renderCorrelation(d));
    resultsEl.appendChild(aux2);
    var dts2 = renderDetail(report);
    for (var y = 0; y < dts2.length; y++) resultsEl.appendChild(dts2[y]);
    setupNav();
    debugScan0x();
  }

  /* ===== 資料流程 ===== */

  async function runAnalysis(input) {
    var parsed = SparkData.parseInput(input);
    if (parsed.error) {
      showError(parsed.error);
      return;
    }
    await runWith(parsed.id, null, null);
  }

  async function runWith(id, buf, name) {
    showLoading();
    analyzeBtn.disabled = true;
    try {
      var data = buf !== null ? buf : await SparkData.fetchProfile(id);
      var res = await SparkEngine.analyze(data, id || (name || "?"));
      renderReport(res.report);
      if (id) {
        var url = "?id=" + id;
        reportCache[url] = res.report;
        try { history.pushState({ url: url }, "", url); } catch (e) { /* ignore */ }
        document.title = "spark 分析器 — " + id;
      }
    } catch (err) {
      showError(err && err.message ? err.message : "分析失敗：" + err);
    } finally {
      analyzeBtn.disabled = false;
    }
  }

  function init() {
    resultsEl = document.getElementById("results");
    inputEl = document.getElementById("report-input");
    analyzeBtn = document.getElementById("analyze-btn");
    fileInput = document.getElementById("file-input");
    emptyStateEl = document.getElementById("empty-state");

    var go = function () { runAnalysis(inputEl.value); };
    analyzeBtn.addEventListener("click", go);
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") go();
    });
    fileInput.addEventListener("change", function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      var name = f.name.replace(/\.sparkprofile$/i, "").replace(/\.bin$/i, "");
      SparkData.readFile(f).then(function (buf) {
        return runWith(null, buf, name);
      }).catch(function (err) {
        showError(err && err.message ? err.message : "讀取檔案失敗");
        fileInput.value = "";
      });
    });

    window.addEventListener("popstate", function (e) {
      var st = e.state;
      if (st && st.url && reportCache[st.url]) {
        var rid = st.url.replace("?id=", "");
        document.title = "spark 分析器 — " + rid;
        renderReport(reportCache[st.url]);
      } else {
        currentReport = null;
        document.title = "spark 分析器";
        resultsEl.innerHTML = "";
        resultsEl.appendChild(emptyStateEl);
      }
    });

    var qid = SparkData.idFromQuery();
    if (qid && SparkData.parseInput(qid).id) {
      inputEl.value = qid;
      runWith(qid, null, null);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  root.SparkApp = { renderReport: renderReport, runWith: runWith };
})(typeof globalThis !== "undefined" ? globalThis : this);
