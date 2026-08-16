/*!
 * protobuf.js — spark SamplerData 手刻 protobuf 解碼器（瀏覽器 / Node 通用）
 *
 * 移植自 spark-analyze.py 的解碼層：只支援 spark 用到的 wire type
 * （0=varint、1=fixed64、2=length-delimited、5=fixed32）。
 * 無外部套件、無 CDN；瀏覽器以 <script> 順序載入，Node 以 require 載入。
 */
(function (root) {
  "use strict";

  // ----------------------------------------------------------------------
  // varint
  // ----------------------------------------------------------------------

  function parseVarint(buf, i) {
    /* 讀一個 varint，回傳 [值, 新的偏移]。
     * 乘法累加（2^shift 倍）取代位元運算，支援 >32bit 且 <2^53 的整數精確值。 */
    var result = 0;
    var shift = 0;
    while (true) {
      if (i >= buf.length) throw new Error("截斷的 varint");
      var byte = buf[i];
      i += 1;
      result += (byte & 0x7f) * Math.pow(2, shift);
      if (!(byte & 0x80)) return [result, i];
      shift += 7;
      if (shift >= 70) throw new Error("varint 過長");
    }
  }

  // ----------------------------------------------------------------------
  // message 解析
  // ----------------------------------------------------------------------

  function parseMsg(buf) {
    /* protobuf message → Map<欄位編號, [{wire, value}, ...]>
     * value: varint=number、fixed64=Uint8Array(8)、length-delimited=Uint8Array、
     *        fixed32=Uint8Array(4)。邊界異常拋 Error。 */
    var out = new Map();
    var i = 0;
    var n = buf.length;
    while (i < n) {
      var key, value;
      var pair = parseVarint(buf, i);
      key = pair[0];
      i = pair[1];
      var field = key >> 3;
      var wire = key & 7;
      if (wire === 0) {
        pair = parseVarint(buf, i);
        value = pair[0];
        i = pair[1];
      } else if (wire === 1) {
        if (i + 8 > n) throw new Error("截斷的 fixed64");
        value = buf.subarray(i, i + 8);
        i += 8;
      } else if (wire === 2) {
        pair = parseVarint(buf, i);
        var length = pair[0];
        i = pair[1];
        if (i + length > n) throw new Error("截斷的 length-delimited");
        value = buf.subarray(i, i + length);
        i += length;
      } else if (wire === 5) {
        if (i + 4 > n) throw new Error("截斷的 fixed32");
        value = buf.subarray(i, i + 4);
        i += 4;
      } else {
        throw new Error("不支援的 wire type " + wire + " (field " + field + ")");
      }
      var arr = out.get(field);
      if (!arr) {
        arr = [];
        out.set(field, arr);
      }
      arr.push({ wire: wire, value: value });
    }
    return out;
  }

  function safeParse(v) {
    /* Uint8Array → message；缺欄位或壞資料 → null（不拋例外）。 */
    if (v instanceof Uint8Array) {
      try {
        var m = parseMsg(v);
        return m.size ? m : null;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  // ----------------------------------------------------------------------
  // StackTraceNode 專用快速解析
  // ----------------------------------------------------------------------

  function unpackPackedInts(v) {
    /* packed repeated varint（wire type 2）解回 number 清單。 */
    var out = [];
    var i = 0;
    while (i < v.length) {
      var pair = parseVarint(v, i);
      out.push(pair[0]);
      i = pair[1];
    }
    return out;
  }

  function parseStackNode(buf) {
    /* StackTraceNode 快速解析：f3 class / f4 method / f6 line /
     * f8 times（直接累加總和）/ f9 children refs。
     * 回傳 [cls, mth, line, time_total, refs]。 */
    var cls = null;
    var mth = null;
    var line = 0;
    var total = 0;
    var refs = [];
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    var i = 0;
    var n = buf.length;
    while (i < n) {
      var key = 0;
      var shift = 0;
      while (true) {
        if (i >= n) throw new Error("截斷的 varint");
        var byte = buf[i];
        i += 1;
        key |= (byte & 0x7f) << shift;
        if (!(byte & 0x80)) break;
        shift += 7;
      }
      var field = key >> 3;
      var wire = key & 7;
      if (wire === 0) {
        var val = 0;
        var sh = 0;
        while (true) {
          if (i >= n) throw new Error("截斷的 varint");
          byte = buf[i];
          i += 1;
          val += (byte & 0x7f) * Math.pow(2, sh);
          if (!(byte & 0x80)) break;
          sh += 7;
        }
        if (field === 6) {
          line = val;
        } else if (field === 9) {
          refs.push(val);
        }
      } else if (wire === 1) {
        if (field === 8) {
          if (i + 8 > n) throw new Error("截斷的 fixed64");
          total += dv.getFloat64(i, true);
        }
        i += 8;
      } else if (wire === 2) {
        var length = 0;
        sh = 0;
        while (true) {
          if (i >= n) throw new Error("截斷的 varint");
          byte = buf[i];
          i += 1;
          length += (byte & 0x7f) * Math.pow(2, sh);
          if (!(byte & 0x80)) break;
          sh += 7;
        }
        var seg = buf.subarray(i, i + length);
        i += length;
        if (field === 3) {
          cls = seg;
        } else if (field === 4) {
          mth = seg;
        } else if (field === 8) {
          if (seg.length % 8) throw new Error("times 資料長度非 8 倍數");
          var segDv = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
          for (var j = 0; j < seg.length; j += 8) {
            total += segDv.getFloat64(j, true);
          }
        } else if (field === 9) {
          var packed = unpackPackedInts(seg);
          for (var k = 0; k < packed.length; k++) refs.push(packed[k]);
        }
      } else {
        throw new Error("不支援的 wire type " + wire + " (field " + field + ")");
      }
    }
    return [cls, mth, line, total, refs];
  }

  // ----------------------------------------------------------------------
  // 欄位存取與型別轉換
  // ----------------------------------------------------------------------

  function get(flds, field, idx) {
    /* 取得欄位第 idx 個原始值；沒有就回傳 null。 */
    if (!flds) return null;
    var lst = flds.get(field);
    var i = idx === undefined ? 0 : idx;
    if (lst && i < lst.length) {
      return lst[i].value;
    }
    return null;
  }

  function allOf(flds, field) {
    /* 取得 repeated 欄位所有原始值。 */
    if (!flds) return [];
    var arr = flds.get(field);
    if (!arr) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push(arr[i].value);
    return out;
  }

  function vi(v, def) {
    /* 僅 varint 整數視為有效值，其餘回傳預設值。 */
    if (typeof v === "number" && Number.isInteger(v)) return v;
    return def === undefined ? 0 : def;
  }

  function asDouble(v) {
    /* fixed64 (8 bytes) → double；varint 直接回傳。 */
    if (v instanceof Uint8Array && v.length === 8) {
      return new DataView(v.buffer, v.byteOffset, v.byteLength).getFloat64(0, true);
    }
    if (typeof v === "number") return v;
    return null;
  }

  // ----------------------------------------------------------------------
  // bytes → 字串（快取）
  // ----------------------------------------------------------------------

  /* 以內容 FNV-1a 雜湊為鍵的快取，取代 Python 版的 bytes 值快取：
   * 同一份 profile 中同一字串反覆出現（類別/方法名），只 decode 一次。
   * 兩條 32-bit FNV 通道合成 64-bit，同長度同雜湊的碰撞機率可忽略。 */
  var _ST_CACHE = new Map();
  var _TD = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;

  function _fnv(v) {
    var h1 = 0x811c9dc5;
    var h2 = 0xdeadbeef;
    for (var i = 0; i < v.length; i++) {
      var b = v[i];
      h1 = (h1 ^ b) * 0x01000193 >>> 0;
      h2 = (h2 ^ b) * 0x85ebca6b >>> 0;
    }
    return h1.toString(36) + ":" + h2.toString(36);
  }

  function st(v) {
    /* Uint8Array → UTF-8 字串（容錯，帶快取）；非 bytes → null。 */
    if (typeof v === "string") return v;
    if (!(v instanceof Uint8Array)) return null;
    if (!_TD) return null;
    var h = _fnv(v);
    var hit = _ST_CACHE.get(h);
    if (hit && hit.len === v.length) return hit.s;
    if (_ST_CACHE.size > 100000) _ST_CACHE.clear();
    var s = _TD.decode(v);
    _ST_CACHE.set(h, { len: v.length, s: s });
    return s;
  }

  // ----------------------------------------------------------------------
  // gzip（瀏覽器 DecompressionStream / Node 全域通用）
  // ----------------------------------------------------------------------

  async function gunzip(u8) {
    var ds = new DecompressionStream("gzip");
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  async function gunzipIfNeeded(data) {
    if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
      return gunzip(data);
    }
    return data;
  }

  var API = {
    parseVarint: parseVarint,
    parseMsg: parseMsg,
    safeParse: safeParse,
    parseStackNode: parseStackNode,
    unpackPackedInts: unpackPackedInts,
    get: get,
    allOf: allOf,
    vi: vi,
    asDouble: asDouble,
    st: st,
    gunzip: gunzip,
    gunzipIfNeeded: gunzipIfNeeded,
  };

  root.SparkProto = API;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
