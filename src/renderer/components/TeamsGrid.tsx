import { useMemo } from 'react';
import type { TeamWithStats } from '../../shared/types';
import { relativeTime } from '../lib/format';

interface TeamsGridProps {
  teams: TeamWithStats[];
  onOpenTeam: (slug: string) => void;
  onNewTeam: () => void;
}

function colorIndexFor(slug: string, slots = 6): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) {
    h = (h * 31 + slug.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % slots;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export function TeamsGrid({ teams, onOpenTeam, onNewTeam }: TeamsGridProps) {
  const sortedTeams = useMemo(
    () =>
      [...teams].sort((a, b) => {
        const aTime = a.stats.lastActivityAt ?? '';
        const bTime = b.stats.lastActivityAt ?? '';
        if (aTime === bTime) return a.name.localeCompare(b.name);
        return bTime.localeCompare(aTime);
      }),
    [teams],
  );

  return (
    <div className="main workspaces-main">
      <div className="workspaces-header">
        <div>
          <h1>Teams</h1>
          <p className="workspaces-subtitle">
            {teams.length} team{teams.length === 1 ? '' : 's'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={onNewTeam}>
            + New team
          </button>
        </div>
      </div>

      <div className="workspaces-grid">
        {sortedTeams.map((t) => {
          const slot = colorIndexFor(t.slug);
          return (
            <button key={t.slug} className="workspace-tile" onClick={() => onOpenTeam(t.slug)}>
              <div className={`workspace-tile-icon color-${slot}`}>{initials(t.name)}</div>
              <div className="workspace-tile-name">{t.name}</div>
              <div className="workspace-tile-meta">
                {t.stats.projectCount} project{t.stats.projectCount === 1 ? '' : 's'} ·{' '}
                {relativeTime(t.stats.lastActivityAt)}
              </div>
            </button>
          );
        })}

        <button className="workspace-tile workspace-tile-new" onClick={onNewTeam}>
          <div className="workspace-tile-icon color-new">+</div>
          <div className="workspace-tile-name">New team</div>
          <div className="workspace-tile-meta">Create a new team</div>
        </button>
      </div>
    </div>
  );
}
