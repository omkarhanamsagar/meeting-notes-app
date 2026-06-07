import { useMemo } from 'react';
import type { ProjectWithStats, TeamMeta } from '../../shared/types';
import { relativeTime } from '../lib/format';

interface ProjectsGridProps {
  team: TeamMeta;
  projects: ProjectWithStats[];
  onOpenProject: (slug: string) => void;
  onNewProject: () => void;
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

export function ProjectsGrid({
  team,
  projects,
  onOpenProject,
  onNewProject,
}: ProjectsGridProps) {
  const sortedProjects = useMemo(
    () =>
      [...projects].sort((a, b) => {
        const aTime = a.stats.lastActivityAt ?? '';
        const bTime = b.stats.lastActivityAt ?? '';
        if (aTime === bTime) return a.name.localeCompare(b.name);
        return bTime.localeCompare(aTime);
      }),
    [projects],
  );

  return (
    <div className="main workspaces-main">
      <div className="workspaces-header">
        <div>
          <h1>{team.name}</h1>
          <p className="workspaces-subtitle">
            {projects.length} project{projects.length === 1 ? '' : 's'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onNewProject}>
            + New project
          </button>
        </div>
      </div>

      <div className="workspaces-grid">
        {sortedProjects.map((p) => {
          const slot = colorIndexFor(p.slug);
          return (
            <button
              key={p.slug}
              className="workspace-tile"
              onClick={() => onOpenProject(p.slug)}
            >
              <div className={`workspace-tile-icon color-${slot}`}>{initials(p.name)}</div>
              <div className="workspace-tile-name">{p.name}</div>
              <div className="workspace-tile-meta">
                {p.stats.meetingCount} meeting{p.stats.meetingCount === 1 ? '' : 's'} ·{' '}
                {relativeTime(p.stats.lastActivityAt)}
              </div>
            </button>
          );
        })}

        <button className="workspace-tile workspace-tile-new" onClick={onNewProject}>
          <div className="workspace-tile-icon color-new">+</div>
          <div className="workspace-tile-name">New project</div>
          <div className="workspace-tile-meta">Create a new project</div>
        </button>
      </div>
    </div>
  );
}
