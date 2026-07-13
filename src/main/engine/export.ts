/**
 * Context export. Bundles everything we know about a project (or a single
 * meeting) into a portable zip that the user can attach to a fresh Claude /
 * ChatGPT / Gemini chat, plus a Claude-synthesized `briefing.md` that
 * summarizes the current state of the work.
 *
 * Layout of the produced zip (project scope):
 *
 *   <project-slug>-context/
 *     README.md                      what's in this zip + how to use it
 *     briefing.md                    AI-generated executive summary (this turn)
 *     project/
 *       project.md                   the user-authored project description
 *       summary.md                   rolling project summary
 *       open-threads.md              currently-open threads
 *     sources/                       project-attached docs (PDFs, images, text)
 *       <original filename>
 *       ...
 *     meetings/
 *       <YYYY-MM-DD--title>/
 *         summary.md
 *         transcript.txt             (if any)
 *         notes.md                   (if any)
 *         attachments/<files>        (if any)
 *
 * Meeting scope: same structure but only the one meeting under `meetings/`,
 * and the project-level summary/sources are still included so the receiving
 * model has the broader frame.
 */

import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import Anthropic from '@anthropic-ai/sdk';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { ANTHROPIC_MODEL } from './config.js';
import { getAnthropicApiKey } from './settings-store.js';
import { projectDir } from './storage.js';
import {
  priorMeetingSummaries,
  readOpenThreads,
  readProjectDescription,
  readProjectSummary,
} from './projects.js';
import { listSources, readSourceBytes } from './sources.js';
import { readMeta, readAttachmentIndex } from './storage.js';
import type { ChatScope } from '../../shared/types.js';

// ============================================================ public API

export interface ExportResult {
  /** Suggested filename for the resulting zip (no path). */
  suggestedFilename: string;
  /** Raw zip bytes, ready to be written to disk by the IPC handler. */
  bytes: Buffer;
}

/** Build the zip for the given scope. Heavy work (Claude call, file reads)
 *  happens here; the IPC layer just orchestrates the save dialog. */
export async function buildExportBundle(scope: ChatScope): Promise<ExportResult> {
  if (scope.kind === 'project') {
    return buildProjectExport(scope.team, scope.project);
  }
  return buildMeetingExport(scope.dir);
}

// ============================================================ project scope

async function buildProjectExport(team: string, project: string): Promise<ExportResult> {
  const projDir = projectDir(team, project);
  if (!fs.existsSync(projDir)) {
    throw new Error(`Project not found: ${team}/${project}`);
  }

  const rootName = `${project}-context`;
  const zip = new JSZip();
  const root = zip.folder(rootName);
  if (!root) throw new Error('Failed to create zip root');

  // ---- 1. Project metadata files
  const projectFolder = root.folder('project');
  if (projectFolder) {
    addIfPresent(projectFolder, 'project.md', path.join(projDir, 'project.md'));
    addIfPresent(projectFolder, 'summary.md', path.join(projDir, 'summary.md'));
    addIfPresent(projectFolder, 'open-threads.md', path.join(projDir, 'open-threads.md'));
  }

  // ---- 2. Sources (PDFs, images, text)
  const sources = listSources(team, project);
  if (sources.length) {
    const srcFolder = root.folder('sources');
    if (srcFolder) {
      const usedNames = new Set<string>();
      for (const entry of sources) {
        const read = readSourceBytes(team, project, entry.id);
        if (!read) continue;
        const safeName = uniquify(entry.filename, usedNames);
        srcFolder.file(safeName, read.bytes);
      }
    }
  }

  // ---- 3. Meetings (summary + transcript + notes + attachments)
  const meetingsRootDisk = path.join(projDir, 'meetings');
  const meetings: MeetingExportInfo[] = [];
  if (fs.existsSync(meetingsRootDisk)) {
    const meetingsFolder = root.folder('meetings');
    if (meetingsFolder) {
      for (const slug of fs.readdirSync(meetingsRootDisk).sort()) {
        const mdir = path.join(meetingsRootDisk, slug);
        if (!fs.statSync(mdir).isDirectory()) continue;
        const info = addMeetingToZip(meetingsFolder, slug, mdir);
        if (info) meetings.push(info);
      }
    }
  }

  // ---- 4. AI-generated briefing (best-effort; falls back to a stub on error)
  const briefing = await generateProjectBriefing({
    team,
    project,
    projectDescription: readProjectDescription(team, project),
    rollingSummary: readProjectSummary(team, project),
    openThreads: readOpenThreads(team, project),
    meetingSummaries: priorMeetingSummaries(team, project),
    sources: sources.map((s) => ({ filename: s.filename, kind: s.kind })),
  });
  root.file('briefing.md', briefing);

  // ---- 5. README
  root.file(
    'README.md',
    renderProjectReadme({
      team,
      project,
      sourceCount: sources.length,
      meetings,
    }),
  );

  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    suggestedFilename: `${rootName}-${stampShort()}.zip`,
    bytes,
  };
}

// ============================================================ meeting scope

async function buildMeetingExport(meetingDir: string): Promise<ExportResult> {
  if (!fs.existsSync(meetingDir)) throw new Error(`Meeting not found: ${meetingDir}`);
  const meta = readMeta(meetingDir);
  const team = meta.team;
  const project = meta.project;
  const slug = path.basename(meetingDir);
  const titleSlug = meta.slug || slug;

  const rootName = `${titleSlug}-context`;
  const zip = new JSZip();
  const root = zip.folder(rootName);
  if (!root) throw new Error('Failed to create zip root');

  // ---- 1. Project metadata (if this meeting is filed under one)
  let sourceCount = 0;
  if (team && project) {
    const projDir = projectDir(team, project);
    const projectFolder = root.folder('project');
    if (projectFolder) {
      addIfPresent(projectFolder, 'project.md', path.join(projDir, 'project.md'));
      addIfPresent(projectFolder, 'summary.md', path.join(projDir, 'summary.md'));
      addIfPresent(projectFolder, 'open-threads.md', path.join(projDir, 'open-threads.md'));
    }

    const sources = listSources(team, project);
    sourceCount = sources.length;
    if (sources.length) {
      const srcFolder = root.folder('sources');
      if (srcFolder) {
        const usedNames = new Set<string>();
        for (const entry of sources) {
          const read = readSourceBytes(team, project, entry.id);
          if (!read) continue;
          const safeName = uniquify(entry.filename, usedNames);
          srcFolder.file(safeName, read.bytes);
        }
      }
    }
  }

  // ---- 2. The meeting itself
  const meetingsFolder = root.folder('meetings');
  let info: MeetingExportInfo | null = null;
  if (meetingsFolder) {
    info = addMeetingToZip(meetingsFolder, slug, meetingDir);
  }

  // ---- 3. AI briefing focused on this meeting
  const briefing = await generateMeetingBriefing({
    title: meta.title,
    startedAt: meta.startedAt,
    team,
    project,
    summary: readFileIfExists(path.join(meetingDir, 'summary.md')),
    transcript: readFileIfExists(path.join(meetingDir, 'transcript.txt')),
    notes: readFileIfExists(path.join(meetingDir, 'notes.md')),
    projectSummary: team && project ? readProjectSummary(team, project) : null,
    openThreads: team && project ? readOpenThreads(team, project) : null,
  });
  root.file('briefing.md', briefing);

  // ---- 4. README
  root.file(
    'README.md',
    renderMeetingReadme({
      title: meta.title,
      startedAt: meta.startedAt,
      team,
      project,
      sourceCount,
      meeting: info,
    }),
  );

  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    suggestedFilename: `${rootName}-${stampShort()}.zip`,
    bytes,
  };
}

// ============================================================ helpers — disk + zip

interface MeetingExportInfo {
  slug: string;
  title: string;
  startedAt: string | null;
  hasSummary: boolean;
  hasTranscript: boolean;
  hasNotes: boolean;
  attachmentCount: number;
}

function addMeetingToZip(
  meetingsFolder: JSZip,
  slug: string,
  meetingDir: string,
): MeetingExportInfo | null {
  let meta: ReturnType<typeof readMeta> | null = null;
  try {
    meta = readMeta(meetingDir);
  } catch {
    return null;
  }
  const folder = meetingsFolder.folder(slug);
  if (!folder) return null;

  const summary = readFileIfExists(path.join(meetingDir, 'summary.md'));
  const transcript = readFileIfExists(path.join(meetingDir, 'transcript.txt'));
  const notes = readFileIfExists(path.join(meetingDir, 'notes.md'));

  if (summary) folder.file('summary.md', summary);
  if (transcript) folder.file('transcript.txt', transcript);
  if (notes) folder.file('notes.md', notes);
  folder.file('meta.json', fs.readFileSync(path.join(meetingDir, 'meta.json')));

  let attachmentCount = 0;
  const attachIndex = readAttachmentIndex(meetingDir);
  if (attachIndex.length) {
    const attachFolder = folder.folder('attachments');
    if (attachFolder) {
      for (const entry of attachIndex) {
        const onDisk = path.join(meetingDir, entry.path);
        if (!fs.existsSync(onDisk)) continue;
        const basename = path.basename(entry.path);
        attachFolder.file(basename, fs.readFileSync(onDisk));
        attachmentCount += 1;
      }
      attachFolder.file('index.json', JSON.stringify(attachIndex, null, 2));
    }
  }

  return {
    slug,
    title: meta.title,
    startedAt: meta.startedAt,
    hasSummary: !!summary,
    hasTranscript: !!transcript,
    hasNotes: !!notes,
    attachmentCount,
  };
}

function addIfPresent(folder: JSZip, name: string, diskPath: string): void {
  if (fs.existsSync(diskPath)) {
    folder.file(name, fs.readFileSync(diskPath));
  }
}

function readFileIfExists(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Ensure no two files inside a zip folder collide on name. */
function uniquify(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let i = 2;
  while (used.has(`${base} (${i})${ext}`)) i += 1;
  const next = `${base} (${i})${ext}`;
  used.add(next);
  return next;
}

function stampShort(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// ============================================================ briefing (AI)

interface ProjectBriefingInput {
  team: string;
  project: string;
  projectDescription: string | null;
  rollingSummary: string | null;
  openThreads: string | null;
  meetingSummaries: Array<[string, string]>;
  sources: Array<{ filename: string; kind: string }>;
}

async function generateProjectBriefing(input: ProjectBriefingInput): Promise<string> {
  const sections: string[] = [];
  if (input.projectDescription) {
    sections.push(`# Project description\n\n${input.projectDescription}`);
  }
  if (input.rollingSummary) {
    sections.push(`# Current rolling project summary\n\n${input.rollingSummary}`);
  }
  if (input.openThreads) {
    sections.push(`# Open threads\n\n${input.openThreads}`);
  }
  if (input.meetingSummaries.length) {
    sections.push('# Meeting summaries (oldest first)');
    for (const [slug, body] of input.meetingSummaries) {
      sections.push(`## ${slug}\n\n${body}`);
    }
  }
  if (input.sources.length) {
    sections.push('# Attached sources');
    for (const s of input.sources) {
      sections.push(`- \`${s.filename}\` (${s.kind})`);
    }
  }

  const userPrompt = [
    `You are preparing a portable "context briefing" for the project "${input.project}" (team "${input.team}").`,
    `The user is going to take this briefing into another AI chat (Claude.ai, ChatGPT, Gemini) and continue working from it. Your job is to compress the project's current state into the single most useful single-document snapshot.`,
    '',
    'Write a Markdown document with these sections, in order:',
    '1. **Executive summary** — 3-6 sentences describing what this project is, why it exists, and where it is right now.',
    '2. **Current focus** — the active threads of work, in priority order. Pull from "Open threads" and the most recent meeting summaries.',
    '3. **Recent decisions** — what has been decided in the last few meetings, with brief rationale.',
    '4. **Open questions / risks** — what is still ambiguous or risky.',
    '5. **Key people & context** — names, roles, recurring stakeholders if any are mentioned.',
    '6. **Glossary of artifacts** — one-line description of each attached source and what it covers (skip if no sources).',
    '7. **How to use this bundle** — a short instruction block telling the receiving AI: "Use the files in `meetings/` for full historical detail, `sources/` for attached reference docs, and `project/` for the project\'s own description/summary/threads."',
    '',
    'Style: concrete, dense, no filler. Prefer bullets over prose where appropriate. Do not invent facts that are not present in the input. If a section has nothing to say, write a single line like "_None recorded._" and move on.',
    '',
    '--- INPUT MATERIAL BEGINS ---',
    '',
    sections.join('\n\n'),
    '',
    '--- INPUT MATERIAL ENDS ---',
  ].join('\n');

  return runBriefingPrompt(userPrompt, fallbackProjectBriefing(input));
}

interface MeetingBriefingInput {
  title: string;
  startedAt: string | null;
  team: string | null;
  project: string | null;
  summary: string | null;
  transcript: string | null;
  notes: string | null;
  projectSummary: string | null;
  openThreads: string | null;
}

async function generateMeetingBriefing(input: MeetingBriefingInput): Promise<string> {
  const sections: string[] = [];
  sections.push(
    `# Meeting\n\n- **Title:** ${input.title}\n- **When:** ${input.startedAt ?? 'unknown'}\n- **Project:** ${
      input.team && input.project ? `${input.team}/${input.project}` : '(unfiled)'
    }`,
  );
  if (input.summary) sections.push(`# AI summary\n\n${input.summary}`);
  if (input.notes) sections.push(`# User notes\n\n${input.notes}`);
  if (input.transcript) {
    sections.push(`# Transcript (truncated if long)\n\n${truncate(input.transcript, 20000)}`);
  }
  if (input.projectSummary) {
    sections.push(`# Project rolling summary (background)\n\n${input.projectSummary}`);
  }
  if (input.openThreads) {
    sections.push(`# Project open threads (background)\n\n${input.openThreads}`);
  }

  const userPrompt = [
    `You are preparing a portable "context briefing" for a single meeting titled "${input.title}". The user will paste this into another AI chat to continue exploring this meeting.`,
    '',
    'Write a Markdown document with these sections:',
    '1. **TL;DR** — 2-4 sentences capturing what happened in this meeting.',
    '2. **Decisions made** — bullets.',
    '3. **Action items / next steps** — bullets, with owner if mentioned.',
    '4. **Open questions raised** — bullets.',
    '5. **Notable quotes or moments** — short pulled-from-transcript snippets only if genuinely informative.',
    '6. **How this fits the project** — 1-3 sentences relating this meeting to the broader project state.',
    '7. **How to use this bundle** — short note that `meetings/<slug>/transcript.txt` has full detail and `sources/` has project reference docs.',
    '',
    'Be concrete. Do not invent. If a section has nothing, write "_None._" and move on.',
    '',
    '--- INPUT MATERIAL BEGINS ---',
    '',
    sections.join('\n\n'),
    '',
    '--- INPUT MATERIAL ENDS ---',
  ].join('\n');

  return runBriefingPrompt(userPrompt, fallbackMeetingBriefing(input));
}

/** Run a one-shot Claude call. On any failure, return the supplied fallback so
 *  the export still succeeds — the user still gets the raw bundle even if the
 *  AI synthesis step had trouble. */
async function runBriefingPrompt(userPrompt: string, fallback: string): Promise<string> {
  try {
    const apiKey = getAnthropicApiKey();
    if (!apiKey) return fallback;
    const client = new Anthropic({ apiKey });
    const block: TextBlockParam = { type: 'text', text: userPrompt };
    const res = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: [block] }],
    });
    const text = res.content.map((block) => ('text' in block ? block.text : '')).join('\n');
    return text.trim() || fallback;
  } catch (err) {
    console.error('[export] briefing generation failed; using fallback:', err);
    return fallback;
  }
}

function fallbackProjectBriefing(input: ProjectBriefingInput): string {
  const out: string[] = [];
  out.push(`# ${input.project} — context briefing`);
  out.push('');
  out.push(
    '_AI briefing could not be generated for this export (the Anthropic API was unavailable or returned an error). The raw materials are still attached in this bundle._',
  );
  out.push('');
  if (input.projectDescription) {
    out.push('## Project description');
    out.push(input.projectDescription);
  }
  if (input.rollingSummary) {
    out.push('## Latest rolling summary');
    out.push(input.rollingSummary);
  }
  if (input.openThreads) {
    out.push('## Open threads');
    out.push(input.openThreads);
  }
  out.push('## How to use this bundle');
  out.push(
    '- `meetings/` contains every meeting (summary, transcript, notes, screenshots).',
  );
  out.push('- `sources/` contains the docs attached to this project.');
  out.push('- `project/` contains the project description and rolling summary.');
  return out.join('\n');
}

function fallbackMeetingBriefing(input: MeetingBriefingInput): string {
  const out: string[] = [];
  out.push(`# ${input.title} — context briefing`);
  out.push('');
  out.push(
    '_AI briefing could not be generated for this export. The raw materials are still attached in this bundle._',
  );
  out.push('');
  if (input.summary) {
    out.push('## AI summary');
    out.push(input.summary);
  }
  if (input.notes) {
    out.push('## User notes');
    out.push(input.notes);
  }
  out.push('## How to use this bundle');
  out.push('- `meetings/<slug>/transcript.txt` has the full meeting transcript.');
  out.push('- `sources/` contains the docs attached to this project.');
  return out.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n…[truncated ${s.length - max} chars from full transcript]`;
}

// ============================================================ README rendering

function renderProjectReadme(args: {
  team: string;
  project: string;
  sourceCount: number;
  meetings: MeetingExportInfo[];
}): string {
  const lines: string[] = [];
  lines.push(`# ${args.project} — context export`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Team: \`${args.team}\``);
  lines.push('');
  lines.push('## What is in this zip');
  lines.push('');
  lines.push('- **`briefing.md`** — AI-synthesized executive summary of the project as of now. Start here.');
  lines.push('- **`project/`** — the project description, the rolling summary, and current open threads.');
  lines.push(
    `- **\`sources/\`** — ${args.sourceCount} attached reference doc${args.sourceCount === 1 ? '' : 's'} (PDFs, images, text).`,
  );
  lines.push(
    `- **\`meetings/\`** — ${args.meetings.length} meeting${args.meetings.length === 1 ? '' : 's'}, each with its own summary, transcript, notes, and any screenshots taken during it.`,
  );
  lines.push('');
  lines.push('## How to use this with Claude / ChatGPT / Gemini');
  lines.push('');
  lines.push('1. Unzip this folder.');
  lines.push('2. Open a new chat in your AI of choice.');
  lines.push('3. Drag in `briefing.md` first — that gives the model the executive summary in a single short doc.');
  lines.push('4. Then attach any specific files you want it to use (e.g. a particular transcript or PDF). Most chat UIs accept zips directly; you can also drop the whole folder in.');
  lines.push('5. Ask away. The briefing tells the model how to navigate the rest of the bundle.');
  if (args.meetings.length) {
    lines.push('');
    lines.push('## Meetings included');
    lines.push('');
    for (const m of args.meetings) {
      const flags: string[] = [];
      if (m.hasSummary) flags.push('summary');
      if (m.hasTranscript) flags.push('transcript');
      if (m.hasNotes) flags.push('notes');
      if (m.attachmentCount) flags.push(`${m.attachmentCount} attachment${m.attachmentCount === 1 ? '' : 's'}`);
      lines.push(`- \`${m.slug}\` — ${m.title}${flags.length ? `  _(${flags.join(', ')})_` : ''}`);
    }
  }
  return lines.join('\n');
}

function renderMeetingReadme(args: {
  title: string;
  startedAt: string | null;
  team: string | null;
  project: string | null;
  sourceCount: number;
  meeting: MeetingExportInfo | null;
}): string {
  const lines: string[] = [];
  lines.push(`# ${args.title} — context export`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  if (args.startedAt) lines.push(`Meeting started: ${args.startedAt}`);
  if (args.team && args.project) lines.push(`Project: \`${args.team}/${args.project}\``);
  lines.push('');
  lines.push('## What is in this zip');
  lines.push('');
  lines.push('- **`briefing.md`** — AI-synthesized summary of this meeting. Start here.');
  if (args.meeting) {
    const flags: string[] = [];
    if (args.meeting.hasSummary) flags.push('summary');
    if (args.meeting.hasTranscript) flags.push('transcript');
    if (args.meeting.hasNotes) flags.push('notes');
    if (args.meeting.attachmentCount) flags.push(`${args.meeting.attachmentCount} attachment${args.meeting.attachmentCount === 1 ? '' : 's'}`);
    lines.push(`- **\`meetings/${args.meeting.slug}/\`** — the meeting itself${flags.length ? ` (${flags.join(', ')})` : ''}.`);
  }
  if (args.sourceCount) {
    lines.push(`- **\`sources/\`** — ${args.sourceCount} project-level reference doc${args.sourceCount === 1 ? '' : 's'}.`);
  }
  if (args.team && args.project) {
    lines.push('- **`project/`** — the parent project\'s description, rolling summary, and open threads (for broader context).');
  }
  lines.push('');
  lines.push('## How to use this with Claude / ChatGPT / Gemini');
  lines.push('');
  lines.push('1. Unzip the folder.');
  lines.push('2. Open a new chat in your AI of choice.');
  lines.push('3. Drop in `briefing.md` first.');
  lines.push('4. Attach the full meeting folder (or just the transcript) if you want the model to dig into specifics.');
  return lines.join('\n');
}
