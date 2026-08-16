/*!
 * engine.js — spark 取樣報告分析引擎（Lag Diagnosis Engine），瀏覽器 / Node 通用
 *
 * 1:1 移植自 spark-analyze.py 的診斷層：
 *   buildReport(bytes, label) → 結構化報告（供網頁 UI 渲染）
 *   renderText(report)        → 與 Python 輸出逐字元相同的純文字報告（供驗證/降級顯示）
 *
 * 依賴：protobuf.js（先載入，root.SparkProto）。
 * 所有對外字串皆為繁體中文。
 */
(function (root) {
  "use strict";

  var P = root.SparkProto;
  var get = P.get;
  var allOf = P.allOf;
  var st = P.st;
  var vi = P.vi;
  var asDouble = P.asDouble;
  var safeParse = P.safeParse;
  var parseMsg = P.parseMsg;
  var gunzipIfNeeded = P.gunzipIfNeeded;

  // ----------------------------------------------------------------------
  // 常量
  // ----------------------------------------------------------------------

  var TICK_ROLES = new Set(["MAIN_TICK", "REGION_TICK"]);

  var CORE_PREFIXES = [
    "net.minecraft.",
    "io.papermc.",
    "io.canvasmc.",
    "com.destroystokyo.",
    "org.bukkit.",
  ];

  var CAUSE_LABEL = {
    ENTITY: "ENTITY OVERLOAD",
    CHUNK: "CHUNK WORKLOAD",
    PLUGIN: "PLUGIN CPU",
    VANILLA: "VANILLA CORE",
    IO: "IO 阻塞",
    NETWORK: "NETWORK 流量",
    GC: "GC 壓力",
    HARI: "HARI BRIDGE",
    UNKNOWN: "其他 / 第三方",
    SPARK: "spark 自身",
  };

  var EXCLUDE_LABEL = {
    IO: "IO/磁碟",
    NETWORK: "NETWORK",
    GC: "GC",
    HARI: "HARI bridge",
    SPARK: "spark 自身",
    UNKNOWN: "第三方/其他",
  };

  // 精確的等待/idle 配對（類別, 方法）
  var WAIT_IDLE_PAIRS = new Set([
    "jdk.internal.misc.Unsafe\u0000park",
    "jdk.internal.misc.Unsafe\u0000parkNanos",
    "java.util.concurrent.locks.LockSupport\u0000park",
    "java.util.concurrent.locks.LockSupport\u0000parkNanos",
    "java.lang.Thread\u0000sleep",
    "java.lang.Thread\u0000yield",
    "java.lang.Object\u0000wait",
    "java.util.concurrent.locks.AbstractQueuedSynchronizer\u0000parkAndCheckInterrupt",
    "java.util.concurrent.locks.AbstractQueuedSynchronizer\u0000acquireQueued",
    "java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject\u0000await",
    "io.canvasmc.canvas.threadedregions.scheduler.AffinitySchedulerThreadPool$TickThreadRunner\u0000waitUntilDeadline",
    "net.minecraft.server.MinecraftServer\u0000recordTaskExecutionTimeWhileWaiting",
  ]);

  /* 等待配對的兩層索引（cls → 方法集合）：collectThreads 每節點查詢時
   * 省去 "cls\0mth" 字串拼接。 */
  var WAIT_IDLE_BY_CLS = new Map();
  for (var _wip of WAIT_IDLE_PAIRS) {
    var _sep = _wip.indexOf("\u0000");
    var _wc = _wip.slice(0, _sep);
    var _wm = _wip.slice(_sep + 1);
    var _ws = WAIT_IDLE_BY_CLS.get(_wc);
    if (!_ws) {
      _ws = new Set();
      WAIT_IDLE_BY_CLS.set(_wc, _ws);
    }
    _ws.add(_wm);
  }

  function isWaitIdle(cls, mth) {
    var ws = WAIT_IDLE_BY_CLS.get(cls);
    return ws ? ws.has(mth) : false;
  }

  var ENTITY_BASE_CLASSES = new Set([
    "Entity", "LivingEntity", "Mob", "PathfinderMob", "Monster", "Animal",
    "AgeableMob", "NeutralMob", "WaterAnimal", "AmbientCreature", "FlyingMob",
    "Golem", "AbstractSchoolingFish", "TamableAnimal", "BreedableAnimal",
    "EntityTickList", "EntityLookup", "EntityGetter", "EntityReference",
    "ServerEntity", "ServerEntityGetter", "EntitySelector", "EntityType",
  ]);

  // ----------------------------------------------------------------------
  // 格式化（與 Python 輸出逐字元一致）
  // ----------------------------------------------------------------------

  /* Python 的 format 採用 round-half-even；JS 的 toFixed 不是。
   * pyRound 重現 Python 的捨入行為。 */
  function pyRound(v, nd) {
    if (!Number.isFinite(v)) return v;
    var neg = v < 0 ? -1 : 1;
    var av = Math.abs(v);
    var f = Math.pow(10, nd);
    var scaled = av * f;
    var fl = Math.floor(scaled);
    var frac = scaled - fl;
    var r;
    if (Math.abs(frac - 0.5) < 1e-9) {
      r = fl % 2 === 0 ? fl : fl + 1;
    } else {
      r = Math.round(scaled);
    }
    return (neg * r) / f;
  }

  function fmtF(v, nd) {
    return pyRound(v, nd).toFixed(nd);
  }

  /* Python str(float) 的最短表示：整數值浮點會附加 ".0"。 */
  function pyStr(v) {
    if (v === null || v === undefined) return "?";
    if (typeof v === "number") {
      if (Number.isInteger(v)) {
        if (Math.abs(v) < 1e16) return v + ".0";
        return v.toExponential();
      }
      return String(v);
    }
    return String(v);
  }

  function fmtMspt(v) {
    if (v === null || v === undefined) return "-";
    return fmtF(v, 2);
  }

  function fnum(v) {
    if (v === null || v === undefined) return "?";
    return pyStr(v);
  }

  function pctStr(v) {
    for (var nd = 1; nd <= 8; nd++) {
      var s = fmtF(v, nd);
      if (parseFloat(s) !== 0) return s;
    }
    return "0";
  }

  function fmtTs(ms) {
    var d = new Date(ms);
    var p = function (x) { return String(x).padStart(2, "0"); };
    return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
      " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds()) + " UTC";
  }

  /* Python 的整數地板除法（used * 100 // maxv）：以 BigInt 保證精確。 */
  function pydFloorDiv(a, b) {
    return Number(BigInt(a) * 100n / BigInt(b));
  }

  // ----------------------------------------------------------------------
  // 噪音判定（熱點排除清單）
  // ----------------------------------------------------------------------

  /* 快取 (cls, mth) 噪音判定：上限 20 萬筆，超過直接清空重來
   * （防止動態產生類別名導致 key 空間失控）。 */
  var _noiseCache = new Map();
  var _noiseIncCache = new Map();

  function isNoise(cls, mth) {
    var ck = cls + "\u0000" + mth;
    if (_noiseCache.has(ck)) return _noiseCache.get(ck);
    if (_noiseCache.size > 200000) _noiseCache.clear();
    var r;
    var full = cls + "." + mth;
    if (full.indexOf("Thread.run") !== -1 || full.indexOf("TickThreadRunner.run") !== -1) {
      r = true;
    } else if (full.indexOf("MinecraftServer.tickServer") !== -1 || full.indexOf("MinecraftServer.tickChildren") !== -1) {
      r = true;
    } else if (full.indexOf("DedicatedServer.tickServer") !== -1) {
      r = true;
    } else if (cls === "net.minecraft.server.MinecraftServer" && mth === "runServer") {
      r = true;
    } else if (cls === "net.minecraft.server.level.ServerLevel" && mth === "tick") {
      r = true;
    } else if (full.indexOf("ConcreteRegionTickHandle.tickRegion") !== -1 || full.indexOf("RegionScheduleHandle.runTick") !== -1) {
      r = true;
    } else if (full.indexOf("GlobalTickTickHandle.tickRegion") !== -1) {
      r = true;
    } else if (cls.indexOf("StackStreamFactory") !== -1 || full.indexOf("StackWalker.walk") !== -1) {
      r = true;
    } else if (cls.indexOf("java.") === 0 || cls.indexOf("jdk.internal.") === 0 || cls.indexOf("it.unimi.dsi.") === 0) {
      r = true;
    } else if (cls.indexOf("ca.spottedleaf.") === 0) {
      r = true;
    } else if (cls === "sun.nio.ch.IOUtil" && mth === "write1") {
      r = true;
    } else if (full.indexOf("native.") === 0 || cls.indexOf("native.") === 0 || cls === "native"
      || cls.indexOf(".so") === cls.length - 3
      || cls.indexOf(".so.") !== -1
      || full.indexOf("libc.so.") !== -1) {
      r = true;
    } else if (cls.indexOf("me.lucko.spark.") === 0 || cls === "sun.management.ThreadImpl") {
      r = true;
    } else {
      r = WAIT_IDLE_PAIRS.has(ck);
    }
    _noiseCache.set(ck, r);
    return r;
  }

  function isNoiseInc(cls, mth) {
    var ck = cls + "\u0000" + mth;
    if (_noiseIncCache.has(ck)) return _noiseIncCache.get(ck);
    if (_noiseIncCache.size > 200000) _noiseIncCache.clear();
    var r;
    if (isNoise(cls, mth)) {
      r = true;
    } else {
      var full = cls + "." + mth;
      r = cls.indexOf("$$Lambda") !== -1
        || mth.indexOf("lambda$spin") !== -1
        || full.indexOf("libjvm.so") !== -1
        || full.indexOf("processPacketsAndTick") !== -1;
    }
    _noiseIncCache.set(ck, r);
    return r;
  }

  // ----------------------------------------------------------------------
  // 樹還原（children refs → self time / inclusive time / parent 鏈）
  // ----------------------------------------------------------------------

  function buildTree(tnode) {
    var raw = allOf(tnode, 3);
    var n = raw.length;
    var cls = new Array(n);
    var mth = new Array(n);
    var line = new Array(n);
    var totals = new Array(n);
    var children = new Array(n);
    for (var i = 0; i < n; i++) {
      cls[i] = null;
      mth[i] = null;
      line[i] = 0;
      totals[i] = 0;
      children[i] = [];
    }
    try {
      for (i = 0; i < n; i++) {
        var v = raw[i];
        if (v instanceof Uint8Array) {
          var r = P.parseStackNode(v);
          cls[i] = r[0];
          mth[i] = r[1];
          line[i] = r[2];
          totals[i] = r[3];
          children[i] = r[4];
        }
      }
    } catch (e) {
      // 節點資料截斷/不支援的 wire type：整棵樹不可信 → 回傳空清單（fail-closed）
      return [];
    }
    var parent = new Array(n);
    for (i = 0; i < n; i++) parent[i] = -1;
    for (i = 0; i < n; i++) {
      var kids = children[i];
      for (var j = 0; j < kids.length; j++) {
        var k = kids[j];
        if (k >= 0 && k < n && parent[k] === -1) parent[k] = i;
      }
    }
    var selfT = totals.slice();
    for (i = 0; i < n; i++) {
      kids = children[i];
      for (j = 0; j < kids.length; j++) {
        k = kids[j];
        // 防禦：只扣「以自己為父」的子節點，避免重複引用被多次扣減
        if (k >= 0 && k < n && parent[k] === i) selfT[i] -= totals[k];
      }
    }
    var out = new Array(n);
    for (i = 0; i < n; i++) {
      out[i] = [st(cls[i]) || "?", st(mth[i]) || "?", line[i], Math.max(0, selfT[i]), totals[i], parent[i]];
    }
    return out;
  }

  // ----------------------------------------------------------------------
  // Thread role / 負載類別分類
  // ----------------------------------------------------------------------

  function threadRole(name) {
    var low = name.toLowerCase();
    if (/\bspark\b/.test(low)) return "SPARK";
    if (low.indexOf("netty") !== -1) return "NETWORK";
    if (low.indexOf("server thread") !== -1 || low.indexOf("servermain") !== -1) return "MAIN_TICK";
    if (low.indexOf("region scheduler") !== -1 || low.indexOf("global region") !== -1 || low.indexOf("tickthreadrunner") !== -1) return "REGION_TICK";
    if (low.indexOf("async") !== -1 || low.indexOf("worker-minecraft") !== -1 || low.indexOf("io-worker") !== -1) return "ASYNC";
    if (name.indexOf("(x") !== -1 || low.indexOf("pool") !== -1 || low.indexOf("worker") !== -1) return "WORKER";
    return "UNKNOWN";
  }

  function makeCategorizer(sources) {
    var plugCache = new Map();
    var catCache = new Map();
    // 前綴索引：索引鍵 = 來源類別 c 本身（sources 原始鍵），查詢時對 cls
    // 切出本身與所有「$」前綴逐一查表（最長來源類別優先，先建者同長度優先），
    // 取代逐條掃描 sources。
    var prefixIndex = new Map();
    for (var spair of sources.entries()) {
      var c0 = spair[0];
      var p0 = spair[1];
      var sold = prefixIndex.get(c0);
      if (!sold || sold.len < c0.length) prefixIndex.set(c0, { p: p0, len: c0.length });
    }

    function pluginOf(cls) {
      if (plugCache.has(cls)) return plugCache.get(cls);
      var best = null;
      var blen = 0;
      var pos = 0;
      while (true) {
        var pre = pos === 0 ? cls : cls.slice(0, pos);
        var hit = prefixIndex.get(pre);
        if (hit && hit.len > blen) {
          best = hit.p;
          blen = hit.len;
        }
        if (pos === 0) {
          pos = cls.indexOf("$");
          if (pos === -1) break;
        } else {
          var npos = cls.indexOf("$", pos + 1);
          if (npos === -1) break;
          pos = npos;
        }
      }
      plugCache.set(cls, best);
      return best;
    }

    function startsWithAny(s, arr) {
      for (var i = 0; i < arr.length; i++) {
        if (s.indexOf(arr[i]) === 0) return true;
      }
      return false;
    }

    // 橋接表：類別名不含 Chunk/Entity 字樣、但方法名代表實體/區塊系統
    // 入口的 Minecraft 類別（如 ServerLevel.tickChunk），補上方法名判斷才
    // 歸入 ENTITY/CHUNK，避免被誤分類為 VANILLA。
    var ENTITY_BRIDGE = ["guardEntityTick", "tickEntities", "serverTickEntities"];
    var CHUNK_BRIDGE = ["tickChunk", "tickChunks", "chunkTick", "tickChunkMap"];

    function categorize(cls, mth) {
      var ck = cls + "\u0000" + mth;
      if (catCache.has(ck)) return catCache.get(ck);
      var r;
      if (cls.indexOf("io.hari.") === 0) {
        r = ["HARI", "io.hari.*"];
      } else if (cls.indexOf("me.lucko.spark.") === 0) {
        r = ["SPARK", "me.lucko.spark"];
      } else if (pluginOf(cls)) {
        r = ["PLUGIN", pluginOf(cls)];
      } else if (["GCTaskThread", "G1ParScan", "G1ConcRefine", "G1YoungGen", "G1OldGen"].some(function (s) { return cls.indexOf(s) !== -1; })) {
        r = ["GC", cls];
      } else if (startsWithAny(cls, CORE_PREFIXES) &&
        (cls.indexOf("Chunk") !== -1 || cls.indexOf("Entity") !== -1 || cls.indexOf("net.minecraft.world.entity.") === 0)) {
        r = [cls.indexOf("Chunk") !== -1 ? "CHUNK" : "ENTITY", cls];
      } else if (startsWithAny(cls, CORE_PREFIXES) && ENTITY_BRIDGE.indexOf(mth) !== -1) {
        r = ["ENTITY", cls];
      } else if (startsWithAny(cls, CORE_PREFIXES) && CHUNK_BRIDGE.indexOf(mth) !== -1) {
        r = ["CHUNK", cls];
      } else if (["netty", "PacketEncoder", "PacketDecoder", "PacketListener", "PacketUtils"].some(function (s) { return cls.indexOf(s) !== -1; })) {
        r = ["NETWORK", cls];
      } else if (["RegionFile", "FileChannel", "FileOutputStream", "FileInputStream",
        "RandomAccessFile", "nio.channels", "FileStore",
        "RegionAndLevelChunkSaveFile", "FileUtil"].some(function (s) { return cls.indexOf(s) !== -1; })) {
        r = ["IO", cls];
      } else if (startsWithAny(cls, CORE_PREFIXES)) {
        r = ["VANILLA", cls];
      } else if (cls.indexOf("com.mojang.") === 0 || cls.indexOf("com.google.gson.") === 0) {
        r = ["VANILLA", cls];
      } else {
        r = ["UNKNOWN", cls];
      }
      catCache.set(ck, r);
      return r;
    }

    return { pluginOf: pluginOf, categorize: categorize };
  }

  // ----------------------------------------------------------------------
  // 鍵（(cls, mth, line) 三元組 ↔ 字串）
  // ----------------------------------------------------------------------

  function keyOf(cls, mth, line) {
    return cls + "\u0000" + mth + "\u0000" + line;
  }

  /* 快取 (cls, mth, line) 分割結果：同鍵反覆分割（熱點統計、執行緒彙總、
   * 診斷掃描共用）。上限 20 萬筆，超過直接清空重來（退化等同未快取）。 */
  var _splitCache = new Map();

  function splitKey(k) {
    var hit = _splitCache.get(k);
    if (hit) return hit;
    if (_splitCache.size > 200000) _splitCache.clear();
    var i = k.indexOf("\u0000");
    var j = k.lastIndexOf("\u0000");
    var parts = [k.slice(0, i), k.slice(i + 1, j), Number(k.slice(j + 1))];
    _splitCache.set(k, parts);
    return parts;
  }

  // ----------------------------------------------------------------------
  // 中間資料結構：執行緒彙總
  // ----------------------------------------------------------------------

  function collectThreads(root, exemptSet) {
    var threads = [];
    var tnodes = allOf(root, 2);
    for (var i = 0; i < tnodes.length; i++) {
      var tn = safeParse(tnodes[i]);
      if (!tn) continue;
      var name = st(get(tn, 1)) || "?";
      var nodes = buildTree(tn);
      var agg = new Map();
      var aggInc = new Map();
      var grand = 0;
      var javaSum = new Map();
      for (var j = 0; j < nodes.length; j++) {
        var cls = nodes[j][0];
        var mth = nodes[j][1];
        var line = nodes[j][2];
        var stv = nodes[j][3];
        var itv = nodes[j][4];
        grand += stv;
        if (cls.indexOf("java.") === 0) {
          var jk = cls + "\u0000" + mth;
          javaSum.set(jk, (javaSum.get(jk) || 0) + stv);
        }
        var key = keyOf(cls, mth, line);
        agg.set(key, (agg.get(key) || 0) + stv);
        aggInc.set(key, (aggInc.get(key) || 0) + itv);
      }
      var work = new Map();
      var excluded = new Map();
      // idle = 等待/閒置時間（非 idle 基數用）：取「未被其他等待節點涵蓋的
      // WAIT_IDLE 節點」inc。祖先涵蓋檢查避免重複計入。
      var idle = 0;
      var waitIdx = [];
      for (j = 0; j < nodes.length; j++) {
        if (isWaitIdle(nodes[j][0], nodes[j][1])) waitIdx.push(j);
      }
      var maxDepth = nodes.length;
      for (j = 0; j < waitIdx.length; j++) {
        var idx = waitIdx[j];
        var p = nodes[idx][5];
        var covered = false;
        var depth = 0;
        while (p >= 0 && depth < maxDepth) {
          if (isWaitIdle(nodes[p][0], nodes[p][1])) {
            covered = true;
            break;
          }
          p = nodes[p][5];
          depth += 1;
        }
        if (!covered) idle += nodes[idx][4];
      }
      for (var entry of agg.entries()) {
        var k = entry[0];
        var t = entry[1];
        var parts = splitKey(k);
        var pc = parts[0];
        var pm = parts[1];
        // java.* 高佔比豁免：某 java 方法自身時間佔該執行緒 ≥10% 時視為
        // 顯著原因（非噪音），納入全域豁免集合，供診斷/鏈/含子榜共用，
        // 確保各處對同一方法的處理一致。
        if (isNoise(pc, pm)) {
          if (pc.indexOf("java.") === 0 && (javaSum.get(pc + "\u0000" + pm) || 0) >= grand * 0.1) {
            exemptSet.add(pc + "\u0000" + pm);
            work.set(k, t);
          } else {
            excluded.set(k, t);
          }
        } else {
          work.set(k, t);
        }
      }
      threads.push({
        name: name,
        role: threadRole(name),
        nodes: nodes,
        grand: grand,
        idle: idle,
        work: work,
        excluded: excluded,
        aggInc: aggInc,
      });
    }
    return threads;
  }

  function threadBusyPct(name, activeMs, durMs) {
    if (!durMs || durMs <= 0) return null;
    var m = /\(x(\d+)\)/.exec(name);
    var pool = m ? parseInt(m[1], 10) : 1;
    if (pool <= 0) pool = 1;
    if (activeMs <= 0) return 0;
    return (activeMs * 100) / (durMs * pool);
  }

  function parseWindows(root) {
    var wins = [];
    var all = allOf(root, 7);
    for (var i = 0; i < all.length; i++) {
      var w = safeParse(all[i]);
      if (!w) continue;
      var wi = safeParse(get(w, 2));
      if (!wi) continue;
      var wTps = asDouble(get(wi, 4));
      var wMspt = asDouble(get(wi, 6));
      var wEnt = vi(get(wi, 8), null);
      var wCh = vi(get(wi, 10), null);
      var wDur = vi(get(wi, 13), null);
      if (wTps === null && wEnt === null && wCh === null && wMspt === null) continue;
      wins.push({
        dur_s: wDur ? wDur / 1000 : null,
        startMs: asDouble(get(wi, 11)),
        tps: wTps,
        mspt: wMspt,
        entities: wEnt,
        chunks: wCh,
      });
    }
    return wins;
  }

  function weightedTps(wins) {
    var tot = 0;
    var den = 0;
    for (var i = 0; i < wins.length; i++) {
      var w = wins[i];
      if (w.tps !== null && w.dur_s) {
        tot += w.tps * w.dur_s;
        den += w.dur_s;
      }
    }
    return den ? tot / den : null;
  }

  function windowAvg(wins, key) {
    var tot = 0;
    var den = 0;
    for (var i = 0; i < wins.length; i++) {
      var v = wins[i][key];
      if (v !== null && v !== undefined && wins[i].dur_s) {
        tot += v * wins[i].dur_s;
        den += wins[i].dur_s;
      }
    }
    return den ? tot / den : null;
  }

  // ----------------------------------------------------------------------
  // 診斷引擎：confidence / tick 成本
  // ----------------------------------------------------------------------

  function confidence(selfPct, overrun) {
    if (selfPct >= 15 && overrun !== null && overrun > 0) return "HIGH";
    if (overrun === null && selfPct >= 20) return "HIGH";
    if (selfPct >= 8) return "MEDIUM";
    return "LOW";
  }

  function severity(overrun, tps1m) {
    if (tps1m !== null && tps1m < 15) return "嚴重";
    if (overrun !== null && overrun >= 20) return "嚴重";
    if (tps1m !== null && tps1m < 19) return "中等";
    if (overrun !== null && overrun >= 5) return "中等";
    return "輕微";
  }

  function tickFactor(durationMs, tpsAvg, target) {
    if (!durationMs || durationMs <= 0) return null;
    // tpsAvg=0（完全凍結）時不誤用 target：回傳 null（無法估算每 tick 成本）
    var tps = (tpsAvg === null || tpsAvg === undefined) ? target : Math.min(tpsAvg, target);
    if (tps <= 0) return null;
    var secs = durationMs / 1000;
    if (secs <= 0) return null;
    return 1 / (secs * tps);
  }

  function aggregateByCategory(threads, categorize) {
    var out = new Map();
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i];
      for (var entry of t.work.entries()) {
        var k = entry[0];
        var stv = entry[1];
        var parts = splitKey(k);
        var cat = categorize(parts[0], parts[1]);
        var c = cat[0];
        var ev = cat[1];
        var d = out.get(c);
        if (!d) {
          d = { self: 0, inc: 0, evidence: new Map(), threads: new Set(), top: new Map(), topInc: new Map() };
          out.set(c, d);
        }
        d.self += stv;
        d.inc += t.aggInc.get(k) || 0;
        d.evidence.set(ev, (d.evidence.get(ev) || 0) + stv);
        d.top.set(k, (d.top.get(k) || 0) + stv);
        d.topInc.set(k, (d.topInc.get(k) || 0) + (t.aggInc.get(k) || 0));
        d.threads.add(t.name);
      }
    }
    return out;
  }

  function aggregateByPlugin(threads, categorize) {
    var out = new Map();
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i];
      for (var entry of t.work.entries()) {
        var k = entry[0];
        var stv = entry[1];
        var parts = splitKey(k);
        var cat = categorize(parts[0], parts[1]);
        if (cat[0] !== "PLUGIN") continue;
        var ev = cat[1];
        var d = out.get(ev);
        if (!d) {
          d = { self: 0, methods: new Map() };
          out.set(ev, d);
        }
        d.self += stv;
        d.methods.set(k, (d.methods.get(k) || 0) + stv);
      }
    }
    return out;
  }

  // ----------------------------------------------------------------------
  // 實體分項
  // ----------------------------------------------------------------------

  /* Python heapq.nlargest / sorted 的語意重現：
   * n==null → 依 count 降冪（穩定）；n 給定 → 維持 top-n 的
   * (count, order) 堆選（count 相同時先出現者優先）。 */
  function mostCommon(m, limit) {
    var items = [];
    var i = 0;
    for (var entry of m.entries()) items.push(entry);
    if (limit === null || limit === undefined || limit >= items.length) {
      items.sort(function (a, b) { return b[1] - a[1]; });
      return items;
    }
    var heap = [];
    var order = 0;
    for (i = 0; i < limit; i++) {
      heap.push([items[i][1], order--, items[i]]);
      if (i > 0) siftUp(heap, i);
    }
    var top = heap[0][0];
    order = -limit;
    for (i = limit; i < items.length; i++) {
      var k = items[i][1];
      if (k > top) {
        heap[0] = [k, order, items[i]];
        siftDown(heap, 0);
        top = heap[0][0];
        order -= 1;
      }
    }
    heap.sort(function (a, b) { return b[0] - a[0] || b[1] - a[1]; });
    var out = [];
    for (i = 0; i < heap.length; i++) out.push(heap[i][2]);
    return out;
  }

  function siftUp(h, i) {
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (less(h[i], h[p])) {
        var tmp = h[i];
        h[i] = h[p];
        h[p] = tmp;
        i = p;
      } else {
        break;
      }
    }
  }

  function siftDown(h, i) {
    var n = h.length;
    while (true) {
      var l = 2 * i + 1;
      var r = l + 1;
      var m = i;
      if (l < n && less(h[l], h[m])) m = l;
      if (r < n && less(h[r], h[m])) m = r;
      if (m === i) break;
      var tmp = h[i];
      h[i] = h[m];
      h[m] = tmp;
      i = m;
    }
  }

  function less(a, b) {
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  }

  function entityBreakdown(threads, categorize) {
    var sections = new Map();
    var specific = new Map();
    var aiOwners = new Map();
    function add(m, key, v) {
      m.set(key, (m.get(key) || 0) + v);
    }
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i];
      for (var entry of t.work.entries()) {
        var k = entry[0];
        var stv = entry[1];
        var parts = splitKey(k);
        var cat = categorize(parts[0], parts[1]);
        if (cat[0] !== "ENTITY") continue;
        var cls = parts[0];
        if (cls.indexOf("net.minecraft.world.entity.ai.attributes.") === 0) {
          add(sections, "實體基底/通用", stv);
        } else if (cls.indexOf("net.minecraft.world.entity.ai.") === 0) {
          add(sections, "AI 目標/行為", stv);
        } else if (cls.indexOf("SynchedEntityData") !== -1) {
          add(sections, "資料同步", stv);
        } else if (cls.indexOf("EntityTickList") !== -1 || cls.indexOf("EntityLookup") !== -1
          || cls.indexOf("EntityGetter") !== -1 || cls.indexOf("EntityReference") !== -1
          || cls.indexOf("EntitySelector") !== -1) {
          add(sections, "實體分派/查詢", stv);
        } else if (cls.indexOf("ServerEntity") !== -1 || cls.indexOf("EntityTracker") !== -1
          || cls.indexOf("EntityAttachments") !== -1) {
          add(sections, "追蹤/同步", stv);
        } else if (cls.indexOf("block.entity") !== -1) {
          add(sections, "區塊實體(BlockEntity)", stv);
        } else if (cls.indexOf("org.bukkit.") === 0 || cls.indexOf("io.papermc.") === 0) {
          add(sections, "插件事件橋接", stv);
        } else if (cls.indexOf("net.minecraft.world.entity.") === 0) {
          var simple = cls.slice(cls.lastIndexOf(".") + 1);
          if (ENTITY_BASE_CLASSES.has(simple) || cls.indexOf("$$Lambda") !== -1) {
            add(sections, "實體基底/通用", stv);
          } else {
            add(sections, "個別實體類型", stv);
            add(specific, simple, stv);
          }
        } else {
          add(sections, "其他", stv);
        }
      }
      var nodes = t.nodes;
      var maxDepth = nodes.length;
      for (var j = 0; j < nodes.length; j++) {
        var node = nodes[j];
        var cls2 = node[0];
        var selfT = node[3];
        var parent = node[5];
        if (selfT <= 0 || cls2.indexOf("net.minecraft.world.entity.ai.") !== 0
          || cls2.indexOf("net.minecraft.world.entity.ai.attributes.") === 0) {
          continue;
        }
        var p = parent;
        var owner = null;
        var inactive = false;
        var system = false;
        var depth = 0;
        while (p >= 0 && depth < maxDepth) {
          var pc = nodes[p][0];
          if (pc === "net.minecraft.server.level.ServerLevel") {
            system = true;
          }
          if (pc === "net.minecraft.world.entity.Mob" && nodes[p][1] === "inactiveTick") {
            inactive = true;
          }
          if ((pc.indexOf("net.minecraft.world.entity.") === 0
            && pc.indexOf("net.minecraft.world.entity.ai.") !== 0)
            || pc === "net.minecraft.server.level.ServerPlayer") {
            var simple2 = pc.slice(pc.lastIndexOf(".") + 1);
            if (ENTITY_BASE_CLASSES.has(simple2) || pc.indexOf("$$Lambda") !== -1) {
              p = nodes[p][5];
              depth += 1;
              continue;
            }
            owner = simple2;
            break;
          }
          p = nodes[p][5];
          depth += 1;
        }
        if (owner) {
          add(aiOwners, owner, selfT);
        } else if (inactive) {
          add(aiOwners, "（停用區域實體 inactiveTick）", selfT);
        } else if (!system) {
          add(aiOwners, "未知入口", selfT);
        }
      }
    }
    return [sections, specific, aiOwners];
  }

  function rankCauses(catAgg, tickBase, factor, overrun) {
    var causes = [];
    for (var pair of catAgg.entries()) {
      var c = pair[0];
      var d = pair[1];
      if (d.self <= 0) continue;
      var selfPct = tickBase > 0 ? (d.self * 100) / tickBase : 0;
      var incRatio = d.self > 0 ? d.inc / d.self : 0;
      var cost = factor ? d.self * factor : null;
      var bestEv = "?";
      var bestEvT = 0;
      for (var ev of d.evidence.entries()) {
        if (ev[1] > bestEvT) {
          bestEvT = ev[1];
          bestEv = ev[0];
        }
      }
      var topMethods = [];
      var sortedTop = [];
      for (var e of d.top.entries()) sortedTop.push(e);
      sortedTop.sort(function (a, b) { return b[1] - a[1]; });
      for (var q = 0; q < sortedTop.length && q < 3; q++) topMethods.push(sortedTop[q]);
      var topMethodsInc = [];
      var sortedTopInc = [];
      for (var e2 of d.topInc.entries()) sortedTopInc.push(e2);
      sortedTopInc.sort(function (a, b) { return b[1] - a[1]; });
      for (var q2 = 0; q2 < sortedTopInc.length && q2 < 3; q2++) {
        var keyInc = sortedTopInc[q2][0];
        topMethodsInc.push([keyInc, sortedTopInc[q2][1], d.top.get(keyInc) || 0]);
      }
      causes.push({
        category: c,
        label: CAUSE_LABEL[c] || c,
        selfMs: d.self,
        selfPct: selfPct,
        incRatio: incRatio,
        costMs: cost,
        confidence: confidence(selfPct, overrun),
        evidence: bestEv,
        evidenceSelf: bestEvT,
        topMethods: topMethods,
        topMethodsInc: topMethodsInc,
        threadCount: d.threads.size,
      });
    }
    causes.sort(function (a, b) { return b.selfMs - a.selfMs; });
    return causes;
  }

  function findChainIndex(threads, categorize, exemptSet) {
    var index = new Map();
    for (var ti = 0; ti < threads.length; ti++) {
      var t = threads[ti];
      for (var ni = 0; ni < t.nodes.length; ni++) {
        var node = t.nodes[ni];
        var cls = node[0];
        var mth = node[1];
        var line = node[2];
        var stv = node[3];
        if (isNoise(cls, mth) && !exemptSet.has(cls + "\u0000" + mth)) continue;
        var catRes = categorize(cls, mth);
        var best = index.get(catRes[0]);
        if (!best) {
          best = new Map();
          index.set(catRes[0], best);
        }
        var k = keyOf(cls, mth, line);
        var cur = best.get(k);
        if (cur === undefined || stv > cur[2]) best.set(k, [ti, ni, stv]);
      }
    }
    return index;
  }

  function chainsFromIndex(best, threads, limit, exemptSet) {
    var chains = [];
    if (!best) return chains;
    for (var bp of best.entries()) {
      var key = bp[0];
      var ti2 = bp[1][0];
      var ni2 = bp[1][1];
      var stv2 = bp[1][2];
      var chain = [];
      var idx = ni2;
      var t2 = threads[ti2];
      while (idx >= 0 && chain.length < 16) {
        var n2 = t2.nodes[idx];
        chain.push([n2[0], n2[1], n2[2]]);
        idx = n2[5];
      }
      chain.reverse();
      var visible = chain.filter(function (x) { return !isNoiseInc(x[0], x[1]) || exemptSet.has(x[0] + "\u0000" + x[1]); });
      if (!visible.length) visible = chain.slice(-1);
      chains.push([stv2, key, visible]);
    }
    chains.sort(function (a, b) { return b[0] - a[0]; });
    return chains.slice(0, limit);
  }

  function findChains(threads, categorize, cat, limit) {
    return chainsFromIndex(findChainIndex(threads, categorize).get(cat), threads, limit);
  }

  function regionRanking(threads, durMs, factor) {
    var out = [];
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i];
      if (t.role !== "REGION_TICK") continue;
      var active = Math.max(0, t.grand - t.idle);
      var busy = threadBusyPct(t.name, active, durMs);
      var perTick = factor ? active * factor : null;
      out.push({ name: t.name, busy: busy, perTick: perTick });
    }
    out.sort(function (a, b) { return (b.busy || 0) - (a.busy || 0); });
    return out;
  }

  function loadNotes(threads, durMs, tickOnly) {
    var notes = [];
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i];
      if (t.grand <= 0) continue;
      if (tickOnly && !TICK_ROLES.has(t.role)) continue;
      if (!tickOnly && TICK_ROLES.has(t.role)) continue;
      if (t.role === "SPARK") continue;
      var active = Math.max(0, t.grand - t.idle);
      var busy = threadBusyPct(t.name, active, durMs);
      if (busy !== null && busy >= (tickOnly ? 90 : 60)) {
        if (tickOnly) {
          notes.push("tick 執行緒「" + t.name + "」活躍度 " + busy.toFixed(0) + "% — 接近飽和（單執行緒 CPU 上限）");
        } else {
          notes.push("執行緒「" + t.name + "」活躍度 " + busy.toFixed(0) + "% — 高 CPU 但非 tick 執行緒，未必直接影響 TPS");
        }
      }
    }
    return notes;
  }

  // ----------------------------------------------------------------------
  // GC 統計
  // ----------------------------------------------------------------------

  function parseGc(sstats) {
    var out = [];
    var all = allOf(sstats, 3);
    for (var i = 0; i < all.length; i++) {
      var entry = safeParse(all[i]);
      if (!entry) continue;
      var name = st(get(entry, 1));
      var gc = safeParse(get(entry, 2));
      if (!name) continue;
      var total = vi(get(gc, 1), 0);
      var avgT = asDouble(get(gc, 2));
      var avgF = asDouble(get(gc, 3));
      var perMin = avgF ? 60000 / avgF : null;
      out.push({ name: name, total: total, avgT: avgT, avgF: avgF, perMin: perMin });
    }
    return out;
  }

  // ----------------------------------------------------------------------
  // 報告組裝
  // ----------------------------------------------------------------------

  function buildReport(data, label) {
    var meta, platform, pstats, sstats, start, end, mode, durMs, sources, threads, wins,
      pmem, heap, tps, mspt, world, worldTotal, dist;

    return gunzipIfNeeded(data).then(function (bytes) {
      var root = parseMsg(bytes);
      if (!root || !(get(root, 1) instanceof Uint8Array)) {
        throw new Error("錯誤：資料不是有效的 spark SamplerData（可能是 heap/health 報告）");
      }

      meta = safeParse(get(root, 1));
      platform = safeParse(get(meta, 7));
      pstats = safeParse(get(meta, 8));
      sstats = safeParse(get(meta, 9));

      start = vi(get(meta, 2));
      end = vi(get(meta, 11));
      mode = vi(get(meta, 15), 0);
      durMs = start && end && end > start ? end - start : null;

      // ---- 插件歸因（spark classSources: className → 插件名） ----
      sources = new Map();
      var srcAll = allOf(root, 3);
      for (var i = 0; i < srcAll.length; i++) {
        var entry = safeParse(srcAll[i]);
        if (!entry) continue;
        var c = st(get(entry, 1));
        var p = st(get(entry, 2));
        if (c && p) sources.set(c, p);
      }
      var cats = makeCategorizer(sources);
      var pluginOf = cats.pluginOf;
      var categorize = cats.categorize;

      // ---- 中間資料結構 ----
      // 全域 java.* 高佔比豁免集合：collectThreads 分流時填入（該執行緒某
      // java 方法自身 ≥10%），診斷/呼叫鏈/含子榜共用，保證各處結論一致。
      var exemptSet = new Set();
      threads = collectThreads(root, exemptSet);
      wins = parseWindows(root);

      pmem = safeParse(get(pstats, 1));
      heap = safeParse(get(pmem, 1));
      tps = safeParse(get(pstats, 4));
      mspt = safeParse(get(pstats, 5));
      world = safeParse(get(pstats, 8));
      worldTotal = 0;
      dist = [];
      if (world) {
        var ecounts = world.get(2);
        if (ecounts) {
          for (var w2 = 0; w2 < ecounts.length; w2++) {
            var ent = safeParse(ecounts[w2].value);
            if (!ent) continue;
            var etype = st(get(ent, 1));
            var num = vi(get(ent, 2));
            worldTotal += num;
            if (etype) dist.push([num, etype]);
          }
        }
        if (!worldTotal && vi(get(world, 1))) {
          worldTotal = vi(get(world, 1));
        }
      }

      // ---- 環境 ----
      var env = buildEnv(label, meta, platform, sstats, pmem, heap);

      // ---- TPS / MSPT / 世界 ----
      var tpsInfo = buildTpsMspt(tps, wins, mspt);
      var worldInfo = { total: worldTotal, dist: dist };

      if (mode === 1) {
        var rptAlloc = {
          label: label,
          allocation: true,
          env: env,
          tpsMspt: tpsInfo,
          world: worldInfo,
          threads: threadDetail(threads, durMs, pluginOf, exemptSet),
          serverAgg: serverAgg(threads, pluginOf, exemptSet),
          hari: hari(threads),
          diag: null,
        };
        rptAlloc._pluginOf = pluginOf;
        return rptAlloc;
      }

      // ---- 診斷層 ----
      var tps1m = tps ? asDouble(get(tps, 1)) : null;
      var target = tps ? vi(get(tps, 4), 20) : 20;
      var budget = 1000 / target;
      var mspt1 = mspt ? safeParse(get(mspt, 1)) : null;
      var msptP95 = mspt1 ? asDouble(get(mspt1, 5)) : null;
      var overrun = msptP95 !== null ? msptP95 - budget : null;
      var tpsAvg = weightedTps(wins) || tps1m;
      var factor = tickFactor(durMs, tpsAvg, target);

      var tickThreads = threads.filter(function (t) { return TICK_ROLES.has(t.role); });
      var tickGrand = 0;
      var tickIdleSum = 0;
      for (i = 0; i < tickThreads.length; i++) {
        tickGrand += tickThreads[i].grand;
        tickIdleSum += tickThreads[i].idle;
      }
      var tickActive = Math.max(0, tickGrand - tickIdleSum);
      var catTick = aggregateByCategory(tickThreads, categorize);
      var causes = rankCauses(catTick, tickActive, factor, overrun);
      var chains = new Map();
      var chainIndex = findChainIndex(tickThreads, categorize, exemptSet);
      for (var ci = 0; ci < causes.length; ci++) {
        var cc = causes[ci];
        if (cc.selfPct >= 3) {
          chains.set(cc.category, chainsFromIndex(chainIndex.get(cc.category), tickThreads, 3, exemptSet));
        }
      }
      var plugins = aggregateByPlugin(tickThreads, categorize);
      var entityBr = null;
      if ((catTick.get("ENTITY") || { self: 0 }).self > 0) {
        entityBr = entityBreakdown(tickThreads, categorize);
      }
      var regions = regionRanking(threads, durMs, factor);
      var notes = loadNotes(threads, durMs, true).concat(loadNotes(threads, durMs, false));
      var singleTick = tickThreads.length === 1;
      var pool = 1;
      if (singleTick) {
        var pm = /\(x(\d+)\)/.exec(tickThreads[0].name);
        pool = pm ? parseInt(pm[1], 10) : 1;
      }
      if (singleTick && tpsAvg && tpsAvg < target && msptP95 !== null) {
        var tickCycleMs = 1000 / tpsAvg;
        if (tickCycleMs > msptP95 * 1.25 + 10) {
          notes.push(
            "MSPT 統計與 TPS 不一致: tick 週期約 " + tickCycleMs.toFixed(0) + "ms（1000/TPS），" +
            "遠大於 MSPT p95 " + fmtF(msptP95, 1) + "ms — 執行緒在 tick 之間仍忙碌" +
            "（分區核心的 spin/排程消耗，或 MSPT 統計未涵蓋完整 tick 路徑）；" +
            "請以 TPS 與執行緒採樣為準"
          );
        }
      }

      var exclusions = [];
      var lowCats = [];
      var catNames = ["IO", "NETWORK", "GC", "HARI", "SPARK", "UNKNOWN"];
      for (i = 0; i < catNames.length; i++) {
        var cname = catNames[i];
        var d = catTick.get(cname);
        var pct = tickActive ? ((d ? d.self : 0) * 100) / tickActive : 0;
        if (pct < 5) lowCats.push(EXCLUDE_LABEL[cname] || cname);
      }
      exclusions.push("無顯著熱點: " + (lowCats.length ? lowCats.join("、") : "（全部類別皆未達顯著門檻）"));
      var pluginPct = tickActive ? (((catTick.get("PLUGIN") || { self: 0 }).self * 100) / tickActive) : 0;
      if (pluginPct < 10) {
        exclusions.push("插件總計 " + fmtF(pluginPct, 1) + "% tick CPU（非 idle 基數）— 無證據顯示插件為主要卡頓來源");
      }
      var gcData = parseGc(sstats);
      var gcActive = gcData.filter(function (g) { return g.total > 0; });
      if (gcActive.length) {
        var gcParts = [];
        var gcProblems = [];
        for (i = 0; i < gcActive.length; i++) {
          var g = gcActive[i];
          var intervalS = g.avgF ? "每 " + fmtF(g.avgF / 1000, 1) + "s 一次" : "間隔?";
          var freqS = g.perMin !== null ? fmtF(g.perMin, 1) + " 次/分" : "?";
          gcParts.push(g.name + " " + g.total + " 次 / 平均暫停 " + fmtF(g.avgT || 0, 1) + "ms / " + freqS + "（" + intervalS + "）");
          if ((g.avgT || 0) >= 100 || (g.perMin || 0) >= 30) {
            gcProblems.push(g.name + " 平均暫停 " + fmtF(g.avgT || 0, 1) + "ms / 頻率 " + freqS);
          }
        }
        if (gcProblems.length) {
          notes.push("GC 壓力偏高: " + gcProblems.join("；"));
        } else {
          exclusions.push("GC: 壓力輕微（" + gcParts.join("；") + "）— 無證據顯示 GC 為主要卡頓來源");
        }
      } else {
        exclusions.push("GC 壓力: 無法從本報告確認（無 GC 統計資料）");
      }

      var env2 = {
        severity: severity(overrun, tps1m),
        durationS: durMs ? durMs / 1000 : null,
      };
      var tpsInfo2 = {
        "1m": tps ? asDouble(get(tps, 1)) : null,
        "5m": tps ? asDouble(get(tps, 2)) : null,
        "15m": tps ? asDouble(get(tps, 3)) : null,
        target: target,
      };

      var diag = {
        severity: env2.severity,
        durationS: env2.durationS,
        tpsInfo: tpsInfo2,
        budget: budget,
        msptP95: msptP95,
        overrun: overrun,
        tickGrand: tickGrand,
        tickActive: tickActive,
        pool: pool,
        factor: factor,
        singleTick: singleTick,
        causes: causes,
        chains: chains,
        plugins: plugins,
        entityBr: entityBr,
        regions: regions,
        notes: notes,
        exclusions: exclusions,
        catTick: catTick,
        wins: wins,
        dist: dist,
      };

      var rpt = {
        label: label,
        allocation: false,
        env: env,
        tpsMspt: tpsInfo,
        world: worldInfo,
        threads: threadDetail(threads, durMs, pluginOf, exemptSet),
        serverAgg: serverAgg(threads, pluginOf, exemptSet),
        hari: hari(threads),
        diag: diag,
      };
      rpt._pluginOf = pluginOf;
      return rpt;
    });
  }

  // ----------------------------------------------------------------------
  // 環境資訊
  // ----------------------------------------------------------------------

  function buildEnv(label, meta, platform, sstats, pmem, heap) {
    var user = safeParse(get(meta, 1));
    var uname = st(get(user, 2)) || "?";
    var utype = { 0: "OTHER", 1: "PLAYER" }[vi(get(user, 1), 0)] || "?";
    var start = vi(get(meta, 2));
    var end = vi(get(meta, 11));
    var interval = vi(get(meta, 3));
    var ptype = { 0: "SERVER", 1: "CLIENT", 2: "PROXY", 3: "APPLICATION" }[vi(get(platform, 1), 0)] || "?";
    var syscpu = safeParse(get(sstats, 1));
    var sysos = safeParse(get(sstats, 5));
    var sysjava = safeParse(get(sstats, 6));
    var heapUsed = null;
    var heapMax = null;
    var heapPct = null;
    if (heap) {
      heapUsed = vi(get(heap, 1));
      heapMax = vi(get(heap, 4));
      if (heapMax) heapPct = pydFloorDiv(heapUsed, heapMax);
    }
    var gcs = parseGc(sstats).filter(function (g) { return g.total > 0; });
    return {
      id: label,
      samplerName: uname,
      samplerType: utype,
      startMs: start,
      endMs: end,
      durationSec: start && end ? Math.trunc((end - start) / 1000) : null,
      intervalMs: interval,
      platformType: ptype,
      platformName: st(get(platform, 2)) || "?",
      platformVersion: st(get(platform, 3)) || "",
      mcVersion: st(get(platform, 4)) || "?",
      core: st(get(platform, 8)) || "?",
      cpuName: st(get(syscpu, 4)) || "?",
      cpuThreads: vi(get(syscpu, 1)),
      osName: sysos ? st(get(sysos, 2)) || "?" : null,
      osVersion: sysos ? st(get(sysos, 3)) || "" : null,
      osArch: sysos ? st(get(sysos, 1)) || "?" : null,
      jvmName: sysjava ? st(get(sysjava, 2)) || "?" : null,
      jvmVersion: sysjava ? st(get(sysjava, 1)) || "?" : null,
      heapUsed: heapUsed,
      heapMax: heapMax,
      heapPct: heapPct,
      gcs: gcs,
    };
  }

  // ----------------------------------------------------------------------
  // TPS / MSPT / 時間窗
  // ----------------------------------------------------------------------

  function buildTpsMspt(tps, wins, mspt) {
    var out = { tps: null, wins: wins, mspt1m: null, mspt5m: null };
    if (tps) {
      out.tps = {
        "1m": asDouble(get(tps, 1)),
        "5m": asDouble(get(tps, 2)),
        "15m": asDouble(get(tps, 3)),
        target: vi(get(tps, 4), 20),
      };
    }
    function rolling(field) {
      var rv = safeParse(get(mspt, field));
      if (!rv) return null;
      return {
        avg: asDouble(get(rv, 1)),
        max: asDouble(get(rv, 2)),
        min: asDouble(get(rv, 3)),
        median: asDouble(get(rv, 4)),
        p95: asDouble(get(rv, 5)),
      };
    }
    if (mspt) {
      out.mspt1m = rolling(1);
      out.mspt5m = rolling(2);
    }
    return out;
  }

  // ----------------------------------------------------------------------
  // 詳細層資料
  // ----------------------------------------------------------------------

  function threadDetail(threads, durMs, pluginOf, exemptSet) {
    var out = [];
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i];
      var d = {
        name: t.name,
        role: t.role,
        noData: t.nodes.length === 0,
        noTime: t.nodes.length > 0 && t.grand <= 0,
      };
      if (d.noData || d.noTime) {
        out.push(d);
        continue;
      }
      var grand = t.grand;
      var workSum = 0;
      for (var v of t.work.values()) workSum += v;
      var idleRatio = ((grand - workSum) * 100) / grand;
      var busy = null;
      if (durMs) {
        var active = Math.max(0, grand - t.idle);
        busy = threadBusyPct(t.name, active, durMs);
      }
      d.idleRatio = idleRatio;
      d.busyPct = busy;
      d._grand = grand;
      var hasPool = /\(x\d+\)/.test(t.name);
      var top = mostCommon(t.work, 20);
      d.workTop = top.map(function (en) {
        var parts = splitKey(en[0]);
        return [parts[0], parts[1], parts[2], en[1], pluginOf(parts[0])];
      });
      var exclTop = mostCommon(t.excluded, 15);
      var exclTotal = 0;
      for (var v2 of t.excluded.values()) exclTotal += v2;
      var shown = 0;
      for (var v3 of exclTop) shown += v3[1];
      d.exclTop = exclTop.map(function (en) {
        var parts = splitKey(en[0]);
        return [parts[0], parts[1], parts[2], en[1]];
      });
      d.exclTotalPct = (exclTotal * 100) / grand;
      d.exclTailPct = ((exclTotal - shown) * 100) / grand;
      var incTh = grand * 0.01;
      var incList = [];
      for (var e of t.work.entries()) {
        var k = e[0];
        var parts = splitKey(k);
        var ck = parts[0] + "\u0000" + parts[1];
        if ((!isNoiseInc(parts[0], parts[1]) || exemptSet.has(ck)) && (t.aggInc.get(k) || 0) >= incTh) {
          incList.push([k, t.aggInc.get(k), t.work.get(k)]);
        }
      }
      incList.sort(function (a, b) { return b[1] - a[1]; });
      d.incTop = incList.slice(0, 15).map(function (en) {
        var parts = splitKey(en[0]);
        return [parts[0], parts[1], parts[2], en[1], en[2], pluginOf(parts[0])];
      });
      d.hasPool = hasPool;
      out.push(d);
    }
    return out;
  }

  function serverAgg(threads, pluginOf, exemptSet) {
    if (threads.length <= 1) return null;
    var aggAll = new Map();
    var aggIncAll = new Map();
    var grandAll = 0;
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i];
      for (var e of t.work.entries()) {
        aggAll.set(e[0], (aggAll.get(e[0]) || 0) + e[1]);
        aggIncAll.set(e[0], (aggIncAll.get(e[0]) || 0) + (t.aggInc.get(e[0]) || 0));
      }
      for (var e2 of t.excluded.entries()) {
        aggAll.set(e2[0], (aggAll.get(e2[0]) || 0) + e2[1]);
        aggIncAll.set(e2[0], (aggIncAll.get(e2[0]) || 0) + (t.aggInc.get(e2[0]) || 0));
      }
      grandAll += t.grand;
    }
    var workAll = new Map();
    var excludedAll = new Map();
    for (var e2 of aggAll.entries()) {
      var parts = splitKey(e2[0]);
      if (isNoise(parts[0], parts[1]) && !exemptSet.has(parts[0] + "\u0000" + parts[1])) {
        excludedAll.set(e2[0], e2[1]);
      } else {
        workAll.set(e2[0], e2[1]);
      }
    }
    var idleAll = grandAll - 0;
    var workSum = 0;
    for (var v of workAll.values()) workSum += v;
    idleAll = grandAll - workSum;
    var topAll = mostCommon(workAll, 25).map(function (en) {
      var parts = splitKey(en[0]);
      return [parts[0], parts[1], parts[2], en[1], pluginOf(parts[0])];
    });
    var exclAllTop = mostCommon(excludedAll, 15).map(function (en) {
      var parts = splitKey(en[0]);
      return [parts[0], parts[1], parts[2], en[1]];
    });
    var exclAllTotal = 0;
    for (var v4 of excludedAll.values()) exclAllTotal += v4;
    var shownAll = 0;
    for (var v5 of exclAllTop) shownAll += v5[3];
    var incAllTh = grandAll * 0.01;
    var incAllList = [];
    for (var e3 of workAll.entries()) {
      var k = e3[0];
      var parts = splitKey(k);
      if ((!isNoiseInc(parts[0], parts[1]) || exemptSet.has(parts[0] + "\u0000" + parts[1])) && (aggIncAll.get(k) || 0) >= incAllTh) {
        incAllList.push([k, aggIncAll.get(k), workAll.get(k)]);
      }
    }
    incAllList.sort(function (a, b) { return b[1] - a[1]; });
    return {
      grand: grandAll,
      idlePct: grandAll > 0 ? (idleAll * 100) / grandAll : 0,
      topAll: topAll,
      exclTop: exclAllTop,
      exclTotalPct: grandAll > 0 ? (exclAllTotal * 100) / grandAll : 0,
      exclTailPct: grandAll > 0 ? ((exclAllTotal - shownAll) * 100) / grandAll : 0,
      incTop: incAllList.slice(0, 15).map(function (en) {
        var parts = splitKey(en[0]);
        return [parts[0], parts[1], parts[2], en[1], en[2], pluginOf(parts[0])];
      }),
    };
  }

  function hari(threads) {
    var overall = 0;
    var hari = new Map();
    for (var i = 0; i < threads.length; i++) {
      var nodes = threads[i].nodes;
      for (var j = 0; j < nodes.length; j++) {
        var node = nodes[j];
        var stv = node[3];
        overall += stv;
        var cls = node[0];
        var mth = node[1];
        if (!(cls.indexOf("io.hari.") === 0 || mth.indexOf("hari$") !== -1)) continue;
        var line = node[2];
        var key = line ? cls + "." + mth + ":" + line : cls + "." + mth;
        hari.set(key, (hari.get(key) || 0) + stv);
      }
    }
    var kept = new Map();
    for (var e of hari.entries()) {
      if (e[1] > 0) kept.set(e[0], e[1]);
    }
    if (!kept.size || overall <= 0) return null;
    var hsum = 0;
    for (var hv of kept.values()) hsum += hv;
    var items = [];
    var sorted = [];
    for (var he of kept.entries()) sorted.push(he);
    sorted.sort(function (a, b) { return b[1] - a[1]; });
    for (var q = 0; q < sorted.length && q < 12; q++) {
      items.push([sorted[q][0], sorted[q][1]]);
    }
    return {
      count: kept.size,
      total: hsum,
      overall: overall,
      items: items,
    };
  }

  // ----------------------------------------------------------------------
  // 純文字渲染（與 Python 輸出逐字元一致）
  // ----------------------------------------------------------------------

  function renderText(report) {
    var L = [];
    function add(s) { L.push(s); }

    if (report.allocation) {
      add("注意: ALLOCATION 模式（times 為配置位元組數，時間語意不適用，診斷略過）");
      renderEnvironment(L, report);
      renderTpsMspt(L, report);
      renderWorld(L, report);
      renderThreadDetail(L, report);
      renderServerAgg(L, report);
      renderHari(L, report);
      add("=".repeat(60));
      return L.join("\n") + "\n";
    }

    var d = report.diag;
    var tpsInfo = d.tpsInfo;
    var budget = d.budget;
    var msptP95 = d.msptP95;
    var overrun = d.overrun;
    var factor = d.factor;
    var tickGrand = d.tickGrand;
    var tickActive = d.tickActive;
    var pool = d.pool;
    var singleTick = d.singleTick;

    add("=".repeat(60));
    add("LAG DIAGNOSIS");
    add("=".repeat(60));
    add("狀態     : " + d.severity);
    function fmt2(v) {
      return v === null || v === undefined ? "?" : fmtF(v, 2);
    }
    add("TPS      : 1m=" + fmt2(tpsInfo["1m"]) + "  5m=" + fmt2(tpsInfo["5m"]) +
      "  15m=" + fmt2(tpsInfo["15m"]) + "  (目標 " + tpsInfo.target + ")");
    if (msptP95 !== null) {
      if (overrun !== null) {
        var sign = overrun >= 0 ? "+" : "";
        add("Tick     : budget " + fmtF(budget, 1) + "ms / MSPT p95 " + fmtF(msptP95, 1) +
          "ms / 超支 " + sign + fmtF(overrun, 1) + "ms");
      } else {
        add("Tick     : budget " + fmtF(budget, 1) + "ms / MSPT p95 " + fmtF(msptP95, 1) + "ms / 超支未知");
      }
    } else {
      add("Tick     : budget " + fmtF(budget, 1) + "ms / MSPT p95 無資料");
    }
    if (d.durationS) {
      var ticks = factor ? Math.trunc(1 / factor) : 0;
      var extra = ticks ? "，估算約 " + ticks + " ticks" : "";
      var idlePct = 0;
      if (tickGrand > 0) {
        idlePct = (Math.max(0, tickGrand - tickActive) * 100) / tickGrand;
      }
      add("採樣     : " + fmtF(d.durationS, 0) + " 秒（tick 執行緒總採樣 " + fmtF(tickGrand, 0) +
        "ms〔active " + fmtF(tickActive, 0) + "ms / idle " + fmtF(idlePct, 0) + "%〕" + extra + "）");
    }
    if (singleTick && factor && tickActive > 0) {
      var poolBudget = pool * budget;
      var perTick = tickActive * factor;
      var diff = perTick - poolBudget;
      var sign2 = diff > 0 ? "+" : "";
      var mark = diff > 0 ? "（執行緒週期層面超支）" : "（未超支）";
      var poolTxt = pool > 1 ? "（" + pool + " 執行緒 × " + fmtF(budget, 1) + "ms）" : "";
      add("執行緒層面: 每 tick 週期約 " + fmtF(perTick, 1) + "ms 忙（active 採樣 ÷ 估算 tick 數；" +
        "對比總預算 " + fmtF(poolBudget, 1) + "ms" + poolTxt + " → " + sign2 + fmtF(diff, 1) + "ms " + mark + "）");
    }

    var mainCauses = d.causes.filter(function (c) { return c.selfPct >= 5; });
    add("");
    if (mainCauses.length) {
      add("主要原因（tick 執行緒）:");
      for (var i = 0; i < mainCauses.length; i++) {
        var c = mainCauses[i];
        var cost = c.costMs !== null ? "+" + fmtF(c.costMs, 1) + " ms/tick  " : "";
        add("  " + (i + 1) + ". " + c.label.padEnd(18) + " " + cost + fmtF(c.selfPct, 1) + "%  Confidence: " + c.confidence);
      }
    } else {
      add("主要原因: （tick 執行緒未偵測到 ≥5% 的單一類別負載）");
    }

    add("");
    add("排除原因:");
    for (i = 0; i < d.exclusions.length; i++) {
      add("  - " + d.exclusions[i]);
    }
    if (d.notes.length) {
      add("");
      add("注意:");
      for (i = 0; i < d.notes.length; i++) {
        add("  - " + d.notes[i]);
      }
    }
    add("");

    // ---- ROOT CAUSE ----
    var shown = 0;
    for (i = 0; i < d.causes.length; i++) {
      var cause = d.causes[i];
      if (cause.selfPct < 3) continue;
      shown += 1;
      add("=".repeat(60));
      add("ROOT CAUSE #" + shown + " — " + cause.label);
      add("=".repeat(60));
      var cost2 = cause.costMs !== null ? "約 +" + fmtF(cause.costMs, 1) + " ms/tick  " : "";
      add("影響     : " + cost2 + "自身 " + fmtF(cause.selfPct, 1) + "%（整段採樣平均，非單次峰值）");
      if (cause.incRatio >= 1.5) {
        add("結構     : 節點 含子/自身 比 " + fmtF(cause.incRatio, 1) + "（≫1 → 自身運算少、開銷來自被大量呼叫）");
      } else {
        add("結構     : 節點 含子/自身 比 " + fmtF(cause.incRatio, 1) + "（自身運算為主）");
      }
      add("信心     : " + cause.confidence);
      add("證據     : " + cause.evidence + "（類別內自身合計 " + fmtF(cause.evidenceSelf, 0) + "ms）");
      add("出現     : 跨 " + cause.threadCount + " 個執行緒");
      add("主要節點 :");
      for (var q2 = 0; q2 < cause.topMethods.length; q2++) {
        var tm = cause.topMethods[q2];
        var parts = splitKey(tm[0]);
        var pctNode = tickActive ? (tm[1] * 100) / tickActive : 0;
        var loc = parts[2] ? ":" + parts[2] : "";
        var pl = pluginOfCategory(report, parts[0]);
        var tag = pl ? " [" + pl + "]" : "";
        add("  " + pctStr(pctNode).padStart(7) + "%  " + parts[0] + "." + parts[1] + loc + tag);
      }
      if (cause.category === "ENTITY" && d.entityBr) {
        var sections = d.entityBr[0];
        var specific = d.entityBr[1];
        var aiOwners = d.entityBr[2];
        if (sections.size) {
          var total = 0;
          for (var sv of sections.values()) total += sv;
          add("實體開銷分項（採樣不含實體實例 → 無法精確到單一實體；以下為系統層級）:");
          var secSorted = mostCommon(sections);
          for (var si = 0; si < secSorted.length; si++) {
            var sec = secSorted[si];
            var secPct = total ? (sec[1] * 100) / total : 0;
            add("  " + sec[0].padEnd(16) + " " + fmtF(sec[1], 0).padStart(8) + "ms  " + fmtF(secPct, 1).padStart(5) + "%");
          }
          if (specific.size) {
            var specTop = mostCommon(specific, 5);
            var restN = specific.size - specTop.length;
            var items = specTop.map(function (en) { return en[0] + " " + fmtF(en[1], 0) + "ms"; }).join("、");
            if (restN > 0) items += "（…另 " + restN + " 個）";
            add("  實體自身開銷: " + items);
          }
          if (aiOwners.size) {
            var aiTop = mostCommon(aiOwners, 5);
            var restN2 = aiOwners.size - aiTop.length;
            var items2 = aiTop.map(function (en) { return en[0] + " " + fmtF(en[1], 0) + "ms"; }).join("、");
            if (restN2 > 0) items2 += "（…另 " + restN2 + " 個入口）";
            add("  AI 開銷的實體入口（AI 自身沿呼叫鏈往上歸因）: " + items2);
          }
        }
      }
      var ch = d.chains.get(cause.category);
      if (ch) {
        add("Call Chain（自身最高的節點往上追，最內層路徑）:");
        for (var ci2 = 0; ci2 < ch.length; ci2++) {
          var chain = ch[ci2][2];
          var shownChain = chain.slice(-5);
          for (var j2 = 0; j2 < shownChain.length; j2++) {
            var cn = shownChain[j2];
            var cloc = cn[2] ? ":" + cn[2] : "";
            var cpl = pluginOfCategory(report, cn[0]);
            var ctag = cpl ? " [" + cpl + "]" : "";
            var prefix = j2 ? "  └─ " : "  ";
            var mark = j2 === shownChain.length - 1 ? "   ← 自身最高" : "";
            add(prefix + cn[0] + "." + cn[1] + cloc + ctag + mark);
          }
        }
      }
      add("");
    }

    // ---- PLUGIN ANALYSIS ----
    add("=".repeat(60));
    add("PLUGIN ANALYSIS（tick 執行緒）");
    add("=".repeat(60));
    var plugins = d.plugins;
    if (!plugins.size) {
      add("  （無插件熱點）");
      add("結論: 沒有證據顯示插件是本次卡頓來源。");
      add("");
    } else {
      var ranked = [];
      for (var pe of plugins.entries()) ranked.push(pe);
      ranked.sort(function (a, b) { return b[1].self - a[1].self; });
      var totalPlugin = 0;
      for (var pr = 0; pr < ranked.length; pr++) totalPlugin += ranked[pr][1].self;
      var totalPct = tickActive > 0 ? (totalPlugin * 100) / tickActive : 0;
      var shownPlugins = ranked.slice(0, 10);
      var restPlugins = ranked.slice(10);
      for (var pi2 = 0; pi2 < shownPlugins.length; pi2++) {
        var pn = shownPlugins[pi2];
        var d2 = pn[1];
        var ppct = tickActive > 0 ? (d2.self * 100) / tickActive : 0;
        var pcost = factor ? "+" + fmtF(d2.self * factor, 1) + " ms/tick  " : "";
        var topK = null;
        var topT = 0;
        for (var me of d2.methods.entries()) {
          if (!topK || me[1] > topT) {
            topK = me[0];
            topT = me[1];
          }
        }
        var topS = "";
        if (topK) {
          var tkParts = splitKey(topK);
          var tloc = tkParts[2] ? ":" + tkParts[2] : "";
          topS = "   top: " + tkParts[0] + "." + tkParts[1] + tloc + " (" + fmtF((topT * 100) / tickActive, 1) + "%)";
        }
        add("  " + (pi2 + 1) + ". " + pn[0].padEnd(24) + " " + pcost + fmtF(ppct, 1) + "%" + topS);
      }
      if (restPlugins.length) {
        var restSum = 0;
        for (pr = 0; pr < restPlugins.length; pr++) restSum += restPlugins[pr][1].self;
        var restPct = tickActive > 0 ? (restSum * 100) / tickActive : 0;
        add("  …另有 " + restPlugins.length + " 個插件微量（合計 " + fmtF(restPct, 1) + "%）");
      }
      add("插件合計 : " + fmtF(totalPct, 1) + "% tick CPU");
      if (totalPct >= 30) {
        add("結論: 插件是主要負載來源，優先檢查下列插件。");
      } else if (totalPct >= 15) {
        add("結論: 插件負載顯著，值得優先檢查。");
      } else {
        add("結論: 無證據顯示插件為主要卡頓來源。");
      }
      add("");
    }

    // ---- REGION RANKING ----
    add("=".repeat(60));
    add("REGION RANKING（threaded regions / region scheduler）");
    add("=".repeat(60));
    if (!d.regions.length) {
      add("  （無 REGION_TICK 執行緒）");
      add("");
    } else {
      for (var ri = 0; ri < d.regions.length; ri++) {
        var rg = d.regions[ri];
        var rbusy = rg.busy !== null ? "活躍 " + fmtF(rg.busy, 0) + "%" : "活躍 ?";
        var rper = rg.perTick !== null ? "   ~" + fmtF(rg.perTick, 1) + " ms/tick" : "";
        add("  " + (ri + 1) + ". " + rg.name.padEnd(40) + " " + rbusy + rper);
      }
      add("");
    }

    // ---- ENTITY / CHUNK CORRELATION ----
    add("=".repeat(60));
    add("ENTITY / CHUNK CORRELATION");
    add("=".repeat(60));
    var wins2 = d.wins;
    var avgEnt = windowAvg(wins2, "entities");
    var avgChunk = windowAvg(wins2, "chunks");
    var avgTps = weightedTps(wins2);
    if (avgEnt !== null || avgChunk !== null || avgTps !== null) {
      var parts2 = [];
      if (avgEnt !== null) parts2.push("實體 " + fmtF(avgEnt, 0));
      if (avgChunk !== null) parts2.push("chunks " + fmtF(avgChunk, 0));
      if (avgTps !== null) parts2.push("tps " + fmtF(avgTps, 1));
      add("窗口平均 : " + parts2.join("  "));
    }
    if (d.dist.length) {
      var distSorted = d.dist.slice().sort(function (a, b) { return b[0] - a[0] || cmpStr(b[1], a[1]); });
      var top3 = distSorted.slice(0, 3);
      add("實體分佈 : " + top3.map(function (en) { return en[1] + " " + en[0]; }).join(", "));
    }
    var entD = d.catTick.get("ENTITY");
    var chunkD = d.catTick.get("CHUNK");
    var entityPct = tickActive ? ((entD ? entD.self : 0) * 100) / tickActive : 0;
    var chunkPct = tickActive ? ((chunkD ? chunkD.self : 0) * 100) / tickActive : 0;
    add("判讀:");
    var reads = [];
    if (avgEnt !== null && entityPct >= 10) {
      reads.push("實體數量高（約 " + fmtF(avgEnt, 0) + "）且 Entity tick CPU " + fmtF(entityPct, 1) + "% → 疑似實體過多造成 tick 壓力");
    } else if (entityPct >= 10) {
      reads.push("Entity tick CPU " + fmtF(entityPct, 1) + "% → 實體 tick 是主要負載之一");
    }
    if (avgChunk !== null && chunkPct >= 10) {
      reads.push("chunks 數量高（約 " + fmtF(avgChunk, 0) + "）且 Chunk 相關 CPU " + fmtF(chunkPct, 1) + "% → 疑似區塊載入/生成壓力");
    } else if (chunkPct >= 10) {
      reads.push("Chunk 相關 CPU " + fmtF(chunkPct, 1) + "% → 區塊處理是主要負載之一");
    }
    if (!reads.length) {
      reads.push("實體 / 區塊熱點均未達顯著門檻（≥10%），不是主要嫌疑");
    }
    for (var rd = 0; rd < reads.length; rd++) {
      add("  - " + reads[rd]);
    }
    add("");

    // ---- DETAILED PROFILER ----
    add("");
    add("=".repeat(60));
    add("DETAILED PROFILER");
    add("=".repeat(60));
    renderEnvironment(L, report);
    renderTpsMspt(L, report);
    renderWorld(L, report);
    renderThreadDetail(L, report);
    renderServerAgg(L, report);
    renderHari(L, report);

    add("=".repeat(60));
    return L.join("\n") + "\n";
  }

  /* renderText 需要 class → 插件 歸因；report 未直接保留 categorize，
   * 故在 renderText 階段以 pluginOf 名稱重新歸因（只影響 [插件] 標籤）。 */
  function pluginOfCategory(report, cls) {
    if (!report._pluginOf) return null;
    return report._pluginOf(cls);
  }

  function renderEnvironment(L, report) {
    var env = report.env;
    L.push("=".repeat(60));
    L.push("spark 取樣分析報告");
    L.push("=".repeat(60));
    L.push("報告 ID : " + env.id);
    L.push("採樣者  : " + env.samplerName + " (" + env.samplerType + ")");
    if (env.startMs && env.endMs) {
      L.push("採樣期間: " + fmtTs(env.startMs) + " → " + fmtTs(env.endMs) + " (" + env.durationSec + " 秒)");
    }
    if (env.intervalMs) {
      L.push("取樣區間: " + fmtF(env.intervalMs / 1000, 0) + " ms");
    }
    L.push("伺服器  : " + env.platformName + " " + env.platformVersion + " (" + env.platformType + ")");
    L.push("MC 版本 : " + env.mcVersion);
    L.push("核心    : " + env.core);
    L.push("CPU     : " + env.cpuName + " (" + env.cpuThreads + " threads)");
    if (env.osName) {
      L.push("作業系統: " + env.osName + " " + env.osVersion + " (" + env.osArch + ")");
    }
    if (env.jvmName) {
      L.push("JVM     : JDK " + env.jvmName + " (" + env.jvmVersion + ")");
    }
    if (env.heapMax) {
      L.push("Heap    : " + fmtF(env.heapUsed / 1073741824, 2) + " GB / " +
        fmtF(env.heapMax / 1073741824, 2) + " GB (" + env.heapPct + "%)");
    }
    if (env.gcs.length) {
      var parts = [];
      for (var i = 0; i < env.gcs.length; i++) {
        var g = env.gcs[i];
        var intervalS = g.avgF ? "每 " + fmtF(g.avgF / 1000, 1) + "s 一次" : "間隔?";
        parts.push(g.name + " " + g.total + " 次 / 平均 " + fmtF(g.avgT || 0, 1) + "ms / " + intervalS);
      }
      L.push("GC      : " + parts.join("；"));
    }
  }

  function renderTpsMspt(L, report) {
    var tp = report.tpsMspt;
    if (tp.tps) {
      L.push("TPS     : 1m=" + fnum(tp.tps["1m"]) + "  5m=" + fnum(tp.tps["5m"]) +
        "  15m=" + fnum(tp.tps["15m"]) + "  (目標 " + tp.tps.target + ")");
      var winParts = [];
      for (var i = 0; i < tp.wins.length; i++) {
        var w = tp.wins[i];
        var dur = w.dur_s ? pyStr(w.dur_s) : "?";
        var part = "窗" + dur + "s: tps=" + fnum(w.tps);
        if (w.entities) part += " 實體=" + w.entities;
        if (w.chunks) part += " chunks=" + w.chunks;
        winParts.push(part);
      }
      if (winParts.length) L.push("時間窗  : " + winParts.join(" | "));
    }
    if (tp.mspt1m) L.push(msptLine("1m", tp.mspt1m));
    if (tp.mspt5m) L.push(msptLine("5m", tp.mspt5m));
  }

  function msptLine(tag, rv) {
    var vals = [
      "平均=" + fmtMspt(rv.avg) + "ms",
      "最大=" + fmtMspt(rv.max) + "ms",
      "最小=" + fmtMspt(rv.min) + "ms",
      "中位=" + fmtMspt(rv.median) + "ms",
      "p95=" + fmtMspt(rv.p95) + "ms",
    ];
    return "MSPT " + tag + " : " + vals.join("  ");
  }

  function renderWorld(L, report) {
    if (report.world.total) {
      L.push("世界實體: " + report.world.total);
    }
    if (report.world.dist.length) {
      var sorted = report.world.dist.slice().sort(function (a, b) {
        return b[0] - a[0] || cmpStr(b[1], a[1]);
      });
      L.push("實體分佈: " + sorted.map(function (en) { return en[1] + " " + en[0]; }).join(", "));
    }
  }

  /* Python 字串比較（code point）的 JS 對應（BMP 內 UTF-16 code unit 相等）。 */
  function cmpStr(a, b) {
    if (a === b) return 0;
    return a > b ? 1 : -1;
  }

  function renderThreadDetail(L, report) {
    var threads = report.threads;
    L.push("");
    L.push("=".repeat(60));
    L.push("※ 以下熱點以自身時間統計；已排除等待/idle、執行緒入口框架與 java.* 基礎框架");
    L.push("  百分比 = 佔總採樣，可與「已排除」表直接相加");
    L.push("  熱點後綴 :N = 該方法內的原始碼行號（來自 bytecode LineNumberTable）");
    L.push("");
    for (var i = 0; i < threads.length; i++) {
      var t = threads[i];
      if (t.noData) {
        L.push("執行緒 : " + t.name);
        L.push("  (無堆疊資料)");
        continue;
      }
      if (t.noTime) {
        L.push("執行緒 : " + t.name);
        L.push("  (無時間資料)");
        continue;
      }
      var busy = "";
      if (t.busyPct !== null && t.busyPct !== undefined) {
        var note = t.hasPool ? " (其餘為 park 等待)" : "";
        busy = "   活躍度: " + fmtF(t.busyPct, 2) + "%" + note;
      }
      L.push("執行緒 : " + t.name + busy);
      L.push("  總採樣: " + fmtF(grandOf(t), 0) + " (等待/idle " + fmtF(t.idleRatio, 0) + "% 已排除)");
      for (var q = 0; q < t.workTop.length; q++) {
        var w = t.workTop[q];
        L.push("  " + pctStr((w[3] * 100) / grandOf(t)).padStart(7) + "%  " + w[0] + "." + w[1] + (w[2] ? ":" + w[2] : "") + (w[4] ? " [" + w[4] + "]" : ""));
      }
      L.push("  已排除（等待/idle、入口框架、基礎框架；顯示前 15，排除共 " +
        fmtF(t.exclTotalPct, 0) + "%，長尾 " + fmtF(t.exclTailPct, 1) + "% 未列）:");
      for (q = 0; q < t.exclTop.length; q++) {
        var ex = t.exclTop[q];
        L.push("  " + pctStr((ex[3] * 100) / grandOf(t)).padStart(7) + "%  " + ex[0] + "." + ex[1] + (ex[2] ? ":" + ex[2] : ""));
      }
      if (t.incTop.length) {
        L.push("  含子時間榜（含全部子呼叫，與 spark 網站一致；含子 ≥1% 才列出，");
        L.push("  百分比不可互相相加）:");
        for (q = 0; q < t.incTop.length; q++) {
          var inc = t.incTop[q];
          L.push("  " + pctStr((inc[3] * 100) / grandOf(t)).padStart(7) + "% (" +
            pctStr((inc[4] * 100) / grandOf(t)).padStart(7) + "%)  " + inc[0] + "." + inc[1] +
            (inc[2] ? ":" + inc[2] : "") + (inc[5] ? " [" + inc[5] + "]" : ""));
        }
      }
      L.push("");
    }
  }

  function grandOf(t) {
    return t._grand;
  }

  function renderServerAgg(L, report) {
    var agg = report.serverAgg;
    if (!agg) return;
    L.push("=".repeat(60));
    L.push("全伺服器彙總（所有執行緒合併，自身時間）");
    L.push("※ 已排除等待/idle、執行緒入口框架與 java.* 基礎框架");
    L.push("  百分比 = 佔總採樣，可與「已排除」表直接相加");
    L.push("  熱點後綴 :N = 該方法內的原始碼行號（來自 bytecode LineNumberTable）");
    L.push("  行尾 [插件] = 該類別歸屬於的插件（spark classSources 歸因）");
    L.push("");
    L.push("  總採樣: " + fmtF(agg.grand, 0) + " (等待/idle " + fmtF(agg.idlePct, 0) + "% 已排除)");
    for (var i = 0; i < agg.topAll.length; i++) {
      var w = agg.topAll[i];
      L.push("  " + pctStr((w[3] * 100) / agg.grand).padStart(7) + "%  " + w[0] + "." + w[1] + (w[2] ? ":" + w[2] : "") + (w[4] ? " [" + w[4] + "]" : ""));
    }
    L.push("  已排除（等待/idle、入口框架、基礎框架；顯示前 15，排除共 " +
      fmtF(agg.exclTotalPct, 0) + "%，長尾 " + fmtF(agg.exclTailPct, 1) + "% 未列）:");
    for (i = 0; i < agg.exclTop.length; i++) {
      var ex = agg.exclTop[i];
      L.push("  " + pctStr((ex[3] * 100) / agg.grand).padStart(7) + "%  " + ex[0] + "." + ex[1] + (ex[2] ? ":" + ex[2] : ""));
    }
    if (agg.incTop.length) {
      L.push("  含子時間榜（含全部子呼叫，與 spark 網站一致；含子 ≥1% 才列出，");
      L.push("  百分比不可互相相加）:");
      for (i = 0; i < agg.incTop.length; i++) {
        var inc = agg.incTop[i];
        L.push("  " + pctStr((inc[3] * 100) / agg.grand).padStart(7) + "% (" +
          pctStr((inc[4] * 100) / agg.grand).padStart(7) + "%)  " + inc[0] + "." + inc[1] +
          (inc[2] ? ":" + inc[2] : "") + (inc[5] ? " [" + inc[5] + "]" : ""));
      }
    }
    L.push("");
  }

  function renderHari(L, report) {
    var h = report.hari;
    if (!h) return;
    L.push("Hari 熱點 :");
    L.push("  命中 " + h.count + " 節點，累計 " + fmtF(h.total, 0) + " (佔總採樣 " +
      pctStr((h.total * 100) / h.overall) + "%)");
    for (var i = 0; i < h.items.length; i++) {
      L.push("  " + pctStr((h.items[i][1] * 100) / h.overall).padStart(7) + "%  " + h.items[i][0]);
    }
    L.push("");
  }

  // ----------------------------------------------------------------------
  // 對外 API
  // ----------------------------------------------------------------------

  async function analyze(data, label) {
    var report = await buildReport(data, label);
    return { report: report, text: renderText(report) };
  }

  var API = {
    analyze: analyze,
    buildReport: buildReport,
    renderText: renderText,
    constants: {
      WAIT_IDLE_PAIRS: WAIT_IDLE_PAIRS,
      CORE_PREFIXES: CORE_PREFIXES,
      CAUSE_LABEL: CAUSE_LABEL,
      EXCLUDE_LABEL: EXCLUDE_LABEL,
      TICK_ROLES: TICK_ROLES,
      ENTITY_BASE_CLASSES: ENTITY_BASE_CLASSES,
    },
    helpers: {
      pctStr: pctStr,
      fmtF: fmtF,
      pyStr: pyStr,
      fmtMspt: fmtMspt,
      fnum: fnum,
      fmtTs: fmtTs,
      splitKey: splitKey,
    },
  };

  root.SparkEngine = API;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
