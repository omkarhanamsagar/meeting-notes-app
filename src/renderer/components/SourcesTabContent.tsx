import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MeetingMeta, SourceEntry, SourceKind } from '../../shared/types';
import { fileToDataUrl, formatSize } from '../lib/files';
import { relativeTime } from '../lib/format';

interface SourcesTabContentProps {
  team: string;
  project: string;
  /** Bumped by the parent to force a refresh (e.g. after switching projects). */
  refreshKey?: number;
  /** Source ids excluded from chat context. */
  excludedSourceIds: Set<string>;
  /** Meeting dir basenames excluded from chat context. */
  excludedMeetingSlugs: Set<string>;
  /** Toggle a single source id in/out of the excluded set. */
  toggleSource: (id: string) => void;
  /** Toggle a single meeting slug in/out of the excluded set. */
  toggleMeeting: (slug: string) => void;
  /** Bulk set helpers (used by select-all/none controls). */
  setExcludedSourceIds: (next: Set<string>) => void;
  setExcludedMeetingSlugs: (next: Set<string>) => void;
}

function dirBasename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
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

function kindIcon(kind: SourceKind): string {
  if (kind === 'pdf') return 'PDF';
  if (kind === 'image') return 'IMG';
  return 'TXT';
}

/**
 * Body of the Sources tab inside the project side rail. Owns:
 *   - the list of currently-attached sources
 *   - drag-and-drop ingestion (with proper enter/leave counting)
 *   - native file picker via the host-supplied imperative ref
 *   - clipboard paste while focused
 *
 * The hosting rail renders the title and the "+ Add" button in its header;
 * those call `pickFiles()` and `addCount`/`isBusy` via the imperative API
 * exposed below.
 */
export function SourcesTabContent({
  team,
  project,
  refreshKey = 0,
  excludedSourceIds,
  excludedMeetingSlugs,
  toggleSource,
  toggleMeeting,
  setExcludedSourceIds,
  setExcludedMeetingSlugs,
}: SourcesTabContentProps) {
  const [sources, setSources] = useState<SourceEntry[]>([]);
  const [meetings, setMeetings] = useState<MeetingMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [internalKey, setInternalKey] = useState(0);
  const [meetingsOpen, setMeetingsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragCounter = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, meetingList] = await Promise.all([
        window.api.sources.list(team, project),
        window.api.meetings.list({ team, project }),
      ]);
      setSources(list);
      // Sort meetings newest-first for the UI; the backend already filters by team/project.
      setMeetings(
        [...meetingList].sort((a, b) =>
          (b.startedAt || '').localeCompare(a.startedAt || ''),
        ),
      );
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

  const includedSourceCount = useMemo(
    () => sources.filter((s) => !excludedSourceIds.has(s.id)).length,
    [sources, excludedSourceIds],
  );
  const includedMeetingCount = useMemo(
    () => meetings.filter((m) => !excludedMeetingSlugs.has(dirBasename(m.dir))).length,
    [meetings, excludedMeetingSlugs],
  );

  async function onRemove(entry: SourceEntry) {
    if (
      !confirm(
        `Remove "${entry.filename}" from this project's sources? Future meetings won't see it anymore.`,
      )
    ) {
      return;
    }
    try {
      await window.api.sources.remove(team, project, entry.id);
      setInternalKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div
      ref={rootRef}
      className={`sources-tab${dragOver ? ' sources-tab--drag' : ''}`}
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
      <div className="sources-tab-toolbar">
        <button
          className="btn btn-ghost btn-sm"
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
        ) : (
          <>
            <SourceGroupHeader
              label="Files"
              count={sources.length}
              includedCount={includedSourceCount}
              onSelectAll={() => setExcludedSourceIds(new Set())}
              onSelectNone={() =>
                setExcludedSourceIds(new Set(sources.map((s) => s.id)))
              }
            />
            {sources.length === 0 ? (
              <div className="sources-panel-empty">
                <p>No sources yet.</p>
                <p className="sources-panel-hint">
                  Drag and drop PDFs, screenshots, or text files here, paste an image
                  with Cmd+V, or click +&nbsp;Add.
                </p>
              </div>
            ) : (
              sources.map((s) => {
                const included = !excludedSourceIds.has(s.id);
                return (
                  <div
                    className={`sources-row${included ? '' : ' sources-row--excluded'}`}
                    key={s.id}
                  >
                    <label className="sources-row-checkbox" title={included ? 'In context' : 'Excluded from context'}>
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={() => toggleSource(s.id)}
                      />
                    </label>
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
                );
              })
            )}

            <button
              type="button"
              className="sources-group-toggle"
              onClick={() => setMeetingsOpen((v) => !v)}
              aria-expanded={meetingsOpen}
            >
              <span className={`sources-group-chevron${meetingsOpen ? ' open' : ''}`} aria-hidden>
                ▸
              </span>
              <span className="sources-group-toggle-label">Meeting summaries</span>
              <span className="sources-group-toggle-count">
                {includedMeetingCount}/{meetings.length}
              </span>
            </button>
            {meetingsOpen && (
              <div className="sources-group-body">
                {meetings.length === 0 ? (
                  <div className="sources-panel-empty sources-panel-empty--compact">
                    No meetings in this project yet.
                  </div>
                ) : (
                  <>
                    <div className="sources-bulk-row">
                      <button
                        type="button"
                        className="sources-bulk-link"
                        onClick={() => setExcludedMeetingSlugs(new Set())}
                      >
                        Select all
                      </button>
                      <span className="sources-bulk-sep">·</span>
                      <button
                        type="button"
                        className="sources-bulk-link"
                        onClick={() =>
                          setExcludedMeetingSlugs(
                            new Set(meetings.map((m) => dirBasename(m.dir))),
                          )
                        }
                      >
                        Select none
                      </button>
                    </div>
                    {meetings.map((m) => {
                      const slug = dirBasename(m.dir);
                      const included = !excludedMeetingSlugs.has(slug);
                      const date = m.startedAt
                        ? new Date(m.startedAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })
                        : '';
                      return (
                        <label
                          key={m.dir}
                          className={`sources-meeting-row${included ? '' : ' sources-meeting-row--excluded'}`}
                        >
                          <input
                            type="checkbox"
                            checked={included}
                            onChange={() => toggleMeeting(slug)}
                          />
                          <span className="sources-meeting-title" title={m.title}>
                            {m.title || '(untitled)'}
                          </span>
                          {date && <span className="sources-meeting-date">{date}</span>}
                        </label>
                      );
                    })}
                  </>
                )}
              </div>
            )}
          </>
        )}
        {busy && <div className="sources-panel-busy">Uploading…</div>}
      </div>

      {dragOver && <div className="sources-panel-drop-hint">Drop to add</div>}
    </div>
  );
}

interface SourceGroupHeaderProps {
  label: string;
  count: number;
  includedCount: number;
  onSelectAll: () => void;
  onSelectNone: () => void;
}

function SourceGroupHeader({ label, count, includedCount, onSelectAll, onSelectNone }: SourceGroupHeaderProps) {
  if (count === 0) return null;
  return (
    <div className="sources-group-header">
      <span className="sources-group-label">{label}</span>
      <span className="sources-group-count">
        {includedCount}/{count}
      </span>
      <button type="button" className="sources-bulk-link" onClick={onSelectAll}>
        All
      </button>
      <span className="sources-bulk-sep">·</span>
      <button type="button" className="sources-bulk-link" onClick={onSelectNone}>
        None
      </button>
    </div>
  );
}
