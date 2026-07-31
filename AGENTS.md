# Side Panel
```html
```

# Content Script
```js
// 抓 ytInitialPlayerResponse → 取 caption tracks → fetch timedtext
// 監聽 SPA 導航（YouTube 是 SPA， yt-navigate-finish event）
```

# Background Service Worker
```js
// 接收 content script 的字幕資料
// 呼叫 LLM API（Gemini / OpenAI / DeepSeek）
// 處理 SRT / VTT 匯出
```

# LLM Prompt 策略
```
分段策略：
- 逐字稿依語意段落分段（每段 ~2000 tokens）
- 每段獨立摘要後再彙整

摘要 prompt：
1. 一句話總結
2. 3-5 個重點（含近似時間戳）
3. 章節分段（含時間範圍）
```

# 字幕擷取流程
```
1. 頁面載入 → content.js 解析 ytInitialPlayerResponse
2. 取得 captions.playerCaptionsTracklistRenderer.captionTracks
3. 選最佳字幕軌（偏好原始語言 > 英文 > 中文）
4. fetch captionTracks.baseUrl → XML 格式 timedtext
5. 解析 XML → [{ start, dur, text }] 結構
6. 傳給 background.js 處理
```

# 風險
```
- ytInitialPlayerResponse 結構變更 → 需防禦性解析 + fallback
- timedtext API CORS → 需在 background worker 呼叫（有 host_permissions）
- 長影片 token 超限 → 分段送 LLM
- 自動翻譯字幕 baseUrl 帶 &kind=asr 品質差 → 優先手動字幕
```
