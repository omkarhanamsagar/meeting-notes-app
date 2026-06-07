import { useEffect, useState } from 'react';
import { formatDuration } from '../lib/format';

interface RecordingPillProps {
  startedAt: number;
  title: string;
  onStop: () => void;
  stopping: boolean;
}

/**
 * The "● Recording 00:01:23" indicator in the title bar.
 * Owns its own ticker so the parent doesn't re-render every second.
 */
export function RecordingPill({ startedAt, title, onStop, stopping }: RecordingPillProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const elapsed = (now - startedAt) / 1000;

  return (
    <div className="recording-pill">
      <span className="dot" />
      <span>{title}</span>
      <span>·</span>
      <span>{formatDuration(elapsed)}</span>
      <button
        className="btn btn-stop"
        style={{ marginLeft: 8, padding: '2px 8px', fontSize: 12 }}
        onClick={onStop}
        disabled={stopping}
      >
        {stopping ? 'Stopping…' : 'Stop'}
      </button>
    </div>
  );
}
