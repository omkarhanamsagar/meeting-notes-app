/**
 * Project "sources" — user-attached docs (PDFs, images, text/markdown) that
 * become persistent context for every future meeting summarization in the
 * project. Lives on disk at `<project>/sources/`:
 *
 *   <project>/sources/
 *     index.json       array of SourceEntry, ordered oldest -> newest
 *     <id>.<ext>       raw file bytes, content-addressed by random id
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectDir } from './storage.js';
import type { SourceEntry, SourceKind } from '../../shared/types.js';

const INDEX_FILE = 'index.json';

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_EXTS = new Set(['.md', '.txt', '.markdown', '.rst', '.log']);
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PDF_MIME = 'application/pdf';

export function sourcesDir(teamSlug: string, projectSlug: string): string {
  return path.join(projectDir(teamSlug, projectSlug), 'sources');
}

function ensureSourcesDir(teamSlug: string, projectSlug: string): string {
  const dir = sourcesDir(teamSlug, projectSlug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(teamSlug: string, projectSlug: string): string {
  return path.join(sourcesDir(teamSlug, projectSlug), INDEX_FILE);
}

function readIndex(teamSlug: string, projectSlug: string): SourceEntry[] {
  const p = indexPath(teamSlug, projectSlug);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SourceEntry[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(teamSlug: string, projectSlug: string, entries: SourceEntry[]): void {
  const dir = ensureSourcesDir(teamSlug, projectSlug);
  fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify(entries, null, 2));
}

/** Classify a file by mime + extension into one of our three handled kinds.
 *  Returns null for unsupported types (caller should reject). */
export function classify(mimeType: string, filename: string): SourceKind | null {
  const mt = mimeType.toLowerCase();
  if (mt === PDF_MIME) return 'pdf';
  if (IMAGE_MIMES.has(mt)) return 'image';
  if (TEXT_MIME_PREFIXES.some((p) => mt.startsWith(p))) return 'text';
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp') {
    return 'image';
  }
  if (TEXT_EXTS.has(ext)) return 'text';
  return null;
}

function normalizeMime(mimeType: string, kind: SourceKind, filename: string): string {
  if (mimeType) return mimeType.toLowerCase();
  if (kind === 'pdf') return PDF_MIME;
  if (kind === 'image') {
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    return 'image/png';
  }
  return 'text/plain';
}

export function listSources(teamSlug: string, projectSlug: string): SourceEntry[] {
  return readIndex(teamSlug, projectSlug);
}

export interface AddSourceArgs {
  filename: string;
  bytes: Buffer;
  mimeType: string;
  observation?: string;
}

export function addSource(
  teamSlug: string,
  projectSlug: string,
  args: AddSourceArgs,
): SourceEntry {
  const kind = classify(args.mimeType, args.filename);
  if (!kind) {
    throw new Error(`Unsupported file type: ${args.filename} (${args.mimeType})`);
  }

  const dir = ensureSourcesDir(teamSlug, projectSlug);
  const id = crypto.randomBytes(8).toString('hex');
  const ext = path.extname(args.filename).toLowerCase() || extForKind(kind);
  const onDisk = `${id}${ext}`;
  fs.writeFileSync(path.join(dir, onDisk), args.bytes);

  const entry: SourceEntry = {
    id,
    filename: args.filename,
    kind,
    mimeType: normalizeMime(args.mimeType, kind, args.filename),
    sizeBytes: args.bytes.byteLength,
    addedAt: new Date().toISOString(),
    observation: args.observation?.trim() ?? '',
  };

  const entries = readIndex(teamSlug, projectSlug);
  entries.push(entry);
  writeIndex(teamSlug, projectSlug, entries);
  return entry;
}

function extForKind(kind: SourceKind): string {
  if (kind === 'pdf') return '.pdf';
  if (kind === 'image') return '.png';
  return '.txt';
}

export function removeSource(teamSlug: string, projectSlug: string, id: string): void {
  const entries = readIndex(teamSlug, projectSlug);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return;
  const entry = entries[idx]!;
  const onDisk = onDiskPath(teamSlug, projectSlug, entry);
  if (fs.existsSync(onDisk)) {
    try {
      fs.unlinkSync(onDisk);
    } catch {
      // best-effort; index is still pruned below
    }
  }
  entries.splice(idx, 1);
  writeIndex(teamSlug, projectSlug, entries);
}

function onDiskPath(teamSlug: string, projectSlug: string, entry: SourceEntry): string {
  const ext = path.extname(entry.filename).toLowerCase() || extForKind(entry.kind);
  return path.join(sourcesDir(teamSlug, projectSlug), `${entry.id}${ext}`);
}

export function readSourceBytes(
  teamSlug: string,
  projectSlug: string,
  id: string,
): { entry: SourceEntry; bytes: Buffer } | null {
  const entries = readIndex(teamSlug, projectSlug);
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  const p = onDiskPath(teamSlug, projectSlug, entry);
  if (!fs.existsSync(p)) return null;
  return { entry, bytes: fs.readFileSync(p) };
}

/** A source materialized for the Claude prompt. Text sources are read into
 *  `text`; pdf/image sources are base64-encoded for native block emission. */
export type SourceContext =
  | { kind: 'text'; filename: string; observation: string; text: string }
  | {
      kind: 'pdf' | 'image';
      filename: string;
      observation: string;
      mediaType: string;
      base64: string;
    };

export function readSourcesForPrompt(
  teamSlug: string,
  projectSlug: string,
): SourceContext[] {
  const entries = readIndex(teamSlug, projectSlug);
  const out: SourceContext[] = [];
  for (const entry of entries) {
    const p = onDiskPath(teamSlug, projectSlug, entry);
    if (!fs.existsSync(p)) continue;
    try {
      const bytes = fs.readFileSync(p);
      if (entry.kind === 'text') {
        out.push({
          kind: 'text',
          filename: entry.filename,
          observation: entry.observation,
          text: bytes.toString('utf8'),
        });
      } else {
        out.push({
          kind: entry.kind,
          filename: entry.filename,
          observation: entry.observation,
          mediaType: entry.mimeType,
          base64: bytes.toString('base64'),
        });
      }
    } catch {
      // skip unreadable
    }
  }
  return out;
}
