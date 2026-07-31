# YouTube AI SRT

> YouTube 影片 → AI 摘要 + 互動逐字稿，直接在瀏覽器裡完成。

Chrome 擴充功能，在 YouTube 頁面側邊顯示 AI 摘要和可點擊的逐字稿。用戶自帶 API Key，零伺服器。

## 功能

- 📋 **AI 摘要** — 一句話總結 + 重點條列 + 章節分段（含時間戳）
- 📝 **互動逐字稿** — 點擊時間戳跳轉、搜尋、跟隨播放自動捲動
- 🔑 **自帶 Key** — 支援 Gemini / OpenAI / DeepSeek，不經過任何伺服器
- 📤 **匯出** — SRT / VTT / Markdown
- 🌐 **跨平台** — Windows / macOS / Linux

## 架構

```
YouTube 頁面
    │
    ├─ Content Script → 解析 ytInitialPlayerResponse → 取字幕軌
    │
    ├─ Side Panel（Chrome Side Panel API）
    │   ├─ 逐字稿區（可點擊跳轉）
    │   ├─ AI 摘要區
    │   └─ 設定區（API Key）
    │
    └─ Background Service Worker
        ├─ 呼叫 LLM API（用戶自帶 Key）
        └─ SRT / VTT 匯出
```

## 開發計畫

| 階段 | 內容 | 狀態 |
|------|------|------|
| P1 | 字幕擷取 + Gemini 摘要 + Side Panel UI | 🚧 規劃中 |
| P2 | 逐字稿互動（點擊跳轉、搜尋、auto-scroll） | ⏳ |
| P3 | 多 Provider（OpenAI / DeepSeek）+ SRT 匯出 | ⏳ |
| P4 | 無字幕 fallback（Whisper API）+ 多語言 UI | ⏳ |

## 技術棧

- **Manifest V3**（Chrome 強制）
- **Side Panel API**（Chrome 114+）
- **Vanilla JS / TypeScript** — 無框架依賴，輕量
- **chrome.storage.local** — API Key 加密存儲

## 授權

MIT
