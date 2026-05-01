const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

class ChatDatabase {
  constructor() {
    const dbPath = path.join(app.getPath('userData'), 'chatgpt.db');
    this.db = new Database(dbPath);
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at DATETIME,
        updated_at DATETIME,
        current_node_id TEXT,
        is_deleted_on_web INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        role TEXT,
        content TEXT,
        created_at DATETIME,
        parent_id TEXT,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );

      CREATE TABLE IF NOT EXISTS cache_failures (
        conversation_id TEXT PRIMARY KEY,
        last_error TEXT,
        status_code INTEGER,
        last_attempt_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        attempt_count INTEGER DEFAULT 1,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    `);

    // Migrations
    const tableInfo = this.db.prepare("PRAGMA table_info(conversations)").all();
    
    const hasCurrentNode = tableInfo.some(col => col.name === 'current_node_id');
    if (!hasCurrentNode) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN current_node_id TEXT");
    }

    const hasDeletedOnWeb = tableInfo.some(col => col.name === 'is_deleted_on_web');
    if (!hasDeletedOnWeb) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN is_deleted_on_web INTEGER DEFAULT 0");
    }
  }

  getConversations() {
    return this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all();
  }

  getConversation(id) {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  }

  getMessages(conversationId) {
    return this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId);
  }

  getLinearPath(currentNodeId) {
    return this.db.prepare(`
      WITH RECURSIVE chat_path(id, conversation_id, role, content, created_at, parent_id) AS (
        SELECT id, conversation_id, role, content, created_at, parent_id
        FROM messages
        WHERE id = ?
        UNION ALL
        SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, m.parent_id
        FROM messages m
        JOIN chat_path cp ON m.id = cp.parent_id
      )
      SELECT * FROM chat_path ORDER BY created_at ASC
    `).all(currentNodeId);
  }

  upsertConversation(conv) {
    const stmt = this.db.prepare(`
      INSERT INTO conversations (id, title, created_at, updated_at, current_node_id, is_deleted_on_web)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        updated_at = excluded.updated_at,
        current_node_id = excluded.current_node_id,
        is_deleted_on_web = excluded.is_deleted_on_web
    `);
    stmt.run(conv.id, conv.title, conv.created_at, conv.updated_at, conv.current_node_id, conv.is_deleted_on_web || 0);
  }

  markAsDeletedOnWeb(id) {
    this.db.prepare('UPDATE conversations SET is_deleted_on_web = 1 WHERE id = ?').run(id);
  }

  deleteConversation(id) {
    const deleteMsgs = this.db.prepare('DELETE FROM messages WHERE conversation_id = ?');
    const deleteConv = this.db.prepare('DELETE FROM conversations WHERE id = ?');
    
    this.db.transaction(() => {
      deleteMsgs.run(id);
      deleteConv.run(id);
    })();
  }

  upsertMessage(msg) {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, created_at, parent_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content
    `);
    stmt.run(msg.id, msg.conversation_id, msg.role, msg.content, msg.created_at, msg.parent_id);
  }

  searchMessages(query) {
    return this.db.prepare(`
      SELECT m.*, c.title as conversation_title
      FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE m.content LIKE ?
      ORDER BY m.created_at DESC
      LIMIT 100
    `).all(`%${query}%`);
  }

  upsertCacheFailure(conversationId, errorMessage, statusCode = null) {
    const stmt = this.db.prepare(`
      INSERT INTO cache_failures (conversation_id, last_error, status_code, last_attempt_at, attempt_count)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, 1)
      ON CONFLICT(conversation_id) DO UPDATE SET
        last_error = excluded.last_error,
        status_code = excluded.status_code,
        last_attempt_at = CURRENT_TIMESTAMP,
        attempt_count = cache_failures.attempt_count + 1
    `);
    stmt.run(conversationId, errorMessage || 'Unknown cache failure', statusCode);
  }

  clearCacheFailure(conversationId) {
    this.db.prepare('DELETE FROM cache_failures WHERE conversation_id = ?').run(conversationId);
  }

  getCacheDiagnostics(limit = 50) {
    const summary = this.db.prepare(`
      WITH conv AS (
        SELECT id FROM conversations WHERE IFNULL(is_deleted_on_web, 0) = 0
      ),
      cached AS (
        SELECT DISTINCT conversation_id AS id FROM messages
      ),
      uncached AS (
        SELECT conv.id
        FROM conv
        LEFT JOIN cached ON cached.id = conv.id
        WHERE cached.id IS NULL
      )
      SELECT
        (SELECT COUNT(*) FROM conv) AS local_count,
        (SELECT COUNT(*) FROM conv JOIN cached ON cached.id = conv.id) AS cached_count,
        (SELECT COUNT(*) FROM uncached) AS uncached_count,
        (SELECT COUNT(*) FROM uncached JOIN cache_failures cf ON cf.conversation_id = uncached.id) AS failed_count
    `).get();

    const rows = this.db.prepare(`
      SELECT
        c.id,
        c.title,
        c.updated_at,
        cf.last_error,
        cf.status_code,
        cf.last_attempt_at,
        cf.attempt_count
      FROM conversations c
      LEFT JOIN cache_failures cf ON cf.conversation_id = c.id
      WHERE IFNULL(c.is_deleted_on_web, 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM messages m WHERE m.conversation_id = c.id
        )
      ORDER BY c.updated_at DESC
      LIMIT ?
    `).all(limit);

    const failedCount = Number(summary.failed_count || 0);
    const uncachedCount = Number(summary.uncached_count || 0);
    return {
      localCount: Number(summary.local_count || 0),
      cachedCount: Number(summary.cached_count || 0),
      uncachedCount,
      failedCount,
      unknownCount: Math.max(0, uncachedCount - failedCount),
      rows,
    };
  }
}

module.exports = ChatDatabase;
