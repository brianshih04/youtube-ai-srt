/**
 * Content Script (隔離世界) — 從 YouTube 頁面擷取字幕軌
 *
 * 策略：直接從 DOM 的 <script> 標籤解析 ytInitialPlayerResponse。
 * 這在隔離世界完全可行，不需要注入主世界腳本。
 */

// ── 狀態 ──────────────────────────────────────────────

let cachedCaptions = null;
let cachedVideoId = null;

// ── 工具函式 ──────────────────────────────────────────

function getVideoId() {
  const url = new URL(window.location.href);
  if (url.hostname === 'www.youtube.com' && url.pathname === '/watch') {
    return url.searchParams.get('v');
  }
  const shortsMatch = url.pathname.match(/^\/shorts\/(.+)/);
  if (shortsMatch) return shortsMatch[1];
  return null;
}

function getVideoTitle() {
  const titleEl =
    document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
    document.querySelector('h1.title yt-formatted-string');
  if (titleEl) return titleEl.textContent.trim();
  return document.title.replace(' - YouTube', '').trim();
}

// ── 字幕軌擷取 ────────────────────────────────────────

/**
 * 從 DOM <script> 標籤解析 ytInitialPlayerResponse
 */
function extractCaptionTracks() {
  const scripts = document.querySelectorAll('script:not([src])');
  for (const script of scripts) {
    const text = script.textContent;
    if (!text || text.indexOf('captionTracks') === -1) continue;

    // 嘗試提取 ytInitialPlayerResponse = {...};
    // 注意：JSON 很大，需要貪婪匹配到正確的結尾分號
    try {
      // 方法一：標準 regex
      const match = text.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});\s*(?:var\s|<\/script>|$)/);
      if (match) {
        const data = JSON.parse(match[1]);
        const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (tracks && tracks.length > 0) return tracks;
      }
    } catch (e) {
      // regex 可能截斷 JSON，嘗試方法二
    }

    // 方法二：用括號配對找到完整 JSON
    try {
      const marker = 'ytInitialPlayerResponse';
      const idx = text.indexOf(marker);
      if (idx === -1) continue;

      // 找到 = 號後的 {
      let braceIdx = text.indexOf('{', idx);
      if (braceIdx === -1) continue;

      // 括號配對
      let depth = 0;
      let inString = false;
      let escape = false;
      let endIdx = -1;

      for (let i = braceIdx; i < text.length; i++) {
        const ch = text[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            endIdx = i;
            break;
          }
        }
      }

      if (endIdx === -1) continue;

      const jsonStr = text.substring(braceIdx, endIdx + 1);
      const data = JSON.parse(jsonStr);
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length > 0) return tracks;
    } catch (e) {
      // 繼續嘗試下一個 script
    }
  }

  return null;
}

/**
 * 主函式：擷取頁面資訊
 */
async function fetchPageInfo(maxRetries = 5, delay = 1000) {
  const videoId = getVideoId();
  if (!videoId) {
    return { success: false, error: 'not_a_video_page' };
  }

  // 快取命中
  if (cachedCaptions !== null && cachedVideoId === videoId) {
    return {
      success: true,
      videoId,
      title: getVideoTitle(),
      captions: cachedCaptions,
      hasCaptions: cachedCaptions.length > 0,
    };
  }

  for (let i = 0; i < maxRetries; i++) {
    const tracks = extractCaptionTracks();

    if (tracks) {
      const captions = tracks.map((t) => ({
        baseUrl: (t.baseUrl || '').replace(/\\u0026/g, '&'),
        languageCode: t.languageCode,
        kind: t.kind || null,
        name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
      }));

      cachedCaptions = captions;
      cachedVideoId = videoId;
      return {
        success: true,
        videoId,
        title: getVideoTitle(),
        captions,
        hasCaptions: true,
      };
    }

    // 等待後重試（SPA 載入延遲）
    if (i < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // 重試完畢仍無字幕
  cachedCaptions = [];
  cachedVideoId = videoId;
  return {
    success: true,
    videoId,
    title: getVideoTitle(),
    captions: [],
    hasCaptions: false,
  };
}

// ── 訊息監聽 ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_INFO') {
    fetchPageInfo().then(sendResponse);
    return true;
  }

  if (msg.type === 'CLEAR_CACHE') {
    cachedCaptions = null;
    cachedVideoId = null;
    sendResponse({ success: true });
    return false;
  }
});

// ── SPA 導航監聽 ──────────────────────────────────────

document.addEventListener('yt-navigate-finish', () => {
  const videoId = getVideoId();
  if (videoId) {
    cachedCaptions = null;
    cachedVideoId = null;
    chrome.runtime.sendMessage({ type: 'PAGE_CHANGED', videoId }).catch(() => {});
  }
});
