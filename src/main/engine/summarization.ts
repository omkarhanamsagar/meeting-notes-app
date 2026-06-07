/**
 * Anthropic summarization. Same prompt + parsing strategy as the Python
 * version: ask Claude to emit three clearly-marked sections, then split.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  Base64ImageSource,
  DocumentBlockParam,
  ImageBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import { ANTHROPIC_MODEL } from './config.js';
import type { SourceContext } from './sources.js';

const SECTION_MEETING = '=== MEETING SUMMARY ===';
const SECTION_PROJECT = '=== UPDATED PROJECT SUMMARY ===';
const SECTION_THREADS = '=== UPDATED OPEN THREADS ===';

const SYSTEM_PROMPT_BASE = `You are a meeting notes assistant for one specific user (the person whose meetings these are).

Your job: given a transcript of a meeting the user just had, plus relevant prior context, produce:
  1. A clean, useful summary of THIS meeting
  2. An updated rolling summary of the overall project (if this meeting is part of one)
  3. An updated list of open threads (decisions pending, action items, follow-ups)

Style guidelines for summaries:
- Lead with the most important outcomes and decisions, not chronological recap
- Be specific. Quote exact numbers, names, dates, decisions. Avoid vague phrases like "the team discussed X".
- Distinguish DECIDED from DISCUSSED from OPEN
- If something contradicts a prior decision/thread, flag it explicitly
- If the user has attached project sources (PDFs, screenshots, docs) below, treat them as authoritative background context. Use them to ground specifics, resolve ambiguity in the transcript, and inform the rolling project summary and open threads. Don't summarize the sources as their own section; weave their content in where it's relevant.
- Use markdown. Short sections with bold headers.
- Don't invent attendees. If the transcript doesn't name speakers clearly, just refer to "the group" or use roles when obvious from context.
- Skip filler: "we said hi", "we wrapped up", etc.

Format your response EXACTLY like this, with these literal section markers:

=== MEETING SUMMARY ===
<markdown content for this meeting's summary>

=== UPDATED PROJECT SUMMARY ===
<a complete rewritten project summary that incorporates this meeting's new information; this should be a self-contained doc someone could read cold to understand the project>

=== UPDATED OPEN THREADS ===
<a complete rewritten markdown list of open threads — items that are still pending, action items, decisions awaiting input. Mark resolved items as DONE and remove them on the next pass. Each item should have a date prefix in [YYYY-MM-DD] form indicating when it was first surfaced.>

If this meeting is NOT part of a project (no prior context provided below), omit the UPDATED PROJECT SUMMARY and UPDATED OPEN THREADS sections — just produce the MEETING SUMMARY.
`;

const SYSTEM_PROMPT_VISUAL_ADDENDUM = `

## Working with attached screenshots

When the user attaches screenshots during a meeting, treat them as PRIMARY evidence — the user explicitly highlighted these moments. For each screenshot you receive, you also get:
  (a) the transcript ±60s around the moment of capture,
  (b) any free-form note the user typed alongside it, and
  (c) the image itself.

Weave the screenshots directly into the MEETING SUMMARY's narrative — do NOT create a separate "Visual evidence" / "Screenshots" / "Attachments" section. Place each screenshot inline at the point in the summary where it's most relevant (often inside the related Decision, Discussion item, or Action Item).

For each screenshot:
  - Embed the image on its own line using the EXACT markdown link the user gave you, e.g. \`![](attachments/2026-05-27_02-03-40.png)\`. Do not rename, re-encode, or rewrite the path.
  - Either just before or just after the image, write one or two sentences in plain prose that say what the screenshot shows in the context of what was being said. Don't label it ("Screenshot 1:", "Visual:", etc.) — write naturally.
  - If the screenshot informs concrete next steps, fold those into the surrounding Action Items / Next Steps the summary already has. Don't create new ad-hoc bullet headers under each image.

Use the screenshots to ground specificity. If a screenshot shows a dashboard, design, or piece of code, name what's actually in the image — colors, numbers, controls, error messages, copy.
`;

export interface SummaryResult {
  meetingSummary: string;
  updatedProjectSummary: string | null;
  updatedOpenThreads: string | null;
}

/** One screenshot the user dropped into the canvas, with its surrounding
 *  transcript window and the image bytes ready for Claude. */
export interface ScreenshotContext {
  /** Relative path inside the meeting dir (used so Claude can reference
   *  the image in its summary via the markdown link). */
  path: string;
  atMs: number | null;
  observation: string;
  transcriptWindow: string;
  base64: string;
  mediaType: string;
}

export interface SummarizeArgs {
  meetingTitle: string;
  transcript: string;
  projectName?: string | null;
  projectDescription?: string | null;
  projectSummary?: string | null;
  openThreads?: string | null;
  priorMeetingSummaries?: Array<[string, string]>;
  projectDocs?: Array<[string, string]>;
  screenshots?: ScreenshotContext[];
  /** User-attached project sources (PDFs, images, text/markdown) that should
   *  be sent to Claude as persistent rolling context for every meeting in
   *  this project. */
  sources?: SourceContext[];
}

type ContentBlock = TextBlockParam | ImageBlockParam | DocumentBlockParam;

function formatTs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function buildContextHeader(args: SummarizeArgs): string {
  const parts: string[] = [];
  parts.push(`# New meeting to summarize\n\n**Title:** ${args.meetingTitle}\n`);

  if (args.projectName) {
    parts.push(`**Part of project:** ${args.projectName}\n`);
    if (args.projectDescription) {
      parts.push(`\n## Project description\n\n${args.projectDescription}\n`);
    }
    if (args.projectDocs?.length) {
      parts.push('\n## Project reference docs\n');
      for (const [fname, content] of args.projectDocs) {
        parts.push(`\n### ${fname}\n\n${content}\n`);
      }
    }
    if (args.projectSummary) {
      parts.push(`\n## Current rolling project summary (pre-meeting)\n\n${args.projectSummary}\n`);
    }
    if (args.openThreads) {
      parts.push(`\n## Current open threads (pre-meeting)\n\n${args.openThreads}\n`);
    }
    if (args.priorMeetingSummaries?.length) {
      parts.push('\n## Prior meeting summaries in this project (oldest first)\n');
      for (const [dateTitle, summary] of args.priorMeetingSummaries) {
        parts.push(`\n### ${dateTitle}\n\n${summary}\n`);
      }
    }
  }
  return parts.join('\n');
}

function buildContent(args: SummarizeArgs): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  blocks.push({ type: 'text', text: buildContextHeader(args) });

  const sources = args.sources ?? [];
  if (sources.length > 0) {
    blocks.push({
      type: 'text',
      text:
        `\n## Project sources\n\n` +
        `The user has attached ${sources.length} project-level source${
          sources.length === 1 ? '' : 's'
        } below. These are persistent reference materials (PDFs, screenshots, docs) ` +
        `that apply across every meeting in this project. Treat them as authoritative ` +
        `background context — use them to ground specifics, resolve ambiguity in the ` +
        `transcript, and inform the rolling project summary and open threads. Don't ` +
        `summarize them as their own section; weave their content into the meeting ` +
        `summary where it's relevant.\n`,
    });
    sources.forEach((s, i) => {
      const obsLine = s.observation.trim()
        ? `User's note on this source: "${s.observation.trim()}"`
        : "User's note on this source: (none)";
      if (s.kind === 'text') {
        blocks.push({
          type: 'text',
          text:
            `\n### Source ${i + 1} of ${sources.length} \u2014 ${s.filename} (text)\n` +
            `${obsLine}\n\n\`\`\`\n${s.text.trim()}\n\`\`\`\n`,
        });
      } else if (s.kind === 'image') {
        blocks.push({
          type: 'text',
          text:
            `\n### Source ${i + 1} of ${sources.length} \u2014 ${s.filename} (image)\n` +
            `${obsLine}\n`,
        });
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: s.mediaType as Base64ImageSource['media_type'],
            data: s.base64,
          },
        });
      } else {
        blocks.push({
          type: 'text',
          text:
            `\n### Source ${i + 1} of ${sources.length} \u2014 ${s.filename} (PDF)\n` +
            `${obsLine}\n`,
        });
        blocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: s.base64,
          },
          title: s.filename,
        });
      }
    });
  }

  const screenshots = args.screenshots ?? [];
  if (screenshots.length > 0) {
    blocks.push({
      type: 'text',
      text: `\n## Attached screenshots\n\nThe user explicitly attached ${screenshots.length} screenshot${
        screenshots.length === 1 ? '' : 's'
      } during this meeting. Each one below is paired with the transcript window around when it was captured and any free-form note the user typed alongside. Treat these as primary evidence and surface them in your "Visual evidence" section as instructed.\n`,
    });
    screenshots.forEach((s, i) => {
      const timing =
        typeof s.atMs === 'number'
          ? `taken ${formatTs(s.atMs)} into the meeting`
          : 'no timestamp (added outside the recording)';
      const obs = s.observation.trim()
        ? `User's note alongside: "${s.observation.trim()}"`
        : "User's note alongside: (none)";
      const window = s.transcriptWindow.trim()
        ? s.transcriptWindow.trim()
        : '(no transcript segments overlap this moment)';
      blocks.push({
        type: 'text',
        text:
          `\n### Screenshot ${i + 1} of ${screenshots.length} — ${timing}\n` +
          `Inline embed path (use exactly this in your summary): \`${s.path}\`\n` +
          `${obs}\n\n` +
          `Transcript window (±60s around capture):\n\`\`\`\n${window}\n\`\`\`\n`,
      });
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: s.mediaType as Base64ImageSource['media_type'],
          data: s.base64,
        },
      });
    });
  }

  blocks.push({
    type: 'text',
    text: `\n## Raw transcript of the new meeting\n\n\`\`\`\n${args.transcript.trim()}\n\`\`\`\n`,
  });

  if (args.projectName) {
    blocks.push({
      type: 'text',
      text: '\nNow produce all three sections (MEETING SUMMARY, UPDATED PROJECT SUMMARY, UPDATED OPEN THREADS) per the format instructions.',
    });
  } else {
    blocks.push({
      type: 'text',
      text: '\nThis meeting is not part of a project — produce ONLY the MEETING SUMMARY section.',
    });
  }

  return blocks;
}

function splitSections(text: string): SummaryResult {
  function grab(marker: string, until: string[]): string | null {
    const start = text.indexOf(marker);
    if (start === -1) return null;
    const contentStart = start + marker.length;
    let end = text.length;
    for (const u of until) {
      const idx = text.indexOf(u, contentStart);
      if (idx !== -1 && idx < end) end = idx;
    }
    const slice = text.slice(contentStart, end).trim();
    return slice || null;
  }

  const meeting = grab(SECTION_MEETING, [SECTION_PROJECT, SECTION_THREADS]);
  const project = grab(SECTION_PROJECT, [SECTION_THREADS]);
  const threads = grab(SECTION_THREADS, []);

  return {
    meetingSummary: meeting ?? text.trim(),
    updatedProjectSummary: project,
    updatedOpenThreads: threads,
  };
}

/**
 * Ask Claude for a short, descriptive title (2–5 words) based on the
 * meeting summary. Used to auto-name "Untitled — h:mm a" recordings once
 * processing is complete. Returns the cleaned title, or null on any error
 * (callers should treat null as "keep existing title").
 */
export async function generateTitle(summary: string, transcript: string): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  // Prefer the summary as input — it's already distilled. Fall back to the
  // first chunk of transcript if no summary was produced.
  const source = summary.trim() || transcript.slice(0, 4000);
  if (!source.trim()) return null;

  const client = new Anthropic();
  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 60,
    system:
      'You generate concise meeting titles. Return ONLY the title — no quotes, no punctuation at the end, no preamble. 2 to 5 words, Title Case.',
    messages: [
      {
        role: 'user',
        content: `Generate a 2-5 word title for this meeting.\n\n${source}`,
      },
    ],
  });

  const raw = response.content
    .map((block) => ('text' in block ? block.text : ''))
    .join('')
    .trim();

  if (!raw) return null;

  // Strip wrapping quotes and trailing punctuation that Claude sometimes adds.
  const cleaned = raw
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.!?]+$/g, '')
    .trim();

  // Sanity guard: reject anything wildly long (more than ~10 words).
  if (cleaned.split(/\s+/).length > 10) return null;
  return cleaned || null;
}

export async function summarize(args: SummarizeArgs): Promise<SummaryResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY env var is not set');
  }

  const client = new Anthropic();
  const content = buildContent(args);
  const hasScreenshots = (args.screenshots ?? []).length > 0;
  const system = hasScreenshots
    ? SYSTEM_PROMPT_BASE + SYSTEM_PROMPT_VISUAL_ADDENDUM
    : SYSTEM_PROMPT_BASE;

  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 8192,
    system,
    messages: [{ role: 'user', content }],
  });

  // The SDK returns a content array; for plain text completions there's one TextBlock.
  const rawText = response.content
    .map((block) => ('text' in block ? block.text : ''))
    .join('');

  return splitSections(rawText);
}
