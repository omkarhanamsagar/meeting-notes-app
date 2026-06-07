/**
 * Chat engine. One persistent conversation per scope (project or meeting),
 * persisted to <scope-root>/chat.json. Streams Claude responses back to the
 * renderer via a callback so the UI can show tokens as they arrive.
 *
 * Context strategy: every send rebuilds the full system prompt from disk so
 * new sources / new meeting summaries are picked up automatically without
 * needing to wipe the conversation. The user's stored message history is
 * sent verbatim alongside.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type {
  Base64ImageSource,
  ContentBlockParam,
  DocumentBlockParam,
  ImageBlockParam,
  MessageParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import { projectDir } from './storage.js';
import {
  priorMeetingSummaries,
  readOpenThreads,
  readProjectDescription,
  readProjectSummary,
  readTextDocs,
} from './projects.js';
import { listSources, readSourcesForPrompt, type SourceContext } from './sources.js';
import { DEFAULT_MODEL_ID, isKnownModel } from './models.js';
import type {
  ChatChunkEvent,
  ChatContentPart,
  ChatImagePart,
  ChatMessage,
  ChatPdfPart,
  ChatScope,
  ChatSession,
  MeetingMeta,
} from '../../shared/types.js';
import { readAttachmentIndex, readMeta } from './storage.js';

const CHAT_FILE = 'chat.json';
const MAX_PROMPT_IMAGES_PER_TURN = 6;
// Hard cap on response length. Smaller than the model's max — we'd rather
// the model truncate itself than ramble. Users who want long output ask for
// it explicitly ("draft the full doc"); short cap pushes the default toward
// concise answers without needing to nag the prompt.
const MAX_OUTPUT_TOKENS = 1024;

// ===================================================================== paths

function scopeDir(scope: ChatScope): string {
  if (scope.kind === 'project') return projectDir(scope.team, scope.project);
  return scope.dir;
}

function chatPath(scope: ChatScope): string {
  return path.join(scopeDir(scope), CHAT_FILE);
}

// ===================================================================== session IO

function emptySession(): ChatSession {
  return {
    id: crypto.randomBytes(8).toString('hex'),
    model: DEFAULT_MODEL_ID,
    excludedSourceIds: [],
    messages: [],
    updatedAt: new Date().toISOString(),
  };
}

export function readChat(scope: ChatScope): ChatSession {
  const p = chatPath(scope);
  if (!fs.existsSync(p)) return emptySession();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as ChatSession;
    if (!raw || !Array.isArray(raw.messages)) return emptySession();
    if (!isKnownModel(raw.model)) raw.model = DEFAULT_MODEL_ID;
    if (!Array.isArray(raw.excludedSourceIds)) raw.excludedSourceIds = [];
    return raw;
  } catch {
    return emptySession();
  }
}

export function writeChat(scope: ChatScope, session: ChatSession): void {
  const dir = scopeDir(scope);
  fs.mkdirSync(dir, { recursive: true });
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(chatPath(scope), JSON.stringify(session, null, 2));
}

export function clearChat(scope: ChatScope): void {
  const p = chatPath(scope);
  if (fs.existsSync(p)) {
    try {
      fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
}

// ===================================================================== context assembly

interface ScopeContext {
  /** Stable identifier used in the system prompt header. */
  scopeLabel: string;
  /** Markdown blob assembled from on-disk context (text + summaries + docs). */
  textHeader: string;
  /** Project sources (text + image + pdf) to attach as native blocks. */
  sources: SourceContext[];
  /** Meeting screenshots (for meeting scope only) — sent as image blocks. */
  meetingScreenshots: Array<{ filename: string; base64: string; mediaType: string }>;
}

function loadProjectContext(
  team: string,
  project: string,
  exclusions: { sourceIds: Set<string>; meetingSlugs: Set<string> },
): {
  textHeader: string;
  sources: SourceContext[];
  scopeLabel: string;
} {
  const parts: string[] = [];
  const projDesc = readProjectDescription(team, project);
  if (projDesc) {
    parts.push(`\n## Project description\n\n${projDesc}\n`);
  }
  const docs = readTextDocs(team, project);
  if (docs.length) {
    parts.push('\n## Project reference docs\n');
    for (const [fname, content] of docs) {
      parts.push(`\n### ${fname}\n\n${content}\n`);
    }
  }
  const summary = readProjectSummary(team, project);
  if (summary) {
    parts.push(`\n## Current rolling project summary\n\n${summary}\n`);
  }
  const threads = readOpenThreads(team, project);
  if (threads) {
    parts.push(`\n## Current open threads\n\n${threads}\n`);
  }
  const meetings = priorMeetingSummaries(team, project).filter(
    ([slug]) => !exclusions.meetingSlugs.has(slug),
  );
  if (meetings.length) {
    parts.push('\n## Prior meeting summaries (oldest first)\n');
    for (const [dateTitle, mSummary] of meetings) {
      parts.push(`\n### ${dateTitle}\n\n${mSummary}\n`);
    }
  }
  const allSources = readSourcesForPrompt(team, project);
  // Note: SourceContext doesn't currently carry an id (it was modeled for the
  // summarizer, which didn't need one). We filter by walking the underlying
  // index to map id -> filename, and excluding any source whose corresponding
  // entry id is in the exclusion set.
  const filteredSources = filterSourcesByExclusion(team, project, allSources, exclusions.sourceIds);
  return {
    textHeader: parts.join('\n'),
    sources: filteredSources,
    scopeLabel: `project "${project}" (team "${team}")`,
  };
}

function filterSourcesByExclusion(
  team: string,
  project: string,
  loaded: SourceContext[],
  excludedIds: Set<string>,
): SourceContext[] {
  if (excludedIds.size === 0) return loaded;
  // SourceContext carries filename (not id); map id -> filename via the
  // manifest, then exclude anything whose filename matches. Filenames may
  // theoretically collide (rare in practice) which would over-exclude; we
  // accept that for v1 to avoid threading ids through SourceContext.
  const manifest = listSources(team, project);
  const excludedFilenames = new Set(
    manifest.filter((m) => excludedIds.has(m.id)).map((m) => m.filename),
  );
  if (excludedFilenames.size === 0) return loaded;
  return loaded.filter((s) => !excludedFilenames.has(s.filename));
}

function loadMeetingContext(
  meetingDir: string,
  exclusions: { sourceIds: Set<string>; meetingSlugs: Set<string> },
): ScopeContext {
  const meta: MeetingMeta = readMeta(meetingDir);
  const team = meta.team;
  const project = meta.project;

  // Start with project-level context if this meeting is filed under one.
  let textHeader = '';
  let sources: SourceContext[] = [];
  if (team && project) {
    const proj = loadProjectContext(team, project, exclusions);
    textHeader = proj.textHeader;
    sources = proj.sources;
  }

  // Append meeting-specific material.
  const sumPath = path.join(meetingDir, 'summary.md');
  if (fs.existsSync(sumPath)) {
    textHeader += `\n## This meeting's existing summary\n\n${fs.readFileSync(sumPath, 'utf8')}\n`;
  }
  const txPath = path.join(meetingDir, 'transcript.txt');
  if (fs.existsSync(txPath)) {
    textHeader += `\n## This meeting's transcript\n\n\`\`\`\n${fs.readFileSync(txPath, 'utf8').trim()}\n\`\`\`\n`;
  }
  const notesPath = path.join(meetingDir, 'notes.md');
  if (fs.existsSync(notesPath)) {
    const notes = fs.readFileSync(notesPath, 'utf8').trim();
    if (notes) {
      textHeader += `\n## User's free-form notes on this meeting\n\n${notes}\n`;
    }
  }

  // Meeting screenshots — load and base64-encode for image blocks.
  const screenshots: ScopeContext['meetingScreenshots'] = [];
  for (const entry of readAttachmentIndex(meetingDir)) {
    const full = path.join(meetingDir, entry.path);
    if (!fs.existsSync(full)) continue;
    const ext = path.extname(full).toLowerCase().slice(1);
    const mediaType =
      ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'webp'
            ? 'image/webp'
            : 'image/png';
    try {
      screenshots.push({
        filename: path.basename(full),
        base64: fs.readFileSync(full).toString('base64'),
        mediaType,
      });
    } catch {
      // skip unreadable
    }
  }

  const title = meta.title || path.basename(meetingDir);
  return {
    scopeLabel: `meeting "${title}"${
      team && project ? ` in project "${project}"` : ''
    }`,
    textHeader,
    sources,
    meetingScreenshots: screenshots,
  };
}

function loadContext(
  scope: ChatScope,
  excludedSourceIds: string[] = [],
  excludedMeetingSlugs: string[] = [],
): ScopeContext {
  const exclusions = {
    sourceIds: new Set(excludedSourceIds),
    meetingSlugs: new Set(excludedMeetingSlugs),
  };
  if (scope.kind === 'project') {
    const p = loadProjectContext(scope.team, scope.project, exclusions);
    return {
      scopeLabel: p.scopeLabel,
      textHeader: p.textHeader,
      sources: p.sources,
      meetingScreenshots: [],
    };
  }
  return loadMeetingContext(scope.dir, exclusions);
}

// ===================================================================== prompt building

const SYSTEM_PROMPT_BASE = `You are a meeting-notes assistant chatting with the user about their own meetings, projects, and the attached context.

# Length
- Match response length to the question. A one-line question gets a one-to-three sentence answer. A short list question gets a short list.
- Default to under ~120 words. Only go longer if the user explicitly asks for detail, a draft, a full breakdown, or something that genuinely can't be said briefly.
- Do not pad with examples, restatements, caveats, or "let me know if…" closers. Stop when the answer is done.
- No giant header trees. For short answers, plain prose is fine — skip markdown headings entirely.

# Anti-hallucination (this matters most)
For factual questions ("where did you get X", "what was decided", "who said Y", "when is Z"):
- Answer ONLY with what is literally stated in the context. Quote or paraphrase the exact line(s) and stop.
- If the user is asking where a piece of info came from, point to the one place it came from. Do not list other places that mention related-but-different things.
- If the info isn't in the context, say so in one sentence and stop. Examples: "I don't see that in your notes." / "Not in the context I have — only X was mentioned."
- Do NOT volunteer adjacent material, plausible extrapolations, "this could mean…", "this implies…", "based on general knowledge…", or speculation about what the user might have meant. The user asked a specific question; answer that question.
- Inference is only appropriate when the user explicitly asks for it ("what do you think this means", "give me your read"). Otherwise, stick to what's recorded.
- Never invent names, dates, deadlines, action items, quotes, numbers, or attributions. If you find yourself writing "[name] mentioned" or quoting someone, that quote must be verbatim from the context.

A common failure mode to avoid: when asked "where did you get this", do not respond with a multi-section breakdown of every source you considered. Just point to where the claim actually came from, or admit you extrapolated.

# Using context selectively
- The context below contains prior meetings, docs, and sources. Most are not relevant to any given question.
- Only reference a meeting, source, or doc when it directly answers what was asked. Don't drag in old notes just because they exist.
- When citing, name the source specifically (e.g. "in the May 12 retro" or "from the API design doc").
- For general questions that don't need prior context, answer directly without rummaging through their notes.

# Drafting
- If asked to draft something (email, agenda, message), use what's in context, write it tight, and only ask a follow-up if a detail is genuinely blocking.
`;

function buildSystemPrompt(ctx: ScopeContext): string {
  return (
    SYSTEM_PROMPT_BASE +
    `\n## Scope of this conversation\n\nThis chat is scoped to ${ctx.scopeLabel}. ` +
    `All context below is the source material you have access to.\n` +
    (ctx.textHeader ? `\n# Context\n${ctx.textHeader}` : '\n_(No textual context attached yet — only what the user sends in chat is available.)_\n')
  );
}

function sourcesToBlocks(sources: SourceContext[]): ContentBlockParam[] {
  const out: ContentBlockParam[] = [];
  for (const s of sources) {
    if (s.kind === 'text') {
      out.push({
        type: 'text',
        text: `\n### Source: ${s.filename} (text)\n${
          s.observation ? `User's note: ${s.observation}\n` : ''
        }\n\`\`\`\n${s.text.trim()}\n\`\`\``,
      } satisfies TextBlockParam);
    } else if (s.kind === 'image') {
      out.push({
        type: 'text',
        text: `\n### Source: ${s.filename} (image)\n${
          s.observation ? `User's note: ${s.observation}\n` : ''
        }`,
      } satisfies TextBlockParam);
      out.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: s.mediaType as Base64ImageSource['media_type'],
          data: s.base64,
        },
      } satisfies ImageBlockParam);
    } else {
      out.push({
        type: 'text',
        text: `\n### Source: ${s.filename} (PDF)\n${
          s.observation ? `User's note: ${s.observation}\n` : ''
        }`,
      } satisfies TextBlockParam);
      out.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: s.base64,
        },
        title: s.filename,
      } satisfies DocumentBlockParam);
    }
  }
  return out;
}

function meetingScreenshotsToBlocks(
  screenshots: ScopeContext['meetingScreenshots'],
): ContentBlockParam[] {
  if (!screenshots.length) return [];
  const out: ContentBlockParam[] = [
    {
      type: 'text',
      text: `\n## Meeting screenshots (${screenshots.length})\nThe user attached these screenshots during the meeting. Use them as visual evidence.`,
    },
  ];
  for (const s of screenshots) {
    out.push({
      type: 'text',
      text: `\n### ${s.filename}`,
    });
    out.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: s.mediaType as Base64ImageSource['media_type'],
        data: s.base64,
      },
    });
  }
  return out;
}

function chatContentToBlocks(parts: ChatContentPart[]): ContentBlockParam[] {
  const out: ContentBlockParam[] = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text.trim()) out.push({ type: 'text', text: p.text });
    } else if (p.type === 'image') {
      out.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: p.mediaType as Base64ImageSource['media_type'],
          data: p.data,
        },
      });
    } else {
      // PDF attached to a chat turn — native document block. Anthropic
      // accepts PDFs up to 32MB / 100 pages on this block; renderer enforces
      // its own caps before we ever see it here.
      out.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: p.data,
        },
        // A small text hint keeps the model from getting confused when the
        // user attaches multiple PDFs in a single turn.
        title: p.filename,
      } satisfies DocumentBlockParam);
    }
  }
  return out;
}

/** Assemble the `messages` array for the API. The first user turn carries
 *  the context blocks (sources + meeting screenshots) so subsequent turns
 *  don't bloat. The history of prior turns is sent verbatim. */
function buildMessagesForApi(
  ctx: ScopeContext,
  history: ChatMessage[],
  newUserParts: ChatContentPart[],
): MessageParam[] {
  const messages: MessageParam[] = [];
  const contextBlocks: ContentBlockParam[] = [
    ...sourcesToBlocks(ctx.sources),
    ...meetingScreenshotsToBlocks(ctx.meetingScreenshots),
  ];

  // History first (verbatim — they were built without context blocks).
  for (const m of history) {
    messages.push({
      role: m.role,
      content: chatContentToBlocks(m.content),
    });
  }

  // New user turn. We always re-attach the current binary context blocks
  // (PDF sources, image sources, meeting screenshots) to the latest user
  // message — not just the first turn — because:
  //   1. The user can add sources mid-conversation. If we only attached on
  //      turn 1, Claude would never see anything added later.
  //   2. Binary content (PDFs, images) can't live in the system prompt; it
  //      has to ride on a message turn, and re-sending the latest manifest
  //      keeps the model's view of "what's attached" current.
  // Text-only context lives in the system prompt (rebuilt every send) so
  // it doesn't need to be re-attached here.
  // Cost trade-off: this resends source bytes every turn, but the user
  // explicitly opted into accuracy over token-cost optimization.
  const newBlocks = chatContentToBlocks(newUserParts);
  if (contextBlocks.length > 0) {
    messages.push({ role: 'user', content: [...contextBlocks, ...newBlocks] });
  } else {
    messages.push({ role: 'user', content: newBlocks });
  }

  return messages;
}

// ===================================================================== send

export interface SendArgs {
  scope: ChatScope;
  /** Plain-text user message (may be empty if only sending attachments). */
  text: string;
  /** Optional images attached to this turn (base64, no data-URL prefix). */
  images?: ChatImagePart[];
  /** Optional PDFs attached to this turn (base64, no data-URL prefix). */
  pdfs?: ChatPdfPart[];
  /** Model id to use for this turn (also persisted as session.model). */
  model: string;
  /** Source ids to omit from the prompt context for this send. */
  excludedSourceIds?: string[];
  /** Meeting folder names (slugs) to omit from prior-meeting context. */
  excludedMeetingSlugs?: string[];
}

export interface SendResult {
  /** The final assistant message that got persisted. */
  message: ChatMessage;
}

/** Send a user turn and stream the assistant's response back via `onChunk`.
 *  Returns once the stream is complete (or errored). */
export async function sendMessage(
  args: SendArgs,
  requestId: string,
  onChunk: (event: ChatChunkEvent) => void,
): Promise<SendResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = 'ANTHROPIC_API_KEY env var is not set';
    onChunk({ requestId, kind: 'error', error: err });
    throw new Error(err);
  }

  const session = readChat(args.scope);
  const modelId = isKnownModel(args.model) ? args.model : DEFAULT_MODEL_ID;
  session.model = modelId;

  // Cap attached files per turn to keep prompts sane. The renderer enforces
  // a combined cap; we re-clamp here defensively for any direct IPC callers.
  const images = (args.images ?? []).slice(0, MAX_PROMPT_IMAGES_PER_TURN);
  const pdfs = (args.pdfs ?? []).slice(0, MAX_PROMPT_IMAGES_PER_TURN);

  // Persist the user turn upfront so it survives a mid-stream crash.
  const userParts: ChatContentPart[] = [];
  if (args.text.trim()) userParts.push({ type: 'text', text: args.text });
  for (const img of images) userParts.push(img);
  for (const pdf of pdfs) userParts.push(pdf);
  if (!userParts.length) {
    const err = 'Cannot send an empty message';
    onChunk({ requestId, kind: 'error', error: err });
    throw new Error(err);
  }

  const userMsg: ChatMessage = {
    id: crypto.randomBytes(8).toString('hex'),
    role: 'user',
    content: userParts,
    timestamp: new Date().toISOString(),
  };
  // history BEFORE we append the new user turn — we pass it to buildMessagesForApi
  const history = session.messages.slice();
  session.messages.push(userMsg);
  writeChat(args.scope, session);

  // Load fresh context every send so new sources / new meeting summaries
  // are picked up automatically without resetting the conversation.
  const ctx = loadContext(args.scope, args.excludedSourceIds, args.excludedMeetingSlugs);
  const messages = buildMessagesForApi(ctx, history, userParts);
  const system = buildSystemPrompt(ctx);

  const client = new Anthropic();
  const stream = client.messages.stream({
    model: modelId,
    max_tokens: MAX_OUTPUT_TOKENS,
    system,
    messages,
  });

  let assembled = '';
  stream.on('text', (delta) => {
    assembled += delta;
    onChunk({ requestId, kind: 'delta', text: delta });
  });

  try {
    await stream.finalMessage();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onChunk({ requestId, kind: 'error', error: msg });
    throw err;
  }

  // Build the persisted assistant message from the assembled text. We don't
  // currently support assistant-returned images / tool use / thinking blocks,
  // so plain text is sufficient.
  const assistantMsg: ChatMessage = {
    id: crypto.randomBytes(8).toString('hex'),
    role: 'assistant',
    content: [{ type: 'text', text: assembled }],
    timestamp: new Date().toISOString(),
  };
  session.messages.push(assistantMsg);
  writeChat(args.scope, session);

  onChunk({ requestId, kind: 'done', message: assistantMsg });
  return { message: assistantMsg };
}
