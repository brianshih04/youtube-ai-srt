/**
 * Side Panel 主邏輯
 *
 * 職責：
 * 1. 與 content script 通訊取得頁面資訊
 * 2. 透過 background worker fetch 字幕 + 生成摘要
 * 3. UI 互動（分頁切換、搜尋、跳轉、匯出）
 * 4. 設定管理（API Key / Provider）
 */

// ── 狀態 ──────────────────────────────────────────────

const state = {
  videoId: null,
  videoTitle: '',
  captions: [],          // 字幕軌列表
  selectedTrack: null,   // 選中的字幕軌
  transcript: [],        // 已擷取的逐字稿 segments [{ start, dur, text }]
  summary: '',           // 已生成的摘要
  settings: {
    provider: 'gemini',
    apiKey: '',
    model: '',
    baseUrl: '',
    asrUrl: 'https://yt-transcribe.avision-gb10.org',
  },
  activeTab: 'summary',
};

// ── DOM 元素 ──────────────────────────────────────────

const el = {
  header: document.getElementById('header'),
  main: document.getElementById('main-content'),
  emptyState: document.getElementById('empty-state'),
  statusBar: document.getElementById('status-bar'),
  statusText: document.getElementById('status-text'),
  errorBar: document.getElementById('error-bar'),
  errorText: document.getElementById('error-text'),
  videoTitle: document.getElementById('video-title'),
  videoMeta: document.getElementById('video-meta'),
  tabs: document.querySelectorAll('.tab'),
  tabSummary: document.getElementById('tab-summary'),
  tabTranscript: document.getElementById('tab-transcript'),
  summaryContent: document.getElementById('summary-content'),
  transcriptContent: document.getElementById('transcript-content'),
  captionLangSelect: document.getElementById('caption-lang-select'),
  searchInput: document.getElementById('search-input'),
  btnGenerate: document.getElementById('btn-generate'),
  btnExportSrt: document.getElementById('btn-export-srt'),
  btnExportVtt: document.getElementById('btn-export-vtt'),
  btnCopySummary: document.getElementById('btn-copy-summary'),
  btnCopyTranscript: document.getElementById('btn-copy-transcript'),
  // 設定面板
  btnSettings: document.getElementById('btn-settings'),
  settingsPanel: document.getElementById('settings-panel'),
  btnCloseSettings: document.getElementById('btn-close-settings'),
  settingProvider: document.getElementById('setting-provider'),
  settingApiKey: document.getElementById('setting-apikey'),
  settingModel: document.getElementById('setting-model'),
  settingBaseUrl: document.getElementById('setting-baseurl'),
  labelBaseUrl: document.getElementById('label-baseurl'),
  settingAsrUrl: document.getElementById('setting-asrurl'),
  btnSaveSettings: document.getElementById('btn-save-settings'),
};

// ── 工具函式 ──────────────────────────────────────────

function showStatus(text) {
  el.statusBar.classList.remove('hidden');
  el.statusText.textContent = text;
}

function hideStatus() {
  el.statusBar.classList.add('hidden');
}

function showError(text) {
  el.errorBar.classList.remove('hidden');
  el.errorText.textContent = text;
  setTimeout(() => el.errorBar.classList.add('hidden'), 8000);
}

function hideError() {
  el.errorBar.classList.add('hidden');
}

function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 取得當前 active tab 的 YouTube頁面
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * 載入設定
 */
async function loadSettings() {
  const data = await chrome.storage.local.get(['settings']);
  if (data.settings) {
    state.settings = { ...state.settings, ...data.settings };
  }
  // 更新設定面板 UI
  el.settingProvider.value = state.settings.provider;
  el.settingApiKey.value = state.settings.apiKey;
  el.settingModel.value = state.settings.model || '';
  el.settingBaseUrl.value = state.settings.baseUrl || '';
  el.settingAsrUrl.value = state.settings.asrUrl || 'https://yt-transcribe.avision-gb10.org';
  toggleBaseUrlVisibility();
}

/**
 * 顯示/隱藏 Base URL 欄位
 */
function toggleBaseUrlVisibility() {
  const provider = el.settingProvider.value;
  // custom 必須填，其他可選填（覆寫預設端點）
  if (provider === 'custom') {
    el.labelBaseUrl.classList.remove('hidden');
    el.settingBaseUrl.placeholder = 'https://your-api.com（必填）';
  } else {
    el.labelBaseUrl.classList.remove('hidden');
    el.settingBaseUrl.placeholder = '留空使用預設端點';
  }
}

/**
 * 依 Provider 更新 model placeholder
 */
function updateModelPlaceholder() {
  const defaults = {
    gemini: 'gemini-2.5-flash',
    openai: 'gpt-4o-mini',
    deepseek: 'deepseek-chat',
    custom: '填入模型名稱',
  };
  el.settingModel.placeholder = defaults[el.settingProvider.value] || '';
}

/**
 * 儲存設定
 */
async function saveSettings() {
  state.settings = {
    provider: el.settingProvider.value,
    apiKey: el.settingApiKey.value.trim(),
    model: el.settingModel.value.trim(),
    baseUrl: el.settingBaseUrl.value.trim(),
    asrUrl: el.settingAsrUrl.value.trim() || 'https://yt-transcribe.avision-gb10.org',
  };
  await chrome.storage.local.set({ settings: state.settings });
  closeSettings();
  // 如果已有逐字稿，允許重新生成摘要
}

// ── 頁面資訊擷取 ──────────────────────────────────────

async function loadPageInfo() {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !tab.url.includes('youtube.com')) {
    showEmptyState();
    return;
  }

  // 向 content script 請求頁面資訊（帶 timeout 保護）
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 12000)
  );

  const messagePromise = new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_INFO' }, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(response);
      }
    });
  });

  try {
    const response = await Promise.race([messagePromise, timeoutPromise]);

    if (!response || !response.success) {
      showEmptyState();
      return;
    }

    if (!response.hasCaptions) {
      // Fallback: 嘗試從 MAIN world 取得字幕軌
      const mainWorldCaptions = await tryGetCaptionsFromMainWorld();
      if (mainWorldCaptions && mainWorldCaptions.length > 0) {
        state.videoId = response.videoId;
        state.videoTitle = response.title;
        state.captions = mainWorldCaptions;
        renderVideoInfo();
        autoSelectTrack();
        return;
      }

      state.videoId = response.videoId;
      state.videoTitle = response.title;
      state.captions = [];
      renderNoCaptions();
      return;
    }

    state.videoId = response.videoId;
    state.videoTitle = response.title;
    state.captions = response.captions;
    renderVideoInfo();
    autoSelectTrack();
  } catch (err) {
    // content script 可能還沒載入，顯示提示
    showEmptyState();
    showError('無法連接頁面，請重新整理 YouTube 頁面後再試');
  }
}

/**
 * 在 MAIN world 讀取 player response 取得字幕軌
 */
async function tryGetCaptionsFromMainWorld() {
  try {
    const tab = await getActiveTab();
    if (!tab) return null;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        // 從 player 物件取得
        var player = document.getElementById('movie_player');
        if (player && player.getPlayerResponse) {
          try {
            var pr = player.getPlayerResponse();
            var tracks = pr && pr.captions
              && pr.captions.playerCaptionsTracklistRenderer
              && pr.captions.playerCaptionsTracklistRenderer.captionTracks;
            if (tracks && tracks.length > 0) {
              return tracks.map(function(t) {
                return {
                  baseUrl: (t.baseUrl || '').replace(/\\u0026/g, '&'),
                  languageCode: t.languageCode,
                  kind: t.kind || null,
                  name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || t.languageCode,
                };
              });
            }
          } catch (e) {}
        }

        // 從 ytInitialPlayerResponse 全域變數取得
        if (typeof ytInitialPlayerResponse !== 'undefined' && ytInitialPlayerResponse) {
          try {
            var tracks2 = ytInitialPlayerResponse.captions
              && ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer
              && ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
            if (tracks2 && tracks2.length > 0) {
              return tracks2.map(function(t) {
                return {
                  baseUrl: (t.baseUrl || '').replace(/\\u0026/g, '&'),
                  languageCode: t.languageCode,
                  kind: t.kind || null,
                  name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || t.languageCode,
                };
              });
            }
          } catch (e) {}
        }

        return null;
      },
    });

    return results?.[0]?.result || null;
  } catch (e) {
    return null;
  }
}

/**
 * 自動選擇最佳字幕軌
 */
function autoSelectTrack() {
  if (state.captions.length === 0) return;

  // 優先級：非 ASR > ASR；原始語言 > 英文 > 中文 > 第一個
  let best = null;

  // 非自動生成優先
  const manual = state.captions.filter((c) => c.kind !== 'asr');
  const auto = state.captions.filter((c) => c.kind === 'asr');

  // 嘗試選英文或第一個
  const pool = manual.length > 0 ? manual : auto;
  best = pool.find((c) => c.languageCode.startsWith('en'))
    || pool.find((c) => c.languageCode.startsWith('zh'))
    || pool[0];

  state.selectedTrack = best;
  fetchTranscript(best);
}

// ── 字幕擷取 ──────────────────────────────────────────

/**
 * 透過 Innertube ANDROID API 擷取逐字稿（主要方法）
 * MAIN world timedtext 被 YouTube 反爬擋住，ANDROID client 不受限制
 */
function fetchTranscriptAsync() {
  return new Promise((resolve) => {
    if (!state.videoId) {
      resolve([]);
      return;
    }

    showStatus('擷取逐字稿中...');

    chrome.runtime.sendMessage(
      { type: 'FETCH_CAPTIONS_INNERTUBE', videoId: state.videoId },
      (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          hideStatus();
          showError('逐字稿擷取失敗：' + (response?.error || chrome.runtime.lastError?.message || '未知錯誤'));
          resolve([]);
          return;
        }

        state.transcript = response.data;
        renderTranscript();
        hideStatus();
        resolve(response.data);
      }
    );
  });
}

async function fetchTranscript(track) {
  state.selectedTrack = track;
  await fetchTranscriptAsync();
}

// ── Whisper 語音辨識 fallback ────────────────────────

async function handleWhisperTranscribe() {
  if (!state.videoId) return;

  const asrUrl = state.settings.asrUrl || 'https://yt-transcribe.avision-gb10.org';
  const videoUrl = `https://www.youtube.com/watch?v=${state.videoId}`;

  try {
    // Step 1: 提交 job
    showStatus('提交轉錄請求...');
    const submitResp = await fetch(`${asrUrl}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: videoUrl }),
    });

    if (!submitResp.ok) {
      const err = await submitResp.text();
      hideStatus();
      showError('轉錄請求失敗：' + err.substring(0, 200));
      return;
    }

    const { job_id } = await submitResp.json();
    if (!job_id) {
      hideStatus();
      showError('伺服器沒有回傳 job_id');
      return;
    }

    // Step 2: 輪詢進度
    const result = await pollJobStatus(asrUrl, job_id);
    hideStatus();

    if (!result || result.status !== 'done' || !result.result) {
      showError('語音辨識失敗：' + (result?.message || '未知錯誤'));
      return;
    }

    const data = result.result;
    if (data.segments && data.segments.length > 0) {
      state.transcript = data.segments;
      state.captions = [{ languageCode: data.language || 'auto', name: 'MOSS-Transcribe', kind: 'asr' }];
      renderTranscript();
      switchTab('transcript');
      showStatus(`✅ 辨識完成：${data.segments.length} 段，${Math.round(data.duration || 0)}秒`);
      setTimeout(() => hideStatus(), 3000);
    } else {
      showError('語音辨識完成但沒有結果');
    }
  } catch (err) {
    hideStatus();
    showError('語音辨識失敗：' + err.message);
  }
}

/**
 * 輪詢 job 狀態直到 done/failed
 */
function pollJobStatus(asrUrl, jobId) {
  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        const resp = await fetch(`${asrUrl}/job/${jobId}`);
        if (!resp.ok) return;
        const data = await resp.json();

        if (data.status === 'done' || data.status === 'failed') {
          clearInterval(interval);
          resolve(data);
        } else {
          showStatus(`${data.message || '處理中...'} (${data.progress || 0}%)`);
        }
      } catch (e) {
        // 繼續重試
      }
    }, 3000); // 每 3 秒查一次
  });
}

// ── 摘要生成 ──────────────────────────────────────────

async function handleGenerateSummary() {
  // 如果還沒逐字稿，自動先抓
  if (state.transcript.length === 0 && state.selectedTrack) {
    await fetchTranscriptAsync();
  }

  if (state.transcript.length === 0) {
    showError('無法擷取逐字稿，請確認此影片有字幕');
    return;
  }

  if (!state.settings.apiKey) {
    showError('請先設定 API Key（點擊右上角 ⚙️）');
    openSettings();
    return;
  }

  showStatus('AI 摘要生成中，請稍候...');

  // 把逐字稿拼成文字
  const transcriptText = state.transcript
    .map((s) => `[${formatTimestamp(s.start)}] ${s.text}`)
    .join('\n');

  chrome.runtime.sendMessage(
    {
      type: 'GENERATE_SUMMARY',
      transcript: transcriptText,
      videoTitle: state.videoTitle,
      settings: state.settings,
    },
    (response) => {
      hideStatus();

      if (chrome.runtime.lastError || !response || !response.success) {
        showError('摘要生成失敗：' + (response?.error || '未知錯誤'));
        return;
      }

      state.summary = response.data.summary;
      renderSummary();
    }
  );
}

// ── UI 渲染 ───────────────────────────────────────────

function renderVideoInfo() {
  el.videoTitle.textContent = state.videoTitle;
  el.videoMeta.textContent = `${state.captions.length} 個字幕軌`;
  el.emptyState.classList.add('hidden');
  el.main.classList.remove('hidden');

  // 如果有多個字幕軌，顯示選擇器
  if (state.captions.length > 1) {
    el.captionLangSelect.innerHTML = state.captions
      .map(
        (c) =>
          `<option value="${c.languageCode}">${c.name} (${c.languageCode})${c.kind === 'asr' ? ' [自動]' : ''}</option>`
      )
      .join('');
    el.captionLangSelect.value = state.selectedTrack?.languageCode || '';
    el.captionLangSelect.classList.remove('hidden');
  }
}

function renderNoCaptions() {
  el.videoTitle.textContent = state.videoTitle;
  el.videoMeta.textContent = '此影片沒有字幕';
  el.emptyState.classList.add('hidden');
  el.main.classList.remove('hidden');

  // 替換摘要區為 Whisper fallback 按鈕
  el.summaryContent.innerHTML = `
    <p style="text-align:center; padding: 20px 0; color: var(--text-muted);">
      ⚠️ 此影片沒有 YouTube 字幕<br><br>
      <button id="btn-whisper" class="btn btn-primary" style="margin-top: 12px;">
        🎙️ 用 MOSS-Transcribe 語音辨識
      </button>
    </p>
  `;

  // 綁定 Whisper 按鈕
  const btnWhisper = document.getElementById('btn-whisper');
  if (btnWhisper) {
    btnWhisper.addEventListener('click', handleWhisperTranscribe);
  }

  el.transcriptContent.innerHTML = '<p class="placeholder">⚠️ 此影片沒有字幕，可用語音辨識生成</p>';
}

function renderSummary() {
  if (!state.summary) {
    el.summaryContent.innerHTML = '<p class="placeholder">點擊上方按鈕生成 AI 摘要</p>';
    return;
  }
  // 簡易 Markdown 渲染
  el.summaryContent.innerHTML = renderMarkdown(state.summary);
}

function renderTranscript() {
  if (state.transcript.length === 0) {
    el.transcriptContent.innerHTML = '<p class="placeholder">逐字稿將顯示於此</p>';
    return;
  }

  el.transcriptContent.innerHTML = state.transcript
    .map(
      (seg, i) =>
        `<div class="transcript-line" data-index="${i}" data-time="${seg.start}">
          <span class="transcript-time">${formatTimestamp(seg.start)}</span>
          <span class="transcript-text">${escapeHtml(seg.text)}</span>
        </div>`
    )
    .join('');

  // 綁定點擊跳轉
  el.transcriptContent.querySelectorAll('.transcript-line').forEach((line) => {
    line.addEventListener('click', () => {
      const time = parseFloat(line.dataset.time);
      seekVideo(time);
      // 標記 active
      el.transcriptContent.querySelectorAll('.transcript-line').forEach((l) => l.classList.remove('active'));
      line.classList.add('active');
    });
  });
}

function showEmptyState() {
  el.emptyState.classList.remove('hidden');
  el.main.classList.add('hidden');
}

// ── 逐字稿搜尋 ────────────────────────────────────────

function handleSearch(query) {
  const lines = el.transcriptContent.querySelectorAll('.transcript-line');
  lines.forEach((line) => {
    line.classList.remove('search-match');
    if (query && line.textContent.toLowerCase().includes(query.toLowerCase())) {
      line.classList.add('search-match');
      // 捲動到第一個匹配
    }
  });

  // 捲動到第一個匹配
  if (query) {
    const firstMatch = el.transcriptContent.querySelector('.search-match');
    if (firstMatch) firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ── 影片跳轉 ──────────────────────────────────────────

async function seekVideo(seconds) {
  const tab = await getActiveTab();
  if (!tab) return;

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sec) => {
      const video = document.querySelector('video');
      if (video) {
        video.currentTime = sec;
        video.play();
      }
    },
    args: [seconds],
  });
}

// ── 匯出 ──────────────────────────────────────────────

function handleExportSRT() {
  if (state.transcript.length === 0) return;
  chrome.runtime.sendMessage(
    { type: 'EXPORT_SRT', segments: state.transcript },
    (response) => {
      if (response?.success) downloadFile(`${state.videoTitle}.srt`, response.data, 'text/plain');
    }
  );
}

function handleExportVTT() {
  if (state.transcript.length === 0) return;
  chrome.runtime.sendMessage(
    { type: 'EXPORT_VTT', segments: state.transcript },
    (response) => {
      if (response?.success) downloadFile(`${state.videoTitle}.vtt`, response.data, 'text/plain');
    }
  );
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── 複製 ──────────────────────────────────────────────

async function copyToClipboard(text) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  // 也可以加 toast
}

// ── 分頁切換 ──────────────────────────────────────────

function switchTab(tabName) {
  state.activeTab = tabName;
  el.tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === tabName));
  el.tabSummary.classList.toggle('active', tabName === 'summary');
  el.tabTranscript.classList.toggle('active', tabName === 'transcript');
}

// ── 設定面板 ──────────────────────────────────────────

function openSettings() {
  el.settingsPanel.classList.remove('hidden');
}

function closeSettings() {
  el.settingsPanel.classList.add('hidden');
}

// ── 工具 ──────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * 簡易 Markdown 渲染（不依賴外部庫）
 */
function renderMarkdown(md) {
  let html = escapeHtml(md);

  // 標題
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h3>$1</h3>');

  // 粗體
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // 列表
  const lines = html.split('\n');
  let result = [];
  let inList = false;
  for (const line of lines) {
    if (line.match(/^- (.+)$/)) {
      if (!inList) { result.push('<ul>'); inList = true; }
      result.push(`<li>${line.replace(/^- /, '')}</li>`);
    } else {
      if (inList) { result.push('</ul>'); inList = false; }
      result.push(line);
    }
  }
  if (inList) result.push('</ul>');
  html = result.join('\n');

  // 段落
  html = html.replace(/\n\n/g, '</p><p>');
  html = `<p>${html}</p>`;
  html = html.replace(/<p><h3>/g, '<h3>').replace(/<\/h3><\/p>/g, '</h3>');
  html = html.replace(/<p><ul>/g, '<ul>').replace(/<\/ul><\/p>/g, '</ul>');

  return html;
}

// ── 事件綁定 ──────────────────────────────────────────

function bindEvents() {
  // 分頁切換
  el.tabs.forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // 摘要生成
  el.btnGenerate.addEventListener('click', handleGenerateSummary);

  // 搜尋
  el.searchInput.addEventListener('input', (e) => handleSearch(e.target.value));

  // 匯出
  el.btnExportSrt.addEventListener('click', handleExportSRT);
  el.btnExportVtt.addEventListener('click', handleExportVTT);

  // 複製
  el.btnCopySummary.addEventListener('click', () => copyToClipboard(state.summary));
  el.btnCopyTranscript.addEventListener('click', () =>
    copyToClipboard(state.transcript.map((s) => s.text).join('\n'))
  );

  // 字幕軌切換
  el.captionLangSelect.addEventListener('change', (e) => {
    const track = state.captions.find((c) => c.languageCode === e.target.value);
    if (track) {
      state.selectedTrack = track;
      fetchTranscript(track);
    }
  });

  // 設定面板
  el.btnSettings.addEventListener('click', openSettings);
  el.btnCloseSettings.addEventListener('click', closeSettings);
  el.btnSaveSettings.addEventListener('click', saveSettings);
  el.settingProvider.addEventListener('change', () => {
    toggleBaseUrlVisibility();
    updateModelPlaceholder();
  });
}

// ── 初始化 ────────────────────────────────────────────

async function init() {
  await loadSettings();
  bindEvents();
  loadPageInfo();

  // 監聽頁面變化
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'PAGE_CHANGED') {
      loadPageInfo();
    }
  });
}

init();
