/**
 * Main World Script — 在 YouTube 頁面的主世界執行
 *
 * 直接讀取 ytInitialPlayerResponse 等頁面全局變數，
 * 透過 window.postMessage 與 content.js（隔離世界）溝通。
 *
 * 注意：此檔案不能使用 chrome.* API（不在隔離世界）
 */

(function () {
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (event.data.type !== 'YASRT_REQUEST') return;

    var videoId = event.data.videoId;
    var result = {
      type: 'YASRT_RESULT',
      videoId: videoId,
      captions: [],
      hasCaptions: false,
      error: null,
    };

    try {
      // 方式一：全局變數
      var playerResponse = null;
      if (typeof ytInitialPlayerResponse !== 'undefined') {
        playerResponse = ytInitialPlayerResponse;
      }

      // 方式二：從 ytcfg 取得
      if (!playerResponse && typeof ytcfg !== 'undefined') {
        try {
          var d = ytcfg.data_ || {};
          if (d.INNERTUBE_PLAYER_RESPONSE) {
            playerResponse = d.INNERTUBE_PLAYER_RESPONSE;
          }
        } catch (e) {}
      }

      // 方式三：從 DOM script 標籤解析
      if (!playerResponse) {
        var scripts = document.querySelectorAll('script:not([src])');
        for (var i = 0; i < scripts.length; i++) {
          var text = scripts[i].textContent;
          if (!text || text.indexOf('captionTracks') === -1) continue;
          try {
            var match = text.match(/ytInitialPlayerResponse\s*=\s*({[\s\S]+?});/);
            if (match) {
              playerResponse = JSON.parse(match[1]);
              break;
            }
          } catch (e) {}
        }
      }

      if (!playerResponse) {
        result.error = 'no_player_response';
        window.postMessage(result, '*');
        return;
      }

      var tracks =
        playerResponse.captions &&
        playerResponse.captions.playerCaptionsTracklistRenderer &&
        playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;

      if (!tracks || tracks.length === 0) {
        result.error = 'no_tracks';
        window.postMessage(result, '*');
        return;
      }

      result.captions = tracks.map(function (t) {
        return {
          baseUrl: t.baseUrl,
          languageCode: t.languageCode,
          kind: t.kind || null,
          name:
            (t.name &&
              (t.name.simpleText ||
                (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) ||
            t.languageCode,
        };
      });
      result.hasCaptions = true;
    } catch (e) {
      result.error = e.message;
    }

    window.postMessage(result, '*');
  });
})();
