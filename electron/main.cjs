const { app, BrowserWindow, ipcMain, protocol, net, session, clipboard, nativeImage } = require('electron');
const path = require('path');
const ChatGPTAuth = require('./auth.cjs');
const ChatDatabase = require('./database.cjs');

const isDev = process.env.NODE_ENV === 'development';

let mainWindow;
let auth;
let db;

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

  // Set a standard browser User-Agent to avoid being blocked by Cloudflare/Akamai
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  mainWindow.webContents.setUserAgent(userAgent);

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
    const allMsgs = db.getMessages(conversationId);
    return allMsgs.filter(m => m.content && m.content.trim());
  }

  const path = db.getLinearPath(conv.current_node_id);

  // Filter out messages with no content (thinking steps, meta-nodes, etc.)
  return path.filter(m => m.content && m.content.trim());
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
            if (node.message && node.message.content) {
              wroteAnyMessage = true;
              const parts = node.message.content.parts || [];
              const content = parts.map(p => {
                if (typeof p === 'string') return p;
                if (p.content_type === 'image_asset_pointer' || p.content_type === 'image' || p.asset_pointer) {
                  const rawPointer = p.asset_pointer || p.file_id || '';
                  const fileId = extractFileId(rawPointer);
                  if (fileId) {
                    return `\n![Chat Image](chatgpt-image://${fileId}?conversation_id=${encodeURIComponent(conv.id)})\n`;
                  }
                }
                return '';
              }).join('\n');
              
              db.upsertMessage({
                id: node.message.id,
                conversation_id: conv.id,
                role: node.message.author.role,
                content: content || '',
                created_at: node.message.create_time,
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
      if (!existing && !conv.is_deleted_on_web) {
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

  ipcMain.handle('api:sendMessage', async (event, { conversationId, content, model, parentMessageId, image }) => {
    try {
      const messageId = require('crypto').randomUUID();
      db.upsertMessage({
        id: messageId,
        conversation_id: conversationId,
        role: 'user',
        content: content,
        created_at: Date.now() / 1000,
        parent_id: parentMessageId
      });
      const payload = {
        action: 'next',
        messages: [
          {
            id: messageId,
            author: { role: 'user' },
            content: {
              content_type: image ? 'multimodal_text' : 'text',
              parts: image ? [
                {
                  content_type: 'image_asset_pointer',
                  asset_pointer: 'file-service://' + image.split(',')[1],
                  size_bytes: Math.round((image.length * 3) / 4),
                  width: 512, height: 512
                },
                content
              ] : [content]
            },
            metadata: {}
          }
        ],
        parent_message_id: parentMessageId || require('crypto').randomUUID(),
        model: model === 'auto' ? 'auto' : model,
        timezone_offset_min: new Date().getTimezoneOffset(),
        history_and_training_disabled: false,
        conversation_id: conversationId || undefined
      };
      const response = await auth.fetchWithAuth('https://chatgpt.com/backend-api/conversation', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const errText = await response.text();
        console.error('API Send Error:', errText);
        throw new Error(`Failed to send message: ${response.status}`);
      }
      return { success: true };
    } catch (error) {
      console.error('Send message failed:', error);
      throw error;
    }
  });

  ipcMain.handle('api:syncMessages', async (event, conversationId) => {
    const now = Date.now();
    if (lastSync.has(conversationId) && now - lastSync.get(conversationId) < 30000) {
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
            if (node.message && node.message.content) {
              const parts = node.message.content.parts || [];
              const content = parts.map(p => {
                if (typeof p === 'string') return p;
                if (p.content_type === 'image_asset_pointer' || p.content_type === 'image' || p.asset_pointer) {
                  const rawPointer = p.asset_pointer || p.file_id || '';
                  const fileId = extractFileId(rawPointer);
                  if (fileId) {
                    return `\n![Chat Image](chatgpt-image://${fileId}?conversation_id=${encodeURIComponent(conversationId)})\n`;
                  }
                }
                return '';
              }).join('\n');
              db.upsertMessage({
                id: node.message.id,
                conversation_id: conversationId,
                role: node.message.author.role,
                content: content || '',
                created_at: node.message.create_time,
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
  if (process.platform !== 'darwin') app.quit();
});
