import { useEffect, useState } from 'react';
import type { ProjectMeta, TeamMeta } from '../../shared/types';

interface MovePickerDialogProps {
  teams: TeamMeta[];
  /** Currently-selected team + project for the meeting. */
  currentTeam: string | null;
  currentProject: string | null;
  onCancel: () => void;
  onConfirm: (teamSlug: string, projectSlug: string) => void;
}

/**
 * Two-step picker: select a team, then a project within that team.
 * Used to re-file a meeting from the detail view.
 */
export function MovePickerDialog({
  teams,
  currentTeam,
  currentProject,
  onCancel,
  onConfirm,
}: MovePickerDialogProps) {
  const [team, setTeam] = useState<string | null>(currentTeam ?? teams[0]?.slug ?? null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [project, setProject] = useState<string | null>(currentProject);
  const [loading, setLoading] = useState(false);

  // Refresh project list whenever the selected team changes.
  useEffect(() => {
    if (!team) {
      setProjects([]);
      setProject(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void window.api.projects.list(team).then((list) => {
      if (cancelled) return;
      setProjects(list);
      // Preserve current selection if it still exists in the new team; else first.
      if (team === currentTeam && currentProject && list.some((p) => p.slug === currentProject)) {
        setProject(currentProject);
      } else {
        setProject(list[0]?.slug ?? null);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [team, currentTeam, currentProject]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!team || !project) return;
    onConfirm(team, project);
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Move meeting</h3>

        <div className="modal-row">
          <label htmlFor="move-team">Team</label>
          <select
            id="move-team"
            value={team ?? ''}
            onChange={(e) => setTeam(e.target.value || null)}
          >
            {teams.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name}
              </option>
            ))}
          </select>
        </div>

        <div className="modal-row">
          <label htmlFor="move-project">Project</label>
          <select
            id="move-project"
            value={project ?? ''}
            onChange={(e) => setProject(e.target.value || null)}
            disabled={loading || projects.length === 0}
          >
            {projects.length === 0 ? (
              <option value="">— No projects in this team —</option>
            ) : (
              projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!team || !project || (team === currentTeam && project === currentProject)}
          >
            Move
          </button>
        </div>
      </form>
    </div>
  );
}
