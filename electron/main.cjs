const { app, BrowserWindow, ipcMain } = require('electron');
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

  auth.mainWindow = mainWindow;

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools();
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

  ipcMain.handle('db:getMessages', async (event, conversationId) => {
    return getLinearMessages(conversationId);
  });

  const lastSync = new Map();

  ipcMain.handle('api:syncConversations', async (event, { offset = 0, limit = 20 } = {}) => {
    try {
      const response = await auth.fetchWithAuth(`https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`);
      const data = await response.json();
      
      if (data.items) {
        db.db.transaction(() => {
          data.items.forEach(item => {
            // Get existing to preserve current_node_id if we have it
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
      
      // 1. Save user message to local DB immediately
      db.upsertMessage({
        id: messageId,
        conversation_id: conversationId,
        role: 'user',
        content: content,
        created_at: Date.now() / 1000,
        parent_id: parentMessageId
      });

      // 2. Prepare API payload
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
                  asset_pointer: 'file-service://' + image.split(',')[1], // Simple placeholder logic for multimodal
                  size_bytes: Math.round((image.length * 3) / 4),
                  width: 512, height: 512 // Placeholders
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

      // Note: Full multimodal handling often requires uploading to /backend-api/files first.
      // For this implementation, we will focus on the text and model selection logic.
      // If an image is provided but not uploaded, the API might reject it.
      // We'll proceed with the request.

      const response = await auth.fetchWithAuth('https://chatgpt.com/backend-api/conversation', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('API Send Error:', errText);
        throw new Error(`Failed to send message: ${response.status}`);
      }

      // For now, we return success and let the sync process handle the response node.
      // In a more advanced version, we would parse the SSE stream here.
      return { success: true };
    } catch (error) {
      console.error('Send message failed:', error);
      throw error;
    }
  });

  ipcMain.handle('api:syncMessages', async (event, conversationId) => {
    // Basic cooldown: don't sync the same conversation more than once every 30 seconds
    const now = Date.now();
    if (lastSync.has(conversationId) && now - lastSync.get(conversationId) < 30000) {
      return getLinearMessages(conversationId);
    }

    try {
      const response = await auth.fetchWithAuth(`https://chatgpt.com/backend-api/conversation/${conversationId}`);
      const data = await response.json();
      
      if (data.mapping) {
        db.db.transaction(() => {
          // Update conversation with current_node_id
          const convs = db.getConversations();
          const existingConv = convs.find(c => c.id === conversationId);
          if (existingConv) {
            db.upsertConversation({
              ...existingConv,
              current_node_id: data.current_node
            });
          }

          Object.values(data.mapping).forEach(node => {
            if (node.message && node.message.content) {
              const parts = node.message.content.parts || [];
              const content = parts.filter(p => typeof p === 'string').join('\n');
              
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

app.whenReady().then(() => {
  auth = new ChatGPTAuth(null);
  db = new ChatDatabase();
  setupIpc();
  
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
