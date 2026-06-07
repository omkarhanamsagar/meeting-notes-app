/**
 * IPC handler registration. Maps every channel from /shared/ipc-channels
 * to a function that calls into the engine. Pushes processing-stage events
 * to the renderer via webContents.send.
 */

import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC } from '../shared/ipc-channels.js';
import {
  appendAttachmentIndex,
  ensureDirs,
  listMeetings,
  listProjects,
  listTeams,
  listUnfiledMeetings,
  moveMeeting,
  readAppState,
  readMeta,
  readTeamMeta,
  renameMeeting,
  writeAppState,
} from './engine/storage.js';
import { createProject, createTeam, projectStats, teamStats } from './engine/projects.js';
import {
  addSource,
  classify,
  listSources,
  readSourceBytes,
  removeSource,
} from './engine/sources.js';
import { clearChat, readChat, sendMessage } from './engine/chat.js';
import { buildExportBundle } from './engine/export.js';
import { calendarService } from './calendar/service.js';
import { runOAuthFlow } from './calendar/oauth.js';
import {
  patchCalendarFile,
  readCalendarFile,
  type CalendarLeadMinutes,
} from './calendar/store.js';
import { MODELS } from './engine/models.js';
import { orchestrator } from './engine/orchestrator.js';
import crypto from 'node:crypto';
import { listAudioDevices } from './audio-devices.js';
import { checkTranscriptionEnv } from './engine/transcription.js';
import { ANTHROPIC_MODEL, AUDIO_DEVICE, FFMPEG_BIN } from './engine/config.js';
import type {
  AppState,
  CalendarStatus,
  ChatChunkEvent,
  ChatImagePart,
  ChatPdfPart,
  ChatScope,
  ChatSession,
  DoctorCheck,
  MeetingDetail,
  ModelInfo,
  ProcessingUpdate,
  ProjectWithStats,
  SourceEntry,
  StartRecordingArgs,
  TeamWithStats,
} from '../shared/types.js';

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

function readMeetingDetail(dir: string): MeetingDetail {
  const meta = readMeta(dir);
  const summaryPath = path.join(dir, 'summary.md');
  const transcriptPath = path.join(dir, 'transcript.txt');
  const notesPath = path.join(dir, 'notes.md');

  return {
    meta,
    summary: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : null,
    transcript: fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, 'utf8') : null,
    notes: fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : '',
  };
}

export function registerIpc(): void {
  // -------------------------------------------------------------- Meetings

  ipcMain.handle(
    IPC.Meetings.List,
    async (_e, opts?: { team?: string; project?: string; includeUnfiled?: boolean }) => {
      ensureDirs();
      // Back-compat: an undefined arg means "everything (including unfiled)"
      // since the old preload sent `undefined` for "all meetings".
      if (!opts) return [...listMeetings(), ...listUnfiledMeetings()];
      return listMeetings(opts);
    },
  );

  ipcMain.handle(IPC.Meetings.Get, async (_e, dir: string) => readMeetingDetail(dir));

  ipcMain.handle(IPC.Meetings.SaveNotes, async (_e, dir: string, notes: string) => {
    fs.writeFileSync(path.join(dir, 'notes.md'), notes);
  });

  ipcMain.handle(IPC.Meetings.Delete, async (_e, dir: string) => {
    if (!dir.includes('/data/')) throw new Error('Refusing to delete outside data directory');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  ipcMain.handle(IPC.Meetings.DeleteRecording, async (_e, dir: string) => {
    const rec = path.join(dir, 'recording.wav');
    if (fs.existsSync(rec)) fs.unlinkSync(rec);
  });

  ipcMain.handle(IPC.Meetings.Resummarize, async (_e, dir: string) => {
    await orchestrator.resummarize(dir);
  });

  ipcMain.handle(
    IPC.Meetings.Move,
    async (_e, dir: string, toTeamSlug: string, toProjectSlug: string) => {
      const newDir = moveMeeting(dir, toTeamSlug, toProjectSlug);
      writeAppState({ lastTeamSlug: toTeamSlug, lastProjectSlug: toProjectSlug });
      return newDir;
    },
  );

  ipcMain.handle(IPC.Meetings.Rename, async (_e, dir: string, newTitle: string) =>
    renameMeeting(dir, newTitle),
  );

  ipcMain.handle(
    IPC.Meetings.ReadAttachment,
    async (_e, dir: string, relPath: string): Promise<string | null> => {
      if (!dir.includes('/data/')) {
        throw new Error('Refusing to read attachment outside data directory');
      }
      // Guard against `..` escapes.
      const safeRel = relPath.replace(/\\/g, '/');
      if (safeRel.includes('..')) throw new Error('Invalid attachment path');
      const full = path.join(dir, safeRel);
      if (!full.startsWith(dir)) throw new Error('Attachment path escaped meeting dir');
      if (!fs.existsSync(full)) return null;
      const buf = fs.readFileSync(full);
      const ext = path.extname(full).slice(1).toLowerCase();
      const mime =
        ext === 'jpg' || ext === 'jpeg'
          ? 'image/jpeg'
          : ext === 'gif'
            ? 'image/gif'
            : ext === 'webp'
              ? 'image/webp'
              : 'image/png';
      return `data:${mime};base64,${buf.toString('base64')}`;
    },
  );

  ipcMain.handle(
    IPC.Meetings.AttachScreenshot,
    async (
      _e,
      dir: string,
      dataUrl: string,
      meta?: { atMs?: number | null; observation?: string },
    ): Promise<string> => {
      if (!dir.includes('/data/')) {
        throw new Error('Refusing to write attachment outside data directory');
      }
      const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.*)$/.exec(dataUrl);
      if (!m) throw new Error('attachScreenshot: expected base64 data URL');
      const ext = m[1] === 'jpeg' ? 'jpg' : (m[1] ?? 'png');
      const buf = Buffer.from(m[2] ?? '', 'base64');
      const attachmentsDir = path.join(dir, 'attachments');
      fs.mkdirSync(attachmentsDir, { recursive: true });
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .slice(0, 19);
      const filename = `${stamp}.${ext}`;
      const relPath = `attachments/${filename}`;
      fs.writeFileSync(path.join(attachmentsDir, filename), buf);

      appendAttachmentIndex(dir, {
        path: relPath,
        atMs: typeof meta?.atMs === 'number' ? meta.atMs : null,
        observation: meta?.observation?.trim() ?? '',
        createdAt: new Date().toISOString(),
      });

      return relPath;
    },
  );

  // -------------------------------------------------------------- Teams

  ipcMain.handle(IPC.Teams.List, async () => listTeams());

  ipcMain.handle(IPC.Teams.Get, async (_e, slug: string) => readTeamMeta(slug));

  ipcMain.handle(IPC.Teams.ListWithStats, async (): Promise<TeamWithStats[]> =>
    listTeams().map((t) => ({ ...t, stats: teamStats(t.slug) })),
  );

  ipcMain.handle(
    IPC.Teams.Create,
    async (_e, slug: string, name: string, description?: string) =>
      createTeam(slug, name, description ?? ''),
  );

  // -------------------------------------------------------------- Projects

  ipcMain.handle(IPC.Projects.List, async (_e, teamSlug: string) => listProjects(teamSlug));

  ipcMain.handle(
    IPC.Projects.ListWithStats,
    async (_e, teamSlug: string): Promise<ProjectWithStats[]> =>
      listProjects(teamSlug).map((p) => ({ ...p, stats: projectStats(teamSlug, p.slug) })),
  );

  ipcMain.handle(
    IPC.Projects.Create,
    async (_e, teamSlug: string, slug: string, name: string, description?: string) =>
      createProject(teamSlug, slug, name, description ?? ''),
  );

  // -------------------------------------------------------------- Sources

  ipcMain.handle(
    IPC.Sources.List,
    async (_e, team: string, project: string): Promise<SourceEntry[]> =>
      listSources(team, project),
  );

  ipcMain.handle(
    IPC.Sources.Add,
    async (
      _e,
      args: {
        team: string;
        project: string;
        filename: string;
        dataUrl: string;
        mimeType?: string;
        observation?: string;
      },
    ): Promise<SourceEntry> => {
      const m = /^data:([^;,]+)?(?:;[^,]*)?,(.*)$/.exec(args.dataUrl);
      if (!m) throw new Error('sources:add expected a data URL');
      const dataPart = m[2] ?? '';
      const isBase64 = /;base64/i.test(args.dataUrl);
      const bytes = isBase64
        ? Buffer.from(dataPart, 'base64')
        : Buffer.from(decodeURIComponent(dataPart), 'utf8');
      if (bytes.byteLength > MAX_SOURCE_BYTES) {
        throw new Error(
          `File is too large (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB). Limit is ${MAX_SOURCE_BYTES / 1024 / 1024} MB.`,
        );
      }
      const mimeType = args.mimeType || m[1] || 'application/octet-stream';
      if (!classify(mimeType, args.filename)) {
        throw new Error(`Unsupported file type: ${args.filename} (${mimeType})`);
      }
      return addSource(args.team, args.project, {
        filename: args.filename,
        bytes,
        mimeType,
        observation: args.observation,
      });
    },
  );

  ipcMain.handle(
    IPC.Sources.Remove,
    async (_e, team: string, project: string, id: string): Promise<void> => {
      removeSource(team, project, id);
    },
  );

  ipcMain.handle(
    IPC.Sources.Read,
    async (_e, team: string, project: string, id: string): Promise<string | null> => {
      const got = readSourceBytes(team, project, id);
      if (!got) return null;
      const { entry, bytes } = got;
      if (entry.kind === 'text') {
        return `data:${entry.mimeType};charset=utf-8,${encodeURIComponent(bytes.toString('utf8'))}`;
      }
      return `data:${entry.mimeType};base64,${bytes.toString('base64')}`;
    },
  );

  // -------------------------------------------------------------- Chat / Models

  ipcMain.handle(IPC.Models.List, async (): Promise<ModelInfo[]> => MODELS);

  ipcMain.handle(
    IPC.Chat.Read,
    async (_e, scope: ChatScope): Promise<ChatSession> => readChat(scope),
  );

  ipcMain.handle(
    IPC.Chat.Clear,
    async (_e, scope: ChatScope): Promise<void> => {
      clearChat(scope);
    },
  );

  ipcMain.handle(
    IPC.Chat.Send,
    async (
      e,
      args: {
        scope: ChatScope;
        text: string;
        images?: ChatImagePart[];
        pdfs?: ChatPdfPart[];
        model: string;
        excludedSourceIds?: string[];
        excludedMeetingSlugs?: string[];
      },
    ): Promise<string> => {
      const requestId = crypto.randomBytes(8).toString('hex');
      const sender = e.sender;
      const emit = (event: ChatChunkEvent): void => {
        if (!sender.isDestroyed()) {
          sender.send(IPC.Events.ChatChunk, event);
        }
      };
      // Kick off the streaming send in the background; resolve immediately
      // with the requestId so the renderer can subscribe to chunks for it.
      void sendMessage(
        {
          scope: args.scope,
          text: args.text,
          images: args.images,
          pdfs: args.pdfs,
          model: args.model,
          excludedSourceIds: args.excludedSourceIds,
          excludedMeetingSlugs: args.excludedMeetingSlugs,
        },
        requestId,
        emit,
      ).catch((err) => {
        // The engine already emitted an 'error' chunk; just log for diagnostics.
        console.error('[chat:send] failed:', err);
      });
      return requestId;
    },
  );

  // -------------------------------------------------------------- Export

  ipcMain.handle(
    IPC.Export.Bundle,
    async (e, args: { scope: ChatScope }): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const bundle = await buildExportBundle(args.scope);
      const result = await dialog.showSaveDialog(win ?? undefined!, {
        title: 'Export context bundle',
        defaultPath: bundle.suggestedFilename,
        filters: [{ name: 'Zip archive', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath) return null;
      fs.writeFileSync(result.filePath, bundle.bytes);
      return result.filePath;
    },
  );

  // -------------------------------------------------------------- Calendar

  function calendarStatus(): CalendarStatus {
    const file = readCalendarFile();
    return {
      hasClient: !!file.settings.client,
      isConnected: !!file.tokens,
      isEnabled: file.settings.enabled,
      leadMinutes: file.settings.leadMinutes,
      account: file.account,
    };
  }

  ipcMain.handle(IPC.Calendar.Status, async (): Promise<CalendarStatus> => calendarStatus());

  ipcMain.handle(
    IPC.Calendar.SetClient,
    async (
      _e,
      args: { clientId: string; clientSecret: string },
    ): Promise<CalendarStatus> => {
      const clientId = String(args.clientId || '').trim();
      const clientSecret = String(args.clientSecret || '').trim();
      if (!clientId || !clientSecret) {
        throw new Error('Both client_id and client_secret are required');
      }
      patchCalendarFile((curr) => ({
        ...curr,
        settings: { ...curr.settings, client: { clientId, clientSecret } },
      }));
      return calendarStatus();
    },
  );

  ipcMain.handle(IPC.Calendar.Connect, async (): Promise<CalendarStatus> => {
    const file = readCalendarFile();
    if (!file.settings.client) {
      throw new Error('No OAuth client configured. Paste a client_id/secret first.');
    }
    const result = await runOAuthFlow(file.settings.client);
    patchCalendarFile((curr) => ({
      ...curr,
      tokens: result.tokens,
      account: result.account,
      // Auto-enable on first successful connect; user can flip off in Settings.
      settings: { ...curr.settings, enabled: true },
      // Connecting with a different account resets the per-event log to
      // avoid showing stale "already notified" state.
      notified: {},
      dismissed: {},
    }));
    calendarService.reset();
    return calendarStatus();
  });

  ipcMain.handle(IPC.Calendar.Disconnect, async (): Promise<CalendarStatus> => {
    patchCalendarFile((curr) => ({
      ...curr,
      tokens: null,
      account: null,
      settings: { ...curr.settings, enabled: false },
      notified: {},
      dismissed: {},
    }));
    calendarService.reset();
    return calendarStatus();
  });

  ipcMain.handle(
    IPC.Calendar.UpdateSettings,
    async (
      _e,
      patch: { enabled?: boolean; leadMinutes?: CalendarLeadMinutes },
    ): Promise<CalendarStatus> => {
      patchCalendarFile((curr) => ({
        ...curr,
        settings: {
          ...curr.settings,
          enabled: patch.enabled ?? curr.settings.enabled,
          leadMinutes: patch.leadMinutes ?? curr.settings.leadMinutes,
        },
      }));
      calendarService.reset();
      return calendarStatus();
    },
  );

  ipcMain.handle(IPC.Calendar.Poll, async (): Promise<CalendarStatus> => {
    await calendarService.pollOnce();
    return calendarStatus();
  });

  // -------------------------------------------------------------- AppState

  ipcMain.handle(IPC.AppState.Get, async (): Promise<AppState> => readAppState());

  ipcMain.handle(IPC.AppState.Set, async (_e, patch: Partial<AppState>): Promise<AppState> =>
    writeAppState(patch),
  );

  // -------------------------------------------------------------- Recording

  ipcMain.handle(IPC.Recording.Start, async (_e, args: StartRecordingArgs) =>
    orchestrator.startRecording(args),
  );

  ipcMain.handle(IPC.Recording.Stop, async () => orchestrator.stopRecording());

  ipcMain.handle(
    IPC.Recording.CommitStop,
    async (_e, args: { dir: string; title: string; team: string; project: string }) =>
      orchestrator.commitStop(args),
  );

  ipcMain.handle(IPC.Recording.GetState, async () => orchestrator.getRecordingState());

  // -------------------------------------------------------------- Audio

  ipcMain.handle(IPC.Audio.ListDevices, async () => listAudioDevices());

  ipcMain.handle(IPC.Audio.GetDevice, async () => AUDIO_DEVICE);

  ipcMain.handle(IPC.Audio.SetDevice, async () => {
    // intentionally empty
  });

  // -------------------------------------------------------------- Diagnostics

  ipcMain.handle(IPC.Diagnostics.Doctor, async (): Promise<DoctorCheck[]> => {
    const checks: DoctorCheck[] = [];
    checks.push({
      name: 'ffmpeg',
      ok: fs.existsSync(FFMPEG_BIN),
      detail: FFMPEG_BIN,
    });
    const wEnv = checkTranscriptionEnv();
    checks.push({ name: 'whisper-cli + model', ok: wEnv.ok, detail: wEnv.detail });
    checks.push({
      name: 'ANTHROPIC_API_KEY',
      ok: Boolean(process.env.ANTHROPIC_API_KEY),
      detail: process.env.ANTHROPIC_API_KEY
        ? `${process.env.ANTHROPIC_API_KEY.slice(0, 15)}...`
        : 'not set',
    });
    checks.push({ name: 'Anthropic model', ok: true, detail: ANTHROPIC_MODEL });
    return checks;
  });

  // -------------------------------------------------------------- Events out

  orchestrator.on('processing', (update: ProcessingUpdate) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.Events.ProcessingUpdate, update);
    }
  });
}
