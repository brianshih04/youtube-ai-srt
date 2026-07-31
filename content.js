/**
 * Content Script — 從 YouTube 頁面擷取字幕軌資訊
 *
 * 流程：
 * 1. 監聽 yt-navigate-finish（YouTube SPA 導航）
 * 2. 解析 ytInitialPlayerResponse 取得 caption tracks
 * 3. 回傳字幕軌列表給 background / sidepanel
 */

// ── 工具函式 ──────────────────────────────────────────

function getVideoId() {
  const url = new URL(window.location.href);
  if (url.hostname === 'www.youtube.com' && url.pathname === '/watch') {
    return url.searchParams.get('v');
  }
  // Shorts
  const shortsMatch = url.pathname.match(/^\/shorts\/(.+)/);
  if (shortsMatch) return shortsMatch[1];
  return null;
}

/**
 * 從頁面的 ytInitialPlayerResponse 取得字幕軌列表
 */
function extractCaptionTracks() {
  // 方式一：直接讀取全局變數（某些情況下可用）
  if (typeof ytInitialPlayerResponse !== 'undefined') {
    const tracks = ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (tracks && tracks.length > 0) return tracks;
  }

  // 方式二：從頁面內嵌的 ytInitialPlayerResponse JSON 搜尋
  const scripts = document.querySelectorAll('script:not[src]');
  for (const script of scripts) {
    const text = script.textContent;
    if (!text || !text.includes('captionTracks')) continue;

    try {
      // 嘗試找到 ytInitialPlayerResponse = {...};
      const match = text.match(/ytInitialPlayerResponse\s*=\s*({.+?});/s);
      if (match) {
        const data = JSON.parse(match[1]);
        const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (tracks && tracks.length > 0) return tracks;
      }
    } catch (e) {
      // JSON 解析失敗，繼續嘗試下一個 script
    }
  }

  // 方式三：從 ytcfg 搜尋
  try {
    if (typeof ytcfg !== 'undefined' && ytcfg.data_) {
      const data = ytcfg.data_;
      const playerResponse = data?.PLAYER_VARS?.embedded_player_response
        || data?.INNERTUBE_CONTEXT;
      // 嘗試從 ytcfg 取得（作為 fallback）
    }
  } catch (e) {
    // 忽略
  }

  return null;
}

/**
 * 取得影片標題
 */
function getVideoTitle() {
  const titleEl = document.querySelector('h1.ytd-watch-metadata title, h1.title yt-formatted-string, h1.ytd-watch-metadata yt-formatted-string');
  if (titleEl) return titleEl.textContent.trim();
  return document.title.replace(' - YouTube', '').trim();
}

/**
 * 主函式：擷取頁面資訊
 */
function collectPageInfo() {
  const videoId = getVideoId();
  if (!videoId) {
    return { success: false, error: 'not_a_video_page' };
  }

  const captionTracks = extractCaptionTracks();

  if (!captionTracks) {
    return {
      success: true,
      videoId,
      title: getVideoTitle(),
      captions: [],
      hasCaptions: false,
    };
  }

  // 整理字幕軌列表
  const captions = captionTracks.map(t => ({
    baseUrl: t.baseUrl,
    languageCode: t.languageCode,
    kind: t.kind || null,
    name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
  }));

  return {
    success: true,
    videoId,
    title: getVideoTitle(),
    captions,
    hasCaptions: true,
  };
}

/**
 * 等待頁面完全載入後再擷取（SPA 延遲問題）
 */
function collectWithRetry(maxRetries = 5, delay = 1000) {
  return new Promise((resolve) => {
    let attempts = 0;

    function attempt() {
      attempts++;
      const info = collectPageInfo();
      if (info.success && info.hasCaptions) {
        resolve(info);
      } else if (info.success && !info.hasCaptions && attempts >= maxRetries) {
        // 確認是 watch 頁面但沒有字幕
        resolve(info);
      } else if (attempts >= maxRetries) {
        resolve(info);
      } else {
        setTimeout(attempt, delay);
      }
    }

    attempt();
  });
}

// ── 訊息監聽 ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_INFO') {
    collectWithRetry().then(sendResponse);
    return true; // async response
  }
});

// ── SPA 導航監聽 ──────────────────────────────────────

// YouTube 使用自訂的導航事件
document.addEventListener('yt-navigate-finish', () => {
  const videoId = getVideoId();
  if (videoId) {
    chrome.runtime.sendMessage({
      type: 'PAGE_CHANGED',
      videoId,
    }).catch(() => {});
  }
});

// ── 注入頁面層級腳本（提取全局變數） ───────────────────

// content script 在隔離世界執行，無法直接讀取 ytInitialPlayerResponse
// 但可以從 DOM 內的 <script> 標籤解析
// 如果上面的方法都失敗，注入一個 inline script 到主世界
function injectMainWorldScript() {
  const script = document.createElement('script');
  script.textContent = `
    (function() {
      function sendCaptions() {
        try {
          let playerResponse = null;
          if (typeof ytInitialPlayerResponse !== 'undefined') {
            playerResponse = ytInitialPlayerResponse;
          }
          if (!playerResponse) return;

          const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (!tracks) {
            window.postMessage({ type: 'YASRT_NO_CAPTIONS' }, '*');
            return;
          }

          const captions = tracks.map(t => ({
            baseUrl: t.baseUrl,
            languageCode: t.languageCode,
            kind: t.kind || null,
            name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || t.languageCode,
          }));

          window.postMessage({ type: 'YASRT_CAPTIONS', captions }, '*');
        } catch(e) {
          window.postMessage({ type: 'YASRT_ERROR', error: e.message }, '*');
        }
      }

      // 稍微延遲以確保變數已載入
      setTimeout(sendCaptions, 1500);
    })();
  `;
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}

// 監聽從主世界來的 postMessage
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data.type === 'YASRT_CAPTIONS') {
    chrome.runtime.sendMessage({
      type: 'CAPTIONS_FOUND',
      captions: event.data.captions,
    }).catch(() => {});
  }
});

// 初始載入時嘗試注入
if (getVideoId()) {
  injectMainWorldScript();
}
