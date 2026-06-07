import { useEffect, useState } from 'react';
import { NotesEditor } from './NotesEditor';

interface RecordingCanvasProps {
  dir: string;
  /** Epoch ms when the recording started — propagated to NotesEditor so
   *  dropped screenshots get tagged with their timestamp into the meeting. */
  recordingStartedAt: number | null;
}

/**
 * Full-screen recording mode: a free-form notes surface that the user
 * can type in or drop screenshots onto while a recording is live.
 *
 * Delegates rendering + persistence to NotesEditor — the same component
 * the Notes tab uses on a finished meeting — so the live and post-stop
 * experiences are identical.
 */
export function RecordingCanvas({ dir, recordingStartedAt }: RecordingCanvasProps) {
  const [initialValue, setInitialValue] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.api.meetings.get(dir).then((detail) => {
      if (cancelled) return;
      setInitialValue(detail.notes ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  return (
    <div className="recording-canvas">
      <div className="recording-canvas-inner">
        {initialValue === null ? (
          <div className="recording-canvas-placeholder">Loading notes…</div>
        ) : (
          <NotesEditor
            dir={dir}
            initialValue={initialValue}
            placeholder="Take notes while you record. Drop or paste screenshots anywhere on this canvas."
            onSave={(md) => void window.api.meetings.saveNotes(dir, md)}
            className="notes-editor-canvas"
            recordingStartedAt={recordingStartedAt}
          />
        )}
      </div>
    </div>
  );
}
