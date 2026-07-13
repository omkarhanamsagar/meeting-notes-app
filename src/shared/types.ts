/**
 * Types shared between Electron main and React renderer.
 * Keep this dependency-free so it can be imported from anywhere.
 */

export interface MeetingMeta {
  /** Full path to the meeting folder on disk. */
  dir: string;
  title: string;
  /** URL-safe slug derived from the title. */
  slug: string;
  /** Team slug. `null` only for legacy unfiled meetings. */
  team: string | null;
  /** Project slug, or null for unfiled meetings. */
  project: string | null;
  /** ISO 8601 timestamp. */
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  hasTranscript: boolean;
  hasSummary: boolean;
  /** Whether `recording.wav` is on disk. Lets the UI offer a recovery
   *  path ("Generate summary") for meetings whose transcription failed. */
  hasRecording: boolean;
}

export interface TeamMeta {
  slug: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface TeamStats {
  slug: string;
  projectCount: number;
  /** ISO 8601 timestamp of the most recent meeting across all projects in this team. */
  lastActivityAt: string | null;
}

export interface TeamWithStats extends TeamMeta {
  stats: TeamStats;
}

export interface ProjectMeta {
  slug: string;
  /** Team this project belongs to. */
  team: string;
  name: string;
  description: string;
  createdAt: string;
}

/** Light-weight aggregate stats used by the workspace grid. */
export interface ProjectStats {
  slug: string;
  meetingCount: number;
  /** ISO 8601 timestamp of the most recent meeting, or null if empty. */
  lastActivityAt: string | null;
}

export interface ProjectWithStats extends ProjectMeta {
  stats: ProjectStats;
}

/** Persistent UI state that survives app restarts. */
export type CalendarLeadMinutes = 5 | 10 | 15 | 30;

export interface CalendarStatus {
  /** Whether the user has pasted an OAuth client_id/secret yet. */
  hasClient: boolean;
  /** Whether we have valid tokens stored. */
  isConnected: boolean;
  /** Whether the poller is currently running. */
  isEnabled: boolean;
  /** The currently-selected lead time, in minutes. */
  leadMinutes: CalendarLeadMinutes;
  /** Connected Google account, or null if disconnected. */
  account: { email: string; name?: string; lastSyncAt: string | null } | null;
}

export interface AppState {
  /** Last team the user was viewing — used to restore on startup. */
  lastTeamSlug: string | null;
  /** Last project the user was viewing — used to restore on startup. */
  lastProjectSlug: string | null;
  /** Bumped each time storage migrations run. 0 = pre-teams (projects at the root). */
  migrationVersion: number;
  /** Schema version for future migrations. */
  version: number;
}

export interface MeetingDetail {
  meta: MeetingMeta;
  summary: string | null;
  transcript: string | null;
  notes: string;
}

export interface RecordingState {
  active: boolean;
  /** Slug for the in-progress meeting, if any. */
  meetingSlug: string | null;
  /** Title shown in the UI for the in-progress meeting. */
  title: string | null;
  /** Epoch ms when recording started, so the renderer can compute its own ticker. */
  startedAt: number | null;
  /** Full path to the in-progress meeting folder on disk. */
  dir: string | null;
}

export interface StartRecordingArgs {
  /** Optional — main process will generate "Untitled — h:mm a" if omitted. */
  title?: string;
  /** Optional — main uses appState.lastTeamSlug, then the first team on disk. */
  team?: string;
  /** Optional — main uses appState.lastProjectSlug, then the first project in the chosen team. */
  project?: string;
}

export type ProcessingStage =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'summarizing'
  | 'done'
  | 'error';

export interface ProcessingUpdate {
  stage: ProcessingStage;
  meetingSlug: string | null;
  message?: string;
}

export interface AudioDevice {
  index: number;
  name: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Where the resolved Claude (Anthropic) API key comes from. An
 *  `ANTHROPIC_API_KEY` env var always wins over the key saved in Settings. */
export type ApiKeySource = 'env' | 'stored' | 'none';

export interface ApiKeyStatus {
  source: ApiKeySource;
  /** Masked preview of the active key (e.g. `sk-ant-a…1b2c`), or null if unset. */
  hint: string | null;
}

/** One whisper-cli segment with millisecond-precise bounds. */
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

// ===================================================================== Chat

/** Where a chat conversation is scoped. Project chats span the whole project;
 *  meeting chats are scoped to a single meeting (but still load project
 *  context as background). */
export type ChatScope =
  | { kind: 'project'; team: string; project: string }
  | { kind: 'meeting'; dir: string };

/** One image attached by the user to a chat message. */
export interface ChatImagePart {
  type: 'image';
  /** Base64-encoded raw bytes (no data-URL prefix). */
  data: string;
  /** Mime type, e.g. `image/png`. */
  mediaType: string;
  /** Original filename for display (optional). */
  filename?: string;
}

export interface ChatTextPart {
  type: 'text';
  text: string;
}

export interface ChatPdfPart {
  type: 'pdf';
  /** Base64-encoded raw PDF bytes (no data-URL prefix). */
  data: string;
  /** Always `application/pdf`; kept explicit for symmetry with image parts. */
  mediaType: 'application/pdf';
  /** Original filename for display. */
  filename: string;
}

export type ChatContentPart = ChatTextPart | ChatImagePart | ChatPdfPart;

export interface ChatMessage {
  /** Stable id (assigned by main on write). */
  id: string;
  role: 'user' | 'assistant';
  content: ChatContentPart[];
  /** ISO timestamp. */
  timestamp: string;
}

export interface ChatSession {
  id: string;
  /** Last-used model id (e.g. `claude-sonnet-4-5`). */
  model: string;
  /** Source ids the user has excluded from the prompt context for this
   *  conversation. Reserved for future per-chat source toggles; always `[]`
   *  in v1. */
  excludedSourceIds: string[];
  messages: ChatMessage[];
  /** ISO timestamp of last update. */
  updatedAt: string;
}

export interface ModelInfo {
  /** API id, e.g. `claude-sonnet-4-5`. */
  id: string;
  /** Display label, e.g. "Sonnet 4.5". */
  label: string;
  /** Short tagline shown in the dropdown. */
  description?: string;
}

/** Streaming events emitted from main to renderer during a chat send. */
export type ChatChunkEvent =
  | { requestId: string; kind: 'delta'; text: string }
  | { requestId: string; kind: 'done'; message: ChatMessage }
  | { requestId: string; kind: 'error'; error: string };

/** Kind of a project source attachment. PDFs and images are sent to Claude
 *  as native blocks; text-like files are inlined as additional context. */
export type SourceKind = 'pdf' | 'image' | 'text';

/** One row in <project>/sources/index.json — a user-attached doc that becomes
 *  part of the rolling context for every future meeting in this project. */
export interface SourceEntry {
  /** Random opaque id; also the on-disk filename stem so two uploads of
   *  the same filename don't collide. */
  id: string;
  /** Original filename the user uploaded (for display). */
  filename: string;
  kind: SourceKind;
  mimeType: string;
  sizeBytes: number;
  /** ISO timestamp of when the source was added. */
  addedAt: string;
  /** Free-form note the user attached alongside (optional). */
  observation: string;
}

/** One row in <meeting>/attachments/index.json — metadata about a screenshot
 *  the user dropped into the canvas during a recording. */
export interface AttachmentIndexEntry {
  /** Relative path inside the meeting dir, e.g. `attachments/foo.png`. */
  path: string;
  /** Milliseconds from the start of the recording when the user attached
   *  the image. `null` if the image was added after the meeting (Notes tab). */
  atMs: number | null;
  /** Free-form text the user typed nearby (paragraph immediately before
   *  the image in the editor). Used by the summarizer to weight intent. */
  observation: string;
  /** ISO timestamp of when the attachment was written. */
  createdAt: string;
}
