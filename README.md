# ChatGPT Desktop (Electron + React)

A local-first desktop client for ChatGPT that uses your web session, caches chats in SQLite, renders markdown/code/math, and includes advanced navigation/caching tools for large chat histories.

## What This Tool Is

This app is an Electron desktop wrapper around ChatGPT with:
- Browser-based login to your ChatGPT account (Plus expected by project intent).
- Local conversation/message cache in SQLite for fast browsing and search.
- Explicit sync controls (manual sync and cache-all/retry flows) instead of always-live sync.
- Image support through a custom `chatgpt-image://` protocol resolved in Electron main process.
- Fullscreen image viewer with context menu copy-to-clipboard.
- Markdown + code highlighting + KaTeX math rendering.
- A right-side Message Map for in-chat navigation.

## Tech Stack

- Electron (main process, IPC, custom protocol, auth fetch)
- React 19 + TypeScript
- Vite (renderer build/dev server)
- better-sqlite3 (local persistence)
- react-markdown + remark-gfm + remark-math + rehype-katex
- react-virtuoso (virtualized lists)

## Project Structure

```text
.
├── electron/
│   ├── main.cjs         # Electron main process, IPC handlers, protocol, ChatGPT API integration
│   ├── auth.cjs         # Session/token acquisition + authenticated fetch helper
│   ├── database.cjs     # SQLite schema, migrations, query helpers
│   └── preload.cjs      # Safe renderer bridge (window.electronAPI)
├── src/
│   ├── App.tsx          # Main UI and interaction logic
│   ├── index.css        # App styles
│   ├── main.tsx         # React bootstrap
│   ├── types/index.ts   # Shared TS interfaces and window typing
│   ├── components/      # Reserved for extracted UI modules
│   ├── hooks/           # Reserved for extracted hooks
│   ├── services/        # Reserved for extracted services
│   └── assets/          # Static renderer assets
├── public/
│   ├── favicon.svg
│   └── icons.svg
├── dist/                # Renderer production build output
├── package.json
├── vite.config.ts
├── tsconfig*.json
└── README.md
```

## Core Features

- Auth and session reuse:
  - Login window loads `https://chatgpt.com/auth/login`.
  - Access token is fetched from `https://chatgpt.com/api/auth/session` and reused.

- Conversation and message sync:
  - Conversation list syncs from ChatGPT API with pagination.
  - Message sync pulls `conversation/{id}` mapping, upserts local DB, and computes linear path.
  - Cooldown throttles repeated message syncs per conversation.

- Local cache diagnostics:
  - Displays cached vs local counts.
  - Tracks uncached chats, failed cache attempts, and unknown uncached cases.
  - Supports `Cache All` and `Retry failed` passes with retry/backoff for transient API failures.

- Image handling:
  - Image markdown references use `chatgpt-image://file_xxx?...`.
  - Electron main resolves image bytes with authenticated fetch and relaxed response headers.
  - Renderer fallback can request image as data URL if direct protocol load fails.

- Fullscreen image mode:
  - Click image to open fullscreen.
  - Right-click image for context menu with `Copy image`.
  - `Esc` closes menu/overlay.

- Message navigation:
  - Right-side Message Map lists user/assistant messages with compact previews.
  - Click to jump a message to top of viewport.
  - Active map item tracks message intersecting viewport top edge.
  - Middle-click pan scrolling works in chat area and message map area.

- Rich content rendering:
  - Markdown tables/lists/checklists via GFM.
  - Syntax-highlighted code blocks.
  - Math rendering via KaTeX, including normalization of `\(...\)` and `\[...\]` delimiters.

## Data Model (SQLite)

Database file:
- `app.getPath('userData')/chatgpt.db`

Tables:
- `conversations`
  - `id` (PK), `title`, `created_at`, `updated_at`, `current_node_id`, `is_deleted_on_web`
- `messages`
  - `id` (PK), `conversation_id` (FK), `role`, `content`, `created_at`, `parent_id`
- `cache_failures`
  - `conversation_id` (PK/FK), `last_error`, `status_code`, `last_attempt_at`, `attempt_count`

## Renderer/Main Process Interface (IPC)

Preload exposes:
- `window.electronAPI.invoke(channel, ...args)`
- `window.electronAPI.onCacheProgress(handler)`

Primary handlers in `electron/main.cjs`:
- Auth:
  - `auth:login`
  - `auth:check`
- DB/UI data:
  - `db:getConversations`
  - `db:deleteConversation`
  - `db:getMessages`
  - `db:searchMessages`
  - `db:getStats`
  - `db:getCacheDiagnostics`
- Sync/cache:
  - `api:syncConversations`
  - `api:syncMessages`
  - `api:cacheAll`
  - `api:cacheFailed`
  - `api:auditDeletions`
- Messaging and media:
  - `api:sendMessage`
  - `api:getImageDataUrl`
  - `api:copyImageToClipboard`

Progress events:
- `api:cacheProgress`

## Custom Protocol

- Scheme: `chatgpt-image://`
- Registered as privileged (`standard`, `secure`, `supportFetchAPI`, `bypassCSP`).
- Used to fetch chat image bytes in main process under authenticated session.

## Scripts

- `npm run dev`
  - Starts Vite renderer dev server only.
  - Input: source files in `src/`, Vite config.
  - Output: hot-reloaded renderer at `http://localhost:5173`.

- `npm run electron:dev`
  - Starts renderer dev server and Electron app together.
  - Input: all renderer + Electron files.
  - Output: desktop app pointing to local Vite URL.

- `npm run build`
  - Type-check/build renderer for production.
  - Input: TypeScript + assets.
  - Output: `dist/` renderer bundle.

- `npm run preview`
  - Serves built renderer bundle locally.
  - Input: `dist/`.
  - Output: local preview HTTP server.

- `npm run lint`
  - Lints codebase with configured ESLint rules.

## Execution Pipeline and Order

Development flow:
1. Run `npm install`.
2. Run `npm run electron:dev`.
3. Login via in-app browser window.
4. App loads local conversations, then syncs conversations from API.
5. Select chat to load local messages; manual sync updates from API.
6. Use Message Map/search/cache tools as needed.

Cache synchronization flow:
1. `api:cacheAll` or `api:cacheFailed` enumerates target conversations.
2. Each uncached target calls conversation API.
3. Mapping nodes are transformed/upserted into `messages`.
4. Failures are written to `cache_failures` with retry metadata.
5. Renderer receives `api:cacheProgress` updates.

Image rendering flow:
1. Message markdown contains `![Chat Image](chatgpt-image://file_...?... )`.
2. Renderer `<img>` requests custom protocol URL.
3. Main process resolves with authenticated fetch and returns bytes.
4. If renderer load fails, fallback `api:getImageDataUrl` is requested.

## Inputs and Outputs Summary

Inputs:
- ChatGPT web session/cookies/token.
- Conversation/message payloads from ChatGPT backend APIs.
- User prompts and optional pasted image data URLs.

Outputs:
- Desktop UI for chat browsing and composition.
- Local SQLite cache (`chatgpt.db`).
- Renderer build artifacts in `dist/`.
- Clipboard image data when copying fullscreen images.

## Notes

- This project relies on ChatGPT web endpoints and your authenticated session.
- Manual sync behavior is intentional for predictable local state control.
- KaTeX assets increase build output size due to font files.
