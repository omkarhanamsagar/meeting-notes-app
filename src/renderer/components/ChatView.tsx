import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatChunkEvent,
  ChatContentPart,
  ChatImagePart,
  ChatMessage,
  ChatPdfPart,
  ChatScope,
  ChatSession,
  ModelInfo,
} from '../../shared/types';
import { Markdown } from './Markdown';
import { fileToDataUrl, formatSize, splitDataUrl } from '../lib/files';

interface ChatViewProps {
  scope: ChatScope;
  models: ModelInfo[];
  defaultModel: string;
  /** Optional className applied to the root for layout tweaks per host. */
  className?: string;
  /** Project source ids excluded from context for this chat session. */
  excludedSourceIds?: string[];
  /** Prior meeting slugs excluded from context for this chat session. */
  excludedMeetingSlugs?: string[];
}

const MAX_ATTACHMENTS_PER_TURN = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PDF_MIME = 'application/pdf';

type StagedAttachment = StagedImageAtt | StagedPdfAtt;

interface StagedImageAtt {
  kind: 'image';
  id: string;
  filename: string;
  mediaType: string;
  base64: string;
  /** data URL for the thumbnail preview. */
  dataUrl: string;
  size: number;
}

interface StagedPdfAtt {
  kind: 'pdf';
  id: string;
  filename: string;
  mediaType: 'application/pdf';
  base64: string;
  size: number;
}

function fileKindFor(file: File): 'image' | 'pdf' | null {
  if (ALLOWED_IMAGE_MIMES.has(file.type)) return 'image';
  if (file.type === PDF_MIME) return 'pdf';
  // Fallback by extension for cases where the OS didn't set the mime.
  const lower = (file.name || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  return null;
}

function scopeKey(scope: ChatScope): string {
  if (scope.kind === 'project') return `project:${scope.team}:${scope.project}`;
  return `meeting:${scope.dir}`;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Tail of textual content in a chat message (we render assistant messages
 *  with the Markdown component; user messages are plain text + thumbnails). */
function messageText(m: ChatMessage): string {
  return m.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n');
}

function messageImages(m: ChatMessage): ChatImagePart[] {
  return m.content.filter((p): p is ChatImagePart => p.type === 'image');
}

function messagePdfs(m: ChatMessage): ChatPdfPart[] {
  return m.content.filter((p): p is ChatPdfPart => p.type === 'pdf');
}

export function ChatView({
  scope,
  models,
  defaultModel,
  className,
  excludedSourceIds,
  excludedMeetingSlugs,
}: ChatViewProps) {
  const [session, setSession] = useState<ChatSession | null>(null);
  const [draft, setDraft] = useState('');
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [model, setModel] = useState<string>(defaultModel);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  /** True when the viewport is pinned near the bottom of the message list.
   *  We only auto-scroll while pinned so the user can scroll up to read
   *  earlier text without being yanked back down mid-stream. */
  const isPinnedRef = useRef(true);
  const [isPinned, setIsPinned] = useState(true);
  const dragCounter = useRef(0);
  const key = scopeKey(scope);

  // ---------------------------------------------------------- load on scope change

  useEffect(() => {
    let cancelled = false;
    void window.api.chat.read(scope).then((s) => {
      if (cancelled) return;
      setSession(s);
      setModel(s.model || defaultModel);
      setStreamingText(null);
      setPendingRequestId(null);
      setStaged([]);
      setDraft('');
      setError(null);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, defaultModel]);

  // ---------------------------------------------------------- streaming subscription

  useEffect(() => {
    const unsub = window.api.onChatChunk((event: ChatChunkEvent) => {
      if (event.requestId !== pendingRequestId) return;
      if (event.kind === 'delta') {
        setStreamingText((prev) => (prev ?? '') + event.text);
      } else if (event.kind === 'done') {
        setStreamingText(null);
        setPendingRequestId(null);
        setSession((s) =>
          s ? { ...s, messages: [...s.messages, event.message] } : s,
        );
      } else if (event.kind === 'error') {
        setStreamingText(null);
        setPendingRequestId(null);
        setError(event.error);
      }
    });
    return unsub;
  }, [pendingRequestId]);

  // ---------------------------------------------------------- auto-scroll
  //
  // Behavior: only autoscroll while the user is pinned to the bottom. If
  // they scroll up to read earlier content (mid-stream or otherwise), we
  // stop yanking them back down. A floating "Jump to latest" button shows
  // up so they can opt back in. A new user turn (which they just sent
  // themselves) always re-pins to the bottom — that's the expected
  // affordance for "I just hit send".

  const PIN_THRESHOLD_PX = 80;

  function recomputePinned(): void {
    const el = messagesScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = distanceFromBottom <= PIN_THRESHOLD_PX;
    if (pinned !== isPinnedRef.current) {
      isPinnedRef.current = pinned;
      setIsPinned(pinned);
    }
  }

  function scrollToLatest(behavior: ScrollBehavior = 'smooth'): void {
    const el = messagesScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    isPinnedRef.current = true;
    setIsPinned(true);
  }

  // Autoscroll on new content only if currently pinned. We intentionally
  // listen to streamingText length (not equality) so each chunk re-evaluates.
  useEffect(() => {
    if (!isPinnedRef.current) return;
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [session?.messages.length, streamingText]);

  // When a new user turn is appended (session.messages length grows AND last
  // message is from the user), force-pin: the user clearly wants to see it.
  useEffect(() => {
    const msgs = session?.messages;
    if (!msgs || msgs.length === 0) return;
    if (msgs[msgs.length - 1]!.role === 'user') {
      scrollToLatest('auto');
    }
  }, [session?.messages.length]);

  // ---------------------------------------------------------- composer auto-resize

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  // ---------------------------------------------------------- attachment staging

  const stageFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    const next: StagedAttachment[] = [];
    const errs: string[] = [];
    for (const file of files) {
      const kind = fileKindFor(file);
      if (!kind) {
        errs.push(
          `${file.name || 'pasted file'}: only PNG/JPG/GIF/WebP images and PDFs are supported in chat`,
        );
        continue;
      }
      const maxBytes = kind === 'pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
      if (file.size > maxBytes) {
        errs.push(
          `${file.name || 'pasted file'}: too large (${formatSize(file.size)}, max ${formatSize(maxBytes)})`,
        );
        continue;
      }
      try {
        const dataUrl = await fileToDataUrl(file);
        const split = splitDataUrl(dataUrl);
        if (!split) {
          errs.push(`${file.name}: could not decode`);
          continue;
        }
        if (kind === 'image') {
          next.push({
            kind: 'image',
            id: newId(),
            filename: file.name || `image-${Date.now()}.png`,
            mediaType: split.mediaType,
            base64: split.base64,
            dataUrl,
            size: file.size,
          });
        } else {
          next.push({
            kind: 'pdf',
            id: newId(),
            filename: file.name || `document-${Date.now()}.pdf`,
            mediaType: 'application/pdf',
            base64: split.base64,
            size: file.size,
          });
        }
      } catch (err) {
        errs.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (errs.length) setError(errs.join('\n'));
    setStaged((prev) => [...prev, ...next].slice(-MAX_ATTACHMENTS_PER_TURN));
  }, []);

  function onPickAttachments(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list) return;
    void stageFiles(Array.from(list));
    e.target.value = '';
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) void stageFiles(files);
  }

  useEffect(() => {
    function clearDrag() {
      dragCounter.current = 0;
      setDragOver(false);
    }
    function onWindowDragLeave(e: DragEvent) {
      if (e.relatedTarget === null) clearDrag();
    }
    window.addEventListener('dragend', clearDrag);
    window.addEventListener('drop', clearDrag);
    window.addEventListener('dragleave', onWindowDragLeave);
    return () => {
      window.removeEventListener('dragend', clearDrag);
      window.removeEventListener('drop', clearDrag);
      window.removeEventListener('dragleave', onWindowDragLeave);
    };
  }, []);

  // ---------------------------------------------------------- clipboard paste

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f && fileKindFor(f)) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        void stageFiles(files);
      }
    }
    el.addEventListener('paste', onPaste);
    return () => el.removeEventListener('paste', onPaste);
  }, [stageFiles]);

  // ---------------------------------------------------------- send

  const canSend =
    !!session && !pendingRequestId && (draft.trim().length > 0 || staged.length > 0);

  async function handleSend() {
    if (!canSend || !session) return;
    setError(null);
    const text = draft.trim();
    const images: ChatImagePart[] = staged
      .filter((s): s is StagedImageAtt => s.kind === 'image')
      .map((s) => ({
        type: 'image',
        data: s.base64,
        mediaType: s.mediaType,
        filename: s.filename,
      }));
    const pdfs: ChatPdfPart[] = staged
      .filter((s): s is StagedPdfAtt => s.kind === 'pdf')
      .map((s) => ({
        type: 'pdf',
        data: s.base64,
        mediaType: 'application/pdf',
        filename: s.filename,
      }));

    // Optimistically append the user message so it appears immediately while
    // the request is in flight. The main process will persist its own copy;
    // when 'done' arrives we replace our local list with the persisted view
    // by re-reading the session in the background (cheap).
    const optimisticContent: ChatContentPart[] = [];
    if (text) optimisticContent.push({ type: 'text', text });
    for (const img of images) optimisticContent.push(img);
    for (const pdf of pdfs) optimisticContent.push(pdf);
    const optimistic: ChatMessage = {
      id: `tmp-${newId()}`,
      role: 'user',
      content: optimisticContent,
      timestamp: new Date().toISOString(),
    };
    setSession({ ...session, messages: [...session.messages, optimistic] });
    setDraft('');
    setStaged([]);
    setStreamingText('');

    try {
      const requestId = await window.api.chat.send({
        scope,
        text,
        images,
        pdfs,
        model,
        excludedSourceIds,
        excludedMeetingSlugs,
      });
      setPendingRequestId(requestId);
    } catch (err) {
      setStreamingText(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function onComposerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSend();
    }
  }

  const [exporting, setExporting] = useState(false);

  async function handleExportContext() {
    if (exporting) return;
    setExporting(true);
    setError(null);
    try {
      await window.api.exportBundle.save(scope);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  async function handleClearChat() {
    if (!confirm('Clear this conversation? This cannot be undone.')) return;
    try {
      await window.api.chat.clear(scope);
      const fresh = await window.api.chat.read(scope);
      setSession(fresh);
      setStreamingText(null);
      setPendingRequestId(null);
      setStaged([]);
      setDraft('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // ---------------------------------------------------------- render

  const messageList = useMemo(() => session?.messages ?? [], [session]);

  return (
    <div
      className={`chat-view${className ? ` ${className}` : ''}${dragOver ? ' chat-view--drag' : ''}`}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        dragCounter.current += 1;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragCounter.current = Math.max(0, dragCounter.current - 1);
        if (dragCounter.current === 0) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <div className="chat-view-toolbar">
        {scope.kind === 'project' && (
          <button
            className="chat-view-export"
            onClick={() => void handleExportContext()}
            disabled={exporting}
            title="Export project context as a zip you can attach to Claude / ChatGPT / Gemini"
            aria-label="Export context"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>{exporting ? 'Preparing…' : 'Export context'}</span>
          </button>
        )}
        <span className="chat-view-toolbar-spacer" />
        {messageList.length > 0 && (
          <button
            className="chat-view-clear"
            onClick={() => void handleClearChat()}
            title="Clear conversation"
            aria-label="Clear conversation"
          >
            Clear
          </button>
        )}
      </div>

      <div
        className="chat-messages"
        ref={messagesScrollRef}
        onScroll={recomputePinned}
      >
        {messageList.map((m) => (
          <ChatMessageRow key={m.id} message={m} />
        ))}
        {streamingText !== null && (
          <div className="chat-msg chat-msg-assistant">
            <div className="chat-msg-body">
              {streamingText ? (
                <Markdown>{streamingText}</Markdown>
              ) : (
                <span className="chat-typing" aria-label="Assistant is typing">
                  <span /> <span /> <span />
                </span>
              )}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
        {!isPinned && (messageList.length > 0 || streamingText !== null) && (
          <button
            type="button"
            className="chat-jump-latest"
            onClick={() => scrollToLatest('smooth')}
            title="Jump to latest"
            aria-label="Jump to latest"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <span>Jump to latest</span>
          </button>
        )}
      </div>

      {error && (
        <div className="chat-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <div className="chat-composer">
        {staged.length > 0 && (
          <div className="chat-composer-thumbs">
            {staged.map((s) =>
              s.kind === 'image' ? (
                <div className="chat-composer-thumb" key={s.id} title={s.filename}>
                  <img src={s.dataUrl} alt={s.filename} />
                  <button
                    className="chat-composer-thumb-remove"
                    aria-label={`Remove ${s.filename}`}
                    onClick={() => setStaged((prev) => prev.filter((p) => p.id !== s.id))}
                  >
                    ×
                  </button>
                </div>
              ) : (
                <div
                  className="chat-composer-thumb chat-composer-thumb--pdf"
                  key={s.id}
                  title={`${s.filename} (${formatSize(s.size)})`}
                >
                  <span className="chat-composer-thumb-pdf-badge">PDF</span>
                  <span className="chat-composer-thumb-pdf-name">{s.filename}</span>
                  <button
                    className="chat-composer-thumb-remove"
                    aria-label={`Remove ${s.filename}`}
                    onClick={() => setStaged((prev) => prev.filter((p) => p.id !== s.id))}
                  >
                    ×
                  </button>
                </div>
              ),
            )}
          </div>
        )}
        <textarea
          ref={composerRef}
          className="chat-composer-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onComposerKey}
          placeholder={
            scope.kind === 'project'
              ? 'Ask about this project\u2026  (\u2318+Enter to send)'
              : 'Ask about this meeting\u2026  (\u2318+Enter to send)'
          }
          rows={2}
          disabled={!session}
        />
        <div className="chat-composer-row">
          <div className="chat-composer-left">
            <button
              className="chat-composer-icon-btn"
              onClick={() => fileInputRef.current?.click()}
              title="Attach images or PDFs"
              aria-label="Attach files"
              disabled={!session || staged.length >= MAX_ATTACHMENTS_PER_TURN}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf"
              multiple
              style={{ display: 'none' }}
              onChange={onPickAttachments}
            />
            <ModelPicker value={model} onChange={setModel} models={models} />
          </div>
          <button
            className="btn btn-primary chat-composer-send"
            onClick={() => void handleSend()}
            disabled={!canSend}
            title={canSend ? 'Send (\u2318+Enter)' : 'Enter a message'}
          >
            Send
          </button>
        </div>
      </div>

      {dragOver && <div className="chat-drop-hint">Drop image or PDF to attach</div>}
    </div>
  );
}

// ============================================================ subcomponents

function ChatMessageRow({ message }: { message: ChatMessage }) {
  const text = messageText(message);
  const images = messageImages(message);
  const pdfs = messagePdfs(message);
  const isUser = message.role === 'user';
  return (
    <div className={`chat-msg ${isUser ? 'chat-msg-user' : 'chat-msg-assistant'}`}>
      <div className="chat-msg-body">
        {images.length > 0 && (
          <div className="chat-msg-images">
            {images.map((img, i) => (
              <img
                key={i}
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={img.filename ?? `image ${i + 1}`}
              />
            ))}
          </div>
        )}
        {pdfs.length > 0 && (
          <div className="chat-msg-pdfs">
            {pdfs.map((pdf, i) => (
              <div className="chat-msg-pdf-chip" key={i} title={pdf.filename}>
                <span className="chat-msg-pdf-chip-badge">PDF</span>
                <span className="chat-msg-pdf-chip-name">{pdf.filename}</span>
              </div>
            ))}
          </div>
        )}
        {text && (isUser ? <div className="chat-msg-text">{text}</div> : <Markdown>{text}</Markdown>)}
      </div>
    </div>
  );
}

function ModelPicker({
  value,
  onChange,
  models,
}: {
  value: string;
  onChange: (id: string) => void;
  models: ModelInfo[];
}) {
  const current = models.find((m) => m.id === value) ?? models[0];
  if (!models.length) return null;
  return (
    <select
      className="chat-model-picker"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title={current?.description ?? current?.label ?? value}
    >
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
  );
}
