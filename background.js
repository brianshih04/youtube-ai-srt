/**
 * Background Service Worker
 *
 * 職責：
 * 1. 開啟 Side Panel
 * 2. 從 YouTube timedtext API fetch 字幕
 * 3. 呼叫 LLM API 生成摘要（Gemini / OpenAI / DeepSeek）
 * 4. 處理 SRT / VTT 匯出
 */

// ── Side Panel 管理 ────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error('Side panel setup error:', e));
});

// ── 訊息路由 ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'FETCH_CAPTIONS':
      fetchTimedText(msg.baseUrl, msg.format)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'FETCH_CAPTIONS_INNERTUBE':
      fetchCaptionsViaInnertube(msg.videoId)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'PARSE_TRANSCRIPT':
      try {
        const rawText = msg.rawText || '';
        if (!rawText.trim()) {
          sendResponse({ success: false, error: '空內容' });
        } else {
          const data = parseTimedTextAuto(rawText);
          if (data.length === 0) {
            sendResponse({ success: false, error: '解析後無字幕' });
          } else {
            sendResponse({ success: true, data });
          }
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return false;

    case 'GENERATE_SUMMARY':
      generateSummary(msg.transcript, msg.videoTitle, msg.settings)
        .then((data) => sendResponse({ success: true, data }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'EXPORT_SRT':
      sendResponse({ success: true, data: toSRT(msg.segments) });
      return false;

    case 'EXPORT_VTT':
      sendResponse({ success: true, data: toVTT(msg.segments) });
      return false;
  }
});

// ── 字幕擷取 ──────────────────────────────────────────

/**
 * 透過 YouTube Innertube API（ANDROID client）取得字幕
 * ANDROID client 不受 timedtext 反爬限制
 */
async function fetchCaptionsViaInnertube(videoId) {
  // Step 1: 取得 INNERTUBE_API_KEY 和 client version
  const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const pageHtml = await pageResp.text();

  const keyMatch = pageHtml.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  const apiKey = keyMatch ? keyMatch[1] : 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

  // Step 2: 呼叫 Innertube player API（ANDROID client）
  const innertubeUrl = `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`;
  const payload = {
    context: {
      client: {
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
        androidSdkVersion: 30,
      },
    },
    videoId: videoId,
  };

  const resp = await fetch(innertubeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'com.google.android.youtube/20.10.38',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    throw new Error(`Innertube API error: HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!tracks || tracks.length === 0) {
    throw new Error('Innertube 回傳無字幕軌');
  }

  // 選最佳字幕軌
  const track = tracks.find((t) => t.languageCode?.startsWith('zh'))
    || tracks.find((t) => t.languageCode?.startsWith('en'))
    || tracks[0];

  const baseUrl = track.baseUrl.replace(/\\u0026/g, '&');

  // Step 3: fetch timedtext（ANDROID client 的 URL 不被擋）
  const formats = [
    baseUrl + '&fmt=json3',
    baseUrl + '&fmt=srv3',
    baseUrl,
  ];

  for (const url of formats) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'com.google.android.youtube/20.10.38' },
      });
      if (!r.ok) continue;
      const text = await r.text();
      if (text.trim()) {
        return parseTimedTextAuto(text);
      }
    } catch (e) {}
  }

  throw new Error('Innertube: 所有格式都回空');
}

/**
 * 自動偵測格式並解析（json3 / XML）
 */
function parseTimedTextAuto(text) {
  const trimmed = text.trim();

  // 嘗試 JSON（json3 格式）
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const json = JSON.parse(trimmed);
      const result = parseJson3(json);
      if (result.length > 0) return result;
    } catch (e) {
      // 不是 JSON，嘗試 XML
    }
  }

  // 嘗試 XML
  if (trimmed.startsWith('<') || trimmed.indexOf('<transcript') !== -1 || trimmed.indexOf('<text') !== -1) {
    return parseTimedTextXML(trimmed);
  }

  // 未知格式
  return [];
}

/**
 * 從 YouTube timedtext API 取得字幕
 * 回傳 [{ start, dur, text }] 陣列
 */
async function fetchTimedText(baseUrl, format = 'json3') {
  // 修正 YouTube baseUrl 裡的 unicode escape（\u0026 → &）
  const cleanUrl = baseUrl.replace(/\\u0026/g, '&');

  const url = new URL(cleanUrl);

  // 移除可能存在的 format 參數，再加回去
  url.searchParams.delete('fmt');
  if (format === 'json3') {
    url.searchParams.set('fmt', 'json3');
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  if (format === 'json3') {
    const text = await response.text();
    // YouTube 有時回空內容或非 JSON
    if (!text.trim()) {
      throw new Error('timedtext 回傳空內容');
    }
    try {
      const json = JSON.parse(text);
      return parseJson3(json);
    } catch (e) {
      // 可能是 XML 格式，嘗試 fallback
      return parseTimedTextXML(text);
    }
  } else {
    const xml = await response.text();
    return parseTimedTextXML(xml);
  }
}

/**
 * 解析 json3 格式的 YouTube 字幕
 */
function parseJson3(data) {
  const segments = [];
  const events = data.events || [];

  for (const ev of events) {
    if (!ev.segs) continue;
    const start = ev.tStartMs / 1000; // ms → s
    const dur = (ev.dDurationMs || 0) / 1000;
    const text = ev.segs.map((s) => s.utf8 || '').join('');

    if (text.trim()) {
      segments.push({ start, dur, text: text.trim() });
    }
  }

  return segments;
}

/**
 * 解析 XML 格式的 timedtext（fallback）
 * 注意：service worker 沒有 DOMParser，用 regex 解析
 */
function parseTimedTextXML(xmlText) {
  const segments = [];

  // 用 regex 解析 <text start="..." dur="...">...</text>
  const regex = /<text\s+([^>]*)>([\s\S]*?)<\/text>/g;
  let match;

  while ((match = regex.exec(xmlText)) !== null) {
    const attrs = match[1];
    const rawText = match[2];

    const startMatch = attrs.match(/start="([\d.]+)"/);
    const durMatch = attrs.match(/dur="([\d.]+)"/);

    const start = startMatch ? parseFloat(startMatch[1]) : 0;
    const dur = durMatch ? parseFloat(durMatch[1]) : 0;
    const text = decodeXmlEntities(rawText).trim();

    if (text) {
      segments.push({ start, dur, text });
    }
  }

  return segments;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

// ── LLM 摘要生成 ──────────────────────────────────────

const SYSTEM_PROMPT = 'You are a helpful assistant that summarizes video transcripts. Respond in the same language as the transcript.';

const LLM_PROVIDERS = {
  gemini: {
    type: 'gemini',
    url: (apiKey, model, baseUrl) =>
      `${baseUrl || 'https://generativelanguage.googleapis.com'}/v1beta/models/${model}:generateContent?key=${apiKey}`,
    buildRequest: (prompt, model) => ({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
    }),
    extractResponse: (data) =>
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '',
    defaultModel: 'gemini-2.5-flash',
  },
  openai: {
    type: 'openai',
    url: (apiKey, model, baseUrl) => `${baseUrl || 'https://api.openai.com'}/v1/chat/completions`,
    buildRequest: (prompt, model) => ({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    }),
    extractResponse: (data) => data?.choices?.[0]?.message?.content || '',
    defaultModel: 'gpt-4o-mini',
  },
  deepseek: {
    type: 'openai',
    url: (apiKey, model, baseUrl) => `${baseUrl || 'https://api.deepseek.com'}/chat/completions`,
    buildRequest: (prompt, model) => ({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    }),
    extractResponse: (data) => data?.choices?.[0]?.message?.content || '',
    defaultModel: 'deepseek-chat',
  },
  custom: {
    type: 'openai',
    url: (apiKey, model, baseUrl) => `${(baseUrl || '').replace(/\/+$/, '')}/v1/chat/completions`,
    buildRequest: (prompt, model) => ({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    }),
    extractResponse: (data) => data?.choices?.[0]?.message?.content || '',
    defaultModel: '',
  },
};

/**
 * 生成 AI 摘要
 */
async function generateSummary(transcript, videoTitle, settings) {
  const provider = settings.provider || 'gemini';
  const config = LLM_PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  const apiKey = settings.apiKey;
  if (!apiKey) throw new Error('API Key not set');

  const model = settings.model || config.defaultModel;
  const baseUrl = settings.baseUrl || '';
  const prompt = buildSummaryPrompt(transcript, videoTitle);

  // 分段處理（超長逐字稿）
  const maxChars = 50000; // ~12K tokens
  if (transcript.length > maxChars) {
    return await generateChunkedSummary(transcript, videoTitle, settings, config, model, apiKey);
  }

  const body = config.buildRequest(prompt, model);
  const url = config.url(apiKey, model, baseUrl);
  const isGemini = config.type === 'gemini';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(isGemini ? {} : { Authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API Error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const summaryText = config.extractResponse(data);

  return { summary: summaryText };
}

/**
 * 分段摘要（長影片用）
 */
async function generateChunkedSummary(transcript, videoTitle, settings, config, model, apiKey) {
  const baseUrl = settings.baseUrl || '';
  const isGemini = config.type === 'gemini';
  const chunks = chunkTranscript(transcript, 40000);
  const partialSummaries = [];

  for (let i = 0; i < chunks.length; i++) {
    const prompt = buildChunkPrompt(chunks[i], videoTitle, i + 1, chunks.length);
    const body = config.buildRequest(prompt, model);
    const url = config.url(apiKey, model, baseUrl);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(isGemini ? {} : { Authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`LLM API Error on chunk ${i + 1}: ${response.status}`);
    const data = await response.json();
    partialSummaries.push(config.extractResponse(data));
  }

  // 最終彙整
  const mergePrompt = buildMergePrompt(partialSummaries, videoTitle);
  const body = config.buildRequest(mergePrompt, model);
  const url = config.url(apiKey, model, baseUrl);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(isGemini ? {} : { Authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`LLM merge error: ${response.status}`);
  const data = await response.json();

  return { summary: config.extractResponse(data) };
}

function chunkTranscript(transcript, maxChars) {
  const chunks = [];
  let current = '';
  for (const line of transcript.split('\n')) {
    if ((current + line).length > maxChars) {
      if (current) chunks.push(current);
      current = line + '\n';
    } else {
      current += line + '\n';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ── Prompt 構建 ───────────────────────────────────────

function buildSummaryPrompt(transcript, title) {
  return `你是一個專業的影片摘要助手。請根據以下影片逐字稿，生成結構化的摘要。

## 影片標題
${title}

## 逐字稿
${transcript}

## 輸出格式（使用 Markdown）
### 一句話總結
（用一句話概括影片核心內容）

### 重點整理
- **重點 1** [時間戳]
- **重點 2** [時間戳]
- **重點 3** [時間戳]
（列出 3-7 個重點，附上近似時間戳）

### 章節分段
1. **章節名稱** [開始時間 - 結束時間]
   簡短說明
2. ...

請用與逐字稿相同的語言回覆。`;
}

function buildChunkPrompt(chunk, title, partNum, totalParts) {
  return `你是一個影片摘要助手。這是影片「${title}」逐字稿的第 ${partNum}/${totalParts} 部分。

請摘要此部分的重點：

${chunk}

用 Markdown 條列重點，保留時間戳。用相同語言回覆。`;
}

function buildMergePrompt(partialSummaries, title) {
  return `以下是影片「${title}」分段摘要的各部分。請彙整成一份完整的結構化摘要。

${partialSummaries.map((s, i) => `### 第 ${i + 1} 部分摘要\n${s}`).join('\n\n---\n\n')}

## 輸出格式（使用 Markdown）
### 一句話總結
### 重點整理（含時間戳）
### 章節分段（含時間範圍）

用相同語言回覆。`;
}

// ── SRT / VTT 匯出 ────────────────────────────────────

function formatTime(seconds, format) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);

  if (format === 'srt') {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  } else {
    // VTT
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }
}

function toSRT(segments) {
  return segments
    .map((seg, i) => {
      const end = seg.start + seg.dur;
      return `${i + 1}\n${formatTime(seg.start, 'srt')} --> ${formatTime(end, 'srt')}\n${seg.text}\n`;
    })
    .join('\n');
}

function toVTT(segments) {
  const body = segments
    .map((seg) => {
      const end = seg.start + seg.dur;
      return `${formatTime(seg.start, 'vtt')} --> ${formatTime(end, 'vtt')}\n${seg.text}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}
