/**
 * Team & project CRUD plus context-gathering for summarization.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDirs,
  projectDir,
  projectMeetingsDir,
  readMeta,
  slugify,
  teamDir,
  teamProjectsDir,
  readTeamMeta,
  listProjects,
} from './storage.js';
import type { ProjectMeta, ProjectStats, TeamMeta, TeamStats } from '../../shared/types.js';

// ===================================================================== teams

export function createTeam(slug: string, name: string, description = ''): TeamMeta {
  ensureDirs();
  const s = slugify(slug);
  const tdir = teamDir(s);
  if (fs.existsSync(tdir)) {
    throw new Error(`Team '${s}' already exists at ${tdir}`);
  }

  fs.mkdirSync(path.join(tdir, 'projects'), { recursive: true });

  const meta: TeamMeta = {
    slug: s,
    name,
    description,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(tdir, 'team.json'), JSON.stringify(meta, null, 2));
  return meta;
}

export function teamStats(slug: string): TeamStats {
  const projectsRoot = teamProjectsDir(slug);
  if (!fs.existsSync(projectsRoot)) {
    return { slug, projectCount: 0, lastActivityAt: null };
  }
  let projectCount = 0;
  let latest: string | null = null;
  for (const proj of fs.readdirSync(projectsRoot)) {
    const full = path.join(projectsRoot, proj);
    if (!fs.statSync(full).isDirectory()) continue;
    projectCount++;
    const meetingsRoot = path.join(full, 'meetings');
    if (!fs.existsSync(meetingsRoot)) continue;
    for (const m of fs.readdirSync(meetingsRoot)) {
      const mFull = path.join(meetingsRoot, m);
      if (!fs.statSync(mFull).isDirectory()) continue;
      try {
        const meta = readMeta(mFull);
        if (!latest || meta.startedAt > latest) latest = meta.startedAt;
      } catch {
        // skip
      }
    }
  }
  return { slug, projectCount, lastActivityAt: latest };
}

// ===================================================================== projects

export function createProject(
  teamSlug: string,
  slug: string,
  name: string,
  description = '',
): ProjectMeta {
  ensureDirs();
  if (!readTeamMeta(teamSlug)) {
    throw new Error(`Team '${teamSlug}' does not exist`);
  }
  const s = slugify(slug);
  const pdir = projectDir(teamSlug, s);
  if (fs.existsSync(pdir)) {
    throw new Error(`Project '${s}' already exists in team '${teamSlug}' at ${pdir}`);
  }

  fs.mkdirSync(path.join(pdir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(pdir, 'sources'), { recursive: true });
  fs.mkdirSync(path.join(pdir, 'meetings'), { recursive: true });

  const meta: ProjectMeta = {
    slug: s,
    team: teamSlug,
    name,
    description,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(pdir, 'project.json'), JSON.stringify(meta, null, 2));

  const projectMd = [
    `# ${name}`,
    '',
    `_Team: \`${teamSlug}\` · Project slug: \`${s}\`_`,
    '',
    '## Description',
    '',
    description || '_(no description yet — edit this file to add one)_',
    '',
    '## Stakeholders',
    '',
    '_(add notes on attendees, roles, etc.)_',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(pdir, 'project.md'), projectMd);

  fs.writeFileSync(
    path.join(pdir, 'summary.md'),
    `# ${name} — Rolling Summary\n\n_(no meetings yet)_\n`,
  );
  fs.writeFileSync(
    path.join(pdir, 'open-threads.md'),
    `# ${name} — Open Threads\n\n_(none yet)_\n`,
  );

  return meta;
}

/** Cheap per-project stats used by the workspace grid. */
export function projectStats(teamSlug: string, projectSlug: string): ProjectStats {
  const meetings = projectMeetingsDir(teamSlug, projectSlug);
  if (!fs.existsSync(meetings)) {
    return { slug: projectSlug, meetingCount: 0, lastActivityAt: null };
  }
  let count = 0;
  let latest: string | null = null;
  for (const d of fs.readdirSync(meetings)) {
    const full = path.join(meetings, d);
    if (!fs.statSync(full).isDirectory()) continue;
    try {
      const meta = readMeta(full);
      count++;
      if (!latest || meta.startedAt > latest) latest = meta.startedAt;
    } catch {
      // ignore folders without meta.json
    }
  }
  return { slug: projectSlug, meetingCount: count, lastActivityAt: latest };
}

// ===================================================================== context for summarization

const TEXT_EXTS = new Set(['.md', '.txt', '.markdown', '.rst', '.log']);

export function readTextDocs(teamSlug: string, projectSlug: string): Array<[string, string]> {
  const docsDir = path.join(projectDir(teamSlug, projectSlug), 'docs');
  if (!fs.existsSync(docsDir)) return [];

  const out: Array<[string, string]> = [];
  for (const f of fs.readdirSync(docsDir).sort()) {
    const ext = path.extname(f).toLowerCase();
    if (!TEXT_EXTS.has(ext)) continue;
    try {
      out.push([f, fs.readFileSync(path.join(docsDir, f), 'utf8')]);
    } catch {
      // skip unreadable files
    }
  }
  return out;
}

function readMarkdownIfMeaningful(filePath: string, placeholderMarker: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) return null;
  return text.includes(placeholderMarker) ? null : text;
}

export function readProjectSummary(teamSlug: string, projectSlug: string): string | null {
  return readMarkdownIfMeaningful(
    path.join(projectDir(teamSlug, projectSlug), 'summary.md'),
    'no meetings yet',
  );
}

export function readOpenThreads(teamSlug: string, projectSlug: string): string | null {
  return readMarkdownIfMeaningful(
    path.join(projectDir(teamSlug, projectSlug), 'open-threads.md'),
    'none yet',
  );
}

export function readProjectDescription(teamSlug: string, projectSlug: string): string | null {
  const file = path.join(projectDir(teamSlug, projectSlug), 'project.md');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8').trim();
  return text || null;
}

export function writeProjectSummary(
  teamSlug: string,
  projectSlug: string,
  summaryMd: string,
): void {
  fs.writeFileSync(
    path.join(projectDir(teamSlug, projectSlug), 'summary.md'),
    summaryMd.trim() + '\n',
  );
}

export function writeOpenThreads(
  teamSlug: string,
  projectSlug: string,
  threadsMd: string,
): void {
  fs.writeFileSync(
    path.join(projectDir(teamSlug, projectSlug), 'open-threads.md'),
    threadsMd.trim() + '\n',
  );
}

export function priorMeetingSummaries(
  teamSlug: string,
  projectSlug: string,
): Array<[string, string]> {
  const meetingsDir = path.join(projectDir(teamSlug, projectSlug), 'meetings');
  if (!fs.existsSync(meetingsDir)) return [];
  const out: Array<[string, string]> = [];
  for (const d of fs.readdirSync(meetingsDir).sort()) {
    const summary = path.join(meetingsDir, d, 'summary.md');
    if (fs.existsSync(summary)) {
      out.push([d, fs.readFileSync(summary, 'utf8')]);
    }
  }
  return out;
}

// Re-export for convenience to callers that previously imported from this file.
export { listProjects };
