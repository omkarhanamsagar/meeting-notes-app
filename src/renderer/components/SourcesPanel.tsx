import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceEntry, SourceKind } from '../../shared/types';
import { relativeTime } from '../lib/format';

interface SourcesPanelProps {
  team: string;
  project: string;
  /** Bumped by the parent (or by us) to trigger a refresh. */
  refreshKey?: number;
}

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.md,.txt,.markdown,.rst,.log';
const MAX_BYTES = 25 * 1024 * 1024;

const SUPPORTED_EXTS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.md',
  '.txt',
  '.markdown',
  '.rst',
  '.log',
]);

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

function kindIcon(kind: SourceKind): string {
  if (kind === 'pdf') return 'PDF';
  if (kind === 'image') return 'IMG';
  return 'TXT';
}

const COLLAPSED_KEY = 'sourcesPanel.collapsed';

export function SourcesPanel({ team, project, refreshKey = 0 }: SourcesPanelProps) {
  const [sources, setSources] = useState<SourceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [internalKey, setInternalKey] = useState(0);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Counter approach to track nested dragenter/dragleave reliably.
  const dragCounter = useRef(0);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // ignore quota errors
      }
      return next;
    });
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.api.sources.list(team, project);
      setSources(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [team, project]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey, internalKey]);

  const ingest = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setBusy(true);
      setError(null);
      const errors: string[] = [];
      for (const file of files) {
        const ext = extOf(file.name);
        if (!SUPPORTED_EXTS.has(ext)) {
          errors.push(`${file.name}: unsupported file type (allowed: PDF, images, text/markdown)`);
          continue;
        }
        if (file.size > MAX_BYTES) {
          errors.push(`${file.name}: too large (${formatSize(file.size)}, max ${formatSize(MAX_BYTES)})`);
          continue;
        }
        try {
          const dataUrl = await fileToDataUrl(file);
          await window.api.sources.add({
            team,
            project,
            filename: file.name,
            dataUrl,
            mimeType: file.type || undefined,
          });
        } catch (err) {
          errors.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (errors.length) setError(errors.join('\n'));
      setBusy(false);
      setInternalKey((k) => k + 1);
    },
    [team, project],
  );

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list) return;
    void ingest(Array.from(list));
    e.target.value = '';
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) void ingest(files);
  }

  // Global backstop: if the drag ends or leaves the window entirely (e.g.
  // user drops outside the panel, or hits Escape), clear the overlay.
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

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        void ingest(files);
      }
    }
    root.addEventListener('paste', onPaste);
    return () => root.removeEventListener('paste', onPaste);
  }, [ingest]);

  async function onRemove(entry: SourceEntry) {
    if (!confirm(`Remove "${entry.filename}" from this project's sources? Future meetings won't see it anymore.`)) {
      return;
    }
    try {
      await window.api.sources.remove(team, project, entry.id);
      setInternalKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (collapsed) {
    return (
      <aside className="sources-panel sources-panel--collapsed">
        <button
          className="sources-panel-rail"
          onClick={toggleCollapsed}
          title={`Show sources${sources.length > 0 ? ` (${sources.length})` : ''}`}
          aria-label="Show sources"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="8" y1="13" x2="16" y2="13" />
            <line x1="8" y1="17" x2="16" y2="17" />
          </svg>
        </button>
      </aside>
    );
  }

  return (
    <aside
      ref={rootRef}
      className={`sources-panel${dragOver ? ' sources-panel--drag' : ''}`}
      tabIndex={0}
      onDragEnter={(e) => {
        e.preventDefault();
        dragCounter.current += 1;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragCounter.current = Math.max(0, dragCounter.current - 1);
        if (dragCounter.current === 0) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <div className="sources-panel-header">
        <button
          className="sources-panel-collapse-btn"
          onClick={toggleCollapsed}
          title="Hide sources"
          aria-label="Hide sources"
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
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <h3 className="sources-panel-title">Sources</h3>
        <button
          className="btn btn-ghost"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          title="Add source"
        >
          + Add
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          multiple
          style={{ display: 'none' }}
          onChange={onPickFiles}
        />
      </div>

      {error && (
        <div className="sources-panel-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <div className="sources-panel-list">
        {loading ? (
          <div className="sources-panel-empty">Loading…</div>
        ) : sources.length === 0 ? (
          <div className="sources-panel-empty">
            <p>No sources yet.</p>
            <p className="sources-panel-hint">
              Drag and drop PDFs, screenshots, or text files here, paste an image
              with Cmd+V, or click +&nbsp;Add.
            </p>
          </div>
        ) : (
          sources.map((s) => (
            <div className="sources-row" key={s.id}>
              <div className={`sources-row-kind sources-row-kind--${s.kind}`}>{kindIcon(s.kind)}</div>
              <div className="sources-row-body">
                <div className="sources-row-name" title={s.filename}>
                  {s.filename}
                </div>
                <div className="sources-row-meta">
                  {formatSize(s.sizeBytes)} · added {relativeTime(s.addedAt)}
                </div>
              </div>
              <button
                className="sources-row-remove"
                aria-label={`Remove ${s.filename}`}
                title="Remove"
                onClick={() => void onRemove(s)}
              >
                ×
              </button>
            </div>
          ))
        )}
        {busy && <div className="sources-panel-busy">Uploading…</div>}
      </div>

      {dragOver && <div className="sources-panel-drop-hint">Drop to add</div>}
    </aside>
  );
}
