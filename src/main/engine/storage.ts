/**
 * On-disk layout for teams, projects, and meetings.
 *
 *   data/teams/<team-slug>/
 *     team.json
 *     projects/<project-slug>/
 *       project.json
 *       project.md          (human-editable description)
 *       summary.md          (AI-maintained rolling summary)
 *       open-threads.md     (AI-maintained open items)
 *       docs/
 *       meetings/<date>--<slug>/
 *         recording.wav
 *         transcript.txt
 *         summary.md
 *         notes.md
 *         meta.json
 *
 *   data/unfiled/<date>--<slug>/...   (legacy only, kept for back-compat)
 *   data/app-state.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { appStatePath, dataDir, teamsDir, unfiledDir } from './config.js';
import type {
  AppState,
  AttachmentIndexEntry,
  MeetingMeta,
  ProjectMeta,
  TeamMeta,
} from '../../shared/types.js';

const SLUG_RE = /[^a-z0-9]+/g;

export function slugify(text: string): string {
  const out = text
    .toLowerCase()
    .trim()
    .replace(SLUG_RE, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'untitled';
}

export function ensureDirs(): void {
  fs.mkdirSync(teamsDir(), { recursive: true });
  fs.mkdirSync(unfiledDir(), { recursive: true });
}

// ----------------------------------------------------------------- paths

export function teamDir(slug: string): string {
  return path.join(teamsDir(), slug);
}

export function teamProjectsDir(teamSlug: string): string {
  return path.join(teamDir(teamSlug), 'projects');
}

export function projectDir(teamSlug: string, projectSlug: string): string {
  return path.join(teamProjectsDir(teamSlug), projectSlug);
}

export function projectMeetingsDir(teamSlug: string, projectSlug: string): string {
  return path.join(projectDir(teamSlug, projectSlug), 'meetings');
}

export function meetingFolderName(date: Date, slug: string): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}--${slug}`;
}

export function meetingDirFor(
  teamSlug: string,
  projectSlug: string,
  date: Date,
  slug: string,
): string {
  return path.join(projectMeetingsDir(teamSlug, projectSlug), meetingFolderName(date, slug));
}

// ----------------------------------------------------------------- meeting meta

/**
 * Internal on-disk format for meta.json. `team` may be missing on legacy
 * meta files written before the teams migration; read paths treat missing
 * as null.
 */
interface RawMeetingMeta {
  title: string;
  slug: string;
  team?: string | null;
  project: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
}

export function writeMeta(
  dir: string,
  meta: Omit<MeetingMeta, 'dir' | 'hasTranscript' | 'hasSummary' | 'hasRecording'>,
): void {
  const raw: RawMeetingMeta = {
    title: meta.title,
    slug: meta.slug,
    team: meta.team,
    project: meta.project,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    durationSeconds: meta.durationSeconds,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(raw, null, 2));
}

export function readMeta(dir: string): MeetingMeta {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as RawMeetingMeta;
  return {
    dir,
    title: raw.title,
    slug: raw.slug,
    team: raw.team ?? null,
    project: raw.project,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt,
    durationSeconds: raw.durationSeconds,
    hasTranscript: fs.existsSync(path.join(dir, 'transcript.txt')),
    hasSummary: fs.existsSync(path.join(dir, 'summary.md')),
    hasRecording: fs.existsSync(path.join(dir, 'recording.wav')),
  };
}

export interface ListMeetingsOpts {
  /** If set, only meetings under this team. */
  team?: string;
  /** If set (requires team), only meetings under this team+project. */
  project?: string;
  /** If true, include legacy unfiled meetings in the result. */
  includeUnfiled?: boolean;
}

/**
 * List meetings. Default (no opts) returns every meeting in every team.
 * Legacy unfiled meetings are excluded unless `includeUnfiled` is set so
 * the typical UI calls don't accidentally mix them in.
 */
export function listMeetings(opts: ListMeetingsOpts = {}): MeetingMeta[] {
  ensureDirs();
  const dirs: string[] = [];

  if (opts.team && opts.project) {
    const meetings = projectMeetingsDir(opts.team, opts.project);
    if (fs.existsSync(meetings)) {
      for (const d of fs.readdirSync(meetings)) {
        const full = path.join(meetings, d);
        if (fs.statSync(full).isDirectory()) dirs.push(full);
      }
    }
  } else if (opts.team) {
    const projectsRoot = teamProjectsDir(opts.team);
    if (fs.existsSync(projectsRoot)) {
      for (const proj of fs.readdirSync(projectsRoot)) {
        const meetingsRoot = path.join(projectsRoot, proj, 'meetings');
        if (fs.existsSync(meetingsRoot) && fs.statSync(meetingsRoot).isDirectory()) {
          for (const d of fs.readdirSync(meetingsRoot)) {
            const full = path.join(meetingsRoot, d);
            if (fs.statSync(full).isDirectory()) dirs.push(full);
          }
        }
      }
    }
  } else {
    // Everything: walk every team's projects.
    const root = teamsDir();
    if (fs.existsSync(root)) {
      for (const team of fs.readdirSync(root)) {
        const projectsRoot = path.join(root, team, 'projects');
        if (!fs.existsSync(projectsRoot)) continue;
        for (const proj of fs.readdirSync(projectsRoot)) {
          const meetingsRoot = path.join(projectsRoot, proj, 'meetings');
          if (!fs.existsSync(meetingsRoot) || !fs.statSync(meetingsRoot).isDirectory()) continue;
          for (const d of fs.readdirSync(meetingsRoot)) {
            const full = path.join(meetingsRoot, d);
            if (fs.statSync(full).isDirectory()) dirs.push(full);
          }
        }
      }
    }
  }

  if (opts.includeUnfiled && fs.existsSync(unfiledDir())) {
    for (const d of fs.readdirSync(unfiledDir())) {
      const full = path.join(unfiledDir(), d);
      if (fs.statSync(full).isDirectory()) dirs.push(full);
    }
  }

  const out: MeetingMeta[] = [];
  for (const d of dirs) {
    try {
      out.push(readMeta(d));
    } catch {
      // Skip folders missing meta.json (e.g. mid-recording crashes)
    }
  }

  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out;
}

/** Returns just the meetings sitting in the legacy data/unfiled/ bucket. */
export function listUnfiledMeetings(): MeetingMeta[] {
  ensureDirs();
  if (!fs.existsSync(unfiledDir())) return [];
  const out: MeetingMeta[] = [];
  for (const d of fs.readdirSync(unfiledDir())) {
    const full = path.join(unfiledDir(), d);
    if (!fs.statSync(full).isDirectory()) continue;
    try {
      out.push(readMeta(full));
    } catch {
      // skip
    }
  }
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out;
}

// ----------------------------------------------------------------- team meta

export function readTeamMeta(slug: string): TeamMeta | null {
  const file = path.join(teamDir(slug), 'team.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TeamMeta;
}

export function listTeams(): TeamMeta[] {
  ensureDirs();
  const root = teamsDir();
  if (!fs.existsSync(root)) return [];
  const out: TeamMeta[] = [];
  for (const d of fs.readdirSync(root).sort()) {
    const full = path.join(root, d);
    if (!fs.statSync(full).isDirectory()) continue;
    const meta = readTeamMeta(d);
    if (meta) out.push(meta);
    else out.push({ slug: d, name: d, description: '', createdAt: '' });
  }
  return out;
}

// ----------------------------------------------------------------- project meta

export function readProjectMeta(teamSlug: string, projectSlug: string): ProjectMeta | null {
  const file = path.join(projectDir(teamSlug, projectSlug), 'project.json');
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ProjectMeta>;
  return {
    slug: raw.slug ?? projectSlug,
    team: raw.team ?? teamSlug,
    name: raw.name ?? projectSlug,
    description: raw.description ?? '',
    createdAt: raw.createdAt ?? '',
  };
}

/** List all projects across all teams. */
export function listAllProjects(): ProjectMeta[] {
  ensureDirs();
  const out: ProjectMeta[] = [];
  for (const team of listTeams()) {
    out.push(...listProjects(team.slug));
  }
  return out;
}

export function listProjects(teamSlug: string): ProjectMeta[] {
  const root = teamProjectsDir(teamSlug);
  if (!fs.existsSync(root)) return [];
  const out: ProjectMeta[] = [];
  for (const d of fs.readdirSync(root).sort()) {
    const full = path.join(root, d);
    if (!fs.statSync(full).isDirectory()) continue;
    const meta = readProjectMeta(teamSlug, d);
    if (meta) out.push(meta);
    else out.push({ slug: d, team: teamSlug, name: d, description: '', createdAt: '' });
  }
  return out;
}

// -------------------------------------------------------------------- app state

const DEFAULT_APP_STATE: AppState = {
  lastTeamSlug: null,
  lastProjectSlug: null,
  migrationVersion: 0,
  version: 1,
};

export function readAppState(): AppState {
  const p = appStatePath();
  if (!fs.existsSync(p)) return { ...DEFAULT_APP_STATE };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<AppState>;
    return { ...DEFAULT_APP_STATE, ...raw };
  } catch {
    return { ...DEFAULT_APP_STATE };
  }
}

export function writeAppState(patch: Partial<AppState>): AppState {
  ensureDirs();
  fs.mkdirSync(dataDir(), { recursive: true });
  const next: AppState = { ...readAppState(), ...patch };
  fs.writeFileSync(appStatePath(), JSON.stringify(next, null, 2));
  return next;
}

// -------------------------------------------------------------------- moves/renames

/**
 * Move a meeting folder to (toTeam, toProject). Returns the new directory path.
 * Slug is kept stable so internal refs don't shift.
 */
export function moveMeeting(
  srcDir: string,
  toTeam: string,
  toProject: string,
): string {
  const meta = readMeta(srcDir);
  const folderName = path.basename(srcDir);
  const destParent = projectMeetingsDir(toTeam, toProject);
  fs.mkdirSync(destParent, { recursive: true });
  const destDir = path.join(destParent, folderName);
  if (destDir === srcDir) return srcDir;
  if (fs.existsSync(destDir)) {
    throw new Error(`Destination already exists: ${destDir}`);
  }

  copyDirRecursive(srcDir, destDir);

  writeMeta(destDir, {
    title: meta.title,
    slug: meta.slug,
    team: toTeam,
    project: toProject,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    durationSeconds: meta.durationSeconds,
  });

  fs.rmSync(srcDir, { recursive: true, force: true });
  return destDir;
}

export function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

// ----------------------------------------------------------------- attachments index

/**
 * Each meeting can have an `attachments/index.json` listing screenshots
 * the user dropped into the canvas during a recording, with the moment
 * each one was captured (relative to recording start) and any text the
 * user typed alongside. This is the data the summarizer uses to feed
 * Claude multimodal context.
 */
export function readAttachmentIndex(meetingDir: string): AttachmentIndexEntry[] {
  const p = path.join(meetingDir, 'attachments', 'index.json');
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as AttachmentIndexEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export function appendAttachmentIndex(
  meetingDir: string,
  entry: AttachmentIndexEntry,
): void {
  const attachmentsDir = path.join(meetingDir, 'attachments');
  fs.mkdirSync(attachmentsDir, { recursive: true });
  const list = readAttachmentIndex(meetingDir);
  list.push(entry);
  fs.writeFileSync(path.join(attachmentsDir, 'index.json'), JSON.stringify(list, null, 2));
}

/** Update a meeting's title (and only its title). Slug/folder stay stable. */
export function renameMeeting(dir: string, newTitle: string): MeetingMeta {
  const meta = readMeta(dir);
  writeMeta(dir, {
    title: newTitle,
    slug: meta.slug,
    team: meta.team,
    project: meta.project,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    durationSeconds: meta.durationSeconds,
  });
  return readMeta(dir);
}
