/**
 * One-shot storage migrations. Runs on app startup before IPC is registered
 * so the renderer can't race the file moves.
 *
 * v0 -> v1: pre-teams layout (`data/projects/<slug>/`) becomes the new
 *           team-scoped layout (`data/teams/personal/projects/<slug>/`).
 *           The old `inbox` project (a workaround we no longer need) is
 *           dropped if empty, or renamed to `inbox-legacy` if it has meetings.
 */

import fs from 'node:fs';
import path from 'node:path';
import { dataDir, legacyProjectsDir, teamsDir } from './config.js';
import {
  copyDirRecursive,
  readAppState,
  teamDir,
  teamProjectsDir,
  writeAppState,
} from './storage.js';
import type { TeamMeta } from '../../shared/types.js';

const CURRENT_MIGRATION_VERSION = 2;
const PERSONAL_SLUG = 'personal';

interface RawProjectFile {
  slug?: string;
  team?: string;
  name?: string;
  description?: string;
  createdAt?: string;
}

interface RawMetaFile {
  title: string;
  slug: string;
  team?: string | null;
  project: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
}

/**
 * Top-level entry point. Safe to call on every launch — short-circuits on
 * the version flag.
 */
export function runMigrations(): void {
  const state = readAppState();
  if (state.migrationVersion >= CURRENT_MIGRATION_VERSION) return;

  if (state.migrationVersion < 1) migrateV0toV1();
  if (state.migrationVersion < 2) migrateV1toV2();

  writeAppState({ migrationVersion: CURRENT_MIGRATION_VERSION });
}

/** v1 -> v2: ensure every existing project has a `sources/` directory so the
 *  new project-sources feature can write to it without surprises. */
function migrateV1toV2(): void {
  const root = teamsDir();
  if (!fs.existsSync(root)) return;
  for (const teamSlug of fs.readdirSync(root)) {
    const projectsRoot = path.join(root, teamSlug, 'projects');
    if (!fs.existsSync(projectsRoot)) continue;
    for (const projectSlug of fs.readdirSync(projectsRoot)) {
      const proj = path.join(projectsRoot, projectSlug);
      if (!fs.statSync(proj).isDirectory()) continue;
      const sources = path.join(proj, 'sources');
      if (!fs.existsSync(sources)) {
        try {
          fs.mkdirSync(sources, { recursive: true });
        } catch (err) {
          console.warn(`[migration] failed to create sources/ at ${sources}:`, err);
        }
      }
    }
  }
}

function migrateV0toV1(): void {
  fs.mkdirSync(dataDir(), { recursive: true });

  const legacyRoot = legacyProjectsDir();
  const newRoot = teamsDir();

  if (!fs.existsSync(legacyRoot)) {
    // Brand-new install. Nothing to migrate. Just make sure teams dir exists.
    fs.mkdirSync(newRoot, { recursive: true });
    return;
  }

  // Safety: refuse to run if a "personal" team already exists — could mean
  // a previous attempt got interrupted, and double-moving would clobber data.
  const personalDir = teamDir(PERSONAL_SLUG);
  if (fs.existsSync(personalDir)) {
    console.warn(
      `[migration] data/teams/${PERSONAL_SLUG} already exists; skipping v0->v1 to avoid clobbering. Resolve manually.`,
    );
    return;
  }

  const legacyEntries = fs.readdirSync(legacyRoot, { withFileTypes: true });
  const legacyProjectDirs = legacyEntries
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  // Nothing under data/projects/ — no-op move.
  if (legacyProjectDirs.length === 0) {
    fs.rmSync(legacyRoot, { recursive: true, force: true });
    fs.mkdirSync(newRoot, { recursive: true });
    return;
  }

  // Create the Personal team scaffold.
  fs.mkdirSync(path.join(personalDir, 'projects'), { recursive: true });
  const teamMeta: TeamMeta = {
    slug: PERSONAL_SLUG,
    name: 'Personal',
    description: 'Auto-created during the teams migration. Holds your existing projects.',
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(personalDir, 'team.json'), JSON.stringify(teamMeta, null, 2));

  for (const slug of legacyProjectDirs) {
    const srcProject = path.join(legacyRoot, slug);

    // Special-case: the old "inbox" project. If empty, drop it; if it
    // has anything in it, rename so the user doesn't lose data.
    if (slug === 'inbox' && isProjectEmpty(srcProject)) {
      fs.rmSync(srcProject, { recursive: true, force: true });
      continue;
    }

    const destSlug = slug === 'inbox' ? 'inbox-legacy' : slug;
    const destProject = path.join(teamProjectsDir(PERSONAL_SLUG), destSlug);

    if (fs.existsSync(destProject)) {
      console.warn(`[migration] ${destProject} already exists; skipping ${slug}`);
      continue;
    }

    copyDirRecursive(srcProject, destProject);

    // Patch project.json so `team` and `slug` reflect the new layout.
    patchProjectJson(destProject, PERSONAL_SLUG, destSlug);

    // Patch every meeting's meta.json with the new team.
    const meetingsRoot = path.join(destProject, 'meetings');
    if (fs.existsSync(meetingsRoot)) {
      for (const d of fs.readdirSync(meetingsRoot)) {
        const meetingPath = path.join(meetingsRoot, d);
        if (!fs.statSync(meetingPath).isDirectory()) continue;
        patchMeetingMeta(meetingPath, PERSONAL_SLUG, destSlug);
      }
    }
  }

  // All good — drop the old root.
  fs.rmSync(legacyRoot, { recursive: true, force: true });

  // Carry the previous lastProjectSlug through if it still exists in Personal.
  const prev = readAppState();
  let carryProject: string | null = null;
  if (prev.lastProjectSlug) {
    const remappedSlug = prev.lastProjectSlug === 'inbox' ? null : prev.lastProjectSlug;
    if (remappedSlug && fs.existsSync(path.join(teamProjectsDir(PERSONAL_SLUG), remappedSlug))) {
      carryProject = remappedSlug;
    }
  }
  writeAppState({
    lastTeamSlug: PERSONAL_SLUG,
    lastProjectSlug: carryProject,
  });
}

function isProjectEmpty(projectDirPath: string): boolean {
  const meetings = path.join(projectDirPath, 'meetings');
  const docs = path.join(projectDirPath, 'docs');
  const hasMeetings = fs.existsSync(meetings) && fs.readdirSync(meetings).length > 0;
  const hasDocs = fs.existsSync(docs) && fs.readdirSync(docs).length > 0;
  return !hasMeetings && !hasDocs;
}

function patchProjectJson(projectPath: string, team: string, slug: string): void {
  const file = path.join(projectPath, 'project.json');
  if (!fs.existsSync(file)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawProjectFile;
    const next: RawProjectFile = { ...raw, slug, team };
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn(`[migration] failed to patch project.json at ${file}:`, err);
  }
}

function patchMeetingMeta(meetingPath: string, team: string, project: string): void {
  const file = path.join(meetingPath, 'meta.json');
  if (!fs.existsSync(file)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawMetaFile;
    const next: RawMetaFile = { ...raw, team, project };
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
  } catch (err) {
    console.warn(`[migration] failed to patch meeting meta.json at ${file}:`, err);
  }
}
