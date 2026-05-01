const { session, BrowserWindow } = require('electron');

class ChatGPTAuth {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.authWindow = null;
    this.accessToken = null;
  }

  async login() {
    if (this.authWindow) return;

    return new Promise((resolve) => {
      this.authWindow = new BrowserWindow({
        width: 800,
        height: 900,
        title: 'Login to ChatGPT',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      // Handle popups (Google/Apple login often use them)
      this.authWindow.webContents.setWindowOpenHandler(({ url }) => {
        return { action: 'allow' };
      });

      this.authWindow.loadURL('https://chatgpt.com/auth/login');

      const checkAuth = async () => {
        try {
          // Check if we can get a session via the internal endpoint
          const sessionResp = await session.defaultSession.fetch('https://chatgpt.com/api/auth/session');
          if (sessionResp.ok) {
            const data = await sessionResp.json();
            if (data.accessToken) {
              this.accessToken = data.accessToken;
              console.log('Successfully captured access token');
              if (this.authWindow) {
                this.authWindow.close();
              }
              resolve(true);
              return;
            }
          }
        } catch (e) {
          // Not logged in yet or network error
        }
      };

      this.authWindow.webContents.on('did-finish-load', checkAuth);
      this.authWindow.webContents.on('did-navigate', checkAuth);
      
      this.authWindow.on('closed', () => {
        this.authWindow = null;
        resolve(!!this.accessToken);
      });
    });
  }

  async getAccessToken() {
    if (!this.accessToken) {
      try {
        const sessionResp = await session.defaultSession.fetch('https://chatgpt.com/api/auth/session');
        if (sessionResp.ok) {
          const data = await sessionResp.json();
          this.accessToken = data.accessToken;
        }
      } catch (e) {
        console.error('Failed to get session token:', e);
      }
    }
    return this.accessToken;
  }

  async fetchWithAuth(url, options = {}) {
    const token = await this.getAccessToken();
    if (!token) throw new Error('Not authenticated');

    const headers = {
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    };

    const hasContentType = Object.keys(headers).some(
      key => key.toLowerCase() === 'content-type'
    );
    if (options.body && !hasContentType) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await session.defaultSession.fetch(url, {
      ...options,
      headers,
    });

    return response;
  }
}

module.exports = ChatGPTAuth;
