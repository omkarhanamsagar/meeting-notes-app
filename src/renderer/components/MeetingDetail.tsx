import { useEffect, useMemo, useState } from 'react';
import type {
  MeetingDetail as MeetingDetailType,
  ModelInfo,
  ProcessingUpdate,
  TeamMeta,
} from '../../shared/types';
import { ChatView } from './ChatView';
import { Markdown } from './Markdown';
import { MovePickerDialog } from './MovePickerDialog';
import { NotesEditor } from './NotesEditor';

type Tab = 'summary' | 'transcript' | 'notes' | 'chat';

/**
 * Strip noise that the renderer doesn't need to show:
 *   - leading H1 (title is already in the header)
 *   - `_Team:` / `_Project:` / `_Generated:` metadata lines
 *   - the trailing `<details>Raw transcript</details>` block (transcript has
 *     its own dedicated tab)
 */
function stripSummaryHeader(md: string): string {
  // Drop the trailing raw-transcript <details> block first.
  let cleaned = md.replace(/\n?---\s*\n+<details>[\s\S]*?<\/details>\s*$/m, '');
  // Also catch a <details> block that wasn't preceded by a hr.
  cleaned = cleaned.replace(/\n?<details>[\s\S]*?Raw transcript[\s\S]*?<\/details>\s*$/m, '');

  const lines = cleaned.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (i < lines.length && lines[i]!.startsWith('# ')) i++;
  while (i < lines.length) {
    const t = lines[i]!.trim();
    if (t === '') {
      i++;
      continue;
    }
    if (/^_(Team:|Project:|Generated:).*_$/.test(t)) {
      i++;
      continue;
    }
    if (t === '---') {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join('\n').trimEnd() + '\n';
}

interface MeetingDetailProps {
  detail: MeetingDetailType;
  teams: TeamMeta[];
  processing: ProcessingUpdate | undefined;
  models: ModelInfo[];
  defaultModel: string;
  onResummarize: () => void;
  onDelete: () => void;
  onDeleteRecording: () => void;
  onSaveNotes: (notes: string) => void;
  onRename: (newTitle: string) => void;
  onMove: (toTeam: string, toProject: string) => void;
}

export function MeetingDetail({
  detail,
  teams,
  processing,
  models,
  defaultModel,
  onResummarize,
  onDelete,
  onDeleteRecording: _onDeleteRecording,
  onSaveNotes,
  onRename,
  onMove,
}: MeetingDetailProps) {
  const { meta, summary, transcript, notes } = detail;

  const [tab, setTab] = useState<Tab>('summary');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(meta.title);
  const [movePickerOpen, setMovePickerOpen] = useState(false);

  useEffect(() => {
    setTab('summary');
    setEditingTitle(false);
    setTitleDraft(meta.title);
  }, [meta.dir, meta.title]);

  const subtitle = useMemo(
    () =>
      new Date(meta.startedAt).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [meta.startedAt],
  );

  const isProcessing =
    processing && (processing.stage === 'transcribing' || processing.stage === 'summarizing');

  function commitTitle() {
    const next = titleDraft.trim();
    setEditingTitle(false);
    if (next && next !== meta.title) {
      onRename(next);
    } else {
      setTitleDraft(meta.title);
    }
  }

  return (
    <div className="main" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="main-header">
        <div style={{ minWidth: 0, flex: 1 }}>
          {editingTitle ? (
            <input
              autoFocus
              className="meeting-title-edit"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle();
                if (e.key === 'Escape') {
                  setTitleDraft(meta.title);
                  setEditingTitle(false);
                }
              }}
            />
          ) : (
            <h2
              className="meeting-title"
              title="Click to rename"
              onClick={() => setEditingTitle(true)}
            >
              {meta.title}
            </h2>
          )}
          <div className="subtitle">{subtitle}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {isProcessing && (
            <span className="processing-pill">
              <span className="spinner" />
              {processing.stage === 'transcribing' ? 'Transcribing' : 'Summarizing'}…
            </span>
          )}
          {processing?.stage === 'error' && (
            <span className="processing-pill error-pill" title={processing.message}>
              Failed
            </span>
          )}
          <button
            className="btn btn-ghost"
            onClick={() => setMovePickerOpen(true)}
            title="Move to a different team or project"
          >
            Move…
          </button>
          <button className="btn btn-danger" onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>

      <div className="main-tabs">
        <div
          className={`tab ${tab === 'summary' ? 'active' : ''}`}
          onClick={() => setTab('summary')}
        >
          Summary
        </div>
        <div
          className={`tab ${tab === 'transcript' ? 'active' : ''}`}
          onClick={() => setTab('transcript')}
        >
          Transcript
        </div>
        <div className={`tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>
          Notes
        </div>
        <div className={`tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>
          Chat
        </div>
      </div>

      <div className="main-body">
        {tab === 'summary' && (
          summary ? (
            <div className="meeting-summary-wrap">
              <Markdown meetingDir={meta.dir}>{stripSummaryHeader(summary)}</Markdown>
            </div>
          ) : isProcessing ? (
            <div style={{ color: 'var(--text-muted)' }}>Summary will appear here when done.</div>
          ) : (
            <div style={{ color: 'var(--text-muted)' }}>
              No summary yet.{' '}
              {meta.hasTranscript || meta.hasRecording ? (
                <button
                  className="btn btn-ghost"
                  style={{ marginLeft: 8 }}
                  onClick={onResummarize}
                  title={
                    meta.hasTranscript
                      ? 'Re-run summarization on the existing transcript'
                      : 'Transcribe the recording, then summarize'
                  }
                >
                  {meta.hasTranscript ? 'Generate summary' : 'Transcribe & summarize'}
                </button>
              ) : (
                'No transcript or recording available.'
              )}
            </div>
          )
        )}

        {tab === 'transcript' && (
          transcript ? (
            <div className="meeting-summary-wrap">
              <TranscriptView transcript={transcript} />
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)' }}>No transcript yet.</div>
          )
        )}

        {tab === 'notes' && (
          <NotesEditor
            dir={meta.dir}
            initialValue={notes}
            onSave={onSaveNotes}
            placeholder="Your own notes — autosaves a moment after you stop typing. Drop or paste images to attach."
            className="notes-editor-detail"
          />
        )}

        {tab === 'chat' && (
          <ChatView
            scope={{ kind: 'meeting', dir: meta.dir }}
            models={models}
            defaultModel={defaultModel}
            className="chat-view--in-meeting"
          />
        )}

      </div>

      {movePickerOpen && (
        <MovePickerDialog
          teams={teams}
          currentTeam={meta.team}
          currentProject={meta.project}
          onCancel={() => setMovePickerOpen(false)}
          onConfirm={(team, project) => {
            setMovePickerOpen(false);
            onMove(team, project);
          }}
        />
      )}
    </div>
  );
}

function TranscriptView({ transcript }: { transcript: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // best-effort; older webviews without Clipboard API just won't show feedback
    }
  }

  return (
    <div className="transcript-stack">
      <div className="transcript-toolbar">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => void handleCopy()}
          title="Copy transcript to clipboard"
        >
          {copied ? 'Copied!' : 'Copy transcript'}
        </button>
      </div>
      <pre className="transcript-pre">{transcript}</pre>
    </div>
  );
}

