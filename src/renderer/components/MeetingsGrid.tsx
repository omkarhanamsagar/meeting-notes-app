import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  MeetingMeta,
  ProcessingUpdate,
  ProjectMeta,
  TeamMeta,
  TeamWithStats,
} from '../../shared/types';
import { relativeDayLabel, shortDate, timeOfDay } from '../lib/format';
import { MovePickerDialog } from './MovePickerDialog';

interface MeetingsGridProps {
  team: TeamMeta;
  project: ProjectMeta;
  meetings: MeetingMeta[];
  teams: TeamWithStats[];
  processingBySlug: Record<string, ProcessingUpdate>;
  onSelectMeeting: (dir: string) => void;
  onMoveMeeting: (dir: string, toTeam: string, toProject: string) => void;
  onDeleteMeeting: (dir: string) => void;
}

interface DayGroup {
  label: string;
  meetings: MeetingMeta[];
}

function groupByDay(meetings: MeetingMeta[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;
  for (const m of meetings) {
    const label = relativeDayLabel(m.startedAt);
    if (!current || current.label !== label) {
      current = { label, meetings: [] };
      groups.push(current);
    }
    current.meetings.push(m);
  }
  return groups;
}

/**
 * Returns an in-progress label if the meeting is still being processed,
 * otherwise null.
 */
function inProgressLabel(update: ProcessingUpdate | undefined): string | null {
  if (!update) return null;
  switch (update.stage) {
    case 'transcribing':
      return 'Transcribing…';
    case 'summarizing':
      return 'Summarizing…';
    case 'recording':
      return 'Recording';
    case 'error':
      return 'Failed';
    default:
      return null;
  }
}

export function MeetingsGrid({
  team: _team,
  project,
  meetings,
  teams,
  processingBySlug,
  onSelectMeeting,
  onMoveMeeting,
  onDeleteMeeting,
}: MeetingsGridProps) {
  const groups = useMemo(() => groupByDay(meetings), [meetings]);

  // Which tile's menu is open (by meeting.dir), and which meeting is being moved.
  const [openMenuDir, setOpenMenuDir] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<MeetingMeta | null>(null);

  // Close the menu on any outside click / escape.
  useEffect(() => {
    if (!openMenuDir) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.tile-menu') && !target.closest('.tile-menu-btn')) {
        setOpenMenuDir(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenuDir(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenuDir]);

  const teamMetas = useMemo(() => teams.map(({ stats: _s, ...rest }) => rest), [teams]);

  return (
    <div className="main workspaces-main">
      <div className="workspaces-header">
        <div>
          <h1>{project.name}</h1>
          <p className="workspaces-subtitle">
            {meetings.length} meeting{meetings.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {meetings.length === 0 ? (
        <div className="empty-hero" style={{ paddingTop: 32 }}>
          <p>No meetings yet in this project. Click Record to start one.</p>
        </div>
      ) : (
        <div className="meetings-list">
          {groups.map((group) => (
            <div key={group.label} className="meetings-day-group">
              <div className="meetings-day-label">{group.label}</div>
              <div className="workspaces-grid">
                {group.meetings.map((m) => {
                  const inProgress = inProgressLabel(processingBySlug[m.slug]);
                  const menuOpen = openMenuDir === m.dir;
                  return (
                    <MeetingTile
                      key={m.dir}
                      meeting={m}
                      inProgress={inProgress}
                      menuOpen={menuOpen}
                      onClick={() => onSelectMeeting(m.dir)}
                      onToggleMenu={() => setOpenMenuDir((prev) => (prev === m.dir ? null : m.dir))}
                      onCloseMenu={() => setOpenMenuDir(null)}
                      onMove={() => {
                        setOpenMenuDir(null);
                        setMoveTarget(m);
                      }}
                      onDelete={() => {
                        setOpenMenuDir(null);
                        if (confirm(`Delete "${m.title}"? This cannot be undone.`)) {
                          onDeleteMeeting(m.dir);
                        }
                      }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {moveTarget && (
        <MovePickerDialog
          teams={teamMetas}
          currentTeam={moveTarget.team}
          currentProject={moveTarget.project}
          onCancel={() => setMoveTarget(null)}
          onConfirm={(team, proj) => {
            const dir = moveTarget.dir;
            setMoveTarget(null);
            onMoveMeeting(dir, team, proj);
          }}
        />
      )}
    </div>
  );
}

interface MeetingTileProps {
  meeting: MeetingMeta;
  inProgress: string | null;
  menuOpen: boolean;
  onClick: () => void;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onMove: () => void;
  onDelete: () => void;
}

function MeetingTile({
  meeting: m,
  inProgress,
  menuOpen,
  onClick,
  onToggleMenu,
  onMove,
  onDelete,
}: MeetingTileProps) {
  const ref = useRef<HTMLDivElement>(null);

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  }

  return (
    <div
      ref={ref}
      className="workspace-tile meeting-tile"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKey}
    >
      <button
        className="tile-menu-btn"
        aria-label="Meeting actions"
        title="More actions"
        onClick={(e) => {
          e.stopPropagation();
          onToggleMenu();
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="12" cy="5" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="12" cy="19" r="1.8" />
        </svg>
      </button>

      {menuOpen && (
        <div className="tile-menu" onClick={(e) => e.stopPropagation()}>
          <button className="tile-menu-item" onClick={onMove}>
            Move…
          </button>
          <button className="tile-menu-item tile-menu-item-danger" onClick={onDelete}>
            Delete
          </button>
        </div>
      )}

      <div className="meeting-tile-name">{m.title}</div>
      <div className="meeting-tile-time">
        {shortDate(m.startedAt)} · {timeOfDay(m.startedAt)}
      </div>
      {inProgress && <div className="meeting-tile-status">{inProgress}</div>}
    </div>
  );
}
