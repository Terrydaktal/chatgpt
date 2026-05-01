const { app, BrowserWindow, ipcMain, protocol, net, session, clipboard, nativeImage } = require('electron');
const path = require('path');
const ChatGPTAuth = require('./auth.cjs');
const ChatDatabase = require('./database.cjs');

const isDev = process.env.NODE_ENV === 'development';

let mainWindow;
let auth;
let db;
let bridgeWindow = null;
let appUserAgent = null;

const shouldShowBridgeWindow = () => isDev || process.env.CHATGPT_BRIDGE_VISIBLE === '1';

function extractFileId(value) {
  if (!value) return null;
  const raw = String(value);
  const directMatch = raw.match(/file[_-][A-Za-z0-9_-]+/);
  if (directMatch) return directMatch[0];

  try {
    const parsed = new URL(raw);
    const candidate = `${parsed.host}${parsed.pathname}`.replace(/^\/+/, '');
    const parsedMatch = candidate.match(/file[_-][A-Za-z0-9_-]+/);
    if (parsedMatch) return parsedMatch[0];
  } catch {
    // Ignore parse failures and fall through.
  }

  return null;
}

async function fetchImageResponse(fileId, conversationId) {
  const encodedFileId = encodeURIComponent(fileId);
  const candidates = [];
  if (conversationId) {
    candidates.push(`https://chatgpt.com/backend-api/files/download/${encodedFileId}?conversation_id=${encodeURIComponent(conversationId)}&inline=false`);
  }
  candidates.push(`https://chatgpt.com/backend-api/files/download/${encodedFileId}`);

  for (const url of candidates) {
    try {
      const metaResponse = await auth.fetchWithAuth(url, {
        headers: { Accept: 'application/json, text/plain, */*' },
      });

      if (!metaResponse.ok) {
        const errorText = await metaResponse.text().catch(() => '');
        console.error(`Image meta fetch failed (${metaResponse.status}) for ${fileId} via ${url}:`, errorText.slice(0, 300));
        continue;
      }

      const meta = await metaResponse.json().catch(() => null);
      const downloadUrl = meta && typeof meta.download_url === 'string' ? meta.download_url : null;
      if (!downloadUrl) continue;

      const fileResponse = await session.defaultSession.fetch(downloadUrl, {
        headers: { Accept: 'image/*,*/*;q=0.8' },
      });
      if (fileResponse.ok) return fileResponse;

      const downloadError = await fileResponse.text().catch(() => '');
      console.error(`Image download URL fetch failed (${fileResponse.status}) for ${fileId}:`, downloadError.slice(0, 300));
    } catch (error) {
      console.error(`Image download URL resolution failed for ${fileId}:`, error);
    }
  }

  // Legacy fallback.
  return auth.fetchWithAuth(`https://chatgpt.com/backend-api/files/${encodedFileId}/download`, {
    headers: { Accept: 'image/*,*/*;q=0.8' },
  });
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i);
  if (!match) return null;
  const mime = match[1] || 'image/png';
  const isBase64 = !!match[2];
  const payload = match[3] || '';
  try {
    const buffer = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    return { mime, buffer };
  } catch {
    return null;
  }
}

function getNormalizedSessionUserAgent() {
  const base = session.defaultSession.getUserAgent();
  return base.replace(/\sElectron\/[^\s]+/i, '').trim();
}

function ensureAppUserAgent() {
  if (!appUserAgent) appUserAgent = getNormalizedSessionUserAgent();
  return appUserAgent;
}

function normalizeChatgptUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return String(value || '').replace(/\/+$/, '');
  }
}

async function ensureBridgeWindow() {
  if (bridgeWindow && !bridgeWindow.isDestroyed()) {
    return bridgeWindow;
  }

  bridgeWindow = new BrowserWindow({
    show: shouldShowBridgeWindow(),
    width: 1200,
    height: 900,
    title: 'ChatGPT Web Bridge',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  bridgeWindow.webContents.setUserAgent(ensureAppUserAgent());

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Bridge window load timeout')), 30000);
    bridgeWindow.webContents.once('did-finish-load', () => {
      clearTimeout(timeout);
      resolve();
    });
    bridgeWindow.webContents.once('did-fail-load', (_event, code, desc) => {
      clearTimeout(timeout);
      reject(new Error(`Bridge window failed to load (${code}): ${desc}`));
    });
    bridgeWindow.loadURL('https://chatgpt.com/').catch(reject);
  });

  bridgeWindow.on('closed', () => {
    bridgeWindow = null;
  });
  return bridgeWindow;
}

async function navigateBridgeTo(url) {
  const win = await ensureBridgeWindow();
  const currentUrl = win.webContents.getURL();
  if (currentUrl && normalizeChatgptUrl(currentUrl) === normalizeChatgptUrl(url)) {
    return win;
  }
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Bridge navigation timeout')), 30000);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timeout);
      resolve();
    });
    win.webContents.once('did-fail-load', (_event, code, desc) => {
      clearTimeout(timeout);
      reject(new Error(`Bridge navigation failed (${code}): ${desc}`));
    });
    win.loadURL(url).catch(reject);
  });
  return win;
}

async function waitForBridgeComposer(win, conversationId) {
  const expectedPath = conversationId ? `/c/${conversationId}` : '/';
  const deadline = Date.now() + 30000;
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = await win.webContents.executeJavaScript(
      `
        (() => {
          const composer =
            document.querySelector('#prompt-textarea[contenteditable="true"]') ||
            document.querySelector('textarea#prompt-textarea') ||
            document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
            document.querySelector('textarea[placeholder*="ask" i], textarea[placeholder*="message" i]');
          const sendBtn =
            document.querySelector('#composer-submit-button') ||
            document.querySelector('button[data-testid="send-button"]') ||
            document.querySelector('button[aria-label="Send prompt"]') ||
            document.querySelector('button[aria-label*="Send"]');
          return {
            href: location.href,
            path: location.pathname,
            readyState: document.readyState,
            composerFound: !!composer,
            sendButtonFound: !!sendBtn,
          };
        })();
      `,
      true
    );

    const pathOk = conversationId ? lastState?.path === expectedPath : lastState?.path === '/';
    if (pathOk && lastState?.composerFound) {
      await sleep(350);
      return lastState;
    }
    await sleep(100);
  }

  throw new Error(`Bridge did not settle on ${expectedPath}: ${JSON.stringify(lastState)}`);
}

async function sendConversationViaUiAutomation({ conversationId, content }) {
  const targetUrl = conversationId
    ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`
    : 'https://chatgpt.com/';
  const win = await navigateBridgeTo(targetUrl);
  const prompt = String(content || '');
  if (shouldShowBridgeWindow()) {
    win.show();
    win.focus();
  }
  win.webContents.focus();
  const settledState = await waitForBridgeComposer(win, conversationId);
  const setup = await win.webContents.executeJavaScript(
    `
      (() => {
        const getComposer = () =>
          document.querySelector('#prompt-textarea[contenteditable="true"]') ||
          document.querySelector('textarea#prompt-textarea') ||
          document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
          document.querySelector('textarea[placeholder*="ask" i], textarea[placeholder*="message" i]');

        const composer = getComposer();
        if (!composer) return { ok: false, reason: 'Composer not found' };

        if (!window.__codexOriginalFetch) {
          window.__codexOriginalFetch = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const input = args[0];
            const init = args[1] || {};
            const url = String(typeof input === 'string' ? input : (input && input.url) || '');
            const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
            const isConversationPost = method === 'POST' && url.includes('/backend-api/conversation');
            const bodyStr = typeof init.body === 'string' ? init.body : '';
            try {
              const response = await window.__codexOriginalFetch(...args);
              if (isConversationPost) {
                let responseText = '';
                try {
                  responseText = await response.clone().text();
                } catch {}
                window.__codexSendEvents.push({
                  time: Date.now(),
                  ok: response.ok,
                  status: response.status,
                  statusText: response.statusText,
                  body: String(responseText || '').slice(0, 1000),
                  requestBody: bodyStr.slice(0, 1000),
                });
              }
              return response;
            } catch (error) {
              if (isConversationPost) {
                window.__codexSendEvents.push({
                  time: Date.now(),
                  ok: false,
                  status: 0,
                  statusText: 'fetch_throw',
                  body: String(error && error.message ? error.message : error || ''),
                  requestBody: bodyStr.slice(0, 1000),
                });
              }
              throw error;
            }
          };
        }
        if (!Array.isArray(window.__codexSendEvents)) window.__codexSendEvents = [];
        const startEventCount = window.__codexSendEvents.length;

        composer.focus();
        if ((composer.tagName || '').toUpperCase() === 'TEXTAREA') {
          composer.value = '';
          composer.dispatchEvent(new Event('input', { bubbles: true }));
          composer.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(composer);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('delete');
          } catch {}
          composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        }
        const sendBtn =
          document.querySelector('#composer-submit-button') ||
          document.querySelector('button[data-testid="send-button"]') ||
          document.querySelector('button[aria-label="Send prompt"]') ||
          document.querySelector('button[aria-label*="Send"]');
        return {
          ok: true,
          startEventCount,
          settledState: ${JSON.stringify(null)},
          url: location.href,
          composerTag: composer.tagName,
          composerClass: composer.className,
          composerText: (composer.value || composer.textContent || '').slice(0, 200),
          activeTag: document.activeElement ? document.activeElement.tagName : '',
          activeId: document.activeElement ? document.activeElement.id : '',
          sendButtonFound: !!sendBtn,
          sendButtonDisabled: sendBtn ? !!sendBtn.disabled : null,
          sendButtonAriaDisabled: sendBtn ? sendBtn.getAttribute('aria-disabled') : null,
        };
      })();
    `,
    true
  );

  if (!setup?.ok) {
    return { ok: false, status: 0, statusText: 'ui_send_failed', bodyText: String(setup?.reason || 'Composer setup failed') };
  }

  await win.webContents.insertText(prompt);
  await sleep(120);

  const afterInsert = await win.webContents.executeJavaScript(
    `
      (() => {
        const composer =
          document.querySelector('#prompt-textarea[contenteditable="true"]') ||
          document.querySelector('textarea#prompt-textarea') ||
          document.querySelector('div[contenteditable="true"][id="prompt-textarea"]');
        const sendBtn =
          document.querySelector('#composer-submit-button') ||
          document.querySelector('button[data-testid="send-button"]') ||
          document.querySelector('button[aria-label="Send prompt"]') ||
          document.querySelector('button[aria-label*="Send"]');
        return {
          url: location.href,
          composerFound: !!composer,
          composerTag: composer ? composer.tagName : '',
          composerText: composer ? String(composer.value || composer.textContent || '').slice(0, 200) : '',
          composerHtml: composer ? String(composer.innerHTML || '').slice(0, 300) : '',
          activeTag: document.activeElement ? document.activeElement.tagName : '',
          activeId: document.activeElement ? document.activeElement.id : '',
          sendButtonFound: !!sendBtn,
          sendButtonDisabled: sendBtn ? !!sendBtn.disabled : null,
          sendButtonAriaDisabled: sendBtn ? sendBtn.getAttribute('aria-disabled') : null,
        };
      })();
    `,
    true
  );
  console.info('UI send composer state', {
    settledState,
    setup,
    afterInsert,
    promptPreview: prompt.slice(0, 120),
  });

  const clickResult = await win.webContents.executeJavaScript(
    `
      (() => {
        const sendBtn =
          document.querySelector('#composer-submit-button') ||
          document.querySelector('button[data-testid="send-button"]') ||
          document.querySelector('button[aria-label="Send prompt"]') ||
          document.querySelector('button[aria-label*="Send"]');
        if (!sendBtn) return { ok: false, reason: 'Send button not found' };
        if (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true') {
          return {
            ok: false,
            reason: 'Send button disabled',
            disabled: !!sendBtn.disabled,
            ariaDisabled: sendBtn.getAttribute('aria-disabled'),
          };
        }
        sendBtn.click();
        return {
          ok: true,
          disabled: !!sendBtn.disabled,
          ariaDisabled: sendBtn.getAttribute('aria-disabled'),
        };
      })();
    `,
    true
  );

  if (!clickResult?.ok) {
    return { ok: false, status: 0, statusText: 'ui_send_failed', bodyText: String(clickResult?.reason || 'Could not click send') };
  }

  const promptMarker = prompt.trim().slice(0, 80);
  const startEventCount = Number(setup.startEventCount || 0);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const eventEnvelope = await win.webContents.executeJavaScript(
      `
        (() => {
          const events = Array.isArray(window.__codexSendEvents) ? window.__codexSendEvents : [];
          if (events.length <= ${startEventCount}) return null;
          const fresh = events.slice(${startEventCount});
          const marker = ${JSON.stringify(promptMarker)};
          const found = [...fresh].reverse().find((e) => {
            if (!e || typeof e !== 'object') return false;
            const body = String(e.requestBody || '');
            const looksLikeSend = body.includes('"action":"next"') || body.includes('"action": "next"');
            const hasMarker = !marker || body.includes(marker);
            return looksLikeSend && hasMarker;
          });
          return {
            matched: found || null,
            latest: fresh[fresh.length - 1] || null,
            totalFresh: fresh.length,
          };
        })();
      `,
      true
    );

    if (eventEnvelope && (eventEnvelope.matched || eventEnvelope.latest)) {
      const event = eventEnvelope.matched || eventEnvelope.latest;
      const currentUrl = win.webContents.getURL();
      console.info('UI send observed conversation request', {
        url: currentUrl,
        matched: !!eventEnvelope.matched,
        totalFresh: eventEnvelope.totalFresh,
        status: Number(event?.status || 0),
        ok: !!event?.ok,
        requestBodyPreview: String(event?.requestBody || '').slice(0, 200),
        responsePreview: String(event?.body || '').slice(0, 200),
      });
      return {
        ok: !!eventEnvelope.matched && !!event.ok,
        status: Number(event.status || 0),
        statusText: String(event.statusText || (eventEnvelope.matched ? 'ui_sent' : 'ui_unmatched_request')),
        bodyText: String(event.body || ''),
      };
    }
    await sleep(100);
  }

  return { ok: false, status: 0, statusText: 'ui_send_failed', bodyText: 'No conversation request observed after send action' };
}

async function sendConversationViaBridge(payload) {
  const win = await ensureBridgeWindow();
  const payloadJson = JSON.stringify(payload);
  const script = `
    (async () => {
      try {
        const response = await fetch('/backend-api/conversation', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json'
          },
          body: ${JSON.stringify(payloadJson)}
        });
        const bodyText = await response.text();
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          bodyText
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          statusText: 'bridge_fetch_failed',
          bodyText: String(error && error.message ? error.message : error || '')
        };
      }
    })();
  `;
  return await win.webContents.executeJavaScript(script, true);
}

async function createUploadSlot(fileName, fileSize) {
  const response = await auth.fetchWithAuth('https://chatgpt.com/backend-api/files', {
    method: 'POST',
    body: JSON.stringify({
      file_name: fileName,
      file_size: fileSize,
      use_case: 'multimodal',
      timezone_offset_min: new Date().getTimezoneOffset(),
      reset_rate_limits: false,
    }),
    headers: {
      Accept: 'application/json, text/plain, */*',
    },
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`File slot create failed (${response.status}): ${errorText.slice(0, 300)}`);
  }
  const payload = await response.json();
  if (!payload?.file_id || !payload?.upload_url) {
    throw new Error('File slot response missing file_id/upload_url');
  }
  return payload;
}

async function uploadToSignedUrl(uploadUrl, buffer, mimeType = 'application/octet-stream') {
  const response = await session.defaultSession.fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-version': '2020-04-08',
      Accept: '*/*',
    },
    body: buffer,
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Signed upload failed (${response.status}): ${errorText.slice(0, 300)}`);
  }
}

async function finalizeUploadedFile(fileId) {
  const response = await auth.fetchWithAuth(`https://chatgpt.com/backend-api/files/${encodeURIComponent(fileId)}/uploaded`, {
    method: 'POST',
    body: JSON.stringify({}),
    headers: {
      Accept: 'application/json, text/plain, */*',
    },
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`File finalize failed (${response.status}): ${errorText.slice(0, 300)}`);
  }
}

async function uploadAttachment(attachment) {
  if (!attachment?.dataUrl || typeof attachment.dataUrl !== 'string') {
    throw new Error('Attachment is missing data URL');
  }
  const parsed = parseDataUrl(attachment.dataUrl);
  if (!parsed) throw new Error('Invalid attachment data URL');

  const mimeType = attachment.mimeType || parsed.mime || 'application/octet-stream';
  const fileName = attachment.name || `upload-${Date.now()}`;
  const sizeBytes = parsed.buffer.length;

  const slot = await createUploadSlot(fileName, sizeBytes);
  await uploadToSignedUrl(slot.upload_url, parsed.buffer, mimeType);
  await finalizeUploadedFile(slot.file_id);

  let width = undefined;
  let height = undefined;
  if (mimeType.startsWith('image/')) {
    const image = nativeImage.createFromBuffer(parsed.buffer);
    if (!image.isEmpty()) {
      const size = image.getSize();
      width = size.width;
      height = size.height;
    }
  }

  return {
    fileId: slot.file_id,
    mimeType,
    name: fileName,
    sizeBytes,
    width,
    height,
    isImage: mimeType.startsWith('image/'),
  };
}

function parseBackendErrorDetail(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  const text = rawText.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.detail === 'string' && parsed.detail.trim()) {
      return parsed.detail.trim();
    }
    if (parsed && typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Not JSON, fall back to plain text handling.
  }
  return text.slice(0, 500);
}

function renderMessageContent(message, conversationId) {
  const parts = Array.isArray(message?.content?.parts) ? message.content.parts : [];
  const lines = [];

  for (const p of parts) {
    if (typeof p === 'string') {
      lines.push(p);
      continue;
    }
    if (!p || typeof p !== 'object') continue;

    if (p.content_type === 'image_asset_pointer' || p.content_type === 'image' || p.asset_pointer) {
      const rawPointer = p.asset_pointer || p.file_id || '';
      const fileId = extractFileId(rawPointer);
      if (fileId) {
        lines.push(`\n![Chat Image](chatgpt-image://${fileId}?conversation_id=${encodeURIComponent(conversationId)})\n`);
      }
      continue;
    }

    if (typeof p.text === 'string' && p.text.trim()) {
      lines.push(p.text);
      continue;
    }
    if (typeof p.markdown === 'string' && p.markdown.trim()) {
      lines.push(p.markdown);
      continue;
    }
    if (typeof p.content === 'string' && p.content.trim()) {
      lines.push(p.content);
    }
  }

  return lines.join('\n');
}

const METADATA_KEY_WHITELIST = new Set([
  // Citation/source resolution
  'content_references',
  'citations',
  'search_result_groups',
  'search_queries',
  'image_results',
  'search_model_queries',
  'safe_urls',
  // Thinking / hidden-UI state
  'reasoning_status',
  'reasoning_start_time',
  'reasoning_end_time',
  'reasoning_title',
  'is_thinking_preamble_message',
  'skip_reasoning_title',
  'finished_duration_sec',
  'is_visually_hidden_from_conversation',
  // Tool/runtime result details
  'aggregate_result',
  'classifier_response',
  // Thread/completion shape
  'parent_id',
  'message_type',
  'finish_details',
  'is_complete',
]);

const CONTENT_REFERENCE_KEY_WHITELIST = new Set([
  'matched_text',
  'safe_urls',
  'refs',
  'alt',
  'start_idx',
  'end_idx',
  'type',
  'prefix',
  'render_as',
  'prompt_text',
  'sources',
  'items',
]);

function sanitizeContentReferences(value) {
  if (!Array.isArray(value)) return [];
  const output = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const ref = {};
    for (const key of CONTENT_REFERENCE_KEY_WHITELIST) {
      if (!(key in item)) continue;
      const entry = item[key];
      if (key === 'safe_urls' || key === 'refs') {
        if (Array.isArray(entry)) {
          const cleaned = entry.filter((v) => typeof v === 'string').map((v) => String(v).trim()).filter(Boolean);
          if (cleaned.length > 0) ref[key] = cleaned;
        }
        continue;
      }
      if (entry !== undefined && entry !== null && entry !== '') {
        ref[key] = entry;
      }
    }
    if (Object.keys(ref).length > 0) output.push(ref);
  }
  return output;
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const output = {};

  for (const key of METADATA_KEY_WHITELIST) {
    if (!(key in metadata)) continue;
    const value = metadata[key];

    if (key === 'content_references') {
      const refs = sanitizeContentReferences(value);
      if (refs.length > 0) output[key] = refs;
      continue;
    }

    if (key === 'citations' || key === 'search_queries' || key === 'image_results' || key === 'safe_urls') {
      if (Array.isArray(value)) output[key] = value;
      continue;
    }

    if (value !== undefined && value !== null && value !== '') {
      output[key] = value;
    }
  }

  if (Object.keys(output).length === 0) return null;
  try {
    return JSON.stringify(output);
  } catch {
    return null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Register custom protocol for images
  // This allows us to fetch images in the main process with full auth
  protocol.handle('chatgpt-image', async (request) => {
    let requestPath = request.url;
    try {
      const parsed = new URL(request.url);
      requestPath = `${parsed.host}${parsed.pathname}`.replace(/^\/+/, '');
    } catch {
      requestPath = request.url.replace('chatgpt-image://', '').replace(/^\/+/, '');
    }

    const fileId = extractFileId(requestPath) || requestPath;
    if (!fileId) {
      return new Response('Missing image id', { status: 400 });
    }

    try {
      // Use the internal fetch with full session/auth
      const parsed = new URL(request.url);
      const conversationId = parsed.searchParams.get('conversation_id');
      const response = await fetchImageResponse(fileId, conversationId || undefined);
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(`Image fetch failed (${response.status}) for ${fileId}:`, errorText.slice(0, 300));
        return new Response(errorText || 'Failed to load image', { status: response.status });
      }

      // Materialize bytes in main process to avoid renderer stream/protocol edge cases.
      const body = await response.arrayBuffer();

      // Strip restrictive headers that can block image embedding from custom protocols.
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.delete('content-security-policy');
      headers.delete('content-disposition'); // Prevents it from being treated as a download attachment
      headers.delete('x-frame-options');
      headers.delete('cross-origin-resource-policy');
      headers.delete('cross-origin-opener-policy');
      headers.delete('cross-origin-embedder-policy');
      headers.delete('permissions-policy');

      if (!headers.get('content-type')) {
        headers.set('content-type', 'image/png');
      }

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
      });
    } catch (e) {
      console.error('Failed to fetch image via protocol:', e);
      return new Response('Failed to load image', { status: 500 });
    }
  });

  // Use Electron's Chromium UA, but drop the Electron token to reduce fingerprint mismatch.
  const normalizedUA = ensureAppUserAgent();
  mainWindow.webContents.setUserAgent(normalizedUA);
  session.defaultSession.setUserAgent(normalizedUA, 'en-GB,en-US;q=0.9,en;q=0.8');

  auth.mainWindow = mainWindow;

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

function getLinearMessages(conversationId) {
  const conv = db.getConversation(conversationId);
  
  if (!conv || !conv.current_node_id) {
    return db.getMessages(conversationId);
  }

  const path = db.getLinearPath(conv.current_node_id);
  return path;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withJitter(ms, jitterRatio = 0.25) {
  const jitter = ms * jitterRatio;
  const delta = (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(ms + delta));
}

function parseRetryAfterMs(retryAfterHeader) {
  if (!retryAfterHeader) return null;
  const numeric = Number(retryAfterHeader);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return Math.round(numeric * 1000);
  }
  const dateMs = Date.parse(retryAfterHeader);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

function setupIpc() {
  ipcMain.handle('auth:login', async () => {
    return await auth.login();
  });

  ipcMain.handle('auth:check', async () => {
    const token = await auth.getAccessToken();
    return !!token;
  });

  ipcMain.handle('auth:reauth', async () => {
    return await auth.reauthenticate({ hardReset: true });
  });

  ipcMain.handle('db:getConversations', async () => {
    return db.getConversations();
  });

  ipcMain.handle('db:deleteConversation', async (event, id) => {
    return db.deleteConversation(id);
  });

  ipcMain.handle('db:getStats', async () => {
    const localCount = db.getConversations().length;
    const cachedCount = db.db.prepare('SELECT COUNT(DISTINCT conversation_id) as count FROM messages').get().count;
    return { localCount, cachedCount };
  });

  ipcMain.handle('db:getCacheDiagnostics', async () => {
    return db.getCacheDiagnostics(100);
  });

  async function cacheConversation(conv, { maxRetries = 5, baseBackoffMs = 2500 } = {}) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await auth.fetchWithAuth(`https://chatgpt.com/backend-api/conversation/${conv.id}`);

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          db.upsertCacheFailure(conv.id, errorText || `HTTP ${response.status}`, response.status);

          const isRetriable = response.status === 429 || response.status === 408 || response.status === 425 || (response.status >= 500 && response.status <= 504);
          if (!isRetriable || attempt === maxRetries - 1) {
            return { success: false, status: response.status };
          }

          const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
          const backoffMs = retryAfterMs ?? withJitter(baseBackoffMs * (2 ** attempt));
          await sleep(backoffMs);
          continue;
        }

        const data = await response.json();
        if (!data.mapping) {
          db.upsertCacheFailure(conv.id, 'Conversation has no mapping payload', response.status);
          return { success: false, status: response.status };
        }

        let wroteAnyMessage = false;
        db.db.transaction(() => {
          db.upsertConversation({ ...conv, current_node_id: data.current_node });

          Object.values(data.mapping).forEach(node => {
            if (node.message) {
              wroteAnyMessage = true;
              const content = renderMessageContent(node.message, conv.id);
              
              db.upsertMessage({
                id: node.message.id,
                conversation_id: conv.id,
                role: node.message.author?.role || 'assistant',
                content: content || '',
                metadata_json: sanitizeMetadata(node.message.metadata),
                created_at: node.message.create_time || 0,
                parent_id: node.parent
              });
            }
          });
        })();

        if (wroteAnyMessage) {
          db.clearCacheFailure(conv.id);
          return { success: true };
        }

        db.upsertCacheFailure(conv.id, 'No cacheable message nodes in mapping', 200);
        return { success: false, status: 200 };
      } catch (e) {
        db.upsertCacheFailure(conv.id, String(e?.message || e), null);
        if (attempt === maxRetries - 1) {
          return { success: false, status: null };
        }
        await sleep(withJitter(baseBackoffMs * (2 ** attempt)));
      }
    }

    return { success: false, status: null };
  }

  async function cacheConversations(event, convs) {
    let processed = 0;
    let failed = 0;
    
    for (const conv of convs) {
      const existing = db.db.prepare('SELECT id FROM messages WHERE conversation_id = ? LIMIT 1').get(conv.id);
      const hasMetadata = db.db
        .prepare('SELECT id FROM messages WHERE conversation_id = ? AND metadata_json IS NOT NULL LIMIT 1')
        .get(conv.id);

      if ((!existing || !hasMetadata) && !conv.is_deleted_on_web) {
        const result = await cacheConversation(conv);
        if (result.success) {
          processed++;
          event.sender.send('api:cacheProgress', { current: processed, id: conv.id });
        } else {
          failed++;
        }

        // Add pacing to reduce rate-limit bursts.
        await sleep(withJitter(1200, 0.35));
      }
    }

    return { success: true, processed, failed };
  }

  ipcMain.handle('api:cacheAll', async (event) => {
    const convs = db.getConversations();
    return cacheConversations(event, convs);
  });

  ipcMain.handle('api:cacheFailed', async (event) => {
    const diagnostics = db.getCacheDiagnostics(5000);
    const failedIds = new Set(
      (diagnostics.rows || [])
        .filter(row => row.last_error)
        .map(row => row.id)
    );
    const convs = db.getConversations().filter(conv => failedIds.has(conv.id));
    return cacheConversations(event, convs);
  });

  ipcMain.handle('db:getMessages', async (event, conversationId) => {
    return getLinearMessages(conversationId);
  });

  ipcMain.handle('db:searchMessages', async (event, query) => {
    return db.searchMessages(query);
  });

  ipcMain.handle('api:getImageDataUrl', async (event, payload) => {
    try {
      const rawImageId = typeof payload === 'string' ? payload : payload?.rawImageId;
      const conversationId = typeof payload === 'string' ? undefined : payload?.conversationId;
      const fileId = extractFileId(rawImageId) || String(rawImageId || '').replace(/^\/+/, '');
      if (!fileId) return null;

      const response = await fetchImageResponse(fileId, conversationId);
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error(`Fallback image fetch failed (${response.status}) for ${fileId}:`, errorText.slice(0, 300));
        return null;
      }

      const contentType = response.headers.get('content-type') || 'image/png';
      const body = Buffer.from(await response.arrayBuffer());
      return `data:${contentType};base64,${body.toString('base64')}`;
    } catch (error) {
      console.error('Fallback image fetch errored:', error);
      return null;
    }
  });

  ipcMain.handle('api:copyImageToClipboard', async (event, payload) => {
    try {
      const source = typeof payload === 'string' ? payload : payload?.src;
      const conversationId = typeof payload === 'string' ? undefined : payload?.conversationId;
      if (!source || typeof source !== 'string') return { success: false, error: 'Invalid image source' };

      let image = null;

      if (source.startsWith('data:image/')) {
        const parsed = parseDataUrl(source);
        if (!parsed) return { success: false, error: 'Invalid data URL' };
        image = nativeImage.createFromBuffer(parsed.buffer);
      } else if (source.startsWith('chatgpt-image://')) {
        let requestPath = source;
        let srcConversationId = conversationId;
        try {
          const parsedUrl = new URL(source);
          requestPath = `${parsedUrl.host}${parsedUrl.pathname}`.replace(/^\/+/, '');
          if (!srcConversationId) srcConversationId = parsedUrl.searchParams.get('conversation_id') || undefined;
        } catch {
          requestPath = source.replace('chatgpt-image://', '').replace(/^\/+/, '');
        }

        const fileId = extractFileId(requestPath) || requestPath;
        if (!fileId) return { success: false, error: 'Missing file id' };

        const response = await fetchImageResponse(fileId, srcConversationId);
        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          return { success: false, error: `Image fetch failed (${response.status}) ${errorText.slice(0, 200)}` };
        }

        const body = Buffer.from(await response.arrayBuffer());
        image = nativeImage.createFromBuffer(body);
      } else {
        const response = await session.defaultSession.fetch(source, { headers: { Accept: 'image/*,*/*;q=0.8' } });
        if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
        const body = Buffer.from(await response.arrayBuffer());
        image = nativeImage.createFromBuffer(body);
      }

      if (!image || image.isEmpty()) return { success: false, error: 'Could not decode image' };
      clipboard.writeImage(image);
      return { success: true };
    } catch (error) {
      console.error('Copy image failed:', error);
      return { success: false, error: String(error?.message || error) };
    }
  });

  ipcMain.handle('api:auditDeletions', async () => {
    try {
      let allApiIds = new Set();
      let offset = 0;
      let hasMore = true;
      while (hasMore && allApiIds.size < 500) {
        const response = await auth.fetchWithAuth(`https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=50&order=updated`);
        const data = await response.json();
        if (data.items) {
          data.items.forEach(item => allApiIds.add(item.id));
          offset += data.items.length;
          hasMore = offset < data.total;
        } else { hasMore = false; }
      }
      const localConvs = db.getConversations();
      let markedCount = 0;
      localConvs.forEach(conv => {
        if (!conv.is_deleted_on_web && !allApiIds.has(conv.id)) {
          db.markAsDeletedOnWeb(conv.id);
          markedCount++;
        } else if (conv.is_deleted_on_web && allApiIds.has(conv.id)) {
          const updated = { ...conv, is_deleted_on_web: 0 };
          db.upsertConversation(updated);
        }
      });
      return { success: true, markedCount };
    } catch (error) {
      console.error('Audit failed:', error);
      throw error;
    }
  });

  const lastSync = new Map();

  ipcMain.handle('api:syncConversations', async (event, { offset = 0, limit = 20 } = {}) => {
    try {
      const response = await auth.fetchWithAuth(`https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`);
      const data = await response.json();
      if (data.items) {
        db.db.transaction(() => {
          data.items.forEach(item => {
            const existing = db.getConversation(item.id);
            db.upsertConversation({
              id: item.id,
              title: item.title,
              created_at: item.create_time,
              updated_at: item.update_time,
              current_node_id: existing ? existing.current_node_id : null
            });
          });
        })();
      }
      return { 
        conversations: db.getConversations(),
        total: data.total,
        hasMore: (offset + limit) < data.total
      };
    } catch (error) {
      console.error('Sync failed:', error);
      throw error;
    }
  });

  ipcMain.handle('api:sendMessage', async (event, { conversationId, content, model, parentMessageId, image, files }) => {
    try {
      const uploaded = [];
      const fileList = Array.isArray(files) ? files : [];
      for (const file of fileList) {
        uploaded.push(await uploadAttachment(file));
      }
      if (image && typeof image === 'string') {
        uploaded.push(await uploadAttachment({
          name: 'pasted-image.png',
          mimeType: 'image/png',
          dataUrl: image,
        }));
      }

      const imageParts = uploaded
        .filter((f) => f.isImage)
        .map((f) => ({
          asset_pointer: `file-service://${f.fileId}`,
          content_type: 'image_asset_pointer',
          width: f.width || 0,
          height: f.height || 0,
          size_bytes: f.sizeBytes,
        }));

      const attachments = uploaded.map((f) => {
        const base = {
          id: f.fileId,
          mime_type: f.mimeType,
          name: f.name,
          size: f.sizeBytes,
        };
        return f.isImage
          ? { ...base, width: f.width || 0, height: f.height || 0 }
          : base;
      });

      const messageId = require('crypto').randomUUID();
      const conv = conversationId ? db.getConversation(conversationId) : null;
      const effectiveParentId = conv?.current_node_id || parentMessageId || require('crypto').randomUUID();
      const payload = {
        action: 'next',
        messages: [
          {
            id: messageId,
            author: { role: 'user' },
            content: {
              content_type: imageParts.length > 0 ? 'multimodal_text' : 'text',
              parts: imageParts.length > 0 ? [...imageParts, content || ''] : [content || '']
            },
            metadata: attachments.length > 0
              ? {
                  selected_all_github_repos: false,
                  selected_github_repos: [],
                  attachments,
                  system_hints: [],
                }
              : {
                  selected_all_github_repos: false,
                  selected_github_repos: [],
                  serialization_metadata: { custom_symbol_offsets: [] },
                  system_hints: [],
                }
          }
        ],
        parent_message_id: effectiveParentId,
        model: model === 'auto' ? 'auto' : model,
        timezone_offset_min: new Date().getTimezoneOffset(),
        history_and_training_disabled: false,
        conversation_id: conversationId || undefined
      };

      if (uploaded.length === 0 && typeof content === 'string' && content.trim()) {
        let uiHardFailure = null;
        try {
          const uiResult = await sendConversationViaUiAutomation({ conversationId, content });
          if (uiResult?.ok) {
            console.info('Message send used UI automation path', { statusText: uiResult.statusText });
            return { success: true };
          }
          console.warn('UI automation send path did not succeed:', uiResult);
          if (uiResult && typeof uiResult.status === 'number' && uiResult.status >= 400) {
            const detail = parseBackendErrorDetail(String(uiResult.bodyText || ''));
            const error = new Error(
              detail
                ? `Failed to send message (${uiResult.status}): ${detail}`
                : `Failed to send message (${uiResult.status})`
            );
            error.statusCode = uiResult.status;
            error.apiDetail = detail;
            uiHardFailure = error;
          }
        } catch (uiError) {
          console.warn('UI automation send path failed, falling back to API paths:', uiError);
        }
        if (uiHardFailure) throw uiHardFailure;
      }

      let sendResult = null;
      try {
        sendResult = await sendConversationViaBridge(payload);
      } catch (bridgeError) {
        console.warn('Bridge send path failed, falling back to main-process fetch:', bridgeError);
      }

      if (!sendResult || sendResult.status === 0) {
        const fallbackResponse = await auth.fetchWithAuth('https://chatgpt.com/backend-api/conversation', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        sendResult = {
          ok: fallbackResponse.ok,
          status: fallbackResponse.status,
          statusText: fallbackResponse.statusText,
          bodyText: await fallbackResponse.text().catch(() => ''),
        };
      }

      if (!sendResult.ok) {
        const errText = sendResult.bodyText || '';
        const detail = parseBackendErrorDetail(errText);
        console.error('API Send Error:', { status: sendResult.status, statusText: sendResult.statusText, detail: detail || errText });
        const error = new Error(
          detail
            ? `Failed to send message (${sendResult.status}): ${detail}`
            : `Failed to send message (${sendResult.status})`
        );
        error.statusCode = sendResult.status;
        error.apiDetail = detail;
        throw error;
      }
      return { success: true };
    } catch (error) {
      console.error('Send message failed:', error);
      throw error;
    }
  });

  ipcMain.handle('api:syncMessages', async (event, payload) => {
    const conversationId = typeof payload === 'string' ? payload : payload?.conversationId;
    const force = typeof payload === 'string' ? false : !!payload?.force;
    if (!conversationId) throw new Error('Missing conversationId');
    const now = Date.now();
    if (!force && lastSync.has(conversationId) && now - lastSync.get(conversationId) < 30000) {
      return getLinearMessages(conversationId);
    }
    try {
      const response = await auth.fetchWithAuth(`https://chatgpt.com/backend-api/conversation/${conversationId}`);
      const data = await response.json();
      if (data.mapping) {
        db.db.transaction(() => {
          const convs = db.getConversations();
          const existingConv = convs.find(c => c.id === conversationId);
          if (existingConv) {
            db.upsertConversation({ ...existingConv, current_node_id: data.current_node });
          }
          Object.values(data.mapping).forEach(node => {
            if (node.message) {
              const content = renderMessageContent(node.message, conversationId);
              db.upsertMessage({
                id: node.message.id,
                conversation_id: conversationId,
                role: node.message.author?.role || 'assistant',
                content: content || '',
                metadata_json: sanitizeMetadata(node.message.metadata),
                created_at: node.message.create_time || 0,
                parent_id: node.parent
              });
            }
          });
        })();
        lastSync.set(conversationId, now);
      }
      return getLinearMessages(conversationId);
    } catch (error) {
      console.error('Message sync failed:', error);
      throw error;
    }
  });
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'chatgpt-image', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } }
]);

app.whenReady().then(() => {
  auth = new ChatGPTAuth(null);
  db = new ChatDatabase();
  setupIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (bridgeWindow && !bridgeWindow.isDestroyed()) {
    bridgeWindow.close();
    bridgeWindow = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
