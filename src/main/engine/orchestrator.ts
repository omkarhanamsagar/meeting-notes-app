/**
 * Ties the engine together: starts/stops recordings, runs transcription,
 * calls summarization, writes everything to disk, and emits progress events.
 *
 * Holds the live recording state for the whole app — the renderer reads
 * from here to know "are we recording right now?" without owning state itself.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Recorder } from './recording.js';
import { loadTranscriptSegments, transcribe } from './transcription.js';
import {
  generateTitle,
  summarize,
  type ScreenshotContext,
  type SummaryResult,
} from './summarization.js';
import {
  ensureDirs,
  listProjects,
  listTeams,
  meetingDirFor,
  moveMeeting,
  readAppState,
  readAttachmentIndex,
  readMeta,
  readProjectMeta,
  renameMeeting,
  slugify,
  writeAppState,
  writeMeta,
} from './storage.js';
import { readSourcesForPrompt } from './sources.js';
import {
  priorMeetingSummaries,
  readOpenThreads,
  readProjectDescription,
  readProjectSummary,
  readTextDocs,
  writeOpenThreads,
  writeProjectSummary,
} from './projects.js';
import type {
  MeetingMeta,
  ProcessingUpdate,
  RecordingState,
  StartRecordingArgs,
} from '../../shared/types.js';
import { ANTHROPIC_MODEL } from './config.js';

interface ActiveSession {
  recorder: Recorder;
  dir: string;
  title: string;
  slug: string;
  team: string;
  project: string;
  startedAtIso: string;
  startedAtMs: number;
}

export class Orchestrator extends EventEmitter {
  private session: ActiveSession | null = null;
  /** Sessions that finished recording but haven't been committed (named) yet. */
  private pendingCommits = new Map<string, ActiveSession>();

  emitUpdate(update: ProcessingUpdate): void {
    this.emit('processing', update);
  }

  getRecordingState(): RecordingState {
    if (!this.session) {
      return { active: false, meetingSlug: null, title: null, startedAt: null, dir: null };
    }
    return {
      active: this.session.recorder.isRunning,
      meetingSlug: this.session.slug,
      title: this.session.title,
      startedAt: this.session.startedAtMs,
      dir: this.session.dir,
    };
  }

  startRecording(args: StartRecordingArgs): { slug: string; dir: string } {
    if (this.session) {
      throw new Error('A recording is already in progress');
    }
    ensureDirs();

    const now = new Date();

    const { team, project } = resolveTeamAndProject(args);

    const title =
      args.title?.trim() ||
      `Untitled — ${now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;

    // For the placeholder we add a timestamp so multiple untitled
    // recordings in the same project don't collide on disk.
    const baseSlug = slugify(title);
    const slug =
      baseSlug === 'untitled' || baseSlug.startsWith('untitled-')
        ? `untitled-${now.getTime()}`
        : baseSlug;

    const dir = meetingDirFor(team, project, now, slug);
    fs.mkdirSync(dir, { recursive: true });

    const recordingPath = path.join(dir, 'recording.wav');
    const meta: Omit<MeetingMeta, 'dir' | 'hasTranscript' | 'hasSummary' | 'hasRecording'> = {
      title,
      slug,
      team,
      project,
      startedAt: now.toISOString(),
      endedAt: null,
      durationSeconds: null,
    };
    writeMeta(dir, meta);

    const notesPath = path.join(dir, 'notes.md');
    if (!fs.existsSync(notesPath)) {
      // Start empty so the canvas shows a clean cursor + placeholder.
      fs.writeFileSync(notesPath, '');
    }

    const recorder = new Recorder({ outputPath: recordingPath });
    try {
      recorder.start();
    } catch (err) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      throw err;
    }

    writeAppState({ lastTeamSlug: team, lastProjectSlug: project });

    this.session = {
      recorder,
      dir,
      title,
      slug,
      team,
      project,
      startedAtIso: now.toISOString(),
      startedAtMs: now.getTime(),
    };

    this.emitUpdate({ stage: 'recording', meetingSlug: slug });

    return { slug, dir };
  }

  /**
   * Stop the recording and finalize the WAV file. Does NOT start transcription
   * or summarization — the caller must call `commitStop()` with the final
   * title/team/project once the user has confirmed them. This lets the UI
   * block on a "name your meeting" modal before any heavy processing runs.
   *
   * Returns the dir + slug so the renderer can find the in-progress recording
   * to open the modal against.
   */
  async stopRecording(): Promise<{ dir: string; slug: string; title: string; team: string; project: string }> {
    if (!this.session) throw new Error('No active recording to stop');

    const session = this.session;
    this.session = null;

    await session.recorder.stop();

    const endedAt = new Date();
    const durationSeconds = (endedAt.getTime() - session.startedAtMs) / 1000;

    writeMeta(session.dir, {
      title: session.title,
      slug: session.slug,
      team: session.team,
      project: session.project,
      startedAt: session.startedAtIso,
      endedAt: endedAt.toISOString(),
      durationSeconds,
    });

    // Stash for commitStop. Keyed by dir so the renderer can correlate.
    this.pendingCommits.set(session.dir, session);

    return {
      dir: session.dir,
      slug: session.slug,
      title: session.title,
      team: session.team,
      project: session.project,
    };
  }

  /**
   * Apply the user-confirmed title + team/project to the stopped recording,
   * then kick off transcription + summarization in the background.
   *
   * If team/project change, the meeting folder is moved before processing.
   */
  async commitStop(args: {
    dir: string;
    title: string;
    team: string;
    project: string;
  }): Promise<{ dir: string }> {
    let { dir } = args;
    const { title, team, project } = args;

    const pending = this.pendingCommits.get(dir);
    // It's still OK if there's no pending session — e.g. main was restarted.
    // We just operate on disk in that case.

    const trimmedTitle = title.trim();
    if (!trimmedTitle) throw new Error('Title is required to commit a recording');

    // Apply rename.
    const beforeMeta = readMeta(dir);
    if (beforeMeta.title !== trimmedTitle) {
      renameMeeting(dir, trimmedTitle);
    }

    // Apply move if team/project changed.
    const needsMove =
      (beforeMeta.team ?? null) !== team || (beforeMeta.project ?? null) !== project;
    if (needsMove) {
      dir = moveMeeting(dir, team, project);
    }

    writeAppState({ lastTeamSlug: team, lastProjectSlug: project });

    // Build a session-like object for processAfterRecording from current meta.
    const meta = readMeta(dir);
    const sessionForProcessing: ActiveSession = pending
      ? { ...pending, dir, title: meta.title, team, project }
      : {
          // Fabricate the minimum needed for processAfterRecording. recorder
          // is unused after stop; cast a stub.
          recorder: null as unknown as Recorder,
          dir,
          title: meta.title,
          slug: meta.slug,
          team,
          project,
          startedAtIso: meta.startedAt,
          startedAtMs: new Date(meta.startedAt).getTime(),
        };

    this.pendingCommits.delete(args.dir);

    void this.processAfterRecording(sessionForProcessing).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.emitUpdate({
        stage: 'error',
        meetingSlug: sessionForProcessing.slug,
        message,
      });
    });

    return { dir };
  }

  private async processAfterRecording(session: ActiveSession): Promise<void> {
    this.emitUpdate({ stage: 'transcribing', meetingSlug: session.slug });

    const recordingPath = path.join(session.dir, 'recording.wav');
    const transcript = await transcribe(recordingPath);

    // Gather any screenshots the user dropped during the meeting along
    // with their transcript windows so Claude can use them as primary
    // context for the summary.
    const screenshots = collectScreenshotContexts(session.dir);

    this.emitUpdate({ stage: 'summarizing', meetingSlug: session.slug, message: ANTHROPIC_MODEL });
    const result = await this.summarizeMeeting(
      session.title,
      transcript,
      session.team,
      session.project,
      screenshots,
    );

    // If the user never named the meeting, ask Claude for a short AI title.
    let finalTitle = session.title;
    if (isPlaceholderTitle(session.title)) {
      try {
        const aiTitle = await generateTitle(result.meetingSummary, transcript);
        if (aiTitle) {
          finalTitle = aiTitle;
          const current = readMeta(session.dir);
          writeMeta(session.dir, {
            title: finalTitle,
            slug: current.slug,
            team: current.team,
            project: current.project,
            startedAt: current.startedAt,
            endedAt: current.endedAt,
            durationSeconds: current.durationSeconds,
          });
        }
      } catch (err) {
        console.warn('generateTitle failed:', err);
      }
    }

    const summaryMd = this.renderMeetingSummaryMd(
      finalTitle,
      session.team,
      session.project,
      result.meetingSummary,
      transcript,
    );
    fs.writeFileSync(path.join(session.dir, 'summary.md'), summaryMd);

    if (result.updatedProjectSummary) {
      writeProjectSummary(session.team, session.project, result.updatedProjectSummary);
    }
    if (result.updatedOpenThreads) {
      writeOpenThreads(session.team, session.project, result.updatedOpenThreads);
    }

    this.emitUpdate({ stage: 'done', meetingSlug: session.slug });
  }

  /**
   * Re-run summarization on an existing meeting.
   *
   * If no transcript exists yet but a `recording.wav` does, transcribe
   * first — this is how we recover meetings whose original transcription
   * failed (e.g. the early stdout-pipe-drain bug) without re-recording.
   */
  async resummarize(meetingDir: string): Promise<void> {
    const meta = readMeta(meetingDir);
    if (!meta.team || !meta.project) {
      throw new Error('Cannot re-summarize a meeting without a team and project');
    }
    const transcriptPath = path.join(meetingDir, 'transcript.txt');
    const recordingPath = path.join(meetingDir, 'recording.wav');
    if (!fs.existsSync(transcriptPath)) {
      if (!fs.existsSync(recordingPath)) {
        throw new Error(
          `No transcript and no recording in ${meetingDir}; nothing to summarize.`,
        );
      }
      this.emitUpdate({ stage: 'transcribing', meetingSlug: meta.slug });
      await transcribe(recordingPath);
    }
    const transcript = fs.readFileSync(transcriptPath, 'utf8');

    const screenshots = collectScreenshotContexts(meetingDir);

    this.emitUpdate({ stage: 'summarizing', meetingSlug: meta.slug, message: ANTHROPIC_MODEL });
    const result = await this.summarizeMeeting(
      meta.title,
      transcript,
      meta.team,
      meta.project,
      screenshots,
    );

    fs.writeFileSync(
      path.join(meetingDir, 'summary.md'),
      this.renderMeetingSummaryMd(meta.title, meta.team, meta.project, result.meetingSummary, transcript),
    );

    if (result.updatedProjectSummary) {
      writeProjectSummary(meta.team, meta.project, result.updatedProjectSummary);
    }
    if (result.updatedOpenThreads) {
      writeOpenThreads(meta.team, meta.project, result.updatedOpenThreads);
    }

    this.emitUpdate({ stage: 'done', meetingSlug: meta.slug });
  }

  private summarizeMeeting(
    title: string,
    transcript: string,
    teamSlug: string,
    projectSlug: string,
    screenshots: ScreenshotContext[] = [],
  ): Promise<SummaryResult> {
    const project = readProjectMeta(teamSlug, projectSlug);
    return summarize({
      meetingTitle: title,
      transcript,
      projectName: project?.name ?? projectSlug,
      projectDescription: readProjectDescription(teamSlug, projectSlug),
      projectSummary: readProjectSummary(teamSlug, projectSlug),
      openThreads: readOpenThreads(teamSlug, projectSlug),
      priorMeetingSummaries: priorMeetingSummaries(teamSlug, projectSlug),
      projectDocs: readTextDocs(teamSlug, projectSlug),
      sources: readSourcesForPrompt(teamSlug, projectSlug),
      screenshots,
    });
  }

  private renderMeetingSummaryMd(
    _title: string,
    _teamSlug: string,
    _projectSlug: string,
    body: string,
    _transcript: string,
  ): string {
    // The UI shows title, team, project, and timestamp in the header already,
    // and the transcript lives in its own tab — so the summary file is just
    // the rendered body. Keeps the file clean for copy/paste / export.
    return body.trim() + '\n';
  }
}

/**
 * Resolve which team + project to use for a new recording based on:
 *   1. explicit args
 *   2. lastTeamSlug / lastProjectSlug in app state (if they still exist)
 *   3. first team + first project on disk
 * Throws if no team or no project exists anywhere — caller (UI) is
 * expected to disable the record button in that case.
 */
function resolveTeamAndProject(args: StartRecordingArgs): { team: string; project: string } {
  const state = readAppState();
  const teams = listTeams();

  if (teams.length === 0) {
    throw new Error('No teams exist yet. Create one before recording.');
  }

  // Pick team.
  let team =
    (args.team && teams.find((t) => t.slug === args.team)?.slug) ||
    (state.lastTeamSlug && teams.find((t) => t.slug === state.lastTeamSlug)?.slug) ||
    teams[0]!.slug;

  const projects = listProjects(team);
  if (projects.length === 0) {
    // The chosen team is empty; try to find any team that has projects.
    const teamWithProjects = teams.find((t) => listProjects(t.slug).length > 0);
    if (!teamWithProjects) {
      throw new Error('No projects exist yet. Create one before recording.');
    }
    team = teamWithProjects.slug;
  }

  const teamProjects = listProjects(team);

  // Pick project.
  const project =
    (args.project && teamProjects.find((p) => p.slug === args.project)?.slug) ||
    (state.lastProjectSlug && teamProjects.find((p) => p.slug === state.lastProjectSlug)?.slug) ||
    teamProjects[0]!.slug;

  return { team, project };
}

function isPlaceholderTitle(title: string): boolean {
  return /^Untitled(\s|$)/i.test(title.trim());
}

const SCREENSHOT_WINDOW_MS = 60_000;

/**
 * Read the attachments index for a meeting and assemble multimodal
 * context (image bytes + ±60s transcript window + user observation) for
 * each screenshot. Returns an empty array if the meeting has no
 * attachments or no timestamped transcript.
 */
function collectScreenshotContexts(meetingDir: string): ScreenshotContext[] {
  const entries = readAttachmentIndex(meetingDir);
  if (entries.length === 0) return [];

  const segments = loadTranscriptSegments(meetingDir);

  const out: ScreenshotContext[] = [];
  for (const entry of entries) {
    const absPath = path.join(meetingDir, entry.path);
    if (!fs.existsSync(absPath)) continue;

    const buf = fs.readFileSync(absPath);
    const ext = path.extname(absPath).slice(1).toLowerCase();
    const mediaType =
      ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'webp'
            ? 'image/webp'
            : 'image/png';

    let transcriptWindow = '';
    if (segments && typeof entry.atMs === 'number') {
      const lo = entry.atMs - SCREENSHOT_WINDOW_MS;
      const hi = entry.atMs + SCREENSHOT_WINDOW_MS;
      transcriptWindow = segments
        .filter((s) => s.endMs >= lo && s.startMs <= hi)
        .map((s) => `[${formatTs(s.startMs)}] ${s.text}`)
        .join('\n');
    }

    out.push({
      path: entry.path,
      atMs: entry.atMs,
      observation: entry.observation ?? '',
      transcriptWindow,
      base64: buf.toString('base64'),
      mediaType,
    });
  }
  return out;
}

function formatTs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// Singleton for the lifetime of the app.
export const orchestrator = new Orchestrator();
