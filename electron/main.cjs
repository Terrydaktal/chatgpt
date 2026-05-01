const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const path = require('path');
const ChatGPTAuth = require('./auth.cjs');
const ChatDatabase = require('./database.cjs');

const isDev = process.env.NODE_ENV === 'development';

let mainWindow;
let auth;
let db;

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
    const fileId = request.url.replace('chatgpt-image://', '');
    try {
      // Use the internal fetch with full session/auth
      const response = await auth.fetchWithAuth(`https://chatgpt.com/backend-api/files/${fileId}/download`);
      
      // Strip restrictive headers
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.delete('content-security-policy');
      headers.delete('content-disposition'); // Prevents it from being treated as a download attachment
      headers.delete('x-frame-options');

      return new Response(response.body, {
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

  ipcMain.handle('api:cacheAll', async (event) => {
    const convs = db.getConversations();
    let processed = 0;
    
    for (const conv of convs) {
      const existing = db.db.prepare('SELECT id FROM messages WHERE conversation_id = ? LIMIT 1').get(conv.id);
      if (!existing && !conv.is_deleted_on_web) {
        try {
          const response = await auth.fetchWithAuth(`https://chatgpt.com/backend-api/conversation/${conv.id}`);
          const data = await response.json();
          
          if (data.mapping) {
            db.db.transaction(() => {
              db.upsertConversation({ ...conv, current_node_id: data.current_node });

              Object.values(data.mapping).forEach(node => {
                if (node.message && node.message.content) {
                  const parts = node.message.content.parts || [];
                  const content = parts.map(p => {
                    if (typeof p === 'string') return p;
                    if (p.content_type === 'image_asset_pointer' || p.content_type === 'image' || p.asset_pointer) {
                      const rawPointer = p.asset_pointer || p.file_id || '';
                      const fileIdMatch = rawPointer.match(/file[_-][a-zA-Z0-9]+/);
                      if (fileIdMatch) {
                        return `\n![Chat Image](chatgpt-image://${fileIdMatch[0]})\n`;
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
            processed++;
            event.sender.send('api:cacheProgress', { current: processed, id: conv.id });
            await new Promise(r => setTimeout(r, 500));
          }
        } catch (e) {
          console.error(`Failed to cache ${conv.id}:`, e);
        }
      }
    }
    return { success: true, processed };
  });

  ipcMain.handle('db:getMessages', async (event, conversationId) => {
    return getLinearMessages(conversationId);
  });

  ipcMain.handle('db:searchMessages', async (event, query) => {
    return db.searchMessages(query);
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
                  const fileIdMatch = rawPointer.match(/file[_-][a-zA-Z0-9]+/);
                  if (fileIdMatch) {
                    return `\n![Chat Image](chatgpt-image://${fileIdMatch[0]})\n`;
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
