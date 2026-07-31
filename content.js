/**
 * Content Script (隔離世界) — 協調 YouTube 頁面與擴充功能
 *
 * 職責：
 * 1. 向 main-world.js 發送請求，取得字幕軌列表
 * 2. 回應 Side Panel 的 GET_PAGE_INFO 請求
 * 3. 監聽 SPA 導航
 *
 * 注意：不使用 inline script 注入（YouTube CSP 擋住）
 *       main-world.js 透過 manifest.json 的 world:"MAIN" 載入
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

// ── 向主世界請求字幕資訊 ──────────────────────────────

function requestCaptionsFromMainWorld(videoId) {
  return new Promise((resolve) => {
    let resolved = false;

    const handler = (event) => {
      if (event.source !== window) return;
      if (event.data.type === 'YASRT_RESULT' && event.data.videoId === videoId) {
        window.removeEventListener('message', handler);
        resolved = true;
        resolve(event.data);
      }
    };
    window.addEventListener('message', handler);

    // 超時（5 秒）
    setTimeout(() => {
      if (!resolved) {
        window.removeEventListener('message', handler);
        resolve({ captions: [], hasCaptions: false, error: 'timeout' });
      }
    }, 5000);

    // 向 main-world.js 發送請求
    window.postMessage({ type: 'YASRT_REQUEST', videoId }, '*');
  });
}

/**
 * 帶重試的擷取
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
    const result = await requestCaptionsFromMainWorld(videoId);

    if (result.hasCaptions) {
      cachedCaptions = result.captions;
      cachedVideoId = videoId;
      return {
        success: true,
        videoId,
        title: getVideoTitle(),
        captions: result.captions,
        hasCaptions: true,
      };
    }

    // 明確無字幕（非 timeout / 非 no_player_response）
    if (result.error && result.error !== 'timeout' && result.error !== 'no_player_response') {
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

    if (i < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

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
