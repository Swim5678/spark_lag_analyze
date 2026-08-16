/* data.js — 資料取得層：bytebin 下載 / 本機上傳 / 深鏈參數
 * 純靜態、零外部依賴。所有對外字串為繁體中文。 */
(function (root) {
  "use strict";

  var BYTEBIN = "https://bytebin.lucko.me/";
  var ALLOWED_HOSTS = { "spark.lucko.me": true, "bytebin.lucko.me": true };
  var ID_RE = /^[A-Za-z0-9_-]{4,32}$/;

  /* 解析輸入文字：回傳 { id } 或 { error }（繁中訊息）。 */
  function parseInput(text) {
    var s = (text || "").trim();
    if (!s) return { error: "請貼上 spark.lucko.me 網址或報告 ID" };
    if (/^https?:\/\//i.test(s)) {
      var u;
      try {
        u = new URL(s);
      } catch (e) {
        return { error: "網址格式無效，請檢查後重試" };
      }
      if (!ALLOWED_HOSTS[u.hostname]) {
        return { error: "僅支援 spark.lucko.me 與 bytebin.lucko.me 的網址" };
      }
      var id = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
      if (!ID_RE.test(id)) {
        return { error: "網址中找不到有效的報告 ID" };
      }
      return { id: id };
    }
    if (ID_RE.test(s)) return { id: s };
    return { error: "無法辨識的輸入：請貼上完整網址或報告 ID" };
  }

  /* 從 bytebin 下載：回傳 ArrayBuffer（gzip 或原始 bytes，engine 會自動處理）。 */
  async function fetchProfile(id) {
    var res;
    try {
      res = await fetch(BYTEBIN + id, {
        headers: { Accept: "application/octet-stream" },
      });
    } catch (e) {
      throw new Error("無法連線至 bytebin.lucko.me（可能離線或網路受限），請改用本機上傳 .sparkprofile 檔案");
    }
    if (!res.ok) {
      throw new Error("bytebin 回傳錯誤碼 " + res.status + "，報告可能已過期或不存在");
    }
    var buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0) {
      throw new Error("bytebin 回傳的資料是空的");
    }
    return buf;
  }

  /* 讀取本機 .sparkprofile 檔案：回傳 ArrayBuffer。 */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error("讀取檔案失敗，請重試")); };
      fr.readAsArrayBuffer(file);
    });
  }

  /* ?id= 深鏈參數。 */
  function idFromQuery() {
    try {
      return new URLSearchParams(location.search).get("id");
    } catch (e) {
      return null;
    }
  }

  var API = { parseInput: parseInput, fetchProfile: fetchProfile, readFile: readFile, idFromQuery: idFromQuery };
  root.SparkData = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
