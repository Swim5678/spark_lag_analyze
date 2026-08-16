# spark 分析器（網頁版）

將 spark（[spark.lucko.me](https://spark.lucko.me)）的取樣報告（SamplerData）轉換為繁體中文卡頓診斷的純靜態網站。完全在瀏覽器本機解析，報告不會上傳到任何伺服器。

- 純靜態：HTML + CSS + JavaScript，零外部套件、零 CDN，可完全離線使用

## 使用方式

開啟 `index.html` 後，三種輸入任選：

1. **貼上 spark.lucko.me 網址或報告 ID**（如 `WOVkupfiJx`）→ 直接從 bytebin.lucko.me 下載並分析
2. **上傳 .sparkprofile 檔案** → 支援匯出的 `.sparkprofile`（gzip）檔案，離線可用
3. **URL 深連結**：`https://網址/?id=WOVkupfiJx` → 開啟頁面即自動分析該報告

## 檔案結構

```
index.html          頁面骨架（頂欄、輸入列、結果區）
css/style.css       全部樣式（設計 tokens 集中在 :root）
js/protobuf.js      spark 的 bytebin protobuf 手刻解碼器（wire type 0/1/2/5）
js/engine.js        診斷引擎（分析、分類、熱點、呼叫鏈、文字輸出）
js/data.js          輸入解析、bytebin 下載、檔案讀取
js/app.js           UI 渲染層（診斷卡、圖表、執行緒手風琴…）
spark-analyze.py    原始 Python CLI 工具（引擎的母版，僅為逐字元比對驗證用）
spark_lag_analyze/  js/ css/ 的位元組一致複製品（改動後需同步並用 fc /B 驗證）
```

## 輸出內容

- 伺服器狀態橫幅與 TPS / MSPT / tick 超支指標
- 主要原因卡（self 佔比、每 tick 成本、信心、呼叫鏈、實體開銷分項）
- 排除原因與注意事項、插件分析、Region 排名、實體/區塊相關性
- 時間窗折線圖（分開 / 重疊兩種檢視，hover 顯示各分鐘數值）
- 執行緒詳細（每執行緒熱點 / 已排除 / 含子時間榜，可個別展開）
- 全伺服器彙總、環境與 GC 統計

## 效能

- 分析引擎全數在瀏覽器本機執行；22MB 報告（約 10 萬節點）引擎解析約 0.5 秒，大檔亦不阻塞操作。
- 效能承重處皆以快取/索引實作（解碼快取、splitKey 快取、plugin 前綴索引等），新增邏輯請沿用此模式。

## 隱私

所有解析都在瀏覽器內完成；僅在「輸入 spark.lucko.me 網址或 ID」時會向 bytebin.lucko.me 下載報告，本專案不包含任何分析程式碼以外的伺服器。
