/**
 * Content Script — 從 YouTube 頁面擷取字幕軌資訊
 *
 * 核心問題：content script 在隔離世界執行，無法直接讀取
 * ytInitialPlayerResponse 等頁面全局變數。
 *
 * 解法：注入 inline script 到主世界，透過 postMessage 溝通。
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
    document.querySelector('h1.ytd-watch-metadata yt-formatted-string')
    || document.querySelector('h1.title yt-formatted-string')
    || document.querySelector('title');
  if (titleEl) return titleEl.textContent.trim();
  return document.title.replace(' - YouTube', '').trim();
}

// ── 主世界注入（擷取 ytInitialPlayerResponse） ─────────

function injectMainWorldScript(videoId) {
  return new Promise((resolve) => {
    let resolved = false;

    // 一次性監聽器
    const handler = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (data.type === 'YASRT_RESULT' && data.videoId === videoId) {
        window.removeEventListener('message', handler);
        resolved = true;
        resolve(data);
      }
    };
    window.addEventListener('message', handler);

    // 超時 fallback（10 秒）
    setTimeout(() => {
      if (!resolved) {
        window.removeEventListener('message', handler);
        resolve({ type: 'YASRT_RESULT', videoId, captions: [], hasCaptions: false, error: 'timeout' });
      }
    }, 10000);

    // 注入腳本到主世界
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        var videoId = ${JSON.stringify(videoId)};
        try {
          // 嘗試多種方式取得 player response
          var playerResponse = null;

          // 方式一：全局變數
          if (typeof ytInitialPlayerResponse !== 'undefined') {
            playerResponse = ytInitialPlayerResponse;
          }

          // 方式二：從 ytcfg 取得
          if (!playerResponse && typeof ytcfg !== 'undefined') {
            try {
              var data = ytcfg.data_ || {};
              // 有些版本的 ytcfg 存在這裡
              if (data.INNERTUBE_PLAYER_RESPONSE) {
                playerResponse = data.INNERTUBE_PLAYER_RESPONSE;
              }
            } catch(e) {}
          }

          // 方式三：從 DOM script 標籤解析
          if (!playerResponse) {
            var scripts = document.querySelectorAll('script:not[src]');
            for (var i = 0; i < scripts.length; i++) {
              var text = scripts[i].textContent;
              if (!text || text.indexOf('captionTracks') === -1) continue;
              try {
                var match = text.match(/ytInitialPlayerResponse\\s*=\\s*({[\\s\\S]+?});/);
                if (match) {
                  playerResponse = JSON.parse(match[1]);
                  break;
                }
              } catch(e) {}
            }
          }

          if (!playerResponse) {
            window.postMessage({ type: 'YASRT_RESULT', videoId: videoId, captions: [], hasCaptions: false, error: 'no_player_response' }, '*');
            return;
          }

          var tracks = playerResponse.captions
            && playerResponse.captions.playerCaptionsTracklistRenderer
            && playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;

          if (!tracks || tracks.length === 0) {
            window.postMessage({ type: 'YASRT_RESULT', videoId: videoId, captions: [], hasCaptions: false, error: 'no_tracks' }, '*');
            return;
          }

          var captions = tracks.map(function(t) {
            return {
              baseUrl: t.baseUrl,
              languageCode: t.languageCode,
              kind: t.kind || null,
              name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || t.languageCode,
            };
          });

          window.postMessage({ type: 'YASRT_RESULT', videoId: videoId, captions: captions, hasCaptions: true }, '*');
        } catch(e) {
          window.postMessage({ type: 'YASRT_RESULT', videoId: videoId, captions: [], hasCaptions: false, error: e.message }, '*');
        }
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();
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

  // 如果已經有快取且 videoId 相同，直接回傳
  if (cachedCaptions !== null && cachedVideoId === videoId) {
    return {
      success: true,
      videoId,
      title: getVideoTitle(),
      captions: cachedCaptions,
      hasCaptions: cachedCaptions.length > 0,
    };
  }

  // 重試注入（YouTube SPA 載入延遲）
  for (let i = 0; i < maxRetries; i++) {
    const result = await injectMainWorldScript(videoId);

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

    // 如果不是 timeout 也不是 no_player_response，就是真的沒字幕
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

    // 等待後重試
    if (i < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // 最後一次嘗試的結果
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

// ── 訊息監聯 ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_INFO') {
    fetchPageInfo().then(sendResponse);
    return true; // async response
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
    // 清除快取，新頁面需要重新擷取
    cachedCaptions = null;
    cachedVideoId = null;
    chrome.runtime.sendMessage({ type: 'PAGE_CHANGED', videoId }).catch(() => {});
  }
});
