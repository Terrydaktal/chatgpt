const { app, BrowserWindow, ipcMain, protocol, net, session, clipboard, nativeImage } = require('electron');
const path = require('path');
const ChatGPTAuth = require('./auth.cjs');
const ChatDatabase = require('./database.cjs');

const isDev = process.env.NODE_ENV === 'development';
const OOM_DEBUG = process.env.CHATGPT_OOM_DEBUG === '1';
const OOM_TRACE_GC = process.env.CHATGPT_TRACE_GC === '1';

if (OOM_DEBUG) {
  const jsFlags = [
    '--max-old-space-size=8192',
    '--expose-gc',
    OOM_TRACE_GC ? '--trace-gc' : '',
  ].filter(Boolean).join(' ');
  app.commandLine.appendSwitch('js-flags', jsFlags);
  app.commandLine.appendSwitch('enable-precise-memory-info');
  app.commandLine.appendSwitch('remote-debugging-port', process.env.CHATGPT_REMOTE_DEBUG_PORT || '9222');
  app.commandLine.appendSwitch('enable-logging');
  app.commandLine.appendSwitch('log-level', '0');
}

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
let oomMetricsTimer = null;
let oomMemoryInfoWarned = false;

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

function formatKbToMB(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round((num / 1024) * 10) / 10;
}

async function getWebContentsMemorySummary(webContents) {
  if (!webContents || webContents.isDestroyed()) return null;
  try {
    const proc = await webContents.getProcessMemoryInfo();
    return {
      rssMB: formatKbToMB(proc.residentSet),
      privateMB: formatKbToMB(proc.private),
      sharedMB: formatKbToMB(proc.shared),
    };
  } catch (error) {
    if (OOM_DEBUG && !oomMemoryInfoWarned) {
      oomMemoryInfoWarned = true;
      console.warn('[oom-main] getProcessMemoryInfo unavailable:', String(error?.message || error));
    }
    return null;
  }
}

async function logRendererMetrics(reason) {
  if (!OOM_DEBUG) return;
  try {
    const metrics = app.getAppMetrics();
    const safePid = (win) => {
      try {
        if (!win || win.isDestroyed()) return null;
        const wc = win.webContents;
        if (!wc || wc.isDestroyed()) return null;
        return wc.getOSProcessId();
      } catch {
        return null;
      }
    };
    const mainPid = safePid(mainWindow);
    const bridgePid = safePid(bridgeWindow);
    const findByPid = (pid) => metrics.find((m) => Number(m.pid) === Number(pid)) || null;
    const slim = (metric) => {
      if (!metric) return null;
      return {
        pid: metric.pid,
        type: metric.type,
        wsMB: formatKbToMB(metric.memory?.workingSetSize),
        privMB: formatKbToMB(metric.memory?.privateBytes),
        sharedMB: formatKbToMB(metric.memory?.sharedBytes),
      };
    };
    const [mainProc, bridgeProc] = await Promise.all([
      getWebContentsMemorySummary(mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
      getWebContentsMemorySummary(bridgeWindow && !bridgeWindow.isDestroyed() ? bridgeWindow.webContents : null),
    ]);
    console.info('[oom-main]', JSON.stringify({
      ts: new Date().toISOString(),
      reason,
      main: slim(findByPid(mainPid)),
      bridge: slim(findByPid(bridgePid)),
      mainProc,
      bridgeProc,
    }));
  } catch (error) {
    console.warn('[oom-main] metrics read failed', error);
  }
}

function attachRendererDiagnostics(label, webContents) {
  if (!OOM_DEBUG || !webContents) return;
  webContents.on('render-process-gone', (_event, details) => {
    console.error(`[oom-main] ${label} render-process-gone`, details);
    logRendererMetrics(`${label}:render-process-gone`);
  });
  webContents.on('unresponsive', () => {
    console.error(`[oom-main] ${label} unresponsive`);
    logRendererMetrics(`${label}:unresponsive`);
  });
}

function startOomMetricsProbe() {
  if (!OOM_DEBUG || oomMetricsTimer) return;
  logRendererMetrics('startup').catch((error) => {
    console.warn('[oom-main] startup metrics failed', error);
  });
  oomMetricsTimer = setInterval(() => {
    logRendererMetrics('heartbeat').catch((error) => {
      console.warn('[oom-main] heartbeat metrics failed', error);
    });
  }, 2000);
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
  attachRendererDiagnostics('bridge', bridgeWindow.webContents);

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
    const domAlreadyTrimmed = Number(lastState?.messageCount || 0) > 0 && Number(lastState?.messageCount || 0) <= expectedVisibleLimit;
    const trimWorkedByMeta =
      !!fastMeta &&
      fastMeta.lastConversationId === conversationId &&
      (
        Number(fastMeta.lastOriginalVisible || 0) <= expectedVisibleLimit ||
        Number(fastMeta.lastKeptVisible || 0) <= expectedVisibleLimit
      );
    const trimmedConversationReady = !conversationId || !BRIDGE_FAST_MODE || domAlreadyTrimmed || !fastInstalled || trimWorkedByMeta;
    
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

function normalizeBridgeModelTarget(requestedModel) {
  const raw = String(requestedModel || 'auto').trim().toLowerCase();
  if (!raw || raw === 'auto' || raw === 'default') {
    return { mode: 'auto', effort: null };
  }

  const map = {
    'gpt-4o': { mode: 'instant', effort: null },
    'gpt-5-3': { mode: 'instant', effort: null },
    instant: { mode: 'instant', effort: null },
    'o1-mini': { mode: 'thinking', effort: 'standard' },
    'o3-mini': { mode: 'thinking', effort: 'standard' },
    'o1': { mode: 'thinking', effort: 'extended' },
    'gpt-5-5-thinking': { mode: 'thinking', effort: null },
  };
  if (map[raw]) return map[raw];

  if (raw.includes('instant')) return { mode: 'instant', effort: null };
  if (raw.includes('thinking')) {
    if (raw.includes('extended')) return { mode: 'thinking', effort: 'extended' };
    if (raw.includes('standard')) return { mode: 'thinking', effort: 'standard' };
    return { mode: 'thinking', effort: null };
  }

  return { mode: 'auto', effort: null };
}

async function applyBridgeModelSelection(win, requestedModel) {
  const target = normalizeBridgeModelTarget(requestedModel);
  if (target.mode === 'auto') {
    return { ok: true, skipped: 'auto' };
  }

  const result = await win.webContents.executeJavaScript(
    `
      (async () => {
        const desiredModel = ${JSON.stringify(target.mode)};
        const desiredEffort = ${JSON.stringify(target.effort)};
        const norm = (v) => String(v || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const isVisible = (el) =>
          !!el &&
          !!el.isConnected &&
          (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
        const click = (el) => {
          if (!el) return false;
          try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
          try { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); } catch {}
          try { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch {}
          try { el.click(); } catch {}
          try { el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); } catch {}
          return true;
        };
        const waitFor = async (fn, timeoutMs = 1800, intervalMs = 50) => {
          const end = Date.now() + timeoutMs;
          while (Date.now() < end) {
            const value = fn();
            if (value) return value;
            await sleep(intervalMs);
          }
          return null;
        };

        const allMenus = () =>
          Array.from(document.querySelectorAll('[role="menu"]')).filter(isVisible);
        const menuItems = () =>
          allMenus().flatMap((menu) =>
            Array.from(menu.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')).filter(isVisible)
          );

        const getModelTrigger = () => {
          const buttons = Array.from(document.querySelectorAll('button.__composer-pill, button[aria-haspopup="menu"]'));
          return buttons.find((btn) => {
            if (!isVisible(btn)) return false;
            const cls = String(btn.className || '');
            if (cls.includes('__composer-pill')) return true;
            const text = norm(btn.textContent || '');
            return text.includes('instant') || text.includes('thinking') || text.includes('extended') || text.includes('standard');
          }) || null;
        };

        const openMenu = async () => {
          if (allMenus().length > 0) return true;
          const trigger = getModelTrigger();
          if (!trigger) return false;
          click(trigger);
          const opened = await waitFor(() => allMenus()[0] || null);
          return !!opened;
        };

        const closeMenu = () => {
          try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch {}
        };

        const pickModelInQuickMenu = async () => {
          const items = menuItems();
          if (items.length === 0) return false;
          const candidate = items.find((el) => {
            if (el.getAttribute('data-model-picker-thinking-effort-action') === 'true') return false;
            const tid = norm(el.getAttribute('data-testid') || '');
            const text = norm(el.textContent || '');
            if (desiredModel === 'instant') {
              return (
                tid.includes('model-switcher-gpt-5-3') ||
                tid.includes('model-switcher-instant') ||
                text.startsWith('instant')
              );
            }
            return (
              tid.includes('model-switcher-gpt-5-5-thinking') ||
              ((tid.includes('model-switcher') || text.includes('thinking')) && text.includes('thinking'))
            );
          }) || null;
          if (!candidate) return false;
          click(candidate);
          await sleep(100);
          return true;
        };

        const pickEffortInQuickMenu = async () => {
          if (!desiredEffort) return true;
          const actionBtn =
            menuItems().find((el) => norm(el.getAttribute('data-testid') || '').includes('thinking-effort')) ||
            document.querySelector('button[data-model-picker-thinking-effort-action="true"]');
          if (!actionBtn || !isVisible(actionBtn)) return false;
          click(actionBtn);
          await sleep(100);

          const effortItem = await waitFor(() => {
            const target = menuItems().find((el) => {
              const text = norm(el.textContent || '');
              if (!text.includes(desiredEffort)) return false;
              return text.includes('standard') || text.includes('extended');
            });
            return target || null;
          }, 1500, 50);

          if (!effortItem) return false;
          click(effortItem);
          await sleep(100);
          return true;
        };

        const pickConfigureInQuickMenu = async () => {
          const configure = menuItems().find((el) => {
            const tid = norm(el.getAttribute('data-testid') || '');
            const text = norm(el.textContent || '');
            return tid.includes('model-configure-modal') || text.includes('configure');
          });
          if (!configure) return false;
          click(configure);
          const dialog = await waitFor(() => document.querySelector('div[role="dialog"][data-state="open"]'));
          return !!dialog;
        };

        const pickModelInConfigureDialog = () => {
          const dialog = document.querySelector('div[role="dialog"][data-state="open"]');
          if (!dialog) return false;
          const radioButtons = Array.from(dialog.querySelectorAll('button[role="radio"]')).filter(isVisible);
          const target = radioButtons.find((el) => {
            const text = norm(el.textContent || '');
            return desiredModel === 'instant' ? text.includes('instant') : text.includes('thinking');
          });
          if (!target) return false;
          if (target.getAttribute('aria-checked') !== 'true') {
            click(target);
          }
          return true;
        };

        const pickEffortInConfigureDialog = async () => {
          if (!desiredEffort) return true;
          const dialog = document.querySelector('div[role="dialog"][data-state="open"]');
          if (!dialog) return false;
          const effortCombo = dialog.querySelector('button[aria-labelledby="thinking-effort-selection-label"]');
          if (!effortCombo || !isVisible(effortCombo)) return false;
          click(effortCombo);

          const option = await waitFor(() => {
            const menus = Array.from(document.querySelectorAll('[role="listbox"], [role="menu"]')).filter(isVisible);
            for (const menu of menus) {
              const nodes = Array.from(menu.querySelectorAll('[role="option"], [role="menuitemradio"], [role="menuitem"]')).filter(isVisible);
              const match = nodes.find((el) => norm(el.textContent || '').includes(desiredEffort));
              if (match) return match;
            }
            return null;
          }, 2000, 50);
          if (!option) return false;
          click(option);
          await sleep(100);
          return true;
        };

        // First try quick menu path.
        const openedQuick = await openMenu();
        if (!openedQuick) return { ok: false, reason: 'Model menu trigger not found' };
        const modelPicked = await pickModelInQuickMenu();
        if (!modelPicked) return { ok: false, reason: 'Model entry not found in quick menu' };

        // For thinking effort changes, try the quick effort action first, then fallback to Configure dialog.
        if (desiredModel === 'thinking' && desiredEffort) {
          if (allMenus().length === 0) {
            await openMenu();
          }
          let effortPicked = await pickEffortInQuickMenu();
          if (!effortPicked) {
            if (allMenus().length === 0) {
              await openMenu();
            }
            const openedDialog = await pickConfigureInQuickMenu();
            if (!openedDialog) return { ok: false, reason: 'Configure dialog did not open for effort selection' };
            const modelSetInDialog = pickModelInConfigureDialog();
            const effortSetInDialog = await pickEffortInConfigureDialog();
            if (!modelSetInDialog || !effortSetInDialog) {
              return { ok: false, reason: 'Failed to set model/effort in configure dialog' };
            }
          }
        }

        closeMenu();
        return { ok: true };
      })();
    `,
    true
  );

  if (!result?.ok) {
    return { ok: false, reason: String(result?.reason || 'Bridge model selection failed') };
  }
  return { ok: true };
}

function buildBridgeAttachmentPayload(image, files) {
  const attachments = [];

  if (typeof image === 'string' && image.startsWith('data:')) {
    attachments.push({
      name: 'image.png',
      mimeType: 'image/png',
      dataUrl: image,
      sizeBytes: 0,
    });
  }

  if (Array.isArray(files)) {
    for (const file of files) {
      if (!file || typeof file !== 'object') continue;
      const dataUrl = typeof file.dataUrl === 'string' ? file.dataUrl : '';
      if (!dataUrl.startsWith('data:')) continue;
      attachments.push({
        name: typeof file.name === 'string' && file.name.trim() ? file.name.trim() : 'attachment',
        mimeType: typeof file.mimeType === 'string' && file.mimeType.trim() ? file.mimeType.trim() : 'application/octet-stream',
        dataUrl,
        sizeBytes: Number(file.sizeBytes) || 0,
      });
    }
  }

  return attachments;
}

async function applyBridgeAttachments(win, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { ok: true, count: 0 };
  }

  const result = await win.webContents.executeJavaScript(
    `
      (async () => {
        const payload = ${JSON.stringify(attachments)};
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const isVisible = (el) =>
          !!el &&
          !!el.isConnected &&
          (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);

        const getComposer = () =>
          document.querySelector('#prompt-textarea[contenteditable="true"]') ||
          document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
          document.querySelector('textarea#prompt-textarea');

        const composer = getComposer();
        if (!composer) return { ok: false, reason: 'Composer not found for file paste' };
        if (typeof DataTransfer === 'undefined' || typeof File === 'undefined') {
          return { ok: false, reason: 'DataTransfer/File API unavailable in bridge page' };
        }

        const existingRemovers = document.querySelectorAll('button[aria-label^="Remove file"]').length;
        const dt = new DataTransfer();
        let added = 0;

        for (const item of payload) {
          const dataUrl = String(item?.dataUrl || '');
          if (!dataUrl.startsWith('data:')) continue;
          const commaIndex = dataUrl.indexOf(',');
          if (commaIndex <= 0) continue;
          const meta = dataUrl.slice(0, commaIndex);
          const base64 = dataUrl.slice(commaIndex + 1);
          const mimeMatch = /^data:([^;]+)/i.exec(meta);
          const mimeType = String(item?.mimeType || (mimeMatch ? mimeMatch[1] : 'application/octet-stream'));
          const name = String(item?.name || (mimeType.startsWith('image/') ? 'image.png' : 'attachment'));

          let bytes;
          try {
            const bin = atob(base64);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          } catch {
            continue;
          }

          const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
          const file = new File([blob], name, { type: mimeType || 'application/octet-stream' });
          dt.items.add(file);
          added += 1;
        }

        if (added === 0) {
          return { ok: false, reason: 'No valid attachment payloads to paste' };
        }

        try { composer.focus(); } catch {}

        let pasteEvent;
        try {
          pasteEvent = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        } catch {
          pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
          try {
            Object.defineProperty(pasteEvent, 'clipboardData', {
              value: dt,
              writable: false,
              configurable: true,
            });
          } catch {}
        }

        // ProseMirror handlers often call preventDefault() on paste, which makes
        // dispatchEvent return false even when paste is successfully handled.
        composer.dispatchEvent(pasteEvent);

        const deadline = Date.now() + 12000;
        const expected = existingRemovers + added;
        while (Date.now() < deadline) {
          const removeButtons = document.querySelectorAll('button[aria-label^="Remove file"]').length;
          if (removeButtons >= expected) {
            return { ok: true, count: added };
          }
          await sleep(100);
        }

        // Fallback: if file chips are present even without remove-label buttons, treat as success.
        const chips = Array.from(document.querySelectorAll('[role="group"][aria-label], img[src*="/backend-api/estuary/content"]')).filter(isVisible);
        if (chips.length > 0) {
          return { ok: true, count: added, fallback: 'chip-detected' };
        }
        return { ok: false, reason: 'Attachment tiles did not appear after paste' };
      })();
    `,
    true
  );

  if (!result?.ok) {
    return { ok: false, reason: String(result?.reason || 'Bridge attachment paste failed') };
  }
  return { ok: true, count: Number(result?.count) || 0 };
}

async function setBridgeComposerText(win, prompt) {
  const text = String(prompt || '');
  const result = await win.webContents.executeJavaScript(
    `
      (() => {
        const prompt = ${JSON.stringify(text)};
        const getComposer = () =>
          document.querySelector('#prompt-textarea[contenteditable="true"]') ||
          document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
          document.querySelector('textarea#prompt-textarea') ||
          document.querySelector('textarea[placeholder*="ask" i], textarea[placeholder*="message" i]');
        const composer = getComposer();
        if (!composer) return { ok: false, reason: 'Composer not found while setting text' };

        composer.focus();
        const tag = (composer.tagName || '').toUpperCase();
        if (tag === 'TEXTAREA') {
          composer.value = prompt;
          composer.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: true };
        }

        // Contenteditable (ProseMirror) path
        composer.textContent = '';
        if (prompt) {
          const lines = prompt.split(/\\r?\\n/);
          const fragment = document.createDocumentFragment();
          for (let i = 0; i < lines.length; i++) {
            const p = document.createElement('p');
            const line = lines[i];
            if (line.length === 0) {
              p.appendChild(document.createElement('br'));
            } else {
              p.textContent = line;
            }
            fragment.appendChild(p);
          }
          composer.appendChild(fragment);
        } else {
          const p = document.createElement('p');
          p.appendChild(document.createElement('br'));
          composer.appendChild(p);
        }

        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
        return { ok: true };
      })();
    `,
    true
  );

  if (!result?.ok) {
    return { ok: false, reason: String(result?.reason || 'Failed to set composer text') };
  }
  return { ok: true };
}

async function waitForBridgeSendReady(win) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const snapshot = await win.webContents.executeJavaScript(
      `
        (() => {
          const sendBtn =
            document.querySelector('#composer-submit-button') ||
            document.querySelector('button[data-testid="send-button"]') ||
            document.querySelector('button[aria-label="Send prompt"]') ||
            document.querySelector('button[aria-label*="Send"]');
          const hasUploadingIndicator =
            document.querySelectorAll('[role="progressbar"], [aria-busy="true"], [data-testid*="upload"], [data-testid*="loading"]').length > 0;
          if (!sendBtn) return { ready: false, reason: 'send_not_found' };
          const disabled = !!sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true';
          return { ready: !disabled && !hasUploadingIndicator, disabled, hasUploadingIndicator };
        })();
      `,
      true
    );
    if (snapshot?.ready) return { ok: true };
    await sleep(120);
  }
  return { ok: false, reason: 'Send button stayed disabled/busy after attachments/text update' };
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

async function sendConversationViaUiAutomation({ conversationId, content, model, image, files }) {
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

  const modelSelection = await applyBridgeModelSelection(win, model);
  if (!modelSelection?.ok) {
    return { ok: false, status: 0, statusText: 'ui_model_select_failed', bodyText: String(modelSelection?.reason || 'Model selection failed') };
  }

  const attachments = buildBridgeAttachmentPayload(image, files);
  if (attachments.length > 0) {
    const attachResult = await applyBridgeAttachments(win, attachments);
    if (!attachResult?.ok) {
      return { ok: false, status: 0, statusText: 'ui_attach_failed', bodyText: String(attachResult?.reason || 'Attachment upload failed') };
    }
  }
  
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

  // Insert text explicitly into the composer (more reliable than insertText for contenteditable editors).
  const textResult = await setBridgeComposerText(win, prompt);
  if (!textResult?.ok) {
    return { ok: false, status: 0, statusText: 'ui_text_set_failed', bodyText: String(textResult?.reason || 'Failed to set prompt text') };
  }

  const sendReady = await waitForBridgeSendReady(win);
  if (!sendReady?.ok) {
    return { ok: false, status: 0, statusText: 'ui_send_not_ready', bodyText: String(sendReady?.reason || 'Send control not ready') };
  }
  await sleep(80);

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
  attachRendererDiagnostics('main', mainWindow.webContents);

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

  ipcMain.handle('api:sendMessage', async (event, { conversationId, content, model, image, files }) => {
    try {
      const fileList = Array.isArray(files) ? files : [];

      const prompt = String(content || '');
      if (!prompt.trim() && !image && fileList.length === 0) {
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
        model,
        image,
        files: fileList,
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
  startOomMetricsProbe();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  if (OOM_DEBUG) {
    app.on('child-process-gone', (_event, details) => {
      console.error('[oom-main] child-process-gone', details);
      logRendererMetrics('child-process-gone');
    });
  }
});

app.on('window-all-closed', () => {
  if (oomMetricsTimer) {
    clearInterval(oomMetricsTimer);
    oomMetricsTimer = null;
  }
  if (bridgeWindow && !bridgeWindow.isDestroyed()) {
    bridgeWindow.close();
    bridgeWindow = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
