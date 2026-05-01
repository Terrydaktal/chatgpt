import React, { useState, useEffect, useRef, memo, useCallback } from 'react';
import type { Conversation, Message } from './types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import 'katex/dist/katex.min.css';
import './index.css';

const escapeRegExp = (string: string) => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const getMessagePreview = (content: string) => {
  const normalized = content
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' [image] ')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '[empty]';
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
};

const normalizeMathDelimiters = (content: string) => {
  const segments = content.split(/(```[\s\S]*?```)/g);
  return segments
    .map((segment) => {
      if (segment.startsWith('```')) return segment;
      return segment
        .replace(/\\\[(.*?)\\\]/gs, (_match, expr: string) => `\n$$\n${expr.trim()}\n$$\n`)
        .replace(/\\\((.*?)\\\)/gs, (_match, expr: string) => `$${expr.trim()}$`);
    })
    .join('');
};

const isNavigableMessage = (msg: Message) =>
  (msg.role === 'user' || msg.role === 'assistant') && !!msg.content?.trim();

const HighlightText = ({ children, query }: { children: React.ReactNode, query: string }): any => {
  if (!query || !query.trim()) return children;
  const escapedQuery = escapeRegExp(query.trim());
  const regex = new RegExp(`(${escapedQuery})`, 'gi');
  
  return React.Children.map(children, child => {
    if (typeof child === 'string') {
      const parts = child.split(regex);
      return parts.map((part, i) => 
        part.toLowerCase() === query.trim().toLowerCase() 
          ? <mark key={i} className="chat-highlight">{part}</mark> 
          : part
      );
    }
    if (React.isValidElement(child) && (child.props as any).children) {
      return React.cloneElement(child, {
        children: <HighlightText query={query}>{(child.props as any).children}</HighlightText>
      } as any);
    }
    return child;
  });
};

const ChatImage = ({ src, alt, conversationId, onOpenImage, ...props }: any) => {
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(src);
  const [triedFallback, setTriedFallback] = useState(false);

  useEffect(() => {
    setResolvedSrc(src);
    setTriedFallback(false);
  }, [src]);

  const handleError = useCallback(async () => {
    if (triedFallback || !src || typeof src !== 'string' || !src.startsWith('chatgpt-image://')) return;
    setTriedFallback(true);
    const rawId = src.replace('chatgpt-image://', '').replace(/^\/+/, '');
    try {
      const dataUrl = await window.electronAPI.invoke('api:getImageDataUrl', { rawImageId: rawId, conversationId });
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
        setResolvedSrc(dataUrl);
      }
    } catch (error) {
      console.error('Image fallback failed:', error);
    }
  }, [src, conversationId, triedFallback]);

  const handleClick = useCallback(() => {
    if (resolvedSrc && onOpenImage) onOpenImage(resolvedSrc);
  }, [resolvedSrc, onOpenImage]);

  return <img src={resolvedSrc} alt={alt || 'Image'} loading="lazy" onError={handleError} onClick={handleClick} {...props} />;
};

const MarkdownMessage = memo(({ content, highlightQuery, conversationId, onOpenImage }: { content: string, highlightQuery?: string, conversationId?: string, onOpenImage?: (src: string) => void }) => {
  const query = highlightQuery || '';
  const renderedContent = normalizeMathDelimiters(content);
  return (
    <ReactMarkdown
      urlTransform={(value: string) => value}
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        p: ({ children, ...props }) => <p {...props}><HighlightText query={query}>{children}</HighlightText></p>,
        li: ({ children, ...props }) => <li {...props}><HighlightText query={query}>{children}</HighlightText></li>,
        h1: ({ children, ...props }) => <h1 {...props}><HighlightText query={query}>{children}</HighlightText></h1>,
        h2: ({ children, ...props }) => <h2 {...props}><HighlightText query={query}>{children}</HighlightText></h2>,
        h3: ({ children, ...props }) => <h3 {...props}><HighlightText query={query}>{children}</HighlightText></h3>,
        img: ({ src, alt, ...props }: any) => {
          return <ChatImage src={src} alt={alt} conversationId={conversationId} onOpenImage={onOpenImage} {...props} />;
        },
        code({ inline, className, children, ...props }: any) {
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
      {renderedContent}
    </ReactMarkdown>
  );
});

const MessageRow = memo(({ msg, highlightQuery, isTarget, onOpenImage }: { msg: Message, highlightQuery?: string, isTarget?: boolean, onOpenImage?: (src: string) => void }) => {
  return (
    <div className={`message-row ${msg.role} ${isTarget ? 'highlight-target' : ''}`} data-message-id={msg.id}>
      <div className="message-content">
        <div className="role-label">{msg.role === 'user' ? 'You' : 'ChatGPT'}</div>
        <div className="markdown-body">
          <MarkdownMessage content={msg.content} highlightQuery={isTarget ? highlightQuery : undefined} conversationId={msg.conversation_id} onOpenImage={onOpenImage} />
        </div>
      </div>
    </div>
  );
});

const ConversationItem = memo(({ conv, active, onClick, onDelete }: { conv: Conversation, active: boolean, onClick: () => void, onDelete: (e: React.MouseEvent) => void }) => {
  return (
    <div 
      className={`conversation-item ${active ? 'active' : ''} ${conv.is_deleted_on_web ? 'local-only' : ''}`}
      onClick={onClick}
    >
      <div className="conv-item-content">
        <span className="conv-title">{conv.title || 'New Chat'}</span>
        {conv.is_deleted_on_web ? <span className="local-badge" title="This chat was deleted on the web but is preserved locally">Local</span> : null}
        <button className="delete-conv-btn" onClick={onDelete} title="Delete locally">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
          </svg>
        </button>
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
  const [selectedModel, setSelectedModel] = useState<string>(localStorage.getItem('selectedModel') || 'Auto');
  const [pastedImage, setPastedImage] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');

  const [fontSize, setFontSize] = useState<number>(Number(localStorage.getItem('fontSize')) || 12);
  const [chatWidth, setChatWidth] = useState<number>(Number(localStorage.getItem('chatWidth')) || 800);
  const [showSettings, setShowSettings] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [targetMessageId, setTargetMessageId] = useState<string | null>(null);
  const [activeHighlightQuery, setActiveHighlightQuery] = useState('');
  const [isMessageMapOpen, setIsMessageMapOpen] = useState<boolean>(() => localStorage.getItem('messageMapOpen') !== '0');
  const [viewportNavMessageId, setViewportNavMessageId] = useState<string | null>(null);
  const [messageScrollerEl, setMessageScrollerEl] = useState<HTMLElement | null>(null);

  const [hasMoreConvs, setHasMoreConvs] = useState(true);
  const [isLoadingMoreConvs, setIsLoadingMoreConvs] = useState(false);
  const [cacheStats, setCacheStats] = useState({ localCount: 0, cachedCount: 0 });
  const [cacheDiagnostics, setCacheDiagnostics] = useState({ uncachedCount: 0, failedCount: 0, unknownCount: 0 });
  const [isCachingAll, setIsCachingAll] = useState(false);

  const [isPanning, setIsPanning] = useState(false);
  const [panPosition, setPanPosition] = useState({ x: 0, y: 0 });
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);
  const [imageMenu, setImageMenu] = useState<{ x: number; y: number } | null>(null);
  const panStart = useRef({ x: 0, y: 0 });
  const panCurrent = useRef({ x: 0, y: 0 });
  const panRaf = useRef<number | null>(null);
  const panScrollTargetRef = useRef<HTMLElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const activeConvIdRef = useRef<string | null>(localStorage.getItem('lastConvId'));
  const hasScrolledToBottomRef = useRef<Record<string, boolean>>({});
  const virtuosoStateByConversationRef = useRef<Record<string, any>>({});
  const [restoreVirtuosoState, setRestoreVirtuosoState] = useState<any | null>(null);

  const saveVirtuosoState = useCallback((conversationId: string | null) => {
    if (!conversationId || !virtuosoRef.current?.getState) return;
    virtuosoRef.current.getState((state: any) => {
      virtuosoStateByConversationRef.current[conversationId] = state;
    });
  }, []);

  const loadConversations = useCallback(async () => {
    const localConvs = await window.electronAPI.invoke('db:getConversations');
    setConversations(localConvs);
    try {
      const result = await window.electronAPI.invoke('api:syncConversations', { offset: 0, limit: 20 });
      setConversations(result.conversations);
      setHasMoreConvs(result.hasMore);
    } catch (e) {
      console.error('Failed to sync conversations', e);
    }
  }, []);

  const checkAuth = useCallback(async () => {
    const authed = await window.electronAPI.invoke('auth:check');
    setIsAuth(authed);
    if (authed) {
      loadConversations();
    }
  }, [loadConversations]);

  const handleLogin = async () => {
    const success = await window.electronAPI.invoke('auth:login');
    if (success) {
      setIsAuth(true);
      loadConversations();
    }
  };

  const loadMoreConversations = useCallback(async () => {
    if (isLoadingMoreConvs || !hasMoreConvs) return;
    setIsLoadingMoreConvs(true);
    try {
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

  const selectConversation = useCallback(async (id: string, forceSync = false, shouldSync = false) => {
    if (id === activeConvIdRef.current && !forceSync) return;

    if (activeConvIdRef.current && activeConvIdRef.current !== id) {
      saveVirtuosoState(activeConvIdRef.current);
    }

    setRestoreVirtuosoState(virtuosoStateByConversationRef.current[id] || null);
    setActiveConvId(id);
    activeConvIdRef.current = id;
    const localMsgs = await window.electronAPI.invoke('db:getMessages', id);
    setMessages(localMsgs);
    if (!shouldSync) {
      setIsSyncing(false);
      return;
    }
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
  }, [saveVirtuosoState]);

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
    const modelMap: Record<string, string> = {
      'Auto': 'auto', 'Instant 5.3': 'gpt-4o', 'Thinking 5.4 Standard': 'o1-mini',
      'Thinking 5.4 Extended': 'o1', 'Thinking 5.5 Standard': 'o3-mini', 'Thinking 5.5 Extended': 'o1',
    };
    try {
      await window.electronAPI.invoke('api:sendMessage', {
        conversationId: activeConvId,
        content: userMsg.content,
        model: modelMap[selectedModel] || 'auto',
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

  const handleSearch = async (q: string) => {
    setSearchQuery(q);
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }
    const results = await window.electronAPI.invoke('db:searchMessages', q);
    setSearchResults(results);
  };

  const jumpToMessage = (e: React.MouseEvent, convId: string, msgId: string) => {
    e.stopPropagation();
    setTargetMessageId(msgId);
    setActiveHighlightQuery(searchQuery);
    selectConversation(convId);
    setShowSearch(false);
  };

  const jumpToMessageInCurrentChat = useCallback((msgId: string) => {
    setTargetMessageId(msgId);
    setActiveHighlightQuery('');
  }, []);

  const handleDeleteConversation = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (window.confirm('Permanently delete this chat from your local database?')) {
      await window.electronAPI.invoke('db:deleteConversation', id);
      if (activeConvId === id) {
        setActiveConvId(null);
        setMessages([]);
      }
      loadConversations();
    }
  };

  const handleAudit = async () => {
    setIsSyncing(true);
    try {
      const result = await window.electronAPI.invoke('api:auditDeletions');
      if (result.success) {
        loadConversations();
        updateStats();
      }
    } catch (e) {
      console.error('Audit failed', e);
    } finally {
      setIsSyncing(false);
    }
  };

  const updateStats = useCallback(async () => {
    const stats = await window.electronAPI.invoke('db:getStats');
    setCacheStats(stats);
  }, []);

  const updateCacheDiagnostics = useCallback(async () => {
    const diagnostics = await window.electronAPI.invoke('db:getCacheDiagnostics');
    if (diagnostics) {
      setCacheDiagnostics({
        uncachedCount: Number(diagnostics.uncachedCount || 0),
        failedCount: Number(diagnostics.failedCount || 0),
        unknownCount: Number(diagnostics.unknownCount || 0),
      });
    }
  }, []);

  const handleCacheAll = async () => {
    if (isCachingAll) return;
    setIsCachingAll(true);
    try {
      await window.electronAPI.invoke('api:cacheAll');
      updateStats();
      updateCacheDiagnostics();
    } catch (e) {
      console.error('Cache All failed', e);
    } finally {
      setIsCachingAll(false);
    }
  };

  const handleRetryFailedCache = async () => {
    if (isCachingAll || cacheDiagnostics.failedCount === 0) return;
    setIsCachingAll(true);
    try {
      await window.electronAPI.invoke('api:cacheFailed');
      updateStats();
      updateCacheDiagnostics();
    } catch (e) {
      console.error('Retry failed-cache pass failed', e);
    } finally {
      setIsCachingAll(false);
    }
  };

  useEffect(() => {
    updateStats();
    updateCacheDiagnostics();
  }, [conversations, updateStats, updateCacheDiagnostics]);

  useEffect(() => {
    if (window.electronAPI.onCacheProgress) {
      window.electronAPI.onCacheProgress(() => {
        updateStats();
        updateCacheDiagnostics();
      });
    }
  }, [updateStats, updateCacheDiagnostics]);

  useEffect(() => {
    localStorage.setItem('selectedModel', selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    if (activeConvId && messages.length > 0) {
      if (targetMessageId) {
        const index = messages.findIndex(m => m.id === targetMessageId);
        if (index !== -1) {
          const timer = setTimeout(() => {
            virtuosoRef.current?.scrollToIndex({ index, align: 'start', behavior: 'auto' });
            hasScrolledToBottomRef.current[activeConvId] = true;
          }, 150);
          return () => clearTimeout(timer);
        }
      } else if (!hasScrolledToBottomRef.current[activeConvId] && !virtuosoStateByConversationRef.current[activeConvId]) {
        const timer = setTimeout(() => {
          virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, align: 'end', behavior: 'auto' });
          hasScrolledToBottomRef.current[activeConvId] = true;
        }, 100);
        return () => clearTimeout(timer);
      }
    }
  }, [messages, activeConvId, targetMessageId]);

  useEffect(() => {
    let timer: number;
    const clearHighlight = (e: MouseEvent) => {
      if (e.button === 0) {
        setTargetMessageId(null);
        setActiveHighlightQuery('');
      }
    };
    if (targetMessageId) {
      timer = window.setTimeout(() => {
        window.addEventListener('mousedown', clearHighlight);
      }, 1000);
    }
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousedown', clearHighlight);
    };
  }, [targetMessageId]);

  useEffect(() => {
    localStorage.setItem('fontSize', fontSize.toString());
    document.documentElement.style.setProperty('--app-font-size', `${fontSize}pt`);
  }, [fontSize]);

  useEffect(() => {
    localStorage.setItem('chatWidth', chatWidth.toString());
    document.documentElement.style.setProperty('--message-max-width', `${chatWidth}px`);
  }, [chatWidth]);

  useEffect(() => {
    localStorage.setItem('messageMapOpen', isMessageMapOpen ? '1' : '0');
  }, [isMessageMapOpen]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [inputValue]);

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
      panScrollTargetRef.current = null;
      return;
    }
    const handleMouseMove = (e: MouseEvent) => { panCurrent.current = { x: e.clientX, y: e.clientY }; };
    const handleMouseUp = (e: MouseEvent) => { if (e.button === 1) setIsPanning(false); };
    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('mouseup', handleMouseUp, { passive: true });
    const scrollLoop = () => {
      if (panScrollTargetRef.current) {
        const dy = panCurrent.current.y - panStart.current.y;
        if (Math.abs(dy) > 5) {
          const speed = (dy - Math.sign(dy) * 5) * 0.15;
          panScrollTargetRef.current.scrollBy(0, speed);
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
    if (fullscreenImage) setImageMenu(null);
  }, [fullscreenImage]);

  useEffect(() => {
    setViewportNavMessageId(null);
  }, [activeConvId]);

  useEffect(() => {
    if (!fullscreenImage) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (imageMenu) setImageMenu(null);
        else setFullscreenImage(null);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [fullscreenImage, imageMenu]);

  const handleCopyFullscreenImage = useCallback(async () => {
    if (!fullscreenImage) return;
    const result = await window.electronAPI.invoke('api:copyImageToClipboard', {
      src: fullscreenImage,
      conversationId: activeConvId || undefined,
    });
    if (!result?.success) {
      console.error('Copy image failed:', result?.error || 'unknown error');
    }
    setImageMenu(null);
  }, [fullscreenImage, activeConvId]);

  useEffect(() => {
    const init = async () => {
      await checkAuth();
      const savedId = localStorage.getItem('lastConvId');
      if (savedId) { selectConversation(savedId, true, true); }
    };
    init();
    const handleGlobalPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.indexOf('image') !== -1) {
            const blob = items[i].getAsFile();
            if (blob) {
              const reader = new FileReader();
              reader.onload = (event) => { setPastedImage(event.target?.result as string); };
              reader.readAsDataURL(blob);
            }
          }
        }
      }
    };
    window.addEventListener('paste', handleGlobalPaste);
    const handleClickOutside = (e: MouseEvent) => {
      if (showModelMenu && !(e.target as HTMLElement).closest('.model-picker-container')) {
        setShowModelMenu(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.removeEventListener('paste', handleGlobalPaste);
      window.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showModelMenu, checkAuth, selectConversation]);

  const startPanning = (e: React.MouseEvent, scrollTarget?: HTMLElement | null) => {
    if (e.button === 1) {
      e.preventDefault();
      setIsPanning(true);
      panScrollTargetRef.current = scrollTarget || scrollerRef.current;
      setPanPosition({ x: e.clientX, y: e.clientY });
      panStart.current = { x: e.clientX, y: e.clientY };
      panCurrent.current = { x: e.clientX, y: e.clientY };
    }
  };

  const updateViewportNavHighlight = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const viewportTop = scrollerRect.top;
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>('.message-row[data-message-id]'));
    const navigableIds = new Set(messages.filter(isNavigableMessage).map((m) => m.id));
    let nextId: string | null = null;

    for (const row of rows) {
      const msgId = row.dataset.messageId || null;
      if (!msgId || !navigableIds.has(msgId)) continue;
      const rect = row.getBoundingClientRect();
      if (rect.top <= viewportTop && rect.bottom > viewportTop) {
        nextId = msgId;
        break;
      }
    }

    if (!nextId) {
      for (const row of rows) {
        const msgId = row.dataset.messageId || null;
        if (!msgId || !navigableIds.has(msgId)) continue;
        const top = row.getBoundingClientRect().top;
        if (top >= scrollerRect.top) {
          nextId = msgId;
          break;
        }
      }
    }

    if (!nextId) {
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        const msgId = row.dataset.messageId || null;
        if (!msgId || !navigableIds.has(msgId)) continue;
        nextId = msgId;
        break;
      }
    }

    setViewportNavMessageId((prev) => (prev === nextId ? prev : nextId));
  }, [messages]);

  const handleMessageRangeChanged = useCallback(() => {
    updateViewportNavHighlight();
  }, [updateViewportNavHighlight]);

  useEffect(() => {
    if (!messageScrollerEl) return;
    let rafId: number | null = null;
    const scheduleHighlightUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateViewportNavHighlight();
      });
    };
    messageScrollerEl.addEventListener('scroll', scheduleHighlightUpdate, { passive: true });
    window.addEventListener('resize', scheduleHighlightUpdate, { passive: true });
    scheduleHighlightUpdate();
    return () => {
      messageScrollerEl.removeEventListener('scroll', scheduleHighlightUpdate);
      window.removeEventListener('resize', scheduleHighlightUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [messageScrollerEl, updateViewportNavHighlight]);

  useEffect(() => {
    const timer = window.setTimeout(() => updateViewportNavHighlight(), 0);
    return () => window.clearTimeout(timer);
  }, [messages, updateViewportNavHighlight]);

  if (isAuth === null) return <div className="auth-overlay">Loading...</div>;
  if (isAuth === false) return (
    <div className="auth-overlay">
      <h1>ChatGPT Desktop</h1>
      <p>Please log in to your ChatGPT Plus account</p>
      <button className="login-btn" onClick={handleLogin}>Login with Browser</button>
    </div>
  );

  const navigationMessages = messages
    .filter(isNavigableMessage)
    .map((m, i) => ({ ...m, navIndex: i + 1, preview: getMessagePreview(m.content) }));
  const activeMapMessageId = isMessageMapOpen ? viewportNavMessageId : targetMessageId;

  return (
    <div className="app-container">
      {isPanning && (
        <div className="pan-overlay">
          <div className="pan-center" style={{ left: panPosition.x, top: panPosition.y }} />
        </div>
      )}
      <div className="sidebar">
        <div className="sidebar-header">
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="new-chat-btn" onClick={() => { saveVirtuosoState(activeConvIdRef.current); setActiveConvId(null); setMessages([]); activeConvIdRef.current = null; setRestoreVirtuosoState(null); }}>+ New Chat</button>
            <button className="search-trigger-btn" onClick={() => setShowSearch(true)} title="Search Chats">
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
            </button>
          </div>
        </div>
        <div className="conversations-list">
          <Virtuoso data={conversations} endReached={loadMoreConversations} 
            itemContent={(_index, conv) => (
              <ConversationItem 
                key={conv.id} 
                conv={conv} 
                active={activeConvId === conv.id} 
                onClick={() => selectConversation(conv.id)} 
                onDelete={(e) => handleDeleteConversation(e, conv.id)}
              />
            )}
            components={{ Footer: () => isLoadingMoreConvs ? <div style={{ padding: '10px', textAlign: 'center', fontSize: '12px', color: '#c5c5d2' }}>Loading more...</div> : null }}
          />
        </div>
        <div className="sidebar-footer">
          <div className="cache-stats-container">
            <div className="cache-stats-text">
              <div className="cache-stats-line">
                <span className="stats-label">Cached:</span>
                <span className="stats-value">{cacheStats.cachedCount} / {cacheStats.localCount}</span>
              </div>
              <div className="cache-stats-line" title="Uncached chats split by known failed fetches vs unknown/no-data cases">
                <span className="stats-label">Uncached:</span>
                <span className="stats-value">{cacheDiagnostics.uncachedCount}</span>
                <span className="stats-subvalue">fail {cacheDiagnostics.failedCount} · unknown {cacheDiagnostics.unknownCount}</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                className="cache-all-btn"
                onClick={handleRetryFailedCache}
                disabled={isCachingAll || cacheDiagnostics.failedCount === 0}
                title="Retry only conversations with known cache failures"
              >
                Retry failed
              </button>
              <button 
                className={`cache-all-btn ${isCachingAll ? 'spinning' : ''}`} 
                onClick={handleCacheAll} 
                disabled={isCachingAll || cacheStats.cachedCount === cacheStats.localCount}
                title="Cache all missing chats locally"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                </svg>
              </button>
            </div>
          </div>
          <div className="footer-actions">
            <button className="sync-btn-sidebar" onClick={() => activeConvId && selectConversation(activeConvId, true, true)} title="Sync current chat">
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>
            <button className="sync-btn-sidebar" onClick={handleAudit} title="Audit Web Deletions (Check for missing chats)">
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
            </button>
            <button className="settings-btn" onClick={() => setShowSettings(true)}>
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
              Settings
            </button>
          </div>
        </div>
      </div>
      <div className="main-content">
        <div className="chat-body">
          <div className="chat-pane">
            {isSyncing && <div className="sync-indicator">Syncing...</div>}
            <div className="messages-container" onMouseDown={(e) => startPanning(e, scrollerRef.current)}>
              <Virtuoso key={activeConvId || '__new_chat__'} ref={virtuosoRef} scrollerRef={(el) => { scrollerRef.current = el as HTMLElement; setMessageScrollerEl((el as HTMLElement) || null); }} data={messages} initialTopMostItemIndex={messages.length > 0 ? messages.length - 1 : 0} restoreStateFrom={restoreVirtuosoState || undefined} followOutput={targetMessageId ? false : "auto"} rangeChanged={handleMessageRangeChanged}
                itemContent={(_index, msg) => <MessageRow key={msg.id} msg={msg} highlightQuery={activeHighlightQuery} isTarget={targetMessageId === msg.id} onOpenImage={setFullscreenImage} />}
              />
            </div>
          </div>
          <button
            className={`content-nav-toggle ${isMessageMapOpen ? 'open' : 'closed'}`}
            onClick={() => setIsMessageMapOpen((prev) => !prev)}
            title={isMessageMapOpen ? 'Hide message map' : 'Show message map'}
            aria-label={isMessageMapOpen ? 'Hide message map' : 'Show message map'}
          >
            {isMessageMapOpen ? '›' : '‹'}
          </button>
          <aside className={`content-nav ${isMessageMapOpen ? '' : 'collapsed'}`} aria-label="Chat message navigation">
            <div className="content-nav-header">
              <span>Message Map</span>
            </div>
            <div className="content-nav-list" onMouseDown={(e) => startPanning(e, e.currentTarget as HTMLElement)}>
              {navigationMessages.map((msg) => (
                <button
                  key={msg.id}
                  className={`content-nav-item ${msg.role === 'user' ? 'role-user' : 'role-assistant'} ${activeMapMessageId === msg.id ? 'active' : ''}`}
                  onClick={() => jumpToMessageInCurrentChat(msg.id)}
                  title={msg.preview}
                >
                  <span className="content-nav-index">{msg.navIndex}</span>
                  <span className="content-nav-text">{msg.preview}</span>
                </button>
              ))}
            </div>
          </aside>
        </div>
        <div className="input-area">
          <div className="input-container">
            {pastedImage && <div className="image-preview"><img src={pastedImage} alt="Pasted" /><button className="remove-image" onClick={() => setPastedImage(null)}>×</button></div>}
            <div className="input-wrapper">
              <div className="model-picker-container">
                <button className={`model-picker-trigger ${showModelMenu ? 'active' : ''}`} onClick={() => setShowModelMenu(!showModelMenu)} title="Select Model"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M7 14l5-5 5 5z"/></svg></button>
                {showModelMenu && <div className="model-picker-menu">{['Auto', 'Instant 5.3', 'Thinking 5.4 Standard', 'Thinking 5.4 Extended', 'Thinking 5.5 Standard', 'Thinking 5.5 Extended'].map(m => <button key={m} className={`model-picker-option ${selectedModel === m ? 'active' : ''}`} onClick={() => { setSelectedModel(m); setShowModelMenu(false); }}>{m}</button>)}</div>}
              </div>
              <textarea ref={textareaRef} className="chat-input" placeholder="Send a message..." rows={1} value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }} />
              <button className="send-btn" onClick={handleSend} disabled={!inputValue.trim() && !pastedImage}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
            </div>
          </div>
        </div>
      </div>
      {showSettings && <div className="modal-backdrop" onClick={() => setShowSettings(false)}><div className="settings-modal" onClick={e => e.stopPropagation()}><div className="modal-header"><h2>Settings</h2><button className="close-modal" onClick={() => setShowSettings(false)}>×</button></div><div className="setting-item"><label>Font Size <span className="setting-value">{fontSize}pt</span></label><input type="range" min="8" max="20" value={fontSize} onChange={(e) => setFontSize(parseInt(e.target.value))} /></div><div className="setting-item"><label>Chat Column Width <span className="setting-value">{chatWidth}px</span></label><input type="range" min="400" max="5000" step="50" value={chatWidth} onChange={(e) => setChatWidth(parseInt(e.target.value))} /></div></div></div>}
      {showSearch && <div className="modal-backdrop" onClick={() => setShowSearch(false)}><div className="search-modal" onClick={e => e.stopPropagation()}><div className="modal-header"><h2>Search Conversations</h2><button className="close-modal" onClick={() => setShowSearch(false)}>×</button></div><div className="search-input-container"><input autoFocus type="text" placeholder="Search all messages..." value={searchQuery} onChange={(e) => handleSearch(e.target.value)} /></div><div className="search-results">{searchResults.length === 0 && searchQuery.trim() !== '' && <div className="no-results">No messages found matching "{searchQuery}"</div>}{searchResults.map(res => (
        <div key={res.id} className="search-result-item" onClick={(e) => jumpToMessage(e, res.conversation_id, res.id)}><div className="search-result-header"><span className="search-result-title">{res.conversation_title}</span><span className="search-result-role">{res.role}</span></div><div className="search-result-content">{(() => { const text = res.content; const idx = text.toLowerCase().indexOf(searchQuery.toLowerCase()); const start = Math.max(0, idx - 60); const end = Math.min(text.length, idx + 100); const preview = (start > 0 ? '...' : '') + text.substring(start, end) + (end < text.length ? '...' : ''); const escaped = escapeRegExp(searchQuery); const parts = preview.split(new RegExp(`(${escaped})`, 'gi')); return parts.map((part, i) => part.toLowerCase() === searchQuery.toLowerCase() ? <span key={i} className="search-highlight">{part}</span> : part); })()}</div></div>))}</div></div></div>}
      {fullscreenImage && (
        <div className="image-lightbox" onClick={() => { setImageMenu(null); setFullscreenImage(null); }}>
          <button className="image-lightbox-close" onClick={() => setFullscreenImage(null)} aria-label="Close image preview">×</button>
          <img
            className="image-lightbox-content"
            src={fullscreenImage}
            alt="Full size chat image"
            onClick={(e) => { e.stopPropagation(); setImageMenu(null); }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setImageMenu({ x: e.clientX, y: e.clientY });
            }}
          />
          {imageMenu && (
            <div
              className="image-context-menu"
              style={{ left: imageMenu.x, top: imageMenu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <button className="image-context-menu-item" onClick={handleCopyFullscreenImage}>Copy image</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
