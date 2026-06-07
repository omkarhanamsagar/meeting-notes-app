import { useEffect, useRef, useState } from 'react';
import type { ProjectMeta, TeamMeta } from '../../shared/types';

interface NameAndFileModalProps {
  teams: TeamMeta[];
  defaultTeam: string | null;
  defaultProject: string | null;
  onSubmit: (title: string, team: string, project: string) => void;
}

/**
 * Blocking modal shown after a recording stops. Forces the user to give
 * the meeting a title before transcription/summarization begins. Team and
 * project default to the last-used values but can be reassigned here too.
 *
 * Cannot be dismissed via Esc or backdrop click — the only path forward is
 * filling in the title and clicking Save.
 */
export function NameAndFileModal({
  teams,
  defaultTeam,
  defaultProject,
  onSubmit,
}: NameAndFileModalProps) {
  const [title, setTitle] = useState('');
  const [team, setTeam] = useState<string | null>(defaultTeam ?? teams[0]?.slug ?? null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [project, setProject] = useState<string | null>(defaultProject);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Swallow Esc so the modal genuinely can't be dismissed by keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    if (!team) {
      setProjects([]);
      setProject(null);
      return;
    }
    let cancelled = false;
    void window.api.projects.list(team).then((list) => {
      if (cancelled) return;
      setProjects(list);
      if (team === defaultTeam && defaultProject && list.some((p) => p.slug === defaultProject)) {
        setProject(defaultProject);
      } else {
        setProject(list[0]?.slug ?? null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [team, defaultTeam, defaultProject]);

  const trimmed = title.trim();
  const canSubmit = !!trimmed && !!team && !!project && !submitting;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    onSubmit(trimmed, team!, project!);
  }

  return (
    <div className="name-modal-backdrop">
      <form className="name-modal" onSubmit={submit}>
        <div className="name-modal-header">
          <div className="name-modal-title">Name & file this meeting</div>
          <div className="name-modal-sub">Required — transcription starts once you save.</div>
        </div>

        <label className="name-modal-label">
          <span>Title</span>
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What was this meeting about?"
            required
          />
        </label>

        <label className="name-modal-label">
          <span>Team</span>
          <select value={team ?? ''} onChange={(e) => setTeam(e.target.value || null)}>
            {teams.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <label className="name-modal-label">
          <span>Project</span>
          <select
            value={project ?? ''}
            onChange={(e) => setProject(e.target.value || null)}
            disabled={projects.length === 0}
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
        </label>

        <div className="name-modal-actions">
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {submitting ? 'Saving…' : 'Save & process'}
          </button>
        </div>
      </form>
    </div>
  );
}

// Back-compat re-export so existing imports keep working until the rename
// fully propagates through the app.
export { NameAndFileModal as NameAndFileToast };
