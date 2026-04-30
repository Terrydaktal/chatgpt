import { useState, useEffect, useRef, memo, useCallback } from 'react';
import type { Conversation, Message } from './types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import './index.css';

const MarkdownMessage = memo(({ content }: { content: string }) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ node, inline, className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className || '');
          return !inline && match ? (
            <SyntaxHighlighter
              style={vscDarkPlus as any}
              language={match[1]}
              PreTag="div"
              codeTagProps={{ style: { fontSize: 'inherit' } }}
              customStyle={{ margin: 0, padding: 0, background: 'transparent', fontSize: 'inherit' }}
              {...props}
            >
              {String(children).replace(/\n$/, '')}
            </SyntaxHighlighter>
          ) : (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

const MessageRow = memo(({ msg }: { msg: Message }) => {
  return (
    <div className={`message-row ${msg.role}`}>
      <div className="message-content">
        <div className="role-label">{msg.role === 'user' ? 'You' : 'ChatGPT'}</div>
        <div className="markdown-body">
          <MarkdownMessage content={msg.content} />
        </div>
      </div>
    </div>
  );
});

const ConversationItem = memo(({ conv, active, onClick }: { conv: Conversation, active: boolean, onClick: () => void }) => {
  return (
    <div 
      className={`conversation-item ${active ? 'active' : ''}`}
      onClick={onClick}
    >
      {conv.title || 'New Chat'}
    </div>
  );
});

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(localStorage.getItem('lastConvId'));
  const [messages, setMessages] = useState<Message[]>([]);
  const [isAuth, setIsAuth] = useState<boolean | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [model, setModel] = useState<'auto' | 'thinking'>((localStorage.getItem('selectedModel') as any) || 'auto');
  const [thinkingMode, setThinkingMode] = useState<'standard' | 'extended'>((localStorage.getItem('thinkingMode') as any) || 'standard');
  const [pastedImage, setPastedImage] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');

  const [fontSize, setFontSize] = useState<number>(Number(localStorage.getItem('fontSize')) || 12);
  const [chatWidth, setChatWidth] = useState<number>(Number(localStorage.getItem('chatWidth')) || 800);
  const [showSettings, setShowSettings] = useState(false);

  const [hasMoreConvs, setHasMoreConvs] = useState(true);
  const [isLoadingMoreConvs, setIsLoadingMoreConvs] = useState(false);

  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panCurrent = useRef({ x: 0, y: 0 });
  const panRaf = useRef<number | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const activeConvIdRef = useRef<string | null>(localStorage.getItem('lastConvId'));

  useEffect(() => {
    localStorage.setItem('selectedModel', model);
  }, [model]);

  useEffect(() => {
    localStorage.setItem('thinkingMode', thinkingMode);
  }, [thinkingMode]);

  useEffect(() => {
    localStorage.setItem('fontSize', fontSize.toString());
    document.documentElement.style.setProperty('--app-font-size', `${fontSize}pt`);
  }, [fontSize]);

  useEffect(() => {
    localStorage.setItem('chatWidth', chatWidth.toString());
    document.documentElement.style.setProperty('--message-max-width', `${chatWidth}px`);
  }, [chatWidth]);

  useEffect(() => {
    if (activeConvId) {
      localStorage.setItem('lastConvId', activeConvId);
      activeConvIdRef.current = activeConvId;
    } else {
      localStorage.removeItem('lastConvId');
      activeConvIdRef.current = null;
    }
  }, [activeConvId]);

  useEffect(() => {
    if (!isPanning) {
      if (panRaf.current) cancelAnimationFrame(panRaf.current);
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      panCurrent.current = { x: e.clientX, y: e.clientY };
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 1) setIsPanning(false);
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('mouseup', handleMouseUp, { passive: true });

    const scrollLoop = () => {
      if (scrollerRef.current) {
        const dy = panCurrent.current.y - panStart.current.y;
        if (Math.abs(dy) > 5) {
          const speed = (dy - Math.sign(dy) * 5) * 0.15;
          scrollerRef.current.scrollBy(0, speed);
        }
      }
      panRaf.current = requestAnimationFrame(scrollLoop);
    };

    panRaf.current = requestAnimationFrame(scrollLoop);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (panRaf.current) cancelAnimationFrame(panRaf.current);
    };
  }, [isPanning]);

  useEffect(() => {
    checkAuth().then(() => {
      const savedId = localStorage.getItem('lastConvId');
      if (savedId) {
        selectConversation(savedId, true);
      }
    });

    const handleGlobalPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.indexOf('image') !== -1) {
            const blob = items[i].getAsFile();
            if (blob) {
              const reader = new FileReader();
              reader.onload = (event) => {
                setPastedImage(event.target?.result as string);
              };
              reader.readAsDataURL(blob);
            }
          }
        }
      }
    };

    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, []);

  const handleSend = async () => {
    if (!inputValue.trim() && !pastedImage) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      conversation_id: activeConvId || '',
      role: 'user',
      content: inputValue,
      created_at: Date.now() / 1000,
    };

    setMessages(prev => [...prev, userMsg]);
    setInputValue('');
    const currentImage = pastedImage;
    setPastedImage(null);

    try {
      await window.electronAPI.invoke('api:sendMessage', {
        conversationId: activeConvId,
        content: userMsg.content,
        model: model === 'auto' ? 'auto' : (thinkingMode === 'extended' ? 'o1' : 'o1-mini'),
        parentMessageId: messages.length > 0 ? messages[messages.length - 1].id : undefined,
        image: currentImage
      });
      
      if (activeConvId) {
        const updatedMsgs = await window.electronAPI.invoke('api:syncMessages', activeConvId);
        setMessages(updatedMsgs);
      } else {
        loadConversations();
      }
    } catch (error) {
      console.error('Failed to send message', error);
    }
  };

  const checkAuth = async () => {
    const authed = await window.electronAPI.invoke('auth:check');
    setIsAuth(authed);
    if (authed) {
      loadConversations();
    }
  };

  const handleLogin = async () => {
    const success = await window.electronAPI.invoke('auth:login');
    if (success) {
      setIsAuth(true);
      loadConversations();
    }
  };

  const loadConversations = async () => {
    // 1. Load from DB first
    const localConvs = await window.electronAPI.invoke('db:getConversations');
    setConversations(localConvs);
    
    // 2. Sync first page from API
    try {
      const result = await window.electronAPI.invoke('api:syncConversations', { offset: 0, limit: 20 });
      setConversations(result.conversations);
      setHasMoreConvs(result.hasMore);
    } catch (e) {
      console.error('Failed to sync conversations', e);
    }
  };

  const loadMoreConversations = useCallback(async () => {
    if (isLoadingMoreConvs || !hasMoreConvs) return;

    setIsLoadingMoreConvs(true);
    try {
      // Offset is current synced count from API perspective, but we can just use length
      const result = await window.electronAPI.invoke('api:syncConversations', { 
        offset: conversations.length, 
        limit: 20 
      });
      setConversations(result.conversations);
      setHasMoreConvs(result.hasMore);
    } catch (e) {
      console.error('Failed to load more conversations', e);
    } finally {
      setIsLoadingMoreConvs(false);
    }
  }, [conversations.length, hasMoreConvs, isLoadingMoreConvs]);

  const selectConversation = async (id: string, forceSync = false) => {
    if (id === activeConvId && !forceSync) return;
    
    setActiveConvId(id);
    activeConvIdRef.current = id;
    
    const localMsgs = await window.electronAPI.invoke('db:getMessages', id);
    setMessages(localMsgs);

    setIsSyncing(true);
    window.electronAPI.invoke('api:syncMessages', id)
      .then((syncedMsgs: Message[]) => {
        if (activeConvIdRef.current === id) {
          setMessages(prev => {
            if (JSON.stringify(prev) === JSON.stringify(syncedMsgs)) return prev;
            return syncedMsgs;
          });
        }
      })
      .catch((error) => console.error('Failed to sync messages', error))
      .finally(() => {
        if (activeConvIdRef.current === id) setIsSyncing(false);
      });
  };

  const startPanning = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY };
      panCurrent.current = { x: e.clientX, y: e.clientY };
    }
  };

  if (isAuth === null) {
    return <div className="auth-overlay">Loading...</div>;
  }

  if (isAuth === false) {
    return (
      <div className="auth-overlay">
        <h1>ChatGPT Desktop</h1>
        <p>Please log in to your ChatGPT Plus account</p>
        <button className="login-btn" onClick={handleLogin}>Login with Browser</button>
      </div>
    );
  }

  return (
    <div className="app-container">
      {isPanning && (
        <div className="pan-overlay">
          <div className="pan-center" style={{ left: panStart.current.x, top: panStart.current.y }} />
        </div>
      )}
      <div className="sidebar">
        <div className="sidebar-header">
          <button className="new-chat-btn" onClick={() => {
            setActiveConvId(null);
            setMessages([]);
            activeConvIdRef.current = null;
          }}>+ New Chat</button>
        </div>
        <div className="conversations-list">
          <Virtuoso
            data={conversations}
            endReached={loadMoreConversations}
            itemContent={(_index, conv) => (
              <ConversationItem 
                key={conv.id}
                conv={conv}
                active={activeConvId === conv.id}
                onClick={() => selectConversation(conv.id)}
              />
            )}
            components={{
              Footer: () => isLoadingMoreConvs ? (
                <div style={{ padding: '10px', textAlign: 'center', fontSize: '12px', color: '#c5c5d2' }}>Loading more...</div>
              ) : null
            }}
          />
        </div>
        <div className="sidebar-footer">
          <button className="settings-btn" onClick={() => setShowSettings(true)}>
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
            Settings
          </button>
        </div>
      </div>
      
      <div className="main-content">
        <div className="toolbar">
          <div className="model-selector">
            <button 
              className={model === 'auto' ? 'active' : ''} 
              onClick={() => setModel('auto')}
            >Auto</button>
            <button 
              className={model === 'thinking' ? 'active' : ''} 
              onClick={() => setModel('thinking')}
            >Thinking</button>
          </div>
          {model === 'thinking' && (
            <div className="thinking-selector">
              <button 
                className={thinkingMode === 'standard' ? 'active' : ''} 
                onClick={() => setThinkingMode('standard')}
              >Standard (o1-mini)</button>
              <button 
                className={thinkingMode === 'extended' ? 'active' : ''} 
                onClick={() => setThinkingMode('extended')}
              >Extended (o1)</button>
            </div>
          )}
          <button className="sync-btn" onClick={() => activeConvId && selectConversation(activeConvId, true)} title="Sync current chat">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
          </button>
        </div>

        {isSyncing && <div className="sync-indicator">Syncing...</div>}
        <div className="messages-container" onMouseDown={startPanning}>
          <Virtuoso
            ref={virtuosoRef}
            scrollerRef={(el) => scrollerRef.current = el as HTMLElement}
            data={messages}
            initialTopMostItemIndex={messages.length > 0 ? messages.length - 1 : 0}
            followOutput="auto"
            itemContent={(_index, msg) => (
              <MessageRow key={msg.id} msg={msg} />
            )}
          />
        </div>

        <div className="input-area">
          <div className="input-container">
            {pastedImage && (
              <div className="image-preview">
                <img src={pastedImage} alt="Pasted" />
                <button className="remove-image" onClick={() => setPastedImage(null)}>×</button>
              </div>
            )}
            <div className="input-wrapper">
              <textarea 
                className="chat-input" 
                placeholder="Send a message..." 
                rows={1}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              <button className="send-btn" onClick={handleSend} disabled={!inputValue.trim() && !pastedImage}>
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="settings-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Settings</h2>
              <button className="close-modal" onClick={() => setShowSettings(false)}>×</button>
            </div>
            <div className="setting-item">
              <label>
                Font Size <span className="setting-value">{fontSize}pt</span>
              </label>
              <input 
                type="range" 
                min="8" 
                max="20" 
                value={fontSize} 
                onChange={(e) => setFontSize(parseInt(e.target.value))} 
              />
            </div>
            <div className="setting-item">
              <label>
                Chat Column Width <span className="setting-value">{chatWidth}px</span>
              </label>
              <input 
                type="range" 
                min="400" 
                max="5000" 
                step="50"
                value={chatWidth} 
                onChange={(e) => setChatWidth(parseInt(e.target.value))} 
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
