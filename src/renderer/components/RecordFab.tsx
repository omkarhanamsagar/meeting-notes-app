interface RecordFabProps {
  disabled: boolean;
  disabledReason?: string;
  onClick: () => void;
}

/**
 * Floating action button anchored to the bottom-right of the app shell.
 * Visible from every non-recording view so recording is always one click
 * away regardless of where the user is browsing.
 */
export function RecordFab({ disabled, disabledReason, onClick }: RecordFabProps) {
  return (
    <button
      type="button"
      className="record-fab"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledReason ?? 'Cannot record yet' : 'Start recording'}
      aria-label="Start recording"
    >
      <span className="record-fab-dot" />
      <span className="record-fab-label">Record</span>
    </button>
  );
}
