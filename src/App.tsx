import React, { useState, useEffect, useRef, memo, useCallback, useMemo } from 'react';
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getMessagePreview = (content: string) => {
  const normalized = content
    .replace(/cite[^]*/g, ' ')
    .replace(/products[\s\S]*?(?:|$)/g, ' ')
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

const normalizeCitationMarkers = (content: string) => {
  const citationOrder = new Map<string, number>();
  let nextCitation = 1;

  const citationNumber = (id: string) => {
    if (!citationOrder.has(id)) citationOrder.set(id, nextCitation++);
    return citationOrder.get(id)!;
  };

  return content
    .replace(/cite([^]+)/g, (_match, rawRefs: string) => {
      const refs = rawRefs
        .split('')
        .map((ref) => ref.trim())
        .filter(Boolean);
      if (refs.length === 0) return '';
      return refs.map((id) => {
        const n = citationNumber(id);
        return `[${n}](citation://${id})`;
      }).join(' ');
    })
    .replace(/cite/g, '')
    .replace(//g, '');
};

const normalizeProductsMarkers = (content: string) => {
  return content.replace(/products(\{[\s\S]*?\})(?:|$)/g, (_match, rawJson: string) => {
    try {
      const parsed = JSON.parse(rawJson) as { selections?: unknown; tags?: unknown };
      const selections = Array.isArray(parsed?.selections) ? parsed.selections : [];
      const tags = Array.isArray(parsed?.tags) ? parsed.tags : [];
      if (selections.length === 0) return '';

      const lines = ['\n**Products**\n'];
      selections.forEach((item, idx) => {
        if (!Array.isArray(item) || item.length < 2) return;
        const id = typeof item[0] === 'string' ? item[0].trim() : '';
        const label = typeof item[1] === 'string' ? item[1].trim() : '';
        if (!label) return;
        const tag = typeof tags[idx] === 'string' ? tags[idx].trim() : '';

        const prefix = `${idx + 1}. `;
        const product = id ? `[${label}](productref://${encodeURIComponent(id)})` : label;
        lines.push(tag ? `${prefix}${product} - ${tag}` : `${prefix}${product}`);
      });

      return lines.join('\n');
    } catch {
      return '';
    }
  });
};

const isNavigableMessage = (msg: Message) =>
  (msg.role === 'user' || msg.role === 'assistant') && !!msg.content?.trim();

type ThinkingPart = Pick<Message, 'id' | 'role' | 'content'>;
type DisplayMessage = Message & { thinkingParts?: ThinkingPart[] };
type CitationEntry = { id: string; url?: string; title?: string };
type BridgeComposerStatus = {
  conversationId: string | null;
  state: string;
  ready: boolean;
  reason?: string;
  updatedAt?: number;
};

const formatSendError = (error: unknown) => {
  const message = typeof error === 'string'
    ? error
    : (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : 'Failed to send message.');

  if (/unusual activity has been detected/i.test(message)) {
    return 'Send blocked by ChatGPT (403 unusual activity). Complete any verification on chatgpt.com, then retry. If it persists, wait a few minutes and try again.';
  }
  return message;
};

const summarizeMetadataOnlyStep = (msg: Message) => {
  if (!msg.metadata_json) return '';
  try {
    const meta = JSON.parse(msg.metadata_json) as Record<string, any>;
    const lines: string[] = [];

    if (typeof meta.reasoning_title === 'string' && meta.reasoning_title.trim()) {
      lines.push(`Reasoning: ${meta.reasoning_title.trim()}`);
    } else if (typeof meta.reasoning_status === 'string' && meta.reasoning_status.trim()) {
      lines.push(`Reasoning status: \`${meta.reasoning_status.trim()}\``);
    }
    if (meta.is_thinking_preamble_message) lines.push('Thinking preamble step');
    if (meta.is_visually_hidden_from_conversation) lines.push('Hidden internal step');

    if (meta.aggregate_result && typeof meta.aggregate_result === 'object') {
      const status = typeof meta.aggregate_result.status === 'string' ? meta.aggregate_result.status : 'available';
      lines.push(`Tool aggregate result: \`${status}\``);
    } else if (msg.role === 'tool') {
      lines.push('Tool step (no text output)');
    }

    if (lines.length === 0 && meta.finish_details && typeof meta.finish_details.type === 'string') {
      lines.push(`Finish: \`${meta.finish_details.type}\``);
    }

    return lines.join('\n');
  } catch {
    return '';
  }
};

const assistantCandidateScore = (content: string) => {
  const text = content.trim();
  if (!text) return -Infinity;
  let score = Math.min(text.length, 20000);
  if (text.startsWith('{') && text.includes('"prompt"')) score -= 7000;
  if (text.startsWith('{') && text.includes('"size"')) score -= 7000;
  if (text.startsWith('```')) score -= 4000;
  if (text.startsWith('[Download')) score -= 1500;
  return score;
};

const buildCitationRegistry = (rawMessages: Message[]): Record<string, CitationEntry> => {
  const registry: Record<string, CitationEntry> = {};
  const markerIdPattern = 'turn\\d+[a-z]+\\d+';
  const trimPunctuation = (value: string) => value.replace(/[),.;!?]+$/, '');
  const citationIdRegex = /turn\d+[a-z]+\d+/i;
  const urlRegex = /https?:\/\/[^\s)\]}>"']+/i;

  const ensureEntry = (id: string) => {
    if (!registry[id]) registry[id] = { id };
    return registry[id];
  };

  const firstCitationId = (value: unknown) => {
    if (typeof value !== 'string') return null;
    const match = value.match(citationIdRegex);
    return match ? match[0] : null;
  };

  const firstUrl = (value: unknown) => {
    if (typeof value !== 'string') return null;
    const match = value.match(urlRegex);
    return match ? trimPunctuation(match[0]) : null;
  };

  const collectFromMetadata = (value: unknown, seen: Set<string>, depth = 0) => {
    if (!value || depth > 12) return;

    if (Array.isArray(value)) {
      for (const item of value) collectFromMetadata(item, seen, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;

    const obj = value as Record<string, unknown>;
    const stringValues = Object.values(obj).filter((v): v is string => typeof v === 'string');

    // ChatGPT metadata often stores citation ids in matched_text and URLs in safe_urls.
    const matchedText = typeof obj.matched_text === 'string' ? obj.matched_text : '';
    const safeUrls = Array.isArray(obj.safe_urls)
      ? obj.safe_urls.filter((u): u is string => typeof u === 'string').map((u) => trimPunctuation(u.trim())).filter(Boolean)
      : [];
    if (matchedText && safeUrls.length > 0) {
      const ids = Array.from(matchedText.matchAll(/turn\d+[a-z]+\d+/gi)).map((m) => m[0]);
      ids.forEach((id, idx) => {
        const url = safeUrls[idx] || safeUrls[0];
        if (!url) return;
        const dedupeKey = `${id}|${url}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        const entry = ensureEntry(id);
        if (!entry.url) entry.url = url;
      });
    }

    const id =
      firstCitationId(obj.ref_id)
      || firstCitationId(obj.citation_id)
      || firstCitationId(obj.source_id)
      || firstCitationId(obj.id)
      || stringValues.map((v) => firstCitationId(v)).find(Boolean)
      || null;

    const url =
      firstUrl(obj.url)
      || firstUrl(obj.href)
      || firstUrl(obj.link)
      || firstUrl(obj.uri)
      || stringValues.map((v) => firstUrl(v)).find(Boolean)
      || null;

    if (id && url) {
      const dedupeKey = `${id}|${url}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        const entry = ensureEntry(id);
        if (!entry.url) entry.url = url;
        if (!entry.title) {
          const title = typeof obj.title === 'string'
            ? obj.title.trim()
            : typeof obj.name === 'string'
              ? obj.name.trim()
              : '';
          if (title) entry.title = title;
        }
      }
    }

    for (const nested of Object.values(obj)) {
      if (nested && typeof nested === 'object') {
        collectFromMetadata(nested, seen, depth + 1);
      }
    }
  };

  const metadataSeen = new Set<string>();
  for (const msg of rawMessages) {
    if (!msg.metadata_json) continue;
    try {
      const parsed = JSON.parse(msg.metadata_json);
      collectFromMetadata(parsed, metadataSeen);
    } catch {
      // Ignore malformed cached metadata.
    }
  }

  const searchableMessages = rawMessages.filter((m) => m.content && m.content.trim());

  for (const msg of searchableMessages) {
    const text = msg.content;

    const inlinePattern = new RegExp(`([^\\n]{0,240}?)\\((https?:\\/\\/[^\\s)]+)\\)\\s*【(${markerIdPattern})】`, 'g');
    let inlineMatch: RegExpExecArray | null;
    while ((inlineMatch = inlinePattern.exec(text)) !== null) {
      const title = inlineMatch[1].replace(/^[\s*\-•]+/, '').trim();
      const url = trimPunctuation(inlineMatch[2].trim());
      const id = inlineMatch[3].trim();
      const entry = ensureEntry(id);
      if (!entry.url) entry.url = url;
      if (!entry.title && title) entry.title = title;
    }

    const markdownLinkWithMarkerPattern = new RegExp(`\\[([^\\]]{1,240})\\]\\((https?:\\/\\/[^\\s)]+)\\)\\s*【(${markerIdPattern})】`, 'g');
    let mdMatch: RegExpExecArray | null;
    while ((mdMatch = markdownLinkWithMarkerPattern.exec(text)) !== null) {
      const title = mdMatch[1].trim();
      const url = trimPunctuation(mdMatch[2].trim());
      const id = mdMatch[3].trim();
      const entry = ensureEntry(id);
      if (!entry.url) entry.url = url;
      if (!entry.title && title) entry.title = title;
    }

    const rawUrlWithMarkerPattern = new RegExp(`(https?:\\/\\/\\S+)\\s*【(${markerIdPattern})】`, 'g');
    let rawMatch: RegExpExecArray | null;
    while ((rawMatch = rawUrlWithMarkerPattern.exec(text)) !== null) {
      const url = trimPunctuation(rawMatch[1].trim());
      const id = rawMatch[2].trim();
      const entry = ensureEntry(id);
      if (!entry.url) entry.url = url;
    }

    const markerPattern = new RegExp(`【(${markerIdPattern})】`, 'g');
    let markerMatch: RegExpExecArray | null;
    while ((markerMatch = markerPattern.exec(text)) !== null) {
      const id = markerMatch[1];
      const entry = ensureEntry(id);
      if (entry.url) continue;

      const markerIndex = markerMatch.index;
      const windowStart = Math.max(0, markerIndex - 500);
      const windowEnd = Math.min(text.length, markerIndex + 500);
      const windowText = text.slice(windowStart, windowEnd);
      const urls = [...windowText.matchAll(/https?:\/\/[^\s)\]]+/g)];
      if (urls.length === 0) continue;

      const nearest = urls.reduce((best, current) => {
        const currentIndex = windowStart + (current.index || 0);
        const bestIndex = windowStart + (best.index || 0);
        return Math.abs(currentIndex - markerIndex) < Math.abs(bestIndex - markerIndex) ? current : best;
      });

      entry.url = trimPunctuation(nearest[0].trim());

      const lineStart = text.lastIndexOf('\n', markerIndex);
      const line = text.slice(lineStart + 1, markerIndex).trim();
      if (!entry.title && line) {
        entry.title = line.replace(/^[\d.\s*\-•]+/, '').trim();
      }
    }
  }

  return registry;
};

const buildDisplayMessages = (rawMessages: Message[]): DisplayMessage[] => {
  const output: DisplayMessage[] = [];
  const segmentable = rawMessages.filter((m) => (m.content && m.content.trim()) || !!m.metadata_json);

  const flushSegment = (segment: Message[]) => {
    if (segment.length === 0) return;
    const userMessages = segment.filter((m) => m.role === 'user' && m.content && m.content.trim());
    const assistantMessages = segment.filter((m) => m.role === 'assistant' && m.content && m.content.trim());

    userMessages.forEach((m) => output.push({ ...m }));
    if (assistantMessages.length === 0) return;

    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    const strongestAssistant = assistantMessages.reduce((best, current) => {
      return assistantCandidateScore(current.content) > assistantCandidateScore(best.content) ? current : best;
    }, assistantMessages[0]);
    const finalAssistant =
      assistantCandidateScore(lastAssistant.content) >= assistantCandidateScore(strongestAssistant.content) * 0.55
        ? lastAssistant
        : strongestAssistant;
    const thinkingParts = segment
      .filter((m) => m.id !== finalAssistant.id && m.role !== 'user')
      .map((m) => {
        const visible = (m.content || '').trim();
        const content = visible ? m.content : summarizeMetadataOnlyStep(m);
        return { id: m.id, role: m.role, content };
      })
      .filter((m) => !!m.content?.trim());

    output.push({
      ...finalAssistant,
      thinkingParts: thinkingParts.length > 0 ? thinkingParts : undefined,
    });
  };

  let segment: Message[] = [];
  for (const msg of segmentable) {
    if (msg.role === 'user' && segment.length > 0) {
      flushSegment(segment);
      segment = [msg];
    } else {
      segment.push(msg);
    }
  }
  flushSegment(segment);

  return output;
};

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

const MarkdownMessage = memo(({ content, highlightQuery, conversationId, onOpenImage, citationRegistry }: { content: string, highlightQuery?: string, conversationId?: string, onOpenImage?: (src: string) => void, citationRegistry: Record<string, CitationEntry> }) => {
  const query = highlightQuery || '';
  const renderedContent = normalizeMathDelimiters(normalizeCitationMarkers(normalizeProductsMarkers(content)));
  return (
    <ReactMarkdown
      urlTransform={(value: string) => value}
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ href, children, ...props }) => {
          if (typeof href === 'string' && href.startsWith('productref://')) {
            const id = decodeURIComponent(href.replace('productref://', ''));
            const entry = citationRegistry[id];
            if (entry?.url) {
              return <a href={entry.url} target="_blank" rel="noreferrer" title={entry.title || id} {...props}>{children}</a>;
            }
            return <span title={id}>{children}</span>;
          }
          if (typeof href === 'string' && href.startsWith('citation://')) {
            const id = decodeURIComponent(href.replace('citation://', ''));
            const entry = citationRegistry[id];
            if (entry?.url) {
              return (
                <sup className="citation-ref">
                  <a href={entry.url} target="_blank" rel="noreferrer" title={entry.title || id}>
                    {children}
                  </a>
                </sup>
              );
            }
            return <sup className="citation-ref" title={id}>{children}</sup>;
          }
          return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
        },
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

const MessageRow = memo(({ msg, highlightQuery, isTarget, onOpenImage, citationRegistry }: { msg: DisplayMessage, highlightQuery?: string, isTarget?: boolean, onOpenImage?: (src: string) => void, citationRegistry: Record<string, CitationEntry> }) => {
  const hasThinking = msg.role === 'assistant' && !!msg.thinkingParts && msg.thinkingParts.length > 0;
  const [thinkingOpen, setThinkingOpen] = useState(false);

  useEffect(() => {
    setThinkingOpen(false);
  }, [msg.id]);

  return (
    <div className={`message-row ${msg.role} ${isTarget ? 'highlight-target' : ''}`} data-message-id={msg.id}>
      <div className="message-content">
        <div className="message-header">
          <div className="role-label">{msg.role === 'user' ? 'You' : 'ChatGPT'}</div>
          {hasThinking ? (
            <button
              type="button"
              className={`thinking-inline-toggle ${thinkingOpen ? 'open' : ''}`}
              onClick={() => setThinkingOpen((prev) => !prev)}
              aria-expanded={thinkingOpen}
            >
              <span className="thinking-chevron" aria-hidden="true">▾</span>
              <span>Thinking</span>
            </button>
          ) : null}
        </div>
        {hasThinking && thinkingOpen ? (
          <div className="thinking-box-inline">
            <div className="thinking-content">
              {msg.thinkingParts!.map((part) => (
                <div key={part.id} className="thinking-item">
                  <div className="thinking-role">{part.role}</div>
                  <div className="markdown-body">
                    <MarkdownMessage content={part.content} conversationId={msg.conversation_id} onOpenImage={onOpenImage} citationRegistry={citationRegistry} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="markdown-body">
          <MarkdownMessage content={msg.content} highlightQuery={isTarget ? highlightQuery : undefined} conversationId={msg.conversation_id} onOpenImage={onOpenImage} citationRegistry={citationRegistry} />
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
  const [attachedFiles, setAttachedFiles] = useState<Array<{ id: string; name: string; mimeType: string; dataUrl: string; sizeBytes: number }>>([]);
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isReauthenticating, setIsReauthenticating] = useState(false);
  const [bridgeComposerStatus, setBridgeComposerStatus] = useState<BridgeComposerStatus | null>(null);

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
  const conversationsScrollerRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const activeConvIdRef = useRef<string | null>(localStorage.getItem('lastConvId'));
  const bridgeComposerStatusRef = useRef<BridgeComposerStatus | null>(null);
  const hasScrolledToBottomRef = useRef<Record<string, boolean>>({});
  const virtuosoStateByConversationRef = useRef<Record<string, any>>({});
  const [restoreVirtuosoState, setRestoreVirtuosoState] = useState<any | null>(null);
  const displayMessages = useMemo(() => buildDisplayMessages(messages), [messages]);
  const citationRegistry = useMemo(() => buildCitationRegistry(messages), [messages]);
  const isBridgeReadyForActiveConversation = useMemo(() => {
    if (!bridgeComposerStatus?.ready) return false;
    return (bridgeComposerStatus.conversationId || null) === (activeConvId || null);
  }, [activeConvId, bridgeComposerStatus]);
  const bridgeActivityLabel = useMemo(() => {
    const status = bridgeComposerStatus;
    if (!status) return '';
    const sameConversation = (status.conversationId || null) === (activeConvId || null);
    if (!sameConversation) return '';
    if (status.state === 'sending') return 'Sending...';
    if (status.state === 'thinking') return 'Thinking...';
    if (status.state === 'warming') return 'Preparing chat...';
    if (status.state === 'ready') return 'Ready';
    if (status.state === 'error' && status.reason) return status.reason;
    return '';
  }, [activeConvId, bridgeComposerStatus]);

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
    window.electronAPI.invoke('api:prewarmConversation', { conversationId: id })
      .catch((error) => console.warn('Failed to prewarm bridge conversation', error));
    const localMsgs = await window.electronAPI.invoke('db:getMessages', id);
    setMessages(localMsgs);
    const shouldSyncNow = shouldSync || localMsgs.length === 0;
    if (!shouldSyncNow) {
      setIsSyncing(false);
      return;
    }
    setIsSyncing(true);
    window.electronAPI.invoke('api:syncMessages', { conversationId: id, force: forceSync })
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

  const handleReauth = useCallback(async () => {
    if (isReauthenticating) return;
    setIsReauthenticating(true);
    try {
      const success = await window.electronAPI.invoke('auth:reauth');
      if (!success) {
        setSendError('Re-authentication was cancelled or failed.');
        return;
      }
      await checkAuth();
      if (activeConvIdRef.current) {
        await selectConversation(activeConvIdRef.current, true, true);
      }
      setSendError(null);
    } catch (error) {
      console.error('Re-authentication failed', error);
      setSendError('Re-authentication failed. Please try again.');
    } finally {
      setIsReauthenticating(false);
    }
  }, [checkAuth, isReauthenticating, selectConversation]);

  const handleSend = async () => {
    if (isSending || (!inputValue.trim() && !pastedImage && attachedFiles.length === 0)) return;
    if (!isBridgeReadyForActiveConversation) {
      setSendError('Bridge chat is still loading. Wait for the send button to turn green.');
      return;
    }
    
    const outgoingContent = inputValue;
    const currentImage = pastedImage;
    const currentFiles = attachedFiles;
    const modelMap: Record<string, string> = {
      'Auto': 'auto', 'Instant 5.3': 'gpt-4o', 'Thinking 5.4 Standard': 'o1-mini',
      'Thinking 5.4 Extended': 'o1', 'Thinking 5.5 Standard': 'o3-mini', 'Thinking 5.5 Extended': 'o1',
    };
    
    setSendError(null);
    setIsSending(true);

    // Optimistically clear the input
    setInputValue('');
    setPastedImage(null);
    setAttachedFiles([]);

    // Create a temporary optimistic message
    const tempId = `temp-${Date.now()}`;
    const optimisticMsg: Message = {
      id: tempId,
      conversation_id: activeConvId || '',
      role: 'user',
      content: outgoingContent,
      created_at: Date.now() / 1000,
      parent_id: messages.length > 0 ? messages[messages.length - 1].id : undefined,
    };
    
    // Add to list immediately
    setMessages(prev => [...prev, optimisticMsg]);

    try {
      await window.electronAPI.invoke('api:sendMessage', {
        conversationId: activeConvId,
        content: outgoingContent,
        model: modelMap[selectedModel] || 'auto',
        image: currentImage,
        files: currentFiles.map((f) => ({
          name: f.name,
          mimeType: f.mimeType,
          dataUrl: f.dataUrl,
          sizeBytes: f.sizeBytes,
        })),
      });

      if (activeConvId) {
        // Pull updates repeatedly while ChatGPT is thinking to mimic web streaming.
        const syncDeadline = Date.now() + 120000;
        let latestMsgs: Message[] = [];
        let stableAssistantPasses = 0;
        let lastAssistantFingerprint = '';

        while (Date.now() < syncDeadline) {
          const synced = await window.electronAPI.invoke('api:syncMessages', { conversationId: activeConvId, force: true });
          latestMsgs = Array.isArray(synced) ? synced : [];
          setMessages((prev) => {
            if (JSON.stringify(prev) === JSON.stringify(latestMsgs)) return prev;
            return latestMsgs;
          });

          const lastAssistant = [...latestMsgs].reverse().find((m) => m.role === 'assistant');
          const assistantFingerprint = lastAssistant
            ? `${lastAssistant.id}|${lastAssistant.content || ''}`
            : '';
          if (assistantFingerprint && assistantFingerprint === lastAssistantFingerprint) {
            stableAssistantPasses += 1;
          } else {
            stableAssistantPasses = 0;
            lastAssistantFingerprint = assistantFingerprint;
          }

          const bridgeState = bridgeComposerStatusRef.current?.state || '';
          const stillGenerating = bridgeState === 'sending' || bridgeState === 'thinking' || bridgeState === 'warming';
          if (!stillGenerating && stableAssistantPasses >= 2) break;

          await sleep(350);
        }

        const textNeedle = outgoingContent.trim();
        const userMessageConfirmed = !textNeedle || latestMsgs.some((m: Message) => {
          if (m.role !== 'user') return false;
          return (m.content || '').includes(textNeedle);
        });
        if (!userMessageConfirmed) {
          setSendError('Send could not be verified in this chat. Your draft was kept so you can retry.');
          setInputValue(outgoingContent);
          setPastedImage(currentImage);
          setAttachedFiles(currentFiles);
        }
      } else {
        // New conversation, need to refresh the list to find the new ID
        loadConversations();
      }
    } catch (error) {
      console.error('Failed to send message', error);
      setSendError(formatSendError(error));
      
      // Restore state on failure
      setInputValue(outgoingContent);
      setPastedImage(currentImage);
      setAttachedFiles(currentFiles);
      
      // Remove the optimistic message
      setMessages(prev => prev.filter(m => m.id !== tempId));
    } finally {
      setIsSending(false);
    }
  };

  const handleAttachFiles = useCallback(async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const fileArray = Array.from(list);
    const mapped = await Promise.all(fileArray.map(async (file) => {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
      return {
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataUrl,
        sizeBytes: file.size,
      };
    }));
    setAttachedFiles((prev) => [...prev, ...mapped]);
  }, []);

  const handleSearch = async (q: string) => {
    setSearchQuery(q);
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }
    const results = await window.electronAPI.invoke('db:searchMessages', q);
    setSearchResults(results.filter((r: any) => r.role === 'user' || r.role === 'assistant'));
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
    if (activeConvId && displayMessages.length > 0) {
      if (targetMessageId) {
        const index = displayMessages.findIndex(m => m.id === targetMessageId);
        if (index !== -1) {
          const timer = setTimeout(() => {
            virtuosoRef.current?.scrollToIndex({ index, align: 'start', behavior: 'auto' });
            hasScrolledToBottomRef.current[activeConvId] = true;
          }, 150);
          return () => clearTimeout(timer);
        }
      } else if (!hasScrolledToBottomRef.current[activeConvId] && !virtuosoStateByConversationRef.current[activeConvId]) {
        const timer = setTimeout(() => {
          virtuosoRef.current?.scrollToIndex({ index: displayMessages.length - 1, align: 'end', behavior: 'auto' });
          hasScrolledToBottomRef.current[activeConvId] = true;
        }, 100);
        return () => clearTimeout(timer);
      }
    }
  }, [displayMessages, activeConvId, targetMessageId]);

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
    let unsubscribe: (() => void) | undefined;
    if (window.electronAPI.onBridgeComposerStatus) {
      const maybeUnsub = window.electronAPI.onBridgeComposerStatus((status: BridgeComposerStatus) => {
        setBridgeComposerStatus(status || null);
      });
      if (typeof maybeUnsub === 'function') unsubscribe = maybeUnsub;
    }
    window.electronAPI.invoke('api:getBridgeComposerStatus')
      .then((status: BridgeComposerStatus) => setBridgeComposerStatus(status || null))
      .catch((error) => console.warn('Failed to get initial bridge status', error));
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  useEffect(() => {
    bridgeComposerStatusRef.current = bridgeComposerStatus;
  }, [bridgeComposerStatus]);

  useEffect(() => {
    const init = async () => {
      await checkAuth();
      const savedId = localStorage.getItem('lastConvId');
      if (savedId) {
        selectConversation(savedId, true, true);
      } else {
        window.electronAPI.invoke('api:prewarmConversation', { conversationId: null })
          .catch((error) => console.warn('Failed to prewarm new chat bridge', error));
      }
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
    const navigableIds = new Set(displayMessages.filter(isNavigableMessage).map((m) => m.id));
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
  }, [displayMessages]);

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
  }, [displayMessages, updateViewportNavHighlight]);

  if (isAuth === null) return <div className="auth-overlay">Loading...</div>;
  if (isAuth === false) return (
    <div className="auth-overlay">
      <h1>ChatGPT Desktop</h1>
      <p>Please log in to your ChatGPT Plus account</p>
      <button className="login-btn" onClick={handleLogin}>Login with Browser</button>
    </div>
  );

  const navigationMessages = displayMessages
    .filter(isNavigableMessage)
    .map((m, i) => ({ ...m, navIndex: i + 1, preview: getMessagePreview(m.content) }));
  const activeMapMessageId = isMessageMapOpen ? viewportNavMessageId : targetMessageId;
  const trimmedSearchQuery = searchQuery.trim();
  const searchMatchCount = trimmedSearchQuery ? searchResults.length : 0;
  const hasSendableInput = !!inputValue.trim() || !!pastedImage || attachedFiles.length > 0;
  const isSendDisabled = isSending || !hasSendableInput || !isBridgeReadyForActiveConversation;

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
            <button className="new-chat-btn" onClick={() => { saveVirtuosoState(activeConvIdRef.current); setActiveConvId(null); setMessages([]); activeConvIdRef.current = null; setRestoreVirtuosoState(null); window.electronAPI.invoke('api:prewarmConversation', { conversationId: null }).catch((error) => console.warn('Failed to prewarm new chat bridge', error)); }}>+ New Chat</button>
            <button className="search-trigger-btn" onClick={() => setShowSearch(true)} title="Search Chats">
              <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
            </button>
          </div>
        </div>
        <div className="conversations-list" onMouseDown={(e) => startPanning(e, conversationsScrollerRef.current || (e.currentTarget as HTMLElement))}>
          <Virtuoso
            data={conversations}
            endReached={loadMoreConversations}
            scrollerRef={(el) => { conversationsScrollerRef.current = (el as HTMLElement) || null; }}
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
              <Virtuoso key={activeConvId || '__new_chat__'} ref={virtuosoRef} scrollerRef={(el) => { scrollerRef.current = el as HTMLElement; setMessageScrollerEl((el as HTMLElement) || null); }} data={displayMessages} initialTopMostItemIndex={displayMessages.length > 0 ? displayMessages.length - 1 : 0} restoreStateFrom={restoreVirtuosoState || undefined} followOutput={targetMessageId ? false : "auto"} rangeChanged={handleMessageRangeChanged}
                itemContent={(_index, msg) => <MessageRow key={msg.id} msg={msg} highlightQuery={activeHighlightQuery} isTarget={targetMessageId === msg.id} onOpenImage={setFullscreenImage} citationRegistry={citationRegistry} />}
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
              {sendError && (
                <div className="send-error-banner">
                  <span>{sendError}</span>
                  <button className="send-error-dismiss" onClick={() => setSendError(null)} aria-label="Dismiss send error">×</button>
                </div>
              )}
              {bridgeActivityLabel && !sendError && (
                <div className={`bridge-status-banner ${bridgeComposerStatus?.state === 'error' ? 'error' : ''}`}>
                  <span>{bridgeActivityLabel}</span>
                </div>
              )}
              {pastedImage && <div className="image-preview"><img src={pastedImage} alt="Pasted" /><button className="remove-image" onClick={() => setPastedImage(null)}>×</button></div>}
              {attachedFiles.length > 0 && (
                <div className="file-preview-list">
                  {attachedFiles.map((file) => (
                    <div key={file.id} className="file-preview-chip" title={file.name}>
                      <span className="file-preview-name">{file.name}</span>
                      <button className="file-preview-remove" onClick={() => setAttachedFiles((prev) => prev.filter((f) => f.id !== file.id))}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  handleAttachFiles(e.target.files).catch((err) => console.error('Attach failed', err));
                  e.currentTarget.value = '';
                }}
              />
              <div className="input-wrapper">
                <div className="model-picker-container">
                  <button className={`model-picker-trigger ${showModelMenu ? 'active' : ''}`} onClick={() => setShowModelMenu(!showModelMenu)} title="Select Model"><svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M7 14l5-5 5 5z"/></svg></button>
                  <button className="attach-btn" onClick={() => fileInputRef.current?.click()} title="Attach files">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M16.5 6.5l-7.79 7.79a2 2 0 1 0 2.83 2.83l7.08-7.08a4 4 0 1 0-5.66-5.66L5.17 12.17a6 6 0 1 0 8.49 8.49l6.36-6.36-1.41-1.41-6.36 6.36a4 4 0 1 1-5.66-5.66l7.79-7.79a2 2 0 1 1 2.83 2.83l-7.08 7.08-.71-.71 6.72-6.72 1.41 1.41-6.72 6.72a2 2 0 0 1-2.83-2.83l7.79-7.79 1.41 1.41z"/></svg>
                  </button>
                  {showModelMenu && <div className="model-picker-menu">{['Auto', 'Instant 5.3', 'Thinking 5.4 Standard', 'Thinking 5.4 Extended', 'Thinking 5.5 Standard', 'Thinking 5.5 Extended'].map(m => <button key={m} className={`model-picker-option ${selectedModel === m ? 'active' : ''}`} onClick={() => { setSelectedModel(m); setShowModelMenu(false); }}>{m}</button>)}</div>}
                </div>
              <textarea ref={textareaRef} className="chat-input" placeholder="Send a message..." rows={1} value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }} />
              <button className={`send-btn ${isBridgeReadyForActiveConversation ? 'ready' : 'not-ready'}`} onClick={handleSend} disabled={isSendDisabled}><svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
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
              <label>Font Size <span className="setting-value">{fontSize}pt</span></label>
              <input type="range" min="8" max="20" value={fontSize} onChange={(e) => setFontSize(parseInt(e.target.value))} />
            </div>
            <div className="setting-item">
              <label>Chat Column Width <span className="setting-value">{chatWidth}px</span></label>
              <input type="range" min="400" max="5000" step="50" value={chatWidth} onChange={(e) => setChatWidth(parseInt(e.target.value))} />
            </div>
            <div className="setting-item">
              <label>Account & Sync</label>
              <div className="settings-action-list">
                <button className="settings-action-btn" onClick={handleAudit} title="Check for chats deleted on web and mark local cache accordingly">
                  Check for auto deletions
                </button>
                <button className="settings-action-btn" onClick={handleReauth} disabled={isReauthenticating} title="Clear ChatGPT session data and log in again">
                  {isReauthenticating ? 'Re-authenticating...' : 'Re-authenticate'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {showSearch && (
        <div className="modal-backdrop" onClick={() => setShowSearch(false)}>
          <div className="search-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Search Conversations</h2>
              <button className="close-modal" onClick={() => setShowSearch(false)}>×</button>
            </div>
            <div className="search-input-container">
              <input
                autoFocus
                type="text"
                placeholder="Search all messages..."
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
              />
            </div>
            {trimmedSearchQuery && (
              <div className="search-results-meta">
                {searchMatchCount} match{searchMatchCount === 1 ? '' : 'es'}
              </div>
            )}
            <div className="search-results">
              {searchResults.length === 0 && trimmedSearchQuery !== '' && (
                <div className="no-results">No messages found matching "{searchQuery}"</div>
              )}
              {searchResults.map(res => (
                <div key={res.id} className="search-result-item" onClick={(e) => jumpToMessage(e, res.conversation_id, res.id)}>
                  <div className="search-result-header">
                    <span className="search-result-title">{res.conversation_title}</span>
                    <span className="search-result-role">{res.role}</span>
                  </div>
                  <div className="search-result-content">
                    {(() => {
                      const text = res.content;
                      const idx = text.toLowerCase().indexOf(searchQuery.toLowerCase());
                      const start = Math.max(0, idx - 60);
                      const end = Math.min(text.length, idx + 100);
                      const preview = (start > 0 ? '...' : '') + text.substring(start, end) + (end < text.length ? '...' : '');
                      const escaped = escapeRegExp(searchQuery);
                      const parts = preview.split(new RegExp(`(${escaped})`, 'gi'));
                      return parts.map((part, i) => part.toLowerCase() === searchQuery.toLowerCase() ? <span key={i} className="search-highlight">{part}</span> : part);
                    })()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
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
