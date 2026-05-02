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
let bridgeWarmRequestToken = 0;
let bridgeComposerStatus = {
  conversationId: null,
  state: 'idle',
  ready: false,
  reason: '',
  updatedAt: Date.now(),
};
let bridgeGenerationMonitorToken = 0;

const shouldShowBridgeWindow = () => isDev || process.env.CHATGPT_BRIDGE_VISIBLE === '1';
const BRIDGE_FAST_MODE = process.env.CHATGPT_BRIDGE_FAST_MODE !== '0';
const BRIDGE_FAST_TURNS = Math.max(1, Number(process.env.CHATGPT_BRIDGE_FAST_TURNS || 1));
const BRIDGE_FAST_CACHE = Math.max(1, Number(process.env.CHATGPT_BRIDGE_FAST_CACHE || 5));
const BRIDGE_RESOURCE_BLOCKING = process.env.CHATGPT_BRIDGE_RESOURCE_BLOCKING === '1';
const BRIDGE_BLOCKED_RESOURCE_TYPES = new Set(['image', 'imageset', 'media', 'font']);
let bridgeRequestBlockerInstalled = false;

function isAbortedNavigationError(errorOrCode) {
  if (typeof errorOrCode === 'number') return errorOrCode === -3;
  return !!(
    errorOrCode &&
    (errorOrCode.code === 'ERR_ABORTED' || errorOrCode.errno === -3)
  );
}

function publishBridgeComposerStatus(patch) {
  bridgeComposerStatus = {
    ...bridgeComposerStatus,
    ...patch,
    updatedAt: Date.now(),
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('api:bridgeComposerStatus', bridgeComposerStatus);
  }
}

function installBridgeRequestBlocker() {
  if (!BRIDGE_RESOURCE_BLOCKING || bridgeRequestBlockerInstalled) return;
  bridgeRequestBlockerInstalled = true;

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      if (!bridgeWindow || bridgeWindow.isDestroyed()) {
        callback({});
        return;
      }
      if (details.webContentsId !== bridgeWindow.webContents.id) {
        callback({});
        return;
      }
      if (BRIDGE_BLOCKED_RESOURCE_TYPES.has(details.resourceType)) {
        callback({ cancel: true });
        return;
      }
      callback({});
    } catch {
      callback({});
    }
  });
}

function buildBridgeFastModeScript() {
  const maxTurns = BRIDGE_FAST_TURNS;
  const cacheSize = BRIDGE_FAST_CACHE;
  return `
    (() => {
      if (window.__codexBridgeFastModeInstalled) return;
      window.__codexBridgeFastModeInstalled = true;
      if (!window.__codexBridgeFastModeMeta) {
        window.__codexBridgeFastModeMeta = {
          installedAt: Date.now(),
          lastConversationId: null,
          lastConversationFetchAt: 0,
          lastOriginalVisible: 0,
          lastKeptVisible: 0,
          lastUrl: '',
          trimCount: 0,
        };
      }
      const MAX_TURNS = ${JSON.stringify(maxTurns)};
      const CACHE_SIZE = ${JSON.stringify(cacheSize)};
      const responseCache = new Map();

      const cacheGet = (key) => {
        const hit = responseCache.get(key);
        if (!hit) return null;
        responseCache.delete(key);
        responseCache.set(key, hit);
        return hit;
      };

      const cachePut = (key, value) => {
        responseCache.delete(key);
        responseCache.set(key, value);
        while (responseCache.size > CACHE_SIZE) {
          const oldest = responseCache.keys().next().value;
          if (!oldest) break;
          responseCache.delete(oldest);
        }
      };

      const isVisibleNode = (node) => {
        const role = node?.message?.author?.role;
        return role === 'user' || role === 'assistant';
      };

      const countVisibleMessages = (data) => {
        if (!data || typeof data !== 'object' || !data.mapping || typeof data.mapping !== 'object' || !data.current_node) {
          return 0;
        }
        const mapping = data.mapping;
        const chain = [];
        const visited = new Set();
        let nid = data.current_node;
        let guard = 0;
        while (nid && mapping[nid] && !visited.has(nid) && guard < 6000) {
          visited.add(nid);
          chain.push(nid);
          nid = mapping[nid]?.parent || null;
          guard++;
        }
        chain.reverse();
        let visible = 0;
        for (const id of chain) {
          if (isVisibleNode(mapping[id])) visible++;
        }
        return visible;
      };

      const trimConversationPayload = (data) => {
        if (!data || typeof data !== 'object' || !data.mapping || typeof data.mapping !== 'object' || !data.current_node) {
          return data;
        }

        const mapping = data.mapping;
        const chain = [];
        const visited = new Set();
        let nid = data.current_node;
        let guard = 0;

        while (nid && mapping[nid] && !visited.has(nid) && guard < 6000) {
          visited.add(nid);
          chain.push(nid);
          nid = mapping[nid]?.parent || null;
          guard++;
        }

        chain.reverse();
        if (chain.length === 0) return data;

        const visibleLimit = Math.max(1, MAX_TURNS * 2);
        let totalVisible = 0;
        for (const id of chain) {
          if (isVisibleNode(mapping[id])) totalVisible++;
        }
        if (totalVisible <= visibleLimit) return data;

        let count = 0;
        let cutoff = 0;
        for (let i = chain.length - 1; i >= 0; i--) {
          if (isVisibleNode(mapping[chain[i]])) {
            count++;
            if (count >= visibleLimit) {
              cutoff = i;
              break;
            }
          }
        }

        const keepSet = new Set();
        for (let i = 0; i < cutoff; i++) {
          if (!isVisibleNode(mapping[chain[i]])) keepSet.add(chain[i]);
        }
        for (let i = cutoff; i < chain.length; i++) {
          keepSet.add(chain[i]);
        }

        const keptChain = chain.filter((id) => keepSet.has(id));
        const trimmedMapping = {};
        for (let i = 0; i < keptChain.length; i++) {
          const id = keptChain[i];
          const src = mapping[id];
          if (!src) continue;
          const node = JSON.parse(JSON.stringify(src));
          node.parent = i > 0 ? keptChain[i - 1] : null;
          node.children = i < keptChain.length - 1 ? [keptChain[i + 1]] : [];
          trimmedMapping[id] = node;
        }

        return {
          ...data,
          mapping: trimmedMapping,
          current_node: keptChain[keptChain.length - 1] || data.current_node,
          root: keptChain[0] || data.root,
        };
      };

      let baseFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
      const WRAPPED_FETCH_MARK = '__codexWrappedFetch';
      if (typeof window.fetch === 'function' && window.fetch[WRAPPED_FETCH_MARK]) {
        return;
      }
      const wrappedFetch = async (...args) => {
        const input = args[0];
        const init = args[1] || {};
        const url = String(typeof input === 'string' ? input : (input && input.url) || '');
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        let pathname = '';
        try {
          pathname = new URL(url, location.origin).pathname || '';
        } catch {
          pathname = '';
        }
        const isConversationGet = method === 'GET' && /^\\/backend-api\\/conversation\\/[^/]+$/.test(pathname);
        if (!baseFetch) throw new Error('Base fetch unavailable');
        if (!isConversationGet) return baseFetch(...args);

        const cacheKey = method + ':' + url;
        const cached = cacheGet(cacheKey);
        if (cached) {
          return new Response(cached.body, {
            status: cached.status,
            statusText: cached.statusText,
            headers: new Headers(cached.headers),
          });
        }

        const response = await baseFetch(...args);
        if (!response.ok) return response;

        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        if (!contentType.includes('application/json')) return response;

        let payload = null;
        try {
          payload = await response.clone().json();
        } catch {
          return response;
        }

        const originalVisible = countVisibleMessages(payload);
        const trimmed = trimConversationPayload(payload);
        const keptVisible = countVisibleMessages(trimmed);
        const body = JSON.stringify(trimmed);
        const headers = new Headers(response.headers);
        headers.set('content-type', 'application/json');
        headers.delete('content-length');
        headers.delete('content-encoding');

        cachePut(cacheKey, {
          body,
          status: response.status,
          statusText: response.statusText,
          headers: Array.from(headers.entries()),
        });

        const conversationMatch = pathname.match(/^\\/backend-api\\/conversation\\/([^/]+)$/);
        const conversationId = conversationMatch ? decodeURIComponent(conversationMatch[1]) : null;
        const meta = window.__codexBridgeFastModeMeta || {};
        meta.lastConversationId = conversationId;
        meta.lastConversationFetchAt = Date.now();
        meta.lastOriginalVisible = originalVisible;
        meta.lastKeptVisible = keptVisible;
        meta.lastUrl = url;
        meta.trimCount = Number(meta.trimCount || 0) + (keptVisible < originalVisible ? 1 : 0);
        window.__codexBridgeFastModeMeta = meta;

        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      };

      wrappedFetch[WRAPPED_FETCH_MARK] = true;
      window.fetch = wrappedFetch;
    })();
  `;
}

async function installBridgeFastMode(win) {
  if (!BRIDGE_FAST_MODE || !win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript(buildBridgeFastModeScript(), true);
  } catch (error) {
    console.warn('Bridge fast mode injection failed:', error);
  }
}

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

  installBridgeRequestBlocker();

  bridgeWindow = new BrowserWindow({
    show: shouldShowBridgeWindow(),
    width: 1200,
    height: 900,
    title: 'ChatGPT Web Bridge',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'bridge-preload.cjs'),
      additionalArguments: [
        `--bridge-fast-mode=${BRIDGE_FAST_MODE ? '1' : '0'}`,
        `--bridge-fast-turns=${String(BRIDGE_FAST_TURNS)}`,
        `--bridge-fast-cache=${String(BRIDGE_FAST_CACHE)}`,
      ],
    },
  });

  if (!shouldShowBridgeWindow()) {
    bridgeWindow.setSkipTaskbar(true);
  }

  bridgeWindow.webContents.setUserAgent(ensureAppUserAgent());
  bridgeWindow.webContents.setAudioMuted(true);
  bridgeWindow.webContents.on('did-finish-load', () => {
    installBridgeFastMode(bridgeWindow).catch((error) => {
      console.warn('Bridge fast mode post-load install failed:', error);
    });
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Bridge window load timeout')), 30000);
    bridgeWindow.webContents.once('did-finish-load', () => {
      clearTimeout(timeout);
      resolve();
    });
    bridgeWindow.webContents.once('did-fail-load', (_event, code, desc) => {
      clearTimeout(timeout);
      // Navigation handoff commonly triggers ERR_ABORTED (-3) when a newer loadURL supersedes this one.
      if (isAbortedNavigationError(code)) {
        resolve();
        return;
      }
      reject(new Error(`Bridge window failed to load (${code}): ${desc}`));
    });
    bridgeWindow.loadURL('https://chatgpt.com/').catch(reject);
  });

  bridgeWindow.on('closed', () => {
    bridgeWindow = null;
    publishBridgeComposerStatus({
      state: 'idle',
      ready: false,
      reason: 'Bridge window closed',
      conversationId: null,
    });
  });
  return bridgeWindow;
}

async function navigateBridgeTo(url) {
  const win = await ensureBridgeWindow();
  const homeUrl = 'https://chatgpt.com/';
  const targetUrl = url || homeUrl;
  const currentUrl = win.webContents.getURL();

  if (currentUrl && normalizeChatgptUrl(currentUrl) === normalizeChatgptUrl(targetUrl)) {
    await installBridgeFastMode(win);
    return win;
  }

  try {
    win.loadURL(targetUrl).catch((err) => {
      if (isAbortedNavigationError(err)) return;
      console.warn('Bridge navigation failed:', err);
    });
  } catch (err) {
    if (!isAbortedNavigationError(err)) {
      throw err;
    }
  }

  // We don't wait for did-finish-load, the composer poller is faster
  await sleep(100);
  await installBridgeFastMode(win);
  return win;
}

async function waitForBridgeComposer(win, conversationId) {
  const expectedPath = conversationId ? `/c/${conversationId}` : '/';
  const deadline = Date.now() + 30000;
  const startTime = Date.now();
  const expectedVisibleLimit = Math.max(1, BRIDGE_FAST_TURNS * 2);
  let lastState = null;
  let stableCounter = 0;

  while (Date.now() < deadline) {
    lastState = await win.webContents.executeJavaScript(
      `
        (() => {
          const getComposer = () =>
            document.querySelector('#prompt-textarea[contenteditable="true"]') ||
            document.querySelector('textarea#prompt-textarea') ||
            document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
            document.querySelector('textarea[placeholder*="ask" i], textarea[placeholder*="message" i]');
          const sendBtn =
            document.querySelector('#composer-submit-button') ||
            document.querySelector('button[data-testid="send-button"]') ||
            document.querySelector('button[aria-label="Send prompt"]') ||
            document.querySelector('button[aria-label*="Send"]');
          
          const composer = getComposer();
          const loadingIndicators = document.querySelectorAll('[role="progressbar"], [aria-busy="true"], [data-testid*="loading"]').length;
          const messageCount = document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]').length;
          return {
            path: location.pathname,
            composerFound: !!composer,
            composerVisible: composer ? (composer.offsetWidth > 0 && composer.offsetHeight > 0) : false,
            composerEnabled: composer ? !composer.hasAttribute('disabled') : false,
            messageCount,
            loadingIndicators,
            fastModeInstalled: !!window.__codexBridgeFastModeInstalled,
            fastModeMeta: window.__codexBridgeFastModeMeta || null,
          };
        })();
      `,
      true
    );

    const normalizedPath = String(lastState?.path || '').replace(/\/+$/, '');
    const normalizedExpectedPath = expectedPath.replace(/\/+$/, '');
    const pathOk = conversationId ? normalizedPath === normalizedExpectedPath : true;
    const loadingIdle = Number(lastState?.loadingIndicators || 0) === 0;
    const hasMessagesForConversation = !conversationId || Number(lastState?.messageCount || 0) > 0;
    const fastInstalled = !!lastState?.fastModeInstalled;
    const fastMeta = lastState?.fastModeMeta || null;
    const trimFreshForConversation =
      !conversationId || (
        fastMeta &&
        fastMeta.lastConversationId === conversationId &&
        (Date.now() - Number(fastMeta.lastConversationFetchAt || 0)) < 20000
      );
    const trimWorked =
      !conversationId || (
        !!fastMeta && (
          Number(fastMeta.lastOriginalVisible || 0) <= expectedVisibleLimit ||
          Number(fastMeta.lastKeptVisible || 0) <= expectedVisibleLimit
        )
      );
    const trimmedConversationReady = !conversationId || (fastInstalled && trimFreshForConversation && trimWorked);
    
    if (
      pathOk &&
      lastState?.composerFound &&
      lastState?.composerVisible &&
      lastState?.composerEnabled &&
      loadingIdle &&
      hasMessagesForConversation &&
      trimmedConversationReady
    ) {
      stableCounter++;
      if (stableCounter >= 4 && (Date.now() - startTime) >= 500) {
        return lastState;
      }
    } else {
      stableCounter = 0;
    }
    await sleep(80);
  }

  throw new Error(`Bridge did not find composer on ${expectedPath}. Path: ${lastState?.path}`);
}

async function prewarmBridgeConversation(conversationId) {
  const normalizedConversationId = conversationId || null;
  const warmToken = ++bridgeWarmRequestToken;
  publishBridgeComposerStatus({
    conversationId: normalizedConversationId,
    state: 'warming',
    ready: false,
    reason: '',
  });

  const targetUrl = normalizedConversationId
    ? `https://chatgpt.com/c/${encodeURIComponent(normalizedConversationId)}`
    : 'https://chatgpt.com/';

  try {
    const win = await navigateBridgeTo(targetUrl);
    await waitForBridgeComposer(win, normalizedConversationId);
    if (warmToken !== bridgeWarmRequestToken) {
      return { success: false, superseded: true };
    }
    publishBridgeComposerStatus({
      conversationId: normalizedConversationId,
      state: 'ready',
      ready: true,
      reason: '',
    });
    return { success: true };
  } catch (error) {
    if (warmToken !== bridgeWarmRequestToken) {
      return { success: false, superseded: true };
    }
    if (isAbortedNavigationError(error)) {
      return { success: false, superseded: true };
    }
    const reason = String(error?.message || error || 'Bridge warm failed');
    publishBridgeComposerStatus({
      conversationId: normalizedConversationId,
      state: 'error',
      ready: false,
      reason,
    });
    return { success: false, error: reason };
  }
}

async function monitorBridgeGeneration(conversationId) {
  if (!bridgeWindow || bridgeWindow.isDestroyed()) return;
  const win = bridgeWindow;
  const token = ++bridgeGenerationMonitorToken;
  const expectedPath = conversationId ? `/c/${conversationId}` : null;
  const deadline = Date.now() + 180000;
  let sawGenerating = false;
  let idlePasses = 0;

  while (
    token === bridgeGenerationMonitorToken &&
    Date.now() < deadline &&
    win &&
    !win.isDestroyed()
  ) {
    let snapshot = null;
    try {
      snapshot = await win.webContents.executeJavaScript(
        `
          (() => {
            const getComposer = () =>
              document.querySelector('#prompt-textarea[contenteditable="true"]') ||
              document.querySelector('textarea#prompt-textarea') ||
              document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
              document.querySelector('textarea[placeholder*="ask" i], textarea[placeholder*="message" i]');
            const sendBtn =
              document.querySelector('#composer-submit-button') ||
              document.querySelector('button[data-testid="send-button"]') ||
              document.querySelector('button[aria-label="Send prompt"]') ||
              document.querySelector('button[aria-label*="Send"]');
            const stopBtn =
              document.querySelector('button[data-testid="stop-button"]') ||
              document.querySelector('button[aria-label="Stop generating"]') ||
              document.querySelector('button[aria-label*="Stop"]');

            const composer = getComposer();
            const sendDisabled = !!sendBtn && (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true');
            const composerEnabled = composer ? !composer.hasAttribute('disabled') : false;

            return {
              path: location.pathname,
              composerFound: !!composer,
              composerEnabled,
              sendDisabled,
              stopVisible: !!stopBtn,
            };
          })();
        `,
        true
      );
    } catch {
      break;
    }

    const path = String(snapshot?.path || '').replace(/\/+$/, '');
    const pathOk = expectedPath ? path === expectedPath : true;
    if (!pathOk) {
      await sleep(200);
      continue;
    }

    const generating = !!snapshot?.stopVisible || (!!snapshot?.composerFound && !!snapshot?.sendDisabled);
    if (generating) {
      sawGenerating = true;
      idlePasses = 0;
      publishBridgeComposerStatus({
        conversationId: conversationId || null,
        state: 'thinking',
        ready: false,
        reason: '',
      });
    } else {
      idlePasses += 1;
      if (sawGenerating || idlePasses >= 4) {
        publishBridgeComposerStatus({
          conversationId: conversationId || null,
          state: 'ready',
          ready: true,
          reason: '',
        });
        return;
      }
    }

    await sleep(250);
  }

  if (token === bridgeGenerationMonitorToken) {
    publishBridgeComposerStatus({
      conversationId: conversationId || null,
      state: 'ready',
      ready: true,
      reason: '',
    });
  }
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
  
  await waitForBridgeComposer(win, conversationId || null);
  
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

        const startUserCount = document.querySelectorAll('[data-message-author-role="user"]').length;
        const startAssistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;

        composer.focus();
        // Clear previous content
        if ((composer.tagName || '').toUpperCase() === 'TEXTAREA') {
          composer.value = '';
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          composer.innerHTML = '';
          composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }

        return {
          ok: true,
          startUserCount,
          startAssistantCount,
          url: location.href,
        };
      })();
    `,
    true
  );

  if (!setup?.ok) {
    return { ok: false, status: 0, statusText: 'ui_send_failed', bodyText: String(setup?.reason || 'Composer setup failed') };
  }

  // Insert the text and click send
  await win.webContents.insertText(prompt);
  await sleep(100);

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
          return { ok: false, reason: 'Send button disabled' };
        }
        sendBtn.click();
        return { ok: true };
      })();
    `,
    true
  );

  if (!clickResult?.ok) {
    return { ok: false, status: 0, statusText: 'ui_send_failed', bodyText: String(clickResult?.reason || 'Could not click send') };
  }

  // Primary success detection is DOM-level submit acceptance.
  // Request observers are best-effort only and can miss due page script timing.
  const acceptDeadline = Date.now() + 7000;
  while (Date.now() < acceptDeadline) {
    const submitObserved = await win.webContents.executeJavaScript(
      `
        (() => {
          const getComposer = () =>
            document.querySelector('#prompt-textarea[contenteditable="true"]') ||
            document.querySelector('textarea#prompt-textarea') ||
            document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
            document.querySelector('textarea[placeholder*="ask" i], textarea[placeholder*="message" i]');
          const sendBtn =
            document.querySelector('#composer-submit-button') ||
            document.querySelector('button[data-testid="send-button"]') ||
            document.querySelector('button[aria-label="Send prompt"]') ||
            document.querySelector('button[aria-label*="Send"]');
          const stopBtn =
            document.querySelector('button[data-testid="stop-button"]') ||
            document.querySelector('button[aria-label="Stop generating"]') ||
            document.querySelector('button[aria-label*="Stop"]');

          const composer = getComposer();
          const composerEmpty = !composer
            ? false
            : ((composer.tagName || '').toUpperCase() === 'TEXTAREA'
              ? String(composer.value || '').trim().length === 0
              : String(composer.textContent || '').trim().length === 0);
          const sendDisabled = !!sendBtn && (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true');
          const userCount = document.querySelectorAll('[data-message-author-role="user"]').length;
          const assistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;

          const userAdvanced = userCount > ${Number(setup.startUserCount || 0)};
          const assistantAdvanced = assistantCount > ${Number(setup.startAssistantCount || 0)};
          const accepted =
            !!stopBtn ||
            userAdvanced ||
            (composerEmpty && (sendDisabled || assistantAdvanced));

          return {
            accepted,
            stopVisible: !!stopBtn,
            userAdvanced,
            assistantAdvanced,
            composerEmpty,
            sendDisabled,
          };
        })();
      `,
      true
    );

    if (submitObserved?.accepted) {
      return {
        ok: true,
        status: 202,
        statusText: submitObserved.stopVisible ? 'ui_sent_generating' : 'ui_sent_accepted',
        bodyText: '',
      };
    }
    await sleep(120);
  }

  return { ok: false, status: 0, statusText: 'ui_send_failed', bodyText: 'Send click was not accepted by bridge UI' };
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

  ipcMain.handle('api:prewarmConversation', async (event, payload) => {
    const conversationId = typeof payload === 'string'
      ? payload
      : (payload?.conversationId || null);
    return prewarmBridgeConversation(conversationId);
  });

  ipcMain.handle('api:getBridgeComposerStatus', async () => {
    return bridgeComposerStatus;
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

  ipcMain.handle('api:sendMessage', async (event, { conversationId, content, image, files }) => {
    try {
      const fileList = Array.isArray(files) ? files : [];
      if (image || fileList.length > 0) {
        throw new Error('Bridge-only send currently supports text prompts only.');
      }

      const prompt = String(content || '');
      if (!prompt.trim()) {
        throw new Error('Cannot send an empty message.');
      }

      const warmResult = await prewarmBridgeConversation(conversationId || null);
      if (!warmResult?.success) {
        throw new Error(bridgeComposerStatus.reason || 'Chat is not ready for sending yet.');
      }

      publishBridgeComposerStatus({
        conversationId: conversationId || null,
        state: 'sending',
        ready: false,
        reason: '',
      });

      const uiResult = await sendConversationViaUiAutomation({
        conversationId: conversationId || null,
        content: prompt,
      });

      if (!uiResult?.ok) {
        const detail = parseBackendErrorDetail(String(uiResult?.bodyText || uiResult?.statusText || ''));
        throw new Error(detail || 'Failed to send message via bridge window UI.');
      }

      publishBridgeComposerStatus({
        conversationId: conversationId || null,
        state: 'thinking',
        ready: false,
        reason: '',
      });
      monitorBridgeGeneration(conversationId || null).catch((error) => {
        console.warn('Bridge generation monitor failed:', error);
      });

      return { success: true };
    } catch (error) {
      publishBridgeComposerStatus({
        conversationId: conversationId || null,
        state: 'error',
        ready: false,
        reason: String(error?.message || error || 'Send failed'),
      });
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
