import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MeetingDetail as MeetingDetailType,
  MeetingMeta,
  ModelInfo,
  ProcessingUpdate,
  ProjectMeta,
  ProjectWithStats,
  RecordingState,
  TeamMeta,
  TeamWithStats,
} from '../shared/types';
import { MeetingDetail } from './components/MeetingDetail';
import { MeetingsGrid } from './components/MeetingsGrid';
import { RecordingPill } from './components/RecordingPill';
import { RecordingCanvas } from './components/RecordingCanvas';
import { NameAndFileModal } from './components/NameAndFileToast';
import { NewProjectDialog } from './components/NewProjectDialog';
import { NewTeamDialog } from './components/NewTeamDialog';
import { SettingsPanel } from './components/SettingsPanel';
import { ProjectSideRail } from './components/ProjectSideRail';
import { TeamsGrid } from './components/TeamsGrid';
import { ProjectsGrid } from './components/ProjectsGrid';
import { Breadcrumb } from './components/Breadcrumb';

type View =
  | { kind: 'teams' }
  | { kind: 'team'; teamSlug: string }
  | { kind: 'project'; teamSlug: string; projectSlug: string }
  | { kind: 'settings' };

type Modal =
  | { kind: 'none' }
  | { kind: 'newProject' }
  | { kind: 'newTeam' };

interface PendingNameModal {
  dir: string;
  team: string;
  project: string;
}

export function App() {
  // ---------------------------------------------------------------- state
  const [teams, setTeams] = useState<TeamWithStats[]>([]);
  const [teamMetas, setTeamMetas] = useState<TeamMeta[]>([]);
  const [projectsInCurrentTeam, setProjectsInCurrentTeam] = useState<ProjectWithStats[]>([]);
  const [meetings, setMeetings] = useState<MeetingMeta[]>([]);
  const [currentProject, setCurrentProject] = useState<ProjectMeta | null>(null);
  const [view, setView] = useState<View>({ kind: 'teams' });
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [detail, setDetail] = useState<MeetingDetailType | null>(null);
  const [recordingState, setRecordingState] = useState<RecordingState>({
    active: false,
    meetingSlug: null,
    title: null,
    startedAt: null,
    dir: null,
  });
  const [processingBySlug, setProcessingBySlug] = useState<Record<string, ProcessingUpdate>>({});
  const [modal, setModal] = useState<Modal>({ kind: 'none' });
  const [stopping, setStopping] = useState(false);
  const [nameModal, setNameModal] = useState<PendingNameModal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);

  // ---------------------------------------------------------------- derived

  const currentTeam = useMemo(() => {
    if (view.kind === 'team' || view.kind === 'project') {
      return teamMetas.find((t) => t.slug === view.teamSlug) ?? null;
    }
    return null;
  }, [view, teamMetas]);

  // ---------------------------------------------------------------- data fetchers

  const refreshTeams = useCallback(async () => {
    const list = await window.api.teams.listWithStats();
    setTeams(list);
    setTeamMetas(list.map(({ stats: _stats, ...rest }) => rest));
  }, []);

  const refreshProjectsForTeam = useCallback(async (teamSlug: string) => {
    const list = await window.api.projects.listWithStats(teamSlug);
    setProjectsInCurrentTeam(list);
  }, []);

  const refreshMeetingsForProject = useCallback(
    async (teamSlug: string, projectSlug: string) => {
      const list = await window.api.meetings.list({ team: teamSlug, project: projectSlug });
      setMeetings(list);
    },
    [],
  );

  const refreshDetail = useCallback(async (dir: string) => {
    try {
      const d = await window.api.meetings.get(dir);
      setDetail(d);
    } catch (err) {
      console.error('Failed to load meeting detail', err);
      setDetail(null);
    }
  }, []);

  // ---------------------------------------------------------------- bootstrap

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [teamsList, state, recState, modelsList] = await Promise.all([
        window.api.teams.listWithStats(),
        window.api.appState.get(),
        window.api.recording.getState(),
        window.api.models.list().catch(() => [] as ModelInfo[]),
      ]);
      if (cancelled) return;

      setTeams(teamsList);
      setTeamMetas(teamsList.map(({ stats: _stats, ...rest }) => rest));
      setRecordingState(recState);
      setModels(modelsList);

      const lastTeam = state.lastTeamSlug;
      const lastProject = state.lastProjectSlug;

      if (lastTeam && teamsList.some((t) => t.slug === lastTeam)) {
        // Try to drill all the way into the last project.
        const projList = await window.api.projects.listWithStats(lastTeam);
        if (cancelled) return;
        setProjectsInCurrentTeam(projList);

        if (lastProject && projList.some((p) => p.slug === lastProject)) {
          const proj = projList.find((p) => p.slug === lastProject) ?? null;
          setCurrentProject(proj);
          await refreshMeetingsForProject(lastTeam, lastProject);
          if (cancelled) return;
          setView({ kind: 'project', teamSlug: lastTeam, projectSlug: lastProject });
        } else {
          setView({ kind: 'team', teamSlug: lastTeam });
        }
      } else {
        setView({ kind: 'teams' });
      }
      setBootstrapped(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshMeetingsForProject]);

  // Keep refs current for the processing-update subscription.
  const selectedDirRef = useRef(selectedDir);
  useEffect(() => {
    selectedDirRef.current = selectedDir;
  }, [selectedDir]);

  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const unsubProcessing = window.api.onProcessingUpdate((update) => {
      void window.api.recording.getState().then(setRecordingState);

      if (!update.meetingSlug) return;
      setProcessingBySlug((prev) => ({ ...prev, [update.meetingSlug as string]: update }));

      const v = viewRef.current;
      if (v.kind === 'project') {
        void refreshMeetingsForProject(v.teamSlug, v.projectSlug);
      }
      void refreshTeams();
      if (selectedDirRef.current) {
        void refreshDetail(selectedDirRef.current);
      }
    });

    const unsubStart = window.api.onOpenStartRecording(() => {
      void handleStartRecording();
    });
    const unsubSettings = window.api.onOpenSettings(() => {
      setView({ kind: 'settings' });
      setSelectedDir(null);
    });

    return () => {
      unsubProcessing();
      unsubStart();
      unsubSettings();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTeams, refreshMeetingsForProject, refreshDetail]);

  // Detail loading when selection changes
  useEffect(() => {
    if (selectedDir) void refreshDetail(selectedDir);
    else setDetail(null);
  }, [selectedDir, refreshDetail]);

  // While recording, clear any selected meeting so the user lands back on
  // the project (or whatever home view they were on) once they stop — the
  // canvas view takes over the main area in the meantime.
  useEffect(() => {
    if (recordingState.active) {
      setSelectedDir(null);
    }
  }, [recordingState.active]);

  // Fallback dir lookup: if the main process returned a recording state
  // without `dir` (older preload, or transient state right after start),
  // resolve it from the on-disk meeting list using the slug. Keeps the
  // canvas reliably visible even when the IPC payload is incomplete.
  const [resolvedRecordingDir, setResolvedRecordingDir] = useState<string | null>(null);
  useEffect(() => {
    if (!recordingState.active) {
      setResolvedRecordingDir(null);
      return;
    }
    if (recordingState.dir) {
      setResolvedRecordingDir(recordingState.dir);
      return;
    }
    if (!recordingState.meetingSlug) return;
    let cancelled = false;
    void window.api.meetings.list().then((all) => {
      if (cancelled) return;
      const match = all.find((m) => m.slug === recordingState.meetingSlug);
      if (match) setResolvedRecordingDir(match.dir);
    });
    return () => {
      cancelled = true;
    };
  }, [recordingState.active, recordingState.dir, recordingState.meetingSlug]);

  // ---------------------------------------------------------------- nav helpers

  async function openTeam(teamSlug: string) {
    setSelectedDir(null);
    setCurrentProject(null);
    setMeetings([]);
    setView({ kind: 'team', teamSlug });
    await window.api.appState.set({ lastTeamSlug: teamSlug, lastProjectSlug: null });
    await refreshProjectsForTeam(teamSlug);
  }

  async function openProject(teamSlug: string, projectSlug: string) {
    setSelectedDir(null);
    setView({ kind: 'project', teamSlug, projectSlug });
    await window.api.appState.set({ lastTeamSlug: teamSlug, lastProjectSlug: projectSlug });
    const projects = await window.api.projects.listWithStats(teamSlug);
    setProjectsInCurrentTeam(projects);
    const proj = projects.find((p) => p.slug === projectSlug) ?? null;
    setCurrentProject(proj);
    await refreshMeetingsForProject(teamSlug, projectSlug);
  }

  function backToTeams() {
    setSelectedDir(null);
    setCurrentProject(null);
    setMeetings([]);
    setView({ kind: 'teams' });
  }

  function backToProjects() {
    if (view.kind !== 'project') return;
    const teamSlug = view.teamSlug;
    setSelectedDir(null);
    setCurrentProject(null);
    setMeetings([]);
    setView({ kind: 'team', teamSlug });
  }

  // ---------------------------------------------------------------- handlers

  async function handleStartRecording(opts?: { team?: string; project?: string }) {
    setError(null);
    try {
      await window.api.recording.start(opts ?? {});
      const state = await window.api.recording.getState();
      setRecordingState(state);
      await refreshTeams();
      if (view.kind === 'project') {
        await refreshMeetingsForProject(view.teamSlug, view.projectSlug);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleStopRecording() {
    setStopping(true);
    try {
      const before = recordingState;
      const result = (await window.api.recording.stop()) as {
        dir: string;
        slug?: string;
        title?: string;
        team?: string;
        project?: string;
      };
      const state = await window.api.recording.getState();
      setRecordingState(state);

      // The new main returns the full filing context. Older builds only
      // return { dir }, so fall back to the most recent meeting record
      // for the slug we were recording.
      let team = result.team;
      let project = result.project;
      if (!team || !project) {
        const slug = before.meetingSlug;
        if (slug) {
          const meeting = (await window.api.meetings.list()).find((m) => m.slug === slug);
          team = team ?? meeting?.team ?? undefined;
          project = project ?? meeting?.project ?? undefined;
        }
      }

      // Open the blocking modal — no processing happens until the user
      // confirms a title via commitStop.
      setNameModal({
        dir: result.dir,
        team: team ?? '',
        project: project ?? '',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  }

  async function handleCreateTeam(slug: string, name: string, description: string) {
    setError(null);
    setModal({ kind: 'none' });
    try {
      await window.api.teams.create(slug, name, description);
      await refreshTeams();
      await openTeam(slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCreateProject(slug: string, name: string, description: string) {
    if (view.kind !== 'team' && view.kind !== 'project') {
      setError('Open a team before creating a project.');
      return;
    }
    const teamSlug = view.teamSlug;
    setError(null);
    setModal({ kind: 'none' });
    try {
      await window.api.projects.create(teamSlug, slug, name, description);
      await refreshTeams();
      await openProject(teamSlug, slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleResummarize() {
    if (!selectedDir) return;
    try {
      await window.api.meetings.resummarize(selectedDir);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDeleteMeeting() {
    if (!selectedDir) return;
    if (!confirm('Delete this meeting? This cannot be undone.')) return;
    try {
      await window.api.meetings.delete(selectedDir);
      setSelectedDir(null);
      if (view.kind === 'project') {
        await refreshMeetingsForProject(view.teamSlug, view.projectSlug);
      }
      await refreshTeams();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDeleteRecording() {
    if (!selectedDir) return;
    if (!confirm('Delete the audio recording file? The transcript and summary will remain.')) return;
    try {
      await window.api.meetings.deleteRecording(selectedDir);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSaveNotes(notes: string) {
    if (!selectedDir) return;
    try {
      await window.api.meetings.saveNotes(selectedDir, notes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRename(newTitle: string) {
    if (!selectedDir) return;
    try {
      await window.api.meetings.rename(selectedDir, newTitle);
      if (view.kind === 'project') {
        await refreshMeetingsForProject(view.teamSlug, view.projectSlug);
      }
      await refreshDetail(selectedDir);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleMove(toTeam: string, toProject: string) {
    if (!selectedDir) return;
    try {
      const newDir = await window.api.meetings.move(selectedDir, toTeam, toProject);
      setSelectedDir(newDir);
      // If the meeting moved out of the current view, follow it.
      if (view.kind === 'project') {
        if (toTeam !== view.teamSlug || toProject !== view.projectSlug) {
          await openProject(toTeam, toProject);
          setSelectedDir(newDir);
        } else {
          await refreshMeetingsForProject(view.teamSlug, view.projectSlug);
        }
      }
      await refreshTeams();
      await refreshDetail(newDir);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Move a meeting by dir (used by the kebab menu on a tile — no "selected" required). */
  async function handleMoveMeeting(dir: string, toTeam: string, toProject: string) {
    try {
      await window.api.meetings.move(dir, toTeam, toProject);
      if (view.kind === 'project') {
        await refreshMeetingsForProject(view.teamSlug, view.projectSlug);
      }
      await refreshTeams();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Delete a meeting by dir without requiring it to be the selected one. */
  async function handleDeleteMeetingByDir(dir: string) {
    try {
      await window.api.meetings.delete(dir);
      if (selectedDir === dir) setSelectedDir(null);
      if (view.kind === 'project') {
        await refreshMeetingsForProject(view.teamSlug, view.projectSlug);
      }
      await refreshTeams();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleNameModalSubmit(title: string, team: string, project: string) {
    if (!nameModal) return;
    const startDir = nameModal.dir;
    try {
      let finalDir = startDir;
      if (typeof window.api.recording.commitStop === 'function') {
        // The main process applies rename + move and then starts processing.
        const res = await window.api.recording.commitStop({
          dir: startDir,
          title,
          team,
          project,
        });
        finalDir = res.dir;
      } else {
        // Fallback for stale main/preload builds: apply the rename + move
        // ourselves. Processing has already been kicked off by the old
        // stopRecording, but at least the title and filing are right.
        if (title) {
          await window.api.meetings.rename(finalDir, title);
        }
        const meeting = (await window.api.meetings.list()).find((m) => m.dir === finalDir);
        if (meeting && (meeting.team !== team || meeting.project !== project)) {
          finalDir = await window.api.meetings.move(finalDir, team, project);
        }
      }

      // Navigate the user to the project they filed into so they can see
      // transcription/summarization progress on the meeting tile.
      await openProject(team, project);
      setSelectedDir(finalDir);
      await refreshTeams();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setNameModal(null);
    }
  }

  // ---------------------------------------------------------------- render

  const selectedProcessing = useMemo(
    () => (detail ? processingBySlug[detail.meta.slug] : undefined),
    [detail, processingBySlug],
  );

  const breadcrumbSegments = useMemo(() => {
    if (view.kind === 'teams') return [{ label: 'Teams' }];
    if (view.kind === 'settings') {
      return [
        { label: 'Teams', onClick: backToTeams },
        { label: 'Settings' },
      ];
    }
    const segs: { label: string; onClick?: () => void }[] = [
      { label: 'Teams', onClick: backToTeams },
    ];
    if (view.kind === 'team') {
      segs.push({ label: currentTeam?.name ?? view.teamSlug });
    } else {
      // 'project'
      segs.push({
        label: currentTeam?.name ?? view.teamSlug,
        onClick: backToProjects,
      });
      if (detail && selectedDir) {
        segs.push({
          label: currentProject?.name ?? view.projectSlug,
          onClick: () => setSelectedDir(null),
        });
        segs.push({ label: detail.meta.title });
      } else {
        segs.push({ label: currentProject?.name ?? view.projectSlug });
      }
    }
    return segs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, currentTeam, currentProject, detail, selectedDir]);

  if (!bootstrapped) {
    return (
      <div className="app app-loading">
        <div className="titlebar" />
        <div className="boot-spinner">Loading…</div>
      </div>
    );
  }

  // First-run empty state: zero teams on disk.
  if (teams.length === 0 && view.kind === 'teams') {
    return (
      <div className="app no-sidebar">
        <header className="titlebar">
          <span>Meeting Notes</span>
        </header>
        <div className="content-area">
          <div className="main">
            <div className="empty-hero">
              <h1>Welcome</h1>
              <p>Start by creating your first team. Teams hold projects; projects hold meetings.</p>
              <button
                className="btn btn-primary"
                style={{ padding: '10px 20px' }}
                onClick={() => setModal({ kind: 'newTeam' })}
              >
                + Create your first team
              </button>
            </div>
          </div>
        </div>
        {modal.kind === 'newTeam' && (
          <NewTeamDialog
            onCancel={() => setModal({ kind: 'none' })}
            onCreate={handleCreateTeam}
          />
        )}
      </div>
    );
  }

  const showSettings = view.kind === 'settings';
  const activeRecordingDir = recordingState.dir ?? resolvedRecordingDir;
  const isRecording = recordingState.active;

  // Record FAB is disabled if there's nowhere to file the recording. We
  // check that at least one team has at least one project; the main-side
  // resolver will pick the last-used (or first available) automatically.
  const recordDisabledReason: string | null = (() => {
    if (recordingState.active) return 'A recording is already in progress';
    if (teams.length === 0) return 'Create a team first';
    if (teams.every((t) => t.stats.projectCount === 0)) return 'Create a project first';
    return null;
  })();

  return (
    <div className="app no-sidebar">
      <header className="titlebar">
        <div className="titlebar-spacer" />
        <div className="titlebar-center">
          {recordingState.active && recordingState.startedAt ? (
            <RecordingPill
              startedAt={recordingState.startedAt}
              title={recordingState.title ?? 'Recording'}
              onStop={handleStopRecording}
              stopping={stopping}
            />
          ) : (
            <span className="titlebar-title">Meeting Notes</span>
          )}
        </div>
        <div className="titlebar-right">
          {!recordingState.active && (
            <button
              className="titlebar-record"
              onClick={() => void handleStartRecording()}
              disabled={recordDisabledReason !== null}
              title={recordDisabledReason ?? 'Start recording'}
              aria-label="Start recording"
            >
              <span className="titlebar-record-dot" />
              <span className="titlebar-record-label">Record</span>
            </button>
          )}
          <button
            className="titlebar-gear"
            onClick={() => setView({ kind: 'settings' })}
            title="Settings"
            aria-label="Settings"
          >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        </div>
      </header>

      <div className="content-area">
        {!isRecording && <Breadcrumb segments={breadcrumbSegments} />}

        {isRecording ? (
          activeRecordingDir ? (
            <RecordingCanvas
              dir={activeRecordingDir}
              recordingStartedAt={recordingState.startedAt}
            />
          ) : (
            <div className="recording-canvas">
              <div className="recording-canvas-inner">
                <div className="recording-canvas-placeholder">Starting recording…</div>
              </div>
            </div>
          )
        ) : showSettings ? (
          <SettingsPanel onClose={() => setView({ kind: 'teams' })} />
        ) : view.kind === 'teams' ? (
          <TeamsGrid
            teams={teams}
            onOpenTeam={(slug) => void openTeam(slug)}
            onNewTeam={() => setModal({ kind: 'newTeam' })}
          />
        ) : view.kind === 'team' && currentTeam ? (
          <ProjectsGrid
            team={currentTeam}
            projects={projectsInCurrentTeam}
            onOpenProject={(slug) => void openProject(view.teamSlug, slug)}
            onNewProject={() => setModal({ kind: 'newProject' })}
          />
        ) : view.kind === 'project' && detail && selectedDir && currentTeam && currentProject ? (
          <MeetingDetail
            detail={detail}
            teams={teamMetas}
            processing={selectedProcessing}
            models={models}
            defaultModel={models[0]?.id ?? 'claude-sonnet-4-5'}
            onResummarize={handleResummarize}
            onDelete={handleDeleteMeeting}
            onDeleteRecording={handleDeleteRecording}
            onSaveNotes={handleSaveNotes}
            onRename={handleRename}
            onMove={handleMove}
          />
        ) : view.kind === 'project' && currentTeam && currentProject ? (
          <div className="project-with-sources">
            <MeetingsGrid
              team={currentTeam}
              project={currentProject}
              meetings={meetings}
              teams={teams}
              processingBySlug={processingBySlug}
              onSelectMeeting={(dir) => setSelectedDir(dir)}
              onMoveMeeting={(dir, toTeam, toProject) =>
                void handleMoveMeeting(dir, toTeam, toProject)
              }
              onDeleteMeeting={(dir) => void handleDeleteMeetingByDir(dir)}
            />
            <ProjectSideRail
              team={view.teamSlug}
              project={view.projectSlug}
              models={models}
              defaultModel={models[0]?.id ?? 'claude-sonnet-4-5'}
            />
          </div>
        ) : null}
      </div>

      {modal.kind === 'newTeam' && (
        <NewTeamDialog
          onCancel={() => setModal({ kind: 'none' })}
          onCreate={handleCreateTeam}
        />
      )}

      {modal.kind === 'newProject' && (
        <NewProjectDialog
          onCancel={() => setModal({ kind: 'none' })}
          onCreate={handleCreateProject}
        />
      )}

      {nameModal && (
        <NameAndFileModal
          teams={teamMetas}
          defaultTeam={nameModal.team}
          defaultProject={nameModal.project}
          onSubmit={(title, team, project) => void handleNameModalSubmit(title, team, project)}
        />
      )}

      {error && (
        <div className="error-toast" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  );
}

