import { useState, useEffect, useRef, memo } from 'react';
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

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const activeConvIdRef = useRef<string | null>(localStorage.getItem('lastConvId'));

  useEffect(() => {
    localStorage.setItem('selectedModel', model);
  }, [model]);

  useEffect(() => {
    localStorage.setItem('thinkingMode', thinkingMode);
  }, [thinkingMode]);

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

    // Optimistically add to UI
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
    const localConvs = await window.electronAPI.invoke('db:getConversations');
    setConversations(localConvs);
    
    try {
      const syncedConvs = await window.electronAPI.invoke('api:syncConversations');
      setConversations(syncedConvs);
    } catch (error) {
      console.error('Failed to sync conversations', error);
    }
  };

  const selectConversation = async (id: string, forceSync = false) => {
    if (id === activeConvId && !forceSync) return;
    
    setActiveConvId(id);
    activeConvIdRef.current = id;
    
    // 1. Load from local cache instantly
    const localMsgs = await window.electronAPI.invoke('db:getMessages', id);
    setMessages(localMsgs);

    // 2. Sync from API in background
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
      <div className="sidebar">
        <div className="sidebar-header">
          <button className="new-chat-btn" onClick={() => {
            setActiveConvId(null);
            setMessages([]);
            activeConvIdRef.current = null;
          }}>+ New Chat</button>
        </div>
        <div className="conversations-list">
          {conversations.map(conv => (
            <div 
              key={conv.id} 
              className={`conversation-item ${activeConvId === conv.id ? 'active' : ''}`}
              onClick={() => selectConversation(conv.id)}
            >
              {conv.title || 'New Chat'}
            </div>
          ))}
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
        <div className="messages-container">
          <Virtuoso
            ref={virtuosoRef}
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
    </div>
  );
}

export default App;
